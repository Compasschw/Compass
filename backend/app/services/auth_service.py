import hashlib
import logging
from datetime import UTC, date, datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.utils.security import create_access_token, create_refresh_token, hash_password, verify_password

logger = logging.getLogger("compass.auth")


class DuplicatePhoneError(Exception):
    """Raised by ``register_user`` when the normalized phone is already on
    another account.

    A distinct exception type (rather than overloading the existing
    "return None means duplicate email" convention) so callers can surface a
    specific, correct HTTP status: 409 for a duplicate phone vs. the existing
    400 for a duplicate email. Carries the already-normalized E.164 value so
    callers never need to re-normalize just to log/report it.
    """

    def __init__(self, normalized_phone: str) -> None:
        self.normalized_phone = normalized_phone
        super().__init__(f"Phone number already registered: {normalized_phone}")


async def register_user(
    db: AsyncSession,
    email: str,
    password: str,
    name: str,
    role: str,
    phone: str | None = None,
    *,
    member_profile_fields: dict[str, Any] | None = None,
    commit: bool = True,
    must_change_password: bool = False,
):
    """Register a new User and provision the role-appropriate profile row.

    A `MemberProfile` (or `CHWProfile`) is created with sensible defaults at
    signup time so downstream endpoints — `GET /member/profile`, `PUT
    /member/profile`, `GET /chw/intake`, request submission, etc. — never 404
    on a freshly-registered account.

    When ``role == "member"`` and ``member_profile_fields`` is provided, the
    expanded-signup fields (DOB, gender, address parts, insurance, CIN) are
    written onto the MemberProfile row in the same transaction so a
    downstream Pear sync (best-effort, scheduled from the auth router) can
    build a complete Pear member payload without a follow-up PATCH.
    Unknown / None keys are ignored.

    Args:
        commit: When True (default — used by the self-signup `/auth/register`
            flow), the User + profile are committed here so the function
            returns a durably-persisted, loginable account, exactly as before.
            When False, the rows are only `flush()`-ed (so `user.id` and all
            relationships are populated and visible to later statements in
            the *same* transaction) but left uncommitted. This lets a caller
            that needs to attach additional rows in the same atomic unit —
            e.g. `create_chw_member` writing the CHW↔member ServiceRequest +
            Conversation — own the commit boundary, so a failure after this
            call rolls back the whole thing (no orphaned member). Callers
            passing `commit=False` MUST call `await db.commit()` themselves
            once all related rows are added, and must let any exception
            propagate un-caught so `get_db`'s rollback-on-exception fires.
        must_change_password: When True (only ``create_chw_member`` in
            ``routers/chw.py`` passes this), the created User is flagged so the
            frontend prompts a mandatory password change on first sign-in
            (Epic G2 — the CHW handed this member a temp password
            out-of-band). Defaults to False — every self-service caller (the
            self-signup ``/auth/register`` flow, OAuth sign-up) leaves this at
            the column default because the account holder chose (or has no)
            password themselves.

    Returns None when the email is already taken (handled at the router layer
    as HTTP 400).

    Raises:
        DuplicatePhoneError: When ``phone`` normalizes to a value already
            stored on another account (QA-batch #1 — CHW phone uniqueness,
            defensively applied to every role that supplies a phone, not
            only CHWs). Checked BEFORE creating the User row so no partial
            row is written. A partial unique index on ``users.phone`` (see
            migration ``chwphone0713``) is the race-safe backstop for
            concurrent requests that both pass this pre-check simultaneously
            — this in-app check exists to return a clean 409 with a readable
            message on the common (non-racing) path, matching the existing
            duplicate-email UX rather than surfacing a raw
            IntegrityError/500.
    """
    from app.models.user import CHWProfile, MemberProfile, User

    # Normalize email to lowercase for consistent storage + case-insensitive
    # login (see authenticate_user). Duplicate check is also case-insensitive so
    # "John@x.com" and "john@x.com" can't create two accounts for one person.
    normalized_email = (email or "").strip().lower()
    existing = await db.execute(
        select(User).where(func.lower(User.email) == normalized_email)
    )
    if existing.scalar_one_or_none():
        return None

    # Duplicate-phone guard (QA-batch #1). Phone is optional at signup for
    # every role, so this only fires when a normalized value is actually
    # present — NULL phones are never compared (any number of accounts may
    # have no phone on file; enforced at the DB layer too via the partial
    # unique index's `WHERE phone IS NOT NULL` clause).
    normalized_phone = _normalize_phone_e164(phone)
    if normalized_phone is not None:
        existing_phone = await db.execute(
            select(User).where(User.phone == normalized_phone)
        )
        if existing_phone.scalar_one_or_none():
            raise DuplicatePhoneError(normalized_phone)

    user = User(
        email=normalized_email,
        password_hash=hash_password(password),
        name=name,
        role=role,
        phone=normalized_phone,
        must_change_password=must_change_password,
    )
    db.add(user)
    await db.flush()  # populate user.id without ending the transaction

    # Provision the role-specific profile in the same transaction so the user
    # never exists in a half-onboarded state where queries against the join
    # row would 404.
    if role == "member":
        profile = MemberProfile(user_id=user.id)
        # Copy any supplied signup fields onto the profile.  We allow-list to
        # the known columns so a malicious client can't set arbitrary
        # attributes (e.g. rewards_balance, pear_suite_member_id).
        allowed_fields = {
            "date_of_birth", "gender",
            "address_line1", "address_line2", "city", "state",
            "zip_code", "insurance_company", "medi_cal_id",
            # Signup consent timestamps (set by the endpoints to NOW(UTC) once
            # the required consent booleans have been validated at the boundary).
            "terms_accepted_at", "communications_consent_at",
        }
        if member_profile_fields:
            for key, value in member_profile_fields.items():
                if key in allowed_fields and value is not None:
                    setattr(profile, key, value)
        db.add(profile)
    elif role == "chw":
        # Epic D: background_check_status starts "pending" (not the column's
        # DB-level default "not_started") — a new CHW account immediately
        # enters the review queue rather than sitting in an unstarted state
        # that looks identical to "nobody has looked at this yet". Only the
        # admin-only PATCH /admin/chws/{id}/background-check endpoint can
        # move it forward from here.
        db.add(CHWProfile(user_id=user.id, background_check_status="pending"))
    # Other roles (admin) don't need a profile row.

    if commit:
        # Session.commit() always flushes pending state first, so this both
        # persists AND populates any remaining server-generated defaults.
        await db.commit()
    else:
        # No commit — just flush so user.id/relationships are populated and
        # visible to later statements in the SAME transaction. The caller
        # (e.g. create_chw_member) owns the eventual db.commit().
        await db.flush()
    await db.refresh(user)
    return user


async def append_new_member_to_csv(user_id: UUID) -> None:
    """Best-effort background task: append a freshly-created member to the
    Pear Member-Import rolling monthly CSV in S3.

    Shared by EVERY member-creation surface — self-signup (``POST
    /auth/register``), OAuth sign-up (``POST /auth/oauth/google`` and
    ``/oauth/apple``), completed OAuth onboarding (``POST
    /auth/complete-member-onboarding``), and CHW-initiated onboarding
    (``POST /chw/members``) — so a member exported to Pear's billing
    pipeline never depends on which surface created the account. Callers
    schedule this via ``BackgroundTasks.add_task`` AFTER their own
    ``db.commit()`` succeeds, so the export only ever runs against a
    durably-persisted member row.

    Opens its own DB session because the request session is closed by the
    time this fires, logs any failure but never re-raises (admin can
    re-run the backfill script later). Idempotent on
    ``MemberProfile.member_csv_exported_at``: skips if it's already
    populated, sets it to ``NOW()`` after a successful S3 append.
    """
    from sqlalchemy import select as _select

    from app.config import settings as _settings
    from app.database import async_session
    from app.models.user import MemberProfile
    from app.models.user import User as _User
    from app.services.member_csv_writer import (
        append_row,
        build_row_from_models,
        is_export_eligible,
        is_pear_complete,
    )

    if not getattr(_settings, "member_csv_enabled", False):
        return

    async with async_session() as db:
        try:
            user = await db.get(_User, user_id)
            if user is None or not is_export_eligible(user):
                return
            result = await db.execute(
                _select(MemberProfile).where(MemberProfile.user_id == user_id)
            )
            profile = result.scalar_one_or_none()
            if profile is None:
                logger.warning(
                    "member_csv: skipped export — no MemberProfile for user=%s",
                    user_id,
                )
                return
            if profile.member_csv_exported_at is not None:
                logger.info(
                    "member_csv: already exported user=%s at %s — skipping",
                    user_id, profile.member_csv_exported_at,
                )
                return
            if not is_pear_complete(user, profile):
                # Profile is missing one or more Pear-required fields.
                # Leave member_csv_exported_at NULL so the next backfill
                # run picks them up once their profile is complete.
                logger.info(
                    "member_csv: skipped user=%s — profile missing "
                    "Pear-required fields; will retry via backfill",
                    user_id,
                )
                return

            row = build_row_from_models(user=user, member_profile=profile)
            env_prefix = "prod" if _settings.pear_suite_enabled else "sandbox"
            append_row(row, environment=env_prefix)

            profile.member_csv_exported_at = datetime.now(UTC)
            await db.commit()
            logger.info(
                "member_csv: appended user=%s env=%s",
                user_id, env_prefix,
            )
        except Exception:  # noqa: BLE001
            logger.exception(
                "member_csv: append failed user=%s (non-fatal, "
                "retryable via scripts/backfill_member_csv.py)",
                user_id,
            )


def _normalize_phone_e164(value: str | None) -> str | None:
    """Canonicalize a US phone string to E.164 (+1XXXXXXXXXX) for storage.

    Frontend signup, magic-link, and re-onboarding flows all collect phones
    as loose strings ("(310) 555-0199", "310-555-0199", "+1 310 555 0199",
    "3105550199", etc.).  We standardize on +1-prefixed E.164 at the User
    record so downstream callers — Vonage create_call, Pear contactInfo,
    SMS notifications — never have to second-guess the format.

    Rules:
      - None / empty → None (phone is optional)
      - 10 digits      → "+1XXXXXXXXXX" (US default)
      - 11 starting "1" → "+1XXXXXXXXXX"
      - Already starts with "+" → strip non-digits, re-prepend "+"
      - Anything else → return the digits-only form with a "+" prefix
        (best-effort for non-US numbers; we don't run outside the US so
        this branch is rarely hit)
    """
    if value is None:
        return None
    raw = value.strip()
    if not raw:
        return None
    digits = "".join(ch for ch in raw if ch.isdigit())
    if not digits:
        return None
    if len(digits) == 10:
        return f"+1{digits}"
    if len(digits) == 11 and digits.startswith("1"):
        return f"+{digits}"
    return f"+{digits}"


# Re-exported for callers that want the type without re-importing date.
__all__ = [
    "register_user",
    "append_new_member_to_csv",
    "authenticate_user",
    "create_tokens",
    "store_refresh_token",
    "revoke_refresh_token",
    "mark_first_login",
    "date",
]


async def authenticate_user(db: AsyncSession, email: str, password: str):
    from app.models.user import User
    # Email is case-insensitive: compare on the LOWERCASED column so a member
    # whose email was stored with any capitalization (e.g. a CHW typed
    # "John@Example.com" in Add New Member) can still log in with any casing.
    # Match on the column (func.lower) — not just a normalized input — so this
    # also fixes accounts already stored mixed-case, not only new ones.
    normalized = (email or "").strip().lower()
    result = await db.execute(select(User).where(func.lower(User.email) == normalized))
    user = result.scalar_one_or_none()
    if user is None or user.password_hash is None or not verify_password(password, user.password_hash):
        return None
    if not user.is_active:
        return None
    return user


def mark_first_login(user) -> None:
    """Stamp ``user.first_login_at`` (once) and ``user.last_active_at`` (every
    call) with NOW(UTC) on every successful authentication.

    ``first_login_at`` is idempotent (a no-op once already set) — it records
    *whether* the user has ever signed in. ``last_active_at`` is stamped
    unconditionally every call — this is a recency signal ("QA-batch #13":
    the CHW Members-page roster status is "active" iff last_active_at is
    within the last 30 days), not a one-time flag, so a returning user's
    sign-in must always refresh it even though it is ALSO bumped by ordinary
    authenticated requests (``dependencies.get_current_user``, throttled to
    once/minute there). Stamping it here too means status flips to "active"
    immediately on login, before the user has made any other API call.

    Called from every path that mints tokens for a user (self-service
    ``/auth/register`` auto-login, ``/auth/login``, and OAuth sign-in in
    ``routers/auth.py``). Deliberately NOT called from
    ``register_user``/``create_chw_member`` — a CHW provisioning a member's
    account on their behalf is not the *member* signing in; that member must
    still authenticate themselves (via ``/auth/login`` with the temp
    password) before ``first_login_at`` is set. This is what drives the CHW
    Members-page status rule: a CHW-created member stays 'inactive' until
    they do so.

    This only mutates the in-memory ORM attributes — it does not commit.
    Every call site below is immediately followed by ``store_refresh_token``,
    which commits the session, so the dirty attributes ride along on that
    same transaction with no extra round-trip.
    """
    now = datetime.now(UTC)
    if user.first_login_at is None:
        user.first_login_at = now
    user.last_active_at = now


def create_tokens(user) -> tuple[str, str]:
    data = {"sub": str(user.id), "role": user.role}
    return create_access_token(data), create_refresh_token(data)


async def store_refresh_token(db: AsyncSession, user_id, token: str):
    from app.models.auth import RefreshToken
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    expires_at = datetime.now(UTC) + timedelta(days=settings.refresh_token_expire_days)
    rt = RefreshToken(user_id=user_id, token_hash=token_hash, expires_at=expires_at)
    db.add(rt)
    await db.commit()


async def revoke_refresh_token(db: AsyncSession, token: str):
    from app.models.auth import RefreshToken
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    result = await db.execute(
        select(RefreshToken).where(
            RefreshToken.token_hash == token_hash,
            RefreshToken.revoked == False,
            RefreshToken.expires_at > datetime.now(UTC),
        )
    )
    rt = result.scalar_one_or_none()
    if rt:
        rt.revoked = True
        await db.commit()
    return rt


async def revoke_all_refresh_tokens_for_user(db: AsyncSession, user_id: UUID) -> int:
    """Revoke every outstanding (not already revoked, not yet expired)
    refresh token for ``user_id`` — signs the user out of all devices.

    Used by the password-reset confirm flow (Epic — forgot password): a
    successful reset is a strong signal that any previously-issued session
    material should no longer be trusted, so every refresh token is revoked
    in bulk rather than the single-token revocation ``revoke_refresh_token``
    performs on login/refresh rotation.

    Does NOT commit — the caller (password-reset confirm) performs one
    commit for the whole unit of work (password hash + consumed_at + token
    revocation) so a partial failure can't leave the account in a half-reset
    state.

    Returns:
        The number of refresh-token rows revoked (0 if the user had none
        outstanding — not an error).
    """
    from app.models.auth import RefreshToken

    result = await db.execute(
        select(RefreshToken).where(
            RefreshToken.user_id == user_id,
            RefreshToken.revoked == False,
            RefreshToken.expires_at > datetime.now(UTC),
        )
    )
    tokens = result.scalars().all()
    for rt in tokens:
        rt.revoked = True
    return len(tokens)

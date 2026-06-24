import hashlib
from datetime import UTC, date, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.utils.security import create_access_token, create_refresh_token, hash_password, verify_password


async def register_user(
    db: AsyncSession,
    email: str,
    password: str,
    name: str,
    role: str,
    phone: str | None = None,
    *,
    member_profile_fields: dict[str, Any] | None = None,
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

    Returns None when the email is already taken (handled at the router layer
    as HTTP 400).
    """
    from app.models.user import CHWProfile, MemberProfile, User

    existing = await db.execute(select(User).where(User.email == email))
    if existing.scalar_one_or_none():
        return None

    user = User(
        email=email,
        password_hash=hash_password(password),
        name=name,
        role=role,
        phone=_normalize_phone_e164(phone),
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
        }
        if member_profile_fields:
            for key, value in member_profile_fields.items():
                if key in allowed_fields and value is not None:
                    setattr(profile, key, value)
        db.add(profile)
    elif role == "chw":
        db.add(CHWProfile(user_id=user.id))
    # Other roles (admin) don't need a profile row.

    await db.commit()
    await db.refresh(user)
    return user


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
__all__ = ["register_user", "authenticate_user", "create_tokens", "store_refresh_token", "revoke_refresh_token", "date"]


async def authenticate_user(db: AsyncSession, email: str, password: str):
    from app.models.user import User
    result = await db.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()
    if user is None or user.password_hash is None or not verify_password(password, user.password_hash):
        return None
    if not user.is_active:
        return None
    return user


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

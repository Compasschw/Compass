import logging
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.limiter import limiter
from app.models.user import User
from app.schemas.auth import (
    ChangePasswordRequest,
    ChangePasswordResponse,
    LoginRequest,
    RefreshRequest,
    RegisterRequest,
    TokenResponse,
)
from app.services.auth_service import (
    append_new_member_to_csv as _append_new_member_to_csv,
)
from app.services.auth_service import (
    authenticate_user,
    create_tokens,
    mark_first_login,
    register_user,
    revoke_refresh_token,
    store_refresh_token,
)
from app.services.signup_confirmations import send_signup_confirmations
from app.services.storage.avatar_urls import presigned_avatar_url
from app.utils.security import decode_token

logger = logging.getLogger("compass.auth")

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])

# ``_append_new_member_to_csv`` is imported (not redefined) from
# ``app.services.auth_service.append_new_member_to_csv`` — the CSV-export
# logic is shared verbatim by every member-creation surface (self-signup,
# OAuth sign-up, OAuth-onboarding-completion, and CHW-initiated onboarding
# in ``routers/chw.py``). Keep the local alias name so existing call sites
# below (and tests that ``patch("app.routers.auth._append_new_member_to_csv")``)
# don't need to change.


async def _sync_new_member_to_pear(user_id: UUID) -> None:
    """Best-effort background task: sync a freshly-registered member to Pear.

    Runs after /auth/register returns so the user isn't stalled on Pear's
    response time (or outage).  Opens its own DB session because the request
    session is closed by the time this fires.  Logs any failure but never
    re-raises — admin can retry later via /admin/members/{id}/sync-to-pear.
    """
    from sqlalchemy import select

    from app.database import async_session
    from app.models.user import MemberProfile
    from app.models.user import User as _User
    from app.services.pear_suite_member_sync import ensure_member_synced

    async with async_session() as db:
        try:
            user = await db.get(_User, user_id)
            if user is None or user.role != "member":
                return
            result = await db.execute(
                select(MemberProfile).where(MemberProfile.user_id == user_id)
            )
            profile = result.scalar_one_or_none()
            if profile is None:
                logger.warning(
                    "register: skipped Pear sync — no MemberProfile for user=%s",
                    user_id,
                )
                return
            await ensure_member_synced(db, profile, user)
            logger.info(
                "register: Pear sync completed user=%s pear_member_id=%s",
                user_id, profile.pear_suite_member_id,
            )
        except Exception:  # noqa: BLE001
            # Background task — never raise; admin can retry from /admin.
            logger.exception(
                "register: Pear sync failed user=%s (non-fatal, retryable from admin)",
                user_id,
            )


@router.post("/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
@limiter.limit("3/minute")
async def register(
    request: Request,
    data: RegisterRequest,
    background_tasks: BackgroundTasks,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Create a Compass account.

    For members, the expanded-signup fields (DOB, gender, address, insurance,
    CIN) are copied onto the MemberProfile row at creation time and a
    background task fires to mirror the member into Pear Suite.  The Pear
    sync is fire-and-forget — a Pear outage or rejection never blocks
    account creation; admin can retry via POST /admin/members/{id}/sync-to-pear.
    """
    # Build the optional member-profile payload from the signup request.
    # None for non-member roles so the service short-circuits cleanly.
    member_profile_fields = None
    if data.role == "member":
        # RegisterRequest's model_validator has already enforced that both
        # consents are True for members, so stamping NOW(UTC) here is safe —
        # an unconsented member request would have 422'd before reaching this.
        from datetime import UTC
        from datetime import datetime as _dt

        consent_now = _dt.now(UTC)
        member_profile_fields = {
            "date_of_birth": data.date_of_birth,
            "gender": data.gender,
            "address_line1": data.address_line1,
            "address_line2": data.address_line2,
            "city": data.city,
            "state": data.state,
            "zip_code": data.zip_code,
            "insurance_company": data.insurance_company,
            "medi_cal_id": data.medi_cal_id,
            "terms_accepted_at": consent_now,
            "communications_consent_at": consent_now,
        }

    user = await register_user(
        db,
        data.email, data.password, data.name, data.role, data.phone,
        member_profile_fields=member_profile_fields,
    )
    if user is None:
        raise HTTPException(status_code=400, detail="Email already registered")
    # Self-service registration returns tokens immediately (auto-login) — this
    # IS the user's first successful authentication, so it counts as their
    # first login. (CHW-initiated member creation does NOT call this endpoint
    # and does NOT get this treatment — see mark_first_login's docstring.)
    mark_first_login(user)
    access, refresh = create_tokens(user)
    await store_refresh_token(db, user.id, refresh)

    # Schedule the Pear sync to run after the response is sent.  Members
    # without DOB/gender/CIN will hit Pear's validation and the sync logs
    # the failure — they can complete the profile later from the app and
    # admin can re-trigger the sync at that point.
    if user.role == "member":
        background_tasks.add_task(_sync_new_member_to_pear, user.id)
        background_tasks.add_task(_append_new_member_to_csv, user.id)

    # Best-effort signup confirmation email (+ SMS for already-SMS-eligible
    # members — rare at this point since phone verification is a separate
    # OTP flow, but the helper checks anyway). Fire-and-forget: a slow/down
    # SES or Vonage never blocks or fails this response (Epic A).
    background_tasks.add_task(send_signup_confirmations, user.id)

    return TokenResponse(
        access_token=access, refresh_token=refresh, role=user.role, name=user.name,
        must_change_password=user.must_change_password,
    )


@router.post("/login", response_model=TokenResponse)
@limiter.limit("5/minute")
async def login(request: Request, data: LoginRequest, db: Annotated[AsyncSession, Depends(get_db)]):
    user = await authenticate_user(db, data.email, data.password)
    if user is None:
        raise HTTPException(status_code=401, detail="Invalid email or password")
    mark_first_login(user)
    access, refresh = create_tokens(user)
    await store_refresh_token(db, user.id, refresh)
    return TokenResponse(
        access_token=access, refresh_token=refresh, role=user.role, name=user.name,
        must_change_password=user.must_change_password,
    )


@router.post("/change-password", response_model=ChangePasswordResponse)
@limiter.limit("5/minute")
async def change_password(
    request: Request,
    data: ChangePasswordRequest,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
):
    """Change the authenticated user's password.

    Primary use case (Epic G2): a member created by a CHW (``POST
    /chw/members``) is handed a temporary password out-of-band and must
    replace it on first sign-in — see ``User.must_change_password``. Also
    usable generally by any authenticated user with a password who wants to
    change it.

    Security:
    - Requires a valid Bearer JWT (``get_current_user``) — 401 if missing/
      invalid/expired.
    - ``current_password`` MUST verify against the stored hash via the same
      argon2 verifier used at login (``verify_password``) — 401 if it
      doesn't match, or if the account has no password at all (OAuth-only
      accounts, ``password_hash is None`` — there is nothing to "change
      from", so this is treated as an auth failure rather than a 500).
      ``verify_password`` (passlib) raises ``UnknownHashError`` rather than
      returning False when the stored value isn't a hash it recognizes (e.g.
      corrupted/legacy data) — that is caught and also treated as a 401
      rather than surfacing as an unhandled 500.
    - ``new_password`` enforces the same minimum-length rule as signup
      (Pydantic ``min_length=8`` on ``ChangePasswordRequest`` — see its
      docstring) — a violation 422s before this handler ever runs.
    - Reuses ``hash_password``/``verify_password`` from ``app.utils.security``
      (argon2 via passlib) — no hand-rolled crypto.
    - Rate-limited to 5/minute per IP, matching ``/auth/login``, to blunt a
      brute-force guess of the current password.

    On success: sets the new hash, clears ``must_change_password`` (a no-op
    if it was already False), and commits. Existing refresh tokens are left
    valid — this endpoint is a password rotation, not a full session
    revocation; a user is not logged out of other devices by changing their
    password here.

    Returns:
        200 with ``ChangePasswordResponse`` on success.
        401 if ``current_password`` is wrong or the account has no password.
        422 if ``new_password`` is shorter than 8 characters.
    """
    from passlib.exc import UnknownHashError

    from app.utils.security import hash_password, verify_password

    current_password_valid = False
    if current_user.password_hash is not None:
        try:
            current_password_valid = verify_password(
                data.current_password, current_user.password_hash
            )
        except UnknownHashError:
            # Stored hash isn't in a format passlib recognizes (corrupted or
            # pre-argon2 legacy data) — never let this surface as an
            # unhandled 500; treat it the same as "current password wrong".
            logger.warning(
                "change-password: unrecognized password_hash format for user=%s",
                current_user.id,
            )
            current_password_valid = False

    if not current_password_valid:
        raise HTTPException(status_code=401, detail="Current password is incorrect")

    current_user.password_hash = hash_password(data.new_password)
    current_user.must_change_password = False
    await db.commit()

    return ChangePasswordResponse()


@router.post("/refresh", response_model=TokenResponse)
async def refresh(data: RefreshRequest, db: Annotated[AsyncSession, Depends(get_db)]):
    payload = decode_token(data.refresh_token)
    if payload is None or payload.get("type") != "refresh":
        raise HTTPException(status_code=401, detail="Invalid refresh token")
    old = await revoke_refresh_token(db, data.refresh_token)
    if old is None:
        raise HTTPException(status_code=401, detail="Token not found, revoked, or expired")
    user = await db.get(User, UUID(payload["sub"]))
    if user is None or not user.is_active:
        raise HTTPException(status_code=401, detail="User not found or deactivated")
    access, new_refresh = create_tokens(user)
    await store_refresh_token(db, user.id, new_refresh)
    return TokenResponse(
        access_token=access, refresh_token=new_refresh, role=user.role, name=user.name,
        must_change_password=user.must_change_password,
    )


# ─── Social OAuth (Google + Apple) ───────────────────────────────────────────

from app.config import settings as _settings  # noqa: E402 (deferred to avoid circular at module top)
from app.schemas.auth import CompleteOnboardingRequest, OAuthRequest, OAuthTokenResponse  # noqa: E402
from app.services.oauth_verification import OAuthIdentity, verify_apple_id_token, verify_google_id_token  # noqa: E402


async def _handle_oauth_signin(
    identity: OAuthIdentity,
    db: AsyncSession,
    background_tasks: BackgroundTasks,
) -> OAuthTokenResponse:
    """Shared sign-in / sign-up logic for all OAuth providers.

    Sign-in path (email exists): fetch user, mint tokens.
    Sign-up path (new email): create MEMBER account with password_hash=NULL,
      MemberProfile with onboarding_complete=False, schedule background tasks.

    Args:
        identity: Verified OAuthIdentity from the provider verifier.
        db: Async DB session (request-scoped).
        background_tasks: FastAPI BackgroundTasks for post-response tasks.

    Returns:
        OAuthTokenResponse with access/refresh tokens + needs_onboarding flag.
    """
    from sqlalchemy import select

    from app.models.user import MemberProfile, User

    # Case-insensitive email lookup, excluding soft-deleted accounts.
    result = await db.execute(
        select(User).where(
            User.email == identity.email.lower(),
            User.deleted_at.is_(None),
        )
    )
    user = result.scalar_one_or_none()

    needs_onboarding = False

    if user is None:
        # New user — create a MEMBER account. CHW accounts are never auto-created
        # via social sign-in (CHWs are vetted and must register through the
        # normal flow with background check / credentialing).
        name = identity.name or identity.email.split("@")[0]
        user = User(
            email=identity.email.lower(),
            password_hash=None,  # social users have no password
            name=name,
            role="member",
        )
        db.add(user)
        await db.flush()  # populate user.id without ending transaction

        # Create a minimal MemberProfile flagged as incomplete.
        profile = MemberProfile(
            user_id=user.id,
            onboarding_complete=False,  # must complete onboarding before Pear sync
        )
        db.add(profile)
        await db.commit()
        await db.refresh(user)

        needs_onboarding = True

        # Schedule background tasks — fire-and-forget, same as /auth/register.
        # They will short-circuit cleanly because is_pear_complete() returns False
        # for a profile with no DOB/gender/insurance, so no Pear row is written
        # until /auth/complete-member-onboarding supplies those fields.
        background_tasks.add_task(_sync_new_member_to_pear, user.id)
        background_tasks.add_task(_append_new_member_to_csv, user.id)

        # Best-effort signup confirmation email (Epic A). Fire-and-forget,
        # same guarantee as /auth/register — never blocks or fails sign-up.
        background_tasks.add_task(send_signup_confirmations, user.id)
    else:
        # Existing user — check if they still need onboarding (OAuth-created members
        # that haven't completed the form yet).
        if user.role == "member":
            existing_profile_result = await db.execute(
                select(MemberProfile).where(MemberProfile.user_id == user.id)
            )
            existing_profile: MemberProfile | None = existing_profile_result.scalar_one_or_none()
            if existing_profile is not None and not existing_profile.onboarding_complete:
                needs_onboarding = True

    # OAuth sign-in/sign-up mints tokens directly (no separate /auth/login
    # call) — this is the user's first successful authentication just like
    # self-service register's auto-login.
    mark_first_login(user)
    access, refresh = create_tokens(user)
    await store_refresh_token(db, user.id, refresh)
    return OAuthTokenResponse(
        access_token=access,
        refresh_token=refresh,
        role=user.role,
        name=user.name,
        needs_onboarding=needs_onboarding,
    )


@router.post(
    "/oauth/google",
    response_model=OAuthTokenResponse,
    summary="Sign in or sign up with a Google id_token",
)
async def oauth_google(
    data: OAuthRequest,
    background_tasks: BackgroundTasks,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> OAuthTokenResponse:
    """Exchange a Google id_token for Compass JWT access + refresh tokens.

    The frontend (Google Identity Services JS SDK) completes the OAuth handshake
    and sends only the id_token here. The backend verifies it cryptographically
    against Google's public keys before taking any action.

    - Provider not configured (GOOGLE_OAUTH_CLIENT_ID unset) → 503
    - Invalid / expired / tampered token → 401
    - Unverified email (email_verified=False) → 401
    - Known email → sign in (any role); needs_onboarding=False
    - New email → create MEMBER account; needs_onboarding=True
    """
    if not _settings.oauth_google_enabled:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Google OAuth is not configured on this server",
        )

    identity = await verify_google_id_token(data.id_token)
    if identity is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired Google token")

    if not identity.email_verified:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Google account email is not verified",
        )

    return await _handle_oauth_signin(identity, db, background_tasks)


@router.post(
    "/oauth/apple",
    response_model=OAuthTokenResponse,
    summary="Sign in or sign up with an Apple id_token",
)
async def oauth_apple(
    data: OAuthRequest,
    background_tasks: BackgroundTasks,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> OAuthTokenResponse:
    """Exchange a Sign in with Apple id_token for Compass JWT access + refresh tokens.

    The frontend (Sign in with Apple JS SDK) completes the OAuth handshake and
    sends only the id_token here. The backend verifies it against Apple's JWKS.

    Apple specifics:
    - email may be a private-relay address (stored as-is)
    - name is only present on first consent — handled gracefully
    - email_verified may be the string "true" (coerced in verifier)

    - Provider not configured (APPLE_OAUTH_CLIENT_ID unset) → 503
    - Invalid / expired / tampered token → 401
    - Known email → sign in (any role); needs_onboarding=False
    - New email → create MEMBER account; needs_onboarding=True
    """
    if not _settings.oauth_apple_enabled:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Apple OAuth is not configured on this server",
        )

    identity = await verify_apple_id_token(data.id_token)
    if identity is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired Apple token")

    if not identity.email_verified:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Apple account email is not verified",
        )

    return await _handle_oauth_signin(identity, db, background_tasks)


@router.post(
    "/complete-member-onboarding",
    response_model=None,
    summary="Complete required profile fields for OAuth-registered members",
)
async def complete_member_onboarding(
    data: CompleteOnboardingRequest,
    background_tasks: BackgroundTasks,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
):
    """Supply the Pear-required fields for an OAuth-created member account.

    OAuth-registered members skip the normal signup form (which requires DOB,
    sex, insurance, CIN, ZIP). This endpoint accepts those fields, writes them
    to the MemberProfile, flips onboarding_complete=True, and fires the same
    post-signup background tasks (/auth/register fires) so the member appears
    in Pear Suite and the member CSV after completing onboarding.

    Authorization:
    - Requires Bearer JWT (any valid user).
    - Role must be "member" — CHWs get 403.
    - Idempotent: calling twice overwrites fields and returns 200 both times.

    Returns:
    - 200 with MemberProfileResponse (the updated profile).
    - 403 if caller is a CHW or admin.
    - 422 if required fields are invalid (CIN validation applies).
    """
    from sqlalchemy import select

    from app.models.user import MemberProfile
    from app.schemas.user import MemberProfileResponse

    if current_user.role != "member":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only members can complete onboarding",
        )

    result = await db.execute(
        select(MemberProfile).where(MemberProfile.user_id == current_user.id)
    )
    profile = result.scalar_one_or_none()
    if profile is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Member profile not found")

    # Write the Pear-required fields. Mirrors the allow-list in auth_service.register_user.
    profile.date_of_birth = data.date_of_birth
    profile.gender = data.gender
    profile.insurance_company = data.insurance_company
    profile.medi_cal_id = data.medi_cal_id  # already carrier-validated by CompleteOnboardingRequest
    profile.zip_code = data.zip_code

    # Optional address fields — write when supplied.
    if data.address_line1 is not None:
        profile.address_line1 = data.address_line1
    if data.address_line2 is not None:
        profile.address_line2 = data.address_line2
    if data.city is not None:
        profile.city = data.city
    if data.state is not None:
        profile.state = data.state

    profile.onboarding_complete = True
    await db.commit()
    await db.refresh(profile)

    # Fire the same post-signup background tasks as /auth/register — now that the
    # profile is complete, Pear sync and CSV export will succeed where they
    # previously short-circuited on the incomplete profile.
    background_tasks.add_task(_sync_new_member_to_pear, current_user.id)
    background_tasks.add_task(_append_new_member_to_csv, current_user.id)

    return MemberProfileResponse(
        id=profile.id,
        user_id=profile.user_id,
        zip_code=profile.zip_code,
        primary_language=profile.primary_language,
        primary_need=profile.primary_need,
        rewards_balance=profile.rewards_balance,
        insurance_provider=profile.insurance_provider,
        insurance_company=profile.insurance_company,
        name=current_user.name,
        phone=current_user.phone,
        email=current_user.email,
        profile_picture_url=presigned_avatar_url(current_user.profile_picture_url),
        preferred_name=profile.preferred_name,
        date_of_birth=profile.date_of_birth,
        gender=profile.gender,
        address_line1=profile.address_line1,
        address_line2=profile.address_line2,
        city=profile.city,
        state=profile.state,
        medi_cal_id=profile.medi_cal_id,
        must_change_password=current_user.must_change_password,
    )


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(data: RefreshRequest, db: Annotated[AsyncSession, Depends(get_db)], current_user=Depends(get_current_user)):
    await revoke_refresh_token(db, data.refresh_token)


# ─── Account deletion ─────────────────────────────────────────────────────────


class _DeleteAccountBody(BaseModel):
    # Optional password re-confirmation. Web members use a Yes/No prompt
    # (no password challenge). If the iOS/Android app is ever submitted to
    # the App Store / Play Store, Apple §5.1.1 and Google Play policy
    # prefer an explicit re-auth step; reinstate by changing this to
    # ``password: str`` and surfacing a password field in the UI's confirm
    # prompt.
    password: str | None = None


@router.delete(
    "/users/me",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Permanently and irrecoverably delete the authenticated user's account",
    description=(
        "Hard-deletes the caller's account and all member-owned PHI. "
        "MemberProfile, sessions, messages, documents, case notes, and every "
        "other member-owned data row are permanently removed from the "
        "database — this cannot be undone. The `users` row itself is kept "
        "(scrubbed to a non-identifying tombstone in place) only because a "
        "small number of append-only ledger tables carry a database-level "
        "RESTRICT constraint that blocks removing it outright; no PII "
        "survives on that row. "
        "The original email address is freed immediately for re-registration. "
        "Billing claims and audit-log rows are retained for the HIPAA "
        "6-year audit window (45 CFR §164.530(j)) but no longer resolve to "
        "any identifying information. "
        "After deletion the account cannot be recovered via magic-link or "
        "password-reset flows because is_active is set to false and the "
        "password hash is cleared. "
        "Authentication is via JWT only; password re-confirmation is "
        "accepted but no longer required (web-only product surface; "
        "reinstate before App Store / Play Store submission)."
    ),
)
@limiter.limit("3/minute")
async def delete_account(
    request: Request,
    data: _DeleteAccountBody,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> None:
    """Hard-delete the authenticated user's account and all member-owned PHI.

    Security:
    - JWT auth (via current_user dependency) confirms the caller is the
      account owner.  When a password IS supplied in the body it must
      match — this lets us keep mobile-app callers backward-compatible
      with the previous password-required contract.
    - Rate-limited to 3 calls/minute per IP to prevent abuse if a JWT is
      ever leaked.

    Returns 204 No Content on success (idempotent — also 204 if already deleted).
    Returns 401 if a password is supplied but does not match.
    Returns 500 (never a bare unhandled crash) if the hard-delete transaction
    fails partway through — the session is rolled back so the account is left
    fully intact; see app/services/account_deletion.py's transactionality
    guarantee and tests/test_account_deactivation.py::TestHardDeleteTransactionality.
    """
    from app.services.account_deletion import execute_account_deletion
    from app.utils.security import verify_password

    # Idempotency guard: if the account is already deleted, return 204
    # immediately.  The current_user dependency will have already rejected the
    # request if is_active is False, so this guard is belt-and-suspenders for
    # future dependency changes.
    if current_user.deleted_at is not None:
        return

    # If the caller supplied a password (legacy mobile clients still do),
    # verify it.  Web clients on the Yes/No flow send no password and rely
    # on the JWT alone.
    if data.password is not None and data.password != "":
        # OAuth-registered users have no password — treat supplied password as incorrect.
        if current_user.password_hash is None or not verify_password(data.password, current_user.password_hash):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Incorrect password",
            )

    ip_address: str | None = request.client.host if request.client else None
    user_agent: str | None = request.headers.get("user-agent")
    # Captured before the try block: after a rollback, `current_user` is an
    # expired ORM instance, and accessing an attribute on it would trigger a
    # lazy-load (implicit IO) outside the SQLAlchemy async greenlet context,
    # raising MissingGreenlet instead of the intended clean HTTPException.
    user_id_for_logging = current_user.id

    try:
        await execute_account_deletion(
            db=db,
            user=current_user,
            ip_address=ip_address,
            user_agent=user_agent,
        )
        await db.commit()
    except Exception as exc:
        # execute_account_deletion never commits internally, so a rollback
        # here undoes every row-scrub/DELETE issued during this attempt —
        # the account is left fully intact. Never let a bare exception
        # surface as an unhandled 500 with no CORS headers (TESTING.md rule 3).
        await db.rollback()
        logger.exception(
            "delete_account.hard_delete_failed user_id=%s", user_id_for_logging
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Account deletion failed and was rolled back: {type(exc).__name__}: {exc}",
        ) from exc


# ─── Magic Link (passwordless) ────────────────────────────────────────────────

class MagicLinkRequest(Annotated[dict, None]):  # pragma: no cover
    """Just here so the Pydantic model below resolves with mypy."""


from pydantic import BaseModel, EmailStr  # noqa: E402


class _MagicLinkRequestBody(BaseModel):
    email: EmailStr


class _MagicLinkVerifyBody(BaseModel):
    token: str


@router.post("/magic/request", status_code=status.HTTP_202_ACCEPTED)
@limiter.limit("3/minute")
async def request_magic_link(
    request: Request,
    data: _MagicLinkRequestBody,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Send a passwordless login link to the user's email.

    Security notes:
    - Always returns 202 regardless of whether the email exists — prevents
      account enumeration. The side effect (sending or not sending the email)
      is invisible to the caller.
    - Rate-limited to 3/min per IP. The attacker still can't harvest the list
      of registered users.
    - Token is cryptographically random (32 bytes, URL-safe base64).
    - We store only the SHA-256 hash of the token (same pattern as refresh tokens).
    """
    import hashlib
    import secrets
    from datetime import UTC, datetime, timedelta

    from sqlalchemy import select

    from app.config import settings
    from app.models.magic_link import MagicLinkToken
    from app.models.user import User

    # Look up user; if missing, silently succeed
    result = await db.execute(select(User).where(User.email == data.email.lower()))
    user = result.scalar_one_or_none()
    if user is None or not user.is_active:
        return {"status": "accepted"}

    # Generate a fresh token + hash
    raw_token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
    expires_at = datetime.now(UTC) + timedelta(minutes=settings.magic_link_ttl_minutes)

    db.add(MagicLinkToken(
        user_id=user.id,
        token_hash=token_hash,
        expires_at=expires_at,
        ip_address=request.client.host if request.client else None,
    ))
    await db.commit()

    # Build the magic link URL — the mobile app's deep link handler
    # parses this and calls /auth/magic/verify with the token.
    magic_url = f"{settings.magic_link_base_url}?token={raw_token}"

    # Deliver via email. Failures are logged but don't change the API response —
    # we still return 202 to preserve the no-enumeration property. The raw token
    # is a bearer credential: it must never reach logs outside local development
    # (CloudWatch retains log groups, so a logged URL is a stored credential).
    import logging

    from app.services.email import send_magic_link_email
    email_result = await send_magic_link_email(
        to=data.email,
        magic_url=magic_url,
        ttl_minutes=settings.magic_link_ttl_minutes,
    )
    if not email_result.success:
        logger = logging.getLogger("compass.auth")
        logger.warning(
            "Magic link email for user %s failed: %s", user.id, email_result.error,
        )
        if settings.environment == "development":
            # Local-only convenience when SES isn't configured.
            logger.warning("Magic link URL (development only): %s", magic_url)

    return {"status": "accepted"}


@router.post("/magic/verify", response_model=TokenResponse)
async def verify_magic_link(
    data: _MagicLinkVerifyBody,
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """Exchange a magic link token for JWT access + refresh tokens."""
    import hashlib
    from datetime import UTC, datetime

    from sqlalchemy import select

    from app.models.magic_link import MagicLinkToken

    token_hash = hashlib.sha256(data.token.encode("utf-8")).hexdigest()
    result = await db.execute(
        select(MagicLinkToken).where(MagicLinkToken.token_hash == token_hash)
    )
    mt = result.scalar_one_or_none()
    if mt is None:
        raise HTTPException(status_code=401, detail="Invalid or expired link")

    now = datetime.now(UTC)
    # Compare with tz-aware datetimes; DB column is TIMESTAMP WITH TIME ZONE
    if mt.consumed_at is not None:
        raise HTTPException(status_code=401, detail="Link already used")
    if mt.expires_at < now:
        raise HTTPException(status_code=401, detail="Link expired")

    user = await db.get(User, mt.user_id)
    if user is None or not user.is_active:
        raise HTTPException(status_code=401, detail="Account not available")

    mt.consumed_at = now
    access, refresh = create_tokens(user)
    await store_refresh_token(db, user.id, refresh)
    await db.commit()
    return TokenResponse(
        access_token=access, refresh_token=refresh, role=user.role, name=user.name,
        must_change_password=user.must_change_password,
    )

"""Phone SMS verification endpoints.

POST /api/v1/phone/start-verification
    Generates a 6-digit OTP, stores the argon2 hash in phone_verifications,
    and delivers the code via Vonage SMS.  Rate-limited to 3 starts per user
    per hour.

POST /api/v1/phone/confirm-verification
    Validates the submitted code against the stored hash.  On success, sets
    User.phone + User.phone_verified_at and marks the PhoneVerification row
    as consumed.  Each wrong guess decrements attempts_left; reaching 0
    exhausts the row and the user must start a new challenge.

Both endpoints require a valid JWT (``Depends(get_current_user)``).

The OTP mechanics (rate-limit cap, argon2 hashing, TTL, attempt decrement)
live in ``app.services.otp`` and are shared verbatim with the SMS 2FA login
challenge (Spec 2) — this router only owns the phone-verification-specific
concerns (sentinel guard, E.164 request validation, and persisting the verified
phone onto the User row).

HIPAA: phone numbers logged only as last-4 digits at INFO level.
"""

import logging
import re
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, field_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.limiter import limiter
from app.models.phone_verification import PhoneVerification
from app.models.user import User
from app.services.otp import OtpCheckError, check_otp, create_otp
from app.utils.phone import is_placeholder_phone

logger = logging.getLogger("compass.phone_verification")

router = APIRouter(prefix="/api/v1/phone", tags=["phone-verification"])

# E.164 pattern: + followed by 7–15 digits (ITU-T E.164 limits).
_E164_PATTERN = re.compile(r"^\+[1-9]\d{6,14}$")

_LOG_SUFFIX_LEN = 4

# TTL as a timedelta for the start-verification response's expires_at. Kept in
# lockstep with the code's persisted expiry (owned by app.services.otp) via the
# same PhoneVerification.CODE_TTL_MINUTES constant.
_CODE_TTL = timedelta(minutes=PhoneVerification.CODE_TTL_MINUTES)


def _masked(phone_e164: str) -> str:
    """Return a HIPAA-safe representation: ***XXXX (last 4 digits only)."""
    suffix = phone_e164[-_LOG_SUFFIX_LEN:] if len(phone_e164) >= _LOG_SUFFIX_LEN else phone_e164
    return f"***{suffix}"


# ─── Pydantic schemas ─────────────────────────────────────────────────────────


class StartVerificationRequest(BaseModel):
    """Request body for POST /phone/start-verification."""

    phone: str

    @field_validator("phone")
    @classmethod
    def validate_e164(cls, value: str) -> str:
        """Reject any phone string that isn't strict E.164."""
        stripped = value.strip()
        if not _E164_PATTERN.match(stripped):
            raise ValueError(
                "phone must be in E.164 format (e.g. +12125551234). "
                "Include the country code with a leading +."
            )
        return stripped


class StartVerificationResponse(BaseModel):
    """Response body for POST /phone/start-verification."""

    expires_at: datetime


class ConfirmVerificationRequest(BaseModel):
    """Request body for POST /phone/confirm-verification."""

    phone: str
    code: str

    @field_validator("phone")
    @classmethod
    def validate_e164(cls, value: str) -> str:
        stripped = value.strip()
        if not _E164_PATTERN.match(stripped):
            raise ValueError("phone must be in E.164 format (e.g. +12125551234).")
        return stripped

    @field_validator("code")
    @classmethod
    def validate_code_format(cls, value: str) -> str:
        """Ensure the code is exactly 6 ASCII digits."""
        stripped = value.strip()
        if not re.fullmatch(r"\d{6}", stripped):
            raise ValueError("code must be exactly 6 digits.")
        return stripped


class ConfirmVerificationResponse(BaseModel):
    """Response body for POST /phone/confirm-verification."""

    verified: bool


# ─── Endpoints ────────────────────────────────────────────────────────────────


@router.post(
    "/start-verification",
    response_model=StartVerificationResponse,
    status_code=status.HTTP_200_OK,
    summary="Start SMS phone verification",
    description=(
        "Generate a 6-digit OTP, store its hash, and deliver via Vonage SMS. "
        "Rate-limited to 3 requests per user per hour."
    ),
)
@limiter.limit("10/minute")  # IP-level hard cap; per-user cap enforced in handler
async def start_verification(
    request: Request,
    body: StartVerificationRequest,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> StartVerificationResponse:
    """Issue a fresh OTP challenge for *phone*.

    Rate-limit: max 3 PhoneVerification rows per user in the past hour (enforced
    by ``app.services.otp.create_otp``, which raises 429 when exceeded). A new
    row is always inserted (codes are not recycled) so each SMS carries a
    fresh, independently-valid code regardless of whether the previous one
    expired or failed delivery.

    Returns the challenge expiry timestamp so the client can display a
    countdown and know when to offer the "Resend" button.
    """
    # ── Sentinel guard (Spec 1 §1, decision 2) ────────────────────────────────
    # The 555-555-5555 placeholder is treated as fully SMS-opted-out: it has no
    # real device behind it, so it can never receive an OTP. Reject before we
    # generate/store a code or attempt delivery.
    if is_placeholder_phone(body.phone):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="This phone number is a placeholder and can't receive texts.",
        )

    # ── Generate, hash, and persist the OTP (shared machinery) ────────────────
    # create_otp enforces the 3-per-hour per-user cap and commits the row.
    raw_code = await create_otp(db, current_user.id, body.phone)
    expires_at = datetime.now(UTC) + _CODE_TTL

    # ── Deliver via SMS — unified async Messages client (Spec 1 §1) ───────────
    # Single SMS-emitting channel: the JWT-authenticated Vonage Messages API,
    # branded via ``brand_outbound_sms`` for 10DLC sender identification. The
    # legacy sync key/secret OTP client has been retired — no sync HTTP call
    # blocks the event loop here.
    from app.routers.conversations import brand_outbound_sms
    from app.services.vonage_sms import get_vonage_sms_messages_client

    otp_body = brand_outbound_sms(
        f"Your verification code is {raw_code}. "
        f"It expires in {PhoneVerification.CODE_TTL_MINUTES} minutes."
    )
    sms_result = await get_vonage_sms_messages_client().send_text(body.phone, otp_body)

    if not sms_result.success:
        logger.error(
            "SMS delivery failed for user %s to %s (error=%s). "
            "Verification row is stored; user may retry.",
            current_user.id,
            _masked(body.phone),
            sms_result.error,
        )
        # We do not roll back the DB row — the OTP is valid and the user
        # can retry sending (within rate limits).  Return 500 so the client
        # knows delivery failed and shows an appropriate error.
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Could not send verification SMS. Please try again.",
        )

    logger.info(
        "Phone OTP issued for user %s to %s.",
        current_user.id,
        _masked(body.phone),
    )

    return StartVerificationResponse(expires_at=expires_at)


@router.post(
    "/confirm-verification",
    response_model=ConfirmVerificationResponse,
    status_code=status.HTTP_200_OK,
    summary="Confirm SMS phone verification code",
    description=(
        "Validate the 6-digit OTP. On success, sets User.phone and "
        "User.phone_verified_at. Each wrong guess decrements attempts_left; "
        "reaching 0 exhausts the code."
    ),
)
@limiter.limit("20/minute")  # IP-level hard cap; per-code cap via attempts_left
async def confirm_verification(
    request: Request,
    body: ConfirmVerificationRequest,
    db: Annotated[AsyncSession, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> ConfirmVerificationResponse:
    """Verify *code* against the active PhoneVerification row.

    Security:
    - Only the most recent active row for (user, phone) is consulted.
    - Wrong codes decrement attempts_left and return 400 with the
      remaining count so the UI can surface a meaningful error.
    - An exhausted (attempts_left=0) or expired row returns 410 Gone,
      prompting the user to request a new code.
    - On success: User.phone is updated to the verified E.164 number and
      User.phone_verified_at is set.  The PhoneVerification.verified_at
      timestamp is set to mark the row consumed.
    """
    # Scope the lookup/verify to (user, phone) — identical to the pre-extraction
    # behaviour — via app.services.otp.check_otp. It sets verified_at in-session
    # (uncommitted) on success so the consumption unwinds atomically with the
    # User.phone write below if that hits the duplicate-phone constraint.
    try:
        await check_otp(db, current_user.id, body.code, phone_e164=body.phone)
    except OtpCheckError as err:
        if err.reason == "no_active":
            logger.info(
                "No active verification found for user %s phone %s.",
                current_user.id,
                _masked(body.phone),
            )
            raise HTTPException(
                status_code=status.HTTP_410_GONE,
                detail=(
                    "No active verification code for this number. "
                    "Please request a new code."
                ),
            ) from err
        if err.reason == "exhausted":
            logger.info(
                "OTP exhausted for user %s phone %s.",
                current_user.id,
                _masked(body.phone),
            )
            raise HTTPException(
                status_code=status.HTTP_410_GONE,
                detail=(
                    "Too many incorrect attempts. "
                    "Please request a new verification code."
                ),
            ) from err
        # wrong_code
        logger.info(
            "Invalid OTP for user %s phone %s. attempts_left=%d.",
            current_user.id,
            _masked(body.phone),
            err.attempts_left,
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Incorrect code. {err.attempts_left} attempt(s) remaining.",
        ) from err

    # ── Success — persist verified phone on User ───────────────────────────────
    now = datetime.now(UTC)

    # Captured BEFORE any rollback — db.rollback() expires every ORM-tracked
    # attribute on `user`/`current_user`, so reading .id off either instance
    # afterward (e.g. in the except block's log line) triggers a lazy-refresh
    # query against a session that just rolled back, which itself raises.
    # Plain locals are safe to use after rollback; ORM attributes are not.
    current_user_id = current_user.id

    # Reload the user within this session to avoid stale state
    user_result = await db.execute(select(User).where(User.id == current_user_id))
    user = user_result.scalar_one()
    user.phone = body.phone
    user.phone_verified_at = now

    try:
        await db.commit()
    except IntegrityError as exc:
        # QA-batch #1's platform-wide unique index on users.phone (partial,
        # WHERE phone IS NOT NULL) applies here too — this write path sets
        # User.phone directly and does NOT go through
        # auth_service.register_user's pre-create duplicate check, so this
        # is the backstop that would otherwise surface as a raw
        # IntegrityError/500 (TESTING.md rule #3: no unhandled 500s) if two
        # different users ever verified the same number. The rollback also
        # unwinds check_otp's in-session verified_at stamp, so the code row is
        # NOT consumed and the user can retry with a different number.
        await db.rollback()
        logger.info(
            "confirm-verification: rejected duplicate phone ending in %s for user %s.",
            _masked(body.phone),
            current_user_id,
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An account with this phone number already exists.",
        ) from exc

    logger.info(
        "Phone %s verified for user %s.",
        _masked(body.phone),
        current_user_id,
    )

    return ConfirmVerificationResponse(verified=True)

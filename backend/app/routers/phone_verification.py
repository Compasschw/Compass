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

HIPAA: phone numbers logged only as last-4 digits at INFO level.
"""

import logging
import re
import secrets
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, field_validator
from sqlalchemy import and_, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.limiter import limiter
from app.models.phone_verification import PhoneVerification
from app.models.user import User
from app.utils.phone import is_placeholder_phone
from app.utils.security import pwd_context

logger = logging.getLogger("compass.phone_verification")

router = APIRouter(prefix="/api/v1/phone", tags=["phone-verification"])

# E.164 pattern: + followed by 7–15 digits (ITU-T E.164 limits).
_E164_PATTERN = re.compile(r"^\+[1-9]\d{6,14}$")

_LOG_SUFFIX_LEN = 4


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


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _generate_otp() -> str:
    """Generate a cryptographically random 6-digit numeric OTP."""
    # secrets.randbelow(1_000_000) gives [0, 999_999]; zero-pad to always 6
    # digits so "000123" is a valid code and not ambiguously 3 digits.
    return f"{secrets.randbelow(1_000_000):06d}"


async def _count_recent_starts(
    db: AsyncSession,
    user_id,
    since: datetime,
) -> int:
    """Count PhoneVerification rows created for this user since *since*."""
    result = await db.execute(
        select(func.count()).where(
            and_(
                PhoneVerification.user_id == user_id,
                PhoneVerification.created_at >= since,
            )
        )
    )
    return result.scalar_one()


async def _find_active_verification(
    db: AsyncSession,
    user_id,
    phone_e164: str,
    now: datetime,
) -> PhoneVerification | None:
    """Return the most recent un-expired, un-verified, un-exhausted row."""
    result = await db.execute(
        select(PhoneVerification)
        .where(
            and_(
                PhoneVerification.user_id == user_id,
                PhoneVerification.phone_e164 == phone_e164,
                PhoneVerification.expires_at > now,
                PhoneVerification.verified_at.is_(None),
                PhoneVerification.attempts_left > 0,
            )
        )
        .order_by(PhoneVerification.created_at.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


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

    Rate-limit: max 3 PhoneVerification rows per user in the past hour.
    A new row is always inserted (codes are not recycled) so each SMS
    carries a fresh, independently-valid code regardless of whether the
    previous one expired or failed delivery.

    Returns the challenge expiry timestamp so the client can display a
    countdown and know when to offer the "Resend" button.
    """
    now = datetime.now(UTC)
    one_hour_ago = now - timedelta(hours=1)

    # ── Sentinel guard (Spec 1 §1, decision 2) ────────────────────────────────
    # The 555-555-5555 placeholder is treated as fully SMS-opted-out: it has no
    # real device behind it, so it can never receive an OTP. Reject before we
    # generate/store a code or attempt delivery.
    if is_placeholder_phone(body.phone):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="This phone number is a placeholder and can't receive texts.",
        )

    # ── Per-user rate limiting ────────────────────────────────────────────────
    recent_count = await _count_recent_starts(db, current_user.id, since=one_hour_ago)
    if recent_count >= PhoneVerification.MAX_STARTS_PER_HOUR:
        logger.warning(
            "Phone verification rate limit hit for user %s (phone %s).",
            current_user.id,
            _masked(body.phone),
        )
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=(
                "Too many verification attempts. "
                "Please wait before requesting another code."
            ),
        )

    # ── Generate and hash the OTP ─────────────────────────────────────────────
    raw_code = _generate_otp()
    code_hash = pwd_context.hash(raw_code)
    expires_at = now + timedelta(minutes=PhoneVerification.CODE_TTL_MINUTES)

    pv = PhoneVerification(
        user_id=current_user.id,
        phone_e164=body.phone,
        code_hash=code_hash,
        attempts_left=PhoneVerification.MAX_ATTEMPTS,
        expires_at=expires_at,
    )
    db.add(pv)
    await db.commit()

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
            "Verification row id=%s is stored; user may retry.",
            current_user.id,
            _masked(body.phone),
            sms_result.error,
            pv.id,
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
    now = datetime.now(UTC)

    pv = await _find_active_verification(db, current_user.id, body.phone, now)

    if pv is None:
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
        )

    # ── Verify the submitted code ──────────────────────────────────────────────
    code_valid = pwd_context.verify(body.code, pv.code_hash)

    if not code_valid:
        pv.attempts_left -= 1
        await db.commit()

        remaining = pv.attempts_left
        logger.info(
            "Invalid OTP for user %s phone %s. attempts_left=%d.",
            current_user.id,
            _masked(body.phone),
            remaining,
        )

        if remaining <= 0:
            raise HTTPException(
                status_code=status.HTTP_410_GONE,
                detail=(
                    "Too many incorrect attempts. "
                    "Please request a new verification code."
                ),
            )

        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Incorrect code. {remaining} attempt(s) remaining.",
        )

    # ── Success — persist verified phone on User ───────────────────────────────
    pv.verified_at = now

    # Captured BEFORE any rollback — db.rollback() expires every ORM-tracked
    # attribute on `user`/`current_user`, so reading .id off either instance
    # afterward (e.g. in the except block's log line) triggers a lazy-refresh
    # query against a session that just rolled back, which itself raises.
    # Plain locals are safe to use after rollback; ORM attributes are not.
    current_user_id = current_user.id

    # Reload the user within this session to avoid stale state
    user_result = await db.execute(
        select(User).where(User.id == current_user_id)
    )
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
        # different users ever verified the same number.
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
        current_user.id,
    )

    return ConfirmVerificationResponse(verified=True)

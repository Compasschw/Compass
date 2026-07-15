"""Reusable SMS OTP machinery — shared by phone verification (Spec 1) and the
SMS 2FA login challenge (Spec 2).

Extracted verbatim from ``app.routers.phone_verification`` so both surfaces use
one implementation of: the 3-starts-per-hour cap, the argon2-hashed 6-digit
code, the 10-minute TTL, and the attempt-decrement / exhaustion semantics.

The two entry points are deliberately transport-agnostic — they raise a typed
:class:`OtpCheckError` (or an ``HTTPException`` for the rate-limit) rather than
baking in a specific HTTP status, because the two callers map a wrong code to
DIFFERENT statuses (phone-verification confirm → 400 with remaining-count;
2FA verify → 422). Everything else (no active code, exhausted, expired → 410)
is shared.

Codes are NEVER stored or logged in plaintext — only the argon2 hash is kept in
``phone_verifications.code_hash``; the raw digits are returned to the caller for
a single SMS send and then discarded.
"""

from __future__ import annotations

import secrets
from datetime import UTC, datetime, timedelta
from typing import Literal
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.phone_verification import PhoneVerification
from app.utils.security import pwd_context

#: Outcome discriminator for :class:`OtpCheckError` so each caller can map to
#: its own HTTP status while sharing the verification logic.
OtpFailureReason = Literal["no_active", "wrong_code", "exhausted"]


class OtpCheckError(Exception):
    """Raised by :func:`check_otp` when a submitted code is not accepted.

    Attributes:
        reason: ``"no_active"`` — no un-expired, un-exhausted code for the user
            (or phone, when scoped); ``"wrong_code"`` — the code did not match
            and attempts remain; ``"exhausted"`` — this guess consumed the last
            attempt (the row is now spent).
        attempts_left: Remaining attempts after a ``"wrong_code"`` failure (0
            for the other reasons). Lets the caller surface the "N attempt(s)
            remaining" message unchanged.
    """

    def __init__(self, reason: OtpFailureReason, attempts_left: int = 0) -> None:
        self.reason: OtpFailureReason = reason
        self.attempts_left = attempts_left
        super().__init__(f"OTP check failed: {reason}")


def generate_otp() -> str:
    """Generate a cryptographically random, zero-padded 6-digit numeric OTP."""
    # secrets.randbelow(1_000_000) gives [0, 999_999]; zero-pad to always 6
    # digits so "000123" is a valid code and not ambiguously 3 digits.
    return f"{secrets.randbelow(1_000_000):06d}"


async def _count_recent_starts(
    db: AsyncSession, user_id: UUID, since: datetime
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
    user_id: UUID,
    now: datetime,
    phone_e164: str | None,
) -> PhoneVerification | None:
    """Return the most recent un-expired, un-verified, un-exhausted row.

    When ``phone_e164`` is provided the lookup is scoped to that (user, phone)
    pair — exactly the behaviour phone-verification confirm relied on. When
    ``None`` (the 2FA verify path, which carries no phone) the most recent
    active row for the user is used regardless of phone.
    """
    conditions = [
        PhoneVerification.user_id == user_id,
        PhoneVerification.expires_at > now,
        PhoneVerification.verified_at.is_(None),
        PhoneVerification.attempts_left > 0,
    ]
    if phone_e164 is not None:
        conditions.append(PhoneVerification.phone_e164 == phone_e164)
    result = await db.execute(
        select(PhoneVerification)
        .where(and_(*conditions))
        .order_by(PhoneVerification.created_at.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def create_otp(db: AsyncSession, user_id: UUID, phone_e164: str) -> str:
    """Issue a fresh OTP challenge row for ``(user_id, phone_e164)`` and COMMIT.

    Enforces the per-user cap of ``PhoneVerification.MAX_STARTS_PER_HOUR`` rows
    in the trailing hour, raising ``HTTPException(429)`` when exceeded. A new
    row is always inserted (codes are never recycled) so each SMS carries a
    fresh, independently-valid code.

    Returns the raw 6-digit code for the caller to deliver via SMS. The caller
    is responsible for the sentinel / duplicate-phone checks appropriate to its
    surface — those are intentionally NOT here so this stays a pure
    rate-limit-plus-issue primitive.
    """
    now = datetime.now(UTC)
    one_hour_ago = now - timedelta(hours=1)

    recent_count = await _count_recent_starts(db, user_id, since=one_hour_ago)
    if recent_count >= PhoneVerification.MAX_STARTS_PER_HOUR:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=(
                "Too many verification attempts. "
                "Please wait before requesting another code."
            ),
        )

    raw_code = generate_otp()
    pv = PhoneVerification(
        user_id=user_id,
        phone_e164=phone_e164,
        code_hash=pwd_context.hash(raw_code),
        attempts_left=PhoneVerification.MAX_ATTEMPTS,
        expires_at=now + timedelta(minutes=PhoneVerification.CODE_TTL_MINUTES),
    )
    db.add(pv)
    await db.commit()
    return raw_code


async def check_otp(
    db: AsyncSession,
    user_id: UUID,
    code: str,
    *,
    phone_e164: str | None = None,
) -> str:
    """Validate ``code`` against the user's active OTP row; return its phone.

    On success sets ``verified_at`` on the row IN-SESSION but does NOT commit —
    the caller owns the commit so any additional same-transaction mutation
    (e.g. setting ``User.phone`` on enrollment, which may hit a duplicate-phone
    IntegrityError) rolls the consumption back atomically with it.

    On a wrong guess the attempt decrement IS committed here (so it survives the
    subsequent ``HTTPException``, whose propagation would otherwise roll the
    session back), then :class:`OtpCheckError` is raised.

    Args:
        phone_e164: When provided, scope the active-row lookup to this phone
            (phone-verification confirm). When ``None`` (2FA verify), use the
            most recent active row for the user.

    Returns:
        The E.164 phone the matched row was issued for.

    Raises:
        OtpCheckError: ``no_active`` / ``wrong_code`` / ``exhausted``.
    """
    now = datetime.now(UTC)
    pv = await _find_active_verification(db, user_id, now, phone_e164)
    if pv is None:
        raise OtpCheckError("no_active")

    if not pwd_context.verify(code, pv.code_hash):
        pv.attempts_left -= 1
        # Commit the decrement BEFORE raising: get_db rolls the session back on
        # any exception, so without this the attempt would not stick.
        await db.commit()
        if pv.attempts_left <= 0:
            raise OtpCheckError("exhausted")
        raise OtpCheckError("wrong_code", attempts_left=pv.attempts_left)

    # Mark consumed in-session; caller commits (possibly alongside other
    # mutations) so a downstream failure unwinds the consumption too.
    pv.verified_at = now
    return pv.phone_e164

"""User-facing SMS two-factor service (SMS Output Spec 2).

This module owns the security-sensitive primitives behind the CHW/member SMS
2FA login challenge:

* the single-purpose *pending* JWT that authorizes exactly the two
  ``/auth/2fa/*`` endpoints (and nothing else) between a correct password and
  a verified OTP;
* the "requires 2FA?" policy (CHWs always; members opt-in with a verified,
  non-sentinel phone; the ``chw_sms_2fa_enabled`` flag is the emergency off
  switch that restores today's login for everyone);
* trusted-device token minting / hashing / lookup.

Security invariants (each covered by a test in
``tests/test_chw_sms_2fa.py``):

* The pending token carries type claim ``user_2fa_pending`` — never
  ``admin_2fa``. It is signed with the same secret as the admin 2FA token
  (``settings.admin_2fa_secret``, falling back to ``settings.secret_key`` in
  dev), so the type claim — NOT the signing key — is what keeps the two token
  families from cross-authorizing each other's endpoints. An ``admin_2fa``
  token presented to a ``/auth/2fa/*`` endpoint is rejected, and vice versa.
* Device tokens are stored hash-only (SHA-256); the raw token never touches
  the database.
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from uuid import UUID

from fastapi import HTTPException, status
from jose import JWTError, jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.trusted_device import TrustedDevice
from app.models.user import User
from app.utils.phone import is_placeholder_phone

# ── Pending-token constants ───────────────────────────────────────────────────

#: Type claim on the post-password, pre-OTP pending JWT. Deliberately distinct
#: from the admin console's ``admin_2fa`` type so the two token families can
#: never authorize each other's endpoints even though they share a signing key.
PENDING_TOKEN_TYPE: str = "user_2fa_pending"

#: Minutes a pending token is valid — long enough to receive an SMS and type a
#: code, short enough to bound the challenge window.
PENDING_TTL_MINUTES: int = 10

_JWT_ALGORITHM = "HS256"


def _pending_signing_secret() -> str:
    """Return the secret used to sign/verify the pending 2FA JWT.

    Mirrors ``app.routers.admin._admin_2fa_signing_secret``: production refuses
    to start unless ``ADMIN_2FA_SECRET`` is set and distinct from
    ``SECRET_KEY`` (see ``config.py`` guards), and dev/staging fall back to
    ``settings.secret_key`` for backwards compatibility. Using the same
    resolution as the admin token is intentional — cross-family rejection is
    enforced by the ``type`` claim, not by key separation, so both must verify
    under the same key for the negative test to be meaningful.
    """
    return settings.admin_2fa_secret or settings.secret_key


def issue_pending_token(user_id: UUID) -> str:
    """Mint a single-purpose pending JWT for ``user_id``.

    The token is accepted ONLY by ``POST /auth/2fa/send-code`` and
    ``POST /auth/2fa/verify`` (via :func:`decode_pending_token`). It carries no
    access privileges of its own.
    """
    now = datetime.now(UTC)
    payload = {
        "sub": str(user_id),
        "type": PENDING_TOKEN_TYPE,
        "iat": now,
        "exp": now + timedelta(minutes=PENDING_TTL_MINUTES),
    }
    return jwt.encode(payload, _pending_signing_secret(), algorithm=_JWT_ALGORITHM)


def decode_pending_token(token: str) -> UUID:
    """Validate a pending token and return the subject user id.

    Raises:
        HTTPException(401): if the token is missing/empty, has a bad signature,
            is expired, carries the wrong ``type`` claim (e.g. an ``admin_2fa``
            or ``access`` token presented in its place), or has an unparseable
            ``sub``.
    """
    _INVALID = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired sign-in session. Please sign in again.",
    )
    if not token:
        raise _INVALID
    try:
        payload = jwt.decode(
            token, _pending_signing_secret(), algorithms=[_JWT_ALGORITHM]
        )
    except JWTError as exc:
        raise _INVALID from exc

    # The type claim is the load-bearing guard: an admin_2fa token (same
    # signing key) must NOT authorize a user 2FA endpoint, and a real access
    # token (different key, but be defensive) must not either.
    if payload.get("type") != PENDING_TOKEN_TYPE:
        raise _INVALID

    sub = payload.get("sub")
    if not sub:
        raise _INVALID
    try:
        return UUID(str(sub))
    except (ValueError, TypeError) as exc:
        raise _INVALID from exc


# ── Trusted-device token helpers ──────────────────────────────────────────────


def mint_device_token() -> str:
    """Return a fresh 256-bit URL-safe device token (the raw secret).

    Returned to the client exactly once; only its :func:`hash_device_token`
    digest is persisted.
    """
    return secrets.token_urlsafe(32)


def hash_device_token(raw: str) -> str:
    """Return the SHA-256 hex digest of a raw device token for at-rest storage."""
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


async def user_requires_2fa(user: User) -> bool:
    """Return True when ``user`` must clear an SMS challenge at login.

    Policy:
      * The ``chw_sms_2fa_enabled`` settings flag is the platform-wide
        emergency off switch — when False, NOBODY is challenged (today's login
        is restored for everyone).
      * CHWs: always required (they hold PHI access).
      * Members: opt-in — required only when ``sms_2fa_enabled`` is True AND
        they have a verified, non-placeholder phone. Fails OPEN (returns False)
        for an opted-in member who has since lost phone verification or whose
        phone is the 555 sentinel — members are opt-in, not workforce.
      * Admins / any other role: never (admin console has its own TOTP 2FA).
    """
    if not settings.chw_sms_2fa_enabled:
        return False
    if user.role == "chw":
        return True
    if user.role == "member":
        return bool(
            user.sms_2fa_enabled
            and user.phone_verified_at is not None
            and user.phone
            and not is_placeholder_phone(user.phone)
        )
    return False


async def find_valid_trusted_device(
    db: AsyncSession,
    user_id: UUID,
    raw_token: str | None,
) -> TrustedDevice | None:
    """Return the caller's matching, un-expired trusted device, or None.

    A device matches when the SHA-256 of ``raw_token`` equals a stored
    ``token_hash`` owned by ``user_id`` and ``expires_at`` is still in the
    future. A missing/empty token, a forged/unknown hash, another user's
    device, or an expired row all return None (→ the caller issues a full
    challenge). Does NOT stamp ``last_used_at`` — the login handler does that
    only when it actually honours the bypass.
    """
    if not raw_token:
        return None
    token_hash = hash_device_token(raw_token)
    now = datetime.now(UTC)
    result = await db.execute(
        select(TrustedDevice).where(
            TrustedDevice.token_hash == token_hash,
            TrustedDevice.user_id == user_id,
            TrustedDevice.expires_at > now,
        )
    )
    return result.scalar_one_or_none()

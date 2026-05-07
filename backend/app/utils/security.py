import logging
import uuid
from datetime import UTC, datetime, timedelta
from uuid import UUID

from jose import JWTError, jwt
from passlib.context import CryptContext

from app.config import settings

_ALGORITHM = "HS256"

logger = logging.getLogger("compass.security")

pwd_context = CryptContext(schemes=["argon2"], deprecated="auto")


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def create_access_token(data: dict) -> str:
    to_encode = data.copy()
    to_encode["exp"] = datetime.now(UTC) + timedelta(minutes=settings.access_token_expire_minutes)
    to_encode["iat"] = datetime.now(UTC)
    to_encode["jti"] = uuid.uuid4().hex
    to_encode["type"] = "access"
    return jwt.encode(to_encode, settings.secret_key, algorithm=_ALGORITHM)


def create_refresh_token(data: dict) -> str:
    to_encode = data.copy()
    to_encode["exp"] = datetime.now(UTC) + timedelta(days=settings.refresh_token_expire_days)
    to_encode["iat"] = datetime.now(UTC)
    # `jti` (JWT ID) ensures every issued token is unique even when two are
    # created in the same second with identical (sub, role, exp). Without it,
    # consecutive refresh issuances produce byte-identical JWTs and identical
    # SHA-256 hashes, which defeats refresh-token rotation: an attacker who
    # presents the old refresh token milliseconds after a legitimate refresh
    # would find a fresh, unrevoked row in `refresh_tokens` and silently
    # acquire a new session. See test_refresh_token_reuse_fails.
    to_encode["jti"] = uuid.uuid4().hex
    to_encode["type"] = "refresh"
    return jwt.encode(to_encode, settings.secret_key, algorithm=_ALGORITHM)


def decode_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, settings.secret_key, algorithms=[_ALGORITHM])
    except JWTError:
        return None


# ---------------------------------------------------------------------------
# Vonage WebSocket JWT helpers
#
# These tokens are issued by the NCCO agent (via the communication router's
# answer-webhook path) and presented by Vonage as ?token=<jwt> when it opens
# the audio-ingestion WebSocket.  They are signed with a SEPARATE secret
# (settings.vonage_ws_jwt_secret) so that a compromised Vonage token can never
# be replayed against the user-facing access-token endpoints, and vice-versa.
#
# Token claims:
#   sub          "vonage"  (literal — checked on verify)
#   session_id   str(UUID) (Compass session the call belongs to)
#   exp          Unix timestamp (iat + ttl_seconds)
#   iat          Unix timestamp (issue time)
#   jti          UUID hex  (nonce — ensures every token is unique)
#
# HIPAA: these tokens carry no PHI — only a session UUID and the "vonage"
# subject sentinel.  The session_id is a surrogate key with no clinical
# meaning on its own, so it is safe to embed in a short-lived signed token.
# ---------------------------------------------------------------------------

_VONAGE_WS_SUB = "vonage"


def create_vonage_ws_token(session_id: UUID, ttl_seconds: int = 1800) -> str:
    """Issue an HS256 JWT bound to a session for Vonage WebSocket auth.

    Signs with ``settings.vonage_ws_jwt_secret`` — deliberately NOT the
    user-facing ``settings.secret_key``.

    Args:
        session_id: The Compass session UUID the Vonage call belongs to.
        ttl_seconds: Lifetime in seconds before the token expires.
                     Default 1800 s (30 min) — long enough for a CHW visit.

    Returns:
        Encoded JWT string suitable for embedding in a Vonage NCCO websocket
        endpoint URI as ``?token=<returned_value>``.

    Raises:
        RuntimeError: If ``settings.vonage_ws_jwt_secret`` is empty or not
                      configured.  Callers must configure this secret before
                      routing Vonage calls through this endpoint.
    """
    secret = settings.vonage_ws_jwt_secret
    if not secret:
        raise RuntimeError(
            "VONAGE_WS_JWT_SECRET is not configured. "
            "Set it in .env before issuing Vonage WebSocket tokens."
        )

    now = datetime.now(UTC)
    payload: dict = {
        "sub": _VONAGE_WS_SUB,
        "session_id": str(session_id),
        "exp": int((now + timedelta(seconds=ttl_seconds)).timestamp()),
        "iat": int(now.timestamp()),
        "jti": uuid.uuid4().hex,
    }
    return jwt.encode(payload, secret, algorithm=_ALGORITHM)


def verify_vonage_ws_token(token: str) -> UUID | None:
    """Verify a Vonage WS JWT and return the session_id UUID, or None on any failure.

    Validates signature (against ``settings.vonage_ws_jwt_secret``), expiry,
    and that ``sub == "vonage"``.  Never raises — all error paths return None
    so callers can safely close the WebSocket with code 4001 without wrapping
    this in a try/except.

    Args:
        token: The raw JWT string extracted from the ``?token=`` query parameter.

    Returns:
        The ``session_id`` claim as a ``UUID`` if verification succeeds, or
        ``None`` if the token is missing, malformed, expired, carries the wrong
        subject, or the secret is not configured.
    """
    secret = settings.vonage_ws_jwt_secret
    if not secret:
        logger.warning(
            "verify_vonage_ws_token called but VONAGE_WS_JWT_SECRET is not set — "
            "rejecting token (configure the secret to enable Vonage WS auth)"
        )
        return None

    try:
        payload = jwt.decode(token, secret, algorithms=[_ALGORITHM])
    except JWTError:
        # Covers expired tokens, bad signatures, and malformed JWTs.
        return None

    if payload.get("sub") != _VONAGE_WS_SUB:
        return None

    session_id_str: str | None = payload.get("session_id")
    if not session_id_str:
        return None

    try:
        return UUID(session_id_str)
    except ValueError:
        return None

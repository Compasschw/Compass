import uuid
from datetime import UTC, datetime, timedelta

from jose import JWTError, jwt
from passlib.context import CryptContext

from app.config import settings

_ALGORITHM = "HS256"

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

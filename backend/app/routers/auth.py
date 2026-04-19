from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.limiter import limiter
from app.models.user import User
from app.schemas.auth import LoginRequest, RefreshRequest, RegisterRequest, TokenResponse
from app.services.auth_service import (
    authenticate_user,
    create_tokens,
    register_user,
    revoke_refresh_token,
    store_refresh_token,
)
from app.utils.security import decode_token

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


@router.post("/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
@limiter.limit("3/minute")
async def register(request: Request, data: RegisterRequest, db: Annotated[AsyncSession, Depends(get_db)]):
    user = await register_user(db, data.email, data.password, data.name, data.role, data.phone)
    if user is None:
        raise HTTPException(status_code=400, detail="Email already registered")
    access, refresh = create_tokens(user)
    await store_refresh_token(db, user.id, refresh)
    return TokenResponse(access_token=access, refresh_token=refresh, role=user.role, name=user.name)


@router.post("/login", response_model=TokenResponse)
@limiter.limit("5/minute")
async def login(request: Request, data: LoginRequest, db: Annotated[AsyncSession, Depends(get_db)]):
    user = await authenticate_user(db, data.email, data.password)
    if user is None:
        raise HTTPException(status_code=401, detail="Invalid email or password")
    access, refresh = create_tokens(user)
    await store_refresh_token(db, user.id, refresh)
    return TokenResponse(access_token=access, refresh_token=refresh, role=user.role, name=user.name)


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
    return TokenResponse(access_token=access, refresh_token=new_refresh, role=user.role, name=user.name)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(data: RefreshRequest, db: Annotated[AsyncSession, Depends(get_db)], current_user=Depends(get_current_user)):
    await revoke_refresh_token(db, data.refresh_token)


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

    # TODO: wire up email delivery (SES, Resend, or Postmark).
    # For now, log it so dev can copy-paste from logs. In production this
    # should hand off to an email service with HIPAA BAA.
    import logging
    logging.getLogger("compass.auth").info(
        "Magic link generated for user %s (expires %s): %s",
        user.id, expires_at.isoformat(), magic_url,
    )

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
    return TokenResponse(access_token=access, refresh_token=refresh, role=user.role, name=user.name)

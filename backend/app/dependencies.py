from typing import Annotated
from uuid import UUID

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.enums import UserRole
from app.utils.security import decode_token

security = HTTPBearer()


async def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials, Depends(security)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    token = credentials.credentials
    payload = decode_token(token)
    if payload is None or payload.get("type") != "access":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")
    user_id = payload.get("sub")
    if user_id is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token payload")
    from app.models.user import User
    result = await db.execute(select(User).where(User.id == UUID(user_id)))
    user = result.scalar_one_or_none()
    if user is None or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found or inactive")

    # Presence: bump last_active_at, throttled to at most once per minute so we
    # don't write on every authenticated request. Best-effort — a failure here
    # must never break auth, so it's guarded and rolled back on error. get_db
    # does not auto-commit, so committing just this field is isolated from the
    # request handler's own transaction.
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    last = user.last_active_at
    if last is None or last.tzinfo is None or (now - last).total_seconds() > 60:
        try:
            user.last_active_at = now
            await db.commit()
        except Exception:
            await db.rollback()

    return user


async def require_admin_key(
    credentials: Annotated[HTTPAuthorizationCredentials, Depends(security)],
):
    """Validates an admin API key passed via `Authorization: Bearer <key>`.

    Separate from user JWT auth — used for operational/admin endpoints where
    the caller is an admin tool rather than a logged-in user.
    """
    import hmac

    from app.config import settings
    if not hmac.compare_digest(credentials.credentials, settings.admin_key):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid admin key")
    return True


def require_role(*roles: str | UserRole):
    """Dependency that checks the current user has one of the specified roles.

    Accepts both string literals and UserRole enum values.
    """
    role_values = {r.value if isinstance(r, UserRole) else r for r in roles}

    async def role_checker(current_user=Depends(get_current_user)):
        if current_user.role not in role_values:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
        return current_user
    return role_checker

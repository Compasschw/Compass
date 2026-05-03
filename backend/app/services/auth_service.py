import hashlib
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.utils.security import create_access_token, create_refresh_token, hash_password, verify_password


async def register_user(db: AsyncSession, email: str, password: str, name: str, role: str, phone: str | None = None):
    """Register a new User and provision the role-appropriate profile row.

    A `MemberProfile` (or `CHWProfile`) is created with sensible defaults at
    signup time so downstream endpoints — `GET /member/profile`, `PUT
    /member/profile`, `GET /chw/intake`, request submission, etc. — never 404
    on a freshly-registered account. Onboarding flows then PATCH the empty
    fields with the user's real data (zip, language, Medi-Cal ID, etc.).

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
        phone=phone,
    )
    db.add(user)
    await db.flush()  # populate user.id without ending the transaction

    # Provision the role-specific profile in the same transaction so the user
    # never exists in a half-onboarded state where queries against the join
    # row would 404.
    if role == "member":
        db.add(MemberProfile(user_id=user.id))
    elif role == "chw":
        db.add(CHWProfile(user_id=user.id))
    # Other roles (admin) don't need a profile row.

    await db.commit()
    await db.refresh(user)
    return user


async def authenticate_user(db: AsyncSession, email: str, password: str):
    from app.models.user import User
    result = await db.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()
    if user is None or not verify_password(password, user.password_hash):
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

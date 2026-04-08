from typing import Annotated
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from app.database import get_db
from app.schemas.auth import RegisterRequest, LoginRequest, TokenResponse, RefreshRequest
from app.services.auth_service import register_user, authenticate_user, create_tokens, store_refresh_token, revoke_refresh_token
from app.utils.security import decode_token

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])

@router.post("/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
async def register(data: RegisterRequest, db: Annotated[AsyncSession, Depends(get_db)]):
    user = await register_user(db, data.email, data.password, data.name, data.role, data.phone)
    if user is None:
        raise HTTPException(status_code=400, detail="Email already registered")
    access, refresh = create_tokens(user)
    await store_refresh_token(db, user.id, refresh)
    return TokenResponse(access_token=access, refresh_token=refresh, role=user.role, name=user.name)

@router.post("/login", response_model=TokenResponse)
async def login(data: LoginRequest, db: Annotated[AsyncSession, Depends(get_db)]):
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
        raise HTTPException(status_code=401, detail="Token not found or revoked")
    from app.models.user import User
    from sqlalchemy import select
    from uuid import UUID
    result = await db.execute(select(User).where(User.id == UUID(payload["sub"])))
    user = result.scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=401, detail="User not found")
    access, new_refresh = create_tokens(user)
    await store_refresh_token(db, user.id, new_refresh)
    return TokenResponse(access_token=access, refresh_token=new_refresh, role=user.role, name=user.name)

@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(data: RefreshRequest, db: Annotated[AsyncSession, Depends(get_db)]):
    await revoke_refresh_token(db, data.refresh_token)

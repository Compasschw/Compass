"""Device token registration endpoints.

The mobile app calls POST /devices/register on login and whenever Expo
rotates the push token. The endpoint is upsert-style: duplicate tokens
update `last_used_at` rather than creating conflicting rows.

Tokens are scoped to the authenticated user — a logout triggers
POST /devices/unregister to mark them inactive.
"""

from typing import Literal

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.device import DeviceToken

router = APIRouter(prefix="/api/v1/devices", tags=["devices"])


class DeviceRegisterRequest(BaseModel):
    token: str = Field(min_length=10, max_length=255)
    platform: Literal["ios", "android", "web"]
    provider: Literal["expo", "apns", "fcm"] = "expo"


class DeviceResponse(BaseModel):
    id: str
    platform: str
    provider: str


@router.post("/register", response_model=DeviceResponse, status_code=status.HTTP_201_CREATED)
async def register_device(
    data: DeviceRegisterRequest,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Register (or refresh) this device's push token for the current user.

    If the token already exists:
      - Owned by the same user: reactivate + refresh last_used_at
      - Owned by a different user: transfer ownership (user switched accounts on this device)
    """
    from datetime import UTC, datetime

    existing = await db.execute(
        select(DeviceToken).where(DeviceToken.token == data.token)
    )
    device = existing.scalar_one_or_none()

    if device is not None:
        device.user_id = current_user.id
        device.platform = data.platform
        device.provider = data.provider
        device.is_active = True
        device.last_used_at = datetime.now(UTC)
    else:
        device = DeviceToken(
            user_id=current_user.id,
            token=data.token,
            platform=data.platform,
            provider=data.provider,
        )
        db.add(device)

    await db.commit()
    await db.refresh(device)
    return DeviceResponse(
        id=str(device.id),
        platform=device.platform,
        provider=device.provider,
    )


@router.post("/unregister", status_code=status.HTTP_204_NO_CONTENT)
async def unregister_device(
    data: DeviceRegisterRequest,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Deactivate this token — called on logout or when user opts out of notifications."""
    result = await db.execute(
        select(DeviceToken)
        .where(DeviceToken.token == data.token)
        .where(DeviceToken.user_id == current_user.id)
    )
    device = result.scalar_one_or_none()
    if device is not None:
        device.is_active = False
        await db.commit()
    return None

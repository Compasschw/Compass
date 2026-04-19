"""Device registration for push notifications.

One user can have multiple devices (phone + tablet, or iOS + Android). Each
registered device stores:
  - The Expo push token (or APNs/FCM token directly in future)
  - The platform (ios, android, web) for routing
  - Last-seen timestamp for pruning stale tokens

Tokens are rotated when Expo invalidates them; the receiver-pruning job
drops any token Expo reports as unregistered.
"""

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class DeviceToken(Base):
    __tablename__ = "device_tokens"
    __table_args__ = (
        # A given device token is globally unique; prevents duplicates across users
        UniqueConstraint("token", name="uq_device_tokens_token"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)
    token: Mapped[str] = mapped_column(String(255), nullable=False)
    platform: Mapped[str] = mapped_column(String(20), nullable=False)  # ios | android | web
    provider: Mapped[str] = mapped_column(String(20), default="expo")  # expo | apns | fcm
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_used_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

"""TrustedDevice model — 30-day "remember this device" tokens for SMS 2FA.

Each row represents one device a user chose to trust after completing an SMS
two-factor challenge (``POST /auth/2fa/verify`` with ``remember_device: true``).
The raw device token is a 256-bit URL-safe secret returned to the client ONCE
and never stored server-side — only its SHA-256 hex digest lives in
``token_hash``. On a subsequent login the client presents the raw token in the
``X-Device-Token`` header; a matching, un-expired hash for that user bypasses
the SMS challenge (SMS Output Spec 2 — "Trusted devices").

Revocation: rows are deleted wholesale on logout-everywhere (a password reset /
full-session invalidation) and on an admin 2FA reset, and are ignored once
``expires_at`` has passed.
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class TrustedDevice(Base):
    __tablename__ = "trusted_devices"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    # The owning user. Indexed for the per-user lookup on every login attempt
    # and the bulk delete on logout-everywhere / admin reset. ON DELETE CASCADE
    # so a hard-deleted account never leaves dangling device rows.
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # SHA-256 hex digest (64 chars) of the raw device token. Unique so a forged
    # or replayed token can never resolve to more than one device row, and so a
    # (vanishingly unlikely) hash collision surfaces as an IntegrityError rather
    # than silently trusting the wrong device. The raw token is NEVER stored.
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    # Captured from the login request's User-Agent header at enrollment time so
    # an operator can attribute a trusted device during an incident review.
    # Nullable — the header may be absent. Truncated to 256 chars by the caller.
    user_agent: Mapped[str | None] = mapped_column(String(256), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    # Stamped every time this device successfully bypasses a challenge, so a
    # future cleanup job / audit can distinguish actively-used devices from
    # dormant ones. Defaults to creation time.
    last_used_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    # Absolute expiry — 30 days after creation. Indexed so the "valid device"
    # lookup (``token_hash`` match AND ``expires_at > now``) is index-served.
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
    )

    __table_args__ = (
        Index("ix_trusted_devices_expires_at", "expires_at"),
    )

    #: Days a trusted device remains valid before the user is challenged again.
    TRUSTED_DEVICE_TTL_DAYS: int = 30

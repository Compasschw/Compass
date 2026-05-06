"""PhoneVerification model — tracks in-flight SMS OTP challenges.

Each row represents one 6-digit code issued to a (user_id, phone_e164) pair.
Codes expire after 10 minutes; callers have at most 5 confirmation attempts
before the row is exhausted and a new challenge must be started.

The code itself is NEVER stored in plaintext — only the argon2 hash produced
by the same pwd_context used for passwords. The raw digits are sent to the
user via SMS and immediately discarded server-side.
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class PhoneVerification(Base):
    __tablename__ = "phone_verifications"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    # Canonical E.164 — e.g. "+12125551234"
    phone_e164: Mapped[str] = mapped_column(String(20), nullable=False)

    # argon2 hash of the 6-digit code. Never store plaintext.
    code_hash: Mapped[str] = mapped_column(String(255), nullable=False)

    # Counts down from MAX_ATTEMPTS. Reaching 0 renders the row exhausted.
    attempts_left: Mapped[int] = mapped_column(Integer, nullable=False, default=5)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
    )

    # Set on successful confirmation. Non-null means "already consumed".
    verified_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )

    __table_args__ = (
        # Fast lookup of pending challenges for a given (user, phone) pair.
        Index("ix_phone_verifications_user_phone", "user_id", "phone_e164"),
    )

    # ── Domain constants ─────────────────────────────────────────────────────

    #: Minutes a newly-issued code is valid for.
    CODE_TTL_MINUTES: int = 10

    #: Maximum confirmation attempts per issued code.
    MAX_ATTEMPTS: int = 5

    #: Max start-verification calls per user per hour (rate-limit sentinel).
    MAX_STARTS_PER_HOUR: int = 3

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import ARRAY, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class ServiceRequest(Base):
    """A member's service request for one or more community health verticals.

    Multi-vertical design
    ─────────────────────
    `verticals` (ARRAY of VARCHAR) is the authoritative list of verticals on a
    request, introduced in migration r1s4t5u6v7w8_add_verticals_array.

    `vertical` (single VARCHAR) is kept for backwards compatibility: it is set
    to ``verticals[0]`` on every write and continues to drive sessions, claims,
    calendar events, and admin views that have not yet migrated to the array.

    Callers MUST write to `verticals`; writing to `vertical` alone is
    deprecated and will be removed in a future migration.
    """

    __tablename__ = "service_requests"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    member_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)
    matched_chw_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"))
    # ── Legacy single-vertical field — kept for backwards compatibility ──────
    # Set to verticals[0] on every create/update. Referenced by sessions,
    # claims, calendar events, and admin views. Do NOT remove until those
    # consumers are migrated.
    vertical: Mapped[str] = mapped_column(String(50), nullable=False)
    # ── Multi-vertical array — authoritative from migration r1s4t5u6v7w8 ────
    verticals: Mapped[list[str]] = mapped_column(
        ARRAY(String(50)),
        nullable=False,
        server_default="{}",
    )
    urgency: Mapped[str] = mapped_column(String(20), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    preferred_mode: Mapped[str] = mapped_column(String(20), nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="open", index=True)
    estimated_units: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

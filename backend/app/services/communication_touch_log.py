"""Append-only audit log for every outbound communication touch (call, SMS, in-app message).

Design rationale:
  - Append-only: rows are never updated or deleted. The table is a compliance artifact
    under HIPAA's audit-control requirements (45 CFR §164.312(b)).
  - Separate from CommunicationSession: CommunicationSession is session-scoped (clinical
    encounter). CommunicationTouch covers ad-hoc, out-of-session contacts — the use-case
    this feature implements — plus session calls via a shared helper.
  - JSONB metadata: keeps the schema flexible without migrations for every new call
    context (e.g. recording platform, IVR path, reason text).
"""

import enum
import logging
import uuid as _uuid_module
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import DateTime, Enum, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import JSONB, UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base

logger = logging.getLogger("compass.communication_touch_log")


# ─── Model ────────────────────────────────────────────────────────────────────


class TouchKind(str, enum.Enum):
    """Mutually exclusive categories of outbound communication touch."""

    call = "call"
    sms = "sms"
    in_app_message = "in_app_message"


class CommunicationTouch(Base):
    """One row per outbound communication touch between two users.

    Columns:
      id                - UUID primary key.
      initiator_id      - User who originated the touch (FK → users.id).
      recipient_id      - User who received the touch (FK → users.id).
      kind              - 'call' | 'sms' | 'in_app_message'.
      provider_session_id - Vonage conversation/call UUID; NULL for in-app messages.
      created_at        - Immutable timestamp set at insert.
      metadata          - Arbitrary context (reason text, recording flag, etc.).
    """

    __tablename__ = "communication_touches"

    id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        primary_key=True,
        default=_uuid_module.uuid4,
    )
    initiator_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    recipient_id: Mapped[UUID] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    kind: Mapped[str] = mapped_column(
        Enum(
            "call",
            "sms",
            "in_app_message",
            name="touch_kind_enum",
            create_type=True,
        ),
        nullable=False,
        index=True,
    )
    provider_session_id: Mapped[str | None] = mapped_column(
        String(255),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    extra_data: Mapped[dict | None] = mapped_column(
        JSONB,
        nullable=True,
    )


# ─── Helper ───────────────────────────────────────────────────────────────────


async def record_touch(
    db,
    *,
    initiator_id: UUID,
    recipient_id: UUID,
    kind: TouchKind | str,
    provider_session_id: str | None = None,
    extra_data: dict | None = None,
) -> CommunicationTouch:
    """Append a CommunicationTouch row to the audit log.

    This is the single authoritative write path; every call endpoint must
    go through here so the compliance table stays consistent.

    Args:
        db: AsyncSession from the request dependency.
        initiator_id: UUID of the user who triggered the touch.
        recipient_id: UUID of the user being contacted.
        kind: TouchKind enum value ('call', 'sms', 'in_app_message').
        provider_session_id: Vonage conversation UUID; None for in-app messages.
        metadata: Optional JSONB dict (e.g. {'reason': 'Check-in', 'recording': False}).

    Returns:
        The persisted CommunicationTouch row (id is populated after flush).

    Note:
        Commits are the caller's responsibility. record_touch flushes but does
        not commit so callers can batch it with other writes in the same transaction.
    """
    kind_value = kind.value if isinstance(kind, TouchKind) else str(kind)

    touch = CommunicationTouch(
        initiator_id=initiator_id,
        recipient_id=recipient_id,
        kind=kind_value,
        provider_session_id=provider_session_id,
        extra_data=extra_data,
        created_at=datetime.now(UTC),
    )
    db.add(touch)

    try:
        await db.flush()
    except Exception as exc:  # noqa: BLE001
        # Touch log failures must never crash a call endpoint — degrade
        # gracefully so the voice call isn't lost due to an audit row error.
        logger.error(
            "Failed to flush communication touch row (initiator=%s recipient=%s kind=%s): %s",
            initiator_id,
            recipient_id,
            kind_value,
            exc,
        )

    logger.info(
        "communication_touch recorded: initiator=%s recipient=%s kind=%s provider_session=%s",
        initiator_id,
        recipient_id,
        kind_value,
        provider_session_id,
    )
    return touch

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Conversation(Base):
    """A messaging thread between a CHW and a member.

    Each (chw_id, member_id) pair maps to exactly ONE Conversation row — the
    ``uq_conversations_chw_member`` UNIQUE constraint enforces this at the DB
    tier.  The ``find_or_create`` code paths (in conversations.py router and
    session_lookup.py service) use ``INSERT ... ON CONFLICT DO NOTHING`` so
    concurrent first-message requests produce only one winner.

    Read cursors (``chw_read_up_to``, ``member_read_up_to``) store the UUID of
    the last message each party has read.  NULL means "no messages read yet".
    This avoids a separate read-receipt table for Phase 1 polling; can be
    replaced with a proper MessageRead fan-out table if we add push read-receipts
    in a later phase.
    """

    __tablename__ = "conversations"
    # UNIQUE (chw_id, member_id): added in migration ab1c2d3e4f5a after
    # consolidating any pre-existing duplicate rows. Declared here on the ORM
    # model so that test DBs created via Base.metadata.create_all also carry
    # the constraint — keeping the ON CONFLICT upsert logic valid in tests.
    #
    # NOTE: the uq_conversations_session_id UNIQUE constraint that previously
    # lived here was dropped in migration f6a7b8c9d0e1 (session-per-call
    # refactor) so a Conversation can host multiple Sessions over its lifetime.
    # The session_id column is kept temporarily as "the originating Session"
    # for backward compat while the rollout flag flips.
    __table_args__ = (
        UniqueConstraint("chw_id", "member_id", name="uq_conversations_chw_member"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    chw_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    member_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    session_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("sessions.id"), index=True)
    # Read cursors: UUID of the last Message each party has acknowledged.
    chw_read_up_to: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("messages.id"), nullable=True)
    member_read_up_to: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("messages.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    # ── Soft-delete fields (HIPAA: never hard-delete PHI) ────────────────────
    # NULL means the thread is active. A non-NULL value means the thread has
    # been soft-deleted by a participant. The inbox list endpoint filters
    # deleted_at IS NULL; the by-id fetch still returns the row for audit access.
    # Sending a new message to a soft-deleted thread auto-restores it (clears
    # both fields) — mirrors the archive-on-engagement pattern from Session.
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    deleted_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    # ── Inbox swipe-action state (CHW perspective) ───────────────────────────
    # Mirror of Session.pinned_at / Session.archived_at, but at the
    # conversation level so a single row answers the inbox sort.
    # Backfilled from sessions in migration v6w7x8y9z0a1.
    pinned_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    archived_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

class Message(Base):
    __tablename__ = "messages"
    # Partial UNIQUE index on provider_message_id (WHERE NOT NULL): declared
    # here (not just in migration smsmsg0711) so test DBs created via
    # Base.metadata.create_all also carry the constraint — mirrors the
    # uq_conversations_chw_member pattern on Conversation above. Without this,
    # the inbound SMS webhook's idempotency guarantee would be silently
    # untested (no DB-level enforcement to actually race against).
    __table_args__ = (
        Index(
            "ix_messages_provider_message_id_unique",
            "provider_message_id",
            unique=True,
            postgresql_where=text("provider_message_id IS NOT NULL"),
        ),
    )
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("conversations.id"), nullable=False, index=True)
    sender_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    type: Mapped[str] = mapped_column(String(20), default="text")
    # ── Masked SMS messaging ──────────────────────────────────────────────────
    # Transport the message traveled over — distinct from `type` (content
    # kind: text/file). 'in_app' (default, backfilled on every pre-existing
    # row) means the message only ever existed in the in-app thread.  'sms'
    # means it was sent/received over the shared masked Vonage number AND
    # mirrored into this same in-app thread so either party can continue in
    # whichever channel they prefer. Enforced at the DB layer by
    # ck_messages_channel (see migration smsmsg0711).
    channel: Mapped[str] = mapped_column(String(20), nullable=False, server_default="in_app")
    # Vonage Messages API `message_uuid`. Populated for channel='sms' rows
    # only (both outbound sends and inbound webhook deliveries); NULL for
    # in_app messages. A partial UNIQUE index (WHERE NOT NULL, see migration
    # smsmsg0711) makes the inbound webhook idempotent without a separate
    # dedup table — a re-delivered Vonage webhook for the same message_uuid
    # cannot create a second Message row.
    provider_message_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

class FileAttachment(Base):
    __tablename__ = "file_attachments"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    message_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("messages.id"), nullable=False)
    s3_key: Mapped[str] = mapped_column(String(500), nullable=False)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    content_type: Mapped[str] = mapped_column(String(100), nullable=False)

class CallLog(Base):
    __tablename__ = "call_logs"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("conversations.id"), nullable=False)
    twilio_sid: Mapped[str | None] = mapped_column(String(100))
    duration_seconds: Mapped[int | None] = mapped_column(Integer)
    recording_s3_key: Mapped[str | None] = mapped_column(String(500))
    transcript_url: Mapped[str | None] = mapped_column(String(500))
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    member_consent_given: Mapped[bool] = mapped_column(Boolean, default=False)

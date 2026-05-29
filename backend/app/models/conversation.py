import uuid
from datetime import datetime

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Conversation(Base):
    """A messaging thread between a CHW and a member.

    Design note: ``session_id`` ties a conversation to a specific scheduled
    session (1-to-1, enforced by the unique constraint below).  General DMs
    that are not session-scoped keep ``session_id = NULL`` — the unique
    constraint only fires on non-NULL values in Postgres, so existing DM rows
    are unaffected.

    Read cursors (``chw_read_up_to``, ``member_read_up_to``) store the UUID of
    the last message each party has read.  NULL means "no messages read yet".
    This avoids a separate read-receipt table for Phase 1 polling; can be
    replaced with a proper MessageRead fan-out table if we add push read-receipts
    in a later phase.
    """

    __tablename__ = "conversations"
    # NOTE: the uq_conversations_session_id UNIQUE constraint that lived here
    # was dropped in migration f6a7b8c9d0e1 (session-per-call refactor) so a
    # Conversation can host multiple Sessions over its lifetime. The session_id
    # column is kept temporarily as "the originating Session" for backward
    # compat while the rollout flag flips; remove it in a follow-up once the
    # flag is on in prod and no caller reads it.

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    chw_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    member_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    session_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("sessions.id"), index=True)
    # Read cursors: UUID of the last Message each party has acknowledged.
    chw_read_up_to: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("messages.id"), nullable=True)
    member_read_up_to: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("messages.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

class Message(Base):
    __tablename__ = "messages"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("conversations.id"), nullable=False, index=True)
    sender_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    type: Mapped[str] = mapped_column(String(20), default="text")
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

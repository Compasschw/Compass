import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class CommunicationSession(Base):
    """Tracks masked calling sessions between CHW and member.

    Provider-agnostic — stores the provider name and provider-specific IDs
    so the same table works across Vonage, Twilio, Plivo, etc.
    """
    __tablename__ = "communication_sessions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("sessions.id"), nullable=False, index=True)
    provider: Mapped[str] = mapped_column(String(50), nullable=False)
    provider_session_id: Mapped[str] = mapped_column(String(255), nullable=False)
    proxy_number: Mapped[str] = mapped_column(String(20), nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="active")

    # Recording
    recording_url: Mapped[str | None] = mapped_column(String(500))
    recording_duration_seconds: Mapped[int | None] = mapped_column(Integer)
    provider_recording_id: Mapped[str | None] = mapped_column(String(255))

    # Transcript
    transcript_text: Mapped[str | None] = mapped_column(Text)
    transcript_confidence: Mapped[float | None] = mapped_column()

    # Lifecycle
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

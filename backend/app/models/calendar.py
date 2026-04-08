import uuid
from datetime import datetime, date, time
from sqlalchemy import String, DateTime, Date, Time, ForeignKey, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column
from app.database import Base

class CalendarEvent(Base):
    __tablename__ = "calendar_events"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)
    session_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("sessions.id"))
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    date: Mapped[date] = mapped_column(Date, nullable=False)
    start_time: Mapped[time | None] = mapped_column(Time)
    end_time: Mapped[time | None] = mapped_column(Time)
    vertical: Mapped[str | None] = mapped_column(String(50))
    event_type: Mapped[str] = mapped_column(String(30), default="session")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

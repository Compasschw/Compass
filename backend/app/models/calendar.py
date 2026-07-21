import uuid
from datetime import date, datetime, time

from sqlalchemy import Date, DateTime, ForeignKey, String, Time, func
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
    # ── Google Calendar sync (one-way Compass → Google push) ─────────────────
    # Populated by app.services.google_calendar.push_session_event when the
    # owning user has connected their Google Calendar and the feature flag is
    # on. ``google_event_id`` is the id of the event on the user's primary
    # Google calendar (used to PATCH/DELETE it on subsequent changes);
    # ``google_synced_at`` records the last successful push. Both NULL until a
    # push succeeds — the vast majority of rows (feature off / user not
    # connected) keep them NULL forever.
    google_event_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    google_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

"""FlagNote model — CHW-authored per-member flag notes.

A flag note is a freeform CHW-only note attached to a member profile, used to
surface persistent context about the member to any CHW viewing that profile
(e.g. "prefers evening appointments", "transportation assistance needed").

Invariant: at most ONE FlagNote per member has ``is_active=True`` at any time.
The service layer enforces this by soft-deleting (``is_active=False``) the
prior active note before inserting a new one.  Past notes are retained in the
table for audit purposes but never surfaced via the API.

HIPAA minimum-necessary (45 CFR §164.514(d)):
  - Flag notes are CHW-visible only — they are never returned to member-facing
    endpoints.  The ``body`` column is PHI; it must never appear in structured
    logs or error messages.
"""

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class FlagNote(Base):
    """A CHW-authored note that surfaces on the member's profile.

    Columns
    -------
    id              UUID PK — globally unique note identifier.
    member_id       FK → users.id — the member this note describes.
    author_chw_id   FK → users.id — the CHW who wrote or last updated the note.
    body            The note text (PHI — never log).
    is_active       True for the current live note; False for superseded notes.
                    Indexed because every read query filters on this column.
    created_at      Server-assigned UTC timestamp when this row was inserted.
    updated_at      Server-assigned UTC timestamp, updated on every write.
    """

    __tablename__ = "flag_notes"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    member_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True
    )
    author_chw_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False
    )
    # PHI — do not log the value of this column.
    body: Mapped[str] = mapped_column(Text, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

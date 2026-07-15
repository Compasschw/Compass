"""CaseNote model — CHW-authored clinical notes attached to a member relationship.

HIPAA: ``body`` is PHI (Protected Health Information).  It is encrypted at rest
using ``EncryptedString`` (AES-256-GCM) and must NEVER appear in structured logs,
error responses, or any external-facing surface other than the authorised CHW or
admin.

Lifecycle:
  - CHW creates a note for any member in their care caseload (active relationship).
  - Optionally linked to a Session (``session_id``), but may be standalone.
  - Soft-deleted via ``deleted_at``; the row is never hard-deleted for HIPAA
    audit trail purposes.  Soft-deleted rows are filtered out by all list
    endpoints and are only visible to admin tooling.
  - ``status`` ('draft' | 'final'): a note created while attached to a
    session that has not yet had its documentation submitted stays a
    'draft'. ``submit_documentation`` (see ``routers/sessions.py``) flips
    every draft note for that session to 'final' in the same transaction
    that marks the session 'completed'. Standalone notes (no ``session_id``)
    and notes attached to an already-completed session are 'final' from
    creation — there is no submission event left to wait for.
"""

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, String, false, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.utils.encryption import EncryptedString

# Case-note lifecycle status values. Kept as plain string constants (not a DB
# enum) to match the column's ``String(10)`` type and avoid an enum-migration
# for what is, today, a two-value flag.
CASE_NOTE_STATUS_DRAFT = "draft"
CASE_NOTE_STATUS_FINAL = "final"


class CaseNote(Base):
    """A CHW-authored clinical note, optionally linked to a session.

    Relationship gates are enforced at the router layer — this model carries
    no enforcement logic itself.  Callers must verify the CHW has an active
    care relationship with ``member_id`` before reading or writing.
    """

    __tablename__ = "case_notes"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    member_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True
    )
    chw_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True
    )
    # Optional: a note may be attached to a specific session call or be standalone.
    session_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("sessions.id"), nullable=True, index=True
    )
    # PHI — encrypted at rest.  Never log this field.
    body: Mapped[str] = mapped_column(EncryptedString, nullable=False)
    is_pinned: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=false()
    )
    # 'draft' | 'final' — see module docstring. server_default='final'
    # backfills every pre-migration row as final (they predate the draft
    # concept and have no pending documentation submission to wait for).
    status: Mapped[str] = mapped_column(
        String(10), nullable=False, server_default=CASE_NOTE_STATUS_FINAL
    )
    # Soft-delete: NULL means active, a timestamp means soft-deleted.
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    __table_args__ = (
        # Composite index for the primary list query: CHW's notes for a member.
        Index("ix_case_notes_member_chw", "member_id", "chw_id"),
        # Secondary index for session-scoped note lookup.
        Index("ix_case_notes_session", "session_id"),
    )

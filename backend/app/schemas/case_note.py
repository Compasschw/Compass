"""Pydantic v2 schemas for the CaseNote CRUD endpoints.

All schemas use ``from_attributes=True`` (ORM mode) where applicable so they
can be constructed directly from SQLAlchemy model instances.

HIPAA note: ``body`` is PHI.  It must only be returned to the authorised CHW
author or an admin; the router layer enforces this.  These schemas deliberately
do NOT include ``deleted_at`` on response types — soft-deleted rows are never
surfaced through the public API.
"""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class CaseNoteCreate(BaseModel):
    """Body for POST /api/v1/case-notes.

    ``session_id`` is optional — notes may be standalone or attached to a
    specific session call.
    """

    member_id: UUID
    body: str = Field(..., min_length=1, description="PHI — note body text.")
    session_id: UUID | None = None
    is_pinned: bool = False


class CaseNoteUpdate(BaseModel):
    """Body for PATCH /api/v1/case-notes/{id}.

    Only ``body`` and ``is_pinned`` are mutable after creation.  Passing
    neither field is allowed but is a no-op.
    """

    body: str | None = Field(default=None, min_length=1)
    is_pinned: bool | None = None


class CaseNoteResponse(BaseModel):
    """Wire shape for a single CaseNote row.

    Returned by POST (201 Created), GET list, and PATCH.
    ``deleted_at`` is intentionally absent — callers never see soft-deleted rows
    through the public API.

    ``status`` ('draft' | 'final') is server-determined, never client-supplied
    (see ``CaseNoteCreate`` — no ``status`` field there): a note attached to a
    session whose documentation has not yet been submitted is created
    'draft' and flips to 'final' the moment that session's documentation is
    submitted (``submit_documentation`` in ``routers/sessions.py``).
    Standalone notes and notes on an already-completed session are 'final'
    from creation.
    """

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    member_id: UUID
    chw_id: UUID
    session_id: UUID | None
    body: str
    is_pinned: bool
    status: str
    created_at: datetime
    updated_at: datetime


class CaseNoteListResponse(BaseModel):
    """Paginated list envelope for GET /api/v1/members/{member_id}/case-notes.

    Uses offset/limit pagination.  ``total`` is the count of visible
    (non-soft-deleted) notes for this CHW+member pair — useful for rendering
    a "showing X of Y" label or an infinite-scroll trigger.
    """

    items: list[CaseNoteResponse]
    total: int
    limit: int
    offset: int

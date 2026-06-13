"""Case Notes CRUD endpoints — CHW-authored clinical notes on a member.

All endpoints are CHW-only.  Every read path is gated on the CHW having an
active care relationship with the target member (``assert_shared_session``).
Write paths additionally enforce author-ownership so CHWs cannot edit or
delete each other's notes.

HIPAA: ``CaseNote.body`` is PHI.  The audit log records every create, edit,
and delete so the access trail is complete.  Body text is never included in
structured logs or error detail strings in this module.
"""

import logging
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import require_role
from app.models.audit import AuditLog
from app.models.case_note import CaseNote
from app.models.session import Session
from app.schemas.case_note import (
    CaseNoteCreate,
    CaseNoteListResponse,
    CaseNoteResponse,
    CaseNoteUpdate,
)
from app.services.relationship_guards import assert_shared_session

logger = logging.getLogger("compass.case_notes")

router = APIRouter(prefix="/api/v1", tags=["case-notes"])


# ── Helpers ──────────────────────────────────────────────────────────────────


async def _load_note_for_author(
    note_id: UUID,
    chw_id: UUID,
    db: AsyncSession,
) -> CaseNote:
    """Load a non-deleted CaseNote and assert caller is the author.

    Returns the loaded note when found and the caller is the author.
    Raises 404 (not-found AND not-author) for both cases to avoid leaking
    existence of notes the caller does not own.
    """
    note = await db.get(CaseNote, note_id)
    if note is None or note.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Case note not found")
    if note.chw_id != chw_id:
        # Return 404 rather than 403 so we do not reveal the existence of
        # another CHW's note to the caller.
        raise HTTPException(status_code=404, detail="Case note not found")
    return note


# ── POST /api/v1/case-notes ──────────────────────────────────────────────────


@router.post(
    "/case-notes",
    response_model=CaseNoteResponse,
    status_code=201,
    summary="Create a case note for a member",
    description=(
        "CHW-only.  Requires an active care relationship with the member "
        "(shared session).  Body is PHI and encrypted at rest."
    ),
)
async def create_case_note(
    data: CaseNoteCreate,
    current_user=Depends(require_role("chw")),
    db: AsyncSession = Depends(get_db),
) -> CaseNoteResponse:
    """POST /api/v1/case-notes

    Relationship gate: CHW must share at least one session with the member.
    Session gate: when ``session_id`` is supplied, the session must belong to
      this CHW+member pair.

    Errors:
      403 — no care relationship
      404 — session_id supplied but not found or not owned by this CHW+member
      422 — body is empty
    """
    await assert_shared_session(db, chw_id=current_user.id, member_id=data.member_id)

    # Optional session FK validation: guard against attaching a note to a
    # session that doesn't belong to this CHW↔member relationship.
    if data.session_id is not None:
        session = await db.get(Session, data.session_id)
        if (
            session is None
            or session.chw_id != current_user.id
            or session.member_id != data.member_id
        ):
            raise HTTPException(
                status_code=404,
                detail="Session not found or does not belong to this CHW/member pair.",
            )

    note = CaseNote(
        member_id=data.member_id,
        chw_id=current_user.id,
        session_id=data.session_id,
        body=data.body,
        is_pinned=data.is_pinned,
    )
    db.add(note)

    audit = AuditLog(
        user_id=current_user.id,
        action="case_note_create",
        resource="case_note",
        # note.id is populated after flush/commit; we stamp it in the audit
        # row created alongside the note. If flush happens before commit here
        # we get the real UUID; otherwise it falls back to None which is still
        # compliant (the note row itself is the record).
        resource_id=None,
        details={"member_id": str(data.member_id)},
    )
    db.add(audit)

    await db.commit()
    await db.refresh(note)

    # Back-fill resource_id now that we have the PK.
    audit.resource_id = str(note.id)
    await db.commit()

    logger.info(
        "case_note created: note_id=%s chw=%s member=%s session=%s",
        note.id,
        current_user.id,
        data.member_id,
        data.session_id,
    )
    return CaseNoteResponse.model_validate(note)


# ── GET /api/v1/members/{member_id}/case-notes ───────────────────────────────


@router.get(
    "/members/{member_id}/case-notes",
    response_model=CaseNoteListResponse,
    summary="List case notes for a member (CHW's own notes only)",
    description=(
        "Returns paginated case notes authored by the authenticated CHW for "
        "this member, most recent first.  Notes authored by other CHWs are "
        "NOT returned.  Soft-deleted notes are excluded."
    ),
)
async def list_case_notes(
    member_id: UUID,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    current_user=Depends(require_role("chw")),
    db: AsyncSession = Depends(get_db),
) -> CaseNoteListResponse:
    """GET /api/v1/members/{member_id}/case-notes

    Relationship gate: CHW must share at least one session with the member.

    Pagination: offset/limit.  Returns items + total for the full unfiltered
    count (pre-pagination) so clients can compute whether more pages exist.
    """
    await assert_shared_session(db, chw_id=current_user.id, member_id=member_id)

    base_filter = (
        CaseNote.chw_id == current_user.id,
        CaseNote.member_id == member_id,
        CaseNote.deleted_at.is_(None),
    )

    # Count query (one round-trip, avoids loading all rows).
    count_result = await db.execute(
        select(func.count()).select_from(CaseNote).where(*base_filter)
    )
    total = count_result.scalar_one()

    # Paginated list query, newest first.
    list_result = await db.execute(
        select(CaseNote)
        .where(*base_filter)
        .order_by(CaseNote.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    notes = list_result.scalars().all()

    # HIPAA §164.312(b): record the PHI read (case notes are clinical PHI).
    from app.services.audit import record_phi_read

    await record_phi_read(
        actor_user_id=current_user.id,
        resource="case_note",
        resource_id=str(member_id),
        details={"count": len(notes), "actor_role": "chw"},
    )

    return CaseNoteListResponse(
        items=[CaseNoteResponse.model_validate(n) for n in notes],
        total=total,
        limit=limit,
        offset=offset,
    )


# ── PATCH /api/v1/case-notes/{id} ────────────────────────────────────────────


@router.patch(
    "/case-notes/{note_id}",
    response_model=CaseNoteResponse,
    summary="Edit a case note's body or pin state",
    description=(
        "Author-only.  Only the CHW who authored the note may edit it.  "
        "Supplying neither ``body`` nor ``is_pinned`` is accepted but is a no-op."
    ),
)
async def update_case_note(
    note_id: UUID,
    data: CaseNoteUpdate,
    current_user=Depends(require_role("chw")),
    db: AsyncSession = Depends(get_db),
) -> CaseNoteResponse:
    """PATCH /api/v1/case-notes/{note_id}

    Author gate: only the CHW who created the note may edit it.
    Returns 404 for both "does not exist" and "not the author" to avoid
    leaking existence of other CHWs' notes.
    """
    note = await _load_note_for_author(note_id, current_user.id, db)

    updated = False
    if data.body is not None:
        note.body = data.body
        updated = True
    if data.is_pinned is not None:
        note.is_pinned = data.is_pinned
        updated = True

    if updated:
        db.add(
            AuditLog(
                user_id=current_user.id,
                action="case_note_edit",
                resource="case_note",
                resource_id=str(note_id),
                details={"fields_updated": [
                    f for f, v in [("body", data.body), ("is_pinned", data.is_pinned)]
                    if v is not None
                ]},
            )
        )
        await db.commit()
        await db.refresh(note)

    return CaseNoteResponse.model_validate(note)


# ── DELETE /api/v1/case-notes/{id} ───────────────────────────────────────────


@router.delete(
    "/case-notes/{note_id}",
    status_code=204,
    summary="Soft-delete a case note",
    description=(
        "Author-only.  Stamps ``deleted_at`` so the note is hidden from all "
        "list endpoints.  PHI is NOT hard-deleted — clinical records are retained "
        "indefinitely for HIPAA compliance and admin-side audit access."
    ),
)
async def delete_case_note(
    note_id: UUID,
    current_user=Depends(require_role("chw")),
    db: AsyncSession = Depends(get_db),
) -> None:
    """DELETE /api/v1/case-notes/{note_id}

    Author gate: only the CHW who created the note may soft-delete it.
    Idempotent: calling DELETE on an already-deleted note returns 204.
    """
    # Load the note, but allow already-deleted rows so the delete is idempotent.
    # We check author ownership directly rather than using _load_note_for_author
    # (which rejects deleted rows to enforce 404 semantics for the other verbs).
    note = await db.get(CaseNote, note_id)
    if note is None:
        # Unknown note — return 404.
        raise HTTPException(status_code=404, detail="Case note not found")
    if note.chw_id != current_user.id:
        # Return 404 rather than 403 to avoid leaking existence of other CHWs' notes.
        raise HTTPException(status_code=404, detail="Case note not found")

    if note.deleted_at is None:
        note.deleted_at = datetime.now(UTC)
        db.add(
            AuditLog(
                user_id=current_user.id,
                action="case_note_delete",
                resource="case_note",
                resource_id=str(note_id),
                details={"member_id": str(note.member_id)},
            )
        )
        await db.commit()

    return None

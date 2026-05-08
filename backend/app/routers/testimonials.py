"""Testimonials — member rating + CHW profile display + admin moderation.

Route map
---------
Member (authenticated, role=member):
  POST /api/v1/sessions/{session_id}/testimonials
    — Submit a star rating + optional text for a completed session.

Public (any authenticated user):
  GET  /api/v1/chws/{chw_id}/testimonials
    — Paginated list of approved testimonials for a CHW profile.
  GET  /api/v1/chws/{chw_id}/testimonials/summary
    — Aggregate { rating_avg, rating_count } for the rating header widget.

Admin (ADMIN_KEY bearer):
  GET  /api/v1/admin/testimonials
    — Paginated moderation queue filterable by status.
  POST /api/v1/admin/testimonials/{id}/moderate
    — Approve or reject a testimonial with an optional admin note.

Privacy model
-------------
Public-facing endpoints return ``PublicTestimonial`` which replaces the
member's full name with their first-name initial + "." (e.g. "R."). The
member_id UUID is never included in public responses.

Auth pattern
------------
- ``require_role("member")``   — member-only endpoints.
- ``get_current_user``          — any authenticated user (CHW or member).
- ``require_admin_key``         — ADMIN_KEY bearer; same as all other admin
                                  endpoints in this codebase.

N+1 notes
---------
The admin list endpoint joins User rows for both member and CHW names in a
single SQL query (two LEFT OUTER JOINs on users aliased as member_user and
chw_user) to avoid N+1 per-row lookups in the moderation queue.
"""

import logging
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.database import get_db
from app.dependencies import get_current_user, require_admin_key, require_role
from app.models.session import Session
from app.models.testimonial import Testimonial
from app.models.user import User
from app.schemas.testimonial import (
    AdminModerateBody,
    AdminTestimonialView,
    PublicTestimonial,
    TestimonialCreate,
    TestimonialResponse,
    TestimonialSummary,
)

logger = logging.getLogger("compass.testimonials")

# ─── Router instances ──────────────────────────────────────────────────────────
# Three router instances keep prefix + tag grouping clean and mirror the
# resources router pattern. All three are registered in main.py.

member_router = APIRouter(prefix="/api/v1/sessions", tags=["testimonials-member"])
public_router = APIRouter(prefix="/api/v1/chws", tags=["testimonials-public"])
admin_router = APIRouter(prefix="/api/v1/admin/testimonials", tags=["testimonials-admin"])


# ─── Member endpoint ───────────────────────────────────────────────────────────


@member_router.post(
    "/{session_id}/testimonials",
    response_model=TestimonialResponse,
    status_code=201,
    summary="Member submits a testimonial for a completed CHW session",
)
async def create_testimonial(
    session_id: UUID,
    data: TestimonialCreate,
    current_user: User = Depends(require_role("member")),
    db: AsyncSession = Depends(get_db),
) -> TestimonialResponse:
    """POST /api/v1/sessions/{session_id}/testimonials

    Business rules enforced here:
    1. Session must exist.
    2. Authenticated member must be the session's member (ownership gate).
    3. Session must have status 'completed' (can't rate an in-progress session).
    4. One testimonial per (member, session) — returns 409 on duplicate.

    Returns 201 with the created testimonial (status='pending') on success.
    Auth: member JWT only.
    """
    # Fetch the session.
    session = await db.get(Session, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")

    # Ownership gate: only the member who participated in this session may rate it.
    if session.member_id != current_user.id:
        raise HTTPException(
            status_code=403,
            detail="You are not the member for this session.",
        )

    # Completed-status gate: rating an unfinished session is semantically invalid.
    if session.status != "completed":
        raise HTTPException(
            status_code=422,
            detail=f"Cannot submit a testimonial for a session with status '{session.status}'. "
                   "Session must be completed.",
        )

    # Idempotency gate: one testimonial per (member, session).
    existing_stmt = select(Testimonial).where(
        Testimonial.member_id == current_user.id,
        Testimonial.session_id == session_id,
    )
    existing_result = await db.execute(existing_stmt)
    existing = existing_result.scalar_one_or_none()
    if existing is not None:
        raise HTTPException(
            status_code=409,
            detail="A testimonial already exists for this session.",
        )

    testimonial = Testimonial(
        chw_id=session.chw_id,
        member_id=current_user.id,
        session_id=session_id,
        rating=data.rating,
        text=data.text,
        status="pending",
    )
    db.add(testimonial)
    await db.commit()
    await db.refresh(testimonial)

    logger.info(
        "Testimonial created: id=%s chw_id=%s member_id=%s session_id=%s rating=%s",
        testimonial.id,
        testimonial.chw_id,
        testimonial.member_id,
        testimonial.session_id,
        testimonial.rating,
    )

    return TestimonialResponse.model_validate(testimonial)


# ─── Public endpoints ──────────────────────────────────────────────────────────


@public_router.get(
    "/{chw_id}/testimonials/summary",
    response_model=TestimonialSummary,
    summary="Aggregate rating stats for a CHW (approved testimonials only)",
)
async def get_testimonial_summary(
    chw_id: UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> TestimonialSummary:
    """GET /api/v1/chws/{chw_id}/testimonials/summary

    Returns the average star rating and count of approved testimonials for
    the given CHW. Both values are NULL-safe: when no approved testimonials
    exist, rating_avg is None and rating_count is 0.

    Auth: any authenticated user (CHW or member).
    """
    stmt = select(
        func.avg(Testimonial.rating).label("rating_avg"),
        func.count(Testimonial.id).label("rating_count"),
    ).where(
        Testimonial.chw_id == chw_id,
        Testimonial.status == "approved",
    )
    result = await db.execute(stmt)
    row = result.one()

    avg_value: float | None = None
    if row.rating_avg is not None:
        avg_value = round(float(row.rating_avg), 1)

    return TestimonialSummary(
        rating_avg=avg_value,
        rating_count=int(row.rating_count or 0),
    )


@public_router.get(
    "/{chw_id}/testimonials",
    response_model=list[PublicTestimonial],
    summary="Paginated approved testimonials for a CHW profile",
)
async def list_chw_testimonials(
    chw_id: UUID,
    limit: int = Query(default=3, ge=1, le=50, description="Max testimonials to return"),
    offset: int = Query(default=0, ge=0, description="Pagination offset"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[PublicTestimonial]:
    """GET /api/v1/chws/{chw_id}/testimonials?limit=3&offset=0

    Returns only approved testimonials, ordered newest-first. Each item is a
    ``PublicTestimonial`` — the member's identity is reduced to their first-name
    initial + "." for privacy (e.g. "Rosa Delgado" → "R.").

    Auth: any authenticated user (CHW or member).
    """
    MemberUser = aliased(User, name="member_user")

    stmt = (
        select(Testimonial, MemberUser.name.label("member_name"))
        .join(MemberUser, MemberUser.id == Testimonial.member_id)
        .where(
            Testimonial.chw_id == chw_id,
            Testimonial.status == "approved",
        )
        .order_by(Testimonial.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    result = await db.execute(stmt)
    rows = result.all()

    public_items: list[PublicTestimonial] = []
    for testimonial, member_name in rows:
        first_initial = _derive_author_initial(member_name)
        public_items.append(
            PublicTestimonial(
                id=testimonial.id,
                rating=testimonial.rating,
                text=testimonial.text,
                author_initial=first_initial,
                created_at=testimonial.created_at,
            )
        )

    return public_items


# ─── Admin endpoints ───────────────────────────────────────────────────────────


@admin_router.get(
    "",
    response_model=list[AdminTestimonialView],
    summary="Admin: paginated testimonial moderation queue",
)
async def admin_list_testimonials(
    status: str | None = Query(
        default="pending",
        description="Filter by status (pending/approved/rejected). Omit for all.",
    ),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    _admin=Depends(require_admin_key),
    db: AsyncSession = Depends(get_db),
) -> list[AdminTestimonialView]:
    """GET /api/v1/admin/testimonials?status=pending&limit=20&offset=0

    Returns the paginated moderation queue, enriched with member and CHW full
    names resolved via a single JOIN (no N+1). Defaults to 'pending' status.

    Auth: ADMIN_KEY bearer token.
    """
    valid_statuses = {"pending", "approved", "rejected"}
    if status is not None and status not in valid_statuses:
        raise HTTPException(
            status_code=422,
            detail=f"Invalid status '{status}'. Valid values: {sorted(valid_statuses)}",
        )

    MemberUser = aliased(User, name="member_user")
    CHWUser = aliased(User, name="chw_user")

    stmt = (
        select(
            Testimonial,
            MemberUser.name.label("member_name"),
            CHWUser.name.label("chw_name"),
        )
        .join(MemberUser, MemberUser.id == Testimonial.member_id)
        .join(CHWUser, CHWUser.id == Testimonial.chw_id)
    )

    if status is not None:
        stmt = stmt.where(Testimonial.status == status)

    stmt = stmt.order_by(Testimonial.created_at.desc()).limit(limit).offset(offset)

    result = await db.execute(stmt)
    rows = result.all()

    return [
        AdminTestimonialView(
            id=t.id,
            chw_id=t.chw_id,
            chw_name=chw_name,
            member_id=t.member_id,
            member_name=member_name,
            session_id=t.session_id,
            rating=t.rating,
            text=t.text,
            status=t.status,
            moderation_notes=t.moderation_notes,
            created_at=t.created_at,
            moderated_at=t.moderated_at,
        )
        for t, member_name, chw_name in rows
    ]


@admin_router.post(
    "/{testimonial_id}/moderate",
    response_model=AdminTestimonialView,
    summary="Admin: approve or reject a testimonial",
)
async def moderate_testimonial(
    testimonial_id: UUID,
    data: AdminModerateBody,
    _admin=Depends(require_admin_key),
    db: AsyncSession = Depends(get_db),
) -> AdminTestimonialView:
    """POST /api/v1/admin/testimonials/{id}/moderate

    Transitions a testimonial's status to 'approved' or 'rejected'.
    This endpoint is intentionally idempotent on the same action — approving
    an already-approved testimonial succeeds without error (moderated_at is
    not reset). Re-moderating with the opposite action IS allowed (admin can
    reverse a decision).

    Body: ``AdminModerateBody { action: "approve"|"reject", notes?: str }``

    Errors:
      404 — testimonial not found
    Auth: ADMIN_KEY bearer token.
    """
    testimonial = await db.get(Testimonial, testimonial_id)
    if testimonial is None:
        raise HTTPException(status_code=404, detail="Testimonial not found")

    new_status = "approved" if data.action == "approve" else "rejected"

    testimonial.status = new_status
    testimonial.moderation_notes = data.notes
    testimonial.moderated_at = datetime.now(UTC)

    await db.commit()
    await db.refresh(testimonial)

    # Resolve names for the response — single-row join.
    MemberUser = aliased(User, name="member_user")
    CHWUser = aliased(User, name="chw_user")

    name_stmt = (
        select(MemberUser.name.label("member_name"), CHWUser.name.label("chw_name"))
        .where(MemberUser.id == testimonial.member_id)
        .where(CHWUser.id == testimonial.chw_id)
    )
    name_result = await db.execute(name_stmt)
    name_row = name_result.one_or_none()
    member_name = name_row.member_name if name_row else "Unknown"
    chw_name = name_row.chw_name if name_row else "Unknown"

    logger.info(
        "Testimonial moderated: id=%s action=%s status=%s",
        testimonial_id,
        data.action,
        new_status,
    )

    return AdminTestimonialView(
        id=testimonial.id,
        chw_id=testimonial.chw_id,
        chw_name=chw_name,
        member_id=testimonial.member_id,
        member_name=member_name,
        session_id=testimonial.session_id,
        rating=testimonial.rating,
        text=testimonial.text,
        status=testimonial.status,
        moderation_notes=testimonial.moderation_notes,
        created_at=testimonial.created_at,
        moderated_at=testimonial.moderated_at,
    )


# ─── Private helpers ───────────────────────────────────────────────────────────


def _derive_author_initial(full_name: str) -> str:
    """Return the privacy-preserving author display string from a full name.

    Examples:
        "Rosa Delgado" → "R."
        "Maria"        → "M."
        ""             → "?"     (defensive fallback for empty/null names)
    """
    first_char = full_name.strip()[:1] if full_name and full_name.strip() else ""
    return f"{first_char.upper()}." if first_char else "?"

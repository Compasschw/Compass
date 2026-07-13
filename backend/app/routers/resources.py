"""CHW Resource Folder — public search, CHW suggestion, and admin CRUD endpoints.

Route map
---------
Public (any authenticated user):
  GET  /api/v1/resources/search            — full-text + category + zip filter
  GET  /api/v1/resources/{id}              — fetch one resource

CHW-only:
  POST /api/v1/chw/resources/suggestions   — submit a suggestion

Admin-only (admin key required):
  GET    /api/v1/admin/resources                           — paginated list
  POST   /api/v1/admin/resources                           — create resource
  PATCH  /api/v1/admin/resources/{id}                      — update resource
  DELETE /api/v1/admin/resources/{id}                      — soft-delete (inactive)
  GET    /api/v1/admin/resources/suggestions               — pending suggestion queue
  POST   /api/v1/admin/resources/suggestions/{id}/approve  — promote to resource
  POST   /api/v1/admin/resources/suggestions/{id}/reject   — reject suggestion

Search ranking
--------------
The GET /search endpoint scores results with a simple Python-side ranking
after fetching the candidate set from Postgres:
  - Exact name prefix match → rank 0 (highest)
  - Name contains query term → rank 1
  - Description contains query term → rank 2
  - All others (category-only match) → rank 3

This avoids a Postgres full-text search dependency for MVP scale while
still producing intuitive ordering. Re-evaluate once the catalog grows
past ~1,000 rows.

Auth pattern
------------
- ``require_admin_key`` — the raw ADMIN_KEY bearer token (same as all
  other admin endpoints in this codebase).
- ``get_current_user`` — any JWT-authenticated user (CHW or member).
- ``require_role("chw")`` — CHW-only.
"""

import logging
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user, require_admin_key, require_role
from app.models.resource import Resource, ResourceSuggestion
from app.schemas.pagination import PaginatedResponse, PaginationParams, pagination
from app.schemas.resource import (
    AdminResourceResponse,
    ResourceCreate,
    ResourceResponse,
    ResourceSuggestionCreate,
    ResourceSuggestionResponse,
    ResourceUpdate,
    SuggestionApproveBody,
    SuggestionRejectBody,
)

logger = logging.getLogger("compass.resources")

# ─── Router instances ──────────────────────────────────────────────────────────
# Three separate router instances so each group can have its own prefix and tags.
# All three are imported and registered in app/main.py.

public_router = APIRouter(prefix="/api/v1/resources", tags=["resources"])
chw_router = APIRouter(prefix="/api/v1/chw/resources", tags=["resources-chw"])
admin_router = APIRouter(prefix="/api/v1/admin/resources", tags=["resources-admin"])

# ─── Allowed category values ───────────────────────────────────────────────────
#
# Epic C5: 'housing' is GRANDFATHERED — kept so search_resources/admin_list_resources
# can still filter by category="housing" (existing housing-categorized
# resources must remain findable) and so admin_approve_suggestion's
# category-fallback logic doesn't reject a suggestion whose proposed_resource
# already carries "housing" (a CHW-submitted suggestion is free-form JSON; see
# ResourceSuggestionCreate). 'utilities' is the replacement offered for NEW
# resource categorization (see ResourceCategory in schemas/resource.py and
# the admin CategoryPicker on the frontend, which no longer lists 'housing').

_VALID_CATEGORIES = frozenset(
    {
        "housing",
        "utilities",
        "food",
        "mental_health",
        "rehab",
        "healthcare",
        "legal",
        "transportation",
        "other",
    }
)


def _rank_resource(resource: Resource, query_lower: str) -> int:
    """Return an integer sort key for search result ordering.

    Lower is better (rank 0 = exact prefix match on name).
    """
    name_lower = resource.name.lower()
    desc_lower = (resource.description or "").lower()

    if name_lower.startswith(query_lower):
        return 0
    if query_lower in name_lower:
        return 1
    if query_lower in desc_lower:
        return 2
    return 3


# ─── Public endpoints ──────────────────────────────────────────────────────────


@public_router.get(
    "/search",
    response_model=list[ResourceResponse],
    summary="Search active resources by name, category, and/or zip code",
)
async def search_resources(
    q: str | None = Query(default=None, min_length=1, max_length=200, description="Free-text query matched against name and description"),
    category: str | None = Query(default=None, description="Filter by category (housing, food, mental_health, rehab, healthcare, legal, transportation, other)"),
    zip_code: str | None = Query(default=None, max_length=10, description="Filter by zip code (exact match)"),
    limit: int = Query(default=10, ge=1, le=50, description="Max results to return"),
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[ResourceResponse]:
    """Full-text + category + zip filter across the active resource catalog.

    Ranking (when ``q`` is provided, Python-side after DB fetch):
      0 — name starts with query
      1 — name contains query
      2 — description contains query
      3 — category/zip match only

    When ``q`` is absent, results are ordered by name ascending.
    """
    if category is not None and category not in _VALID_CATEGORIES:
        raise HTTPException(
            status_code=422,
            detail=f"Invalid category '{category}'. Valid values: {sorted(_VALID_CATEGORIES)}",
        )

    stmt = select(Resource).where(Resource.status == "active")

    if category is not None:
        stmt = stmt.where(Resource.category == category)

    if zip_code is not None:
        stmt = stmt.where(Resource.zip_code == zip_code)

    if q is not None:
        q_pattern = f"%{q.lower()}%"
        stmt = stmt.where(
            or_(
                func.lower(Resource.name).like(q_pattern),
                func.lower(Resource.description).like(q_pattern),
            )
        )

    # Fetch a broader candidate set then re-rank in Python for nuanced ordering.
    # Cap the DB query at 5× the requested limit to bound memory usage while
    # still having enough candidates to fill the ranked result set.
    stmt = stmt.order_by(Resource.name.asc()).limit(limit * 5)
    result = await db.execute(stmt)
    candidates = result.scalars().all()

    if q is not None:
        query_lower = q.lower()
        candidates = sorted(candidates, key=lambda r: _rank_resource(r, query_lower))

    return [ResourceResponse.model_validate(r) for r in candidates[:limit]]


@public_router.get(
    "/{resource_id}",
    response_model=ResourceResponse,
    summary="Fetch a single resource by ID",
)
async def get_resource(
    resource_id: UUID,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ResourceResponse:
    """Return a resource by its UUID.

    Returns 404 regardless of status — so an inactive resource is still
    resolvable when a CHW has already @-mentioned it in a saved note
    (the rendering layer shows an "inactive" badge).
    """
    resource = await db.get(Resource, resource_id)
    if resource is None:
        raise HTTPException(status_code=404, detail="Resource not found")
    return ResourceResponse.model_validate(resource)


# ─── CHW endpoints ─────────────────────────────────────────────────────────────


@chw_router.post(
    "/suggestions",
    response_model=ResourceSuggestionResponse,
    status_code=201,
    summary="CHW submits a resource suggestion for admin review",
)
async def create_resource_suggestion(
    data: ResourceSuggestionCreate,
    current_user=Depends(require_role("chw")),
    db: AsyncSession = Depends(get_db),
) -> ResourceSuggestionResponse:
    """POST /api/v1/chw/resources/suggestions

    Creates a pending ResourceSuggestion row. The admin team reviews the
    suggestion queue and can approve (→ creates a real Resource) or reject.

    Auth: CHW JWT only. Members and admins receive 403.
    """
    suggestion = ResourceSuggestion(
        chw_id=current_user.id,
        proposed_resource=data.proposed_resource,
        notes=data.notes,
        status="pending",
    )
    db.add(suggestion)
    await db.commit()
    await db.refresh(suggestion)

    logger.info(
        "Resource suggestion created: suggestion_id=%s chw_id=%s name=%s",
        suggestion.id,
        suggestion.chw_id,
        data.proposed_resource.get("name", "<unnamed>"),
    )

    return ResourceSuggestionResponse.model_validate(suggestion)


# ─── Admin endpoints ───────────────────────────────────────────────────────────


@admin_router.get(
    "",
    response_model=PaginatedResponse[AdminResourceResponse],
    summary="Admin: paginated resource catalog",
)
async def admin_list_resources(
    category: str | None = Query(default=None, description="Filter by category"),
    status: str | None = Query(default=None, description="Filter by status (active/inactive). Omit for all."),
    q: str | None = Query(default=None, min_length=1, max_length=200, description="Name/description substring search"),
    params: PaginationParams = Depends(pagination),
    _admin=Depends(require_admin_key),
    db: AsyncSession = Depends(get_db),
) -> PaginatedResponse[AdminResourceResponse]:
    """GET /api/v1/admin/resources

    Paginated, filterable resource list for the admin dashboard.
    Auth: ADMIN_KEY bearer token.
    """
    if category is not None and category not in _VALID_CATEGORIES:
        raise HTTPException(
            status_code=422,
            detail=f"Invalid category '{category}'. Valid values: {sorted(_VALID_CATEGORIES)}",
        )

    base_stmt = select(Resource)

    if category is not None:
        base_stmt = base_stmt.where(Resource.category == category)
    if status is not None:
        base_stmt = base_stmt.where(Resource.status == status)
    if q is not None:
        q_pattern = f"%{q.lower()}%"
        base_stmt = base_stmt.where(
            or_(
                func.lower(Resource.name).like(q_pattern),
                func.lower(Resource.description).like(q_pattern),
            )
        )

    # Total count — run a dedicated count query to avoid fetching all rows.
    count_stmt = select(func.count()).select_from(base_stmt.subquery())
    total: int = await db.scalar(count_stmt) or 0

    # Paginated result
    items_stmt = (
        base_stmt.order_by(Resource.created_at.desc())
        .offset(params.offset)
        .limit(params.page_size)
    )
    result = await db.execute(items_stmt)
    items = [AdminResourceResponse.model_validate(r) for r in result.scalars().all()]

    return PaginatedResponse(
        items=items,
        total=total,
        page=params.page,
        page_size=params.page_size,
    )


@admin_router.post(
    "",
    response_model=AdminResourceResponse,
    status_code=201,
    summary="Admin: create a new resource",
)
async def admin_create_resource(
    data: ResourceCreate,
    _admin=Depends(require_admin_key),
    db: AsyncSession = Depends(get_db),
) -> AdminResourceResponse:
    """POST /api/v1/admin/resources

    Creates an active resource in the catalog.
    Auth: ADMIN_KEY bearer token.

    Note: ``created_by_admin_id`` is intentionally not set here because
    ``require_admin_key`` does not resolve a User row — the admin bearer
    key is not tied to a user account in this codebase. This matches the
    pattern in the rest of the admin API.
    """
    resource = Resource(
        name=data.name,
        description=data.description,
        category=data.category,
        url=data.url,
        phone=data.phone,
        address=data.address,
        zip_code=data.zip_code,
        latitude=data.latitude,
        longitude=data.longitude,
        hours=data.hours,
        eligibility=data.eligibility,
        languages=data.languages,
        status="active",
    )
    db.add(resource)
    await db.commit()
    await db.refresh(resource)

    logger.info("Admin created resource: id=%s name=%s", resource.id, resource.name)

    return AdminResourceResponse.model_validate(resource)


@admin_router.patch(
    "/{resource_id}",
    response_model=AdminResourceResponse,
    summary="Admin: update a resource",
)
async def admin_update_resource(
    resource_id: UUID,
    data: ResourceUpdate,
    _admin=Depends(require_admin_key),
    db: AsyncSession = Depends(get_db),
) -> AdminResourceResponse:
    """PATCH /api/v1/admin/resources/{id}

    Partial update — only fields present in the request body are applied.
    Auth: ADMIN_KEY bearer token.
    """
    resource = await db.get(Resource, resource_id)
    if resource is None:
        raise HTTPException(status_code=404, detail="Resource not found")

    update_data = data.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(resource, field, value)

    await db.commit()
    await db.refresh(resource)

    logger.info("Admin updated resource: id=%s fields=%s", resource_id, list(update_data.keys()))

    return AdminResourceResponse.model_validate(resource)


@admin_router.delete(
    "/{resource_id}",
    status_code=204,
    summary="Admin: soft-delete a resource (sets status=inactive)",
)
async def admin_delete_resource(
    resource_id: UUID,
    _admin=Depends(require_admin_key),
    db: AsyncSession = Depends(get_db),
) -> None:
    """DELETE /api/v1/admin/resources/{id}

    Soft-deletes the resource by setting ``status = 'inactive'``.
    The row is preserved so that existing @[Name](resource:uuid) tokens
    in saved messages/notes can still resolve (with an inactive badge).

    Returns 204 No Content on success, 404 if not found.
    Auth: ADMIN_KEY bearer token.
    """
    resource = await db.get(Resource, resource_id)
    if resource is None:
        raise HTTPException(status_code=404, detail="Resource not found")

    if resource.status == "inactive":
        # Idempotent — deleting an already-inactive resource is a no-op.
        return

    resource.status = "inactive"
    await db.commit()

    logger.info("Admin soft-deleted resource: id=%s name=%s", resource_id, resource.name)


# ─── Admin suggestion queue endpoints ─────────────────────────────────────────
# NOTE: FastAPI matches routes top-to-bottom. The static route "/suggestions"
# must be registered BEFORE the parameterised routes "/suggestions/{id}/..."
# to avoid "suggestions" being captured as a resource_id UUID (which would
# fail UUID parsing and return a confusing 422). Register via include_router
# in the correct order in main.py, or keep the suggestions routes on their
# own sub-prefix — we use the latter approach here.

_suggestions_router = APIRouter(
    prefix="/api/v1/admin/resources/suggestions",
    tags=["resources-admin"],
)


@_suggestions_router.get(
    "",
    response_model=PaginatedResponse[ResourceSuggestionResponse],
    summary="Admin: paginated suggestion queue",
)
async def admin_list_suggestions(
    status: str | None = Query(
        default="pending",
        description="Filter by status (pending/approved/rejected). Default: pending.",
    ),
    params: PaginationParams = Depends(pagination),
    _admin=Depends(require_admin_key),
    db: AsyncSession = Depends(get_db),
) -> PaginatedResponse[ResourceSuggestionResponse]:
    """GET /api/v1/admin/resources/suggestions

    Returns the paginated suggestion queue, defaulting to pending items.
    Auth: ADMIN_KEY bearer token.
    """
    valid_statuses = {"pending", "approved", "rejected"}
    if status is not None and status not in valid_statuses:
        raise HTTPException(
            status_code=422,
            detail=f"Invalid status '{status}'. Valid values: {sorted(valid_statuses)}",
        )

    base_stmt = select(ResourceSuggestion)
    if status is not None:
        base_stmt = base_stmt.where(ResourceSuggestion.status == status)

    count_stmt = select(func.count()).select_from(base_stmt.subquery())
    total: int = await db.scalar(count_stmt) or 0

    items_stmt = (
        base_stmt.order_by(ResourceSuggestion.created_at.desc())
        .offset(params.offset)
        .limit(params.page_size)
    )
    result = await db.execute(items_stmt)
    items = [
        ResourceSuggestionResponse.model_validate(s)
        for s in result.scalars().all()
    ]

    return PaginatedResponse(
        items=items,
        total=total,
        page=params.page,
        page_size=params.page_size,
    )


@_suggestions_router.post(
    "/{suggestion_id}/approve",
    response_model=AdminResourceResponse,
    status_code=201,
    summary="Admin: approve suggestion → create real resource",
)
async def admin_approve_suggestion(
    suggestion_id: UUID,
    data: SuggestionApproveBody,
    _admin=Depends(require_admin_key),
    db: AsyncSession = Depends(get_db),
) -> AdminResourceResponse:
    """POST /api/v1/admin/resources/suggestions/{id}/approve

    Promotes a pending suggestion to a real Resource row and marks the
    suggestion as approved. Field values from ``data`` override whatever
    the CHW submitted in ``proposed_resource``; missing fields fall back
    to the CHW's values.

    Errors:
      404 — suggestion not found
      409 — suggestion is not in 'pending' status
    Auth: ADMIN_KEY bearer token.
    """
    suggestion = await db.get(ResourceSuggestion, suggestion_id)
    if suggestion is None:
        raise HTTPException(status_code=404, detail="Suggestion not found")
    if suggestion.status != "pending":
        raise HTTPException(
            status_code=409,
            detail=f"Cannot approve a suggestion with status '{suggestion.status}'.",
        )

    # Merge: admin overrides win; fall back to CHW's proposed_resource values.
    proposed = suggestion.proposed_resource or {}
    override = data.model_dump(exclude_unset=True)

    def _resolve(field: str, default=None):
        """Return admin override if present, then CHW value, then default."""
        if field in override:
            return override[field]
        return proposed.get(field, default)

    category = _resolve("category", "other")
    if category not in _VALID_CATEGORIES:
        category = "other"

    resource = Resource(
        name=_resolve("name") or proposed.get("name", "Unnamed Resource"),
        description=_resolve("description") or proposed.get("description", ""),
        category=category,
        url=_resolve("url"),
        phone=_resolve("phone"),
        address=_resolve("address"),
        zip_code=_resolve("zip_code"),
        latitude=_resolve("latitude"),
        longitude=_resolve("longitude"),
        hours=_resolve("hours"),
        eligibility=_resolve("eligibility"),
        languages=_resolve("languages") or [],
        status="active",
    )
    db.add(resource)

    suggestion.status = "approved"
    suggestion.reviewed_at = datetime.now(UTC)

    await db.commit()
    await db.refresh(resource)

    logger.info(
        "Admin approved suggestion: suggestion_id=%s → resource_id=%s name=%s",
        suggestion_id,
        resource.id,
        resource.name,
    )

    return AdminResourceResponse.model_validate(resource)


@_suggestions_router.post(
    "/{suggestion_id}/reject",
    response_model=ResourceSuggestionResponse,
    summary="Admin: reject a suggestion",
)
async def admin_reject_suggestion(
    suggestion_id: UUID,
    data: SuggestionRejectBody,
    _admin=Depends(require_admin_key),
    db: AsyncSession = Depends(get_db),
) -> ResourceSuggestionResponse:
    """POST /api/v1/admin/resources/suggestions/{id}/reject

    Marks the suggestion as rejected. An optional ``admin_notes`` field
    in the request body may carry a reason, which is stored in the
    suggestion's ``notes`` field (appended, prefixed with "Admin: ").

    Errors:
      404 — suggestion not found
      409 — suggestion is not in 'pending' status
    Auth: ADMIN_KEY bearer token.
    """
    suggestion = await db.get(ResourceSuggestion, suggestion_id)
    if suggestion is None:
        raise HTTPException(status_code=404, detail="Suggestion not found")
    if suggestion.status != "pending":
        raise HTTPException(
            status_code=409,
            detail=f"Cannot reject a suggestion with status '{suggestion.status}'.",
        )

    if data.admin_notes:
        existing_notes = suggestion.notes or ""
        admin_prefix = f"[Admin review] {data.admin_notes}"
        suggestion.notes = (
            f"{existing_notes}\n\n{admin_prefix}".strip()
            if existing_notes
            else admin_prefix
        )

    suggestion.status = "rejected"
    suggestion.reviewed_at = datetime.now(UTC)

    await db.commit()
    await db.refresh(suggestion)

    logger.info("Admin rejected suggestion: suggestion_id=%s", suggestion_id)

    return ResourceSuggestionResponse.model_validate(suggestion)

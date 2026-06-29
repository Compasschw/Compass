"""Journeys router — gamified care pathways.

Endpoint summary:
  GET    /api/v1/journeys/templates
  GET    /api/v1/chw/journeys
  GET    /api/v1/journeys/{member_journey_id}
  GET    /api/v1/members/{member_id}/journeys
  POST   /api/v1/members/{member_id}/journeys
  POST   /api/v1/journeys/{member_journey_id}/nodes
  PATCH  /api/v1/journeys/{member_journey_id}/nodes/{step_id}
  PATCH  /api/v1/journeys/{member_journey_id}/steps/{step_id}
  DELETE /api/v1/journeys/{member_journey_id}/nodes/{step_id}
  GET    /api/v1/members/{member_id}/wellness-points

Authorization:
  - Every endpoint that takes a member_id applies the relationship guard:
    the requesting CHW must have at least one Session or matched ServiceRequest
    with the member, or the endpoint returns 403 (not 404) to avoid disclosing
    whether the member_id exists.
  - Members can only read their own journeys/wellness-points.
  - Admin callers bypass relationship checks.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user, require_role
from app.models.journeys import (
    JourneyTemplate,
    JourneyTemplateStep,
    MemberJourney,
    MemberJourneyStepState,
    WellnessPointsLedger,
)
from app.models.user import MemberProfile
from app.schemas.journeys import (
    CaseloadJourneyItem,
    CreateCustomJourneyRequest,
    CreateMemberJourneyRequest,
    JourneyNodeUpsert,
    JourneyStepResponse,
    JourneyTemplateResponse,
    MemberJourneyResponse,
    MemberJourneyStepResponse,
    UpdateJourneyPriorityRequest,
    UpdateStepStatusRequest,
    WellnessLedgerEntry,
    WellnessPointsSummary,
)

router = APIRouter(tags=["journeys"])


# ─── Internal helpers ──────────────────────────────────────────────────────────


async def _assert_chw_member_relationship(
    chw_id: uuid.UUID,
    member_id: uuid.UUID,
    db: AsyncSession,
) -> None:
    """Raise HTTP 403 if the CHW has no relationship with the member.

    Checks for:
      1. Any Session row where chw_id matches AND member_id matches.
      2. Any matched ServiceRequest where matched_chw_id matches AND
         member_id matches.

    Returns 403 (not 404) to avoid disclosing whether the member_id exists.
    """
    from app.models.request import ServiceRequest
    from app.models.session import Session

    session_count_result = await db.execute(
        select(func.count())
        .select_from(Session)
        .where(Session.chw_id == chw_id)
        .where(Session.member_id == member_id)
    )
    if (session_count_result.scalar() or 0) > 0:
        return

    request_count_result = await db.execute(
        select(func.count())
        .select_from(ServiceRequest)
        .where(ServiceRequest.matched_chw_id == chw_id)
        .where(ServiceRequest.member_id == member_id)
    )
    if (request_count_result.scalar() or 0) > 0:
        return

    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="You do not have an active relationship with this member.",
    )


async def _load_template_with_steps(
    template_id: uuid.UUID, db: AsyncSession
) -> JourneyTemplateResponse:
    """Load a JourneyTemplate and its ordered steps into the response schema."""
    template_result = await db.execute(
        select(JourneyTemplate).where(JourneyTemplate.id == template_id)
    )
    template = template_result.scalar_one_or_none()
    if template is None:
        raise HTTPException(status_code=404, detail="Journey template not found.")

    steps_result = await db.execute(
        select(JourneyTemplateStep)
        .where(JourneyTemplateStep.template_id == template_id)
        .order_by(JourneyTemplateStep.order)
    )
    steps = steps_result.scalars().all()

    return JourneyTemplateResponse(
        id=template.id,
        slug=template.slug,
        name=template.name,
        category=template.category,
        icon=template.icon,
        is_active=template.is_active,
        steps=[JourneyStepResponse.model_validate(s) for s in steps],
        created_at=template.created_at,
    )


async def _build_member_journey_response(
    member_journey: MemberJourney, db: AsyncSession
) -> MemberJourneyResponse:
    """Assemble a full MemberJourneyResponse for a single MemberJourney row.

    Executes two additional queries:
      1. Fetch the template + its ordered steps (for metadata).
      2. Fetch all MemberJourneyStepState rows for this journey, joined to
         JourneyTemplateStep for order/name/description.

    N+1 note: callers that iterate over many journeys should use a bulk loader
    instead of calling this per row. For single-journey views the two queries
    are acceptable.
    """
    template_response = await _load_template_with_steps(member_journey.template_id, db)

    # Load step states joined to template steps for merged metadata.
    states_result = await db.execute(
        select(MemberJourneyStepState, JourneyTemplateStep)
        .join(
            JourneyTemplateStep,
            MemberJourneyStepState.template_step_id == JourneyTemplateStep.id,
        )
        .where(MemberJourneyStepState.member_journey_id == member_journey.id)
        .order_by(JourneyTemplateStep.order)
    )
    rows = states_result.all()

    step_responses: list[MemberJourneyStepResponse] = []
    total_points = 0
    completed_count = 0

    for state, tpl_step in rows:
        step_resp = MemberJourneyStepResponse(
            id=state.id,
            member_journey_id=state.member_journey_id,
            template_step_id=state.template_step_id,
            step_order=tpl_step.order,
            step_name=tpl_step.name,
            step_description=tpl_step.description,
            points_on_completion=tpl_step.points_on_completion,
            required_documents=tpl_step.required_documents or [],
            status=state.status,
            started_at=state.started_at,
            completed_at=state.completed_at,
            due_date=state.due_date,
            points_awarded=state.points_awarded,
            created_at=state.created_at,
        )
        step_responses.append(step_resp)
        total_points += state.points_awarded
        if state.status == "completed":
            completed_count += 1

    total_steps = len(step_responses)
    progress_percent = round(completed_count / total_steps * 100, 1) if total_steps else 0.0

    # Identify the current step (matches current_step_id on the journey).
    current_step: MemberJourneyStepResponse | None = None
    if member_journey.current_step_id is not None:
        current_step = next(
            (s for s in step_responses if s.template_step_id == member_journey.current_step_id),
            None,
        )

    return MemberJourneyResponse(
        id=member_journey.id,
        member_id=member_journey.member_id,
        chw_id=member_journey.chw_id,
        template=template_response,
        steps=step_responses,
        status=member_journey.status,
        progress_percent=progress_percent,
        current_step=current_step,
        wellness_points_earned=total_points,
        started_at=member_journey.started_at,
        completed_at=member_journey.completed_at,
        created_at=member_journey.created_at,
        priority_level=member_journey.priority_level,
    )


# ─── GET /api/v1/journeys/templates ───────────────────────────────────────────


@router.get(
    "/api/v1/journeys/templates",
    response_model=list[JourneyTemplateResponse],
    summary="List available journey templates",
)
async def list_journey_templates(
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[JourneyTemplateResponse]:
    """Return all active JourneyTemplates with their ordered steps.

    Available to any authenticated user (CHW or member). Results are stable
    and change rarely; a future iteration should add a Cache-Control header or
    Redis cache keyed on a templates_version counter.
    """
    templates_result = await db.execute(
        select(JourneyTemplate)
        .where(JourneyTemplate.is_active == True)  # noqa: E712
        .where(JourneyTemplate.is_custom == False)  # noqa: E712 — private per-member templates
        .order_by(JourneyTemplate.name)
    )
    templates = templates_result.scalars().all()

    responses: list[JourneyTemplateResponse] = []
    for template in templates:
        steps_result = await db.execute(
            select(JourneyTemplateStep)
            .where(JourneyTemplateStep.template_id == template.id)
            .order_by(JourneyTemplateStep.order)
        )
        steps = steps_result.scalars().all()
        responses.append(
            JourneyTemplateResponse(
                id=template.id,
                slug=template.slug,
                name=template.name,
                category=template.category,
                icon=template.icon,
                is_active=template.is_active,
                steps=[JourneyStepResponse.model_validate(s) for s in steps],
                created_at=template.created_at,
            )
        )
    return responses


# ─── GET /api/v1/chw/journeys ─────────────────────────────────────────────────


@router.get(
    "/api/v1/chw/journeys",
    response_model=list[CaseloadJourneyItem],
    summary="CHW caseload — all member journeys assigned to this CHW",
)
async def list_chw_journeys(
    current_user=Depends(require_role("chw")),
    db: AsyncSession = Depends(get_db),
) -> list[CaseloadJourneyItem]:
    """Return a lightweight list of all MemberJourneys where chw_id matches
    the authenticated CHW.

    The response intentionally omits full step-state detail to keep the
    payload small for caseload views with many members. Clients that need full
    step detail should call GET /members/{member_id}/journeys/{journey_id}.
    """
    from app.models.user import User

    journeys_result = await db.execute(
        select(MemberJourney)
        .where(MemberJourney.chw_id == current_user.id)
        .order_by(MemberJourney.created_at.desc())
    )
    journeys = journeys_result.scalars().all()

    if not journeys:
        return []

    # Batch-load templates for the journeys to avoid N+1.
    template_ids = list({j.template_id for j in journeys})
    templates_result = await db.execute(
        select(JourneyTemplate).where(JourneyTemplate.id.in_(template_ids))
    )
    templates_by_id = {t.id: t for t in templates_result.scalars().all()}

    # Batch-load member names.
    member_ids = list({j.member_id for j in journeys})
    members_result = await db.execute(
        select(User).where(User.id.in_(member_ids))
    )
    members_by_id = {u.id: u for u in members_result.scalars().all()}

    # Batch-load current steps for all journeys that have one.
    current_step_ids = [j.current_step_id for j in journeys if j.current_step_id is not None]
    current_steps_by_id: dict[uuid.UUID, JourneyTemplateStep] = {}
    if current_step_ids:
        current_steps_result = await db.execute(
            select(JourneyTemplateStep).where(JourneyTemplateStep.id.in_(current_step_ids))
        )
        current_steps_by_id = {s.id: s for s in current_steps_result.scalars().all()}

    # Compute progress percents via step-state counts.
    # One query per journey — acceptable for caseload sizes (<200 rows).
    results: list[CaseloadJourneyItem] = []
    for journey in journeys:
        template = templates_by_id.get(journey.template_id)
        member_user = members_by_id.get(journey.member_id)
        if template is None or member_user is None:
            continue

        # Count total and completed steps.
        total_result = await db.execute(
            select(func.count())
            .select_from(MemberJourneyStepState)
            .where(MemberJourneyStepState.member_journey_id == journey.id)
        )
        total_steps = total_result.scalar() or 0

        completed_result = await db.execute(
            select(func.count())
            .select_from(MemberJourneyStepState)
            .where(MemberJourneyStepState.member_journey_id == journey.id)
            .where(MemberJourneyStepState.status == "completed")
        )
        completed_steps = completed_result.scalar() or 0

        points_result = await db.execute(
            select(func.coalesce(func.sum(MemberJourneyStepState.points_awarded), 0))
            .where(MemberJourneyStepState.member_journey_id == journey.id)
        )
        total_points = points_result.scalar() or 0

        progress_percent = (
            round(completed_steps / total_steps * 100, 1) if total_steps else 0.0
        )

        current_step = (
            current_steps_by_id.get(journey.current_step_id)
            if journey.current_step_id
            else None
        )

        results.append(
            CaseloadJourneyItem(
                id=journey.id,
                member_id=journey.member_id,
                member_name=member_user.name,
                template_name=template.name,
                template_slug=template.slug,
                template_icon=template.icon,
                status=journey.status,
                progress_percent=progress_percent,
                current_step_name=current_step.name if current_step else None,
                wellness_points_earned=int(total_points),
                started_at=journey.started_at,
                completed_at=journey.completed_at,
            )
        )
    return results


# ─── GET /api/v1/journeys/{member_journey_id} ─────────────────────────────────


@router.get(
    "/api/v1/journeys/{member_journey_id}",
    response_model=MemberJourneyResponse,
    summary="Full detail for a single member journey (CHW caseload expand)",
)
async def get_chw_journey_detail(
    member_journey_id: uuid.UUID,
    current_user=Depends(require_role("chw")),
    db: AsyncSession = Depends(get_db),
) -> MemberJourneyResponse:
    """Return the full step-state detail for one MemberJourney on the CHW's caseload.

    Backs the expandable Journeys card: the lightweight GET /chw/journeys list
    omits steps to keep the payload small, so the screen calls this endpoint when
    a card is expanded to show the ordered steps and the member's current position.

    Authorization: the requesting CHW must be the assigned chw_id on the journey.
    Returns 403 (not 404) when another CHW requests it, mirroring the relationship
    guard used elsewhere — never disclose whether the journey id exists.
    """
    journey_result = await db.execute(
        select(MemberJourney).where(MemberJourney.id == member_journey_id)
    )
    member_journey = journey_result.scalar_one_or_none()
    if member_journey is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Journey not found."
        )

    if member_journey.chw_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not the assigned CHW for this journey.",
        )

    return await _build_member_journey_response(member_journey, db)


# ─── GET /api/v1/members/{member_id}/journeys ─────────────────────────────────


@router.get(
    "/api/v1/members/{member_id}/journeys",
    response_model=list[MemberJourneyResponse],
    summary="All journeys for a member",
)
async def list_member_journeys(
    member_id: uuid.UUID,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[MemberJourneyResponse]:
    """Return all MemberJourneys for a member, with full step-state detail.

    Authorization:
      - CHW callers: must have an active relationship (Session or matched
        ServiceRequest) with the member. Returns 403 otherwise.
      - Member callers: can only read their own journeys. Returns 403 if
        member_id != current_user.id.
    """
    if current_user.role == "chw":
        await _assert_chw_member_relationship(current_user.id, member_id, db)
    elif current_user.role == "member":
        if current_user.id != member_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You can only view your own journeys.",
            )
    # Admin passes through.

    journeys_result = await db.execute(
        select(MemberJourney)
        .where(MemberJourney.member_id == member_id)
        .order_by(MemberJourney.created_at.desc())
    )
    journeys = journeys_result.scalars().all()

    return [await _build_member_journey_response(j, db) for j in journeys]


# ─── POST /api/v1/members/{member_id}/journeys ────────────────────────────────


@router.post(
    "/api/v1/members/{member_id}/journeys",
    response_model=MemberJourneyResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Start a new journey for a member",
)
async def create_member_journey(
    member_id: uuid.UUID,
    body: CreateMemberJourneyRequest,
    current_user=Depends(require_role("chw")),
    db: AsyncSession = Depends(get_db),
) -> MemberJourneyResponse:
    """Assign a JourneyTemplate to a member. CHW action only.

    Applies the relationship guard — the CHW must have an active Session or
    matched ServiceRequest with the member.

    Guards:
      - 403 if no CHW–member relationship.
      - 409 if the member already has an active journey for this template.
      - 404 if the template_slug does not exist or is inactive.

    On success, creates:
      - One MemberJourney row (status='active', current_step set to step 1).
      - One MemberJourneyStepState row per template step ('in_progress' for
        step 1, 'upcoming' for all others).
    """
    await _assert_chw_member_relationship(current_user.id, member_id, db)

    # Resolve the template slug.
    template_result = await db.execute(
        select(JourneyTemplate)
        .where(JourneyTemplate.slug == body.template_slug)
        .where(JourneyTemplate.is_active == True)  # noqa: E712
    )
    template = template_result.scalar_one_or_none()
    if template is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Journey template '{body.template_slug}' not found or is inactive.",
        )

    # Guard: at most one active journey per member per template.
    duplicate_result = await db.execute(
        select(func.count())
        .select_from(MemberJourney)
        .where(MemberJourney.member_id == member_id)
        .where(MemberJourney.template_id == template.id)
        .where(MemberJourney.status == "active")
    )
    if (duplicate_result.scalar() or 0) > 0:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Member already has an active journey for this template.",
        )

    # Delegate core creation to the shared helper (used by the reconciler too).
    from app.services.journey_reconciler import create_journey_for_template

    try:
        member_journey = await create_journey_for_template(
            db, member_id, current_user.id, template
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc

    await db.commit()
    await db.refresh(member_journey)

    return await _build_member_journey_response(member_journey, db)


# ─── Custom (CHW-authored) journeys ───────────────────────────────────────────
#
# A custom journey is a normal MemberJourney backed by a PRIVATE JourneyTemplate
# (is_custom=true) the CHW fills in node-by-node. Because it reuses the template
# machinery, the response builder, step-complete flow, Journeys page, and Roadmap
# all work unchanged — only the template is per-member and editable.
#
# Points rule: the first node is worth 10 points, every later node 5.


async def _next_node_points(journey_template_id: uuid.UUID, db: AsyncSession) -> int:
    """10 for the first node on a custom journey, 5 for every node after."""
    existing = (
        await db.execute(
            select(func.count())
            .select_from(JourneyTemplateStep)
            .where(JourneyTemplateStep.template_id == journey_template_id)
        )
    ).scalar() or 0
    return 10 if existing == 0 else 5


@router.post(
    "/api/v1/journeys/custom",
    response_model=MemberJourneyResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a CHW-authored custom journey with 3 blank nodes",
)
async def create_custom_journey(
    body: CreateCustomJourneyRequest,
    current_user=Depends(require_role("chw")),
    db: AsyncSession = Depends(get_db),
) -> MemberJourneyResponse:
    """Create a custom journey for one of the CHW's members.

    Provisions a private template named ``title`` with 3 blank starter nodes
    (points 10, 5, 5) and an active MemberJourney positioned at node 1. The CHW
    then fills in each node's description and may add more nodes (POST .../nodes).
    """
    await _assert_chw_member_relationship(current_user.id, body.member_id, db)

    template = JourneyTemplate(
        id=uuid.uuid4(),
        slug=f"custom-{uuid.uuid4().hex}",
        name=body.title.strip(),
        category=(body.category or body.title).strip().lower()[:100],
        icon=(body.icon or "circle"),
        is_active=True,
        is_custom=True,
    )
    db.add(template)
    await db.flush()

    # 3 blank starter nodes: points 10, 5, 5.
    steps: list[JourneyTemplateStep] = []
    for order, points in ((1, 10), (2, 5), (3, 5)):
        step = JourneyTemplateStep(
            id=uuid.uuid4(),
            template_id=template.id,
            order=order,
            name="",
            description="",
            points_on_completion=points,
        )
        db.add(step)
        steps.append(step)
    await db.flush()

    now = datetime.now(UTC)
    member_journey = MemberJourney(
        id=uuid.uuid4(),
        member_id=body.member_id,
        chw_id=current_user.id,
        template_id=template.id,
        status="active",
        current_step_id=steps[0].id,
        started_at=now,
        priority_level=body.priority_level,
    )
    db.add(member_journey)
    await db.flush()

    for i, step in enumerate(steps):
        db.add(
            MemberJourneyStepState(
                id=uuid.uuid4(),
                member_journey_id=member_journey.id,
                template_step_id=step.id,
                status="in_progress" if i == 0 else "upcoming",
                started_at=now if i == 0 else None,
            )
        )

    await db.commit()
    await db.refresh(member_journey)
    return await _build_member_journey_response(member_journey, db)


@router.patch(
    "/api/v1/journeys/{member_journey_id}/priority",
    response_model=MemberJourneyResponse,
    summary="Update a custom journey's CHW-assigned priority level",
)
async def update_journey_priority(
    member_journey_id: uuid.UUID,
    body: UpdateJourneyPriorityRequest,
    current_user=Depends(require_role("chw")),
    db: AsyncSession = Depends(get_db),
) -> MemberJourneyResponse:
    """Set the priority (low|medium|high) of a CHW-authored custom journey.

    Only custom journeys carry a priority_level. The shared helper enforces that
    the caller is the assigned CHW and the journey is custom (404/403/409).
    """
    member_journey, _template = await _load_custom_journey_for_chw(
        member_journey_id, current_user, db
    )
    member_journey.priority_level = body.priority_level
    await db.commit()
    await db.refresh(member_journey)
    return await _build_member_journey_response(member_journey, db)


@router.delete(
    "/api/v1/journeys/{member_journey_id}",
    response_model=MemberJourneyResponse,
    summary="Remove (abandon) a CHW-authored custom journey",
)
async def remove_custom_journey(
    member_journey_id: uuid.UUID,
    current_user=Depends(require_role("chw")),
    db: AsyncSession = Depends(get_db),
) -> MemberJourneyResponse:
    """Soft-remove a custom journey by marking it 'abandoned'.

    Only the assigned CHW may remove, and only custom (CHW-authored) journeys —
    the shared helper raises 404/403/409 otherwise. The row is kept (status
    abandoned) so any wellness points already awarded are preserved; it simply
    drops out of every active-journey view (Resource Needs card, Member Journey
    section, and the Edit Resource Needs modal).
    """
    member_journey, _template = await _load_custom_journey_for_chw(
        member_journey_id, current_user, db
    )
    member_journey.status = "abandoned"
    await db.commit()
    await db.refresh(member_journey)
    return await _build_member_journey_response(member_journey, db)


async def _load_custom_journey_for_chw(
    member_journey_id: uuid.UUID, current_user, db: AsyncSession
) -> tuple[MemberJourney, JourneyTemplate]:
    """Load a member journey + its template, asserting the CHW owns it and the
    template is custom (editable). Raises 404/403 otherwise."""
    member_journey = (
        await db.execute(select(MemberJourney).where(MemberJourney.id == member_journey_id))
    ).scalar_one_or_none()
    if member_journey is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Journey not found.")
    if member_journey.chw_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not the assigned CHW for this journey.",
        )
    template = (
        await db.execute(
            select(JourneyTemplate).where(JourneyTemplate.id == member_journey.template_id)
        )
    ).scalar_one_or_none()
    if template is None or not template.is_custom:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Only custom (CHW-authored) journeys can be edited.",
        )
    return member_journey, template


async def fork_member_journey_to_private(
    db: AsyncSession,
    member_journey: MemberJourney,
    template: JourneyTemplate,
) -> tuple[MemberJourney, JourneyTemplate, dict[uuid.UUID, uuid.UUID]]:
    """Fork a shared JourneyTemplate to a private per-member copy.

    If the template is already custom (is_custom=True) this is a no-op and the
    same objects are returned unchanged with an empty map — idempotent; never
    double-forks.

    When forking:
      1. A new JourneyTemplate is created (is_custom=True, unique slug
         ``custom-{member_journey.id}``).
      2. Every JourneyTemplateStep of the original is cloned into the new
         template in order. An old_step_id → new_step_id map is built.
      3. MemberJourney.template_id is re-pointed to the new template.
         MemberJourney.current_step_id is re-mapped via the id map.
      4. Every MemberJourneyStepState for this member_journey is re-pointed
         from the old step id to the new cloned step id, preserving all
         progress fields.

    The original shared template and its steps are left completely untouched.

    Returns:
        A 3-tuple of (member_journey, new_template, old_step_id→new_step_id map).
        The map is empty when the template was already custom (no-op path).
    """
    if template.is_custom:
        # Already a private copy — nothing to do.
        return member_journey, template, {}

    # ── 1. Clone the JourneyTemplate ────────────────────────────────────────────
    new_template = JourneyTemplate(
        id=uuid.uuid4(),
        slug=f"custom-{member_journey.id}",
        name=template.name,
        category=template.category,
        icon=template.icon,
        is_active=template.is_active,
        is_custom=True,
    )
    db.add(new_template)
    await db.flush()  # populate new_template.id before FK references below

    # ── 2. Clone all steps; build old_step_id → new_step_id map ─────────────────
    original_steps_result = await db.execute(
        select(JourneyTemplateStep)
        .where(JourneyTemplateStep.template_id == template.id)
        .order_by(JourneyTemplateStep.order)
    )
    original_steps: list[JourneyTemplateStep] = list(
        original_steps_result.scalars().all()
    )

    # Map: old_step_id → new_step_id (used to re-map MemberJourneyStepState rows
    # and to remap URL step_id params that reference the old template's steps).
    old_to_new_step_id: dict[uuid.UUID, uuid.UUID] = {}

    for orig_step in original_steps:
        new_step_id = uuid.uuid4()
        cloned_step = JourneyTemplateStep(
            id=new_step_id,
            template_id=new_template.id,
            order=orig_step.order,
            name=orig_step.name,
            description=orig_step.description,
            points_on_completion=orig_step.points_on_completion,
            required_documents=orig_step.required_documents,
        )
        db.add(cloned_step)
        old_to_new_step_id[orig_step.id] = new_step_id

    await db.flush()  # ensure all new step rows exist before FK updates below

    # ── 3. Re-point MemberJourney to the new custom template ────────────────────
    member_journey.template_id = new_template.id

    if member_journey.current_step_id is not None:
        # Re-map current_step_id to the cloned counterpart.
        mapped_current = old_to_new_step_id.get(member_journey.current_step_id)
        if mapped_current is not None:
            member_journey.current_step_id = mapped_current
        # If current_step_id had no matching old step (data anomaly), leave as-is;
        # the subsequent endpoint logic will handle any resulting 404.

    # ── 4. Re-map every MemberJourneyStepState for this member_journey ──────────
    step_states_result = await db.execute(
        select(MemberJourneyStepState).where(
            MemberJourneyStepState.member_journey_id == member_journey.id
        )
    )
    step_states: list[MemberJourneyStepState] = list(
        step_states_result.scalars().all()
    )

    for state in step_states:
        new_template_step_id = old_to_new_step_id.get(state.template_step_id)
        if new_template_step_id is not None:
            state.template_step_id = new_template_step_id
        # Orphan states (pointing to steps not on this template) are left alone;
        # the FK constraint will catch truly invalid rows.

    await db.flush()
    return member_journey, new_template, old_to_new_step_id


async def _load_journey_for_chw(
    member_journey_id: uuid.UUID,
    current_user: object,
    db: AsyncSession,
) -> tuple[MemberJourney, JourneyTemplate]:
    """Load a member journey + its template, asserting the CHW is assigned to it.

    Unlike ``_load_custom_journey_for_chw``, this does NOT raise 409 for
    non-custom templates. It is used by structural-edit endpoints that call
    ``fork_member_journey_to_private`` themselves to transparently convert a
    shared template to a private per-member copy on the first structural edit.

    Raises:
        404 if the member journey does not exist.
        403 if the requesting user is not the assigned CHW.
        404 if the template row is missing (data integrity failure).
    """
    member_journey = (
        await db.execute(
            select(MemberJourney).where(MemberJourney.id == member_journey_id)
        )
    ).scalar_one_or_none()
    if member_journey is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Journey not found."
        )
    if member_journey.chw_id != current_user.id:  # type: ignore[attr-defined]
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not the assigned CHW for this journey.",
        )
    template = (
        await db.execute(
            select(JourneyTemplate).where(
                JourneyTemplate.id == member_journey.template_id
            )
        )
    ).scalar_one_or_none()
    if template is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Journey template not found.",
        )
    return member_journey, template


@router.post(
    "/api/v1/journeys/{member_journey_id}/nodes",
    response_model=MemberJourneyResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Add a node to a custom journey",
)
async def add_journey_node(
    member_journey_id: uuid.UUID,
    body: JourneyNodeUpsert,
    current_user=Depends(require_role("chw")),
    db: AsyncSession = Depends(get_db),
) -> MemberJourneyResponse:
    """Add a node to a custom journey.

    Default (append) mode:
      Appends a new node at the end of the journey (worth 10 points for the
      first node, 5 for every subsequent node).

    Positional insert mode:
      When ``position`` and ``relative_to_step_id`` are both provided, the new
      node is inserted before or after the referenced step. All existing steps at
      or after the insert point have their ``order`` incremented by 1. The new
      node is always worth 5 points in positional mode (it is never the first).

    Both ``position`` and ``relative_to_step_id`` must be supplied together;
    providing only one raises HTTP 400.
    """
    member_journey, template = await _load_journey_for_chw(
        member_journey_id, current_user, db
    )
    member_journey, template, _step_id_map = await fork_member_journey_to_private(
        db, member_journey, template
    )

    # ── Validate positional-insert field pairing ────────────────────────────────
    position_provided = body.position is not None
    ref_step_provided = body.relative_to_step_id is not None

    if position_provided != ref_step_provided:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Both 'position' and 'relative_to_step_id' must be provided together.",
        )

    if position_provided and ref_step_provided:
        # ── Positional insert branch ────────────────────────────────────────────
        #
        # 1. Validate relative_to_step_id belongs to this journey's template.
        # 2. Determine insert_point from target step's order.
        # 3. Shift all steps at or after insert_point up by 1.
        # 4. Insert new step at insert_point (always 5 points).
        # 5. Create MemberJourneyStepState with status='upcoming'.

        target_step_result = await db.execute(
            select(JourneyTemplateStep)
            .where(JourneyTemplateStep.id == body.relative_to_step_id)
            .where(JourneyTemplateStep.template_id == template.id)
        )
        target_step = target_step_result.scalar_one_or_none()
        if target_step is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="relative_to_step_id does not belong to this journey.",
            )

        insert_point: int = (
            target_step.order if body.position == "before" else target_step.order + 1
        )

        # Shift existing steps whose order >= insert_point to make room.
        await db.execute(
            update(JourneyTemplateStep)
            .where(JourneyTemplateStep.template_id == template.id)
            .where(JourneyTemplateStep.order >= insert_point)
            .values(order=JourneyTemplateStep.order + 1)
        )
        # Flush the shift before inserting so the new step's order doesn't collide.
        await db.flush()

        step = JourneyTemplateStep(
            id=uuid.uuid4(),
            template_id=template.id,
            order=insert_point,
            name=(body.name or "").strip(),
            description=(body.description or "").strip(),
            points_on_completion=5,
        )
        db.add(step)
        await db.flush()

        db.add(
            MemberJourneyStepState(
                id=uuid.uuid4(),
                member_journey_id=member_journey.id,
                template_step_id=step.id,
                status="upcoming",
            )
        )

    else:
        # ── Append (default) branch ─────────────────────────────────────────────
        max_order = (
            await db.execute(
                select(func.coalesce(func.max(JourneyTemplateStep.order), 0)).where(
                    JourneyTemplateStep.template_id == template.id
                )
            )
        ).scalar() or 0
        points = await _next_node_points(template.id, db)

        step = JourneyTemplateStep(
            id=uuid.uuid4(),
            template_id=template.id,
            order=max_order + 1,
            name=(body.name or "").strip(),
            description=(body.description or "").strip(),
            points_on_completion=points,
        )
        db.add(step)
        await db.flush()

        db.add(
            MemberJourneyStepState(
                id=uuid.uuid4(),
                member_journey_id=member_journey.id,
                template_step_id=step.id,
                status="upcoming",
            )
        )

    await db.commit()
    await db.refresh(member_journey)
    return await _build_member_journey_response(member_journey, db)


@router.patch(
    "/api/v1/journeys/{member_journey_id}/nodes/{step_id}",
    response_model=MemberJourneyResponse,
    summary="Edit a custom journey node's name/description",
)
async def update_journey_node(
    member_journey_id: uuid.UUID,
    step_id: uuid.UUID,
    body: JourneyNodeUpsert,
    current_user=Depends(require_role("chw")),
    db: AsyncSession = Depends(get_db),
) -> MemberJourneyResponse:
    """Edit a node's name and/or description (CHW writes the step text).

    If the journey is on a shared built-in template, the template is first
    forked to a private per-member copy before the update is applied, so other
    members using the same template are not affected.
    """
    member_journey, template = await _load_journey_for_chw(
        member_journey_id, current_user, db
    )
    member_journey, template, step_id_map = await fork_member_journey_to_private(
        db, member_journey, template
    )
    # If a fork just happened, remap the URL step_id to the cloned step.
    if step_id_map:
        step_id = step_id_map.get(step_id, step_id)

    step = (
        await db.execute(
            select(JourneyTemplateStep)
            .where(JourneyTemplateStep.id == step_id)
            .where(JourneyTemplateStep.template_id == template.id)
        )
    ).scalar_one_or_none()
    if step is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Node not found.")

    if body.name is not None:
        step.name = body.name.strip()
    if body.description is not None:
        step.description = body.description.strip()
    await db.commit()
    await db.refresh(member_journey)
    return await _build_member_journey_response(member_journey, db)


# ─── PATCH /api/v1/journeys/{member_journey_id}/steps/{step_id} ───────────────


@router.patch(
    "/api/v1/journeys/{member_journey_id}/steps/{step_id}",
    response_model=MemberJourneyResponse,
    summary="Update a step's status on a member journey",
)
async def update_step_status(
    member_journey_id: uuid.UUID,
    step_id: uuid.UUID,
    body: UpdateStepStatusRequest,
    current_user=Depends(require_role("chw")),
    db: AsyncSession = Depends(get_db),
) -> MemberJourneyResponse:
    """Update a step's status on an active MemberJourney. CHW action only.

    When status='completed':
      - Records completed_at timestamp and awards points_on_completion.
      - Writes a WellnessPointsLedger row (reason='journey_step_completed').
      - Advances current_step_id to the next step in order.
      - If no next step exists, sets the MemberJourney to status='completed'
        and clears current_step_id.
      - Sets the next step's state to 'in_progress'.

    Reversal (status='upcoming' or 'in_progress' on a completed journey):
      - Only permitted when the target step itself is currently 'completed'.
      - Writes a negative WellnessPointsLedger entry (reason='correction') to
        claw back the awarded points, resets the step state, and reopens the
        journey (status='active').

    Authorization: the CHW must be the assigned chw_id on the MemberJourney.
    Returns 403 if another CHW attempts to modify this journey.
    """
    # Load the MemberJourney.
    journey_result = await db.execute(
        select(MemberJourney).where(MemberJourney.id == member_journey_id)
    )
    member_journey = journey_result.scalar_one_or_none()
    if member_journey is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Journey not found.")

    # The requesting CHW must be the one assigned to this journey.
    if member_journey.chw_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not the assigned CHW for this journey.",
        )

    # Load the specific step state BEFORE the reversal guard so the guard can
    # inspect the step's current status.
    state_result = await db.execute(
        select(MemberJourneyStepState)
        .where(MemberJourneyStepState.member_journey_id == member_journey_id)
        .where(MemberJourneyStepState.template_step_id == step_id)
    )
    step_state = state_result.scalar_one_or_none()
    if step_state is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Step not found on this journey.",
        )

    # Allow reversal of a completed journey (un-completing a step reopens it).
    # Reversal is only possible when:
    #   - the target status is 'upcoming' or 'in_progress', AND
    #   - the journey is 'completed', AND
    #   - the specific step itself is 'completed'.
    # The step-status guard prevents bypassing this check on a non-completed step
    # while the journey happens to be completed via other steps.
    # All other modifications require the journey to be in an editable state.
    is_reversal_attempt = (
        body.status in ("upcoming", "in_progress")
        and member_journey.status == "completed"
        and step_state.status == "completed"
    )
    if not is_reversal_attempt and member_journey.status not in ("active", "paused"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Cannot update steps on a journey with status '{member_journey.status}'.",
        )

    now = datetime.now(UTC)
    old_status = step_state.status

    # ── Transition matrix ──────────────────────────────────────────────────────
    #
    # completed → completed        : no-op (idempotent — don't double-award).
    # completed → upcoming|in_prog : reversal — write negative ledger entry,
    #                                 reset state, reopen journey if needed.
    # any → completed (not already): award points + ledger, advance current_step.
    # any → in_progress            : set started_at if None. No ledger.
    # any → upcoming (non-completed): no ledger action.
    # ---------------------------------------------------------------------------

    if body.status == "completed" and old_status == "completed":
        # Idempotent no-op — don't re-award points.
        pass

    elif old_status == "completed" and body.status in ("upcoming", "in_progress"):
        # Reversal: un-complete a previously completed step.
        step_state.status = body.status
        step_state.completed_at = None

        if body.notes is not None:
            step_state.notes = body.notes

        if body.status == "in_progress" and step_state.started_at is None:
            step_state.started_at = now

        # Write a negative ledger entry only if points were actually awarded.
        if step_state.points_awarded != 0:
            reversal_entry = WellnessPointsLedger(
                id=uuid.uuid4(),
                member_id=member_journey.member_id,
                points=-step_state.points_awarded,
                reason="correction",
                related_id=step_state.id,
            )
            db.add(reversal_entry)

            # Claw back the awarded points from the member's rewards_balance.
            # Clamp at 0 to avoid a negative balance in unexpected edge cases.
            profile_result = await db.execute(
                select(MemberProfile).where(
                    MemberProfile.user_id == member_journey.member_id
                )
            )
            profile = profile_result.scalar_one_or_none()
            if profile is not None:
                profile.rewards_balance = max(
                    0, profile.rewards_balance - step_state.points_awarded
                )

        step_state.points_awarded = 0

        # Reopen the journey if it was marked completed.
        if member_journey.status == "completed":
            member_journey.status = "active"
            member_journey.completed_at = None
            member_journey.current_step_id = step_state.template_step_id

    elif body.status == "completed" and old_status != "completed":
        # Award points and advance the journey.
        step_state.status = "completed"
        step_state.completed_at = now
        if step_state.started_at is None:
            step_state.started_at = now

        if body.notes is not None:
            step_state.notes = body.notes

        # Load the template step to get points_on_completion.
        tpl_step_result = await db.execute(
            select(JourneyTemplateStep).where(JourneyTemplateStep.id == step_id)
        )
        tpl_step = tpl_step_result.scalar_one_or_none()
        if tpl_step is None:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Journey template step configuration is missing; cannot complete step.",
            )
        step_state.points_awarded = tpl_step.points_on_completion

        # Write append-only ledger entry.
        ledger_entry = WellnessPointsLedger(
            id=uuid.uuid4(),
            member_id=member_journey.member_id,
            points=tpl_step.points_on_completion,
            reason="journey_step_completed",
            related_id=step_state.id,
        )
        db.add(ledger_entry)

        # Credit the member's rewards_balance so the balance endpoint reflects
        # this award. The ledger is append-only; rewards_balance is the live total.
        if tpl_step.points_on_completion != 0:
            award_profile_result = await db.execute(
                select(MemberProfile).where(
                    MemberProfile.user_id == member_journey.member_id
                )
            )
            award_profile = award_profile_result.scalar_one_or_none()
            if award_profile is not None:
                award_profile.rewards_balance += tpl_step.points_on_completion

        # Advance current_step_id to the next step in template order.
        all_states_result = await db.execute(
            select(MemberJourneyStepState, JourneyTemplateStep)
            .join(
                JourneyTemplateStep,
                MemberJourneyStepState.template_step_id == JourneyTemplateStep.id,
            )
            .where(MemberJourneyStepState.member_journey_id == member_journey_id)
            .order_by(JourneyTemplateStep.order)
        )
        all_rows = all_states_result.all()

        # Find the index of the completed step, then get the next one.
        completed_index: int | None = None
        for idx, (state, _ts) in enumerate(all_rows):
            if state.template_step_id == step_id:
                completed_index = idx
                break

        if completed_index is None:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Journey step state is inconsistent; cannot advance journey.",
            )

        if completed_index + 1 < len(all_rows):
            next_state, next_tpl_step = all_rows[completed_index + 1]
            member_journey.current_step_id = next_tpl_step.id
            # Advance the next step to in_progress if it is still upcoming.
            if next_state.status == "upcoming":
                next_state.status = "in_progress"
                next_state.started_at = now
        else:
            # All steps done — complete the journey.
            member_journey.status = "completed"
            member_journey.completed_at = now
            member_journey.current_step_id = None

    else:
        # any → in_progress or any → upcoming (non-reversal paths).
        step_state.status = body.status

        if body.notes is not None:
            step_state.notes = body.notes

        if body.status == "in_progress" and step_state.started_at is None:
            step_state.started_at = now

    # ── Persist and return ────────────────────────────────────────────────────
    # progress_percent is computed dynamically by _build_member_journey_response
    # from the current step states — no column update needed.
    await db.commit()
    await db.refresh(member_journey)

    return await _build_member_journey_response(member_journey, db)


# ─── DELETE /api/v1/journeys/{member_journey_id}/nodes/{step_id} ─────────────


@router.delete(
    "/api/v1/journeys/{member_journey_id}/nodes/{step_id}",
    response_model=MemberJourneyResponse,
    summary="Remove a node from a custom journey",
)
async def delete_journey_node(
    member_journey_id: uuid.UUID,
    step_id: uuid.UUID,
    current_user=Depends(require_role("chw")),
    db: AsyncSession = Depends(get_db),
) -> MemberJourneyResponse:
    """Remove a node (step) from a custom (CHW-authored) journey.

    Behavior:
      1. Auth gate: same as POST/PATCH nodes — only the assigned CHW (or admin)
         may delete; otherwise 403. Custom-journey-only guard raises 409 for
         standard templates.
      2. Step must exist on this journey; otherwise 404.
      3. Last-step guard: if the step is the ONLY remaining step in the journey
         the delete is rejected with 400. An empty journey has no meaningful
         current_step_id and would be permanently stuck. The CHW must first add
         a replacement step before removing the last one.
      4. Points reversal: if the deleted step was ``completed`` and had awarded
         points, a negative WellnessPointsLedger entry (reason='correction') is
         written — identical to the un-complete path in update_step_status.
         ``step_state.points_awarded`` is used so the reversal matches exactly
         what was recorded, not the template value.
      5. The MemberJourneyStepState row is deleted. The underlying
         JourneyTemplateStep row is also deleted (custom journeys own their
         template exclusively).
      6. Reorder: all remaining steps on the same template with order >
         deleted_step.order have their order decremented by 1, keeping the
         sequence contiguous (mirror of the +1 shift in add_journey_node).
      7. If the deleted step was the journey's current_step_id, current_step_id
         is advanced to the next step in order (or set to None if none remain,
         which cannot happen because the last-step guard prevents deleting the
         final step).

    Returns the updated MemberJourneyResponse (200) so the frontend can refetch
    the same shape as POST/PATCH nodes.
    """
    member_journey, template = await _load_journey_for_chw(
        member_journey_id, current_user, db
    )
    member_journey, template, step_id_map = await fork_member_journey_to_private(
        db, member_journey, template
    )
    # If a fork just happened, the caller's step_id refers to the OLD template's
    # step. Remap it to the newly cloned step so the rest of the delete logic
    # resolves correctly against the new template.
    if step_id_map:
        step_id = step_id_map.get(step_id, step_id)

    # ── Locate the template step ────────────────────────────────────────────────
    tpl_step_result = await db.execute(
        select(JourneyTemplateStep)
        .where(JourneyTemplateStep.id == step_id)
        .where(JourneyTemplateStep.template_id == template.id)
    )
    tpl_step = tpl_step_result.scalar_one_or_none()
    if tpl_step is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Node not found on this journey.",
        )

    # ── Locate the step state ───────────────────────────────────────────────────
    step_state_result = await db.execute(
        select(MemberJourneyStepState)
        .where(MemberJourneyStepState.member_journey_id == member_journey_id)
        .where(MemberJourneyStepState.template_step_id == step_id)
    )
    step_state = step_state_result.scalar_one_or_none()
    if step_state is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Step state not found on this journey.",
        )

    # ── Last-step guard ─────────────────────────────────────────────────────────
    # Count remaining steps on the template so we can block deletion of the last.
    step_count_result = await db.execute(
        select(func.count()).where(JourneyTemplateStep.template_id == template.id)
    )
    step_count = step_count_result.scalar() or 0
    if step_count <= 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Cannot delete the last remaining step. "
                "Add a replacement step before removing this one."
            ),
        )

    # ── Points reversal (mirror of update_step_status reversal branch) ──────────
    if step_state.status == "completed" and step_state.points_awarded != 0:
        reversal_entry = WellnessPointsLedger(
            id=uuid.uuid4(),
            member_id=member_journey.member_id,
            points=-step_state.points_awarded,
            reason="correction",
            related_id=step_state.id,
        )
        db.add(reversal_entry)

    # ── Advance current_step_id if deleting the current step ───────────────────
    # Find the next step (by order) before we delete so we can point to it.
    if member_journey.current_step_id == step_id:
        next_step_result = await db.execute(
            select(JourneyTemplateStep)
            .where(JourneyTemplateStep.template_id == template.id)
            .where(JourneyTemplateStep.order > tpl_step.order)
            .order_by(JourneyTemplateStep.order)
            .limit(1)
        )
        next_step = next_step_result.scalar_one_or_none()
        if next_step is not None:
            member_journey.current_step_id = next_step.id
        else:
            # No later step — point to the highest-order remaining step instead
            # (this case is blocked by last-step guard when count==1, but can
            # occur when deleting the last step when count==2 and it's current).
            prev_step_result = await db.execute(
                select(JourneyTemplateStep)
                .where(JourneyTemplateStep.template_id == template.id)
                .where(JourneyTemplateStep.order < tpl_step.order)
                .order_by(JourneyTemplateStep.order.desc())
                .limit(1)
            )
            prev_step = prev_step_result.scalar_one_or_none()
            member_journey.current_step_id = prev_step.id if prev_step else None

    deleted_order: int = tpl_step.order

    # ── Delete step state and template step ────────────────────────────────────
    await db.delete(step_state)
    await db.flush()
    await db.delete(tpl_step)
    await db.flush()

    # ── Reorder: decrement order for all steps after the deleted position ───────
    await db.execute(
        update(JourneyTemplateStep)
        .where(JourneyTemplateStep.template_id == template.id)
        .where(JourneyTemplateStep.order > deleted_order)
        .values(order=JourneyTemplateStep.order - 1)
    )

    await db.commit()
    await db.refresh(member_journey)
    return await _build_member_journey_response(member_journey, db)


# ─── GET /api/v1/members/{member_id}/wellness-points ──────────────────────────


@router.get(
    "/api/v1/members/{member_id}/wellness-points",
    response_model=WellnessPointsSummary,
    summary="Member's wellness-points balance and ledger",
)
async def get_wellness_points(
    member_id: uuid.UUID,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> WellnessPointsSummary:
    """Return the member's total wellness-points balance and the last 50 ledger
    entries, most recent first.

    Authorization:
      - CHW callers: must have an active relationship with the member.
      - Member callers: can only read their own points.
    """
    if current_user.role == "chw":
        await _assert_chw_member_relationship(current_user.id, member_id, db)
    elif current_user.role == "member":
        if current_user.id != member_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You can only view your own wellness points.",
            )
    # Admin passes through.

    total_result = await db.execute(
        select(func.coalesce(func.sum(WellnessPointsLedger.points), 0))
        .where(WellnessPointsLedger.member_id == member_id)
    )
    total_points = int(total_result.scalar() or 0)

    ledger_result = await db.execute(
        select(WellnessPointsLedger)
        .where(WellnessPointsLedger.member_id == member_id)
        .order_by(WellnessPointsLedger.created_at.desc())
        .limit(50)
    )
    ledger_entries = ledger_result.scalars().all()

    return WellnessPointsSummary(
        total_points=total_points,
        ledger=[WellnessLedgerEntry.model_validate(e) for e in ledger_entries],
    )

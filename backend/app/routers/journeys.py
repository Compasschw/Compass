"""Journeys router — gamified care pathways.

Endpoint summary:
  GET    /api/v1/journeys/templates
  GET    /api/v1/chw/journeys
  GET    /api/v1/members/{member_id}/journeys
  POST   /api/v1/members/{member_id}/journeys
  PATCH  /api/v1/journeys/{member_journey_id}/steps/{step_id}
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
from sqlalchemy import func, select
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
from app.schemas.journeys import (
    CaseloadJourneyItem,
    CreateMemberJourneyRequest,
    JourneyStepResponse,
    JourneyTemplateResponse,
    MemberJourneyResponse,
    MemberJourneyStepResponse,
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

    # Load the ordered template steps.
    steps_result = await db.execute(
        select(JourneyTemplateStep)
        .where(JourneyTemplateStep.template_id == template.id)
        .order_by(JourneyTemplateStep.order)
    )
    template_steps = steps_result.scalars().all()
    if not template_steps:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Journey template has no steps configured.",
        )

    first_step = template_steps[0]
    now = datetime.now(UTC)

    # Create the MemberJourney row.
    member_journey = MemberJourney(
        id=uuid.uuid4(),
        member_id=member_id,
        template_id=template.id,
        chw_id=current_user.id,
        status="active",
        started_at=now,
        current_step_id=first_step.id,
    )
    db.add(member_journey)
    await db.flush()

    # Initialize step states: step 1 = in_progress, rest = upcoming.
    for i, tpl_step in enumerate(template_steps):
        step_status = "in_progress" if i == 0 else "upcoming"
        step_state = MemberJourneyStepState(
            id=uuid.uuid4(),
            member_journey_id=member_journey.id,
            template_step_id=tpl_step.id,
            status=step_status,
            started_at=now if i == 0 else None,
        )
        db.add(step_state)

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

    if member_journey.status not in ("active", "paused"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Cannot update steps on a journey with status '{member_journey.status}'.",
        )

    # Load the specific step state.
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

    now = datetime.now(UTC)
    old_status = step_state.status

    # Apply the status update.
    step_state.status = body.status
    if body.notes is not None:
        step_state.notes = body.notes
    if body.status == "in_progress" and step_state.started_at is None:
        step_state.started_at = now

    if body.status == "completed" and old_status != "completed":
        step_state.completed_at = now

        # Load the template step to get points_on_completion.
        tpl_step_result = await db.execute(
            select(JourneyTemplateStep).where(JourneyTemplateStep.id == step_id)
        )
        tpl_step = tpl_step_result.scalar_one_or_none()
        if tpl_step is not None:
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

        if completed_index is not None and completed_index + 1 < len(all_rows):
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

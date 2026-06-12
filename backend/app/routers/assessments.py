"""Assessment engine API router.

Endpoints
---------
GET  /api/v1/assessment-templates/{template_id}
    Return a template's question list (questions, sections, metadata).
    Public to any authenticated user — templates contain no PHI.

POST /api/v1/sessions/{session_id}/assessments
    Start a new assessment for the session's member using the given template.
    Idempotent: if an in_progress assessment already exists for this
    template + member, returns the existing one (HTTP 200) rather than
    creating a duplicate. If a fresh one is created, returns HTTP 201.
    Auth: CHW who owns the session, or admin.

POST /api/v1/assessments/{assessment_id}/responses
    Append a single response row. Per-answer persistence — each call
    saves exactly one answer. Multiple responses to the same question_id
    are allowed (creates new rows, not updates). ``captured_at`` defaults
    to server UTC if not provided.
    Auth: CHW who owns the assessment, or admin.

POST /api/v1/assessments/{assessment_id}/complete
    Transition status → completed and stamp completed_at.
    Auth: CHW who owns the assessment, or admin.

POST /api/v1/assessments/{assessment_id}/abandon
    Transition status → abandoned (CHW paused and won't resume).
    Auth: CHW who owns the assessment, or admin.

GET  /api/v1/chw/members/{member_id}/assessments/latest
    Return the most recent *completed* assessment for a member,
    with all responses included. Used by the Member Profile screen.
    Auth: any CHW, or admin (CHW must be on a session with the member
    or be admin — enforced below).

Auth pattern: CHW must own the session (for session-scoped endpoints) or
own the assessment (for assessment-scoped endpoints). Admin API key bypasses
all role/ownership checks. Members never access assessment data directly.
"""

import logging
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.assessment import MemberAssessment, MemberAssessmentResponse
from app.models.session import Session
from app.schemas.assessment import (
    AssessmentOut,
    AssessmentResponseCreate,
    AssessmentResponseOut,
    AssessmentStartRequest,
)
from app.services.assessment_templates import get_template

logger = logging.getLogger("compass.assessments")

router = APIRouter(tags=["assessments"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _assert_chw_or_admin(current_user) -> None:
    """Raise 403 if the caller is not a CHW or admin."""
    if current_user.role not in ("chw", "admin"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only CHW users or admins may access assessments.",
        )


async def _get_assessment_and_assert_ownership(
    assessment_id: UUID,
    current_user,
    db: AsyncSession,
) -> MemberAssessment:
    """Fetch the assessment and verify the caller is its CHW or an admin.

    Raises 404 if not found, 403 if the caller does not own it.
    """
    assessment = await db.get(MemberAssessment, assessment_id)
    if not assessment:
        raise HTTPException(status_code=404, detail="Assessment not found.")
    if current_user.role != "admin" and assessment.chw_id != current_user.id:
        raise HTTPException(
            status_code=403,
            detail="You are not the CHW on this assessment.",
        )
    return assessment


async def _assert_session_chw(
    session_id: UUID,
    current_user,
    db: AsyncSession,
) -> Session:
    """Return the session if the caller is its CHW or admin. Raise otherwise."""
    session = await db.get(Session, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found.")
    if current_user.role != "admin" and session.chw_id != current_user.id:
        raise HTTPException(
            status_code=403,
            detail="Only the CHW on this session may start an assessment.",
        )
    return session


async def _load_responses(
    assessment_id: UUID,
    db: AsyncSession,
) -> list[MemberAssessmentResponse]:
    """Return all response rows for an assessment, ordered by captured_at."""
    result = await db.execute(
        select(MemberAssessmentResponse)
        .where(MemberAssessmentResponse.assessment_id == assessment_id)
        .order_by(MemberAssessmentResponse.captured_at.asc())
    )
    return list(result.scalars().all())


def _assessment_to_out(
    assessment: MemberAssessment,
    responses: list[MemberAssessmentResponse] | None = None,
) -> AssessmentOut:
    """Convert ORM rows to the response schema."""
    return AssessmentOut(
        id=assessment.id,
        member_id=assessment.member_id,
        session_id=assessment.session_id,
        template_id=assessment.template_id,
        chw_id=assessment.chw_id,
        status=assessment.status,
        created_at=assessment.created_at,
        completed_at=assessment.completed_at,
        responses=[
            AssessmentResponseOut.model_validate(r) for r in (responses or [])
        ],
    )


# ---------------------------------------------------------------------------
# Template endpoint
# ---------------------------------------------------------------------------


@router.get(
    "/api/v1/assessment-templates/{template_id}",
    summary="Fetch a questionnaire template by ID",
    description=(
        "Returns the full template definition including sections, questions, "
        "options, and metadata. Templates contain no PHI. "
        "Valid IDs: 'compass_member_v1', 'compass_intro_script_v1'."
    ),
)
async def get_assessment_template(
    template_id: str,
    current_user=Depends(get_current_user),
) -> dict:
    """GET /api/v1/assessment-templates/{template_id}

    Returns the raw template dict. Any authenticated user may call this;
    the response contains no member data.
    """
    template = get_template(template_id)
    if template is None:
        raise HTTPException(
            status_code=404,
            detail=f"Template '{template_id}' not found. "
            "Check /api/v1/assessment-templates for valid IDs.",
        )
    return template


# ---------------------------------------------------------------------------
# Session-scoped: start assessment
# ---------------------------------------------------------------------------


@router.post(
    "/api/v1/sessions/{session_id}/assessments",
    summary="Start a new assessment for a session's member",
    description=(
        "Idempotent: if an in_progress assessment already exists for this "
        "template + member combination, the existing assessment is returned "
        "(HTTP 200). A new assessment is created and returned as HTTP 201. "
        "Body: {\"template_id\": \"compass_member_v1\"}."
    ),
    status_code=201,
    response_model=AssessmentOut,
)
async def start_assessment(
    session_id: UUID,
    data: AssessmentStartRequest,
    request: Request,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> AssessmentOut | JSONResponse:
    """POST /api/v1/sessions/{session_id}/assessments

    Idempotency rule: one in_progress assessment per (member_id, template_id).
    If a completed assessment exists but an in_progress one does not, a fresh
    assessment row is created — re-assessment is intentional and supported.
    """
    _assert_chw_or_admin(current_user)

    # Validate template exists before touching the DB.
    template = get_template(data.template_id)
    if template is None:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown template '{data.template_id}'.",
        )

    session = await _assert_session_chw(session_id, current_user, db)

    # Idempotency: return any in_progress assessment for this member+template.
    existing_result = await db.execute(
        select(MemberAssessment).where(
            MemberAssessment.member_id == session.member_id,
            MemberAssessment.template_id == data.template_id,
            MemberAssessment.status == "in_progress",
        )
    )
    existing = existing_result.scalar_one_or_none()
    if existing is not None:
        logger.info(
            "assessment idempotent return: assessment=%s member=%s template=%s",
            existing.id, session.member_id, data.template_id,
        )
        # Return existing with HTTP 200 to signal idempotent return.
        responses = await _load_responses(existing.id, db)
        out = _assessment_to_out(existing, responses)
        return JSONResponse(
            content=out.model_dump(mode="json"),
            status_code=200,
        )

    assessment = MemberAssessment(
        member_id=session.member_id,
        session_id=session_id,
        template_id=data.template_id,
        chw_id=current_user.id,
        status="in_progress",
    )
    db.add(assessment)
    await db.commit()
    await db.refresh(assessment)

    logger.info(
        "assessment created: assessment=%s session=%s member=%s template=%s chw=%s",
        assessment.id, session_id, session.member_id, data.template_id, current_user.id,
    )
    return _assessment_to_out(assessment)


# ---------------------------------------------------------------------------
# Assessment-scoped: append a response
# ---------------------------------------------------------------------------


@router.post(
    "/api/v1/assessments/{assessment_id}/responses",
    summary="Append a single answer to an in-progress assessment",
    description=(
        "Per-answer persistence — each call creates exactly one response row. "
        "Multiple responses to the same question_id are permitted (re-assessment); "
        "they create new rows, never updates. "
        "captured_at defaults to server UTC if not provided by the client."
    ),
    status_code=201,
    response_model=AssessmentResponseOut,
)
async def append_response(
    assessment_id: UUID,
    data: AssessmentResponseCreate,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> AssessmentResponseOut:
    """POST /api/v1/assessments/{assessment_id}/responses

    Validates:
    - Assessment exists and is in_progress (cannot append to completed/abandoned).
    - Caller is the CHW on the assessment or admin.
    - Stamps captured_at to server UTC if client did not provide it.
    """
    _assert_chw_or_admin(current_user)
    assessment = await _get_assessment_and_assert_ownership(
        assessment_id, current_user, db
    )

    if assessment.status != "in_progress":
        raise HTTPException(
            status_code=409,
            detail=(
                f"Cannot append responses to an assessment with status "
                f"'{assessment.status}'. Assessment must be in_progress."
            ),
        )

    captured_at = data.captured_at or datetime.now(UTC)

    response_row = MemberAssessmentResponse(
        assessment_id=assessment_id,
        question_id=data.question_id,
        question_text=data.question_text,
        answer_value=data.answer_value,
        answer_label=data.answer_label,
        category=data.category,
        subcategory=data.subcategory,
        tags=data.tags,
        captured_at=captured_at,
        captured_by_chw_id=current_user.id,
    )
    db.add(response_row)
    await db.commit()
    await db.refresh(response_row)

    logger.info(
        "assessment response saved: assessment=%s question=%s captured_at=%s",
        assessment_id, data.question_id, captured_at.isoformat(),
    )
    return AssessmentResponseOut.model_validate(response_row)


# ---------------------------------------------------------------------------
# Assessment-scoped: lifecycle transitions
# ---------------------------------------------------------------------------


@router.post(
    "/api/v1/assessments/{assessment_id}/complete",
    summary="Mark an assessment as completed",
    description="Transitions status to 'completed' and stamps completed_at.",
    response_model=AssessmentOut,
)
async def complete_assessment(
    assessment_id: UUID,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> AssessmentOut:
    """POST /api/v1/assessments/{assessment_id}/complete

    Only valid when status == in_progress. Returns 409 otherwise.
    """
    _assert_chw_or_admin(current_user)
    assessment = await _get_assessment_and_assert_ownership(
        assessment_id, current_user, db
    )

    if assessment.status != "in_progress":
        raise HTTPException(
            status_code=409,
            detail=(
                f"Cannot complete an assessment with status '{assessment.status}'. "
                "Must be in_progress."
            ),
        )

    assessment.status = "completed"
    assessment.completed_at = datetime.now(UTC)
    await db.commit()
    await db.refresh(assessment)

    responses = await _load_responses(assessment_id, db)
    logger.info(
        "assessment completed: assessment=%s responses=%d", assessment_id, len(responses)
    )
    return _assessment_to_out(assessment, responses)


@router.post(
    "/api/v1/assessments/{assessment_id}/abandon",
    summary="Mark an assessment as abandoned",
    description=(
        "Transitions status to 'abandoned'. Used when the CHW pauses and "
        "does not intend to resume. The assessment row is preserved for audit."
    ),
    response_model=AssessmentOut,
)
async def abandon_assessment(
    assessment_id: UUID,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> AssessmentOut:
    """POST /api/v1/assessments/{assessment_id}/abandon

    Only valid when status == in_progress. Returns 409 otherwise.
    """
    _assert_chw_or_admin(current_user)
    assessment = await _get_assessment_and_assert_ownership(
        assessment_id, current_user, db
    )

    if assessment.status != "in_progress":
        raise HTTPException(
            status_code=409,
            detail=(
                f"Cannot abandon an assessment with status '{assessment.status}'. "
                "Must be in_progress."
            ),
        )

    assessment.status = "abandoned"
    await db.commit()
    await db.refresh(assessment)

    responses = await _load_responses(assessment_id, db)
    logger.info("assessment abandoned: assessment=%s", assessment_id)
    return _assessment_to_out(assessment, responses)


# ---------------------------------------------------------------------------
# CHW member view: latest completed assessment
# ---------------------------------------------------------------------------


@router.get(
    "/api/v1/chw/members/{member_id}/assessments/latest",
    summary="Get the latest completed assessment for a member",
    description=(
        "Returns the most recently completed assessment for the given member, "
        "including all response rows. Used by the Member Profile screen. "
        "Auth: any CHW, or admin. Members never access this endpoint."
    ),
    response_model=AssessmentOut,
)
async def get_latest_member_assessment(
    member_id: UUID,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> AssessmentOut:
    """GET /api/v1/chw/members/{member_id}/assessments/latest

    Returns the most recent completed assessment for ``member_id``.
    Returns 404 if no completed assessment exists for this member.

    Auth: CHW with a shared session, or admin.  Role-only checks are
    insufficient — any CHW would otherwise be able to read any member's
    assessment PHI without a care relationship.  Members do not access
    their own assessment data directly.
    """
    _assert_chw_or_admin(current_user)

    # Finding #5 (CRITICAL): enforce CHW ↔ member relationship gate.
    # Admins bypass this check — they can access any member's data.
    if current_user.role != "admin":
        from app.services.relationship_guards import assert_shared_session
        await assert_shared_session(db, chw_id=current_user.id, member_id=member_id)

    result = await db.execute(
        select(MemberAssessment)
        .where(
            MemberAssessment.member_id == member_id,
            MemberAssessment.status == "completed",
        )
        .order_by(MemberAssessment.completed_at.desc())
        .limit(1)
    )
    assessment = result.scalar_one_or_none()
    if assessment is None:
        raise HTTPException(
            status_code=404,
            detail="No completed assessment found for this member.",
        )

    responses = await _load_responses(assessment.id, db)
    logger.info(
        "latest assessment fetched: assessment=%s member=%s responses=%d by_chw=%s",
        assessment.id, member_id, len(responses), current_user.id,
    )
    return _assessment_to_out(assessment, responses)

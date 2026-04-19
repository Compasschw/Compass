from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.billing import BillingClaim
from app.models.request import ServiceRequest
from app.models.session import MemberConsent, Session, SessionDocumentation
from app.schemas.session import ConsentSubmit, SessionCreate, SessionDocumentationSubmit, SessionResponse
from app.services.billing_service import calculate_earnings, calculate_units, check_unit_caps, validate_claim

router = APIRouter(prefix="/api/v1/sessions", tags=["sessions"])


@router.get("/", response_model=list[SessionResponse])
async def list_sessions(current_user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    from sqlalchemy.orm import aliased

    from app.models.user import User
    CHWUser = aliased(User)
    MemberUser = aliased(User)
    stmt = (
        select(Session, CHWUser.name, MemberUser.name)
        .join(CHWUser, Session.chw_id == CHWUser.id)
        .join(MemberUser, Session.member_id == MemberUser.id)
        .order_by(Session.created_at.desc())
    )
    if current_user.role == "chw":
        stmt = stmt.where(Session.chw_id == current_user.id)
    else:
        stmt = stmt.where(Session.member_id == current_user.id)
    result = await db.execute(stmt)
    rows = result.all()
    return [
        SessionResponse.model_validate({**s.__dict__, "chw_name": chw_name, "member_name": member_name})
        for s, chw_name, member_name in rows
    ]


@router.post("/", response_model=SessionResponse, status_code=201)
async def create_session(data: SessionCreate, current_user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    req = await db.get(ServiceRequest, data.request_id)
    if not req:
        raise HTTPException(status_code=404, detail="Request not found")

    if current_user.role == "chw":
        chw_id = current_user.id
        member_id = req.member_id
    elif req.matched_chw_id:
        if req.member_id != current_user.id:
            raise HTTPException(status_code=403, detail="You can only create sessions for your own requests")
        chw_id = req.matched_chw_id
        member_id = current_user.id
    else:
        raise HTTPException(status_code=400, detail="Request has no matched CHW")

    session = Session(
        request_id=data.request_id,
        chw_id=chw_id,
        member_id=member_id,
        vertical=req.vertical,
        mode=data.mode.value,
        scheduled_at=data.scheduled_at,
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)
    return session


@router.get("/{session_id}", response_model=SessionResponse)
async def get_session(session_id: UUID, current_user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    session = await db.get(Session, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.chw_id != current_user.id and session.member_id != current_user.id and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Not authorized")
    return session


@router.patch("/{session_id}/start", response_model=SessionResponse)
async def start_session(session_id: UUID, current_user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    session = await db.get(Session, session_id)
    if not session or session.chw_id != current_user.id:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.status != "scheduled":
        raise HTTPException(status_code=409, detail=f"Cannot start session with status '{session.status}'. Must be 'scheduled'.")
    session.status = "in_progress"
    session.started_at = datetime.now(UTC)

    # Create masked communication session (provider-agnostic)
    from app.models.communication import CommunicationSession
    from app.services.communication import get_provider
    try:
        provider = get_provider()
        proxy = await provider.create_proxy_session(
            session_id=str(session_id),
            chw_phone="",  # TODO: pull from User/CHWProfile phone field
            member_phone="",  # TODO: pull from User/MemberProfile phone field
        )
        comm_session = CommunicationSession(
            session_id=session_id,
            provider=proxy.provider,
            provider_session_id=proxy.provider_session_id,
            proxy_number=proxy.proxy_number,
        )
        db.add(comm_session)
    except Exception as e:
        import logging
        logging.getLogger("compass").warning("Failed to create communication session: %s", e)

    await db.commit()
    await db.refresh(session)
    return session


@router.patch("/{session_id}/complete", response_model=SessionResponse)
async def complete_session(session_id: UUID, current_user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    session = await db.get(Session, session_id)
    if not session or session.chw_id != current_user.id:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.status != "in_progress":
        raise HTTPException(status_code=409, detail=f"Cannot complete session with status '{session.status}'. Must be 'in_progress'.")
    session.status = "completed"
    session.ended_at = datetime.now(UTC)
    if session.started_at:
        session.duration_minutes = int((session.ended_at - session.started_at).total_seconds() / 60)
        session.suggested_units = calculate_units(session.duration_minutes)

    # Close communication session + retrieve recording/transcript
    from app.models.communication import CommunicationSession
    from app.services.communication import get_provider
    try:
        comm_result = await db.execute(
            select(CommunicationSession)
            .where(CommunicationSession.session_id == session_id)
            .where(CommunicationSession.status == "active")
        )
        comm_session = comm_result.scalar_one_or_none()
        if comm_session:
            provider = get_provider()
            await provider.end_proxy_session(comm_session.provider_session_id)

            recording = await provider.get_recording(comm_session.provider_session_id)
            if recording:
                comm_session.recording_url = recording.recording_url
                comm_session.recording_duration_seconds = recording.duration_seconds
                comm_session.provider_recording_id = recording.provider_recording_id

                transcript = await provider.get_transcript(recording.recording_url)
                if transcript:
                    comm_session.transcript_text = transcript.text
                    comm_session.transcript_confidence = transcript.confidence

            comm_session.status = "closed"
            comm_session.closed_at = datetime.now(UTC)
    except Exception as e:
        import logging
        logging.getLogger("compass").warning("Failed to close communication session: %s", e)

    await db.commit()
    await db.refresh(session)
    return session


@router.post("/{session_id}/documentation")
async def submit_documentation(session_id: UUID, data: SessionDocumentationSubmit, current_user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    session = await db.get(Session, session_id)
    if not session or session.chw_id != current_user.id:
        raise HTTPException(status_code=404, detail="Session not found")

    existing = await db.execute(select(SessionDocumentation).where(SessionDocumentation.session_id == session_id))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Documentation already submitted for this session")

    errors = validate_claim(data.diagnosis_codes, data.procedure_code, data.units_to_bill)
    if errors:
        raise HTTPException(status_code=422, detail=errors)

    session_date = (session.started_at or session.created_at).date()
    caps = await check_unit_caps(db, session.chw_id, session.member_id, session_date)
    if data.units_to_bill > caps["daily_remaining"]:
        raise HTTPException(status_code=422, detail=f"Daily unit cap exceeded. {caps['daily_remaining']} units remaining today.")
    if data.units_to_bill > caps["yearly_remaining"]:
        raise HTTPException(status_code=422, detail=f"Yearly unit cap exceeded. {caps['yearly_remaining']} units remaining this year.")

    doc = SessionDocumentation(
        session_id=session_id, summary=data.summary, resources_referred=data.resources_referred,
        member_goals=data.member_goals, follow_up_needed=data.follow_up_needed,
        follow_up_date=data.follow_up_date, diagnosis_codes=data.diagnosis_codes,
        procedure_code=data.procedure_code, units_to_bill=data.units_to_bill,
    )
    db.add(doc)

    earnings = calculate_earnings(data.units_to_bill)
    claim = BillingClaim(
        session_id=session_id, chw_id=session.chw_id, member_id=session.member_id,
        diagnosis_codes=data.diagnosis_codes, procedure_code=data.procedure_code,
        units=data.units_to_bill, gross_amount=earnings["gross"],
        platform_fee=earnings["platform_fee"], pear_suite_fee=earnings["pear_suite_fee"],
        net_payout=earnings["net"],
    )
    db.add(claim)

    session.units_billed = data.units_to_bill
    session.gross_amount = earnings["gross"]
    session.net_amount = earnings["net"]
    await db.commit()
    return {"documentation_id": str(doc.id), "claim_id": str(claim.id), "earnings": earnings}


@router.post("/{session_id}/consent")
async def submit_consent(session_id: UUID, data: ConsentSubmit, request: Request, current_user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    session = await db.get(Session, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.member_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only the session member can submit consent")

    consent = MemberConsent(
        session_id=session_id, member_id=current_user.id,
        consent_type=data.consent_type, typed_signature=data.typed_signature,
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
    )
    db.add(consent)
    await db.commit()
    return {"consent_id": str(consent.id)}

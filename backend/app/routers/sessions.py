from uuid import UUID
from datetime import datetime, timezone, date
from typing import Annotated
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.database import get_db
from app.dependencies import get_current_user
from app.models.session import Session, SessionDocumentation, MemberConsent
from app.models.request import ServiceRequest
from app.models.billing import BillingClaim
from app.schemas.session import SessionCreate, SessionResponse, SessionDocumentationSubmit, ConsentSubmit
from app.services.billing_service import validate_claim, calculate_earnings, check_unit_caps

router = APIRouter(prefix="/api/v1/sessions", tags=["sessions"])


@router.get("/", response_model=list[SessionResponse])
async def list_sessions(current_user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    if current_user.role == "chw":
        result = await db.execute(select(Session).where(Session.chw_id == current_user.id).order_by(Session.created_at.desc()))
    else:
        result = await db.execute(select(Session).where(Session.member_id == current_user.id).order_by(Session.created_at.desc()))
    return result.scalars().all()


@router.post("/", response_model=SessionResponse, status_code=201)
async def create_session(data: SessionCreate, current_user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    req = await db.get(ServiceRequest, data.request_id)
    if not req:
        raise HTTPException(status_code=404, detail="Request not found")

    if current_user.role == "chw":
        chw_id = current_user.id
        member_id = req.member_id
    elif req.matched_chw_id:
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
    session.started_at = datetime.now(timezone.utc)
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
    session.ended_at = datetime.now(timezone.utc)
    if session.started_at:
        session.duration_minutes = int((session.ended_at - session.started_at).total_seconds() / 60)
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
async def submit_consent(session_id: UUID, data: ConsentSubmit, current_user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    session = await db.get(Session, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.member_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only the session member can submit consent")

    consent = MemberConsent(
        session_id=session_id, member_id=current_user.id,
        consent_type=data.consent_type, typed_signature=data.typed_signature,
    )
    db.add(consent)
    await db.commit()
    return {"consent_id": str(consent.id)}

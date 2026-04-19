from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user, require_role
from app.schemas.request import (
    ServiceRequestCreate,
    ServiceRequestResponse,
    ServiceRequestSummaryResponse,
)

router = APIRouter(prefix="/api/v1/requests", tags=["requests"])


@router.get("/", response_model=list[ServiceRequestSummaryResponse] | list[ServiceRequestResponse])
async def list_requests(current_user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """List service requests.

    - CHWs see an anonymized summary of all open requests (no description, no member name).
      They must accept a request to see the full details. This enforces HIPAA's minimum
      necessary access standard (45 CFR §164.514(d)).
    - Members see their own requests with full details.
    """
    from app.models.request import ServiceRequest
    from app.models.user import User
    if current_user.role == "chw":
        stmt = (
            select(ServiceRequest)
            .where(ServiceRequest.status == "open")
            .order_by(ServiceRequest.created_at.desc())
        )
        result = await db.execute(stmt)
        requests = result.scalars().all()
        return [ServiceRequestSummaryResponse.model_validate(r) for r in requests]

    # Member view — full details on their own requests
    stmt = (
        select(ServiceRequest, User.name)
        .join(User, ServiceRequest.member_id == User.id)
        .where(ServiceRequest.member_id == current_user.id)
        .order_by(ServiceRequest.created_at.desc())
    )
    result = await db.execute(stmt)
    rows = result.all()
    return [ServiceRequestResponse.model_validate({**req.__dict__, "member_name": name}) for req, name in rows]


@router.get("/{request_id}", response_model=ServiceRequestResponse)
async def get_request(
    request_id: UUID,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Full request detail — only visible to the request's member, its matched CHW, or admin."""
    from app.models.request import ServiceRequest
    from app.models.user import User
    stmt = (
        select(ServiceRequest, User.name)
        .join(User, ServiceRequest.member_id == User.id)
        .where(ServiceRequest.id == request_id)
    )
    result = await db.execute(stmt)
    row = result.first()
    if row is None:
        raise HTTPException(status_code=404, detail="Request not found")

    req, member_name = row
    is_owner = req.member_id == current_user.id
    is_matched_chw = req.matched_chw_id == current_user.id
    is_admin = current_user.role == "admin"
    if not (is_owner or is_matched_chw or is_admin):
        raise HTTPException(status_code=403, detail="Not authorized to view this request")

    return ServiceRequestResponse.model_validate({**req.__dict__, "member_name": member_name})

@router.post("/", response_model=ServiceRequestResponse, status_code=201)
async def create_request(data: ServiceRequestCreate, current_user=Depends(require_role("member")), db: AsyncSession = Depends(get_db)):
    from app.models.request import ServiceRequest
    req = ServiceRequest(member_id=current_user.id, vertical=data.vertical.value, urgency=data.urgency.value, description=data.description, preferred_mode=data.preferred_mode.value, estimated_units=data.estimated_units)
    db.add(req)
    await db.commit()
    await db.refresh(req)
    return req

@router.patch("/{request_id}/accept")
async def accept_request(request_id: UUID, current_user=Depends(require_role("chw")), db: AsyncSession = Depends(get_db)):
    from app.models.request import ServiceRequest
    from app.models.session import Session
    req = await db.get(ServiceRequest, request_id)
    if not req or req.status != "open":
        raise HTTPException(status_code=404, detail="Request not found or not open")
    req.status = "matched"
    req.matched_chw_id = current_user.id

    # Auto-create a session for the matched request
    session = Session(
        request_id=req.id,
        chw_id=current_user.id,
        member_id=req.member_id,
        vertical=req.vertical,
        mode=req.preferred_mode,
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)
    return {"status": "matched", "request_id": str(req.id), "session_id": str(session.id)}

@router.patch("/{request_id}/pass")
async def pass_request(request_id: UUID, current_user=Depends(require_role("chw")), db: AsyncSession = Depends(get_db)):
    from app.models.request import ServiceRequest
    req = await db.get(ServiceRequest, request_id)
    if not req or req.status != "open":
        raise HTTPException(status_code=404, detail="Request not found or not open")
    if req.matched_chw_id == current_user.id:
        req.matched_chw_id = None
        req.status = "open"
        await db.commit()
    return {"status": "passed", "request_id": str(req.id)}

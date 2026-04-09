from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.database import get_db
from app.dependencies import get_current_user, require_role
from app.schemas.request import ServiceRequestCreate, ServiceRequestResponse

router = APIRouter(prefix="/api/v1/requests", tags=["requests"])

@router.get("/", response_model=list[ServiceRequestResponse])
async def list_requests(current_user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    from app.models.request import ServiceRequest
    if current_user.role == "chw":
        result = await db.execute(select(ServiceRequest).where(ServiceRequest.status == "open").order_by(ServiceRequest.created_at.desc()))
    else:
        result = await db.execute(select(ServiceRequest).where(ServiceRequest.member_id == current_user.id).order_by(ServiceRequest.created_at.desc()))
    return result.scalars().all()

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
    req = await db.get(ServiceRequest, request_id)
    if not req or req.status != "open":
        raise HTTPException(status_code=404, detail="Request not found or not open")
    req.status = "matched"
    req.matched_chw_id = current_user.id
    await db.commit()
    return {"status": "matched", "request_id": str(req.id)}

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

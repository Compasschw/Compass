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
    """Accept an open request.

    Side effects (in order; row mutations are transactional, downstream
    notifications are best-effort):
      1. ServiceRequest → status=matched, matched_chw_id=<chw>.
      2. Session row created (status=scheduled, mode inherits request).
      3. CalendarEvent rows inserted for both CHW and member so the
         "Upcoming Session" widgets on each dashboard render immediately.
      4. Push notification to the member.
      5. Email notification to the member with the matched CHW's first name.
    """
    from datetime import UTC, datetime, timedelta

    from app.models.calendar import CalendarEvent
    from app.models.request import ServiceRequest
    from app.models.session import Session
    from app.models.user import User

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
    await db.flush()  # populate session.id without ending the transaction

    # ── Calendar events ─────────────────────────────────────────────────────
    # Use scheduled_at if the request specified one, else default to "next
    # half-hour" so the calendar UI has a non-null slot. CHW will move it
    # via PATCH /sessions/{id} later as needed.
    scheduled_at = session.scheduled_at or _next_half_hour(datetime.now(UTC))
    end_time_at = scheduled_at + timedelta(minutes=30)
    chw_user = await db.get(User, current_user.id)
    member_user = await db.get(User, req.member_id)
    chw_first = (chw_user.name.split(" ")[0] if chw_user and chw_user.name else "Your CHW")
    member_first = (member_user.name.split(" ")[0] if member_user and member_user.name else "Your member")

    db.add_all([
        CalendarEvent(
            user_id=current_user.id,
            session_id=session.id,
            title=f"Session with {member_first}",
            date=scheduled_at.date(),
            start_time=scheduled_at.time(),
            end_time=end_time_at.time(),
            vertical=req.vertical,
            event_type="session",
        ),
        CalendarEvent(
            user_id=req.member_id,
            session_id=session.id,
            title=f"Session with {chw_first}",
            date=scheduled_at.date(),
            start_time=scheduled_at.time(),
            end_time=end_time_at.time(),
            vertical=req.vertical,
            event_type="session",
        ),
    ])

    await db.commit()
    await db.refresh(session)

    # ── Push notification to member ─────────────────────────────────────────
    try:
        from app.services.notifications import NotificationPayload, notify_user
        await notify_user(
            db,
            req.member_id,
            NotificationPayload(
                user_id=req.member_id,
                title="A CHW accepted your request",
                body=f"{chw_first} will reach out soon to schedule your session.",
                deeplink=f"compasschw://sessions/{session.id}",
                category="request.accepted",
                data={"session_id": str(session.id), "request_id": str(req.id)},
            ),
        )
    except Exception as e:  # noqa: BLE001
        import logging
        logging.getLogger("compass").warning("Notification fanout failed on accept: %s", e)

    # ── Email notification to member ────────────────────────────────────────
    try:
        if member_user and member_user.email:
            from app.services.email import send_request_accepted_email
            await send_request_accepted_email(
                to=member_user.email,
                member_first_name=member_first,
                chw_first_name=chw_first,
                vertical=req.vertical,
                scheduled_at_iso=scheduled_at.isoformat(),
            )
    except Exception as e:  # noqa: BLE001
        import logging
        logging.getLogger("compass").warning("Email send failed on accept: %s", e)

    return {"status": "matched", "request_id": str(req.id), "session_id": str(session.id)}


def _next_half_hour(now):
    """Round UP to the next :00 or :30 boundary."""
    from datetime import timedelta
    minute = 0 if now.minute < 30 else 30
    bumped = now.replace(minute=minute, second=0, microsecond=0)
    if bumped <= now:
        bumped = bumped + timedelta(minutes=30)
    return bumped

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

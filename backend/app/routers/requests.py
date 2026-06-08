from datetime import UTC, datetime, timedelta
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user, require_role
from app.services.session_lookup import find_or_create_conversation_for_pair
from app.schemas.request import (
    IncomingMemberRequestResponse,
    ServiceRequestCreate,
    ServiceRequestResponse,
    ServiceRequestSummaryResponse,
)

router = APIRouter(prefix="/api/v1/requests", tags=["requests"])


# The CHW-exclusive lock window for Schedule-with-X targeted requests.
# After this much time has passed without the chosen CHW accepting or
# declining, the request falls into the open pool for any CHW to claim.
TARGET_LOCK_WINDOW = timedelta(hours=24)


def _is_target_active(req, now: datetime) -> bool:
    """True when a request is still in its target-CHW exclusive window."""
    return (
        req.target_chw_id is not None
        and req.target_expires_at is not None
        and req.target_expires_at > now
    )


@router.get("/", response_model=list[ServiceRequestSummaryResponse] | list[ServiceRequestResponse])
async def list_requests(current_user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """List service requests.

    - CHWs see an anonymized summary of open requests in the pool (no
      description, no member name).  Requests still inside their 24h
      target-CHW exclusive window are EXCLUDED for non-target CHWs;
      they appear in the target's separate ``GET /requests/incoming``
      endpoint instead.  This enforces HIPAA's minimum necessary access
      standard (45 CFR §164.514(d)) AND the product expectation that a
      member's directed choice is honored before the request becomes
      public.
    - Members see their own requests with full details.
    """
    from app.models.request import ServiceRequest
    from app.models.user import User
    if current_user.role == "chw":
        now = datetime.now(UTC)
        stmt = (
            select(ServiceRequest)
            .where(ServiceRequest.status == "open")
            # Open-pool visibility: include requests with no target, OR
            # whose target window has expired.  Targeted-and-still-active
            # requests are scoped to the target CHW only.
            .where(
                or_(
                    ServiceRequest.target_chw_id.is_(None),
                    ServiceRequest.target_expires_at.is_(None),
                    ServiceRequest.target_expires_at <= now,
                )
            )
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


@router.get("/incoming", response_model=list[IncomingMemberRequestResponse])
async def list_incoming_member_requests(
    current_user=Depends(require_role("chw")),
    db: AsyncSession = Depends(get_db),
):
    """List pending member requests directed at THIS CHW.

    Powers the "Request" filter on the CHW Members page.  Returns one
    row per ServiceRequest where:
      - ``target_chw_id`` is the caller
      - ``status == 'open'``
      - ``target_expires_at`` is in the future (lock window still active)

    Carries member name + verticals + urgency + description preview so
    the row can render inline with Accept/Decline buttons without an
    extra round-trip.  PHI exposure is justified because the member
    explicitly directed the request at this CHW.
    """
    from app.models.request import ServiceRequest
    from app.models.user import User

    now = datetime.now(UTC)
    stmt = (
        select(ServiceRequest, User.name)
        .join(User, ServiceRequest.member_id == User.id)
        .where(ServiceRequest.target_chw_id == current_user.id)
        .where(ServiceRequest.status == "open")
        .where(ServiceRequest.target_expires_at.is_not(None))
        .where(ServiceRequest.target_expires_at > now)
        .order_by(ServiceRequest.created_at.desc())
    )
    result = await db.execute(stmt)
    rows = result.all()
    return [
        IncomingMemberRequestResponse.model_validate({
            **req.__dict__,
            "member_name": name or "Unknown member",
        })
        for req, name in rows
    ]


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
async def create_request(
    data: ServiceRequestCreate,
    current_user=Depends(require_role("member")),
    db: AsyncSession = Depends(get_db),
) -> ServiceRequestResponse:
    """Create a single service request covering one or more verticals.

    Accepts either the new `verticals` array or the legacy `vertical` string
    field (backwards-compatible with old mobile clients). Always writes both:
      - `verticals` = the authoritative array
      - `vertical`  = verticals[0] (for sessions, claims, and admin views
                       that consume the single-vertical column)

    Raises 422 if no vertical is specified via either field.
    """
    from app.models.request import ServiceRequest

    try:
        resolved = data.resolved_verticals()
    except ValueError as exc:
        from fastapi import HTTPException
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    verticals_values = [v.value for v in resolved]
    primary_vertical = verticals_values[0]

    req = ServiceRequest(
        member_id=current_user.id,
        vertical=primary_vertical,
        verticals=verticals_values,
        urgency=data.urgency.value,
        description=data.description,
        preferred_mode=data.preferred_mode.value,
        estimated_units=data.estimated_units,
    )

    # Schedule-with-X flow: when the member explicitly chose a CHW, lock the
    # request to that CHW for 24h.  Validate the target is actually a CHW
    # account so an attacker can't pre-target a member or admin user_id.
    if data.target_chw_id is not None:
        from app.models.user import User as _User
        target = await db.get(_User, data.target_chw_id)
        if target is None or target.role != "chw" or not target.is_active:
            raise HTTPException(
                status_code=422,
                detail="target_chw_id does not match an active CHW account",
            )
        req.target_chw_id = data.target_chw_id
        req.target_expires_at = datetime.now(UTC) + TARGET_LOCK_WINDOW

    db.add(req)
    await db.commit()
    await db.refresh(req)
    return ServiceRequestResponse.model_validate(req)

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

    # Respect the target-CHW lock window.  If another CHW tries to claim a
    # request that's still locked to a specific target, return 403 so the
    # mobile UI can surface "this request is reserved for another CHW
    # right now".  After expiry (or after the target's explicit /pass),
    # this gate is open and any CHW can accept.
    now = datetime.now(UTC)
    if _is_target_active(req, now) and req.target_chw_id != current_user.id:
        raise HTTPException(
            status_code=403,
            detail="This request is reserved for another CHW until the 24h window expires",
        )

    # T03: block new session creation when the requesting member has refused
    # services.  Existing in-progress sessions are NOT affected — only the
    # creation of a new Session (which happens on accept) is blocked.
    from app.services.relationship_guards import assert_member_consents_to_services
    await assert_member_consents_to_services(db, member_id=req.member_id)

    req.status = "matched"
    req.matched_chw_id = current_user.id
    # Clear the target lock now that the request is claimed — the relationship
    # is established and downstream UIs key off matched_chw_id, not target_*.
    req.target_chw_id = None
    req.target_expires_at = None

    # Compute a real scheduled_at BEFORE the session is persisted. Without
    # this the session row had `scheduled_at=NULL`, and the React Native web
    # bundle's date formatter rendered `new Date(null)` as Unix epoch — i.e.
    # "Wed, Dec 31, 4:00 PM" Pacific (= 1970-01-01 00:00 UTC). The placeholder
    # date showed up on every CHW + member session card.
    #
    # Member can specify a preferred time on the request; otherwise pick the
    # next half-hour so the calendar slot isn't stale. CHW can still move it
    # later via PATCH /sessions/{id}.
    scheduled_at = _next_half_hour(datetime.now(UTC))

    # Auto-create a session for the matched request
    session = Session(
        request_id=req.id,
        chw_id=current_user.id,
        member_id=req.member_id,
        vertical=req.vertical,
        mode=req.preferred_mode,
        scheduled_at=scheduled_at,
    )
    db.add(session)
    await db.flush()  # populate session.id without ending the transaction

    # Stamp the conversation back-link so future session-per-call lookups
    # (get_active_session_for_conversation) can find this Session by its
    # conversation. New in #193 — see app.services.session_lookup.
    conversation = await find_or_create_conversation_for_pair(
        db, chw_id=session.chw_id, member_id=session.member_id,
    )
    session.conversation_id = conversation.id

    # ── Calendar events ─────────────────────────────────────────────────────
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
    """CHW declines a request.

    Two paths:
      1. **Targeted-pending pass** — the caller is the request's
         ``target_chw_id`` and the request is still ``open`` inside the
         24h lock window.  Clear ``target_chw_id`` + ``target_expires_at``
         so the request falls into the open pool immediately for other
         CHWs to claim.  This is the "Decline" button on the Request
         filter in the Members page.
      2. **Matched-but-un-accept** — legacy behavior, retained for the
         old open-pool flow where a CHW had already been "matched" to a
         request but wants to release it back.

    Either way, the response is 200 with ``{"status": "passed"}`` so
    the mobile UI can refetch and re-render.
    """
    from app.models.request import ServiceRequest
    req = await db.get(ServiceRequest, request_id)
    if not req or req.status != "open":
        raise HTTPException(status_code=404, detail="Request not found or not open")

    mutated = False
    # Targeted-pending pass: release the 24h CHW-exclusive lock so other
    # CHWs can claim the request from the open pool.
    if req.target_chw_id == current_user.id:
        req.target_chw_id = None
        req.target_expires_at = None
        mutated = True
    # Legacy matched-but-un-accept (kept for back-compat with the older
    # open-pool flow where /accept transitioned status to "matched" but
    # the CHW later wanted out).
    if req.matched_chw_id == current_user.id:
        req.matched_chw_id = None
        req.status = "open"
        mutated = True
    if mutated:
        await db.commit()
    return {"status": "passed", "request_id": str(req.id)}


@router.patch("/{request_id}/cancel")
async def cancel_request(
    request_id: UUID,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Cancel an open request.

    Only the member who owns the request may cancel it. Cancellation is only
    allowed while the request is in the ``open`` state — once a CHW has
    accepted (status=``matched``) the member should contact the CHW directly
    or cancel the resulting session instead.

    Returns 403 when the caller is not the owning member.
    Returns 409 when the request is not in a cancellable state.
    """
    from app.models.request import ServiceRequest

    req = await db.get(ServiceRequest, request_id)
    if req is None:
        raise HTTPException(status_code=404, detail="Request not found")

    if req.member_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not authorized to cancel this request")

    if req.status != "open":
        raise HTTPException(
            status_code=409,
            detail=f"Cannot cancel a request with status '{req.status}'. "
                   "Only open requests may be cancelled by the member.",
        )

    req.status = "cancelled"
    await db.commit()
    return {"status": "cancelled", "request_id": str(req.id)}

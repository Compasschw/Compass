from datetime import UTC, datetime, timedelta
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.billing import BillingClaim
from app.models.request import ServiceRequest
from app.models.session import ConsentRequest, MemberConsent, Session, SessionDocumentation
from app.models.user import User
from app.schemas.conversation import (
    MarkReadRequest,
    SessionMessageAttachmentResponse,
    SessionMessageResponse,
    SessionMessageSend,
)
from app.schemas.followup import (
    ExtractFollowupsResponse,
    SessionFollowupPatch,
    SessionFollowupResponse,
)
from app.schemas.session import (
    ConsentRequestApprove,
    ConsentRequestCreate,
    ConsentRequestResponse,
    ConsentSubmit,
    ScheduleSessionRequest,
    SessionArchiveUpdate,
    SessionCreate,
    SessionDocumentationSubmit,
    SessionMuteUpdate,
    SessionPinUpdate,
    SessionResponse,
    TranscriptResponse,
)
from app.services.billing_service import calculate_earnings, calculate_units, check_unit_caps, validate_claim
from app.services.session_lookup import find_or_create_conversation_for_pair

router = APIRouter(prefix="/api/v1/sessions", tags=["sessions"])


@router.get("/", response_model=list[SessionResponse])
async def list_sessions(
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    limit: int = Query(default=50, ge=1, le=200, description="Max sessions to return"),
    offset: int = Query(default=0, ge=0, description="Skip this many sessions"),
    include_archived: bool = Query(
        default=False,
        description=(
            "When true, also return archived threads (CHW perspective). Soft-"
            "deleted threads are never returned through this endpoint."
        ),
    ),
):
    """List sessions for the current user.

    Sort order for CHW callers: pinned threads first (newest-pin first),
    then everything else by creation time desc.  This is what the inbox
    expects so pinned threads form a top section with the rest below.

    Soft-deleted threads (``deleted_at IS NOT NULL``) are always hidden;
    archived threads (``archived_at IS NOT NULL``) are hidden unless the
    caller passes ``include_archived=true``.  Member callers see the full
    set unfiltered — the CHW inbox swipe-action state is intentionally not
    surfaced on the member side.

    Offset-based pagination keeps response shape identical to the unpaginated
    variant (still a flat array). For total counts, clients call /sessions/count.
    """
    from sqlalchemy import desc, nulls_last
    from sqlalchemy.orm import aliased

    from app.models.user import User
    CHWUser = aliased(User)
    MemberUser = aliased(User)
    stmt = (
        select(Session, CHWUser.name, MemberUser.name)
        .join(CHWUser, Session.chw_id == CHWUser.id)
        .join(MemberUser, Session.member_id == MemberUser.id)
    )
    if current_user.role == "chw":
        stmt = stmt.where(Session.chw_id == current_user.id)
        # Hide soft-deleted threads from the inbox.
        stmt = stmt.where(Session.deleted_at.is_(None))
        if not include_archived:
            stmt = stmt.where(Session.archived_at.is_(None))
        # Pinned threads bubble to the top of the CHW inbox; everything
        # else stays in creation-time-desc order beneath them.
        stmt = stmt.order_by(
            nulls_last(desc(Session.pinned_at)),
            Session.created_at.desc(),
        )
    else:
        stmt = stmt.where(Session.member_id == current_user.id)
        stmt = stmt.order_by(Session.created_at.desc())
    stmt = stmt.limit(limit).offset(offset)
    result = await db.execute(stmt)
    rows = result.all()
    return [
        SessionResponse.model_validate({**s.__dict__, "chw_name": chw_name, "member_name": member_name})
        for s, chw_name, member_name in rows
    ]


# ── Swipe-action endpoints (CHW Messages inbox) ──────────────────────────────
#
# Three small endpoints back the CHW Messages thread-row swipe actions:
#   PATCH  /sessions/{id}/pin      → toggle pinned_at
#   PATCH  /sessions/{id}/archive  → toggle archived_at
#   PATCH  /sessions/{id}/mute     → toggle muted_at
#   DELETE /sessions/{id}          → soft-delete (deleted_at)
#
# All three require the caller to be either (a) the CHW that owns the
# session or (b) an admin.  Members never see these — the swipe UI is
# CHW-only.  The endpoints are idempotent: re-pinning an already-pinned
# thread updates the timestamp; un-pinning a never-pinned thread is a no-op
# that returns 200 with the unchanged row.
#
# Soft delete vs hard delete: clinical records carry HIPAA + Pear-billing
# audit obligations. We only stamp ``deleted_at`` and let the inbox query
# hide the row.  An admin-side undelete + scheduled purge job can come
# later; today the row is recoverable indefinitely.


async def _load_chw_session_or_404(
    *, session_id: UUID, db: AsyncSession, current_user: User
) -> Session:
    """Resolve a session for a CHW-action endpoint, enforcing ownership.

    Returns the loaded ``Session`` row when the caller is either the
    session's owning CHW or an admin.  Raises HTTPException(404) when the
    row doesn't exist *or* when the caller is not authorised — we return
    404 instead of 403 so we don't leak the existence of sessions the
    caller cannot see.
    """
    session = await db.get(Session, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if current_user.role == "admin":
        return session
    if current_user.role == "chw" and session.chw_id == current_user.id:
        return session
    raise HTTPException(status_code=404, detail="Session not found")


async def _load_participant_session_or_404(
    *, session_id: UUID, db: AsyncSession, current_user: User
) -> Session:
    """Resolve a session for a confirm/decline-style endpoint, enforcing that
    the caller is a participant on the session.

    Unlike ``_load_chw_session_or_404`` (CHW-or-admin only), this loader also
    admits the session's participant MEMBER — used by ``confirm_session`` /
    ``decline_session`` now that either side of a proposed session may need
    to approve/decline it (see the initiator-inversion rule in those
    handlers). Returns the loaded ``Session`` row when the caller is the
    owning CHW, the participant member, or an admin. Raises
    HTTPException(404) when the row doesn't exist *or* the caller is not a
    participant — 404 (never 403) so we don't leak the existence of sessions
    the caller cannot see, matching this file's existing pattern.
    """
    session = await db.get(Session, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if current_user.role == "admin":
        return session
    if current_user.role == "chw" and session.chw_id == current_user.id:
        return session
    if current_user.role == "member" and session.member_id == current_user.id:
        return session
    raise HTTPException(status_code=404, detail="Session not found")


@router.patch("/{session_id}/pin", response_model=SessionResponse)
async def update_session_pin(
    session_id: UUID,
    body: SessionPinUpdate,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SessionResponse:
    """Pin or unpin a thread in the CHW's Messages inbox.

    ``pinned=true`` stamps the current UTC time onto ``pinned_at`` (so the
    most-recently-pinned threads sort first among pinned items).
    ``pinned=false`` clears the timestamp.
    """
    session = await _load_chw_session_or_404(
        session_id=session_id, db=db, current_user=current_user
    )
    session.pinned_at = datetime.now(UTC) if body.pinned else None
    await db.commit()
    await db.refresh(session)
    # Re-load names for the response shape (list endpoint joins them; this
    # endpoint loads them directly because the user names rarely change and
    # the round-trip is cheap).
    from app.models.user import User as _User
    chw = await db.get(_User, session.chw_id)
    member = await db.get(_User, session.member_id)
    return SessionResponse.model_validate({
        **session.__dict__,
        "chw_name": chw.name if chw else None,
        "member_name": member.name if member else None,
    })


@router.patch("/{session_id}/archive", response_model=SessionResponse)
async def update_session_archive(
    session_id: UUID,
    body: SessionArchiveUpdate,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SessionResponse:
    """Archive or unarchive a thread in the CHW's Messages inbox.

    Archived threads disappear from the default inbox but reappear when the
    CHW toggles "Show archived" in the inbox header (the list endpoint
    accepts ``?include_archived=true`` for that case).
    """
    session = await _load_chw_session_or_404(
        session_id=session_id, db=db, current_user=current_user
    )
    session.archived_at = datetime.now(UTC) if body.archived else None
    await db.commit()
    await db.refresh(session)
    from app.models.user import User as _User
    chw = await db.get(_User, session.chw_id)
    member = await db.get(_User, session.member_id)
    return SessionResponse.model_validate({
        **session.__dict__,
        "chw_name": chw.name if chw else None,
        "member_name": member.name if member else None,
    })


@router.patch("/{session_id}/mute", response_model=SessionResponse)
async def update_session_mute(
    session_id: UUID,
    body: SessionMuteUpdate,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SessionResponse:
    """Mute or unmute a thread in the CHW's Messages inbox.

    ``muted=true`` stamps the current UTC time onto ``muted_at``; a muted
    thread stays in the inbox but its unread notification/badge is suppressed
    and a bell-off indicator is shown on the row.  ``muted=false`` clears the
    timestamp.  CHW-owned via ``_load_chw_session_or_404`` (non-owner → 404).

    Idempotent: re-muting an already-muted thread updates the timestamp;
    un-muting a never-muted thread is a no-op that returns 200 unchanged.
    """
    session = await _load_chw_session_or_404(
        session_id=session_id, db=db, current_user=current_user
    )
    session.muted_at = datetime.now(UTC) if body.muted else None
    await db.commit()
    await db.refresh(session)
    from app.models.user import User as _User
    chw = await db.get(_User, session.chw_id)
    member = await db.get(_User, session.member_id)
    return SessionResponse.model_validate({
        **session.__dict__,
        "chw_name": chw.name if chw else None,
        "member_name": member.name if member else None,
    })


def _scheduled_at_label(session) -> str:
    """Human-readable clinic-local label for the session start, e.g.
    'Thu, Jul 09 at 11:30 AM'. Falls back gracefully when scheduled_at is null."""
    if session.scheduled_at is None:
        return "your session"
    from app.services.availability import to_clinic_local

    local = to_clinic_local(session.scheduled_at)
    return local.strftime("%a, %b %d at %I:%M %p")


def _add_scheduling_message(db: AsyncSession, session, sender_id, *, confirmed: bool) -> None:
    """Post a notification message to the session's conversation on confirm/decline.

    The message lands in the shared CHW↔member thread, so both parties see the
    outcome in Messages. No-op when the session has no conversation linked.
    """
    if session.conversation_id is None:
        return
    from app.models.conversation import Message

    label = _scheduled_at_label(session)
    body = (
        f"✅ Session confirmed for {label}."
        if confirmed
        else f"❌ Session request for {label} was declined."
    )
    db.add(
        Message(
            conversation_id=session.conversation_id,
            sender_id=sender_id,
            body=body,
            type="text",
        )
    )


def _reject_self_approval_if_initiator(session: Session, current_user: User) -> None:
    """Enforce the initiator-inversion rule for CONFIRM ONLY: only the
    NON-proposing party may confirm a session's proposed time.

    NOTE (QA2 A2 — root cause of the "propose new time doesn't remove the
    original" bug): this rule used to also gate ``decline_session``, which
    blocked a proposer from retracting their OWN proposal. Concretely: a CHW
    who scheduled a pending session (proposed_by='chw'), then used "Propose
    New Time" to counter-offer a different slot, could not decline the stale
    original — the CHW IS that session's proposer, so the old rule 409'd the
    retraction, leaving two pending sessions instead of one. That's backwards:
    retracting your own proposal (to replace it with a new one) is exactly the
    case a proposer must always be allowed to do; only ACCEPTING your own
    proposal (confirm) is invalid self-approval. ``decline_session`` no longer
    calls this helper at all — decline is now unconditional for any
    participant. Only ``confirm_session`` still calls this helper.

    - CHW caller: allowed when ``proposed_by == "member"`` or ``None``
      (legacy rows — allow, preserving pre-existing CHW behavior). Rejected
      (409) when ``proposed_by == "chw"`` (self-approval).
    - Member caller: allowed only when ``proposed_by == "chw"``. Rejected
      (409) when ``proposed_by == "member"`` (self-approval) OR ``None``
      (legacy rows — reject for members; the initiator is unknown, so we
      default to the safe/conservative choice rather than assume the CHW
      proposed it).
    - Admin caller: bypasses this rule entirely (admins act on behalf of
      support/ops workflows and are not a "side" of the negotiation).

    Raises HTTPException(409) on violation; the caller (confirm_session)
    should call this AFTER the participant-relationship 404 gate.
    """
    if current_user.role == "admin":
        return
    if current_user.role == "chw":
        if session.proposed_by == "chw":
            raise HTTPException(
                status_code=409,
                detail="You proposed this session's time; the other party must respond.",
            )
        return
    if current_user.role == "member":
        if session.proposed_by != "chw":
            raise HTTPException(
                status_code=409,
                detail="You proposed this session's time; the other party must respond.",
            )
        return


@router.patch("/{session_id}/confirm", response_model=SessionResponse)
async def confirm_session(
    session_id: UUID,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SessionResponse:
    """Confirm a pending scheduled session — either participant may call this,
    but never the party that proposed the current time.

    Flips ``scheduling_status`` pending → confirmed. Callable by the owning
    CHW, the participant member, or an admin (``_load_participant_session_or_404``);
    a non-participant gets 404 so session existence isn't leaked. 409 when the
    session is not in the ``scheduled`` state.

    Initiator-inversion rule (409, see ``_reject_self_approval_if_initiator``):
    a CHW cannot confirm a session THEY proposed (``proposed_by == "chw"``);
    a member cannot confirm a session THEY proposed (``proposed_by ==
    "member"``) or a legacy session with no recorded proposer
    (``proposed_by is None`` — conservative default since the initiator is
    unknown). A CHW confirming a legacy-null or member-proposed session is
    unaffected — this preserves the pre-existing CHW confirm flow exactly.
    Admins bypass the inversion rule entirely.

    Idempotent: confirming an already-confirmed scheduled session is a no-op 200.
    """
    session = await _load_participant_session_or_404(
        session_id=session_id, db=db, current_user=current_user
    )
    _reject_self_approval_if_initiator(session, current_user)
    if session.status != "scheduled":
        raise HTTPException(
            status_code=409, detail="Only a scheduled session can be confirmed."
        )
    session.scheduling_status = "confirmed"
    _add_scheduling_message(db, session, current_user.id, confirmed=True)
    await db.commit()
    await db.refresh(session)

    # ── Push notification to the OTHER party — "request approved" ──────────
    # Best-effort: a delivery failure here must never fail the confirm action
    # (mirrors the accept-request notification pattern in routers/requests.py).
    # NOTE: we don't store a per-member timezone yet, so the label below is
    # rendered in clinic-local time (CLINIC_TZ_NAME) via `_scheduled_at_label`
    # — same fallback the existing scheduling-message helper already uses.
    #
    # Direction depends on who called: a CHW confirming a member-proposed
    # session notifies the MEMBER (pre-existing copy/behavior, unchanged); a
    # member confirming a CHW-proposed session notifies the CHW instead, with
    # copy reflecting that the member accepted the CHW's proposed time.
    try:
        from app.services.notifications import NotificationPayload, notify_user
        if current_user.role == "member":
            notify_user_id = session.chw_id
            notify_body = f"Your member accepted the session for {_scheduled_at_label(session)}."
        else:
            notify_user_id = session.member_id
            notify_body = f"Your session was approved for {_scheduled_at_label(session)}."
        await notify_user(
            db,
            notify_user_id,
            NotificationPayload(
                user_id=notify_user_id,
                title="Session approved",
                body=notify_body,
                deeplink=f"compasschw://sessions/{session.id}",
                category="session.confirmed",
                data={"session_id": str(session.id)},
            ),
        )
    except Exception as e:  # noqa: BLE001
        import logging
        logging.getLogger("compass").warning(
            "Notification fanout failed on session confirm: %s", e
        )

    from app.models.user import User as _User
    chw = await db.get(_User, session.chw_id)
    member = await db.get(_User, session.member_id)
    return SessionResponse.model_validate({
        **session.__dict__,
        "chw_name": chw.name if chw else None,
        "member_name": member.name if member else None,
    })


@router.patch("/{session_id}/decline", response_model=SessionResponse)
async def decline_session(
    session_id: UUID,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SessionResponse:
    """Decline (or retract) a pending scheduled session — EITHER participant
    may call this, INCLUDING the party that proposed the current time.

    Marks the session ``cancelled`` so it drops off both parties' upcoming
    calendar views. Callable by the owning CHW, the participant member, or an
    admin (``_load_participant_session_or_404``); a non-participant gets 404
    so session existence isn't leaked. 409 when the session is not in the
    ``scheduled`` state.

    NO initiator-inversion rule here (QA2 A2 fix — this used to call
    ``_reject_self_approval_if_initiator``, the same check ``confirm_session``
    uses, which incorrectly blocked a proposer from retracting their OWN
    proposal). Declining/retracting is symmetric: the proposer may withdraw
    their own pending offer (the "Propose New Time" flow's book-then-decline-
    the-original sequence depends on this — the CHW/member who just proposed
    the NEW time is also the proposer of the OLD session being replaced), and
    the non-proposer may decline an offer made to them, exactly as before.
    Only ``confirm_session`` keeps the inversion check, since confirming your
    own proposal is the one case that really is invalid self-approval.

    No push notification here — only ``_add_scheduling_message`` posts to the
    shared thread (it already takes ``sender_id`` generically, so it works
    correctly for either calling role).
    """
    session = await _load_participant_session_or_404(
        session_id=session_id, db=db, current_user=current_user
    )
    if session.status != "scheduled":
        raise HTTPException(
            status_code=409, detail="Only a scheduled session can be declined."
        )
    session.status = "cancelled"
    _add_scheduling_message(db, session, current_user.id, confirmed=False)
    await db.commit()
    await db.refresh(session)
    from app.models.user import User as _User
    chw = await db.get(_User, session.chw_id)
    member = await db.get(_User, session.member_id)
    return SessionResponse.model_validate({
        **session.__dict__,
        "chw_name": chw.name if chw else None,
        "member_name": member.name if member else None,
    })


@router.patch("/{session_id}/cancel", response_model=SessionResponse)
async def cancel_session(
    session_id: UUID,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SessionResponse:
    """Either participant (member or CHW) cancels a scheduled session.

    Powers the member's "Remove" action on their own appointment (and the
    cancel half of a reschedule). Marks the session ``cancelled`` and posts a
    notification to the shared thread so the other party is informed. Only a
    participant on the session (or an admin) may act — a non-participant gets
    404 so session existence isn't leaked. 409 when the session isn't
    ``scheduled`` (e.g. already completed/cancelled/in progress).
    """
    session = await db.get(Session, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    is_participant = current_user.id in (session.member_id, session.chw_id)
    if not (is_participant or current_user.role == "admin"):
        raise HTTPException(status_code=404, detail="Session not found")
    if session.status != "scheduled":
        raise HTTPException(
            status_code=409, detail="Only a scheduled session can be cancelled."
        )

    session.status = "cancelled"
    if session.conversation_id is not None:
        from app.models.conversation import Message

        db.add(
            Message(
                conversation_id=session.conversation_id,
                sender_id=current_user.id,
                body=f"🚫 The session for {_scheduled_at_label(session)} was cancelled.",
                type="text",
            )
        )
    await db.commit()
    await db.refresh(session)
    from app.models.user import User as _User
    chw = await db.get(_User, session.chw_id)
    member = await db.get(_User, session.member_id)
    return SessionResponse.model_validate({
        **session.__dict__,
        "chw_name": chw.name if chw else None,
        "member_name": member.name if member else None,
    })


@router.delete("/{session_id}", status_code=204)
async def delete_session(
    session_id: UUID,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Soft-delete a thread from the CHW's Messages inbox.

    Stamps ``deleted_at`` on the row so the inbox query hides it.  The
    underlying messages, transcript, recording_url, and any downstream
    billing claim rows remain intact — this is intentionally not a hard
    delete because clinical records carry HIPAA + Pear-billing audit
    obligations.  An admin-side undelete tool can flip ``deleted_at`` back
    to NULL.
    """
    session = await _load_chw_session_or_404(
        session_id=session_id, db=db, current_user=current_user
    )
    if session.deleted_at is None:
        session.deleted_at = datetime.now(UTC)
        await db.commit()
    return None


@router.post("/", response_model=SessionResponse, status_code=201)
async def create_session(
    data: SessionCreate,
    background_tasks: BackgroundTasks,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Session:
    # Epic D work gate: block a non-compliant CHW from creating a session
    # via the legacy create path. Flag OFF (default) is a no-op — identical
    # behavior to before this change.
    from app.config import settings

    if settings.chw_work_gate_enabled and current_user.role == "chw":
        from app.services.chw_compliance import chw_can_work

        can_work, missing = await chw_can_work(db, current_user)
        if not can_work:
            raise HTTPException(
                status_code=403,
                detail={"code": "onboarding_incomplete", "missing": missing},
            )

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

    # Stamp the conversation back-link so future session-per-call lookups
    # (get_active_session_for_conversation) can find this Session by its
    # conversation. New in #193 — see app.services.session_lookup.
    conversation = await find_or_create_conversation_for_pair(
        db, chw_id=session.chw_id, member_id=session.member_id,
    )
    session.conversation_id = conversation.id

    await db.commit()
    await db.refresh(session)

    # Resolve both parties' names for notification copy.
    # We do this before returning so the names are captured in the closure;
    # the actual push send happens after the HTTP response via BackgroundTasks.
    chw_user = await db.get(User, chw_id)
    member_user = await db.get(User, member_id)
    chw_first_name = (chw_user.name.split()[0] if chw_user else "Your CHW")
    member_first_name = (member_user.name.split()[0] if member_user else "Your member")

    # Notify the member that a session has been scheduled.
    from app.services import notification_service
    background_tasks.add_task(
        notification_service.notify_session_scheduled,
        db,
        member_id,
        chw_first_name,
        session.id,
        data.scheduled_at,
    )

    # Notify the CHW that a session has been scheduled.
    background_tasks.add_task(
        notification_service.notify_session_scheduled,
        db,
        chw_id,
        member_first_name,
        session.id,
        data.scheduled_at,
    )

    return session


@router.get("/{session_id}", response_model=SessionResponse)
async def get_session(session_id: UUID, current_user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    session = await db.get(Session, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.chw_id != current_user.id and session.member_id != current_user.id and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Not authorized")
    return session


@router.post("/schedule", response_model=SessionResponse, status_code=201)
async def schedule_session(
    data: ScheduleSessionRequest,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Session:
    """Schedule a session between a CHW and a member.

    Called by a CHW (Calendar "Schedule Session") with ``member_id``, or by a
    member (Appointments "Schedule a session") with ``chw_id`` — in which case
    the booking is recorded as ``pending`` for the CHW to confirm. Unlike
    ``POST /sessions/`` (which requires an accepted ServiceRequest), either
    party may book against an existing care relationship; the request_id NOT
    NULL invariant is satisfied by reusing the CHW↔member ServiceRequest, or
    auto-creating a minimal one when none exists.
    """
    from app.config import settings
    from app.models.user import MemberProfile

    # Epic D work gate: block a non-compliant CHW from scheduling a session.
    # Only gates when the CALLER is a CHW (a member scheduling against a CHW
    # is not affected here — matches the epic's "caller is a CHW" rule).
    # Flag OFF (default) is a no-op — identical behavior to before this change.
    if settings.chw_work_gate_enabled and current_user.role == "chw":
        from app.services.chw_compliance import chw_can_work

        can_work, missing = await chw_can_work(db, current_user)
        if not can_work:
            raise HTTPException(
                status_code=403,
                detail={"code": "onboarding_incomplete", "missing": missing},
            )

    # ── Resolve the CHW/member pair + booking status from the caller's role ──
    if current_user.role == "chw":
        chw_id = current_user.id
        member_id = data.member_id
        if member_id is None:
            raise HTTPException(status_code=422, detail="member_id is required.")
        scheduling_status = data.scheduling_status
        proposed_by = "chw"
    elif current_user.role == "member":
        member_id = current_user.id
        chw_id = data.chw_id
        if chw_id is None:
            raise HTTPException(status_code=422, detail="chw_id is required.")
        # A member's booking is a request the CHW confirms — always pending.
        scheduling_status = "pending"
        proposed_by = "member"
    else:
        raise HTTPException(status_code=403, detail="Not allowed to schedule sessions.")

    # ── Relationship gate ────────────────────────────────────────────────────
    # Either party may only schedule within an existing care relationship: a
    # prior shared Session OR a ServiceRequest matched between this CHW & member.
    shared_session = (
        await db.execute(
            select(Session.id)
            .where(Session.chw_id == chw_id, Session.member_id == member_id)
            .limit(1)
        )
    ).scalar_one_or_none()

    matched_request = (
        await db.execute(
            select(ServiceRequest)
            .where(
                ServiceRequest.matched_chw_id == chw_id,
                ServiceRequest.member_id == member_id,
            )
            .order_by(ServiceRequest.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()

    if shared_session is None and matched_request is None:
        raise HTTPException(
            status_code=403,
            detail="You can only schedule sessions within an existing care relationship.",
        )

    # ── Resolve request_id: reuse the matched request, else auto-create one ──
    if matched_request is not None:
        request_id = matched_request.id
        vertical = matched_request.vertical
    else:
        member_profile = (
            await db.execute(
                select(MemberProfile).where(MemberProfile.user_id == member_id)
            )
        ).scalar_one_or_none()
        vertical = (
            member_profile.primary_need
            if member_profile and member_profile.primary_need
            else "other"
        )
        auto_request = ServiceRequest(
            member_id=member_id,
            matched_chw_id=chw_id,
            vertical=vertical,
            verticals=[vertical],
            urgency="routine",
            description="Auto-created for a scheduled session.",
            preferred_mode=data.mode.value,
            status="matched",
        )
        db.add(auto_request)
        await db.flush()
        request_id = auto_request.id

    session = Session(
        request_id=request_id,
        chw_id=chw_id,
        member_id=member_id,
        vertical=vertical,
        mode=data.mode.value,
        scheduled_at=data.scheduled_at,
        scheduled_end_at=data.scheduled_end_at,
        scheduling_status=scheduling_status,
        proposed_by=proposed_by,
        notes=data.notes,
        resource_needs=[v.value for v in data.resource_needs] or None,
        status="scheduled",
    )
    db.add(session)

    # Back-link the conversation so session-per-call lookups resolve this row.
    conversation = await find_or_create_conversation_for_pair(
        db, chw_id=chw_id, member_id=member_id,
    )
    session.conversation_id = conversation.id

    await db.commit()
    await db.refresh(session)
    return session


@router.patch("/{session_id}/start", response_model=SessionResponse)
async def start_session(session_id: UUID, current_user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    # The whole body is wrapped so any UNEXPECTED failure is surfaced as an
    # HTTPException (which keeps CORS headers) carrying the real error, instead of
    # an unhandled 500 — those drop the Access-Control-Allow-Origin header, so the
    # browser only sees "Failed to fetch" / a CORS error and the actual cause is
    # invisible. The full traceback is also logged server-side.
    import logging
    import traceback

    from app.config import settings

    try:
        # Epic D work gate: block a non-compliant CHW from starting a
        # session. Flag OFF (default) is a no-op — identical behavior to
        # before this change. Placed inside the try so an unexpected failure
        # in chw_can_work is still surfaced as a clean HTTPException(500) by
        # the except Exception handler below, never a bare 500.
        if settings.chw_work_gate_enabled and current_user.role == "chw":
            from app.services.chw_compliance import chw_can_work

            can_work, missing = await chw_can_work(db, current_user)
            if not can_work:
                raise HTTPException(
                    status_code=403,
                    detail={"code": "onboarding_incomplete", "missing": missing},
                )

        session = await db.get(Session, session_id)
        if not session or session.chw_id != current_user.id:
            raise HTTPException(status_code=404, detail="Session not found")
        if session.status != "scheduled":
            raise HTTPException(status_code=409, detail=f"Cannot start session with status '{session.status}'. Must be 'scheduled'.")

        # One active session per CHW. A CHW can only physically be in one session
        # at a time, so any OTHER session still marked in_progress when starting a
        # new one was abandoned (or is a stale artifact from an interrupted start).
        # Auto-cancel them to restore the one-active invariant and let the new
        # session start.
        #
        # NOTE: use .scalars().all() — NOT scalar_one_or_none(), which RAISES
        # MultipleResultsFound when more than one stale in_progress row exists. That
        # raise was the bug that 500'd Begin Session once orphaned rows piled up.
        # They are marked "cancelled" (not "completed"), so abandoned sessions are
        # never billed; a CHW who wants to bill a session must Complete it (which
        # moves it to awaiting_documentation) before starting another.
        existing_result = await db.execute(
            select(Session).where(
                Session.chw_id == current_user.id,
                Session.status == "in_progress",
                Session.id != session_id,
            )
        )
        now_utc = datetime.now(UTC)
        for stale in existing_result.scalars().all():
            stale.status = "cancelled"
            if stale.ended_at is None:
                stale.ended_at = now_utc
            logging.getLogger("compass.sessions").info(
                "start_session: auto-cancelled abandoned in_progress session %s "
                "for chw %s when starting %s",
                stale.id, current_user.id, session_id,
            )

        session.status = "in_progress"
        session.started_at = now_utc
        await db.commit()
        await db.refresh(session)

        # NOTE: masked-call provisioning is intentionally NOT done here. The
        # Vonage proxy/CommunicationSession is created lazily when the CHW places
        # the call via POST /sessions/{id}/call. Starting a session only flips
        # status -> in_progress and stamps started_at. Validate the response
        # inside the try so any serialization error is surfaced too.
        return SessionResponse.model_validate(session)
    except HTTPException:
        # Expected, CORS-safe responses (404 / 409) pass through unchanged.
        raise
    except Exception as exc:
        # Roll back defensively; never let a broken-connection rollback mask the
        # real error below.
        try:
            await db.rollback()
        except Exception:  # noqa: BLE001, S110 — rollback failure must not mask the real error logged below
            pass
        logging.getLogger("compass.sessions").error(
            "start_session failed for session %s:\n%s",
            session_id,
            traceback.format_exc(),
        )
        raise HTTPException(
            status_code=500,
            detail=f"start_session failed: {type(exc).__name__}: {exc}",
        ) from exc


@router.patch("/{session_id}/complete", response_model=SessionResponse)
async def complete_session(session_id: UUID, current_user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    # #193 BE redirect (transitional, Task 11 server-side stand-in): when
    # session_per_call_enabled is on and the URL id is a stale completed
    # Session, swap to the conversation's active in_progress Session so the
    # FE-stuck-on-original-id submission still hits the right row.
    from app.config import settings as _settings
    from app.services.session_lookup import resolve_active_session_id_for_redirect
    if _settings.session_per_call_enabled:
        redirected = await resolve_active_session_id_for_redirect(
            db, requested_session_id=session_id,
        )
        if redirected != session_id:
            import logging
            logging.getLogger("compass").info(
                "complete_session: #193 BE redirect from %s to active=%s",
                session_id, redirected,
            )
            session_id = redirected

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

    # Close the communication session. Recording URL + transcript are NOT
    # fetched inline: the recording lands via the voice/events webhook, which
    # schedules finalize_recording (download → AssemblyAI batch transcription →
    # persist) as a background task; web sessions transcribe live over the
    # streaming socket. The old inline path called provider.get_transcript(),
    # a 30-120s synchronous poll that blocked this response — and was already
    # dead for Vonage (get_recording() returns None by design). Audit #16.
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
            comm_session.status = "closed"
            comm_session.closed_at = datetime.now(UTC)
    except Exception as e:
        import logging
        logging.getLogger("compass").warning("Failed to close communication session: %s", e)

    await db.commit()
    await db.refresh(session)
    return session


@router.post("/{session_id}/end", response_model=SessionResponse)
async def end_session(
    session_id: UUID,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SessionResponse:
    """POST /api/v1/sessions/{session_id}/end

    Terminates the active Vonage call bridge (if any) and transitions the
    session from ``in_progress`` → ``awaiting_documentation``, signalling the
    frontend to open the DocumentationModal.

    This is DISTINCT from ``/complete`` which finalises the documentation and
    billing claim.  The lifecycle is:

        scheduled → in_progress → awaiting_documentation → completed

    Relationship gate: only the CHW who owns the session may call this endpoint.
    Status guard: only ``in_progress`` sessions may be ended.

    Idempotency: calling this on a session already in ``awaiting_documentation``
    returns 200 with the current state rather than an error (the CHW may tap
    End Session more than once while offline/reconnecting).

    Vonage termination: the active ``CommunicationSession`` row is looked up and
    ``provider.end_proxy_session`` is called.  If no active comm session exists
    (the call ended naturally before the CHW tapped End Session) we log a
    warning and proceed — the status transition is still made.

    Errors:
      404 — session not found or caller is not the owning CHW
      409 — session is in a terminal state that cannot be ended
            (``completed`` or ``cancelled``)
    """
    import logging as _logging

    from app.models.audit import AuditLog
    from app.models.communication import CommunicationSession
    from app.services.communication import get_provider

    _log = _logging.getLogger("compass.sessions.end")

    # Relationship gate: reuse the existing CHW-ownership helper so we return
    # 404 (not 403) for both "not found" and "not your session" cases — this
    # avoids leaking the existence of sessions the caller cannot see.
    session = await _load_chw_session_or_404(
        session_id=session_id, db=db, current_user=current_user
    )

    # Idempotency: already in awaiting_documentation → return current state.
    if session.status == "awaiting_documentation":
        chw = await db.get(User, session.chw_id)
        member = await db.get(User, session.member_id)
        return SessionResponse.model_validate({
            **session.__dict__,
            "chw_name": chw.name if chw else None,
            "member_name": member.name if member else None,
        })

    # Terminal-state guard: completed/cancelled sessions cannot be ended.
    if session.status in ("completed", "cancelled"):
        raise HTTPException(
            status_code=409,
            detail=(
                f"Cannot end session with status '{session.status}'. "
                "Only 'in_progress' sessions can be ended."
            ),
        )

    # Status guard: reject anything that isn't in_progress (e.g. scheduled).
    if session.status != "in_progress":
        raise HTTPException(
            status_code=409,
            detail=(
                f"Cannot end session with status '{session.status}'. "
                "Session must be 'in_progress' to be ended."
            ),
        )

    # ── Vonage termination ────────────────────────────────────────────────────
    # Look up the active CommunicationSession row.  We deliberately wrap the
    # entire Vonage interaction in try/except — a provider outage or stale call
    # UUID must never block the status transition below.
    try:
        comm_result = await db.execute(
            select(CommunicationSession)
            .where(CommunicationSession.session_id == session_id)
            .where(CommunicationSession.status == "active")
            .order_by(CommunicationSession.created_at.desc())
            .limit(1)
        )
        comm_session = comm_result.scalar_one_or_none()

        if comm_session is not None:
            provider = get_provider()
            await provider.end_proxy_session(comm_session.provider_session_id)
            comm_session.status = "closed"
            comm_session.closed_at = datetime.now(UTC)
            _log.info(
                "end_session: terminated comm_session=%s provider_session=%s for session=%s",
                comm_session.id,
                comm_session.provider_session_id,
                session_id,
            )
        else:
            _log.warning(
                "end_session: no active CommunicationSession found for session=%s "
                "— call may have ended naturally; proceeding with status transition",
                session_id,
            )
    except Exception as vonage_err:  # noqa: BLE001
        _log.warning(
            "end_session: Vonage termination failed for session=%s (non-fatal): %s",
            session_id,
            vonage_err,
        )

    # ── Status transition ─────────────────────────────────────────────────────
    session.status = "awaiting_documentation"
    session.ended_at = datetime.now(UTC)
    if session.started_at:
        session.duration_minutes = int(
            (session.ended_at - session.started_at).total_seconds() / 60
        )
        from app.services.billing_service import calculate_units
        session.suggested_units = calculate_units(session.duration_minutes)

    db.add(
        AuditLog(
            user_id=current_user.id,
            action="session_end",
            resource="session",
            resource_id=str(session_id),
            details={
                "previous_status": "in_progress",
                "new_status": "awaiting_documentation",
            },
        )
    )

    await db.commit()
    await db.refresh(session)

    chw = await db.get(User, session.chw_id)
    member = await db.get(User, session.member_id)
    return SessionResponse.model_validate({
        **session.__dict__,
        "chw_name": chw.name if chw else None,
        "member_name": member.name if member else None,
    })


@router.patch("/{session_id}/abort", response_model=SessionResponse)
async def abort_session(
    session_id: UUID,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SessionResponse:
    """PATCH /api/v1/sessions/{session_id}/abort

    CHW aborts an ACTIVE session from the "Complete Session" confirm dialog's
    "Cancel Session" action. Unlike ``/end`` (which moves the session to
    ``awaiting_documentation`` so it can be documented + billed), abort throws
    the session away: it transitions ``in_progress`` / ``awaiting_documentation``
    → ``cancelled`` and creates NO documentation and NO billing claim.

    Distinct from ``PATCH /{id}/cancel`` (member/CHW cancelling a *scheduled*
    appointment) — abort is specifically for a session the CHW already started.

    Relationship gate: only the owning CHW (or an admin) may abort — a
    non-owner gets 404 so session existence isn't leaked.

    Idempotency: aborting an already-``cancelled`` session returns 200 with the
    current state.

    Errors:
      404 — session not found or caller is not the owning CHW
      409 — session is in a state that cannot be aborted (``scheduled`` —
            use ``/cancel`` — or ``completed``)
    """
    import logging as _logging

    from app.models.audit import AuditLog

    session = await _load_chw_session_or_404(
        session_id=session_id, db=db, current_user=current_user
    )

    # Idempotency: already cancelled → return current state.
    if session.status == "cancelled":
        chw = await db.get(User, session.chw_id)
        member = await db.get(User, session.member_id)
        return SessionResponse.model_validate({
            **session.__dict__,
            "chw_name": chw.name if chw else None,
            "member_name": member.name if member else None,
        })

    if session.status not in ("in_progress", "awaiting_documentation"):
        raise HTTPException(
            status_code=409,
            detail=(
                "Only an active session can be aborted. "
                "Use /cancel for a scheduled appointment."
            ),
        )

    previous_status = session.status
    session.status = "cancelled"
    if session.ended_at is None:
        session.ended_at = datetime.now(UTC)

    db.add(
        AuditLog(
            user_id=current_user.id,
            action="session_abort",
            resource="session",
            resource_id=str(session_id),
            details={"previous_status": previous_status, "new_status": "cancelled"},
        )
    )

    await db.commit()
    await db.refresh(session)

    _logging.getLogger("compass.sessions.abort").info(
        "session %s aborted by chw %s (was %s)",
        session_id, current_user.id, previous_status,
    )

    chw = await db.get(User, session.chw_id)
    member = await db.get(User, session.member_id)
    return SessionResponse.model_validate({
        **session.__dict__,
        "chw_name": chw.name if chw else None,
        "member_name": member.name if member else None,
    })


@router.patch("/{session_id}/no-show", response_model=SessionResponse)
async def mark_session_no_show(
    session_id: UUID,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SessionResponse:
    """PATCH /api/v1/sessions/{session_id}/no-show

    CHW marks an ACTIVE session as a no-show ("Missed") from the "Complete
    Session" confirm dialog / ActiveSessionBadge — the member didn't attend a
    session the CHW had already begun. Transitions ``in_progress`` →
    ``no_show`` and creates NO documentation and NO billing claim, exactly
    like ``/abort``.

    DISTINCT from ``/abort``: a ``no_show`` session is a terminal, RECORD-
    KEEPING status — it stays visible on the CHW/member calendar tagged
    "Missed" (badge derivation in CHWCalendarScreen/MemberCalendarScreen),
    whereas ``cancelled`` sessions vanish from the calendar grid entirely
    (Epic N1). Aborting throws the session away; no-show keeps a record that
    the CHW showed up and the member did not.

    Only allowed from ``in_progress`` — a member can't be a no-show for a
    session that never started (unlike abort, which also accepts
    ``awaiting_documentation``). 409 from ``scheduled``, ``completed``,
    ``cancelled``, or ``awaiting_documentation``.

    Relationship gate: only the owning CHW (or an admin) may mark a no-show —
    a non-owner gets 404 so session existence isn't leaked.

    Clears the active-session state the same way ``/abort`` does: flipping
    ``status`` away from ``in_progress`` means
    ``get_active_session_for_conversation`` (which filters on
    ``status == "in_progress"``) no longer returns this row, so the CHW
    Messages timer/ActiveSessionBadge disappear on the next refetch — no
    separate "clear" step is needed.

    Errors:
      404 — session not found or caller is not the owning CHW
      409 — session is not ``in_progress`` (e.g. ``scheduled`` — the member
            can't be a no-show for a session that never started; or
            ``awaiting_documentation``/``completed``/``cancelled``)
    """
    import logging as _logging

    from app.models.audit import AuditLog

    session = await _load_chw_session_or_404(
        session_id=session_id, db=db, current_user=current_user
    )

    if session.status != "in_progress":
        raise HTTPException(
            status_code=409,
            detail=(
                f"Cannot mark session with status '{session.status}' as a "
                "no-show. Only an 'in_progress' session can be marked Missed."
            ),
        )

    previous_status = session.status
    session.status = "no_show"
    if session.ended_at is None:
        session.ended_at = datetime.now(UTC)

    db.add(
        AuditLog(
            user_id=current_user.id,
            action="session_no_show",
            resource="session",
            resource_id=str(session_id),
            details={"previous_status": previous_status, "new_status": "no_show"},
        )
    )

    await db.commit()
    await db.refresh(session)

    _logging.getLogger("compass.sessions.no_show").info(
        "session %s marked no_show by chw %s (was %s)",
        session_id, current_user.id, previous_status,
    )

    chw = await db.get(User, session.chw_id)
    member = await db.get(User, session.member_id)
    return SessionResponse.model_validate({
        **session.__dict__,
        "chw_name": chw.name if chw else None,
        "member_name": member.name if member else None,
    })


async def _run_extraction_in_background(session_id: UUID) -> None:
    """Run LLM follow-up extraction in a fresh DB session, fire-and-forget.

    Called by ``submit_documentation`` after the request returns so the CHW
    sees a fast 200, while the (potentially slow) AssemblyAI LeMUR pass
    runs out-of-band and pre-populates ``session_followups`` rows for the
    Roadmap / Followups review screen.

    The service is idempotent — if extraction has already run for this
    session it returns the cached rows without a second LLM call. Any
    exception is caught and logged; the user-facing flow has already
    committed, so we never want a transcription provider hiccup to surface
    as a 5xx on the documentation submit.
    """
    import logging

    from app.database import async_session as _async_session_factory
    from app.services.followup_extraction import extract_session_followups

    logger = logging.getLogger("compass.sessions.bg_extract")
    try:
        async with _async_session_factory() as bg_db:
            rows = await extract_session_followups(session_id, bg_db)
        logger.info(
            "Background followup extraction complete for session %s: %d rows",
            session_id, len(rows),
        )
    except Exception as e:  # noqa: BLE001
        logger.warning(
            "Background followup extraction failed for session %s: %s",
            session_id, e,
        )


@router.post("/{session_id}/documentation")
async def submit_documentation(
    session_id: UUID,
    data: SessionDocumentationSubmit,
    background_tasks: BackgroundTasks,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # #193 BE redirect (transitional, Task 11 server-side stand-in): when
    # session_per_call_enabled is on and the URL id is a stale Session that
    # already has a SessionDocumentation row, swap to the conversation's
    # active in_progress Session so the FE-stuck-on-original-id submission
    # creates a doc on the right (fresh) Session.
    from app.config import settings as _settings
    from app.services.session_lookup import resolve_active_session_id_for_redirect
    if _settings.session_per_call_enabled:
        redirected = await resolve_active_session_id_for_redirect(
            db, requested_session_id=session_id,
        )
        if redirected != session_id:
            import logging
            logging.getLogger("compass").info(
                "submit_documentation: #193 BE redirect from %s to active=%s",
                session_id, redirected,
            )
            session_id = redirected

    session = await db.get(Session, session_id)
    if not session or session.chw_id != current_user.id:
        raise HTTPException(status_code=404, detail="Session not found")

    existing = await db.execute(select(SessionDocumentation).where(SessionDocumentation.session_id == session_id))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Documentation already submitted for this session")

    # Units are always computed server-side from a duration (never trusted as a
    # raw count from the client) — this preserves the anti-upcoding guarantee.
    # The DURATION source, however, is now the CHW-entered start/end times when
    # both are supplied on the documentation screen (product decision: the CHW
    # edits the actual session window before filing). When they're absent we
    # fall back to the session's server-tracked duration (legacy/clients that
    # don't send times). The entered window is validated and audit-logged
    # against the server-tracked times so any adjustment is traceable.
    from app.services.billing_service import calculate_units

    entered_start = data.session_start_time
    entered_end = data.session_end_time
    if entered_start is not None and entered_end is not None:
        # Normalize to aware UTC for a correct delta regardless of client tz.
        if entered_start.tzinfo is None:
            entered_start = entered_start.replace(tzinfo=UTC)
        if entered_end.tzinfo is None:
            entered_end = entered_end.replace(tzinfo=UTC)
        if entered_end <= entered_start:
            raise HTTPException(
                status_code=422,
                detail="Session end time must be after the start time.",
            )
        duration_minutes: int | None = int(
            (entered_end - entered_start).total_seconds() / 60
        )
        import logging as _logging

        _logging.getLogger("compass").info(
            "submit_documentation: CHW-entered session window for %s — "
            "entered=[%s, %s] (%dmin) vs tracked=[%s, %s] (%smin)",
            session_id, entered_start.isoformat(), entered_end.isoformat(),
            duration_minutes, session.started_at, session.ended_at,
            session.duration_minutes,
        )
        # Persist the CHW-adjusted window as the session's authoritative times
        # so downstream (Earnings Session Detail, service_date, reporting) all
        # agree with what was billed.
        session.started_at = entered_start
        session.ended_at = entered_end
        session.duration_minutes = duration_minutes
    else:
        duration_minutes = session.duration_minutes

    computed_units = calculate_units(duration_minutes)

    errors = validate_claim(data.diagnosis_codes, data.procedure_code, computed_units)
    if errors:
        raise HTTPException(status_code=422, detail=errors)

    session_date = (session.started_at or session.created_at).date()
    caps = await check_unit_caps(db, session.chw_id, session.member_id, session_date)
    if computed_units > caps["daily_remaining"]:
        raise HTTPException(status_code=422, detail=f"Daily unit cap exceeded. {caps['daily_remaining']} units remaining today.")
    if computed_units > caps["yearly_remaining"]:
        raise HTTPException(status_code=422, detail=f"Yearly unit cap exceeded. {caps['yearly_remaining']} units remaining this year.")

    doc = SessionDocumentation(
        session_id=session_id,
        summary=data.summary,
        resources_referred=data.resources_referred,
        member_goals=data.member_goals,
        follow_up_needed=data.follow_up_needed,
        follow_up_date=data.follow_up_date,
        diagnosis_codes=data.diagnosis_codes,
        procedure_code=data.procedure_code,
        units_to_bill=computed_units,
        members_served=data.members_served,
        # AI summary provenance — persisted so audit trails can distinguish
        # the AI-generated draft from the CHW-authored note permanently.
        ai_summary=data.ai_summary,
        ai_summary_generated_at=data.ai_summary_generated_at,
        ai_summary_excluded=data.ai_summary_excluded,
    )
    db.add(doc)

    earnings = calculate_earnings(computed_units)
    claim = BillingClaim(
        session_id=session_id, chw_id=session.chw_id, member_id=session.member_id,
        diagnosis_codes=data.diagnosis_codes, procedure_code=data.procedure_code,
        units=computed_units, gross_amount=earnings["gross"],
        platform_fee=earnings["platform_fee"], pear_suite_fee=earnings["pear_suite_fee"],
        net_payout=earnings["net"],
        service_date=session_date,
    )
    db.add(claim)

    session.units_billed = computed_units
    session.gross_amount = earnings["gross"]
    session.net_amount = earnings["net"]
    # Submitting documentation is the final step of the CHW session flow
    # (Complete Session → /end → awaiting_documentation → /documentation), so it
    # completes the session. Without this the session stays stuck in
    # awaiting_documentation and the CHW's "Complete Session" button never flips
    # back to "Begin Session". Guard against resurrecting a cancelled or
    # already-completed session.
    if session.status in ("awaiting_documentation", "in_progress"):
        session.status = "completed"
    await db.commit()
    await db.refresh(claim)

    # Submit claim to Pear Suite for Medi-Cal processing (async, non-blocking).
    # Failures here do NOT fail the request — the claim is persisted locally and
    # can be resubmitted from an admin job. This is the correct boundary because:
    #   - We always want local source of truth even if Pear Suite is down
    #   - CHW already completed the work; don't make them retry documentation
    #   - Retries should happen in a separate worker that reads `status='pending'`
    #
    # We hydrate four Pear identifiers into ClaimSubmission.extra so that
    # PearSuiteProvider.submit_claim() can orchestrate sync -> schedule ->
    # complete (with cost_id) -> generate end-to-end without needing any DB
    # access of its own:
    #   1. pear_suite_member_id         — set by ensure_member_synced (idempotent)
    #   2. pear_suite_chw_user_id       — read from CHWProfile (set per CHW via admin)
    #   3. pear_suite_activity_template_id — looked up in PearSuiteTemplateMap by CPT
    #   4. cost_id                      — resolved from MemberProfile.insurance_company
    from decimal import Decimal as _Dec

    from app.models.billing import PearSuiteTemplateMap
    from app.models.user import CHWProfile, MemberProfile, User
    from app.services.billing import ClaimSubmission, get_billing_provider
    from app.services.billing.pear_cost_ids import resolve_cost_id
    from app.services.pear_suite_member_sync import ensure_member_synced

    try:
        provider = get_billing_provider()

        # Load member + CHW profiles for the Pear identifiers.
        member_user = await db.get(User, session.member_id)
        member_profile_row = (await db.execute(
            select(MemberProfile).where(MemberProfile.user_id == session.member_id)
        )).scalar_one_or_none()
        chw_profile_row = (await db.execute(
            select(CHWProfile).where(CHWProfile.user_id == session.chw_id)
        )).scalar_one_or_none()
        chw_user = await db.get(User, session.chw_id)
        template_row = (await db.execute(
            select(PearSuiteTemplateMap).where(
                PearSuiteTemplateMap.cpt_code == data.procedure_code
            )
        )).scalar_one_or_none()

        # ── Pear bulk-upload CSV row (sandbox + future prod parallel) ──
        # When billing_csv_enabled, append a row to the rolling monthly
        # CSV in S3 so ops can bulk-upload to Pear (workaround until
        # Pear's API accepts the full field set).  This runs BEFORE the
        # Pear API call so a Pear outage doesn't block the CSV write —
        # the CSV is the canonical billing artifact on this path.
        from app.config import settings as _settings
        if _settings.billing_csv_enabled and member_profile_row and member_user:
            try:
                from app.models.communication import CommunicationSession
                from app.services.billing_csv_writer import append_row, build_row_from_models

                # Pull the most recent CommunicationSession for this Session
                # — its created_at is "when the call connected", which is
                # the right Activity Start Time for billing (vs the chat
                # thread's started_at, which can be days older). Falls back
                # to None for in-person sessions with no call leg; the
                # writer then defaults to Session.started_at.
                latest_comm = (
                    await db.execute(
                        select(CommunicationSession)
                        .where(CommunicationSession.session_id == session_id)
                        .order_by(CommunicationSession.created_at.desc())
                        .limit(1)
                    )
                ).scalar_one_or_none()

                csv_row = build_row_from_models(
                    claim=claim,
                    session=session,
                    member_user=member_user,
                    member_profile=member_profile_row,
                    chw_user=chw_user,
                    documentation=doc,
                    consent_given=session.recording_consent_given_at is not None,
                    communication_session=latest_comm,
                )
                # Environment prefix: "prod" when Pear API is also on, else "sandbox".
                # Lets a single bucket host both worlds cleanly.
                env_prefix = "prod" if _settings.pear_suite_enabled else "sandbox"
                append_row(csv_row, environment=env_prefix)
            except Exception as csv_err:  # noqa: BLE001
                import logging as _lg
                _lg.getLogger("compass").warning(
                    "billing CSV append failed (non-fatal, retryable from admin): %s",
                    csv_err,
                )

        # Skip the entire Pear API chain when disabled (sandbox uses CSV only).
        # Using a flag rather than ``return`` so the follow-up extraction
        # background task below the try-block still gets scheduled — only
        # the Pear network calls are gated, not the post-documentation
        # workflow.
        if _settings.pear_suite_enabled:
            # Ensure the member exists in Pear (idempotent; no-op when already synced).
            # Best-effort: if this raises we still attempt the rest so the error
            # surfaces in provider.submit_claim() with the precise missing-id message.
            if member_profile_row and member_user:
                try:
                    await ensure_member_synced(db, member_profile_row, member_user)
                except Exception as sync_err:  # noqa: BLE001
                    import logging as _lg
                    _lg.getLogger("compass").warning(
                        "Pear member sync failed pre-claim: %s", sync_err
                    )

            # Resolve cost_id from member's insurance carrier.
            cost_id = resolve_cost_id(
                member_profile_row.insurance_company if member_profile_row else None,
                procedure_code=data.procedure_code,
            ) if member_profile_row else None

            claim_submission = ClaimSubmission(
                session_id=session_id,
                chw_id=session.chw_id,
                member_id=session.member_id,
                service_date=session_date,
                procedure_code=data.procedure_code,
                modifier=claim.modifier or "U2",
                diagnosis_codes=data.diagnosis_codes,
                units=computed_units,
                gross_amount=_Dec(str(earnings["gross"])),
            )
            claim_submission.extra = {
                "pear_suite_member_id":            (member_profile_row.pear_suite_member_id if member_profile_row else None),
                "pear_suite_chw_user_id":          (chw_profile_row.pear_suite_user_id if chw_profile_row else None),
                "pear_suite_activity_template_id": (template_row.template_id if template_row else None),
                "cost_id":                         cost_id,
            }

            result = await provider.submit_claim(claim_submission)
            if result.success and result.provider_claim_id:
                claim.pear_suite_claim_id = result.provider_claim_id
                claim.status = result.status
                from datetime import UTC as _UTC
                from datetime import datetime as _dt
                claim.submitted_at = _dt.now(_UTC)
                await db.commit()
    except Exception as e:  # noqa: BLE001
        import logging
        logging.getLogger("compass").warning("Pear Suite claim submission deferred: %s", e)

    # Auto-trigger follow-up extraction in the background. Fires AFTER the
    # response is sent, so the CHW gets a fast 200 and the LLM call doesn't
    # gate the documentation save. Idempotent at the service layer — if the
    # CHW manually re-runs extraction later the existing rows are returned
    # rather than duplicated. See _run_extraction_in_background above.
    background_tasks.add_task(_run_extraction_in_background, session_id)

    return {"documentation_id": str(doc.id), "claim_id": str(claim.id), "earnings": earnings}


@router.post("/{session_id}/consent")
async def submit_consent(session_id: UUID, data: ConsentSubmit, request: Request, current_user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Record consent for a session.

    Two valid callers:
      - The session member (member_id matches current_user) — direct consent.
      - The session CHW (chw_id matches current_user) when ``chw_attestation``
        is True — attests that the member gave verbal consent on the call.
        Required for single-device demo / phone-call flows where the member
        does not have the app open to tap Approve themselves. The audit
        layer (HTTP middleware) records the CHW's identity, IP, and UA
        on the row so the attestation is reviewable.
    """
    session = await db.get(Session, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    is_member_self = session.member_id == current_user.id
    is_chw_attesting = (
        data.chw_attestation
        and session.chw_id == current_user.id
        and data.consent_type == "ai_transcription"
    )
    if not (is_member_self or is_chw_attesting):
        raise HTTPException(
            status_code=403,
            detail=(
                "Only the session member can submit consent, or the session "
                "CHW with chw_attestation=true for ai_transcription."
            ),
        )

    consent = MemberConsent(
        session_id=session_id,
        # member_id is always the member of record on the consent row, even
        # when the CHW attests on their behalf. The audit trail captures
        # who actually performed the POST via IP + UA.
        member_id=session.member_id,
        consent_type=data.consent_type,
        typed_signature=data.typed_signature,
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
    )
    db.add(consent)
    await db.commit()
    return {"consent_id": str(consent.id), "chw_attested": is_chw_attesting}


# ─── Two-party consent request flow ─────────────────────────────────────────
#
# HIPAA + California Penal Code §632 compliance
# -----------------------------------------------
# California §632 requires *all* parties to an in-person or telephone
# conversation to affirmatively consent before audio is recorded.  The
# existing /consent endpoint supports CHW attestation (verbal consent given
# by phone) as a fallback, but it does not capture the member's own in-app
# tap.  These six endpoints implement the full digital two-party consent loop:
#
#   1. CHW creates a ConsentRequest row (status=pending).
#   2. Member's app polls for pending requests and renders an approval modal.
#   3. Member approves → MemberConsent row is created with member's own user ID.
#   4. Member denies  → ConsentRequest.status = "denied"; no MemberConsent row.
#   5. CHW can cancel the outstanding request (e.g. they close the modal).
#   6. Either party can read the request status for polling.
#
# Expiry (5 min TTL) prevents stale pending rows from bypassing future consent
# decisions without any background worker — we check expires_at at read time.
#
# Audit trail: the HTTP audit middleware records IP + UA + timestamp on every
# mutating call.  The MemberConsent row created via approve carries
# member_id = the member's own user ID (not chw_id), typed_signature, IP,
# and UA — satisfying HIPAA "individual authorization" documentation.

_CONSENT_REQUEST_TTL_MINUTES = 5


@router.post(
    "/{session_id}/consent-requests",
    response_model=ConsentRequestResponse,
    status_code=201,
    summary="CHW requests in-app recording consent from the member",
)
async def create_consent_request(
    session_id: UUID,
    data: ConsentRequestCreate,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ConsentRequestResponse:
    """POST /api/v1/sessions/{session_id}/consent-requests

    Creates a pending ConsentRequest row that the member's app polls for.
    Only the CHW on the session may call this endpoint.

    Errors:
      404 — session not found
      403 — caller is not the CHW on this session
      409 — there is already an active pending consent request for this
             session + consent_type (prevents duplicate modal spam)
    """
    session = await db.get(Session, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.chw_id != current_user.id:
        raise HTTPException(
            status_code=403,
            detail="Only the CHW on this session may request recording consent.",
        )

    # Guard: reject if there is already a non-terminal pending request.
    existing_result = await db.execute(
        select(ConsentRequest).where(
            ConsentRequest.session_id == session_id,
            ConsentRequest.consent_type == data.consent_type,
            ConsentRequest.status == "pending",
        )
    )
    existing = existing_result.scalar_one_or_none()
    if existing is not None:
        # If the existing row has already expired by TTL, treat it as gone and
        # let the CHW create a fresh one.
        now = datetime.now(UTC)
        if not existing.is_expired(now):
            raise HTTPException(
                status_code=409,
                detail=(
                    "A consent request is already pending for this session. "
                    "Cancel it before creating a new one, or wait for the member to respond."
                ),
            )
        # Expired — mark it so and proceed to create a new row.
        existing.status = "expired"
        existing.responded_at = now

    now = datetime.now(UTC)
    consent_request = ConsentRequest(
        session_id=session_id,
        chw_id=current_user.id,
        member_id=session.member_id,
        consent_type=data.consent_type,
        status="pending",
        requested_at=now,
        expires_at=now + timedelta(minutes=_CONSENT_REQUEST_TTL_MINUTES),
    )
    db.add(consent_request)
    await db.commit()
    await db.refresh(consent_request)
    return ConsentRequestResponse.model_validate(consent_request)


@router.get(
    "/{session_id}/pending-consents",
    response_model=list[ConsentRequestResponse],
    summary="Member polls for pending recording consent requests",
)
async def list_pending_consents(
    session_id: UUID,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[ConsentRequestResponse]:
    """GET /api/v1/sessions/{session_id}/pending-consents

    Returns all pending (non-expired) ConsentRequest rows for this session
    addressed to the calling member.  Polled every 3 seconds by the member's
    SessionChat while the session is in_progress.

    Only the session member may call this endpoint (403 otherwise).

    Expired requests are transparently upgraded to status="expired" on the
    first read after their TTL elapses, so the member never sees a stale modal.
    """
    session = await db.get(Session, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.member_id != current_user.id:
        raise HTTPException(
            status_code=403,
            detail="Only the session member may view pending consent requests.",
        )

    result = await db.execute(
        select(ConsentRequest).where(
            ConsentRequest.session_id == session_id,
            ConsentRequest.member_id == current_user.id,
            ConsentRequest.status == "pending",
        ).order_by(ConsentRequest.requested_at.desc())
    )
    rows = result.scalars().all()

    # Expire stale rows in-place (lazy expiry — no background job needed).
    now = datetime.now(UTC)
    active: list[ConsentRequest] = []
    for row in rows:
        if row.is_expired(now):
            row.status = "expired"
            row.responded_at = now
        else:
            active.append(row)

    if len(rows) != len(active):
        await db.commit()

    return [ConsentRequestResponse.model_validate(r) for r in active]


# ── Consent-request operations (not session-scoped) ───────────────────────────

_consent_request_router = APIRouter(
    prefix="/api/v1/consent-requests",
    tags=["consent-requests"],
)


@_consent_request_router.get(
    "/{request_id}",
    response_model=ConsentRequestResponse,
    summary="Get the current status of a consent request (CHW polling)",
)
async def get_consent_request(
    request_id: UUID,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ConsentRequestResponse:
    """GET /api/v1/consent-requests/{request_id}

    Returns the single ConsentRequest row.  Both the CHW (who polls for
    approval/denial) and the member (who needs the row to render the modal)
    may call this endpoint.

    Lazy expiry: if the request is still "pending" but has passed its TTL,
    it is marked "expired" before returning.
    """
    consent_req = await db.get(ConsentRequest, request_id)
    if not consent_req:
        raise HTTPException(status_code=404, detail="Consent request not found")

    is_participant = (
        current_user.id == consent_req.chw_id
        or current_user.id == consent_req.member_id
    )
    if not is_participant and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Not authorized to view this consent request")

    now = datetime.now(UTC)
    if consent_req.is_expired(now):
        consent_req.status = "expired"
        consent_req.responded_at = now
        await db.commit()

    return ConsentRequestResponse.model_validate(consent_req)


@_consent_request_router.post(
    "/{request_id}/approve",
    response_model=ConsentRequestResponse,
    summary="Member approves the recording consent request",
)
async def approve_consent_request(
    request_id: UUID,
    data: ConsentRequestApprove,
    request: Request,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ConsentRequestResponse:
    """POST /api/v1/consent-requests/{request_id}/approve

    Member-only.  Marks the ConsentRequest approved and creates a MemberConsent
    row with:
      - member_id = current_user.id   (the actual member, NOT a CHW surrogate)
      - typed_signature = data.typed_signature
      - ip_address / user_agent from the HTTP request (audit trail)

    The resulting MemberConsent row satisfies both:
      - HIPAA 45 CFR §164.508 "individual authorization" (member signs themselves)
      - California Penal Code §632 two-party consent (member taps Approve)

    Errors:
      404 — request not found
      403 — caller is not the session member
      409 — request is not in "pending" status (already approved/denied/cancelled/expired)
    """
    consent_req = await db.get(ConsentRequest, request_id)
    if not consent_req:
        raise HTTPException(status_code=404, detail="Consent request not found")
    if consent_req.member_id != current_user.id:
        raise HTTPException(
            status_code=403,
            detail="Only the session member may approve a consent request.",
        )

    now = datetime.now(UTC)
    if consent_req.is_expired(now):
        consent_req.status = "expired"
        consent_req.responded_at = now
        await db.commit()
        raise HTTPException(status_code=409, detail="This consent request has expired.")

    if consent_req.status != "pending":
        raise HTTPException(
            status_code=409,
            detail=f"Cannot approve a consent request with status '{consent_req.status}'.",
        )

    consent_req.status = "approved"
    consent_req.responded_at = now

    # Create the real MemberConsent row — member_id is the member's own user ID.
    # This is categorically distinct from a CHW attestation row.
    member_consent = MemberConsent(
        session_id=consent_req.session_id,
        member_id=current_user.id,
        consent_type=consent_req.consent_type,
        typed_signature=data.typed_signature,
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
    )
    db.add(member_consent)
    await db.commit()
    await db.refresh(consent_req)
    return ConsentRequestResponse.model_validate(consent_req)


@_consent_request_router.post(
    "/{request_id}/deny",
    response_model=ConsentRequestResponse,
    summary="Member denies the recording consent request",
)
async def deny_consent_request(
    request_id: UUID,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ConsentRequestResponse:
    """POST /api/v1/consent-requests/{request_id}/deny

    Member-only.  Marks the ConsentRequest denied.  No MemberConsent row is
    created.  The denial is final for this request — the CHW must create a new
    ConsentRequest to ask again (ensuring the member always sees a fresh modal
    with accurate disclosure rather than retrying silently).

    Errors:
      404 — request not found
      403 — caller is not the session member
      409 — request is not in "pending" status
    """
    consent_req = await db.get(ConsentRequest, request_id)
    if not consent_req:
        raise HTTPException(status_code=404, detail="Consent request not found")
    if consent_req.member_id != current_user.id:
        raise HTTPException(
            status_code=403,
            detail="Only the session member may deny a consent request.",
        )

    now = datetime.now(UTC)
    if consent_req.is_expired(now):
        consent_req.status = "expired"
        consent_req.responded_at = now
        await db.commit()
        raise HTTPException(status_code=409, detail="This consent request has already expired.")

    if consent_req.status != "pending":
        raise HTTPException(
            status_code=409,
            detail=f"Cannot deny a consent request with status '{consent_req.status}'.",
        )

    consent_req.status = "denied"
    consent_req.responded_at = now
    await db.commit()
    await db.refresh(consent_req)
    return ConsentRequestResponse.model_validate(consent_req)


@_consent_request_router.post(
    "/{request_id}/cancel",
    response_model=ConsentRequestResponse,
    summary="CHW cancels an outstanding consent request",
)
async def cancel_consent_request(
    request_id: UUID,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ConsentRequestResponse:
    """POST /api/v1/consent-requests/{request_id}/cancel

    CHW-only.  Marks the ConsentRequest cancelled.  Called when the CHW closes
    the "Waiting for member…" modal before the member responds.  Prevents the
    member from seeing a stale modal after the CHW has given up.

    Errors:
      404 — request not found
      403 — caller is not the CHW who created the request
      409 — request is not in "pending" status
    """
    consent_req = await db.get(ConsentRequest, request_id)
    if not consent_req:
        raise HTTPException(status_code=404, detail="Consent request not found")
    if consent_req.chw_id != current_user.id:
        raise HTTPException(
            status_code=403,
            detail="Only the CHW who created this request may cancel it.",
        )
    if consent_req.status != "pending":
        raise HTTPException(
            status_code=409,
            detail=f"Cannot cancel a consent request with status '{consent_req.status}'.",
        )

    now = datetime.now(UTC)
    consent_req.status = "cancelled"
    consent_req.responded_at = now
    await db.commit()
    await db.refresh(consent_req)
    return ConsentRequestResponse.model_validate(consent_req)


# ─── Device-audio-capture consent helper ─────────────────────────────────────
#
# `device_audio_capture` consent is per-CHW-relationship, not per-session.
# The member grants it once; the grant persists across all future sessions with
# the same CHW.  The helper looks at the most recent device_audio_capture
# MemberConsent row for any session this member has ever had with this CHW.
#
# Why not per-session?  The UX spec says "once per CHW relationship" — the
# member should never be asked twice for the same CHW.  A new session with a
# different CHW would correctly surface the modal again because no prior grant
# exists for that pairing.
#
# HIPAA: this helper performs a DB read of metadata only (no PHI) and is safe
# to call from any participant-authenticated endpoint.


async def member_has_device_audio_consent(
    member_id: UUID,
    chw_id: UUID,
    db: AsyncSession,
) -> bool:
    """Return True when the member has granted device_audio_capture consent
    for any past session with this CHW.

    Implements the "once per CHW relationship" semantics: a single grant on
    any historical session is sufficient to skip the opt-in modal for all
    subsequent sessions with the same CHW.

    The query joins MemberConsent → Session to scope the look-up by both
    member_id (on the consent row) and chw_id (on the session row), so a
    consent granted with a different CHW is never considered valid here.

    Args:
        member_id: UUID of the member whose consent state is being checked.
        chw_id:    UUID of the CHW for whom we're checking this pairing.
        db:        Active async database session.

    Returns:
        True if at least one matching device_audio_capture consent row exists.
    """
    from app.models.session import Session as _Session

    result = await db.execute(
        select(MemberConsent)
        .join(_Session, MemberConsent.session_id == _Session.id)
        .where(
            MemberConsent.member_id == member_id,
            MemberConsent.consent_type == "device_audio_capture",
            _Session.chw_id == chw_id,
        )
        .limit(1)
    )
    return result.scalar_one_or_none() is not None


@router.get(
    "/{session_id}/consents",
    summary="List all consent records for a session",
    description=(
        "Returns all MemberConsent rows recorded for this session.  "
        "Accessible to either participant (CHW or member).  Used by the member "
        "side to check whether device_audio_capture consent has already been "
        "granted for the CHW on this session's relationship."
    ),
)
async def list_session_consents(
    session_id: UUID,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    """GET /api/v1/sessions/{session_id}/consents

    Returns the ordered list of all MemberConsent rows for this session.
    Each entry exposes:
      - consent_type  (e.g. "ai_transcription", "device_audio_capture")
      - consented_at  (ISO-8601 UTC timestamp)
      - member_id     (UUID of the member who consented)

    Additionally, for device_audio_capture rows, the response includes:
      - chw_audio_consent_active (bool) — whether the member has a
        device_audio_capture grant for any session with this session's CHW.
        This allows the frontend to skip the opt-in modal on subsequent sessions.

    HIPAA: typed_signature, ip_address, and user_agent are intentionally
    excluded from this response — they are HIPAA-sensitive audit fields that
    should only be surfaced through the admin audit log, not the client API.
    """
    session = await db.get(Session, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    is_participant = (
        current_user.id == session.chw_id
        or current_user.id == session.member_id
    )
    if not is_participant and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Not a participant on this session")

    result = await db.execute(
        select(MemberConsent)
        .where(MemberConsent.session_id == session_id)
        .order_by(MemberConsent.consented_at.asc())
    )
    rows = result.scalars().all()

    # Pre-compute CHW-relationship device-audio consent once (avoids N+1 for
    # multi-consent sessions).  Only relevant when at least one
    # device_audio_capture row exists.
    chw_audio_consent_active = await member_has_device_audio_consent(
        member_id=session.member_id,
        chw_id=session.chw_id,
        db=db,
    )

    return [
        {
            "id": str(row.id),
            "session_id": str(row.session_id),
            "member_id": str(row.member_id),
            "consent_type": row.consent_type,
            "consented_at": row.consented_at.isoformat(),
            # Convenience field: did this member grant device audio consent for
            # any session with this CHW?  Always populated; most relevant when
            # consent_type == "device_audio_capture".
            "chw_audio_consent_active": chw_audio_consent_active,
        }
        for row in rows
    ]


# ─── Transcript replay ───────────────────────────────────────────────────────
#
# GET /sessions/{id}/transcript returns all persisted final transcript chunks
# for a session, ordered by created_at.  Used for post-session replay and as
# input to the follow-up extraction pipeline.
#
# Auth: CHW or member on the session, or bearer of the admin API key.
# HIPAA: transcript text is PHI.  The audit middleware logs access at the HTTP
#   layer; this handler deliberately does NOT log any chunk content.


@router.get(
    "/{session_id}/transcript",
    response_model=TranscriptResponse,
    summary="Fetch persisted transcript chunks for a session",
    description=(
        "Returns all final transcript chunks stored during the session, ordered "
        "oldest-first by created_at.  Auth: CHW or member on the session, or "
        "admin API key.  Transcript text is PHI — access is audit-logged."
    ),
)
async def get_session_transcript(
    session_id: UUID,
    credentials: "HTTPAuthorizationCredentials" = Depends(HTTPBearer()),
    db: AsyncSession = Depends(get_db),
) -> TranscriptResponse:
    """GET /api/v1/sessions/{session_id}/transcript

    Returns the full ordered list of final transcript chunks for the session.
    Partial chunks (is_final=False) are never persisted and therefore never
    returned here.

    HIPAA: chunk text is PHI.  Never log chunk content inside this handler.
    The audit middleware will record the access event including session_id and
    caller identity.
    """
    import hmac

    from app.config import settings
    from app.models.session import SessionTranscript
    from app.models.user import User
    from app.schemas.session import TranscriptChunkResponse
    from app.utils.security import decode_token

    token = credentials.credentials

    # Admin key path — checked first so ops tooling works without a user JWT.
    if hmac.compare_digest(token, settings.admin_key):
        actor_user_id: UUID | None = None
        actor_role = "admin"
        session = await db.get(Session, session_id)
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
    else:
        # User JWT path.
        payload = decode_token(token)
        if payload is None or payload.get("type") != "access":
            raise HTTPException(status_code=401, detail="Invalid or expired token")

        user_id_str = payload.get("sub")
        if user_id_str is None:
            raise HTTPException(status_code=401, detail="Invalid token payload")

        result = await db.execute(select(User).where(User.id == UUID(user_id_str)))
        user = result.scalar_one_or_none()
        if user is None or not user.is_active:
            raise HTTPException(status_code=401, detail="User not found or inactive")

        session = await db.get(Session, session_id)
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")

        is_participant = user.id == session.chw_id or user.id == session.member_id
        if not is_participant and user.role != "admin":
            raise HTTPException(status_code=403, detail="Not a participant on this session")
        actor_user_id = user.id
        actor_role = user.role

    chunk_result = await db.execute(
        select(SessionTranscript)
        .where(SessionTranscript.session_id == session_id)
        .order_by(SessionTranscript.created_at.asc())
    )
    chunks = chunk_result.scalars().all()

    # HIPAA §164.312(b): record the PHI read (transcript text is PHI).
    from app.services.audit import record_phi_read

    await record_phi_read(
        actor_user_id=actor_user_id,
        resource="session_transcript",
        resource_id=str(session_id),
        details={"chunk_count": len(chunks), "actor_role": actor_role},
    )

    return TranscriptResponse(
        session_id=session_id,
        chunks=[TranscriptChunkResponse.model_validate(c) for c in chunks],
        total=len(chunks),
    )


# ─── Session-scoped messaging ─────────────────────────────────────────────────
#
# Design rationale: ``Conversation`` already carries a nullable ``session_id``
# FK.  Rather than adding a separate "session_message" model, we lazily create
# one Conversation per Session (enforced by a unique constraint on
# ``conversations.session_id``) and reuse the existing Message table.
# The endpoints live under /sessions/{id}/ so mobile routing is intuitive,
# but the storage layer is the shared Conversation/Message schema — keeping
# general DMs (session_id=NULL) and session chat in the same table with no
# structural duplication.


async def _get_session_and_assert_participant(
    session_id: UUID,
    current_user,
    db: AsyncSession,
) -> Session:
    """Fetch the session and verify the caller is the CHW, member, or admin.

    Raises 404 if the session does not exist, 403 if the caller is not a
    participant (admin role bypasses the participant check for ops access).
    """
    session = await db.get(Session, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    is_participant = (
        current_user.id == session.chw_id
        or current_user.id == session.member_id
    )
    if not is_participant and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Not a participant on this session")
    return session


async def _get_or_create_session_conversation(
    session: Session,
    db: AsyncSession,
):
    """Return the Conversation for this Session's (chw, member) pair, creating
    it if absent.

    Post-#193, Conversation is the long-lived chat thread between a CHW and a
    member — many Sessions belong to one Conversation. This helper delegates
    to ``find_or_create_conversation_for_pair`` so the (chw, member) lookup is
    the canonical one. The first time a Conversation is created for a pair we
    also stamp its ``session_id`` back-link to the Session that opened it —
    legacy callers still read ``Conversation.session_id`` and we don't want to
    break them during the rollout. Subsequent Sessions in the same pair don't
    overwrite that back-link.

    Race note: the underlying helper has a SELECT-then-INSERT pattern with no
    DB-level lock. Concurrent calls for the same (chw, member) pair can both
    INSERT, producing a duplicate Conversation row. A follow-up adds
    ``UNIQUE (chw_id, member_id)`` on ``conversations`` so the insert can be
    a proper upsert; tracked as a sibling cleanup task to #193.
    """
    from app.services.session_lookup import find_or_create_conversation_for_pair

    conv = await find_or_create_conversation_for_pair(
        db, chw_id=session.chw_id, member_id=session.member_id,
    )
    # Preserve the legacy back-link for callers that still read
    # Conversation.session_id. Only set it when absent so the originating
    # Session stays sticky; subsequent calls in the same thread don't
    # rewrite it.
    if conv.session_id is None:
        conv.session_id = session.id
    # Stamp the canonical post-refactor back-link on the Session.
    session.conversation_id = conv.id
    await db.flush()
    return conv


def _to_session_message_response(
    msg,
    session: Session,
    attachment=None,
) -> SessionMessageResponse:
    """Convert a raw Message ORM row to the session-scoped response shape.

    ``attachment`` is the optional FileAttachment ORM row associated with this
    message. When provided, we mint a fresh presigned GET URL so the client
    can render / download the file. The URL expires per s3_service default
    (1 hour).
    """
    from app.config import settings as _settings
    from app.services.s3_service import generate_presigned_download_url

    sender_role = "chw" if msg.sender_id == session.chw_id else "member"

    attachment_payload = None
    if attachment is not None:
        # Message attachments are uploaded to the message-attachments bucket
        # (upload.py routes purpose="message_attachment" ->
        # s3_message_attachments_bucket). Mint the download URL against the SAME
        # bucket or the read 404s with NoSuchKey. (Was previously reading from
        # s3_bucket_phi, which holds no message attachments.)
        download_url = generate_presigned_download_url(
            _settings.s3_message_attachments_bucket,
            attachment.s3_key,
        )
        attachment_payload = SessionMessageAttachmentResponse(
            id=attachment.id,
            filename=attachment.filename,
            size_bytes=attachment.size_bytes,
            content_type=attachment.content_type,
            s3_key=attachment.s3_key,
            download_url=download_url,
        )

    return SessionMessageResponse(
        id=msg.id,
        sender_user_id=msg.sender_id,
        sender_role=sender_role,
        body=msg.body,
        type=msg.type or "text",
        created_at=msg.created_at,
        attachment=attachment_payload,
    )


@router.get("/{session_id}/messages", response_model=list[SessionMessageResponse])
async def list_session_messages(
    session_id: UUID,
    after: UUID | None = Query(default=None, description="Cursor: return only messages with id > this message's created_at. Used for polling new messages."),
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[SessionMessageResponse]:
    """List messages in the session's conversation thread.

    ``after`` is a message UUID cursor.  Only messages created *after* the
    given message are returned, ordered oldest-first.  Omit ``after`` to get
    the full thread (up to 200 messages — enough for Phase 1 polling).

    HIPAA: message bodies are PHI.  They are returned only to verified
    participants and are never written to structured logs.
    """
    from app.models.conversation import FileAttachment, Message

    session = await _get_session_and_assert_participant(session_id, current_user, db)
    conv = await _get_or_create_session_conversation(session, db)

    stmt = (
        select(Message)
        .where(Message.conversation_id == conv.id)
    )

    if after is not None:
        # Resolve the cursor message's timestamp so we can do a range query
        # on the indexed ``created_at`` column rather than a UUID comparison.
        cursor_msg = await db.get(Message, after)
        if cursor_msg is None:
            raise HTTPException(status_code=404, detail="Cursor message not found")
        stmt = stmt.where(Message.created_at > cursor_msg.created_at)

    stmt = stmt.order_by(Message.created_at.asc()).limit(200)
    result = await db.execute(stmt)
    messages = result.scalars().all()

    # Eager-load any FileAttachment rows for this batch in one query (avoids N+1).
    attachments_by_message: dict = {}
    if messages:
        att_result = await db.execute(
            select(FileAttachment).where(
                FileAttachment.message_id.in_([m.id for m in messages])
            )
        )
        for att in att_result.scalars().all():
            attachments_by_message[att.message_id] = att

    return [
        _to_session_message_response(m, session, attachments_by_message.get(m.id))
        for m in messages
    ]


@router.post("/{session_id}/messages", response_model=SessionMessageResponse, status_code=201)
async def send_session_message(
    session_id: UUID,
    data: SessionMessageSend,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SessionMessageResponse:
    """Send a message in the session's conversation thread.

    HIPAA: the message body is PHI.  It is persisted to the encrypted
    ``messages`` table but is never logged or included in error responses.
    """
    from app.models.conversation import FileAttachment, Message

    session = await _get_session_and_assert_participant(session_id, current_user, db)

    # T03: block messaging when the member has refused services.
    # The check is on the member party regardless of who is sending — both
    # CHW→member and member→CHW messages are blocked when services_consent
    # is "refuse_services".
    from app.services.relationship_guards import assert_member_consents_to_services
    await assert_member_consents_to_services(db, member_id=session.member_id)

    conv = await _get_or_create_session_conversation(session, db)

    has_attachment = bool(data.attachment_s3_key)
    body_text = data.body or ""

    # Require either body text or an attachment so we don't persist empty rows.
    if not body_text.strip() and not has_attachment:
        raise HTTPException(
            status_code=422,
            detail="Message must include either a body or an attachment.",
        )

    # When an attachment is present without text, we still require the
    # filename / size / content_type fields so the row is renderable.
    if has_attachment and not (
        data.attachment_filename
        and data.attachment_size_bytes is not None
        and data.attachment_content_type
    ):
        raise HTTPException(
            status_code=422,
            detail="attachment_filename, attachment_size_bytes and attachment_content_type are required with attachment_s3_key.",
        )

    # Derive the message type from the attachment content_type so clients can
    # render image bubbles inline vs file rows.
    msg_type = "text"
    if has_attachment:
        if (data.attachment_content_type or "").startswith("image/"):
            msg_type = "image"
        else:
            msg_type = "file"

    msg = Message(
        conversation_id=conv.id,
        sender_id=current_user.id,
        body=body_text,
        type=msg_type,
    )
    db.add(msg)
    await db.flush()  # need msg.id before linking attachment

    attachment = None
    if has_attachment:
        attachment = FileAttachment(
            message_id=msg.id,
            s3_key=data.attachment_s3_key,
            filename=data.attachment_filename,
            size_bytes=data.attachment_size_bytes,
            content_type=data.attachment_content_type,
        )
        db.add(attachment)

    await db.commit()
    await db.refresh(msg)
    if attachment is not None:
        await db.refresh(attachment)

    # Best-effort push notification to the other participant.
    # Truncated to 40 chars for HIPAA minimum-necessary on lock screens.
    try:
        recipient_id = (
            session.member_id if current_user.id == session.chw_id else session.chw_id
        )
        # Notification preview prefers attachment filename when body is empty.
        if body_text.strip():
            preview = (body_text[:40] + "…") if len(body_text) > 40 else body_text
        elif has_attachment:
            kind = "Photo" if msg_type == "image" else "File"
            preview = f"📎 {kind}: {data.attachment_filename}"
        else:
            preview = "New message"
        from app.services.notifications import NotificationPayload, notify_user
        await notify_user(
            db,
            recipient_id,
            NotificationPayload(
                user_id=recipient_id,
                title=f"New message from {current_user.name.split(' ')[0]}",
                body=preview,
                deeplink=f"compasschw://sessions/{session_id}/messages",
                category="message.new",
                data={"session_id": str(session_id), "message_id": str(msg.id)},
            ),
        )
    except Exception as exc:  # noqa: BLE001
        import logging
        logging.getLogger("compass").warning(
            "Session message notification failed session=%s: %s", session_id, exc
        )

    return _to_session_message_response(msg, session, attachment)


@router.post("/{session_id}/messages/read", status_code=204)
async def mark_session_messages_read(
    session_id: UUID,
    data: MarkReadRequest,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Advance the caller's read cursor to ``up_to_message_id``.

    Stores the cursor on the Conversation row:
    - CHW  → ``chw_read_up_to``
    - member → ``member_read_up_to``

    The cursor only ever moves forward; sending an older message id is a no-op
    (we compare ``created_at`` timestamps to determine ordering).
    """
    from app.models.conversation import Message

    session = await _get_session_and_assert_participant(session_id, current_user, db)
    conv = await _get_or_create_session_conversation(session, db)

    # Validate the target message belongs to this conversation.
    target_msg = await db.get(Message, data.up_to_message_id)
    if target_msg is None or target_msg.conversation_id != conv.id:
        raise HTTPException(status_code=404, detail="Message not found in this session")

    is_chw = current_user.id == session.chw_id

    if is_chw:
        current_cursor_id = conv.chw_read_up_to
    else:
        current_cursor_id = conv.member_read_up_to

    # Only advance the cursor — never retreat it.
    if current_cursor_id is not None:
        current_cursor = await db.get(Message, current_cursor_id)
        if current_cursor is not None and target_msg.created_at <= current_cursor.created_at:
            # Cursor is already at or ahead of the requested position — no-op.
            return

    if is_chw:
        conv.chw_read_up_to = data.up_to_message_id
    else:
        conv.member_read_up_to = data.up_to_message_id

    await db.commit()


# ─── Session-scoped call wrapper ─────────────────────────────────────────────
#
# The existing /communication/call-bridge accepts ``recipient_id`` + optional
# ``session_id``.  The mobile phone-icon taps from a session context and only
# has a session_id, not the other party's user UUID.  This thin wrapper
# resolves the session's two participants and forwards to the bridge endpoint
# internally — keeping all Vonage logic in communication.py.


@router.post("/{session_id}/call")
async def initiate_session_call(
    session_id: UUID,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Start a masked Vonage call for this session.

    Resolves both parties from the session row and delegates to
    ``/api/v1/communication/call-bridge``.  The caller (CHW or member)
    is the initiator; the other party is the recipient.

    Returns the same ``CallBridgeResponse`` shape as the bridge endpoint so
    clients can share the response handler.
    """
    from app.models.communication import CommunicationSession
    from app.models.user import User
    from app.services.communication import get_provider

    session = await _get_session_and_assert_participant(session_id, current_user, db)

    recipient_id = (
        session.member_id if current_user.id == session.chw_id else session.chw_id
    )

    caller = await db.get(User, current_user.id)
    recipient = await db.get(User, recipient_id)
    if caller is None or recipient is None:
        raise HTTPException(status_code=404, detail="User not found")
    if not caller.phone or not recipient.phone:
        raise HTTPException(
            status_code=400,
            detail="Both parties must have a verified phone number on file.",
        )

    # #193 session-per-call: this endpoint is the one the FE actually hits
    # (NOT /communication/call-bridge — that's a separate path). Delegate
    # to the shared resolver so both endpoints stay in sync.
    import logging
    target_session_id: UUID = session_id
    from app.config import settings as _settings
    if _settings.session_per_call_enabled:
        from app.services.session_lookup import resolve_target_session_for_call

        chw_user_obj = caller if current_user.id == session.chw_id else recipient
        member_user_obj = recipient if current_user.id == session.chw_id else caller
        resolved = await resolve_target_session_for_call(
            db,
            chw_id=session.chw_id,
            member_id=session.member_id,
            chw_user=chw_user_obj,
            member_user=member_user_obj,
            fallback_session_id=session_id,
        )
        if resolved is not None:
            target_session_id = resolved

    provider = get_provider()
    proxy = await provider.create_proxy_session(
        session_id=str(target_session_id),
        chw_phone=caller.phone if current_user.id == session.chw_id else recipient.phone,
        member_phone=recipient.phone if current_user.id == session.chw_id else caller.phone,
    )

    db.add(
        CommunicationSession(
            session_id=target_session_id,
            provider=proxy.provider,
            provider_session_id=proxy.provider_session_id,
            proxy_number=proxy.proxy_number,
        )
    )
    await db.commit()

    logging.getLogger("compass.communication").info(
        "session-call initiated: caller=%s url_session=%s target_session=%s provider_session=%s",
        current_user.id, session_id, target_session_id, proxy.provider_session_id,
    )

    return {
        "proxy_number": proxy.proxy_number,
        "provider_session_id": proxy.provider_session_id,
        "session_id": str(target_session_id),
    }


# ─── Follow-up extraction ─────────────────────────────────────────────────────
#
# POST /sessions/{id}/extract-followups kicks off the LLM extraction pass that
# converts the session transcript into structured action items, follow-up tasks,
# resource referrals, and member goals.
#
# Auth: the CHW who owns the session, OR a bearer of the admin API key.
# Idempotency: returns existing rows if extraction already ran; never duplicates.
# Sync: Phase 2 runs synchronously (200 OK + rows in body). Phase 3 can convert
#       to a background task returning 202 Accepted once load justifies it.


async def _require_chw_on_session_or_admin(
    session_id: UUID,
    credentials,
    db: AsyncSession,
) -> Session:
    """Return the session if the caller is the CHW on it or holds the admin key.

    Checks the bearer token against the admin key first (constant-time compare),
    then falls back to verifying it as a user JWT with role ``chw``.

    Raises:
        401 if the token is invalid for both auth paths.
        403 if the caller is a valid user but is not the CHW on this session.
        404 if the session does not exist.
    """
    import hmac

    from app.config import settings
    from app.utils.security import decode_token

    token = credentials.credentials

    # Admin key path — checked first so admin ops don't need a user account.
    if hmac.compare_digest(token, settings.admin_key):
        session = await db.get(Session, session_id)
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
        return session

    # User JWT path.
    payload = decode_token(token)
    if payload is None or payload.get("type") != "access":
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    user_id_str = payload.get("sub")
    if user_id_str is None:
        raise HTTPException(status_code=401, detail="Invalid token payload")

    from app.models.user import User
    result = await db.execute(select(User).where(User.id == UUID(user_id_str)))
    user = result.scalar_one_or_none()
    if user is None or not user.is_active:
        raise HTTPException(status_code=401, detail="User not found or inactive")

    session = await db.get(Session, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    if session.chw_id != user.id:
        raise HTTPException(
            status_code=403,
            detail="Only the CHW on this session (or an admin) may trigger extraction",
        )
    return session


@router.post(
    "/{session_id}/ai-summary",
    status_code=200,
    summary="Generate an AI summary of the session transcript",
    description=(
        "Calls the configured LLM (Claude via Anthropic) to produce a 3-5 "
        "sentence plain-language summary of the CHW–member transcript.  The "
        "result is a DRAFT — the CHW may edit or discard it before submitting "
        "documentation.  The AI summary is a separate field from the CHW-authored "
        "notes; both are stored on SessionDocumentation so audit trails can "
        "distinguish them permanently.\n\n"
        "Returns ``{\"ai_summary\": \"\", \"generated_at\": null}`` (HTTP 200) "
        "when no transcript is available, the session is not in a summarisable "
        "state, or the LLM provider is unavailable — the frontend hides the "
        "AI-summary section in that case."
    ),
)
async def generate_ai_summary_endpoint(
    session_id: UUID,
    credentials: "HTTPAuthorizationCredentials" = Depends(HTTPBearer()),
    db: AsyncSession = Depends(get_db),
):
    """POST /api/v1/sessions/{session_id}/ai-summary

    Auth: CHW on the session or admin key.  Synchronous — LLM round-trip is
    typically 1-3 s; the DocumentationModal opens with a spinner.

    Response shape:
        {
            "ai_summary":   "<text or empty string>",
            "generated_at": "<ISO-8601 UTC timestamp or null>"
        }
    """
    from app.services.summary_generation import generate_session_summary

    await _require_chw_on_session_or_admin(session_id, credentials, db)
    result = await generate_session_summary(session_id, db)
    return {
        "ai_summary": result.text,
        "generated_at": result.generated_at.isoformat() if result.generated_at else None,
    }


@router.post(
    "/{session_id}/extract-followups",
    response_model=ExtractFollowupsResponse,
    status_code=200,
    summary="Run LLM extraction pass to produce structured follow-ups",
    description=(
        "Extracts action items, follow-up tasks, resource referrals, and member "
        "goals from the session transcript using an LLM pass. Idempotent — returns "
        "existing rows if extraction has already run for this session. "
        "Auth: CHW on the session or admin key."
    ),
)
async def extract_followups(
    session_id: UUID,
    credentials: "HTTPAuthorizationCredentials" = Depends(HTTPBearer()),
    db: AsyncSession = Depends(get_db),
) -> ExtractFollowupsResponse:
    """POST /api/v1/sessions/{session_id}/extract-followups

    Runs synchronously.  LLM failures are caught internally — if the provider
    is unavailable the endpoint returns 200 with an empty followups list rather
    than a 5xx, because extraction is non-blocking and must never interfere with
    session completion or documentation workflows.
    """
    import logging

    from app.services.followup_extraction import extract_session_followups

    _logger = logging.getLogger("compass.sessions.extract_followups")

    # Auth: CHW on session or admin key.
    await _require_chw_on_session_or_admin(session_id, credentials, db)

    followup_rows = await extract_session_followups(session_id, db)

    # Counts for response envelope — no descriptions in logs.
    action_count = sum(1 for f in followup_rows if f.kind == "action_item")
    task_count = sum(1 for f in followup_rows if f.kind == "follow_up_task")
    resource_count = sum(1 for f in followup_rows if f.kind == "resource_referral")
    goal_count = sum(1 for f in followup_rows if f.kind == "member_goal")

    # Determine whether rows are freshly created or cached (idempotent return).
    # The service already handles idempotency; we signal it in the response by
    # checking the auto_created flag and comparing counts vs zero.
    was_cached = bool(followup_rows) and all(
        not f.auto_created or f.created_at < f.updated_at
        for f in followup_rows
    )

    _logger.info(
        "session=%s extract-followups complete: total=%d action=%d task=%d resource=%d goal=%d cached=%s",
        session_id, len(followup_rows), action_count, task_count, resource_count, goal_count, was_cached,
    )

    return ExtractFollowupsResponse(
        session_id=session_id,
        followups=[SessionFollowupResponse.model_validate(f) for f in followup_rows],
        action_items_count=action_count,
        follow_up_tasks_count=task_count,
        resource_referrals_count=resource_count,
        member_goals_count=goal_count,
        was_cached=was_cached,
    )


@router.patch(
    "/{session_id}/followups/{followup_id}",
    response_model=SessionFollowupResponse,
    summary="Confirm, dismiss, edit, or complete a single follow-up item",
)
async def patch_followup(
    session_id: UUID,
    followup_id: UUID,
    patch: SessionFollowupPatch,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """PATCH a single follow-up.

    Auth: CHW or member who is a participant on the session. Members can ONLY
    set `status` (typically `completed`) — they cannot rewrite description,
    owner, vertical, priority, due_date, or roadmap visibility. CHWs can edit
    every field.

    Setting `status = 'confirmed'` (CHW action) automatically stamps
    `confirmed_by_user_id` and `confirmed_at` for audit trail.
    """
    from datetime import UTC, datetime

    from app.models.followup import SessionFollowup as SessionFollowupModel

    followup = await db.get(SessionFollowupModel, followup_id)
    if followup is None or followup.session_id != session_id:
        raise HTTPException(status_code=404, detail="Follow-up not found")

    # Participant check — must be CHW or member on the underlying session.
    is_chw = followup.chw_id == current_user.id
    is_member = followup.member_id == current_user.id
    is_admin = getattr(current_user, "role", None) == "admin"
    if not (is_chw or is_member or is_admin):
        raise HTTPException(status_code=403, detail="Not a participant on this session")

    # Member-role callers may only update status (e.g. mark complete).
    fields = patch.model_dump(exclude_unset=True)
    if is_member and not is_chw and not is_admin:
        allowed = {"status"}
        rejected = set(fields.keys()) - allowed
        if rejected:
            raise HTTPException(
                status_code=403,
                detail=f"Members may only update status; rejected fields: {sorted(rejected)}",
            )

    for field, value in fields.items():
        setattr(followup, field, value.value if hasattr(value, "value") else value)

    # Auto-stamp confirmation audit fields when status flips to confirmed.
    if fields.get("status") == "confirmed" and (is_chw or is_admin):
        followup.confirmed_by_user_id = current_user.id
        followup.confirmed_at = datetime.now(UTC)

    await db.commit()
    await db.refresh(followup)
    return followup

from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.billing import BillingClaim
from app.models.request import ServiceRequest
from app.models.session import MemberConsent, Session, SessionDocumentation
from app.models.user import User
from app.schemas.conversation import (
    MarkReadRequest,
    SessionMessageAttachmentResponse,
    SessionMessageResponse,
    SessionMessageSend,
)
from app.schemas.followup import ExtractFollowupsResponse, SessionFollowupResponse
from app.schemas.session import ConsentSubmit, SessionCreate, SessionDocumentationSubmit, SessionResponse, TranscriptResponse
from app.services.billing_service import calculate_earnings, calculate_units, check_unit_caps, validate_claim

router = APIRouter(prefix="/api/v1/sessions", tags=["sessions"])


@router.get("/", response_model=list[SessionResponse])
async def list_sessions(
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    limit: int = Query(default=50, ge=1, le=200, description="Max sessions to return"),
    offset: int = Query(default=0, ge=0, description="Skip this many sessions"),
):
    """List sessions for the current user.

    Offset-based pagination keeps response shape identical to the unpaginated
    variant (still a flat array). For total counts, clients call /sessions/count.
    """
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
    stmt = stmt.limit(limit).offset(offset)
    result = await db.execute(stmt)
    rows = result.all()
    return [
        SessionResponse.model_validate({**s.__dict__, "chw_name": chw_name, "member_name": member_name})
        for s, chw_name, member_name in rows
    ]


@router.post("/", response_model=SessionResponse, status_code=201)
async def create_session(
    data: SessionCreate,
    background_tasks: BackgroundTasks,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SessionResponse:
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
    from app.models.user import User
    from app.services.communication import get_provider
    try:
        # Pull both parties' phone numbers for masked-call routing
        chw_user = await db.get(User, session.chw_id)
        member_user = await db.get(User, session.member_id)
        chw_phone = (chw_user.phone if chw_user else "") or ""
        member_phone = (member_user.phone if member_user else "") or ""

        if not chw_phone or not member_phone:
            import logging
            logging.getLogger("compass").warning(
                "Session %s starting without both phone numbers (chw=%s, member=%s). "
                "Masked calling disabled for this session.",
                session_id, bool(chw_phone), bool(member_phone),
            )

        provider = get_provider()
        proxy = await provider.create_proxy_session(
            session_id=str(session_id),
            chw_phone=chw_phone,
            member_phone=member_phone,
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
        service_date=session_date,
    )
    db.add(claim)

    session.units_billed = data.units_to_bill
    session.gross_amount = earnings["gross"]
    session.net_amount = earnings["net"]
    await db.commit()
    await db.refresh(claim)

    # Submit claim to Pear Suite for Medi-Cal processing (async, non-blocking).
    # Failures here do NOT fail the request — the claim is persisted locally and
    # can be resubmitted from an admin job. This is the correct boundary because:
    #   - We always want local source of truth even if Pear Suite is down
    #   - CHW already completed the work; don't make them retry documentation
    #   - Retries should happen in a separate worker that reads `status='pending'`
    from decimal import Decimal as _Dec

    from app.services.billing import ClaimSubmission, get_billing_provider
    try:
        provider = get_billing_provider()
        result = await provider.submit_claim(ClaimSubmission(
            session_id=session_id,
            chw_id=session.chw_id,
            member_id=session.member_id,
            service_date=session_date,
            procedure_code=data.procedure_code,
            modifier=claim.modifier or "U2",
            diagnosis_codes=data.diagnosis_codes,
            units=data.units_to_bill,
            gross_amount=_Dec(str(earnings["gross"])),
        ))
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

    chunk_result = await db.execute(
        select(SessionTranscript)
        .where(SessionTranscript.session_id == session_id)
        .order_by(SessionTranscript.created_at.asc())
    )
    chunks = chunk_result.scalars().all()

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
    """Return the Conversation tied to this session, creating it if absent.

    Uses INSERT ... ON CONFLICT DO NOTHING + a follow-up SELECT to be safe
    under concurrent requests (e.g. CHW and member both open chat simultaneously
    for the first time).
    """
    from sqlalchemy.dialects.postgresql import insert as pg_insert

    from app.models.conversation import Conversation

    # Fast path: conversation already exists.
    result = await db.execute(
        select(Conversation).where(Conversation.session_id == session.id)
    )
    conv = result.scalar_one_or_none()
    if conv is not None:
        return conv

    # Slow path: insert, tolerating a concurrent insert via ON CONFLICT.
    stmt = (
        pg_insert(Conversation)
        .values(
            chw_id=session.chw_id,
            member_id=session.member_id,
            session_id=session.id,
        )
        .on_conflict_do_nothing(constraint="uq_conversations_session_id")
        .returning(Conversation)
    )
    insert_result = await db.execute(stmt)
    inserted = insert_result.scalar_one_or_none()
    if inserted is not None:
        await db.commit()
        return inserted

    # Another request won the race; fetch the row it created.
    result = await db.execute(
        select(Conversation).where(Conversation.session_id == session.id)
    )
    return result.scalar_one()


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
        # Chat attachments live in the PHI bucket per upload.py routing
        # ("document" purpose). Use the same bucket here when minting the
        # download URL so we don't 404 on read.
        download_url = generate_presigned_download_url(
            _settings.s3_bucket_phi,
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
    from app.models.conversation import Conversation, Message

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

    provider = get_provider()
    proxy = await provider.create_proxy_session(
        session_id=str(session_id),
        chw_phone=caller.phone if current_user.id == session.chw_id else recipient.phone,
        member_phone=recipient.phone if current_user.id == session.chw_id else caller.phone,
    )

    db.add(
        CommunicationSession(
            session_id=session_id,
            provider=proxy.provider,
            provider_session_id=proxy.provider_session_id,
            proxy_number=proxy.proxy_number,
        )
    )
    await db.commit()

    import logging
    logging.getLogger("compass.communication").info(
        "session-call initiated: caller=%s session=%s provider_session=%s",
        current_user.id, session_id, proxy.provider_session_id,
    )

    return {
        "proxy_number": proxy.proxy_number,
        "provider_session_id": proxy.provider_session_id,
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

    from app.models.followup import SessionFollowup as SessionFollowupModel
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
    patch: "SessionFollowupPatch",  # noqa: F821 — forward-ref to avoid top-level import churn
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
    from app.schemas.followup import SessionFollowupPatch  # noqa: F401

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

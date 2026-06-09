from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.schemas.conversation import (
    ConversationResponse,
    FileAttachmentInline,
    MessageCreate,
    MessageResponse,
)

router = APIRouter(prefix="/api/v1/conversations", tags=["conversations"])


# ─── In-app messaging decision ────────────────────────────────────────────────
#
# The existing Conversation model already supports session_id=NULL for ad-hoc
# (non-session-scoped) DMs between a CHW and member pair. The existing
# GET /conversations/ endpoint returns all conversations for the current user,
# and GET/POST /conversations/{id}/messages work for any conversation the caller
# is a participant in — regardless of whether session_id is set.
#
# Therefore: NO structural extension is needed for the "Message" button in
# ProfileContactButtons. The only gap was a "find-or-create by peer" endpoint
# so the frontend can navigate to a conversation without knowing the UUID first.
#
# Decision: add POST /conversations/find-or-create with body {peer_id}.
# The endpoint is idempotent — it returns the existing conversation UUID if one
# already exists for this (chw, member) pair (with session_id=NULL), otherwise
# inserts a new row. Registration order matters — this route is declared BEFORE
# the /{conversation_id}/messages route to avoid FastAPI treating "find-or-create"
# as a UUID path param.


class FindOrCreateConversationRequest(BaseModel):
    """Body for POST /conversations/find-or-create."""
    peer_id: UUID


@router.post(
    "/find-or-create",
    response_model=ConversationResponse,
    status_code=200,
    summary="Find or create an ad-hoc DM conversation with a peer",
    description=(
        "Returns the existing Conversation between the caller and peer_id "
        "(where session_id IS NULL), or creates one if none exists. "
        "The caller must be either a CHW or a member, and peer_id must be "
        "the other role. Idempotent — safe to call on every 'Message' tap."
    ),
)
async def find_or_create_conversation(
    body: FindOrCreateConversationRequest,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ConversationResponse:
    """POST /api/v1/conversations/find-or-create

    Auth: any authenticated user (CHW or member).
    Body: { "peer_id": "<uuid>" }

    Determines chw_id and member_id from the callers' roles, then performs
    an INSERT ... ON CONFLICT DO NOTHING + SELECT to safely handle concurrent
    first-message taps.
    """
    from sqlalchemy.dialects.postgresql import insert as pg_insert

    from app.models.conversation import Conversation
    from app.models.user import User

    peer = await db.get(User, body.peer_id)
    if peer is None or not peer.is_active:
        raise HTTPException(status_code=404, detail="Peer user not found.")

    # Determine CHW / member assignment from roles.
    if current_user.role == "chw" and peer.role == "member":
        chw_id = current_user.id
        member_id = peer.id
    elif current_user.role == "member" and peer.role == "chw":
        chw_id = peer.id
        member_id = current_user.id
    else:
        raise HTTPException(
            status_code=400,
            detail=(
                "Conversations must be between a CHW and a member. "
                f"Caller role: {current_user.role}, peer role: {peer.role}."
            ),
        )

    # Finding #20: enforce CHW ↔ member relationship gate.
    # Any CHW could otherwise start a conversation with any member — this gate
    # requires at least one shared session before a DM channel is created.
    # Admins bypass the check.
    if current_user.role != "admin":
        from app.services.relationship_guards import assert_shared_session
        await assert_shared_session(db, chw_id=chw_id, member_id=member_id)

    # Fast path: existing conversation for this (chw, member) pair.
    # The uq_conversations_chw_member UNIQUE constraint ensures at most one row.
    result = await db.execute(
        select(Conversation).where(
            Conversation.chw_id == chw_id,
            Conversation.member_id == member_id,
        )
    )
    existing = result.scalar_one_or_none()
    if existing is not None:
        return existing

    # Slow path: atomic upsert via ON CONFLICT (chw_id, member_id) DO NOTHING.
    # The uq_conversations_chw_member UNIQUE constraint (migration ab1c2d3e4f5a)
    # guarantees that two concurrent inserts for the same pair will resolve to
    # exactly one winner. The loser gets nothing back (DO NOTHING), then falls
    # through to the SELECT below to fetch the winning row.
    stmt = (
        pg_insert(Conversation)
        .values(
            chw_id=chw_id,
            member_id=member_id,
            session_id=None,
        )
        .on_conflict_do_nothing(index_elements=["chw_id", "member_id"])
        .returning(Conversation.id)
    )
    insert_result = await db.execute(stmt)
    inserted_row = insert_result.first()
    if inserted_row is not None:
        conv = await db.get(Conversation, inserted_row[0])
        assert conv is not None  # we just inserted it
        await db.commit()
        return conv

    # Conflict: another request won the race — commit any prior flushed state
    # and fetch the single canonical row now guaranteed by the UNIQUE constraint.
    await db.commit()
    result = await db.execute(
        select(Conversation).where(
            Conversation.chw_id == chw_id,
            Conversation.member_id == member_id,
        )
    )
    conv = result.scalar_one()
    return conv


def _serialize_message(msg, attachment) -> MessageResponse:
    """Combine a Message row with an optional FileAttachment row into a response."""
    response_data = {
        "id": msg.id,
        "conversation_id": msg.conversation_id,
        "sender_id": msg.sender_id,
        "body": msg.body,
        "type": msg.type,
        "created_at": msg.created_at,
        "attachment": None,
    }
    if attachment is not None:
        response_data["attachment"] = FileAttachmentInline.model_validate(attachment)
    return MessageResponse.model_validate(response_data)

@router.get("/", response_model=list[ConversationResponse])
async def list_conversations(
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[ConversationResponse]:
    """List all conversations for the current user (CHW or member).

    For each conversation, `active_session_id` is resolved server-side by
    querying for an in_progress Session. The N+1 here is intentional and
    acceptable — CHW inboxes are bounded to a single CHW's conversations
    (typically < 50). If inbox sizes grow, replace with a single query using
    DISTINCT ON (conversation_id) WHERE status='in_progress'.
    """
    from app.models.conversation import Conversation
    from app.services.session_lookup import get_active_session_for_conversation

    result = await db.execute(
        select(Conversation).where(
            (Conversation.chw_id == current_user.id) | (Conversation.member_id == current_user.id)
        ).order_by(Conversation.created_at.desc())
    )
    conversations = result.scalars().all()

    # Build response objects manually so we can stamp the computed
    # active_session_id field (from_attributes=True alone cannot populate it).
    responses: list[ConversationResponse] = []
    for conv in conversations:
        active = await get_active_session_for_conversation(db, conv.id)
        responses.append(
            ConversationResponse(
                id=conv.id,
                chw_id=conv.chw_id,
                member_id=conv.member_id,
                session_id=conv.session_id,
                active_session_id=active.id if active else None,
                created_at=conv.created_at,
            )
        )
    return responses

@router.get("/{conversation_id}/messages", response_model=list[MessageResponse])
async def get_messages(
    conversation_id: UUID,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    limit: int = Query(default=100, ge=1, le=500, description="Max messages to return"),
    before: str | None = Query(default=None, description="ISO timestamp — return only messages older than this (for 'load earlier' pagination)"),
):
    """List messages in a conversation.

    Default returns the most recent 100 messages. For loading older messages
    as the user scrolls up, pass `before` with the timestamp of the oldest
    message currently shown — the server returns the next 100 older messages.
    Client then prepends them to its local list.
    """
    from datetime import datetime

    from app.models.conversation import Conversation, FileAttachment, Message
    conv = await db.get(Conversation, conversation_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    if conv.chw_id != current_user.id and conv.member_id != current_user.id and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Not authorized")

    stmt = (
        select(Message, FileAttachment)
        .outerjoin(FileAttachment, FileAttachment.message_id == Message.id)
        .where(Message.conversation_id == conversation_id)
    )

    if before:
        try:
            before_dt = datetime.fromisoformat(before.replace("Z", "+00:00"))
            stmt = stmt.where(Message.created_at < before_dt)
        except ValueError as err:
            raise HTTPException(status_code=422, detail="Invalid 'before' timestamp") from err

    # Order newest-first for DB efficiency + limit, then reverse for client
    stmt = stmt.order_by(Message.created_at.desc()).limit(limit)
    result = await db.execute(stmt)
    rows = list(result.all())
    rows.reverse()  # Client expects oldest-first chronological order
    return [_serialize_message(msg, att) for msg, att in rows]

@router.post("/{conversation_id}/messages", response_model=MessageResponse, status_code=201)
async def send_message(conversation_id: UUID, data: MessageCreate, current_user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    from app.models.conversation import Conversation, FileAttachment, Message
    conv = await db.get(Conversation, conversation_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    if conv.chw_id != current_user.id and conv.member_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not a participant")

    # T03: block messaging when the member has refused services.
    # Checked after the participant gate so non-participants cannot probe
    # the consent status of arbitrary members.
    from app.services.relationship_guards import assert_member_consents_to_services
    await assert_member_consents_to_services(db, member_id=conv.member_id)

    # Validate attachment completeness: all four fields must be present together
    attachment_fields = [
        data.attachment_s3_key,
        data.attachment_filename,
        data.attachment_size_bytes,
        data.attachment_content_type,
    ]
    has_attachment = any(f is not None for f in attachment_fields)
    all_attachment = all(f is not None for f in attachment_fields)
    if has_attachment and not all_attachment:
        raise HTTPException(
            status_code=422,
            detail="Attachment requires s3_key, filename, size_bytes, and content_type together",
        )

    msg = Message(
        conversation_id=conversation_id,
        sender_id=current_user.id,
        body=data.body,
        type="file" if has_attachment else data.type,
    )
    db.add(msg)
    await db.flush()  # Get msg.id before creating the attachment

    attachment = None
    if all_attachment:
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

    # Notify the other party. Deliberately uses a short preview only — never
    # the full body, in case the message contains PHI (HIPAA minimum necessary
    # on the lock screen). The app fetches full content after tap.
    try:
        recipient_id = conv.member_id if current_user.id == conv.chw_id else conv.chw_id
        preview = (data.body[:40] + "…") if len(data.body) > 40 else data.body
        from app.services.notifications import NotificationPayload, notify_user
        await notify_user(
            db,
            recipient_id,
            NotificationPayload(
                user_id=recipient_id,
                title=f"New message from {current_user.name.split(' ')[0]}",
                body="📎 Attachment" if has_attachment else preview,
                deeplink=f"compasschw://conversations/{conversation_id}",
                category="message.new",
                data={"conversation_id": str(conversation_id), "message_id": str(msg.id)},
            ),
        )
    except Exception as e:  # noqa: BLE001
        import logging
        logging.getLogger("compass").warning("Notification fanout failed on message send: %s", e)

    return _serialize_message(msg, attachment)


@router.get("/messages/{message_id}/attachment-url")
async def get_attachment_download_url(
    message_id: UUID,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return a short-lived presigned URL to download a message's attachment.

    Authorization: caller must be a participant in the conversation.
    URL is valid for 5 minutes — the client should download immediately.
    """
    from app.config import settings
    from app.models.conversation import Conversation, FileAttachment, Message
    from app.services.s3_service import generate_presigned_download_url

    stmt = (
        select(Message, FileAttachment, Conversation)
        .join(FileAttachment, FileAttachment.message_id == Message.id)
        .join(Conversation, Conversation.id == Message.conversation_id)
        .where(Message.id == message_id)
    )
    result = await db.execute(stmt)
    row = result.first()
    if row is None:
        raise HTTPException(status_code=404, detail="Attachment not found")

    _msg, attachment, conv = row

    if conv.chw_id != current_user.id and conv.member_id != current_user.id and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Not authorized")

    url = generate_presigned_download_url(
        bucket=settings.s3_bucket_phi,
        key=attachment.s3_key,
        expires_in=300,
    )
    return {
        "url": url,
        "filename": attachment.filename,
        "content_type": attachment.content_type,
        "size_bytes": attachment.size_bytes,
        "expires_in_seconds": 300,
    }

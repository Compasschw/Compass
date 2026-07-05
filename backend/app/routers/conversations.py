from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.models.conversation import Conversation
from app.schemas.conversation import (
    ConversationArchiveUpdate,
    ConversationDeleteResponse,
    ConversationMarkReadRequest,
    ConversationPinUpdate,
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
) -> Conversation:
    """POST /api/v1/conversations/find-or-create

    Auth: any authenticated user (CHW or member).
    Body: { "peer_id": "<uuid>" }

    Determines chw_id and member_id from the callers' roles, then performs
    an INSERT ... ON CONFLICT DO NOTHING + SELECT to safely handle concurrent
    first-message taps.
    """
    from sqlalchemy.dialects.postgresql import insert as pg_insert

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


async def _load_chw_conversation_or_404(
    *,
    conversation_id: UUID,
    db: AsyncSession,
    current_user,
) -> Conversation:
    """Resolve a conversation for a CHW swipe-action endpoint.

    Returns the Conversation when the caller is the owning CHW or an admin.
    Raises HTTPException(404) when the row is missing OR the caller is
    not authorised — 404 instead of 403 so we don't leak conversation existence.

    Args:
        conversation_id: UUID of the Conversation.
        db: Async database session.
        current_user: Authenticated caller from JWT.

    Returns:
        The loaded Conversation row.

    Raises:
        HTTPException(404): Not found or caller not authorised.
    """
    conv = await db.get(Conversation, conversation_id)
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    if current_user.role == "admin":
        return conv
    if current_user.role == "chw" and conv.chw_id == current_user.id:
        return conv
    raise HTTPException(status_code=404, detail="Conversation not found")

@router.get("/", response_model=list[ConversationResponse])
async def list_conversations(
    include_archived: bool = Query(
        default=False,
        description=(
            "When true, also return archived conversations (CHW perspective). "
            "Soft-deleted threads are never returned."
        ),
    ),
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[ConversationResponse]:
    """List all conversations for the current user (CHW or member).

    Enrichment (N+1-free):
    - CHW + member names resolved via JOIN.
    - Last message per conversation: single DISTINCT ON batch query.
    - Unread count: one grouped COUNT per caller.
    - active_session_id: single DISTINCT ON batch query (existing helper).

    Sort order (CHW callers): pinned threads first (newest-pin-first),
    then all others by last_message_at DESC, then conversation.created_at DESC.
    Members: last_message_at DESC, created_at DESC.

    Filters:
    - deleted_at IS NULL always applied.
    - archived_at IS NULL applied unless include_archived=true.
    """
    from datetime import datetime

    from sqlalchemy import desc, nulls_last
    from sqlalchemy.orm import aliased

    from app.models.conversation import Message
    from app.models.user import User
    from app.services.session_lookup import get_active_session_ids_for_conversations

    CHWUser = aliased(User)
    MemberUser = aliased(User)

    stmt = (
        select(Conversation, CHWUser.name, MemberUser.name, MemberUser.last_active_at)
        .join(CHWUser, Conversation.chw_id == CHWUser.id)
        .join(MemberUser, Conversation.member_id == MemberUser.id)
        .where(
            (Conversation.chw_id == current_user.id)
            | (Conversation.member_id == current_user.id),
            Conversation.deleted_at.is_(None),
        )
    )

    if current_user.role == "chw" and not include_archived:
        stmt = stmt.where(Conversation.archived_at.is_(None))

    # Sort: pinned threads first (CHW only), then by last_message_at desc,
    # then creation time as tiebreaker. last_message_at is a computed field
    # populated after the query — we sort in Python once we have the batch data.
    stmt = stmt.order_by(
        nulls_last(desc(Conversation.pinned_at)),
        Conversation.created_at.desc(),
    )

    result = await db.execute(stmt)
    rows = result.all()
    conversations = [conv for conv, _chw_name, _member_name, _la in rows]
    name_map: dict = {
        conv.id: (chw_name, member_name)
        for conv, chw_name, member_name, _la in rows
    }
    member_last_active_map: dict = {
        conv.id: member_last_active
        for conv, _chw_name, _member_name, member_last_active in rows
    }

    if not conversations:
        return []

    conv_ids = [conv.id for conv in conversations]

    # ── Batch 1: active_session_id ────────────────────────────────────────────
    active_session_ids = await get_active_session_ids_for_conversations(db, conv_ids)

    # ── Batch 2: last message per conversation ────────────────────────────────
    # DISTINCT ON (conversation_id) returns the newest message for each thread.
    # The composite index ix_messages_conversation_created_at (added in migration
    # v6w7x8y9z0a1) serves this query without a sort step.
    last_msg_result = await db.execute(
        select(
            Message.conversation_id,
            Message.body,
            Message.created_at,
            Message.sender_id,
        )
        .where(Message.conversation_id.in_(conv_ids))
        .order_by(Message.conversation_id, Message.created_at.desc())
        .distinct(Message.conversation_id)
    )
    last_msg_map: dict = {}
    for conv_id, body, created_at, sender_id in last_msg_result.all():
        preview = (body[:60] + "…") if len(body) > 60 else body
        last_msg_map[conv_id] = {
            "last_message_preview": preview,
            "last_message_at": created_at,
            "last_message_sender_id": sender_id,
        }

    # ── Batch 3: unread count per conversation ─────────────────────────────────
    # Resolve cursor timestamps in Python from already-loaded conversations to
    # avoid N+1 cursor-message lookups. Then a single batched fetch of all
    # messages from the other party, grouped in Python against per-conv cursors.
    is_chw_caller = current_user.role in ("chw", "admin")
    cursor_ids: list = []
    for conv in conversations:
        cursor_id = conv.chw_read_up_to if is_chw_caller else conv.member_read_up_to
        if cursor_id is not None:
            cursor_ids.append(cursor_id)

    cursor_ts_map: dict = {}
    if cursor_ids:
        cursor_result = await db.execute(
            select(Message.id, Message.created_at).where(Message.id.in_(cursor_ids))
        )
        cursor_ts_map = {msg_id: ts for msg_id, ts in cursor_result.all()}

    # Fetch all messages from other party in one query, then group in Python.
    # This avoids N+1 while still supporting per-conversation different cursors.
    unread_candidates_result = await db.execute(
        select(Message.conversation_id, Message.created_at)
        .where(
            Message.conversation_id.in_(conv_ids),
            Message.sender_id != current_user.id,
        )
    )
    unread_candidates = unread_candidates_result.all()  # (conv_id, created_at)

    def _cursor_ts_for_conv(conv: Conversation) -> "datetime | None":
        cursor_id = conv.chw_read_up_to if is_chw_caller else conv.member_read_up_to
        if cursor_id is None:
            return None
        return cursor_ts_map.get(cursor_id)

    conv_cursor_map = {conv.id: _cursor_ts_for_conv(conv) for conv in conversations}

    unread_count_map: dict = {}
    for conv_id, msg_ts in unread_candidates:
        cursor_ts = conv_cursor_map.get(conv_id)
        if cursor_ts is None or msg_ts > cursor_ts:
            unread_count_map[conv_id] = unread_count_map.get(conv_id, 0) + 1

    # ── Assemble response objects ─────────────────────────────────────────────
    response_items = []
    for conv in conversations:
        chw_name, member_name = name_map[conv.id]
        last_msg = last_msg_map.get(conv.id, {})
        response_items.append(
            ConversationResponse(
                id=conv.id,
                chw_id=conv.chw_id,
                member_id=conv.member_id,
                session_id=conv.session_id,
                active_session_id=active_session_ids.get(conv.id),
                created_at=conv.created_at,
                deleted_at=conv.deleted_at,
                deleted_by_user_id=conv.deleted_by_user_id,
                chw_name=chw_name,
                member_name=member_name,
                member_last_active_at=member_last_active_map.get(conv.id),
                last_message_preview=last_msg.get("last_message_preview"),
                last_message_at=last_msg.get("last_message_at"),
                last_message_sender_id=last_msg.get("last_message_sender_id"),
                unread_count=unread_count_map.get(conv.id, 0),
                pinned_at=conv.pinned_at,
                archived_at=conv.archived_at,
            )
        )

    # Re-sort by last_message_at desc (secondary, after pinned_at which the DB
    # already handled) so threads with recent messages float above idle ones.
    response_items.sort(
        key=lambda r: (
            r.pinned_at is None,             # False (pinned) sorts before True
            -(r.last_message_at.timestamp() if r.last_message_at else 0),
        )
    )

    return response_items

@router.delete(
    "/{conversation_id}",
    response_model=ConversationDeleteResponse,
    status_code=200,
    summary="Soft-delete a conversation thread",
    description=(
        "Stamps deleted_at on the Conversation row. The thread is hidden from "
        "the inbox list but remains fetchable by id for audit. Messages, "
        "call_logs, and all downstream FK rows are retained (HIPAA). "
        "Sending a new message to a soft-deleted thread auto-restores it. "
        "Only the CHW or member on this thread may delete it (403 otherwise). "
        "Idempotent: deleting an already-deleted thread returns 200 unchanged."
    ),
)
async def soft_delete_conversation(
    conversation_id: UUID,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ConversationDeleteResponse:
    """DELETE /api/v1/conversations/{conversation_id}

    Auth: caller must be the CHW or member on this thread.
    Returns the conversation's updated soft-delete state.

    Args:
        conversation_id: UUID of the conversation to soft-delete.
        current_user:    The authenticated caller (from JWT).
        db:              Async database session.

    Returns:
        ConversationDeleteResponse with the stamped deleted_at and
        deleted_by_user_id fields.

    Raises:
        HTTPException(404): Conversation not found.
        HTTPException(403): Caller is not a participant on this thread.
    """
    from datetime import UTC, datetime

    conv = await db.get(Conversation, conversation_id)
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found.")

    # Participant gate: only the CHW or member on this thread may delete it.
    # Admins are intentionally excluded — use the admin panel for audit access.
    if conv.chw_id != current_user.id and conv.member_id != current_user.id:
        raise HTTPException(
            status_code=403,
            detail="Not authorized: you are not a participant on this conversation.",
        )

    # Idempotent: already deleted — return existing state unchanged.
    if conv.deleted_at is not None:
        # deleted_by_user_id is always set when deleted_at is non-NULL; the
        # columns are written atomically by this endpoint. The assert narrows
        # the type for mypy so the non-nullable schema field is satisfied.
        assert conv.deleted_by_user_id is not None, (
            "Data integrity violation: deleted_at is set but deleted_by_user_id is NULL "
            f"on conversation {conv.id}."
        )
        return ConversationDeleteResponse(
            id=conv.id,
            deleted_at=conv.deleted_at,
            deleted_by_user_id=conv.deleted_by_user_id,
        )

    now_utc = datetime.now(UTC)
    conv.deleted_at = now_utc
    conv.deleted_by_user_id = current_user.id
    await db.commit()
    await db.refresh(conv)

    # After refresh, both columns are guaranteed non-NULL (we just wrote them).
    assert conv.deleted_at is not None
    assert conv.deleted_by_user_id is not None
    return ConversationDeleteResponse(
        id=conv.id,
        deleted_at=conv.deleted_at,
        deleted_by_user_id=conv.deleted_by_user_id,
    )


@router.patch("/{conversation_id}/pin", response_model=ConversationResponse)
async def update_conversation_pin(
    conversation_id: UUID,
    body: ConversationPinUpdate,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ConversationResponse:
    """Pin or unpin a conversation thread in the CHW's inbox.

    ``pinned=true`` stamps the current UTC time onto ``pinned_at``; pinned
    threads sort to the top of the inbox.  ``pinned=false`` clears the
    timestamp.  CHW or admin only — members cannot pin.

    Idempotent: re-pinning an already-pinned thread updates the timestamp.
    Un-pinning a never-pinned thread is a no-op that returns 200 unchanged.
    """
    from datetime import UTC, datetime

    from app.models.user import User as _User

    conv = await _load_chw_conversation_or_404(
        conversation_id=conversation_id, db=db, current_user=current_user
    )
    conv.pinned_at = datetime.now(UTC) if body.pinned else None
    await db.commit()
    await db.refresh(conv)

    chw = await db.get(_User, conv.chw_id)
    member = await db.get(_User, conv.member_id)
    return ConversationResponse(
        id=conv.id,
        chw_id=conv.chw_id,
        member_id=conv.member_id,
        session_id=conv.session_id,
        created_at=conv.created_at,
        deleted_at=conv.deleted_at,
        deleted_by_user_id=conv.deleted_by_user_id,
        chw_name=chw.name if chw else None,
        member_name=member.name if member else None,
        member_last_active_at=member.last_active_at if member else None,
        pinned_at=conv.pinned_at,
        archived_at=conv.archived_at,
    )


@router.patch("/{conversation_id}/archive", response_model=ConversationResponse)
async def update_conversation_archive(
    conversation_id: UUID,
    body: ConversationArchiveUpdate,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ConversationResponse:
    """Archive or unarchive a conversation in the CHW's inbox.

    Archived conversations disappear from the default inbox but reappear
    when the CHW passes ``?include_archived=true`` to the list endpoint.
    CHW or admin only.
    """
    from datetime import UTC, datetime

    from app.models.user import User as _User

    conv = await _load_chw_conversation_or_404(
        conversation_id=conversation_id, db=db, current_user=current_user
    )
    conv.archived_at = datetime.now(UTC) if body.archived else None
    await db.commit()
    await db.refresh(conv)

    chw = await db.get(_User, conv.chw_id)
    member = await db.get(_User, conv.member_id)
    return ConversationResponse(
        id=conv.id,
        chw_id=conv.chw_id,
        member_id=conv.member_id,
        session_id=conv.session_id,
        created_at=conv.created_at,
        deleted_at=conv.deleted_at,
        deleted_by_user_id=conv.deleted_by_user_id,
        chw_name=chw.name if chw else None,
        member_name=member.name if member else None,
        member_last_active_at=member.last_active_at if member else None,
        pinned_at=conv.pinned_at,
        archived_at=conv.archived_at,
    )


@router.post("/{conversation_id}/messages/read", status_code=204)
async def mark_conversation_messages_read(
    conversation_id: UUID,
    data: ConversationMarkReadRequest,
    current_user=Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Advance the caller's read cursor on this conversation to ``up_to_message_id``.

    Stores the cursor on the Conversation row:
    - CHW    → ``chw_read_up_to``
    - member → ``member_read_up_to``

    The cursor is monotonic — sending an older message id is a no-op (we
    compare ``created_at`` timestamps).  A dangling cursor pointing at a
    deleted message id is handled gracefully (treated as NULL).

    Auth: caller must be a participant (CHW or member on the thread).
    """
    from app.models.conversation import Message

    conv = await db.get(Conversation, conversation_id)
    if conv is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    if conv.chw_id != current_user.id and conv.member_id != current_user.id and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Not authorized")

    target_msg = await db.get(Message, data.up_to_message_id)
    if target_msg is None or target_msg.conversation_id != conv.id:
        raise HTTPException(status_code=404, detail="Message not found in this conversation")

    is_chw = current_user.id == conv.chw_id

    if is_chw:
        current_cursor_id = conv.chw_read_up_to
    else:
        current_cursor_id = conv.member_read_up_to

    # Only advance — never retreat.
    if current_cursor_id is not None:
        current_cursor = await db.get(Message, current_cursor_id)
        # Graceful: if the cursor message was deleted, treat cursor as NULL.
        if current_cursor is not None and target_msg.created_at <= current_cursor.created_at:
            return

    if is_chw:
        conv.chw_read_up_to = data.up_to_message_id
    else:
        conv.member_read_up_to = data.up_to_message_id

    await db.commit()


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

    # Auto-restore: sending a message to a soft-deleted thread reactivates it.
    # This mirrors the archive-on-engagement pattern (Session.archived_at is
    # cleared when activity resumes). HIPAA note: the deletion record is NOT
    # preserved after restore — deleted_at and deleted_by_user_id are cleared.
    # If an audit trail of the delete event is needed, add an AuditLog row here.
    if conv.deleted_at is not None:
        conv.deleted_at = None
        conv.deleted_by_user_id = None

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

    # Message attachments are uploaded to s3_message_attachments_bucket (see
    # upload.py purpose routing); read from the same bucket or S3 returns
    # NoSuchKey. s3_bucket_phi holds no message attachments.
    url = generate_presigned_download_url(
        bucket=settings.s3_message_attachments_bucket,
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

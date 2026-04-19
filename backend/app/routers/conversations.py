from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
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
async def list_conversations(current_user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    from app.models.conversation import Conversation
    result = await db.execute(
        select(Conversation).where(
            (Conversation.chw_id == current_user.id) | (Conversation.member_id == current_user.id)
        ).order_by(Conversation.created_at.desc())
    )
    return result.scalars().all()

@router.get("/{conversation_id}/messages", response_model=list[MessageResponse])
async def get_messages(conversation_id: UUID, current_user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    from app.models.conversation import Conversation, FileAttachment, Message
    conv = await db.get(Conversation, conversation_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    if conv.chw_id != current_user.id and conv.member_id != current_user.id and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Not authorized")

    # Left-join messages with their optional file attachments in a single query
    stmt = (
        select(Message, FileAttachment)
        .outerjoin(FileAttachment, FileAttachment.message_id == Message.id)
        .where(Message.conversation_id == conversation_id)
        .order_by(Message.created_at)
    )
    result = await db.execute(stmt)
    return [_serialize_message(msg, att) for msg, att in result.all()]

@router.post("/{conversation_id}/messages", response_model=MessageResponse, status_code=201)
async def send_message(conversation_id: UUID, data: MessageCreate, current_user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    from app.models.conversation import Conversation, FileAttachment, Message
    conv = await db.get(Conversation, conversation_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    if conv.chw_id != current_user.id and conv.member_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not a participant")

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

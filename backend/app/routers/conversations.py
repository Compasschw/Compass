from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import get_current_user
from app.schemas.conversation import ConversationResponse, MessageCreate, MessageResponse

router = APIRouter(prefix="/api/v1/conversations", tags=["conversations"])

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
    from app.models.conversation import Conversation, Message
    conv = await db.get(Conversation, conversation_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    if conv.chw_id != current_user.id and conv.member_id != current_user.id and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Not authorized")
    result = await db.execute(select(Message).where(Message.conversation_id == conversation_id).order_by(Message.created_at))
    return result.scalars().all()

@router.post("/{conversation_id}/messages", response_model=MessageResponse, status_code=201)
async def send_message(conversation_id: UUID, data: MessageCreate, current_user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    from app.models.conversation import Conversation, Message
    conv = await db.get(Conversation, conversation_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    if conv.chw_id != current_user.id and conv.member_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not a participant")
    msg = Message(conversation_id=conversation_id, sender_id=current_user.id, body=data.body, type=data.type)
    db.add(msg)
    await db.commit()
    await db.refresh(msg)
    return msg

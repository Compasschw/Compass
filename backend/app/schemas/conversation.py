from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class MessageCreate(BaseModel):
    body: str
    type: str = "text"
    # Optional — when set, attach a previously-uploaded file to the message.
    # The client first calls /upload/presigned-url → uploads to S3 → then calls
    # this endpoint with attachment_s3_key + attachment_filename + size/content_type.
    attachment_s3_key: str | None = None
    attachment_filename: str | None = None
    attachment_size_bytes: int | None = None
    attachment_content_type: str | None = None


class FileAttachmentInline(BaseModel):
    """Nested attachment info returned on message responses."""
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    filename: str
    size_bytes: int
    content_type: str
    s3_key: str


class MessageResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    conversation_id: UUID
    sender_id: UUID
    body: str
    type: str
    created_at: datetime
    attachment: FileAttachmentInline | None = None


class ConversationResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    chw_id: UUID
    member_id: UUID
    session_id: UUID | None
    created_at: datetime


class FileAttachmentResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    filename: str
    size_bytes: int
    content_type: str


# ─── Session-scoped messaging schemas ────────────────────────────────────────


class SessionMessageSend(BaseModel):
    """Request body for POST /sessions/{session_id}/messages."""
    body: str = Field(..., min_length=1, max_length=10_000)


class SessionMessageResponse(BaseModel):
    """Single message as returned from session-scoped endpoints.

    ``sender_role`` is resolved at query time from the session's chw_id /
    member_id — clients don't need to look it up separately.
    """
    model_config = ConfigDict(from_attributes=False)

    id: UUID
    sender_user_id: UUID
    sender_role: str  # "chw" | "member"
    body: str
    created_at: datetime


class MarkReadRequest(BaseModel):
    """Request body for POST /sessions/{session_id}/messages/read."""
    up_to_message_id: UUID

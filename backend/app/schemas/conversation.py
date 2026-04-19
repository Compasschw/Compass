from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict


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

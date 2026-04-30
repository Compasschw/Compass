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
    """Request body for POST /sessions/{session_id}/messages.

    ``body`` may be empty when an attachment is included (e.g. an image with
    no caption). At least one of body/attachment must be present — enforced
    in the router, not here, so the validation error message can mention the
    attachment context.

    Attachment flow (mirrors the conversations router):
      1. Client calls POST /upload/presigned-url to get a PUT URL + s3_key
      2. Client PUTs the file binary to that URL
      3. Client posts here with attachment_s3_key + filename + size + content_type
    """
    body: str = Field(default="", max_length=10_000)
    attachment_s3_key: str | None = None
    attachment_filename: str | None = None
    attachment_size_bytes: int | None = None
    attachment_content_type: str | None = None


class SessionMessageAttachmentResponse(BaseModel):
    """Inline attachment payload returned with a session message.

    ``download_url`` is a fresh presigned GET URL minted at read time — clients
    should not cache it across requests since it expires (default 1 hour per
    s3_service.generate_presigned_download_url).
    """
    model_config = ConfigDict(from_attributes=False)

    id: UUID
    filename: str
    size_bytes: int
    content_type: str
    s3_key: str
    download_url: str


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
    type: str = "text"  # "text" | "image" | "file"
    created_at: datetime
    attachment: SessionMessageAttachmentResponse | None = None


class MarkReadRequest(BaseModel):
    """Request body for POST /sessions/{session_id}/messages/read."""
    up_to_message_id: UUID

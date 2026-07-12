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
    # The conversation's currently in_progress Session, if any. The CHW
    # Messages screen reads this to know which Session to act on for
    # End Session / Submit Documentation. None when the conversation has
    # no active Session (e.g., all prior calls are completed). Always
    # populated server-side (not pulled from the column) via
    # app.services.session_lookup.get_active_session_for_conversation.
    active_session_id: UUID | None = None
    # Start time of the in_progress Session (``active_session_id``), if any. The
    # CHW Messages screen counts a live session timer up from this. None when
    # there is no active Session. Populated server-side alongside
    # active_session_id via session_lookup.get_active_session_started_ats_for_conversations.
    active_session_started_at: datetime | None = None
    created_at: datetime
    # Soft-delete fields. None = active thread.
    deleted_at: datetime | None = None
    deleted_by_user_id: UUID | None = None
    # ── Inbox enrichment fields (computed server-side) ─────────────────────
    # Names resolved via JOIN to users table — avoid extra round-trips.
    member_name: str | None = None
    chw_name: str | None = None
    # Member's last authenticated activity — drives the presence ("Active") pill.
    member_last_active_at: datetime | None = None
    # Last message preview (truncated to 60 chars, HIPAA minimum-necessary).
    last_message_preview: str | None = None
    last_message_at: datetime | None = None
    last_message_sender_id: UUID | None = None
    # Unread count for the calling party. 0 when all messages have been read
    # or there are no messages.
    unread_count: int = 0
    # CHW-perspective swipe-action state. Members receive these as informational
    # only — the FE must not let members call PATCH /pin or /archive.
    pinned_at: datetime | None = None
    archived_at: datetime | None = None


class ConversationDeleteResponse(BaseModel):
    """Response body for DELETE /conversations/{id}.

    Returns the conversation's new soft-deleted state so the client
    can optimistically remove it from the inbox without a follow-up GET.
    """
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    deleted_at: datetime
    deleted_by_user_id: UUID


class ConversationPinUpdate(BaseModel):
    """Body for PATCH /conversations/{id}/pin.

    ``pinned=true`` stamps pinned_at; ``pinned=false`` clears it.
    CHW or admin only — members receive pin state as read-only.
    """

    pinned: bool


class ConversationArchiveUpdate(BaseModel):
    """Body for PATCH /conversations/{id}/archive.

    Archived conversations are hidden from the default inbox but reappear
    with ``?include_archived=true``.  CHW or admin only.
    """

    archived: bool


class ConversationMarkReadRequest(BaseModel):
    """Body for POST /conversations/{id}/messages/read.

    Advances the caller's read cursor to ``up_to_message_id``.  The cursor
    is monotonic: sending an older message id is a no-op.
    """

    up_to_message_id: UUID


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

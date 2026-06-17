"""Pydantic schemas for the presigned-URL upload endpoint.

Key design decisions (HIPAA audit, 2026-06):
- ``target_member_id`` is required for ``message_attachment`` uploads so the
  S3 key is scoped to the member being addressed, not to the uploader.  When a
  CHW uploads an attachment to send to a member, the file is stored under the
  member's UUID prefix (``prod/v1/members/{member_uuid}/attachments/...``), not
  the CHW's UUID.  The router validates that the requesting user has an active
  care relationship with the target member before issuing the presigned URL.
"""

from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

# Allowlisted MIME types for uploads. Adding new types is a conscious decision --
# never accept arbitrary content_type strings from clients.
ALLOWED_MIME_TYPES = frozenset({
    # Images (profile photos, document scans, chat attachments)
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/gif",
    # Documents (credentials, referrals, signed consents)
    "application/pdf",
    "application/msword",  # .doc
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",  # .docx
    # Audio (session recordings -- when enabled)
    "audio/mpeg",
    "audio/mp4",
    "audio/wav",
    "audio/webm",
})

# Upload purpose determines S3 bucket (PHI vs public) and path prefix.
# Kept as a Literal for compile-time + runtime validation.
# message_attachment -> compass-prod-message-attachments (PHI bucket; must be
# created via docs/runbooks/create-phi-buckets.md before first use).
# member_document   -> compass-prod-member-documents (PHI bucket; must be
# created via docs/runbooks/create-phi-buckets.md -> Step 3c before production use).
UploadPurpose = Literal[
    "credential",
    "recording",
    "document",
    "profile_image",
    "message_attachment",
    "member_document",
]

MAX_UPLOAD_BYTES = 20 * 1024 * 1024  # 20 MB


class PresignedUrlRequest(BaseModel):
    """Request body for POST /api/v1/upload/presigned-url.

    ``target_member_id`` is required when ``purpose == "message_attachment"``.
    It identifies the member who will receive the message containing this
    attachment, so the S3 key is scoped to that member rather than the sender.

    For all other purposes the field is ignored (may be omitted).
    """

    filename: str = Field(min_length=1, max_length=255)
    content_type: str
    purpose: UploadPurpose = "credential"
    size_bytes: int = Field(gt=0, le=MAX_UPLOAD_BYTES)
    # Required for message_attachment purpose; ignored for all others.
    target_member_id: uuid.UUID | None = None

    @field_validator("content_type")
    @classmethod
    def _validate_mime(cls, v: str) -> str:
        if v not in ALLOWED_MIME_TYPES:
            raise ValueError(
                f"content_type '{v}' is not allowed. "
                f"Must be one of: {sorted(ALLOWED_MIME_TYPES)}"
            )
        return v

    @field_validator("filename")
    @classmethod
    def _sanitize_filename(cls, v: str) -> str:
        # Reject path traversal and null bytes
        if "/" in v or "\\" in v or "\x00" in v or v.startswith(".."):
            raise ValueError("filename contains invalid characters")
        return v

    @model_validator(mode="after")
    def _require_target_member_for_attachment(self) -> PresignedUrlRequest:
        """Enforce that target_member_id is present for message_attachment uploads."""
        if self.purpose == "message_attachment" and self.target_member_id is None:
            raise ValueError(
                "target_member_id is required when purpose is 'message_attachment'"
            )
        return self


class PresignedUrlResponse(BaseModel):
    upload_url: str
    s3_key: str

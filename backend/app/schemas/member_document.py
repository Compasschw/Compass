"""Pydantic v2 schemas for the MemberDocument resource.

Document types mirror the FE categories: id, income, address, medical, other.
Size cap is enforced both here (schema) and in the presigned-URL endpoint
(upload.py MAX_UPLOAD_BYTES = 20 MB).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

# Allowed document categories.  New values require a data migration for
# existing rows and a FE update to the icon map in MemberDocumentsScreen.
DocumentType = Literal["id", "income", "address", "medical", "other"]

ALLOWED_CONTENT_TYPES: frozenset[str] = frozenset({
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/heic",
})

# 20 MB server-side cap (same as the presigned-URL endpoint).
MAX_DOCUMENT_BYTES = 20 * 1024 * 1024


class MemberDocumentCreate(BaseModel):
    """Body for POST /api/v1/members/{member_id}/documents."""

    model_config = {"strict": True}

    document_type: DocumentType
    filename: str = Field(min_length=1, max_length=255)
    s3_url: str = Field(min_length=1, max_length=1000)
    s3_key: str = Field(min_length=1, max_length=500)
    content_type: str
    size_bytes: int = Field(gt=0, le=MAX_DOCUMENT_BYTES)

    @field_validator("content_type")
    @classmethod
    def _validate_content_type(cls, v: str) -> str:
        if v not in ALLOWED_CONTENT_TYPES:
            raise ValueError(
                f"content_type '{v}' is not allowed. "
                f"Must be one of: {sorted(ALLOWED_CONTENT_TYPES)}"
            )
        return v

    @field_validator("filename")
    @classmethod
    def _sanitize_filename(cls, v: str) -> str:
        if "/" in v or "\\" in v or "\x00" in v or v.startswith(".."):
            raise ValueError("filename contains invalid characters")
        return v


class MemberDocumentResponse(BaseModel):
    """Serialised MemberDocument row returned to the client."""

    model_config = {"from_attributes": True}

    id: uuid.UUID
    member_id: uuid.UUID
    document_type: str
    filename: str
    # s3_url intentionally OMITTED — clients must use the download-url
    # endpoint which returns a short-lived presigned GET URL.
    content_type: str
    size_bytes: int
    uploaded_by: uuid.UUID
    uploaded_at: datetime
    deleted_at: datetime | None = None


class PresignedDownloadUrlResponse(BaseModel):
    """Response for GET /api/v1/documents/{doc_id}/download-url."""

    download_url: str
    expires_in_seconds: int = 900  # 15 minutes

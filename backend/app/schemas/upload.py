from typing import Literal

from pydantic import BaseModel, Field, field_validator

# Allowlisted MIME types for uploads. Adding new types is a conscious decision —
# never accept arbitrary content_type strings from clients.
ALLOWED_MIME_TYPES = frozenset({
    # Images (profile photos, document scans)
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    # Documents (credentials, referrals, signed consents)
    "application/pdf",
    # Audio (session recordings — when enabled)
    "audio/mpeg",
    "audio/mp4",
    "audio/wav",
    "audio/webm",
})

# Upload purpose determines S3 bucket (PHI vs public) and path prefix.
# Kept as a Literal for compile-time + runtime validation.
UploadPurpose = Literal["credential", "recording", "document", "profile_image"]

MAX_UPLOAD_BYTES = 20 * 1024 * 1024  # 20 MB


class PresignedUrlRequest(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    content_type: str
    purpose: UploadPurpose = "credential"
    size_bytes: int = Field(gt=0, le=MAX_UPLOAD_BYTES)

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


class PresignedUrlResponse(BaseModel):
    upload_url: str
    s3_key: str

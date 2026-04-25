import re
from datetime import date, datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, field_validator

# Allowed prefix pattern for credential document S3 keys.
# Full URLs must never be stored — only the path segment after the bucket name.
_S3_KEY_PATTERN = re.compile(r"^credentials/[0-9a-f\-]{36}/[0-9a-f\-]{36}\.pdf$")


class CredentialValidationSubmit(BaseModel):
    institution_name: str
    institution_contact_email: str | None = None
    program_name: str
    certificate_number: str | None = None
    graduation_date: datetime | None = None
    document_s3_key: str | None = None
    expiry_date: date | None = None

    @field_validator("document_s3_key", mode="before")
    @classmethod
    def validate_s3_key(cls, v: str | None) -> str | None:
        """Reject full URLs and keys outside the allowed path structure.

        Accepts only paths matching ``credentials/<chw_uuid>/<file_uuid>.pdf``.
        This prevents callers from pointing the column at arbitrary S3 paths or
        embedding https:// URLs that expose the bucket name in logs.
        """
        if v is None:
            return v
        if not _S3_KEY_PATTERN.match(v):
            raise ValueError(
                "document_s3_key must be a path of the form "
                "'credentials/<chw_uuid>/<file_uuid>.pdf' — full URLs are not allowed."
            )
        return v


class CredentialValidationPatch(BaseModel):
    """Partial update accepted by PATCH /credentials/{credential_id}.

    Both fields are optional so the client can update them independently.
    """

    document_s3_key: str | None = None
    expiry_date: date | None = None

    @field_validator("document_s3_key", mode="before")
    @classmethod
    def validate_s3_key(cls, v: str | None) -> str | None:
        if v is None:
            return v
        if not _S3_KEY_PATTERN.match(v):
            raise ValueError(
                "document_s3_key must be a path of the form "
                "'credentials/<chw_uuid>/<file_uuid>.pdf' — full URLs are not allowed."
            )
        return v


class CredentialValidationResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    chw_id: UUID
    institution_id: UUID
    program_name: str
    certificate_number: str | None
    document_s3_key: str | None
    expiry_date: date | None
    validation_status: str
    validated_at: datetime | None
    institution_confirmed: bool
    notes: str | None
    created_at: datetime

class InstitutionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    name: str
    contact_email: str | None
    programs_offered: list[str] | None
    accreditation_status: str | None

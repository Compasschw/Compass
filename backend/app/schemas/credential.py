import re
from datetime import date, datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

# Allowed prefix pattern for credential document S3 keys.
# Full URLs must never be stored — only the path segment after the bucket name.
_S3_KEY_PATTERN = re.compile(r"^credentials/[0-9a-f\-]{36}/[0-9a-f\-]{36}\.pdf$")

# S3 key pattern for the four Epic D compliance-checklist document uploads
# (hipaa_training, professional_service_agreement, liability_insurance,
# chw_certification). These go through POST /upload/presigned-url with
# purpose="credential", which builds keys via app.services.s3_service.
# build_phi_key(user_id, "credential", filename) -> "users/<uuid>/credential/<filename>".
# Deliberately a DIFFERENT pattern from _S3_KEY_PATTERN above (which is for
# the older CHWCredentialValidation flow's "credentials/<uuid>/<uuid>.pdf"
# shape) — the two upload flows use different key builders and must not be
# cross-validated against each other's pattern.
_CHECKLIST_S3_KEY_PATTERN = re.compile(
    r"^users/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/credential/[^/\\]+\.pdf$"
)

# The 4 document-upload requirement types tracked in the `credentials` table.
# Mirrors app.services.chw_compliance.DOCUMENT_CREDENTIAL_TYPES — kept as a
# separate literal here (rather than importing) so the schema layer has no
# dependency on the service layer.
_DOCUMENT_CREDENTIAL_TYPES = (
    "hipaa_training",
    "professional_service_agreement",
    "liability_insurance",
    "chw_certification",
)


class CredentialSubmit(BaseModel):
    """CHW-facing upsert body for POST /credentials/{type}.

    Submitting always resets status to "pending" — a re-submission after
    rejection re-enters the review queue rather than silently staying
    rejected. CHWs cannot set status directly; only s3_key is accepted here.
    """

    s3_key: str = Field(min_length=1, max_length=500)

    @field_validator("s3_key")
    @classmethod
    def validate_s3_key(cls, v: str) -> str:
        if not _CHECKLIST_S3_KEY_PATTERN.match(v):
            raise ValueError(
                "s3_key must be a path of the form "
                "'users/<chw_uuid>/credential/<filename>.pdf' returned by "
                "POST /upload/presigned-url (purpose='credential') — full "
                "URLs and other path shapes are not allowed."
            )
        return v


class CredentialResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    chw_id: UUID
    type: str
    label: str
    status: str
    s3_key: str | None
    file_name: str | None
    verified_by: UUID | None
    verified_at: datetime | None
    created_at: datetime


class CredentialReviewRequest(BaseModel):
    """Admin-only review body for PATCH /credentials/{id}/review."""

    approved: bool
    notes: str = ""


class ChecklistItemResponse(BaseModel):
    """One row in the CHW's compliance checklist (GET /credentials/checklist)."""

    code: str
    status: str


class ChecklistResponse(BaseModel):
    """Full checklist payload — all 5 requirement items + overall gate status."""

    can_work: bool
    missing: list[str]
    items: list[ChecklistItemResponse]


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

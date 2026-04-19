from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class CredentialValidationSubmit(BaseModel):
    institution_name: str
    institution_contact_email: str | None = None
    program_name: str
    certificate_number: str | None = None
    graduation_date: datetime | None = None

class CredentialValidationResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    chw_id: UUID
    institution_id: UUID
    program_name: str
    certificate_number: str | None
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

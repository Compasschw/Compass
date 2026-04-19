from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import SessionMode


class SessionCreate(BaseModel):
    request_id: UUID
    scheduled_at: datetime
    mode: SessionMode = SessionMode.in_person


class SessionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    request_id: UUID
    chw_id: UUID
    member_id: UUID
    vertical: str
    status: str
    mode: str
    scheduled_at: datetime | None
    started_at: datetime | None
    ended_at: datetime | None
    duration_minutes: int | None
    suggested_units: int | None
    units_billed: int | None
    gross_amount: float | None
    net_amount: float | None
    created_at: datetime
    chw_name: str | None = None
    member_name: str | None = None


class SessionDocumentationSubmit(BaseModel):
    summary: str
    resources_referred: list[str] = []
    member_goals: list[str] = []
    follow_up_needed: bool = False
    follow_up_date: datetime | None = None
    diagnosis_codes: list[str]
    procedure_code: str
    units_to_bill: int = Field(ge=1, le=4)


class ConsentSubmit(BaseModel):
    consent_type: str = "medical_billing"
    typed_signature: str

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import SessionMode, Urgency, Vertical


class ServiceRequestCreate(BaseModel):
    vertical: Vertical
    urgency: Urgency = Urgency.routine
    description: str
    preferred_mode: SessionMode = SessionMode.in_person
    estimated_units: int = Field(default=1, ge=1, le=4)


class ServiceRequestResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    member_id: UUID
    matched_chw_id: UUID | None
    vertical: str
    urgency: str
    description: str
    preferred_mode: str
    status: str
    estimated_units: int
    created_at: datetime
    member_name: str | None = None


class ServiceRequestUpdate(BaseModel):
    status: str | None = None
    matched_chw_id: UUID | None = None

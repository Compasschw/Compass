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
    """Full request detail — visible to the member who created it and to the
    CHW who has been matched/accepted. Contains PHI (description, member name).
    """
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


class ServiceRequestSummaryResponse(BaseModel):
    """Minimum-necessary view of an open request for CHWs browsing before accept.

    Per HIPAA 45 CFR §164.514(d) (minimum necessary standard), CHWs should not
    see the member's free-text description or display name before they've been
    matched. Only fields needed to decide whether to accept are exposed:
    vertical, urgency, mode, estimated units, and approximate location (zip prefix).
    """
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    vertical: str
    urgency: str
    preferred_mode: str
    status: str
    estimated_units: int
    created_at: datetime


class ServiceRequestUpdate(BaseModel):
    status: str | None = None
    matched_chw_id: UUID | None = None

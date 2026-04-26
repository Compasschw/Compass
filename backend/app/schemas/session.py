from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import SessionMode

# Consent types accepted by POST /sessions/{id}/consent.
# Extend this union when new consent flows are introduced.
ConsentType = Literal["medical_billing", "ai_transcription"]


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
    """Body for POST /sessions/{id}/consent.

    ``consent_type`` must be one of the values in ``ConsentType``.
    The default is ``medical_billing`` for backwards compatibility with
    existing clients that pre-date the ai_transcription consent flow.
    """

    consent_type: ConsentType = "medical_billing"
    typed_signature: str


class TranscriptChunkResponse(BaseModel):
    """A single persisted transcript chunk returned by GET /sessions/{id}/transcript."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    speaker_label: str | None
    speaker_role: str | None
    text: str
    is_final: bool
    confidence: float | None
    started_at_ms: int | None
    ended_at_ms: int | None
    created_at: datetime


class TranscriptResponse(BaseModel):
    """Response envelope for GET /sessions/{id}/transcript."""

    session_id: UUID
    chunks: list[TranscriptChunkResponse]
    total: int

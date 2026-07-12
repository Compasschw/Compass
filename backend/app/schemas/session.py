from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import SessionMode

# Consent types accepted by POST /sessions/{id}/consent.
# Extend this union when new consent flows are introduced.
ConsentType = Literal["medical_billing", "ai_transcription", "device_audio_capture"]


class SessionCreate(BaseModel):
    request_id: UUID
    scheduled_at: datetime
    mode: SessionMode = SessionMode.in_person


class ScheduleSessionRequest(BaseModel):
    """Body for POST /api/v1/sessions/schedule.

    Two callers:
    - CHW schedules with one of their members → send ``member_id`` (chw_id is the
      authenticated CHW). ``scheduling_status`` may be confirmed or pending.
    - Member schedules with their CHW → send ``chw_id`` (member_id is the
      authenticated member). The booking is always recorded as ``pending`` — it
      is a request the CHW confirms — regardless of any supplied value.

    The backend reuses an existing CHW↔member ServiceRequest as the session's
    request_id when one exists, or auto-creates a minimal one, so the
    request_id NOT NULL invariant holds without a request being filed first.
    """

    # Exactly one of these is supplied, determined by the caller's role.
    member_id: UUID | None = None  # required when a CHW schedules
    chw_id: UUID | None = None     # required when a member schedules
    scheduled_at: datetime
    scheduled_end_at: datetime | None = None
    mode: SessionMode = SessionMode.in_person
    scheduling_status: Literal["confirmed", "pending"] = "confirmed"
    notes: str | None = Field(default=None, max_length=2000)


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
    scheduled_end_at: datetime | None = None
    scheduling_status: str | None = None
    started_at: datetime | None
    ended_at: datetime | None
    duration_minutes: int | None
    suggested_units: int | None
    units_billed: int | None
    gross_amount: float | None
    net_amount: float | None
    # Inbox swipe-action state. ``None`` for the default (not pinned /
    # not archived / not deleted) case; populated timestamps record when the
    # CHW applied the action. The frontend uses these to render the pin
    # badge and the archived filter.
    pinned_at: datetime | None = None
    archived_at: datetime | None = None
    deleted_at: datetime | None = None
    # ``None`` when the thread is not muted; a populated timestamp records when
    # the CHW muted it. Muted threads stay in the inbox but their unread badge
    # is suppressed on the frontend.
    muted_at: datetime | None = None
    created_at: datetime
    chw_name: str | None = None
    member_name: str | None = None


# ── Swipe-action request bodies (CHW Messages inbox) ─────────────────────────


class SessionPinUpdate(BaseModel):
    """Body for ``PATCH /sessions/{id}/pin``. ``pinned=true`` stamps the
    timestamp; ``pinned=false`` clears it."""

    pinned: bool


class SessionArchiveUpdate(BaseModel):
    """Body for ``PATCH /sessions/{id}/archive``."""

    archived: bool


class SessionMuteUpdate(BaseModel):
    """Body for ``PATCH /sessions/{id}/mute``. ``muted=true`` stamps the
    timestamp (suppressing the thread's unread badge); ``muted=false`` clears it."""

    muted: bool


class SessionDocumentationSubmit(BaseModel):
    """Body for POST /sessions/{id}/documentation.

    ``summary`` is the CHW-authored manual note — exclusively human-written.
    The three ``ai_summary*`` fields carry the AI-generated draft that was
    shown in the DocumentationModal; the frontend passes them through so the
    long-term record can distinguish AI output from CHW narrative at a glance
    (required for HIPAA audit trails and investor due diligence).
    """

    summary: str
    resources_referred: list[str] = []
    member_goals: list[str] = []
    follow_up_needed: bool = False
    follow_up_date: datetime | None = None
    diagnosis_codes: list[str]
    procedure_code: str
    # CHW-entered session start/end times. When BOTH are provided the backend
    # bills from this duration (end - start) — the CHW edits these on the
    # documentation screen before filing. When absent, the backend falls back
    # to the session's server-tracked duration. ``units_to_bill`` from the
    # client is still ignored (units are always computed server-side from the
    # authoritative duration, whichever source) so a CHW cannot upcode by
    # sending a raw unit count. ``session_end_time`` must be after
    # ``session_start_time`` (validated at the endpoint → 422).
    session_start_time: datetime | None = None
    session_end_time: datetime | None = None
    # Optional — the backend authoritatively computes units from session
    # duration via app.services.billing_service.calculate_units to prevent
    # CHW upcoding. The field is accepted (with the ge/le bounds) for legacy
    # clients but the value is overwritten server-side at submission.
    units_to_bill: int | None = Field(default=None, ge=1, le=4)
    # Number of Medi-Cal members served in this session (1 = individual).
    members_served: int = Field(default=1, ge=1, le=50)

    # AI summary provenance — optional; frontend passes through what it received
    # from POST /ai-summary so the submission record has permanent provenance.
    ai_summary: str | None = None
    ai_summary_generated_at: datetime | None = None
    ai_summary_excluded: bool = False


class SessionDocumentationResponse(BaseModel):
    """Response for GET /sessions/{id}/documentation (and the submit response body
    when consumers need the full record).

    Surfaces both the CHW-authored note (``summary``) and the AI-generated
    fields so audit tooling can compare them side-by-side.
    """

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    session_id: UUID
    summary: str
    resources_referred: list[str] | None
    member_goals: list[str] | None
    follow_up_needed: bool
    follow_up_date: datetime | None
    diagnosis_codes: list[str] | None
    procedure_code: str | None
    units_to_bill: int | None
    members_served: int
    submitted_at: datetime
    ai_summary: str | None
    ai_summary_generated_at: datetime | None
    ai_summary_excluded: bool


class ConsentSubmit(BaseModel):
    """Body for POST /sessions/{id}/consent.

    ``consent_type`` must be one of the values in ``ConsentType``.
    The default is ``medical_billing`` for backwards compatibility with
    existing clients that pre-date the ai_transcription consent flow.

    ``chw_attestation`` lets the CHW record consent on the member's behalf
    when the member has given verbal consent on the call. Only the CHW on
    the session may set this true; setting it from a member account is
    rejected. The typed_signature in this case is the CHW's name and the
    backend records the attestation source for audit.
    """

    consent_type: ConsentType = "medical_billing"
    typed_signature: str
    chw_attestation: bool = False


# ── Two-party consent request schemas ────────────────────────────────────────

class ConsentRequestCreate(BaseModel):
    """Body for POST /sessions/{id}/consent-requests.

    ``consent_type`` is always "ai_transcription" for v1.  The field is kept
    explicit so future callers (e.g. video consent) can reuse the same endpoint.
    """

    consent_type: ConsentType = "ai_transcription"


class ConsentRequestResponse(BaseModel):
    """Wire shape for a ConsentRequest row returned to both the CHW and the member.

    ``status`` reflects the current lifecycle state of the request.  Clients
    should treat any value outside {"pending","approved","denied","cancelled",
    "expired"} as an unknown terminal state and stop polling.
    """

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    session_id: UUID
    chw_id: UUID
    member_id: UUID
    consent_type: str
    status: str
    requested_at: datetime
    responded_at: datetime | None
    expires_at: datetime


class ConsentRequestApprove(BaseModel):
    """Body for POST /consent-requests/{id}/approve.

    ``typed_signature`` is the member's full name as a digital signature.
    Required — it becomes the ``typed_signature`` on the resulting MemberConsent
    row and is the audit-trail evidence of the member's explicit affirmation.
    """

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

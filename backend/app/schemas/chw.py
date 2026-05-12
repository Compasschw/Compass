"""Pydantic response models for CHW-facing endpoints.

HIPAA minimum-necessary enforcement (45 CFR §164.514(d)):
- CHWMemberProfileView exposes ONLY the fields a CHW needs for care delivery.
- CHWMemberProfileDetail exposes the full rich profile for the member profile screen.
- MembersRosterItem exposes the minimum set needed for the roster table.
- Explicitly excluded: medi_cal_id (raw), insurance_provider, full session notes,
  session summaries, diagnosis codes, raw transcripts, and session data from
  other CHWs.
- Session history visible to the CHW is limited to sessions WHERE
  session.chw_id == current_user.id.

- MapMemberPin: ZIP-centroid only (not precise address). Display name is first
  initial + period only — minimum PHI for map clustering context.
- MapResourcePin: precise coordinates from the resource record (not PHI).
"""

from datetime import date, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class CHWMemberProfileView(BaseModel):
    """HIPAA-scoped member profile returned to a CHW who has an active relationship.

    Fields selected on the principle of minimum-necessary disclosure:
    - name: required for care delivery and verbal identification.
    - phone: for masked-call initiation via Vonage bridge; never exposed raw.
    - primary_language: needed so the CHW can prepare language resources.
    - primary_need: care-delivery context (the vertical that generated the session).
    - zip_code: service-area context only; not precise enough for re-identification.
    - total_sessions_with_you: CHW's own care history with this member.
    - total_sessions_all_time: full context for care continuity without exposing
      other CHW session details.
    - last_session_at: helps the CHW assess care recency.
    - active_request_id: shortcut to open any pending service request with this CHW.

    Deliberately excluded:
    - medi_cal_id (PHI — encrypted at rest, minimum-necessary prohibits disclosure)
    - insurance_provider (can be used for re-identification)
    - session notes / summaries / documentation from any CHW
    - session transcripts (PHI audio content)
    - diagnosis_codes (clinical PHI)
    - session data for sessions belonging to other CHWs
    """

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    """Member's user ID (not MemberProfile.id) — used as the canonical identifier."""

    name: str
    """Display name for the member. Required for care delivery."""

    phone: str | None
    """Phone number for masked-call initiation. May be null if member omitted it."""

    primary_language: str
    """Primary language preference. Defaults to "English" if never set."""

    primary_need: str | None
    """The care vertical that best describes the member's primary need."""

    zip_code: str | None
    """ZIP code for service-area context. Not precise enough for re-identification."""

    total_sessions_with_you: int
    """Count of completed sessions between this CHW and this member only."""

    total_sessions_all_time: int
    """Total completed sessions across all CHWs — care continuity context."""

    last_session_at: datetime | None
    """ISO timestamp of the most recent session between this CHW and this member."""

    active_request_id: UUID | None
    """Open service_request.id matched to this CHW, if one exists. Null otherwise."""


# ─── Rich member profile (CHW member profile screen) ─────────────────────────


class BillingUnitsView(BaseModel):
    """Daily and yearly Medi-Cal unit cap snapshot for a CHW↔member pair."""

    today_used: int
    today_remaining: int
    yearly_used: int
    yearly_remaining: int


class OpenGoalItem(BaseModel):
    """A single open member goal from session_followups."""

    text: str
    due_date: date | None = None


class OpenFollowupItem(BaseModel):
    """A single open follow-up task from session_followups."""

    text: str
    due_date: date | None = None


class SessionSummaryItem(BaseModel):
    """Compact session row for the CHW profile screen's session history list."""

    id: UUID
    status: str
    mode: str
    scheduled_at: datetime | None
    started_at: datetime | None
    ended_at: datetime | None
    duration_minutes: int | None
    units_billed: int | None


class ConsentStatusView(BaseModel):
    """Most-recent consent state for each consent type held by this member."""

    ai_transcription: str
    """granted | denied | none"""

    session_recording: str
    """granted | denied | none"""


class CHWMemberProfileDetail(BaseModel):
    """Full HIPAA-scoped member profile for the CHW Member Profile screen."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    first_name: str
    last_name: str
    phone_e164: str | None
    email: str | None
    primary_language: str
    additional_languages: list[str]
    address: str | None
    city: str | None
    zip_code: str | None
    mco: str | None
    ecm_eligible: bool
    primary_categories: list[str]
    billing_units: BillingUnitsView
    session_count: int
    last_session_at: datetime | None
    open_goals: list[OpenGoalItem]
    open_followups: list[OpenFollowupItem]
    consent_status: ConsentStatusView
    recent_sessions: list[SessionSummaryItem]


# ─── Members Roster ───────────────────────────────────────────────────────────


class ActiveJourneyInfo(BaseModel):
    """Lightweight journey info for the roster table cell."""

    name: str
    """Journey template name, e.g. 'Food Assistance'."""

    current_step: str | None
    """Name of the current in-progress step. Null if journey has no active step."""

    percent: float
    """Completion percentage 0–100."""


class MembersRosterItem(BaseModel):
    """One row in the CHW Members roster table.

    HIPAA minimum-necessary (45 CFR §164.514(d)):
    - display_name: decrypted first + last name — required for identification.
    - age: derived from DOB; not DOB itself (avoids precise birth date disclosure).
    - masked_id: last 4 chars of medi_cal_id only — enough for verbal verification.
    - avatar_initials: derived from display_name; no additional PHI.
    - risk: always null in v1 (no clinical model yet).
    - top_need: primary vertical of the most recent active ServiceRequest.

    Excluded: raw medi_cal_id, DOB, phone, insurance_provider, notes, transcripts.
    """

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    """Member's User.id — canonical identifier for navigation."""

    display_name: str
    """Decrypted full name for display."""

    age: int | None
    """Age in whole years, derived from DOB. Null when DOB is not recorded."""

    masked_id: str
    """Last 4 characters of medi_cal_id, formatted '...XXXX'. '—' when absent."""

    avatar_initials: str
    """Up to 2 uppercase initials derived from display_name."""

    status: Literal["active", "inactive"]
    """'active' = session in last 30 days OR open/accepted ServiceRequest.
    'inactive' otherwise."""

    risk: None
    """Always null in v1 — no clinical risk model yet. UI hides the chip when null."""

    engagement: Literal["highly", "moderately", "disengaged"]
    """'highly' ≥3 sessions last 60 days; 'moderately' 1–2; 'disengaged' 0."""

    active_journey: ActiveJourneyInfo | None
    """Most recent active MemberJourney for this member, or null if none."""

    last_contact_at: datetime | None
    """Most recent session.ended_at or session.scheduled_at; null if no sessions."""

    top_need: str | None
    """Primary vertical of the most recent active ServiceRequest. Null if none."""


# ─── CHW Map Data ─────────────────────────────────────────────────────────────


class MapMemberPin(BaseModel):
    """PHI-minimised member pin for the CHW map view (HIPAA §164.514(d)).

    First-initial display name only, ZIP-centroid coordinates (NOT precise),
    no surname / phone / insurance / session notes.
    """

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    display_name: str
    zip_code: str
    latitude: float
    longitude: float
    primary_categories: list[str]
    session_count: int


class MapResourcePin(BaseModel):
    """Community resource pin for the CHW map view — public, non-PHI, precise."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    category: str
    latitude: float
    longitude: float
    address: str


class CHWMapDataResponse(BaseModel):
    """Aggregate response for GET /chw/map-data."""

    model_config = ConfigDict(from_attributes=True)

    members: list[MapMemberPin]
    resources: list[MapResourcePin]

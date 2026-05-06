"""Pydantic response models for CHW-facing endpoints.

HIPAA minimum-necessary enforcement (45 CFR §164.514(d)):
- CHWMemberProfileView exposes ONLY the fields a CHW needs for care delivery.
- Explicitly excluded: medi_cal_id, insurance_provider, full session notes,
  session summaries, diagnosis codes, raw transcripts, and session data from
  other CHWs.
- Session history visible to the CHW is limited to sessions WHERE
  session.chw_id == current_user.id.
"""

from datetime import datetime
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

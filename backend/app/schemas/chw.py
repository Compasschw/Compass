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

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.schemas.cin_config import validate_cin_for_carrier as _validate_chw_cin

# Valid CHW-assigned priority levels for a resource need.
_VALID_LEVELS = {"low", "medium", "high"}


class ResourceNeedLevelItem(BaseModel):
    """A single resource need with its CHW-assigned priority level.

    Using a list of items (instead of a keyed dict) keeps the slug as a string
    VALUE — immune to key-transform camelCasing by the mobile app's response
    interceptor (mental_health → mentalHealth mangling). Single-word slugs like
    "housing" happened to survive the transform; multi-word slugs like
    "mental_health" did not, causing PATCH round-trip failures.
    """

    slug: str
    level: str

    @field_validator("slug")
    @classmethod
    def _normalize_slug(cls, v: str) -> str:
        return v.strip().lower()

    @field_validator("level")
    @classmethod
    def _validate_level(cls, v: str) -> str:
        normalized = v.strip().lower()
        if normalized not in _VALID_LEVELS:
            raise ValueError(
                f"level must be one of {sorted(_VALID_LEVELS)}, got {v!r}"
            )
        return normalized


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
    """Full HIPAA-scoped member profile for the CHW Member Profile screen.

    PHI fields added 2026-06-09 (HIPAA minimum-necessary, 45 CFR §164.514(d)):
    - date_of_birth: Required for age-appropriate referrals and Medi-Cal eligibility.
    - gender: Required for clinical context and Pear Suite billing (sex enum).
    - medi_cal_id: Full CIN for billing verification and identity confirmation on calls.
      Decrypted automatically by the EncryptedString SQLAlchemy descriptor on read.
      Access is gated by assert_chw_member_relationship in the route handler.
    """

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    first_name: str
    last_name: str
    # Member's chosen/preferred name (nullable — UI falls back to first_name).
    preferred_name: str | None = None
    phone_e164: str | None
    email: str | None
    primary_language: str
    additional_languages: list[str]
    address: str | None
    city: str | None
    zip_code: str | None
    mco: str | None
    # Raw address parts for the CHW demographics edit modal — the joined
    # `address` / `city` above are display-only. Default None (additive/safe).
    address_line1: str | None = None
    address_line2: str | None = None
    city_name: str | None = None
    state: str | None = None
    ecm_eligible: bool
    primary_categories: list[str]
    # The member's editable resource needs (signup + CHW-curated): the stored
    # primary_need followed by additional_needs, in priority order. Drives the
    # Resource Needs card's edit pencil. Default [] for additive safety.
    resource_needs: list[str] = []
    # CHW-assigned priority levels per resource need, as an ordered list of
    # {slug, level} items.  Default [] (no levels set yet).
    # List shape keeps the slug as a string value — immune to camelCase
    # key transforms in the mobile app's response interceptor.
    resource_need_levels: list[ResourceNeedLevelItem] = Field(default_factory=list)
    billing_units: BillingUnitsView
    session_count: int
    last_session_at: datetime | None
    open_goals: list[OpenGoalItem]
    open_followups: list[OpenFollowupItem]
    consent_status: ConsentStatusView
    recent_sessions: list[SessionSummaryItem]

    # Member's self-uploaded avatar, surfaced to the related CHW so the CHW
    # Member Profile screen shows the same photo the member set in Settings.
    # Stored on the User row; returned as a short-lived presigned GET URL (or
    # the raw value for external/data URLs). Null when no photo is set — the
    # UI falls back to initials. Access is already relationship-gated by
    # assert_chw_member_relationship in the route handler.
    profile_picture_url: str | None = None

    # ── PHI Demographics (minimum-necessary for care delivery) ────────────────
    date_of_birth: date | None = None
    """Date of birth. Used for age-appropriate referrals and eligibility verification."""

    gender: Literal["Male", "Female", "Other"] | None = None
    """Biological sex enum matching Pear Suite: 'Male' | 'Female' | 'Other'."""

    medi_cal_id: str | None = None
    """Full Medi-Cal CIN (8 digits + 1 letter). Returned in plain text — the
    EncryptedString descriptor decrypts on read. Required for billing verification."""


class PreferredNameUpdate(BaseModel):
    """Request body for PATCH /api/v1/chw/members/{member_id}/preferred-name.

    A null or empty value clears the preferred name (UI falls back to first name).
    Whitespace is trimmed; max 100 chars.
    """

    preferred_name: str | None = Field(default=None, max_length=100)

    @field_validator("preferred_name")
    @classmethod
    def _normalize(cls, v: str | None) -> str | None:
        if v is None:
            return None
        trimmed = v.strip()
        return trimmed or None


class PreferredNameResponse(BaseModel):
    """Response body for the preferred-name GET/PATCH endpoints."""

    preferred_name: str | None = None


_DEMO_GENDER_VALUES = {"Male", "Female", "Other"}


class MemberDemographicsUpdate(BaseModel):
    """Request body for PATCH /api/v1/chw/members/{member_id}/demographics.

    CHW-editable demographics from the Member Profile pencil. Every field is
    optional so a partial update only touches what changed. first_name/last_name
    combine into User.name; phone updates User.phone; the rest live on
    MemberProfile. ``insurance`` writes both the displayed (insurance_provider)
    and billing (insurance_company) fields so they stay in sync.
    """

    first_name: str | None = Field(default=None, max_length=120)
    last_name: str | None = Field(default=None, max_length=120)
    preferred_name: str | None = Field(default=None, max_length=100)
    date_of_birth: date | None = None
    gender: str | None = None
    insurance: str | None = Field(default=None, max_length=120)
    medi_cal_id: str | None = None
    address_line1: str | None = Field(default=None, max_length=160)
    address_line2: str | None = Field(default=None, max_length=160)
    city: str | None = Field(default=None, max_length=80)
    state: str | None = None
    zip_code: str | None = Field(default=None, max_length=10)
    phone: str | None = Field(default=None, max_length=20)
    primary_language: str | None = Field(default=None, max_length=50)

    @field_validator("medi_cal_id")
    @classmethod
    def _normalize_cin(cls, value: str | None) -> str | None:
        """Normalize and validate the demo-seeding CIN when one is supplied.

        Accepts Medi-Cal CINs, 14-char BICs, and commercial/Medicare IDs.
        None / empty returns None (field is optional for demo seeds).
        Cross-reference: validate_cin_for_carrier() in app/schemas/cin_config.py.
        """
        if value is None:
            return None
        stripped = value.strip()
        if not stripped:
            return None
        normalized, is_valid = _validate_chw_cin(stripped, None)
        if not is_valid:
            raise ValueError(
                "Double-check the member ID — Medi-Cal CINs look like 91234567A2."
            )
        return normalized

    @field_validator("gender")
    @classmethod
    def _validate_gender(cls, value: str | None) -> str | None:
        if value is None:
            return None
        v = value.strip().title()
        if not v:
            return None
        if v not in _DEMO_GENDER_VALUES:
            raise ValueError(f"gender must be one of {sorted(_DEMO_GENDER_VALUES)}")
        return v

    @field_validator("state")
    @classmethod
    def _normalize_state(cls, value: str | None) -> str | None:
        if value is None:
            return None
        v = value.strip().upper()
        if not v:
            return None
        if len(v) != 2 or not v.isalpha():
            raise ValueError("state must be a 2-letter USPS code (e.g. CA)")
        return v


# Known resource-need verticals (mirrors native/src/data/mock.ts verticalLabels).
_RESOURCE_NEED_VALUES = {"housing", "transportation", "food", "food_security", "mental_health", "healthcare", "employment"}


class ResourceNeedsUpdate(BaseModel):
    """Request body for PATCH /api/v1/chw/members/{member_id}/resource-needs.

    ``needs`` is a caller-ordered list of resource categories (de-duped,
    lowercased).  ``levels`` is a list of {slug, level} items — one per need.
    Any slug absent from ``levels`` defaults to "medium" in the endpoint.

    Validation rules:
    - Each ``needs`` entry must be a known vertical slug.
    - Each ``levels`` item's level must be one of {"low", "medium", "high"}.
    - Every slug in ``levels`` must also appear in ``needs``; extra slugs → 422.
    - Duplicate slugs in ``levels`` are silently deduplicated (last entry wins).
    """

    needs: list[str] = Field(default_factory=list, max_length=10)
    levels: list[ResourceNeedLevelItem] = Field(default_factory=list)

    @field_validator("needs")
    @classmethod
    def _validate_needs(cls, value: list[str]) -> list[str]:
        seen: set[str] = set()
        out: list[str] = []
        for raw in value:
            need = raw.strip().lower()
            if not need:
                continue
            if need not in _RESOURCE_NEED_VALUES:
                raise ValueError(f"unknown resource need: {raw!r}")
            if need not in seen:
                seen.add(need)
                out.append(need)
        return out

    @model_validator(mode="after")
    def _levels_slugs_must_be_subset_of_needs(self) -> "ResourceNeedsUpdate":
        """Deduplicate levels (last wins) and reject any slug not in needs."""
        # Deduplicate: iterate reversed so last occurrence survives.
        seen_slugs: set[str] = set()
        deduped: list[ResourceNeedLevelItem] = []
        for item in reversed(self.levels):
            if item.slug not in seen_slugs:
                seen_slugs.add(item.slug)
                deduped.append(item)
        self.levels = list(reversed(deduped))

        extra = {item.slug for item in self.levels} - set(self.needs)
        if extra:
            raise ValueError(
                f"levels keys not in needs: {sorted(extra)}"
            )
        return self


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
    - age: derived from DOB — quick at-a-glance identifier.
    - date_of_birth: full DOB — the canonical patient-matching identifier the CHW
      uses to pull up the right member's records on request. Disclosed only to the
      relationship-gated CHW for their own caseload; consistent with
      CHWMemberProfileDetail which already exposes DOB to the same audience.
    - masked_id: last 4 chars of medi_cal_id only — enough for verbal verification.
    - avatar_initials: derived from display_name; no additional PHI.
    - risk: always null in v1 (no clinical model yet).
    - top_need: primary vertical of the most recent active ServiceRequest.

    Excluded: raw medi_cal_id, phone, insurance_provider, notes, transcripts.
    """

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    """Member's User.id — canonical identifier for navigation."""

    display_name: str
    """Decrypted full name for display."""

    age: int | None
    """Age in whole years, derived from DOB. Null when DOB is not recorded."""

    date_of_birth: date | None
    """Member's date of birth (ISO). Exposed to the CHW for their own caseload as
    the canonical patient-matching identifier when retrieving documents ("confirm
    your date of birth"). Consistent with CHWMemberProfileDetail, which already
    discloses full DOB to the relationship-gated CHW. Null when not recorded."""

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

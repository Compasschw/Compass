"""Pydantic response models for member-facing endpoints.

CHWMemberFacingProfile is the public-style view of a CHW that any
authenticated member may fetch. It deliberately exposes only the
professional/public fields a member needs to choose or understand their
CHW — analogous to how CHWMemberProfileView exposes the minimum-necessary
member information to a CHW (HIPAA §164.514(d)).

Fields deliberately excluded:
- CHW personal phone / email (not public; members contact via the platform)
- stripe_connected_account_id, payouts / finance state (irrelevant to member)
- latitude / longitude (ZIP-level granularity is sufficient for member context)
- rating_count (implementation detail; rating is surfaced)
- Any PHI from the CHW's own member caseload
"""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schemas.cin_config import validate_cin_for_carrier as _validate_cin_for_carrier


class CHWMemberFacingProfile(BaseModel):
    """Public-style CHW profile returned to an authenticated member.

    Maps to GET /api/v1/member/chws/{chw_id}.

    Field-level decisions:
    - ``last_name_initial``: first character of last_name + "." — privacy
      shorthand that identifies the CHW without exposing the full surname.
      E.g. "Smith" → "S.".
    - ``primary_specialization``: first element of CHWProfile.specializations,
      or None when the CHW hasn't completed intake.
    - ``years_experience``: human-readable bracket derived from the integer
      CHWProfile.years_experience column (0→"<1 year", 1→"1 year", 2+→"N years").
      Returned as a pre-formatted string so the frontend doesn't need to
      implement the bracket logic in two places.
    - ``ca_chw_certified``: derived from CHWIntake.ca_chw_certificate when the
      intake row exists and that field is "yes"; False otherwise. The CHWProfile
      model has no dedicated cert column today — this is Phase-2 expansion.
    - ``modality``: mapped from CHWIntake.preferred_modality when the intake row
      exists; values are "in_person" | "virtual" | "hybrid". None if not set.
    - ``service_area_zips``: list with CHWProfile.zip_code as the single element
      when set, else empty. Multi-ZIP service area is a Phase-2 feature.
    - ``available_days``: extracted from CHWProfile.availability_windows JSONB
      if present; falls back to [] when not set. The JSONB schema stores a
      dict of day-name → time-range, e.g. {"mon": "9-5", "tue": "9-5"}.
    - ``shared_session_count``: count of sessions WHERE chw_id == chw AND
      member_id == calling_member. Zero when no shared sessions exist.
    """

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    """CHW user ID — the canonical identifier used in navigation params."""

    first_name: str
    """First name from the CHW's User.name (split on first space)."""

    last_name_initial: str
    """First character of the last name + "." for privacy. E.g. "S."."""

    primary_language: str
    """First element of CHWProfile.languages if set, else "English"."""

    additional_languages: list[str]
    """Remaining elements of CHWProfile.languages after the first."""

    primary_specialization: str | None
    """First element of CHWProfile.specializations, or None."""

    years_experience: str | None
    """Human-readable experience bracket. None when CHWProfile row is absent."""

    ca_chw_certified: bool
    """True when CHWIntake.ca_chw_certificate == "yes"; False otherwise."""

    modality: str | None
    """Preferred session modality: "in_person" | "virtual" | "hybrid" | None."""

    service_area_zips: list[str]
    """ZIP codes the CHW serves. Single-element list (CHWProfile.zip_code) for now."""

    available_days: list[str]
    """Day abbreviations from availability_windows JSONB keys. E.g. ["mon","tue"]."""

    shared_session_count: int
    """Sessions this calling member has had with this CHW (any status)."""

    profile_picture_url: str | None = None
    """CHW's self-uploaded avatar, so the member sees the same photo the CHW set.
    Stored on the User row; returned as a short-lived presigned GET URL (or the
    raw value for external/data URLs). Null when no photo is set — the UI falls
    back to initials."""


# ── Services Consent schemas (T03) ────────────────────────────────────────────

_VALID_CONSENT_STATUSES = frozenset({"consent_to_services", "refuse_services"})


class ServicesConsentResponse(BaseModel):
    """Response body for GET/PATCH /api/v1/member/services-consent.

    Fields:
        status:     Current consent value — "consent_to_services" or
                    "refuse_services".
        changed_at: ISO-8601 UTC timestamp of the last flip, or None when
                    the field has never been explicitly set (legacy rows that
                    have only ever held the server default).
        changed_by: UUID of the user who last changed the status, or None
                    for rows that have never been explicitly set.
    """

    model_config = ConfigDict(from_attributes=True)

    status: str
    changed_at: datetime | None = None
    changed_by: UUID | None = None


class ServicesConsentUpdate(BaseModel):
    """Request body for PATCH /api/v1/member/services-consent.

    Only ``status`` is accepted — the server stamps ``changed_at`` and
    ``changed_by`` from the request context so the client cannot forge them.
    """

    status: str = Field(
        ...,
        description='Must be "consent_to_services" or "refuse_services".',
    )

    @field_validator("status")
    @classmethod
    def validate_status(cls, value: str) -> str:
        """Reject values outside the two-value enum."""
        if value not in _VALID_CONSENT_STATUSES:
            raise ValueError(
                f"status must be one of {sorted(_VALID_CONSENT_STATUSES)!r}, "
                f"got {value!r}"
            )
        return value


class BillingStatusResponse(BaseModel):
    """Response body for GET/PATCH /api/v1/members/{member_id}/billing-status.

    Fields:
        is_billable: True when the member's completed sessions are billable;
                     False marks them non-billable (excluded from Pear Suite
                     submission).
        changed_at:  ISO-8601 UTC timestamp of the last flip, or None when the
                     field has never been explicitly set (legacy rows on the
                     server default).
        changed_by:  UUID of the CHW/admin who last changed it, or None.
    """

    model_config = ConfigDict(from_attributes=True)

    is_billable: bool
    changed_at: datetime | None = None
    changed_by: UUID | None = None


class BillingStatusUpdate(BaseModel):
    """Request body for PATCH /api/v1/members/{member_id}/billing-status.

    Only ``is_billable`` is accepted — the server stamps ``changed_at`` and
    ``changed_by`` from the request context so the client cannot forge them.
    """

    is_billable: bool = Field(
        ...,
        description="True = billable, False = non-billable.",
    )


class InsuranceCINUpdate(BaseModel):
    """Request body for PATCH /api/v1/member/profile/insurance-cin.

    Both fields are required together — the member always provides insurance
    company and CIN in the same editing flow.  CIN is normalized to uppercase
    before storage.

    CIN format: 8 digits followed by exactly one letter (case-insensitive
    on input).  Examples: ``12345678A``, ``00000001Z``.
    """

    insurance_company: str = Field(
        ...,
        min_length=1,
        max_length=80,
        description="Insurance company name from the approved dropdown.",
    )
    medi_cal_id: str = Field(
        ...,
        description="Medi-Cal CIN in format ^\\d{8}[A-Z]$ (case-insensitive input).",
    )

    @field_validator("medi_cal_id")
    @classmethod
    def validate_and_normalize_cin(cls, value: str) -> str:
        """Normalize and validate the CIN on insurance-CIN PATCH.

        Accepts Medi-Cal CINs (^9\\d{7}[A-Z]\\d?$), 14-char BICs (extracted
        to 10-char CIN), and commercial/Medicare IDs (^[A-Z0-9]{6,15}$).
        Cross-reference: validate_cin_for_carrier() in app/schemas/cin_config.py.
        """
        normalized, is_valid = _validate_cin_for_carrier(value, None)
        if not is_valid:
            raise ValueError(
                f"Double-check the member ID — Medi-Cal CINs look like 91234567A2. "
                f"Got: {value!r}"
            )
        return normalized


class InsuranceCINResponse(BaseModel):
    """Response body for PATCH /api/v1/member/profile/insurance-cin."""

    model_config = ConfigDict(from_attributes=True)

    insurance_company: str | None
    medi_cal_id: str | None


# ── Flag Notes (T04) ──────────────────────────────────────────────────────────


class FlagNoteResponse(BaseModel):
    """Response body for GET /api/v1/members/{member_id}/flag-note.

    Returns the currently active flag note for a member, or null when none
    exists.  This schema intentionally omits ``is_active`` (always True for
    a returned note) and ``updated_at`` (not yet exposed in Phase 1).

    HIPAA note: ``body`` is PHI.  This response must only be returned to an
    authenticated CHW who has an active care relationship with the member.
    """

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    member_id: UUID
    author_chw_id: UUID
    body: str
    created_at: datetime


class FlagNoteCreate(BaseModel):
    """Request body for POST /api/v1/members/{member_id}/flag-note.

    Validation:
        body must be non-empty after stripping whitespace and must not exceed
        2 000 characters — long enough for any practical note, short enough to
        prevent abuse.
    """

    body: str = Field(
        ...,
        min_length=1,
        max_length=2000,
        description="Free-form CHW note about the member (PHI — CHW-visible only).",
    )

    @field_validator("body")
    @classmethod
    def body_not_blank(cls, value: str) -> str:
        """Reject whitespace-only bodies."""
        stripped = value.strip()
        if not stripped:
            raise ValueError("body must not be blank or whitespace-only.")
        return stripped

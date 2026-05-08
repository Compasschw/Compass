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

from uuid import UUID

from pydantic import BaseModel, ConfigDict


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

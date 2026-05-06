from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.models.enums import SessionMode, Urgency, Vertical

# All valid vertical string values — used for cross-field validation.
_VALID_VERTICALS: frozenset[str] = frozenset(v.value for v in Vertical)


class ServiceRequestCreate(BaseModel):
    """Input schema for POST /api/v1/requests.

    Multi-vertical support
    ──────────────────────
    `verticals` (list, min 1) is the preferred field. Each element must be a
    valid Vertical enum value.

    `vertical` (single string) is still accepted for legacy callers that have
    not yet migrated. When *only* `vertical` is supplied, the handler promotes
    it into `verticals` automatically. When both are supplied, `verticals`
    takes precedence.
    """

    verticals: list[Vertical] = Field(
        default=[],
        description="One or more verticals the member needs help with (preferred field).",
    )
    # Kept for backwards-compat with old mobile clients that send a single
    # `vertical` string. The endpoint coerces it to [vertical] when
    # `verticals` is empty.
    vertical: Vertical | None = Field(
        default=None,
        description="Deprecated: use `verticals`. Still accepted for backwards compatibility.",
    )
    urgency: Urgency = Urgency.routine
    description: str = Field(default="", description="Optional member-supplied context.")
    preferred_mode: SessionMode = SessionMode.in_person
    estimated_units: int = Field(default=1, ge=1, le=4)

    @field_validator("verticals", mode="before")
    @classmethod
    def coerce_vertical_strings(cls, v: object) -> list[str]:
        """Accept bare strings inside the list without requiring callers to
        send enum labels — the Vertical enum validator downstream handles
        the conversion to the enum type."""
        if not isinstance(v, list):
            raise ValueError("verticals must be a list")
        return v

    def resolved_verticals(self) -> list[Vertical]:
        """Return the canonical list of verticals, falling back to [vertical]
        when the caller sent only the legacy single-vertical field.

        Raises ValueError when neither field is populated.
        """
        if self.verticals:
            return self.verticals
        if self.vertical is not None:
            return [self.vertical]
        raise ValueError("At least one vertical must be specified.")


class ServiceRequestResponse(BaseModel):
    """Full request detail — visible to the member who created it and to the
    CHW who has been matched/accepted. Contains PHI (description, member name).
    """

    model_config = ConfigDict(from_attributes=True)
    id: UUID
    member_id: UUID
    matched_chw_id: UUID | None
    # Legacy single-vertical field — kept for backwards compatibility.
    vertical: str
    # Authoritative multi-vertical array.
    verticals: list[str]
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
    verticals, urgency, mode, estimated units, and approximate location (zip prefix).
    """

    model_config = ConfigDict(from_attributes=True)
    id: UUID
    # Legacy single-vertical field — kept for backwards compatibility.
    vertical: str
    # Authoritative multi-vertical array.
    verticals: list[str]
    urgency: str
    preferred_mode: str
    status: str
    estimated_units: int
    created_at: datetime


class ServiceRequestUpdate(BaseModel):
    status: str | None = None
    matched_chw_id: UUID | None = None

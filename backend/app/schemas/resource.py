"""Pydantic schemas for the CHW Resource Folder feature.

Naming convention:
  - *Create / *Update  — inbound request bodies
  - *Response          — outbound API response shapes
  - *SuggestionCreate  — CHW-submitted suggestion body

All response schemas include ``model_config = ConfigDict(from_attributes=True)``
so they can be constructed directly from SQLAlchemy ORM instances via
``model_validate(orm_obj)``.
"""

from collections.abc import Iterable
from datetime import datetime
from typing import Literal, cast
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

# ─── Enums (mirrored from models/resource.py) ─────────────────────────────────

# Epic C5: 'housing' is GRANDFATHERED here, not removed. ResourceUpdate.category
# is used by a read-then-full-resave admin edit form (AdminResourcesScreen.tsx
# resourceToForm() seeds `category` from the existing resource; the edit form
# always resends the full category on save, even when the admin only touched
# an unrelated field) — so an existing housing-categorized resource must keep
# validating on every edit, not just at creation time. The admin CategoryPicker
# (native/src/screens/admin/AdminResourcesScreen.tsx CATEGORIES) no longer
# offers 'housing' for NEW selection; 'utilities' is its replacement there.
# ResourceCreate also uses this same Literal (its form always starts at
# category: 'other', so 'housing' is unreachable from that path in practice,
# but a shared type keeps Create/Update in sync and is easier to reason about
# than gate-per-call-site).
ResourceCategory = Literal[
    "housing",
    "utilities",
    "food",
    "mental_health",
    "rehab",
    "healthcare",
    "legal",
    "transportation",
    "other",
]

ResourceStatus = Literal["active", "inactive"]

SuggestionStatus = Literal["pending", "approved", "rejected"]


# ─── Resource schemas ──────────────────────────────────────────────────────────


class ResourceResponse(BaseModel):
    """Full resource row returned to CHWs and admins.

    Does not expose ``created_by_admin_id`` to non-admin callers — that
    field is an internal audit trail identifier, not useful for CHW search
    results.  Admins get it via AdminResourceResponse below.
    """

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    description: str
    category: str
    url: str | None
    phone: str | None
    address: str | None
    zip_code: str | None
    latitude: float | None
    longitude: float | None
    hours: str | None
    eligibility: str | None
    languages: list[str]
    status: str
    created_at: datetime


class AdminResourceResponse(ResourceResponse):
    """Extended resource response for admin endpoints — includes audit fields."""

    created_by_admin_id: UUID | None


class ResourceCreate(BaseModel):
    """Body for admin POST /api/v1/admin/resources."""

    name: str = Field(..., min_length=1, max_length=255)
    description: str = Field(..., min_length=1)
    category: ResourceCategory
    url: str | None = Field(default=None, max_length=500)
    phone: str | None = Field(default=None, max_length=20)
    address: str | None = Field(default=None, max_length=500)
    zip_code: str | None = Field(default=None, max_length=10)
    latitude: float | None = None
    longitude: float | None = None
    hours: str | None = None
    eligibility: str | None = None
    languages: list[str] = Field(default_factory=list)

    @field_validator("languages", mode="before")
    @classmethod
    def coerce_languages_to_list(cls, value: object) -> list[str]:
        """Accept None or a bare string for languages and normalise to list."""
        if value is None:
            return []
        if isinstance(value, str):
            return [value]
        # cast: pydantic re-validates element types after this before-validator;
        # a non-iterable still raises TypeError inside list() exactly as before.
        return list(cast(Iterable[str], value))


class ResourceUpdate(BaseModel):
    """Body for admin PATCH /api/v1/admin/resources/{id}.

    All fields are optional — only provided fields are applied.
    """

    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = Field(default=None, min_length=1)
    category: ResourceCategory | None = None
    url: str | None = Field(default=None, max_length=500)
    phone: str | None = Field(default=None, max_length=20)
    address: str | None = Field(default=None, max_length=500)
    zip_code: str | None = Field(default=None, max_length=10)
    latitude: float | None = None
    longitude: float | None = None
    hours: str | None = None
    eligibility: str | None = None
    languages: list[str] | None = None
    status: ResourceStatus | None = None

    @field_validator("languages", mode="before")
    @classmethod
    def coerce_languages_to_list(cls, value: object) -> list[str] | None:
        if value is None:
            return None
        if isinstance(value, str):
            return [value]
        # cast: pydantic re-validates element types after this before-validator;
        # a non-iterable still raises TypeError inside list() exactly as before.
        return list(cast(Iterable[str], value))


# ─── ResourceSuggestion schemas ────────────────────────────────────────────────


class ResourceSuggestionCreate(BaseModel):
    """Body for CHW POST /api/v1/chw/resources/suggestions.

    ``proposed_resource`` is free-form; validation is intentionally loose
    because CHWs may only know a name + phone number.  Admins fill in the
    rest during review.  Require at minimum a ``name`` key so the admin
    queue has something to display.
    """

    proposed_resource: dict = Field(
        ...,
        description="Free-form resource data. Must contain at least a 'name' key.",
    )
    notes: str | None = Field(
        default=None,
        max_length=2000,
        description="Optional CHW note explaining why this should be added.",
    )

    @field_validator("proposed_resource")
    @classmethod
    def require_name_key(cls, value: dict) -> dict:
        if not value.get("name"):
            raise ValueError("proposed_resource must contain a non-empty 'name' field")
        return value


class ResourceSuggestionResponse(BaseModel):
    """Suggestion row returned to both CHWs (own submissions) and admins."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    chw_id: UUID
    proposed_resource: dict
    notes: str | None
    status: str
    reviewed_by_admin_id: UUID | None
    created_at: datetime
    reviewed_at: datetime | None


class SuggestionRejectBody(BaseModel):
    """Optional body for POST /admin/resources/suggestions/{id}/reject."""

    admin_notes: str | None = Field(
        default=None,
        max_length=2000,
        description="Optional explanation surfaced to the CHW.",
    )


class SuggestionApproveBody(BaseModel):
    """Body for POST /admin/resources/suggestions/{id}/approve.

    The admin can override any field from the CHW's proposed_resource
    before the row is promoted to a real Resource.  Fields not supplied
    here fall back to whatever the CHW provided in proposed_resource.
    All fields are optional — the minimum viable approve just calls the
    endpoint with an empty body and the CHW's data is used verbatim.
    """

    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = Field(default=None, min_length=1)
    category: ResourceCategory | None = None
    url: str | None = Field(default=None, max_length=500)
    phone: str | None = Field(default=None, max_length=20)
    address: str | None = Field(default=None, max_length=500)
    zip_code: str | None = Field(default=None, max_length=10)
    latitude: float | None = None
    longitude: float | None = None
    hours: str | None = None
    eligibility: str | None = None
    languages: list[str] | None = None

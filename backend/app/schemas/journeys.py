"""Pydantic schemas for the Journeys feature.

All schemas use model_config = ConfigDict(from_attributes=True) so they can be
constructed directly from SQLAlchemy ORM instances.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict


# ─── Template schemas ──────────────────────────────────────────────────────────


class JourneyStepResponse(BaseModel):
    """A single step within a JourneyTemplate."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    template_id: uuid.UUID
    order: int
    name: str
    description: str
    points_on_completion: int
    required_documents: list[str]
    created_at: datetime


class JourneyTemplateResponse(BaseModel):
    """Public representation of a JourneyTemplate including its steps."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    slug: str
    name: str
    category: str
    icon: str
    is_active: bool
    steps: list[JourneyStepResponse] = []
    created_at: datetime


# ─── Member-journey step state ─────────────────────────────────────────────────


class MemberJourneyStepResponse(BaseModel):
    """A JourneyTemplateStep merged with its per-member state.

    The ``step_*`` fields come from JourneyTemplateStep; the remaining fields
    come from MemberJourneyStepState.
    """

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID  # MemberJourneyStepState.id
    member_journey_id: uuid.UUID
    template_step_id: uuid.UUID
    step_order: int
    step_name: str
    step_description: str
    points_on_completion: int
    required_documents: list[str]
    # Per-member state
    status: str  # upcoming | in_progress | completed | missed
    started_at: datetime | None
    completed_at: datetime | None
    due_date: datetime | None
    points_awarded: int
    created_at: datetime


# ─── Member-journey aggregate ──────────────────────────────────────────────────


class MemberJourneyResponse(BaseModel):
    """Full member-journey view including template metadata, step states, and
    computed progress.

    ``progress_percent`` = completed_steps / total_steps * 100, rounded to one
    decimal place.

    ``wellness_points_earned`` = sum of points_awarded across all steps for
    this journey (NOT the member's total balance — use the ledger endpoint for
    that).
    """

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    member_id: uuid.UUID
    chw_id: uuid.UUID
    template: JourneyTemplateResponse
    steps: list[MemberJourneyStepResponse]
    status: str  # active | paused | completed | abandoned
    progress_percent: float
    current_step: MemberJourneyStepResponse | None
    wellness_points_earned: int
    started_at: datetime
    completed_at: datetime | None
    created_at: datetime


# ─── Caseload item (lightweight) ───────────────────────────────────────────────


class CaseloadJourneyItem(BaseModel):
    """Lightweight representation used in the CHW caseload list view.

    Avoids eager-loading all step state for every member on the caseload page.
    """

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    member_id: uuid.UUID
    member_name: str
    template_name: str
    template_slug: str
    template_icon: str
    status: str
    progress_percent: float
    current_step_name: str | None
    wellness_points_earned: int
    started_at: datetime
    completed_at: datetime | None


# ─── Request schemas ───────────────────────────────────────────────────────────


class CreateMemberJourneyRequest(BaseModel):
    """Body for POST /members/{member_id}/journeys."""

    member_id: uuid.UUID
    template_slug: str


class UpdateStepStatusRequest(BaseModel):
    """Body for PATCH /journeys/{member_journey_id}/steps/{step_id}.

    CHW can mark a step in_progress, completed, or missed.
    Optional notes are stored on the MemberJourneyStepState row (CHW-only,
    not surfaced to the member in the default response).
    """

    status: Literal["in_progress", "completed", "missed"]
    notes: str | None = None


# ─── Wellness points ───────────────────────────────────────────────────────────


class WellnessLedgerEntry(BaseModel):
    """A single entry in the wellness-points ledger."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    member_id: uuid.UUID
    points: int
    reason: str
    related_id: uuid.UUID | None
    created_at: datetime


class WellnessPointsSummary(BaseModel):
    """Response for GET /members/{member_id}/wellness-points."""

    total_points: int
    ledger: list[WellnessLedgerEntry]

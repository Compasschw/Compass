"""Pydantic v2 response/request schemas for session follow-up extraction.

HIPAA: ``description`` is PHI.  It is intentionally included in these schemas
because the follow-up endpoint returns structured data back to verified
participants only.  Never include description in logs or error messages.
"""

from datetime import date, datetime
from enum import Enum
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


# ── Enums for constrained string fields ──────────────────────────────────────

class FollowupKind(str, Enum):
    action_item = "action_item"
    follow_up_task = "follow_up_task"
    resource_referral = "resource_referral"
    member_goal = "member_goal"


class FollowupOwner(str, Enum):
    chw = "chw"
    member = "member"
    both = "both"


class FollowupPriority(str, Enum):
    low = "low"
    medium = "medium"
    high = "high"


class FollowupStatus(str, Enum):
    pending = "pending"
    confirmed = "confirmed"
    dismissed = "dismissed"
    completed = "completed"


# ── Response model ────────────────────────────────────────────────────────────

class SessionFollowupResponse(BaseModel):
    """Single follow-up item as returned to the API caller."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    session_id: UUID
    member_id: UUID
    chw_id: UUID
    kind: FollowupKind
    # description is PHI — included intentionally for participants, never log
    description: str
    owner: FollowupOwner | None
    vertical: str | None
    priority: FollowupPriority | None
    due_date: date | None
    status: FollowupStatus
    auto_created: bool
    show_on_roadmap: bool
    confirmed_by_user_id: UUID | None
    confirmed_at: datetime | None
    created_at: datetime
    updated_at: datetime


class ExtractFollowupsResponse(BaseModel):
    """Envelope returned by POST /sessions/{id}/extract-followups."""

    session_id: UUID
    followups: list[SessionFollowupResponse]
    # Counts only — never log or embed the description values in this summary
    action_items_count: int = Field(ge=0)
    follow_up_tasks_count: int = Field(ge=0)
    resource_referrals_count: int = Field(ge=0)
    member_goals_count: int = Field(ge=0)
    was_cached: bool = Field(
        default=False,
        description="True if extraction already ran and existing rows were returned",
    )


# ── Patch (CHW review actions) ────────────────────────────────────────────────

class SessionFollowupPatch(BaseModel):
    """Mutable subset of SessionFollowup writable via PATCH.

    Used by CHWSessionReviewScreen for confirm/dismiss/edit actions and by
    MemberRoadmapScreen for marking items complete. All fields optional;
    only those provided are applied.
    """

    description: str | None = None
    owner: FollowupOwner | None = None
    vertical: str | None = None
    priority: FollowupPriority | None = None
    due_date: date | None = None
    status: FollowupStatus | None = None
    show_on_roadmap: bool | None = None


# ── Roadmap surface schema ────────────────────────────────────────────────────

class RoadmapItemResponse(BaseModel):
    """Projection of a SessionFollowup row for MemberRoadmapScreen.

    Subset of SessionFollowupResponse — only the fields the member-facing
    roadmap UI needs.  Keeps the contract minimal and avoids leaking CHW-only
    fields (chw_id, auto_created, session_id) to the member app.

    `session_id` is included so the member-side "mark complete" action can
    locate the underlying row via PATCH /sessions/{id}/followups/{id}.
    """

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    session_id: UUID
    kind: FollowupKind
    description: str
    vertical: str | None
    priority: FollowupPriority | None
    due_date: date | None
    status: FollowupStatus
    show_on_roadmap: bool
    created_at: datetime

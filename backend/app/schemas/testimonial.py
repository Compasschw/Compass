"""Pydantic schemas for the Testimonials feature.

Schema hierarchy
----------------
TestimonialCreate         — member POST body (rating + optional text), session-scoped flow
TestimonialClosureCreate  — Epic B3: CHW-facilitated closure-review POST body
                             (text only, 1..120 chars, no rating)
TestimonialResponse       — full row for internal / member-facing use
TestimonialClosureResponse — Epic B3: response for the closure-review endpoint
PublicTestimonial         — stripped for the CHW Profile public display;
                            member_id replaced by author_initial ("M.")
AdminTestimonialView      — full row + member_name for admin moderation queue
AdminModerateBody         — admin action body (approve | reject + optional notes)
TestimonialSummary        — aggregate { rating_avg, rating_count } for CHW summary header
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class TestimonialCreate(BaseModel):
    """Body accepted when a member submits a testimonial for a CHW.

    Both rating bounds and text length are enforced here at the schema boundary
    and mirrored in a DB CHECK constraint for defence-in-depth.
    """

    rating: int = Field(
        ...,
        ge=1,
        le=5,
        description="Star rating from 1 (lowest) to 5 (highest).",
    )
    text: str | None = Field(
        default=None,
        max_length=500,
        description="Optional free-text review body. Maximum 500 characters.",
    )


class TestimonialClosureCreate(BaseModel):
    """Body accepted by POST /chw/members/{member_id}/closure-review (Epic B3).

    CHW-facilitated capture of the member's parting feedback when a CHW
    closes the member's case. Deliberately text-only — the member is
    typically not logged in at close time, so a star rating (which needs an
    authenticated member's own affirmative input for other testimonials) is
    not collected here. Rating stays absent/None on the created Testimonial
    row; the session-scoped TestimonialCreate above is unaffected and still
    requires rating.

    ``text`` is REQUIRED at this schema layer (1..120 chars) because the
    endpoint itself is only called when the CHW has entered text in the
    on-brand prompt — the "skip" action on the frontend simply never calls
    this endpoint at all (see CHWMemberProfileScreen close flow).
    """

    text: str = Field(
        ...,
        min_length=1,
        max_length=120,
        description="Member's parting feedback about their experience with "
                    "their CHW. 1-120 characters.",
    )


class TestimonialResponse(BaseModel):
    """Full testimonial row — used internally and in member-facing contexts
    where member_id disclosure is acceptable (e.g. within the authenticated
    member's own session view).
    """

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    chw_id: uuid.UUID
    member_id: uuid.UUID
    session_id: uuid.UUID | None
    rating: int | None
    text: str | None
    status: str
    created_at: datetime


class TestimonialClosureResponse(BaseModel):
    """Response for POST /chw/members/{member_id}/closure-review (Epic B3).

    Deliberately narrower than TestimonialResponse: the caller is a CHW
    relaying member feedback, not the member themselves, so this omits
    member_id/chw_id disclosure nuance and just confirms what was recorded.
    """

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    member_id: uuid.UUID
    chw_id: uuid.UUID
    text: str | None
    status: str
    source: str
    created_at: datetime


class PublicTestimonial(BaseModel):
    """Stripped testimonial for the public CHW Profile display.

    member_id is deliberately excluded. author_initial is derived at
    serialisation time from the member's first_name (first letter + "."),
    e.g. "Rosa" → "R.". This preserves privacy while giving the testimonial
    enough human context to feel authentic.
    """

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    rating: int | None
    text: str | None
    author_initial: str = Field(
        ...,
        description='First letter of the member first name + "." (e.g. "M.").',
    )
    created_at: datetime


class AdminTestimonialView(BaseModel):
    """Full testimonial row enriched with member and CHW display names
    for the admin moderation queue.
    """

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    chw_id: uuid.UUID
    chw_name: str
    member_id: uuid.UUID
    member_name: str
    session_id: uuid.UUID | None
    rating: int | None
    text: str | None
    status: str
    # Epic B3: 'session' | 'account_closure' — lets the moderation queue
    # distinguish CHW-facilitated closure reviews from member session ratings.
    source: str
    moderation_notes: str | None
    created_at: datetime
    moderated_at: datetime | None


class AdminModerateBody(BaseModel):
    """Body for the admin moderation endpoint.

    ``action`` is a union literal so FastAPI/Pydantic rejects any value outside
    {"approve", "reject"} with a 422 before the handler runs.
    """

    action: Literal["approve", "reject"]
    notes: str | None = Field(
        default=None,
        max_length=1000,
        description="Optional admin note stored in moderation_notes.",
    )


class TestimonialSummary(BaseModel):
    """Aggregate stats for the CHW Profile rating header.

    ``rating_avg`` is None (not 0.0) when no approved testimonials exist so
    callers can distinguish "no ratings yet" from "average is exactly 0".
    """

    rating_avg: float | None = Field(
        description="Average star rating across all approved testimonials. "
                    "None when rating_count is 0.",
    )
    rating_count: int = Field(
        description="Number of approved testimonials contributing to the average.",
    )

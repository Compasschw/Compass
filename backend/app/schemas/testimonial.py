"""Pydantic schemas for the Testimonials feature.

Schema hierarchy
----------------
TestimonialCreate      — member POST body (rating + optional text)
TestimonialResponse    — full row for internal / member-facing use
PublicTestimonial      — stripped for the CHW Profile public display;
                         member_id replaced by author_initial ("M.")
AdminTestimonialView   — full row + member_name for admin moderation queue
AdminModerateBody      — admin action body (approve | reject + optional notes)
TestimonialSummary     — aggregate { rating_avg, rating_count } for CHW summary header
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
    rating: int
    text: str | None
    status: str
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
    rating: int
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
    rating: int
    text: str | None
    status: str
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

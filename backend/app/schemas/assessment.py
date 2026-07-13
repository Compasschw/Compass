"""Pydantic schemas for the assessment engine API.

Naming convention: *Create for request bodies, *Response for response shapes.
All timestamps are timezone-aware (UTC).
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field, model_validator

# Placeholder answer_value/answer_label written when a question is skipped
# (Epic W2). Kept as a private constant so the router and any future caller
# stay in lockstep — never hand-typed in more than one place.
SKIPPED_ANSWER_VALUE = "skipped"
SKIPPED_ANSWER_LABEL = "Skipped"

# ---------------------------------------------------------------------------
# Request schemas
# ---------------------------------------------------------------------------


class AssessmentStartRequest(BaseModel):
    """Body for POST /api/v1/sessions/{session_id}/assessments."""

    template_id: str = Field(
        ...,
        description=(
            "The template to use for this assessment. "
            "E.g. 'compass_member_v1'. Must be a registered template ID."
        ),
        min_length=1,
        max_length=100,
    )


class AssessmentResponseCreate(BaseModel):
    """Body for POST /api/v1/assessments/{assessment_id}/responses.

    The client submits one response at a time — per-answer persistence.
    ``captured_at`` defaults to server UTC time if not provided.
    Multiple responses to the same ``question_id`` are allowed and create
    new rows (re-assessment history), never updates.
    """

    question_id: str = Field(
        ...,
        description="Stable programmatic question identifier (e.g. 'housing_situation').",
        min_length=1,
        max_length=100,
    )
    question_text: str = Field(
        ...,
        description=(
            "Snapshot of the question text at the time of capture. "
            "Stored verbatim so renames don't break history."
        ),
        min_length=1,
        max_length=500,
    )
    answer_value: str | None = Field(
        default=None,
        description=(
            "The selected option key (e.g. 'yes', 'no', 'own_or_rent_stable'). "
            "Required unless skipped=True, in which case it defaults to "
            f"'{SKIPPED_ANSWER_VALUE}' if omitted."
        ),
        max_length=500,
    )
    answer_label: str | None = Field(
        default=None,
        description=(
            "Snapshot of the human-readable label at capture time. "
            "Required unless skipped=True, in which case it defaults to "
            f"'{SKIPPED_ANSWER_LABEL}' if omitted."
        ),
        max_length=500,
    )
    skipped: bool = Field(
        default=False,
        description=(
            "Epic W2 — True when the CHW tapped 'Skip' for this question "
            "instead of selecting an answer. A skipped response is distinct "
            "from both a real answer (skipped=False) and an unanswered "
            "question (no row at all). Skipped responses still count toward "
            "the 'X of 39' progress total."
        ),
    )
    category: str = Field(
        ...,
        description="Top-level category: 'sdoh' or 'medical'.",
        pattern=r"^(sdoh|medical)$",
    )
    subcategory: str = Field(
        ...,
        description="Finer-grained domain (e.g. 'housing', 'blood_pressure').",
        min_length=1,
        max_length=40,
    )
    tags: list[str] = Field(
        default_factory=list,
        description="Source-PDF classification tags (e.g. ['HEDIS', 'SDOH']).",
    )
    # If the client does not supply captured_at, the router stamps server UTC time.
    captured_at: datetime | None = Field(
        default=None,
        description=(
            "ISO-8601 UTC timestamp of when this answer was selected. "
            "Defaults to server time if omitted."
        ),
    )

    @model_validator(mode="after")
    def _validate_answer_fields_for_skip_state(self) -> AssessmentResponseCreate:
        """Enforce the skipped/answered contract.

        - skipped=False (default): answer_value and answer_label are REQUIRED
          and must be non-empty — identical to the pre-Epic-W2 contract, so
          every existing caller/test continues to work unmodified.
        - skipped=True: answer_value/answer_label are OPTIONAL. If the client
          omits them, they default to the reserved placeholder
          ('skipped'/'Skipped') rather than being left null, so downstream
          readers of this table never have to special-case NULL.
        """
        if self.skipped:
            if not self.answer_value:
                self.answer_value = SKIPPED_ANSWER_VALUE
            if not self.answer_label:
                self.answer_label = SKIPPED_ANSWER_LABEL
            return self

        if not self.answer_value or not self.answer_value.strip():
            raise ValueError("answer_value is required when skipped is False.")
        if not self.answer_label or not self.answer_label.strip():
            raise ValueError("answer_label is required when skipped is False.")
        return self


# ---------------------------------------------------------------------------
# Response schemas
# ---------------------------------------------------------------------------


class AssessmentResponseOut(BaseModel):
    """Represents a single captured answer row."""

    id: UUID
    assessment_id: UUID
    question_id: str
    question_text: str
    answer_value: str
    answer_label: str
    skipped: bool
    category: str
    subcategory: str
    tags: list[str]
    captured_at: datetime
    captured_by_chw_id: UUID

    model_config = {"from_attributes": True}


class AssessmentOut(BaseModel):
    """Full assessment row, optionally with responses included."""

    id: UUID
    member_id: UUID
    session_id: UUID | None
    template_id: str
    chw_id: UUID
    status: str
    created_at: datetime
    completed_at: datetime | None
    responses: list[AssessmentResponseOut] = Field(default_factory=list)

    model_config = {"from_attributes": True}

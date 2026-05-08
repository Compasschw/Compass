"""SQLAlchemy models for the flexible questionnaire engine.

Tables
------
MemberAssessment
    One row per "assessment session" — created when a CHW starts the questionnaire
    with a member. Ties together a member, an optional session, a template, and
    a lifecycle status.

MemberAssessmentResponse
    One row per answer captured. Per-answer timestamping is the primary design
    requirement here: every response records *when* it was answered and *who*
    answered it (the CHW), giving a complete audit trail that survives question
    renames (question_text is a snapshot at capture time).

Design decisions
----------------
- question_text and answer_label are SNAPSHOT columns. Even if founders rename
  a question or option label in the template, historical responses still show
  the exact wording the member heard.
- Multiple responses to the same question_id are permitted (re-assessment rows
  rather than UPDATE). A later query can SELECT the MAX(captured_at) row per
  question to get the current answer.
- tags is JSONB (array of strings) so it indexes well and the AI summary /
  admin reporting layer can filter on e.g. tags @> '["HEDIS"]'.
- session_id is NULLABLE — assessments may be conducted outside a live session
  (e.g., in-person visit where the session is not tracked digitally).
- status uses a string enum kept as VARCHAR(20) for portability. The valid
  values mirror the Session pattern elsewhere in the codebase.
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class MemberAssessment(Base):
    """One assessment "run" for a member.

    A member may have many completed assessments over time (repeat screenings).
    Each assessment is tied to a single template version so the response set can
    be interpreted correctly even after the template evolves.
    """

    __tablename__ = "member_assessments"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    member_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id"),
        nullable=False,
        index=True,
    )
    # Nullable — assessment may be conducted outside a formal session (e.g. phone
    # intake that hasn't been migrated to the session system yet).
    session_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("sessions.id"),
        nullable=True,
        index=True,
    )
    # Template identifier — e.g. "compass_member_v1". Stored as a plain string so
    # a new template version is simply a new string value, no schema change needed.
    template_id: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    # The CHW who administered the assessment.
    chw_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id"),
        nullable=False,
        index=True,
    )
    # Lifecycle: in_progress → completed | abandoned
    # in_progress: CHW has started but not finished.
    # completed:   CHW tapped "Done" — all required questions answered.
    # abandoned:   CHW paused and never resumed; no further answers expected.
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="in_progress", index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    # Stamped when status transitions to 'completed'.
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    __table_args__ = (
        # Composite index: "all in_progress assessments for this member+template"
        # used by the idempotency check in the start-assessment endpoint.
        Index(
            "ix_member_assessments_member_template_status",
            "member_id",
            "template_id",
            "status",
        ),
    )


class MemberAssessmentResponse(Base):
    """A single captured answer within a MemberAssessment.

    Per-answer persistence (not bulk submit) — each row is written the moment
    the CHW taps an answer on the form. This provides:
    1. No data loss if the CHW's device loses connectivity mid-assessment.
    2. A complete audit trail with per-answer timestamps.
    3. Re-assessment support — a second (or third) answer to the same question_id
       produces a new row, never an UPDATE, preserving the history.

    To get the "current" answer for a question, query:
        SELECT * FROM member_assessment_responses
        WHERE assessment_id = :id AND question_id = :qid
        ORDER BY captured_at DESC LIMIT 1
    """

    __tablename__ = "member_assessment_responses"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    assessment_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("member_assessments.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Stable programmatic identifier (e.g. "housing_situation", "blood_pressure_diagnosis").
    # Never changes — used for programmatic lookups and filter queries.
    question_id: Mapped[str] = mapped_column(String(100), nullable=False)
    # SNAPSHOT of question text at capture time. Survives template renames.
    question_text: Mapped[str] = mapped_column(String(500), nullable=False)
    # The selected option key (e.g. "yes", "no", "sometimes").
    answer_value: Mapped[str] = mapped_column(String(500), nullable=False)
    # SNAPSHOT of the human-readable label at capture time.
    answer_label: Mapped[str] = mapped_column(String(500), nullable=False)
    # Top-level category — "sdoh" or "medical".
    category: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    # Finer-grained domain — "housing", "food_access", "blood_pressure", etc.
    subcategory: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    # Array of source-PDF tags: ["HEDIS"], ["SDOH"], ["Member needs"], or combinations.
    # JSONB gives us the @> operator for "has this tag?" queries without a join table.
    tags: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    # The exact moment this answer was recorded (server time if not provided by client).
    captured_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    # The CHW who recorded the answer — may differ from the assessment.chw_id if
    # a supervisor completes a partial assessment (future use case).
    captured_by_chw_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id"),
        nullable=False,
    )

    __table_args__ = (
        # Hot-path: fetch all responses for one assessment ordered by capture time.
        Index(
            "ix_assessment_responses_assessment_captured",
            "assessment_id",
            "captured_at",
        ),
        # Supports "latest answer per question" query pattern.
        Index(
            "ix_assessment_responses_assessment_question",
            "assessment_id",
            "question_id",
        ),
    )

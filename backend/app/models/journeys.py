"""SQLAlchemy models for the Journeys feature.

Five tables:
  - JourneyTemplate        — reusable care-pathway definition (e.g. "Food Assistance")
  - JourneyTemplateStep    — ordered steps within a template
  - MemberJourney          — an instance of a template assigned to a member
  - MemberJourneyStepState — per-step status for a member's journey
  - WellnessPointsLedger   — append-only ledger of wellness-point grants/deductions

The ledger is intentionally append-only at the application layer.
The migration REVOKEs UPDATE/DELETE from the app role to enforce this at the
DB layer as well.
"""

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class JourneyTemplate(Base):
    """Reusable definition of a care pathway, e.g. 'Food Assistance' with 6 steps.

    Slugs are unique across the system and used as stable identifiers when
    creating member journeys from the API (avoids UUID management on the
    frontend).
    """

    __tablename__ = "journey_templates"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    slug: Mapped[str] = mapped_column(String(100), unique=True, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    # SDOH category — food, housing, mental_health, transportation, maternal_health, etc.
    category: Mapped[str] = mapped_column(String(100), nullable=False)
    # Lucide icon name rendered by the frontend (e.g. "utensils", "home")
    icon: Mapped[str] = mapped_column(String(100), nullable=False, server_default="circle")
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="true")
    # True for per-member, CHW-authored journeys (private editable template).
    # Excluded from the shared template picker; the only templates a CHW may edit.
    is_custom: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class JourneyTemplateStep(Base):
    """Ordered steps within a JourneyTemplate.

    ``order`` is 1-based and must be unique per template_id. The ordering is
    used to advance ``current_step_id`` on MemberJourney when a step is
    completed.
    """

    __tablename__ = "journey_template_steps"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    template_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("journey_templates.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    order: Mapped[int] = mapped_column(Integer, nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    points_on_completion: Mapped[int] = mapped_column(Integer, nullable=False, server_default="10")
    # JSONB array of document-type strings the member must provide for this step.
    # Example: ["proof_of_income", "photo_id"]
    required_documents: Mapped[list] = mapped_column(
        JSONB, nullable=False, server_default="[]"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class MemberJourney(Base):
    """An instance of a JourneyTemplate assigned to a specific member.

    A member may have multiple MemberJourney rows (one per template), but the
    application layer enforces at most one active journey per template per
    member to prevent duplicate-journey confusion on the caseload view.

    ``current_step_id`` always points at the JourneyTemplateStep the member is
    currently working on. It advances on each step completion and becomes NULL
    when the journey reaches status='completed'.
    """

    __tablename__ = "member_journeys"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    member_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
    )
    template_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("journey_templates.id", ondelete="RESTRICT"),
        nullable=False,
    )
    chw_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
    )
    # active | paused | completed | abandoned
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, server_default="active"
    )
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Points at the step the member is currently on. NULL once completed.
    current_step_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("journey_template_steps.id", ondelete="SET NULL"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class MemberJourneyStepState(Base):
    """Per-step status for a member's journey.

    One row per (member_journey_id, template_step_id) pair. All rows for a
    journey are created together when the MemberJourney is first assigned —
    initial status is 'upcoming' for every step except the first, which starts
    as 'in_progress'.
    """

    __tablename__ = "member_journey_step_states"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    member_journey_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("member_journeys.id", ondelete="CASCADE"),
        nullable=False,
    )
    template_step_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("journey_template_steps.id", ondelete="CASCADE"),
        nullable=False,
    )
    # upcoming | in_progress | completed | missed
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, server_default="upcoming"
    )
    started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    due_date: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # CHW notes on this step — not surfaced to the member in the API response.
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 0 until step is completed; then set to the template step's points_on_completion.
    points_awarded: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class WellnessPointsLedger(Base):
    """Append-only ledger of wellness-point grants and deductions.

    The application NEVER issues UPDATE or DELETE against this table. The
    migration REVOKEs those privileges from the app role so the invariant is
    enforced at the database layer, not just in application code.

    ``points`` is signed: positive for grants, negative for redemptions or
    corrections.

    ``related_id`` is a free-form UUID reference to whatever entity triggered
    the event (MemberJourneyStepState.id, appointment_id, etc.). It is
    intentionally not a FK because the related entity can belong to any table.
    """

    __tablename__ = "wellness_points_ledger"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    member_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
    )
    # Signed integer: +N for grants, -N for deductions/redemptions
    points: Mapped[int] = mapped_column(Integer, nullable=False)
    # Reason code — journey_step_completed | appointment_confirmed |
    #               mutation_reply | redemption | correction
    reason: Mapped[str] = mapped_column(String(100), nullable=False)
    # Nullable UUID reference to the triggering entity row (no FK constraint
    # because the referent table varies by reason code).
    related_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

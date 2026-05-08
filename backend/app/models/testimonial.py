"""SQLAlchemy model for the Testimonials feature.

Design decisions
----------------
- A testimonial is written by a member about a CHW after a completed session.
  The (member_id, session_id) UNIQUE constraint ensures a member can only
  leave one testimonial per session. Multiple testimonials for the same CHW
  across different sessions are intentionally allowed.

- session_id is NULLABLE to support edge cases where a testimonial might be
  submitted without a specific session reference (e.g., future direct-rate
  flows), but the current POST endpoint always supplies session_id and gates
  on session ownership + completed status.

- status transitions: pending → approved | rejected.
  Once approved or rejected, re-moderation is not blocked at the DB level but
  the router can enforce idempotency as needed.

- author_initial ("M.") is NOT stored — it is derived at query time from
  the member's first_name field. This avoids PII duplication and ensures the
  display always reflects the current name on the User row.

- 1-star ratings are treated as normal testimonials, not auto-flagged.
  Very low ratings naturally surface to admins in the pending moderation
  queue where they can review context before approving or suppressing.

- moderated_by_admin_id is intentionally nullable and is not FKd to a
  User row that must have role='admin' — admins authenticate via bearer
  key, not user rows. The column stores the resolving admin's user ID only
  when the admin authenticates as a user (future auth extension). For now
  it remains NULL and we rely on the audit log for tracing.

Indexes
-------
  - (chw_id, status) — public profile page fetches approved testimonials for a CHW
  - (created_at)     — moderation queue ordering (newest first)
"""

import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Testimonial(Base):
    """A member-authored rating and review of a CHW, submitted after a session.

    Lifecycle
    ---------
    1. Member POSTs after a completed session → status = 'pending'.
    2. Admin reviews the pending queue.
    3. Admin approves → status = 'approved'; row becomes publicly visible.
    4. Admin rejects → status = 'rejected'; row hidden from public view.

    Public display
    --------------
    Only approved testimonials are visible on the CHW Profile screen.
    The member's identity is privacy-preserved: the API serialises
    member first name initial + "." (e.g. "M.") — member_id is never
    included in the public-facing schema.
    """

    __tablename__ = "testimonials"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )

    # The CHW being reviewed.
    chw_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False
    )

    # The member who wrote the testimonial.
    member_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False
    )

    # Optional FK to the session that prompted this testimonial.
    # The POST endpoint always supplies session_id; nullable for schema flexibility.
    session_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("sessions.id"), nullable=True
    )

    # Star rating: 1 (lowest) to 5 (highest). Enforced at both schema (Pydantic
    # ge/le validators) and DB (CHECK constraint) layers.
    rating: Mapped[int] = mapped_column(Integer, nullable=False)

    # Free-text body. Max 500 chars enforced at the Pydantic schema level.
    text: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Moderation lifecycle: pending | approved | rejected.
    # VARCHAR(20) + CHECK constraint avoids a Postgres enum type migration.
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="pending"
    )

    # Nullable: only populated if the admin who moderates has a User row.
    # See module docstring for why this is nullable rather than required.
    moderated_by_admin_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )

    # Optional admin note explaining why a testimonial was rejected.
    moderation_notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    moderated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    __table_args__ = (
        # A member can only submit one testimonial per session.
        # Multiple testimonials for the same CHW across different sessions are allowed.
        UniqueConstraint("member_id", "session_id", name="uq_testimonials_member_session"),

        # DB-level rating range guard (belt-and-suspenders with Pydantic validation).
        CheckConstraint("rating >= 1 AND rating <= 5", name="ck_testimonials_rating_range"),

        # DB-level status guard.
        CheckConstraint(
            "status IN ('pending', 'approved', 'rejected')",
            name="ck_testimonials_status",
        ),

        # Composite index: CHW profile page fetches approved testimonials for a CHW.
        Index("ix_testimonials_chw_status", "chw_id", "status"),

        # Single-column index: moderation queue orders by newest first.
        Index("ix_testimonials_created_at", "created_at"),
    )

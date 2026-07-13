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

- ``source`` (Epic B3) distinguishes WHERE a testimonial originated:
  'session' (the original member-initiated, session-scoped rating flow) vs.
  'account_closure' (CHW-facilitated parting feedback captured when a CHW
  closes a member's case — the member usually isn't logged in at that point,
  so a CHW relays it via POST /chw/members/{id}/closure-review). NOT NULL
  with a server default of 'session' so every pre-B3 row backfills correctly
  without a data migration pass. session_id stays NULL for closure-sourced
  rows since there is no specific session being rated.

- ``rating`` is nullable (Epic B3) to support closure-sourced reviews, which
  are text-only ("Member's parting feedback... — optional", 120 chars, no
  star rating collected in that flow). The session-scoped POST endpoint
  keeps rating REQUIRED at the Pydantic schema layer (TestimonialCreate);
  only the DB column relaxed to nullable, gated by the CHECK constraint
  below so a rating, when present, must still be within 1..5.

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
  - (source)         — Epic B3: filtering/reporting closure-sourced reviews
                        separately from session ratings
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
    """A member-authored rating and/or review of a CHW.

    Two sources feed this table (see ``source`` column):

    1. ``session``          — the original flow: a member rates a CHW after a
       completed session (rating required, session_id populated).
    2. ``account_closure``  — Epic B3: a CHW relays the member's parting
       feedback while closing the member's case (text-only, rating optional,
       session_id NULL — see POST /chw/members/{id}/closure-review).

    Lifecycle
    ---------
    1. Row created (either source) → status = 'pending'.
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

    # Star rating: 1 (lowest) to 5 (highest). NULLABLE (Epic B3) to support
    # text-only account-closure reviews. The session-scoped POST endpoint
    # keeps rating required at the Pydantic schema layer regardless — this
    # column is nullable purely so the closure-review path can omit it.
    # When present, the CHECK constraint below still enforces the 1..5 range.
    rating: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Free-text body. Max 500 chars enforced at the Pydantic schema level
    # (session path) / 120 chars (closure-review path, TestimonialClosureCreate).
    text: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Moderation lifecycle: pending | approved | rejected.
    # VARCHAR(20) + CHECK constraint avoids a Postgres enum type migration.
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="pending"
    )

    # Origin of this testimonial (Epic B3): 'session' | 'account_closure'.
    # VARCHAR(20) + CHECK constraint, same pattern as `status`, to avoid a
    # Postgres enum type migration. Defaults to 'session' so the migration
    # backfills every pre-existing row correctly with zero data migration.
    source: Mapped[str] = mapped_column(
        String(20), nullable=False, default="session"
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
        # NOTE: session_id is NULL for every account_closure-sourced row, and
        # Postgres treats NULL as distinct in a UNIQUE constraint, so multiple
        # closure reviews for the same member do not collide here.
        UniqueConstraint("member_id", "session_id", name="uq_testimonials_member_session"),

        # DB-level rating range guard (belt-and-suspenders with Pydantic validation).
        # Rating is nullable (Epic B3 closure reviews) — the range check only
        # applies when a rating IS present.
        CheckConstraint(
            "rating IS NULL OR (rating >= 1 AND rating <= 5)",
            name="ck_testimonials_rating_range",
        ),

        # DB-level status guard.
        CheckConstraint(
            "status IN ('pending', 'approved', 'rejected')",
            name="ck_testimonials_status",
        ),

        # DB-level source guard (Epic B3).
        CheckConstraint(
            "source IN ('session', 'account_closure')",
            name="ck_testimonials_source",
        ),

        # Composite index: CHW profile page fetches approved testimonials for a CHW.
        Index("ix_testimonials_chw_status", "chw_id", "status"),

        # Single-column index: moderation queue orders by newest first.
        Index("ix_testimonials_created_at", "created_at"),

        # Single-column index: Epic B3 filtering/reporting by source.
        Index("ix_testimonials_source", "source"),
    )

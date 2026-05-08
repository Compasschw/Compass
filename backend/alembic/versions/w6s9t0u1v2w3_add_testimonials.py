"""add_testimonials

Creates the ``testimonials`` table which stores member-authored star ratings
and free-text reviews of CHWs, subject to admin moderation before public display.

Schema decisions
----------------
- ``rating`` INT with CHECK(rating >= 1 AND rating <= 5) — belt-and-suspenders
  with the Pydantic schema-level ge/le validators.
- ``status`` VARCHAR(20) with CHECK constraint over (pending|approved|rejected).
  Using a plain varchar avoids a Postgres enum type so new statuses can be added
  without a separate ALTER TYPE migration.
- ``session_id`` is NULLABLE — the POST endpoint always supplies it, but the
  nullable FK keeps the schema flexible for future direct-rate flows.
- UNIQUE(member_id, session_id) prevents duplicate testimonials per session.
  Multiple testimonials for the same CHW across different sessions are allowed.

Indexes
-------
- ix_testimonials_chw_status  (chw_id, status)  — CHW profile public fetch
- ix_testimonials_created_at  (created_at)       — moderation queue ordering

Revision ID: w6s9t0u1v2w3
Revises:     v5r8s9t0u1v2
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "w6s9t0u1v2w3"
down_revision: str | None = "v5r8s9t0u1v2"
branch_labels = None
depends_on = None

_TESTIMONIAL_STATUSES = ("pending", "approved", "rejected")


def upgrade() -> None:
    op.create_table(
        "testimonials",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            nullable=False,
        ),
        sa.Column(
            "chw_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=False,
        ),
        sa.Column(
            "member_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=False,
        ),
        sa.Column(
            "session_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("sessions.id"),
            nullable=True,
        ),
        sa.Column("rating", sa.Integer, nullable=False),
        sa.Column("text", sa.Text, nullable=True),
        sa.Column(
            "status",
            sa.String(20),
            nullable=False,
            server_default="pending",
        ),
        sa.Column(
            "moderated_by_admin_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=True,
        ),
        sa.Column("moderation_notes", sa.Text, nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
        sa.Column(
            "moderated_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        # Rating range constraint.
        sa.CheckConstraint(
            "rating >= 1 AND rating <= 5",
            name="ck_testimonials_rating_range",
        ),
        # Status enum constraint.
        sa.CheckConstraint(
            f"status IN ({', '.join(repr(s) for s in _TESTIMONIAL_STATUSES)})",
            name="ck_testimonials_status",
        ),
        # One testimonial per (member, session).
        sa.UniqueConstraint("member_id", "session_id", name="uq_testimonials_member_session"),
    )

    # Composite index: CHW profile approved testimonials hot path.
    op.create_index(
        "ix_testimonials_chw_status",
        "testimonials",
        ["chw_id", "status"],
    )

    # Single-column index: moderation queue ordering by newest first.
    op.create_index(
        "ix_testimonials_created_at",
        "testimonials",
        ["created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_testimonials_created_at", table_name="testimonials")
    op.drop_index("ix_testimonials_chw_status", table_name="testimonials")
    op.drop_table("testimonials")

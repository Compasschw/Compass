"""add_session_scheduling_fields — scheduled_end_at + scheduling_status.

Revision ID: s1t2u3v4w5x6
Revises:     r0s1t2u3v4w5
Create Date: 2026-06-19

Supports CHW member-direct scheduling on the Calendar page:
  - scheduled_end_at   TIMESTAMPTZ nullable — appointment end time so calendar
                       cards span their real duration.
  - scheduling_status  VARCHAR(20) nullable — the CHW's Confirmed/Pending choice
                       for a scheduled session ("confirmed" | "pending" | NULL).
                       Distinct from the session lifecycle `status`
                       (scheduled/in_progress/completed/...); Completed/Missed
                       badges derive from the lifecycle.

Both nullable adds, no table rewrite; passes the RDS snapshot gate.
"""

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision = "s1t2u3v4w5x6"
down_revision = "r0s1t2u3v4w5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "sessions",
        sa.Column("scheduled_end_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "sessions",
        sa.Column("scheduling_status", sa.String(length=20), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("sessions", "scheduling_status")
    op.drop_column("sessions", "scheduled_end_at")

"""add users.last_active_at — member/CHW presence tracking

Revision ID: presence0704
Revises:     perfidx0701
Create Date: 2026-07-04

Adds a nullable ``last_active_at`` timestamp to ``users``, bumped (throttled) on
every authenticated request in ``get_current_user``. Used to drive presence in
the UI (e.g. a member's "Active" pill when they were on the app within the last
10 minutes). Nullable + no backfill, so the migration is instant and safe.
"""
import sqlalchemy as sa

from alembic import op

revision = "presence0704"
down_revision = "perfidx0701"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("last_active_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("users", "last_active_at")

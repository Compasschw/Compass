"""add sessions.muted_at — CHW inbox mute action

Revision ID: smute0708
Revises:     presence0704
Create Date: 2026-07-08

Adds a nullable ``muted_at`` timestamp to ``sessions`` to power the CHW Messages
inbox "Mute" action. NULL means the thread is not muted; a populated value
records when the CHW muted it. A muted thread stays in the inbox but its unread
badge is suppressed on the frontend.

Nullable + no backfill, so the migration is instant and safe behind the
snapshot gate — mirrors the pinned_at / archived_at columns added in
b2c3d4e5f6a7.
"""
import sqlalchemy as sa

from alembic import op

revision = "smute0708"
down_revision = "presence0704"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "sessions",
        sa.Column("muted_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("sessions", "muted_at")

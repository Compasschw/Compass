"""add pinned_at / archived_at / deleted_at to sessions

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2026-05-17

Adds three nullable timestamp columns to the ``sessions`` table to power the
CHW Messages inbox swipe actions (pin / archive / soft-delete).

Design choices:
    - All three are nullable timestamps (``TIMESTAMPTZ``) rather than boolean
      flags so the row records *when* the action happened — useful for audit,
      "recently deleted" UIs, and admin-side undelete tooling.
    - The columns reflect the **CHW's perspective** on the thread.  The
      Messages screen is CHW-only today; if the member-side inbox later needs
      independent state we'll add member-prefixed columns (or a join table)
      then.  Keeping them on ``sessions`` for now avoids an extra round-trip
      on every inbox load.
    - Soft-delete: ``deleted_at IS NOT NULL`` hides the row from the inbox
      but leaves the PHI in place.  Hard deletes for clinical records are a
      compliance hazard.
    - A composite partial index on (chw_id, pinned_at, created_at) speeds up
      the inbox query that filters by CHW and sorts ``pinned_at DESC NULLS
      LAST, created_at DESC``.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b2c3d4e5f6a7"
down_revision: str | None = "a1b2c3d4e5f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "sessions",
        sa.Column("pinned_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "sessions",
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "sessions",
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )

    # Partial index covers the most common inbox query path:
    # "WHERE chw_id = ? AND deleted_at IS NULL [AND archived_at IS NULL]
    #  ORDER BY pinned_at DESC NULLS LAST, created_at DESC".
    # Including pinned_at + created_at lets the planner serve the ORDER BY
    # from the index without a separate sort step.
    op.create_index(
        "ix_sessions_chw_inbox",
        "sessions",
        ["chw_id", "pinned_at", "created_at"],
        postgresql_where=sa.text("deleted_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_sessions_chw_inbox", table_name="sessions")
    op.drop_column("sessions", "deleted_at")
    op.drop_column("sessions", "archived_at")
    op.drop_column("sessions", "pinned_at")

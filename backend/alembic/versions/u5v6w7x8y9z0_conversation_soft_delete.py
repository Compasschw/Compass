"""Add soft-delete columns to conversations table.

Revision ID: u5v6w7x8y9z0
Revises:     t2u3v4w5x6y7
Create Date: 2026-06-22

Adds two nullable columns:
  - deleted_at (TIMESTAMPTZ): NULL = active thread; non-NULL = soft-deleted
  - deleted_by_user_id (UUID FK → users.id): who performed the deletion

HIPAA: soft-delete only — messages, call_logs, and all downstream FK rows
are retained for the 6-year compliance window. The inbox list endpoint
filters deleted_at IS NULL; the by-id fetch still returns the row.

Nullable/default-NULL add — passes the RDS snapshot gate without a table
lock; existing conversation rows default to deleted_at=NULL (active).

Downgrade: drops both columns. Any soft-deleted threads become visible
again in the inbox on downgrade — document to the team.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "u5v6w7x8y9z0"
down_revision: str = "t2u3v4w5x6y7"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    """Add deleted_at and deleted_by_user_id to conversations."""
    op.add_column(
        "conversations",
        sa.Column(
            "deleted_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )
    op.add_column(
        "conversations",
        sa.Column(
            "deleted_by_user_id",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=True,
        ),
    )
    # Index for the list-endpoint filter (deleted_at IS NULL scans heavily).
    op.create_index(
        "ix_conversations_deleted_at",
        "conversations",
        ["deleted_at"],
        unique=False,
    )


def downgrade() -> None:
    """Remove soft-delete columns from conversations."""
    op.drop_index("ix_conversations_deleted_at", table_name="conversations")
    op.drop_column("conversations", "deleted_by_user_id")
    op.drop_column("conversations", "deleted_at")

"""session-per-call: drop conv UC + add session.conversation_id

Revision ID: f6a7b8c9d0e1
Revises: e5f6a7b8c9d0
Create Date: 2026-05-28 00:00:00.000000

Notes
-----
The repo has 5 pre-existing alembic heads as of 2026-05-28
(aa1b2c3d4e5f, e5f6a7b8c9d0, w6s9t0u1v2w3, v1a2b3c4d5e6, r1s4t5u6v7w8).
This migration descends from e5f6a7b8c9d0 (the billing head) — the
session-per-call refactor naturally extends billing. Consolidating
the 5 heads into a single merge is a separate cleanup follow-up.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision: str = "f6a7b8c9d0e1"
down_revision: str | None = "e5f6a7b8c9d0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. Drop the 1-session-per-conversation unique constraint.
    op.drop_constraint(
        "uq_conversations_session_id",
        "conversations",
        type_="unique",
    )

    # 2. Add Session.conversation_id (nullable so we can backfill safely).
    op.add_column(
        "sessions",
        sa.Column(
            "conversation_id",
            UUID(as_uuid=True),
            sa.ForeignKey("conversations.id"),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_sessions_conversation_id",
        "sessions",
        ["conversation_id"],
        unique=False,
    )

    # 3. Backfill: each existing Conversation has at most one Session via
    #    Conversation.session_id (UC just dropped, but the rows still
    #    encode the 1:1 link). Copy that link onto Session.conversation_id.
    op.execute(
        """
        UPDATE sessions s
        SET conversation_id = c.id
        FROM conversations c
        WHERE c.session_id = s.id
          AND s.conversation_id IS NULL
        """
    )


def downgrade() -> None:
    # 1. Drop the index + column from sessions.
    op.drop_index("ix_sessions_conversation_id", table_name="sessions")
    op.drop_column("sessions", "conversation_id")

    # 2. Restore the UC on conversations.session_id.
    # Will fail if any conversation now points to a session shared with
    # another conversation — that's intentional: downgrade is only safe
    # before any second-call session lands.
    op.create_unique_constraint(
        "uq_conversations_session_id",
        "conversations",
        ["session_id"],
    )

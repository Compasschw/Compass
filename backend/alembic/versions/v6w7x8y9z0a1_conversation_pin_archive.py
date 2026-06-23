"""Add pinned_at / archived_at to conversations + backfill from sessions.

Revision ID: v6w7x8y9z0a1
Revises:     u5v6w7x8y9z0
Create Date: 2026-06-22

Adds two nullable TIMESTAMPTZ columns to ``conversations`` and backfills
them from the ``sessions`` table using the following semantics:

  pinned_at   = MAX(sessions.pinned_at)   GROUP BY conversation_id
                 (PINNED IF ANY session was pinned)
  archived_at = MAX(sessions.archived_at) GROUP BY conversation_id
                 WHERE every session for that conversation has archived_at IS NOT NULL
                 (ARCHIVED ONLY IF ALL sessions archived)

Also backfills conversations.deleted_at for conversations where all sessions
are deleted but the conversation itself is not yet soft-deleted.

Adds a composite index (conversation_id, created_at) on messages to serve
the DISTINCT ON last-message query without a sort step.

KEEP sessions.pinned_at / archived_at / deleted_at columns — they are
needed for rollback safety and the session-list inbox that predates this change.
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "v6w7x8y9z0a1"
down_revision: str = "u5v6w7x8y9z0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ── 1. ADD COLUMNS (nullable, no lock) ────────────────────────────────────
    op.add_column(
        "conversations",
        sa.Column("pinned_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "conversations",
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
    )

    # ── 2. BACKFILL pinned_at ─────────────────────────────────────────────────
    # Any pinned session → conversation is pinned (MAX wins).
    op.execute(sa.text("""
        UPDATE conversations c
        SET pinned_at = sub.max_pinned
        FROM (
            SELECT conversation_id, MAX(pinned_at) AS max_pinned
            FROM sessions
            WHERE conversation_id IS NOT NULL
              AND pinned_at IS NOT NULL
            GROUP BY conversation_id
        ) sub
        WHERE c.id = sub.conversation_id
    """))

    # ── 3. BACKFILL archived_at (all sessions must be archived) ───────────────
    op.execute(sa.text("""
        UPDATE conversations c
        SET archived_at = sub.max_archived
        FROM (
            SELECT
                conversation_id,
                MAX(archived_at)                            AS max_archived,
                COUNT(*)                                    AS total,
                COUNT(archived_at)                          AS archived_count
            FROM sessions
            WHERE conversation_id IS NOT NULL
            GROUP BY conversation_id
            HAVING COUNT(*) = COUNT(archived_at)
               AND COUNT(*) > 0
        ) sub
        WHERE c.id = sub.conversation_id
    """))

    # ── 4. BACKFILL deleted_at for conversations whose EVERY session is deleted,
    #       but the conversation row itself has not been explicitly soft-deleted yet.
    op.execute(sa.text("""
        UPDATE conversations c
        SET deleted_at = sub.max_deleted
        FROM (
            SELECT
                conversation_id,
                MAX(deleted_at)                             AS max_deleted,
                COUNT(*)                                    AS total,
                COUNT(deleted_at)                           AS deleted_count
            FROM sessions
            WHERE conversation_id IS NOT NULL
            GROUP BY conversation_id
            HAVING COUNT(*) = COUNT(deleted_at)
               AND COUNT(*) > 0
        ) sub
        WHERE c.id = sub.conversation_id
          AND c.deleted_at IS NULL
    """))

    # ── 5. Composite index on messages for the last-message DISTINCT ON query ──
    # The inbox endpoint runs:
    #   SELECT DISTINCT ON (conversation_id) conversation_id, body, created_at, sender_id
    #   FROM messages WHERE conversation_id IN (...)
    #   ORDER BY conversation_id, created_at DESC
    # A (conversation_id, created_at DESC) index lets the planner serve both
    # the filter and the ORDER BY without a separate sort.
    op.create_index(
        "ix_messages_conversation_created_at",
        "messages",
        ["conversation_id", sa.text("created_at DESC")],
    )

    # ── 6. Partial inbox index on conversations (mirrors ix_sessions_chw_inbox) ─
    op.create_index(
        "ix_conversations_chw_inbox",
        "conversations",
        ["chw_id", "pinned_at", "archived_at"],
        postgresql_where=sa.text("deleted_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_conversations_chw_inbox", table_name="conversations")
    op.drop_index("ix_messages_conversation_created_at", table_name="messages")
    op.drop_column("conversations", "archived_at")
    op.drop_column("conversations", "pinned_at")

"""Add UNIQUE (chw_id, member_id) to conversations + consolidate any duplicates.

Revision ID: ab1c2d3e4f5a
Revises:     aa1b2c3d4e5f, j0e1f2g3h4i5, r1s4t5u6v7w8, v1a2b3c4d5e6, w6s9t0u1v2w3
Create Date: 2026-06-09

Problem
-------
The ``conversations`` table had no UNIQUE constraint on ``(chw_id, member_id)``.
Two concurrent requests — e.g. a CHW dialling at the same instant a member
taps "Message" — could both INSERT a new row and create two threads for the
same pair. The read path's ORDER BY created_at / LIMIT 1 picked one
deterministically, but messages were silently split across the two rows.

Fix
---
1. Consolidate any existing duplicate rows: keep the oldest conversation
   (canonical row), re-point every ``messages.conversation_id``,
   ``call_logs.conversation_id``, and ``sessions.conversation_id`` FK that
   references a duplicate onto the canonical row, then delete the duplicates.
   (No ``session_id`` column on Conversation itself needs updating — that
   column is the originating Session pointer on the Conversation row, not a
   reverse FK.)

2. Add ``UNIQUE (chw_id, member_id)`` so the DB enforces the invariant.

   NOTE: only applies to the ad-hoc conversation model (session_id=NULL).
   Session-scoped conversations (session_id IS NOT NULL) historically had
   one Conversation per Session; after the session-per-call refactor (#193)
   the same Conversation hosts many Sessions. The UNIQUE constraint covers
   ALL ``(chw_id, member_id)`` pairs — including those with a session_id —
   which is now correct because every CHW+member pair should share exactly
   ONE conversation thread for their entire relationship.

Downgrade
---------
Drops the UNIQUE constraint. Previously consolidated duplicate rows are NOT
re-split — that data is irrecoverable. Document any rollback clearly to the
team.
"""
from __future__ import annotations

import logging

from alembic import op
import sqlalchemy as sa

log = logging.getLogger("alembic.migrations")

revision: str = "ab1c2d3e4f5a"
down_revision: tuple[str, ...] = (
    "aa1b2c3d4e5f",
    "j0e1f2g3h4i5",
    "r1s4t5u6v7w8",
    "v1a2b3c4d5e6",
    "w6s9t0u1v2w3",
)
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    """Consolidate duplicate (chw_id, member_id) conversation rows, then add UNIQUE."""
    bind = op.get_bind()

    # ── Step 1: find all duplicate (chw_id, member_id) pairs ─────────────────
    duplicates = bind.execute(
        sa.text(
            """
            SELECT chw_id, member_id, COUNT(*) AS cnt
            FROM conversations
            GROUP BY chw_id, member_id
            HAVING COUNT(*) > 1
            ORDER BY cnt DESC
            """
        )
    ).fetchall()

    if duplicates:
        log.warning(
            "Found %d duplicate (chw_id, member_id) conversation pairs — "
            "consolidating before adding UNIQUE constraint.",
            len(duplicates),
        )

        total_deleted = 0
        for row in duplicates:
            chw_id = row[0]
            member_id = row[1]

            # ── Step 2: pick the canonical (oldest) conversation row ──────────
            rows = bind.execute(
                sa.text(
                    """
                    SELECT id FROM conversations
                    WHERE chw_id = :chw AND member_id = :mem
                    ORDER BY created_at ASC
                    """
                ),
                {"chw": chw_id, "mem": member_id},
            ).fetchall()

            canonical_id = rows[0][0]
            duplicate_ids = [r[0] for r in rows[1:]]

            log.info(
                "Pair chw=%s member=%s: canonical=%s  duplicates=%s",
                chw_id, member_id, canonical_id, duplicate_ids,
            )

            for dup_id in duplicate_ids:
                # Re-point messages FK
                msgs = bind.execute(
                    sa.text(
                        "UPDATE messages SET conversation_id = :canon "
                        "WHERE conversation_id = :dup"
                    ),
                    {"canon": canonical_id, "dup": dup_id},
                )
                log.info(
                    "  Remapped %d message(s) from conversation %s → %s",
                    msgs.rowcount, dup_id, canonical_id,
                )

                # Re-point call_logs FK
                calls = bind.execute(
                    sa.text(
                        "UPDATE call_logs SET conversation_id = :canon "
                        "WHERE conversation_id = :dup"
                    ),
                    {"canon": canonical_id, "dup": dup_id},
                )
                log.info(
                    "  Remapped %d call_log(s) from conversation %s → %s",
                    calls.rowcount, dup_id, canonical_id,
                )

                # Re-point sessions FK (session_per_call: sessions.conversation_id)
                sessions = bind.execute(
                    sa.text(
                        "UPDATE sessions SET conversation_id = :canon "
                        "WHERE conversation_id = :dup"
                    ),
                    {"canon": canonical_id, "dup": dup_id},
                )
                log.info(
                    "  Remapped %d session(s) from conversation %s → %s",
                    sessions.rowcount, dup_id, canonical_id,
                )

                # Delete the now-orphaned duplicate conversation row
                bind.execute(
                    sa.text("DELETE FROM conversations WHERE id = :dup"),
                    {"dup": dup_id},
                )
                total_deleted += 1

        log.warning(
            "Duplicate consolidation complete: deleted %d orphan conversation row(s).",
            total_deleted,
        )
    else:
        log.info(
            "No duplicate (chw_id, member_id) conversation pairs found — "
            "safe to add UNIQUE constraint directly."
        )

    # ── Step 3: add the UNIQUE constraint ─────────────────────────────────────
    # Postgres automatically creates a B-tree index backing the constraint, so
    # we do NOT need a separate CREATE INDEX. The constraint name follows the
    # project convention: uq_<table>_<cols>.
    op.create_unique_constraint(
        "uq_conversations_chw_member",
        "conversations",
        ["chw_id", "member_id"],
    )
    log.info("Added UNIQUE constraint uq_conversations_chw_member to conversations.")


def downgrade() -> None:
    """Drop the UNIQUE constraint. Duplicate rows are NOT restored."""
    op.drop_constraint(
        "uq_conversations_chw_member",
        "conversations",
        type_="unique",
    )

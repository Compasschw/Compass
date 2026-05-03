"""make_followup_chw_id_nullable

Makes two columns in ``session_followups`` nullable to support
member-self-set roadmap goals (POST /api/v1/member/roadmap):

  1. ``chw_id``    — was NOT NULL; now nullable.
     Rationale: member-initiated goals have no supervising CHW.
     All LLM-extracted and CHW-session-derived rows retain a non-NULL chw_id.
     Audit queries computing CHW-attributed item counts should apply
     ``WHERE chw_id IS NOT NULL``.

  2. ``session_id`` — was NOT NULL with ondelete=CASCADE; now nullable.
     Rationale: member-initiated goals are not tied to any session.
     The CASCADE delete behaviour is preserved on the FK constraint so that
     rows with a non-NULL session_id are still cleaned up when the parent
     session is hard-deleted.  Rows with session_id=NULL are unaffected.

Design trade-off (documented per spec):
  The original NOT NULL constraint on chw_id reflected the invariant that
  every follow-up item was produced from a CHW-supervised session.  Making
  it nullable breaks that invariant to enable member self-service goals.
  The trade-off is accepted because:
    a) The ``auto_created`` and ``owner`` columns identify self-set items.
    b) CHW-attributed analytics can still be computed via IS NOT NULL filter.
    c) Adding a separate RoadmapItem table for member-only goals would
       duplicate sorting/filtering logic without materially improving
       data integrity.

Both changes are backwards-compatible (existing NOT NULL rows satisfy the
new nullable constraint automatically).  Safe to apply without downtime on
PostgreSQL 12+ via a transactional DDL statement.

Revision ID: n6j9k0l1m2n3
Revises: m5i8j9k0l1m2
Create Date: 2026-04-22 15:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "n6j9k0l1m2n3"
down_revision: Union[str, None] = "m5i8j9k0l1m2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── 1. Make chw_id nullable ───────────────────────────────────────────────
    # ALTER COLUMN is transactional on PostgreSQL and does not require a table
    # rewrite — safe to apply without downtime.
    op.alter_column(
        "session_followups",
        "chw_id",
        existing_type=sa.dialects.postgresql.UUID(as_uuid=True),
        nullable=True,
        comment=(
            "NULL for member-self-set goals (POST /member/roadmap). "
            "Non-NULL for all CHW-session-derived and LLM-extracted rows."
        ),
    )

    # ── 2. Make session_id nullable ───────────────────────────────────────────
    # We must drop and recreate the FK constraint to change nullability while
    # keeping the ondelete=CASCADE behaviour intact.
    op.drop_constraint(
        "fk_session_followups_session_id",
        "session_followups",
        type_="foreignkey",
    )
    op.alter_column(
        "session_followups",
        "session_id",
        existing_type=sa.dialects.postgresql.UUID(as_uuid=True),
        nullable=True,
        comment=(
            "NULL for member-self-set goals. "
            "Non-NULL for all session-derived rows; CASCADE delete applies."
        ),
    )
    op.create_foreign_key(
        "fk_session_followups_session_id",
        "session_followups",
        "sessions",
        ["session_id"],
        ["id"],
        ondelete="CASCADE",
    )


def downgrade() -> None:
    # ── Reverse session_id: make NOT NULL again ───────────────────────────────
    # NOTE: this will FAIL if any rows have session_id=NULL. Purge or backfill
    # those rows before running the downgrade in production.
    op.drop_constraint(
        "fk_session_followups_session_id",
        "session_followups",
        type_="foreignkey",
    )
    op.alter_column(
        "session_followups",
        "session_id",
        existing_type=sa.dialects.postgresql.UUID(as_uuid=True),
        nullable=False,
    )
    op.create_foreign_key(
        "fk_session_followups_session_id",
        "session_followups",
        "sessions",
        ["session_id"],
        ["id"],
        ondelete="CASCADE",
    )

    # ── Reverse chw_id: make NOT NULL again ───────────────────────────────────
    # NOTE: this will FAIL if any rows have chw_id=NULL.
    op.alter_column(
        "session_followups",
        "chw_id",
        existing_type=sa.dialects.postgresql.UUID(as_uuid=True),
        nullable=False,
    )

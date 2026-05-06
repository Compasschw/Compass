"""add_verticals_array

Add `verticals VARCHAR[]` to service_requests and backfill from `vertical`.

Why this exists
───────────────
Members previously selected multiple service categories and the frontend
submitted one POST /requests per selected vertical, creating N separate
ServiceRequest rows for a single form submission. This produced noisy data
(e.g., three separate "open" requests with identical description/urgency/mode)
and showed the member a misleading "Submit 3 Requests" button.

The fix consolidates the submission: one form → one ServiceRequest row that
holds an array of all selected verticals. The single `vertical` column is
kept for backwards compatibility with sessions, claims, calendar events, and
admin views that reference it today; those consumers read `vertical` (singular)
which is always set to `verticals[0]`.

Strategy
────────
1. ADD COLUMN verticals VARCHAR[] NOT NULL DEFAULT '{}' — safe on Postgres; the
   server default means existing rows get an empty array without a table rewrite.
2. Backfill existing rows: SET verticals = ARRAY[vertical] WHERE verticals = '{}'
   so every historical row has at least one element.
3. No `down` migration touches `vertical` — dropping `verticals` is safe since
   `vertical` is still populated; callers that previously wrote `verticals` will
   fall back gracefully.

Revision ID: r1s4t5u6v7w8
Revises: q9m2n3o4p5q6
Create Date: 2026-05-04 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import ARRAY

revision: str = "r1s4t5u6v7w8"
down_revision: str | None = "q9m2n3o4p5q6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ADD COLUMN verticals VARCHAR[] with an empty-array server default.
    # NOT NULL is safe here because the server default covers existing rows
    # during the DDL phase; the backfill below then fills them in.
    op.add_column(
        "service_requests",
        sa.Column(
            "verticals",
            ARRAY(sa.String(50)),
            nullable=False,
            server_default="{}",
        ),
    )

    # Backfill: for every row whose verticals array is still empty (i.e.,
    # every pre-existing row), copy the legacy `vertical` string into a
    # single-element array.  The cardinality() check guards against a
    # partial run if this migration is ever re-applied after a failed attempt.
    op.execute(
        """
        UPDATE service_requests
        SET    verticals = ARRAY[vertical]
        WHERE  cardinality(verticals) = 0
        """
    )


def downgrade() -> None:
    # Dropping `verticals` is safe — the legacy `vertical` column still
    # carries the primary-vertical value and all consumers that haven't
    # migrated to the array will continue to work.
    op.drop_column("service_requests", "verticals")

"""backfill_session_scheduled_at

Backfill `sessions.scheduled_at` for any historic rows where it was left NULL.

Why this exists
───────────────
The accept_request endpoint historically created the Session row WITHOUT
`scheduled_at`, then computed a calendar-event `scheduled_at` separately
without writing it back to the session. That left the column NULL on
every accepted-then-completed session.

The native bundle's date formatter renders `new Date(null)` as the Unix
epoch in local time — which on the West Coast displays as "Wed, Dec 31,
4:00 PM" (1970-01-01 00:00 UTC ↦ 1969-12-31 16:00 PST). Members and CHWs
saw this fake date on every session card.

The producing bug is fixed in the same PR as this migration. The migration
exists to clean up the rows already in production.

Strategy
────────
For each NULL row, set scheduled_at to the row's own `created_at`. That's
a defensible choice: it's the moment the CHW accepted the request, which
is what operators expect to see for sessions that started immediately
(common for the demo flow). The CHW can still PATCH /sessions/{id} to a
different time later.

Revision ID: q9m2n3o4p5q6
Revises: p8l1m2n3o4p5
Create Date: 2026-05-05 00:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "q9m2n3o4p5q6"
down_revision: str | None = "p8l1m2n3o4p5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        "UPDATE sessions SET scheduled_at = created_at "
        "WHERE scheduled_at IS NULL AND created_at IS NOT NULL"
    )
    # If both were NULL (shouldn't happen — created_at has a server_default —
    # but defend anyway), stamp them with NOW() so the formatter never sees
    # a NULL again.
    op.execute(
        "UPDATE sessions SET scheduled_at = NOW() WHERE scheduled_at IS NULL"
    )


def downgrade() -> None:
    # No safe downgrade — we don't track which rows we backfilled. Leaving
    # the data as-is is the only sane reverse path.
    pass

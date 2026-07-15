"""add_case_notes_status — QA batch (2026-07-14) Part 9: draft case notes.

Revision ID: casenote0715
Revises:     smsnotif0714
Create Date: 2026-07-15

Adds ``case_notes.status`` ('draft' | 'final', ``String(10)``,
``server_default='final'``) backing the "session case notes stay drafts
until documentation is submitted" behavior:

  - A case note created while attached to a session that has not yet had
    its documentation submitted is created with ``status='draft'``.
  - ``submit_documentation`` (``routers/sessions.py``) bulk-flips every
    draft note for that session to 'final' in the same transaction that
    marks the session 'completed'.
  - Standalone notes (no ``session_id``) and notes on an already-completed
    session are created 'final' — there's no pending submission to wait for.

``server_default='final'`` backfills every existing row as final: they
predate the draft concept entirely (the sessions they're attached to, if
any, already had documentation submitted or the note was never
session-scoped), so there is nothing to "finish".

Note: this migration's ``down_revision`` is ``smsnotif0714``, the current
alembic head on ``origin/main`` at authoring time. A concurrent PR adds two
other migrations off that same head — this creates parallel heads
deliberately (deploy runs ``alembic upgrade heads``, which applies both
branches); do not attempt to chain onto the concurrent PR's revision ids.

Nullable-free single-column add with a server default — no table rewrite
blocking concern beyond the default backfill scan; passes the RDS snapshot
gate.
"""

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision = "casenote0715"
down_revision = "smsnotif0714"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "case_notes",
        sa.Column(
            "status",
            sa.String(length=10),
            nullable=False,
            server_default="final",
        ),
    )


def downgrade() -> None:
    op.drop_column("case_notes", "status")

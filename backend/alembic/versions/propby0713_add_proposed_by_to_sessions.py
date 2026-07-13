"""add_proposed_by_to_sessions

Session confirm/decline initiator-inversion fix.

Today, only the owning CHW can confirm/decline a pending session — even when
the CHW themselves proposed the pending time (via ``POST /sessions/schedule``
or a reschedule/counter-offer), letting a CHW self-approve their own
proposal. The fix tracks WHO proposed a session's current scheduled time so
``PATCH /sessions/{id}/confirm`` and ``/decline`` can reject the proposing
party and only allow the other side to act.

Adds a single nullable ``proposed_by VARCHAR(10)`` column to ``sessions``:
'chw' | 'member' | None. No backfill — legacy rows predating this column
stay NULL by design (the initiator is genuinely unknown for them), and the
router treats NULL specially per role (CHW: allowed, preserving today's
behavior; member: rejected, the safe default since the initiator is
unknown). See app/models/session.py Session.proposed_by docstring and
app/routers/sessions.py confirm_session/decline_session for the full design.

Revision ID: propby0713
Revises: sdohskip0713
"""

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "propby0713"
down_revision: str | None = "sdohskip0713"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "sessions",
        sa.Column("proposed_by", sa.String(length=10), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("sessions", "proposed_by")

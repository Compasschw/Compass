"""add_members_served — number of Medi-Cal members served per session.

Revision ID: q9r0s1t2u3v4
Revises:     p8q9r0s1t2u3
Create Date: 2026-06-17

Adds session_documentation.members_served (INTEGER NOT NULL DEFAULT 1) — the
count of Medi-Cal members served in a session (1 = individual, >1 = group),
required on the Pear billing claim. Defaulted add, no table rewrite; passes the
RDS pre-migration snapshot gate.
"""

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "q9r0s1t2u3v4"
down_revision = "p8q9r0s1t2u3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "session_documentation",
        sa.Column(
            "members_served",
            sa.Integer(),
            nullable=False,
            server_default="1",
        ),
    )


def downgrade() -> None:
    op.drop_column("session_documentation", "members_served")

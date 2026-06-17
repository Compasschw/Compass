"""add_member_preferred_name — member's chosen/preferred name.

Revision ID: p8q9r0s1t2u3
Revises:     o7p8q9r0s1t2
Create Date: 2026-06-17

Adds member_profiles.preferred_name (VARCHAR(100), nullable) — the name the
member goes by, distinct from the legal name on users.name. Nullable add, no
table rewrite; passes through the RDS pre-migration snapshot gate.
"""

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "p8q9r0s1t2u3"
down_revision = "o7p8q9r0s1t2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "member_profiles",
        sa.Column("preferred_name", sa.String(length=100), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("member_profiles", "preferred_name")

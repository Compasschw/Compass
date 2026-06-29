"""add priority_level to member_journeys (for custom-need priority)

Custom (CHW-authored) journeys can now carry a CHW-assigned priority level
(low | medium | high), mirroring the fixed resource needs. Canonical journeys
leave it NULL — their priority comes from member_profiles.resource_need_levels.

Revision ID: jpriolevel2806
Revises: reh2transp2606
Create Date: 2026-06-28

"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "jpriolevel2806"
down_revision = "reh2transp2606"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "member_journeys",
        sa.Column("priority_level", sa.String(length=10), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("member_journeys", "priority_level")

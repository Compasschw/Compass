"""add_session_resource_needs — Epic L: replace Notes with Resource Needs.

Revision ID: resneeds0713
Revises:     mustchg0712
Create Date: 2026-07-13

Adds `resource_needs` (TEXT[] nullable) to `sessions`. The CHW "Schedule
Session" modal's free-text Notes field is replaced by a structured
multi-select of resource-need verticals (Housing, Food, etc — see
app.models.enums.Vertical); this column stores the selected values.

The existing `notes` column is intentionally left untouched — it is NOT
dropped, so historical CHW-authored notes on existing rows are preserved and
no data is lost. The Schedule Session form simply stops writing to it.

Nullable add, no table rewrite, no backfill needed; passes the RDS snapshot
gate.
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision = "resneeds0713"
down_revision = "mustchg0712"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "sessions",
        sa.Column(
            "resource_needs",
            postgresql.ARRAY(sa.String()),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("sessions", "resource_needs")

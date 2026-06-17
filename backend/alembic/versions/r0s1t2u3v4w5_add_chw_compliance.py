"""add_chw_compliance — HIPAA training, certification, background-check status.

Revision ID: r0s1t2u3v4w5
Revises:     q9r0s1t2u3v4
Create Date: 2026-06-17

Adds CHW compliance columns to chw_profiles:
  - hipaa_training_completed BOOLEAN NOT NULL DEFAULT false
  - chw_certification        VARCHAR(120) nullable
  - background_check_status  VARCHAR(20) NOT NULL DEFAULT 'not_started'

All defaulted/nullable adds, no table rewrite; passes the RDS snapshot gate.
"""

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision = "r0s1t2u3v4w5"
down_revision = "q9r0s1t2u3v4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "chw_profiles",
        sa.Column(
            "hipaa_training_completed",
            sa.Boolean(),
            nullable=False,
            server_default="false",
        ),
    )
    op.add_column(
        "chw_profiles",
        sa.Column("chw_certification", sa.String(length=120), nullable=True),
    )
    op.add_column(
        "chw_profiles",
        sa.Column(
            "background_check_status",
            sa.String(length=20),
            nullable=False,
            server_default="not_started",
        ),
    )


def downgrade() -> None:
    op.drop_column("chw_profiles", "background_check_status")
    op.drop_column("chw_profiles", "chw_certification")
    op.drop_column("chw_profiles", "hipaa_training_completed")

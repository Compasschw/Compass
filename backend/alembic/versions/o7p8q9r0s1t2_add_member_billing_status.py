"""add_member_billing_status — billable/non-billable toggle on member_profiles.

Revision ID: o7p8q9r0s1t2
Revises:     m5n6o7p8q9r0
Create Date: 2026-06-17

Adds a CHW-controlled billing-eligibility toggle to member_profiles, mirroring
the existing services_consent audit pattern.

Columns
-------
member_profiles
  - ``is_billable`` BOOLEAN NOT NULL DEFAULT true
      false → member is non-billable; their completed sessions should be
      excluded from Pear Suite billing submission.
  - ``billing_status_changed_at`` TIMESTAMPTZ nullable — audit: when last flipped
  - ``billing_status_changed_by`` UUID FK → users.id nullable — audit: who flipped it

All adds are nullable / have a server_default, so this is a fast metadata-only
change (no table rewrite). Still passes through the RDS pre-migration snapshot gate.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = "o7p8q9r0s1t2"
down_revision = "m5n6o7p8q9r0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "member_profiles",
        sa.Column(
            "is_billable",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
    )
    op.add_column(
        "member_profiles",
        sa.Column(
            "billing_status_changed_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )
    op.add_column(
        "member_profiles",
        sa.Column(
            "billing_status_changed_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("member_profiles", "billing_status_changed_by")
    op.drop_column("member_profiles", "billing_status_changed_at")
    op.drop_column("member_profiles", "is_billable")

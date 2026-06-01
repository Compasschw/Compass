"""member-csv: add MemberProfile.member_csv_exported_at idempotency stamp

Revision ID: g7b8c9d0e1f2
Revises: f6a7b8c9d0e1
Create Date: 2026-06-01 00:00:00.000000

Adds a nullable timestamp column the Pear Member-Import CSV writer
uses to dedup. Auth/register stamps it after a successful S3 append;
backfill_member_csv.py walks every row where it's NULL.
"""
from alembic import op
import sqlalchemy as sa


revision: str = "g7b8c9d0e1f2"
down_revision: str | None = "f6a7b8c9d0e1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "member_profiles",
        sa.Column(
            "member_csv_exported_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("member_profiles", "member_csv_exported_at")

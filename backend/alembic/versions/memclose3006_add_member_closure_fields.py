"""add member closure fields to member_profiles

A CHW can close a member's case with a disposition (closure_status) + reason.
NULL closure_status means the member is open/active. closed_at / closed_by give
the audit trail. Reversible: reopening sets all four back to NULL.

Revision ID: memclose3006
Revises: dedupjourney2806
Create Date: 2026-06-30

"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = "memclose3006"
down_revision = "dedupjourney2806"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "member_profiles",
        sa.Column("closure_status", sa.String(length=30), nullable=True),
    )
    op.add_column(
        "member_profiles",
        sa.Column("closure_reason", sa.String(length=40), nullable=True),
    )
    op.add_column(
        "member_profiles",
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "member_profiles",
        sa.Column(
            "closed_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("member_profiles", "closed_by")
    op.drop_column("member_profiles", "closed_at")
    op.drop_column("member_profiles", "closure_reason")
    op.drop_column("member_profiles", "closure_status")

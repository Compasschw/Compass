"""add_account_deletion_fields

Adds soft-delete and HIPAA data-retention columns to the `users` table
required by the account-deletion flow (Apple / Google Play policy + HIPAA
45 CFR §164.530(j) 6-year retention).

New columns
-----------
users.deleted_at          TIMESTAMPTZ NULL  — non-null = soft-deleted
users.data_retention_until DATE NULL        — deleted_at + 6 years; after
                                              this date the row may be
                                              hard-deleted by a scheduler job

Revision ID: m5i8j9k0l1m2
Revises: l4h7i8j9k0l1
Create Date: 2026-04-22 00:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "m5i8j9k0l1m2"
down_revision: Union[str, None] = "l4h7i8j9k0l1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # deleted_at: NULL for all existing rows — retroactively safe.
    op.add_column(
        "users",
        sa.Column(
            "deleted_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_users_deleted_at",
        "users",
        ["deleted_at"],
    )

    # data_retention_until: computed at deletion as deleted_at + 6 years.
    # NULL for all existing (non-deleted) rows.
    op.add_column(
        "users",
        sa.Column(
            "data_retention_until",
            sa.Date(),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_index("ix_users_deleted_at", table_name="users")
    op.drop_column("users", "deleted_at")
    op.drop_column("users", "data_retention_until")

"""add_phone_verified_at_to_users

Adds ``phone_verified_at`` column to the ``users`` table.  NULL means the
stored phone number has never been validated via an SMS OTP challenge.
Non-null means the user completed verification for that number.

When a user changes their phone, the column is reset to NULL by the
start-verification flow until the new number is confirmed.

Revision ID: r1n4o5p6q7r8
Revises: q9m2n3o4p5q6
Create Date: 2026-05-04 00:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "r1n4o5p6q7r8"
down_revision: Union[str, None] = "q9m2n3o4p5q6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "phone_verified_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("users", "phone_verified_at")

"""create_phone_verifications

Creates the ``phone_verifications`` table used by the SMS OTP verification
flow.  Each row represents one issued code for a (user_id, phone_e164) pair.

Columns
-------
id                UUID PK
user_id           UUID FK → users.id ON DELETE CASCADE
phone_e164        VARCHAR(20) — canonical E.164, e.g. +12125551234
code_hash         VARCHAR(255) — argon2 hash of the 6-digit code
attempts_left     INTEGER — starts at 5, decrements on each wrong guess
created_at        TIMESTAMPTZ — server default now()
expires_at        TIMESTAMPTZ — created_at + 10 minutes
verified_at       TIMESTAMPTZ NULL — non-null once code is accepted

Index
-----
ix_phone_verifications_user_phone — (user_id, phone_e164) for active-row lookup

Revision ID: s2o5p6q7r8s9
Revises: r1n4o5p6q7r8
Create Date: 2026-05-04 00:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "s2o5p6q7r8s9"
down_revision: Union[str, None] = "r1n4o5p6q7r8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "phone_verifications",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "user_id",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("phone_e164", sa.String(20), nullable=False),
        sa.Column("code_hash", sa.String(255), nullable=False),
        sa.Column("attempts_left", sa.Integer, nullable=False, server_default="5"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("verified_at", sa.DateTime(timezone=True), nullable=True),
    )

    op.create_index(
        "ix_phone_verifications_user_phone",
        "phone_verifications",
        ["user_id", "phone_e164"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_phone_verifications_user_phone",
        table_name="phone_verifications",
    )
    op.drop_table("phone_verifications")

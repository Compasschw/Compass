"""make_password_hash_nullable_add_onboarding_complete

Revision ID: 947a18b60652
Revises: v6w7x8y9z0a1
Create Date: 2026-06-24

Schema changes:
  users.password_hash   — DROP NOT NULL (social users have no password)
  member_profiles.onboarding_complete — ADD BOOLEAN NOT NULL DEFAULT TRUE
    False for OAuth-created members pending the onboarding completion flow.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision: str = "947a18b60652"
down_revision: str = "v6w7x8y9z0a1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Allow NULL password_hash for social-auth users (no password set).
    # Existing rows are unaffected — their hashes remain.
    op.alter_column(
        "users",
        "password_hash",
        existing_type=sa.String(length=255),
        nullable=True,
    )

    # Onboarding completion flag on member profiles.
    # Default TRUE so all pre-existing rows are treated as complete.
    op.add_column(
        "member_profiles",
        sa.Column(
            "onboarding_complete",
            sa.Boolean,
            nullable=False,
            server_default=sa.text("true"),
        ),
    )


def downgrade() -> None:
    op.drop_column("member_profiles", "onboarding_complete")

    # Restore NOT NULL — will fail if any NULL hashes exist. In practice,
    # this migration should only be rolled back in dev/test.
    op.alter_column(
        "users",
        "password_hash",
        existing_type=sa.String(length=255),
        nullable=False,
    )

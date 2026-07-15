"""trusted_devices table + members' sms_2fa_enabled opt-in column

SMS Output (Spec 2) — CHW SMS two-factor login with trusted devices.

Adds:
  * ``trusted_devices`` — 30-day "remember this device" tokens (hash-only at
    rest) that bypass the SMS challenge on a subsequent login. See
    ``app.models.trusted_device.TrustedDevice``.
  * ``users.sms_2fa_enabled`` — member opt-in flag for SMS 2FA (CHWs are
    governed by the ``chw_sms_2fa_enabled`` settings flag instead). NOT NULL
    with a ``false`` server default so every existing row is unaffected and no
    backfill is required.

This is the ONLY migration in Spec 2. It chains off Spec 1's final head
(``smsdlv0715``) so ``alembic upgrade head`` stays unambiguous (single head
``chw2fa0715``).

Revision ID: chw2fa0715
Revises: smsdlv0715
"""

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "chw2fa0715"
down_revision = "smsdlv0715"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "trusted_devices",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column("user_agent", sa.String(256), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "last_used_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("token_hash", name="uq_trusted_devices_token_hash"),
    )
    op.create_index(
        "ix_trusted_devices_user_id", "trusted_devices", ["user_id"]
    )
    op.create_index(
        "ix_trusted_devices_expires_at", "trusted_devices", ["expires_at"]
    )

    op.add_column(
        "users",
        sa.Column(
            "sms_2fa_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )


def downgrade() -> None:
    op.drop_column("users", "sms_2fa_enabled")
    op.drop_index("ix_trusted_devices_expires_at", table_name="trusted_devices")
    op.drop_index("ix_trusted_devices_user_id", table_name="trusted_devices")
    op.drop_table("trusted_devices")

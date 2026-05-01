"""add_admin_totp_secrets

Creates the ``admin_totp_secrets`` table for storing the AES-256-GCM–encrypted
TOTP shared secret used by the admin 2FA feature.

One row per "admin slot" (currently just one, keyed by name = "default").
Using a named-slot model rather than a single config row makes it easy to add
per-operator secrets in the future without a schema change.

HIPAA note: the TOTP secret is sensitive infrastructure credential, not PHI.
It is stored encrypted at rest using the same AES-256-GCM key (PHI_ENCRYPTION_KEY)
used for field-level PHI encryption — see app/utils/security.py::encrypt_field.

Revision ID: o7k0l1m2n3o4
Revises: n6j9k0l1m2n3
Create Date: 2026-04-22 00:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic
revision: str = "o7k0l1m2n3o4"
down_revision: Union[str, None] = "n6j9k0l1m2n3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "admin_totp_secrets",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        # Logical name for the admin slot — "default" for the single admin set.
        sa.Column("name", sa.String(64), nullable=False, unique=True),
        # AES-256-GCM ciphertext of the TOTP secret, base64-encoded.
        # Format: "<base64-nonce>:<base64-ciphertext>" produced by encrypt_field().
        sa.Column("encrypted_secret", sa.Text(), nullable=False),
        # True once the operator has verified their first TOTP code — secrets
        # that have never been verified can be regenerated safely.
        sa.Column("is_verified", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
            onupdate=sa.text("NOW()"),
        ),
    )


def downgrade() -> None:
    op.drop_table("admin_totp_secrets")

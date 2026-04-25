"""add credential document and expiry

Adds three new nullable columns to ``chw_credential_validations``:

  document_s3_key  – S3 path the CHW uploads their credential document to
                     after the native client completes the presigned-PUT.
                     Stored as path-only (e.g. credentials/<chw_id>/<uuid>.pdf);
                     the full URL is reconstructed at read time.

  expiry_date      – Date the credential expires.  Queried by the daily
                     scheduler to drive renewal-warning notifications.

  last_warned_date – Date we last sent a "credential expiring" push to this
                     CHW.  Used to prevent duplicate daily warnings and ensures
                     dedup survives process restarts (multi-instance safe).

Revision ID: i1e4f5a6b7c8
Revises: h0d3e4f5a6b7
Create Date: 2026-04-22 09:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "i1e4f5a6b7c8"
down_revision: Union[str, None] = "h0d3e4f5a6b7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "chw_credential_validations",
        sa.Column("document_s3_key", sa.String(500), nullable=True),
    )
    op.add_column(
        "chw_credential_validations",
        sa.Column("expiry_date", sa.Date(), nullable=True),
    )
    op.add_column(
        "chw_credential_validations",
        sa.Column("last_warned_date", sa.Date(), nullable=True),
    )
    # Index for the daily scheduler query: status=approved + expiry_date range
    op.create_index(
        "ix_chw_cred_val_expiry_status",
        "chw_credential_validations",
        ["expiry_date", "validation_status"],
    )


def downgrade() -> None:
    op.drop_index("ix_chw_cred_val_expiry_status", table_name="chw_credential_validations")
    op.drop_column("chw_credential_validations", "last_warned_date")
    op.drop_column("chw_credential_validations", "expiry_date")
    op.drop_column("chw_credential_validations", "document_s3_key")

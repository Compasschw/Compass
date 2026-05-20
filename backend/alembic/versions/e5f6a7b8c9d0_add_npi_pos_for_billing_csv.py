"""add chw_profiles.npi + billing_claims.place_of_service_code

Revision ID: e5f6a7b8c9d0
Revises: d4e5f6a7b8c9
Create Date: 2026-05-19

Backs the Pear bulk-upload CSV (billing_csv_writer service).  Pear's
CSV template includes two columns we don't currently persist:

  - ``Place of service code`` (e.g. "11 - Office", "02 - Telehealth")
    needed on every billable claim row.  Default '02' because the bulk
    of Compass sessions today are phone/video.  CHW can override at
    documentation-submit time when a session was in-person.
  - CHW NPI is technically required for Medi-Cal billing but Pear's
    template doesn't include it in the bulk-upload columns.  We add it
    to ``chw_profiles`` anyway because (a) the CBO needs it during their
    own claim review and (b) Pear's API path (when it ships the missing
    fields) will need it on the wire.

Both columns are nullable so existing rows aren't disturbed; the CSV
writer treats NULL as "use the default" (POS='02', NPI omitted).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e5f6a7b8c9d0"
down_revision: str | None = "d4e5f6a7b8c9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "chw_profiles",
        sa.Column("npi", sa.String(length=10), nullable=True),
    )
    op.add_column(
        "billing_claims",
        sa.Column(
            "place_of_service_code",
            sa.String(length=5),
            nullable=False,
            server_default="02",
        ),
    )


def downgrade() -> None:
    op.drop_column("billing_claims", "place_of_service_code")
    op.drop_column("chw_profiles", "npi")

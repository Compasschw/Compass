"""add member signup consent timestamps

Adds two nullable ``timestamptz`` columns to ``member_profiles`` capturing the
timestamped consent collected on BOTH member-signup surfaces (self-service
``POST /auth/register`` and CHW-initiated ``POST /chw/members``):

  - ``terms_accepted_at``          — member agreed to the Terms of Service +
                                     Privacy Policy.
  - ``communications_consent_at``  — member consented to calls/SMS from Compass
                                     and their CHW, and to Compass billing their
                                     insurance for covered services.

Required for A2P 10DLC documented opt-in and the HIPAA consent audit trail.

Both columns are NULLABLE so existing (legacy) members created before this gate
are unaffected — no backfill required. Only NEW signups are required (at the
request-schema boundary) to supply both consents, at which point the endpoints
stamp these columns = NOW(UTC).

Revision ID: c0n5ent0701
Revises: smsmsg0711
Create Date: 2026-07-11 00:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c0n5ent0701"
# Chained after #168's masked-SMS migration (which also branched smute0708) so
# the two concurrently-authored migrations form a single linear head rather
# than diverging into two alembic heads.
down_revision: Union[str, None] = "smsmsg0711"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "member_profiles",
        sa.Column("terms_accepted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "member_profiles",
        sa.Column(
            "communications_consent_at", sa.DateTime(timezone=True), nullable=True
        ),
    )


def downgrade() -> None:
    op.drop_column("member_profiles", "communications_consent_at")
    op.drop_column("member_profiles", "terms_accepted_at")

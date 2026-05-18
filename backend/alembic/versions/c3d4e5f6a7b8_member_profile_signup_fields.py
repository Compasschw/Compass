"""add demographic/address/insurance fields to member_profiles

Revision ID: c3d4e5f6a7b8
Revises: b2c3d4e5f6a7
Create Date: 2026-05-17

Backs the expanded member signup form (RegisterScreen → POST /auth/register).
Adds the fields Pear Suite needs to create a billable member record:

  - date_of_birth, gender                  → required by Pear's CreateMember
  - address_line1/2, city, state           → Pear's address sub-keys
  - insurance_company                      → drives carrier→costId lookup
                                              for billing claim generation
  - country defaults to "US"; we don't add the column because Compass is
    a CA Medi-Cal program with no foreign-member scenario

medi_cal_id (Primary CIN) and zip_code already exist on member_profiles so
they're not re-added here.  insurance_provider already exists as a free-text
column; we add insurance_company alongside it because the signup form uses
the curated 6-carrier dropdown (Anthem / Blue Shield Promise / Health Net /
Kaiser ILS / LA Care / Molina) while insurance_provider is the looser
existing free-text field used by the CHW intake flow.  Keeping both lets us
migrate insurance_provider into the dropdown later without breaking older
data.

All columns are nullable: only Full Name, DOB, and Sex are hard-required at
signup (per product decision).  Everything else is captured-but-optional so
members can complete profiles incrementally.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c3d4e5f6a7b8"
down_revision: str | None = "b2c3d4e5f6a7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("member_profiles", sa.Column("date_of_birth", sa.Date(), nullable=True))
    op.add_column("member_profiles", sa.Column("gender", sa.String(length=32), nullable=True))
    op.add_column("member_profiles", sa.Column("address_line1", sa.String(length=160), nullable=True))
    op.add_column("member_profiles", sa.Column("address_line2", sa.String(length=160), nullable=True))
    op.add_column("member_profiles", sa.Column("city", sa.String(length=80), nullable=True))
    op.add_column("member_profiles", sa.Column("state", sa.String(length=2), nullable=True))
    op.add_column("member_profiles", sa.Column("insurance_company", sa.String(length=80), nullable=True))


def downgrade() -> None:
    op.drop_column("member_profiles", "insurance_company")
    op.drop_column("member_profiles", "state")
    op.drop_column("member_profiles", "city")
    op.drop_column("member_profiles", "address_line2")
    op.drop_column("member_profiles", "address_line1")
    op.drop_column("member_profiles", "gender")
    op.drop_column("member_profiles", "date_of_birth")

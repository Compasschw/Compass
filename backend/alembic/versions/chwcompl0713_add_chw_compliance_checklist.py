"""add_chw_compliance_checklist

Epic D — CHW compliance checklist + admin approval + gated work.

Schema changes:
  - Add a UNIQUE constraint on credentials(chw_id, type) so the 4 document
    checklist types (hipaa_training, professional_service_agreement,
    liability_insurance, chw_certification) upsert cleanly — one row per
    (chw_id, type), enforced at the DB level as a backstop against a race
    between two concurrent submits producing duplicate rows. The
    `credentials` table itself already existed (previously unused dead
    code); no column changes are needed since `type`/`status`/`s3_key`/
    `verified_by`/`verified_at` already have the right shape for this reuse.

No backfill: this migration does NOT touch existing `credentials` rows (the
table has never been written to by any router prior to this epic, so it is
empty in every environment) and does NOT touch
chw_profiles.background_check_status's existing values or DB-level column
default ("not_started" server_default is unchanged — only the application
code path that constructs a NEW CHWProfile row now passes
background_check_status="pending" explicitly at insert time; see
app/services/auth_service.py register_user). Existing CHWs keep whatever
background_check_status they already have.

Revision ID: chwcompl0713
Revises: propby0713
"""

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "chwcompl0713"
down_revision: str | None = "propby0713"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_unique_constraint(
        "uq_credentials_chw_id_type",
        "credentials",
        ["chw_id", "type"],
    )


def downgrade() -> None:
    op.drop_constraint("uq_credentials_chw_id_type", "credentials", type_="unique")

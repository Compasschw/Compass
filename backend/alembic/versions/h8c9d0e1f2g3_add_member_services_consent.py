"""add member services consent columns

Revision ID: h8c9d0e1f2g3
Revises: g7b8c9d0e1f2
Create Date: 2026-06-08 00:00:00.000000

Adds three columns to member_profiles to support the member-controlled
Services Consent toggle (T03):

  services_consent          VARCHAR(32) NOT NULL DEFAULT 'consent_to_services'
  services_consent_changed_at  TIMESTAMP WITH TIME ZONE NULL
  services_consent_changed_by  UUID NULL -> FK users.id

Backfills all existing rows to 'consent_to_services' (the server_default
handles new inserts; old rows need the explicit UPDATE).
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "h8c9d0e1f2g3"
down_revision: str | None = "g7b8c9d0e1f2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── Add services_consent (NOT NULL with server default) ─────────────────
    op.add_column(
        "member_profiles",
        sa.Column(
            "services_consent",
            sa.String(32),
            nullable=False,
            server_default="consent_to_services",
        ),
    )

    # ── Add services_consent_changed_at (nullable timestamp) ─────────────────
    op.add_column(
        "member_profiles",
        sa.Column(
            "services_consent_changed_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )

    # ── Add services_consent_changed_by (nullable FK -> users.id) ────────────
    op.add_column(
        "member_profiles",
        sa.Column(
            "services_consent_changed_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=True,
        ),
    )

    # ── Backfill existing rows ────────────────────────────────────────────────
    # The server_default guarantees new inserts get 'consent_to_services'
    # automatically.  Rows that existed before this migration have
    # services_consent=NULL due to the column not existing — the NOT NULL
    # constraint above is satisfied by the backfill below (Postgres applies
    # the server_default on the ALTER TABLE for existing rows when the
    # column is added with a non-null default, so this UPDATE is a belt-
    # and-suspenders precaution).
    op.execute(
        "UPDATE member_profiles "
        "SET services_consent = 'consent_to_services' "
        "WHERE services_consent IS NULL"
    )


def downgrade() -> None:
    op.drop_column("member_profiles", "services_consent_changed_by")
    op.drop_column("member_profiles", "services_consent_changed_at")
    op.drop_column("member_profiles", "services_consent")

"""Add Pear Suite ID columns to member_profiles and chw_profiles, and create pear_suite_template_map config table.

Revision ID: aa1b2c3d4e5f
Revises: z9w3x4y5a6b7
Create Date: 2026-05-09 00:00:00.000000

Changes:
- member_profiles.pear_suite_member_id (String 100, nullable, indexed)
- chw_profiles.pear_suite_user_id (String 100, nullable, indexed)
- pear_suite_template_map config table (cpt_code PK, template_id, modifier, description)
- Seed: one row for T1016 with empty template_id (filled at runtime from env)
"""

from alembic import op
import sqlalchemy as sa

# Revision identifiers used by Alembic.
revision = "aa1b2c3d4e5f"
down_revision = "z9w3x4y5a6b7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── member_profiles: add pear_suite_member_id ─────────────────────────────
    op.add_column(
        "member_profiles",
        sa.Column(
            "pear_suite_member_id",
            sa.String(100),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_member_profiles_pear_suite_member_id",
        "member_profiles",
        ["pear_suite_member_id"],
        unique=False,
    )

    # ── chw_profiles: add pear_suite_user_id ──────────────────────────────────
    op.add_column(
        "chw_profiles",
        sa.Column(
            "pear_suite_user_id",
            sa.String(100),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_chw_profiles_pear_suite_user_id",
        "chw_profiles",
        ["pear_suite_user_id"],
        unique=False,
    )

    # ── pear_suite_template_map config table ──────────────────────────────────
    op.create_table(
        "pear_suite_template_map",
        sa.Column("cpt_code", sa.String(20), nullable=False),
        sa.Column("template_id", sa.String(200), nullable=False, server_default=""),
        sa.Column("modifier", sa.String(10), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("cpt_code"),
    )

    # ── Seed: T1016 row (template_id filled from env at runtime) ──────────────
    _seed_t1016()


def _seed_t1016() -> None:
    """Insert the T1016 CHW service row.

    template_id is intentionally seeded as an empty string. Before running the
    demo flow, set PEAR_SUITE_T1016_TEMPLATE_ID in the environment — the
    demo-claim endpoint reads it from settings and will 400 if still blank.

    Alternatively, UPDATE the row directly after obtaining the template ID from
    the Pear Suite dashboard:
        UPDATE pear_suite_template_map
        SET template_id = '<your-template-id>'
        WHERE cpt_code = 'T1016';
    """
    op.execute(
        """
        INSERT INTO pear_suite_template_map (cpt_code, template_id, modifier, description)
        VALUES (
            'T1016',
            '',
            'U2',
            'Targeted Case Management – CHW/Community Health Worker (Medi-Cal T1016)'
        )
        ON CONFLICT (cpt_code) DO NOTHING;
        """
    )


def downgrade() -> None:
    op.drop_table("pear_suite_template_map")
    op.drop_index("ix_chw_profiles_pear_suite_user_id", table_name="chw_profiles")
    op.drop_column("chw_profiles", "pear_suite_user_id")
    op.drop_index("ix_member_profiles_pear_suite_member_id", table_name="member_profiles")
    op.drop_column("member_profiles", "pear_suite_member_id")

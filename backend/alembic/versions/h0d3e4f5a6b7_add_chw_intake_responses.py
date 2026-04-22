"""add chw intake responses table

Creates the CHW professional intake questionnaire table. Captures 27
single-select answers plus two free-text "Other — please specify" overrides.
All columns are nullable so partial progress saves cleanly.

Revision ID: h0d3e4f5a6b7
Revises: g9c2d3e4f5a6
Create Date: 2026-04-21 10:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "h0d3e4f5a6b7"
down_revision: Union[str, None] = "g9c2d3e4f5a6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "chw_intake_responses",
        sa.Column(
            "id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "user_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        # Section 1
        sa.Column("years_experience", sa.String(30), nullable=True),
        sa.Column("employment_status", sa.String(30), nullable=True),
        sa.Column("education_level", sa.String(30), nullable=True),
        sa.Column("primary_setting", sa.String(30), nullable=True),
        # Section 2
        sa.Column("ca_chw_certificate", sa.String(30), nullable=True),
        sa.Column("training_pathway", sa.String(30), nullable=True),
        sa.Column("additional_certification", sa.String(30), nullable=True),
        sa.Column("medi_cal_familiarity", sa.String(30), nullable=True),
        sa.Column("ehr_experience", sa.String(30), nullable=True),
        # Section 3
        sa.Column("primary_language", sa.String(30), nullable=True),
        sa.Column("other_language_fluency", sa.String(30), nullable=True),
        sa.Column("additional_language", sa.String(30), nullable=True),
        sa.Column("cultural_competency_training", sa.String(30), nullable=True),
        sa.Column("lived_experience", sa.String(30), nullable=True),
        # Section 4
        sa.Column("primary_specialization", sa.String(40), nullable=True),
        sa.Column("sdoh_experience", sa.String(30), nullable=True),
        sa.Column("population_experience", sa.String(40), nullable=True),
        sa.Column("motivational_interviewing", sa.String(30), nullable=True),
        sa.Column("hedis_experience", sa.String(30), nullable=True),
        # Section 5
        sa.Column("preferred_modality", sa.String(30), nullable=True),
        sa.Column("home_visit_comfort", sa.String(30), nullable=True),
        sa.Column("telehealth_comfort", sa.String(30), nullable=True),
        sa.Column("transportation", sa.String(30), nullable=True),
        sa.Column("preferred_caseload", sa.String(30), nullable=True),
        # Section 6
        sa.Column("preferred_schedule", sa.String(30), nullable=True),
        sa.Column("preferred_employment_type", sa.String(30), nullable=True),
        sa.Column("urgent_outreach", sa.String(30), nullable=True),
        # Free-text "Other" overrides
        sa.Column("primary_language_other", sa.String(100), nullable=True),
        sa.Column("additional_language_other", sa.String(100), nullable=True),
        # Progress
        sa.Column("last_completed_section", sa.Integer, nullable=False, server_default="0"),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_chw_intake_user",
        "chw_intake_responses",
        ["user_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_chw_intake_user", table_name="chw_intake_responses")
    op.drop_table("chw_intake_responses")

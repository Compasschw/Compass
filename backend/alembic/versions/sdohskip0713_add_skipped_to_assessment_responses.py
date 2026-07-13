"""add_skipped_to_assessment_responses

Epic W2 — per-question Skip for SDOH/health screenings.

Adds a single NOT NULL boolean column, ``skipped``, to
``member_assessment_responses``. This is a strictly additive migration:
existing rows backfill to ``skipped = false`` via the server default, which
is exactly correct — every response captured before this migration was a
real answer, never a skip.

Design note (see also app/models/assessment.py module docstring): a
dedicated boolean column was chosen over a reserved sentinel value in
``answer_value`` because it keeps that column free of magic strings for
downstream AI-summary / admin-reporting queries, and because a boolean
column is directly filterable/indexable without exact-string matching.

Revision ID: sdohskip0713
Revises: mustchg0712
"""

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "sdohskip0713"
down_revision: str | None = "resneeds0713"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "member_assessment_responses",
        sa.Column(
            "skipped",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.create_index(
        "ix_member_assessment_responses_skipped",
        "member_assessment_responses",
        ["skipped"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_member_assessment_responses_skipped",
        table_name="member_assessment_responses",
    )
    op.drop_column("member_assessment_responses", "skipped")

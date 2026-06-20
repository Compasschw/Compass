"""add_journey_template_is_custom — flag for per-member CHW-authored journeys.

Revision ID: t2u3v4w5x6y7
Revises:     s1t2u3v4w5x6
Create Date: 2026-06-20

A "custom" journey is a normal MemberJourney backed by a PRIVATE JourneyTemplate
the CHW authors node-by-node (vs the shared, pre-seeded templates). is_custom
marks those private templates so they are excluded from the journey-template
picker and are the only ones a CHW may edit. Nullable/defaulted add — passes the
RDS snapshot gate; existing templates default to is_custom=false.
"""

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision = "t2u3v4w5x6y7"
down_revision = "s1t2u3v4w5x6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "journey_templates",
        sa.Column(
            "is_custom",
            sa.Boolean(),
            nullable=False,
            server_default="false",
        ),
    )


def downgrade() -> None:
    op.drop_column("journey_templates", "is_custom")

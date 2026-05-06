"""add_ai_summary_to_session_documentation

Splits session documentation into CHW-authored notes (existing ``summary``
column, unchanged) and AI-generated summary (three new columns).

Investors and HIPAA auditors must be able to distinguish the two at a glance
and forever after. The CHW-authored ``summary`` field is the human record of
record; the ``ai_summary`` field is the raw LLM output that was shown as a
draft in the DocumentationModal.

New columns
-----------
ai_summary                TEXT, nullable
    The 3-5 sentence plain-language summary produced by the LLM.  NULL means
    the AI summary endpoint was never called for this session or returned empty.

ai_summary_generated_at   TIMESTAMPTZ, nullable
    UTC timestamp of the generate call.  NULL when ai_summary is NULL.

ai_summary_excluded       BOOLEAN, NOT NULL, server_default false
    Set to true by the CHW when the AI draft was inappropriate, inaccurate,
    or otherwise should be excluded from audit displays.  Defaults to false so
    existing rows (which have no AI summary) are not surfaced as "excluded".

Revision ID: t3p6q7r8s9t0
Revises:     s2o5p6q7r8s9
Create Date: 2026-05-06 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "t3p6q7r8s9t0"
down_revision: str | None = "s2o5p6q7r8s9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "session_documentation",
        sa.Column("ai_summary", sa.Text(), nullable=True),
    )
    op.add_column(
        "session_documentation",
        sa.Column(
            "ai_summary_generated_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )
    op.add_column(
        "session_documentation",
        sa.Column(
            "ai_summary_excluded",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )


def downgrade() -> None:
    op.drop_column("session_documentation", "ai_summary_excluded")
    op.drop_column("session_documentation", "ai_summary_generated_at")
    op.drop_column("session_documentation", "ai_summary")

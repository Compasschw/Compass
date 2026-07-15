"""add member_profiles.last_stop_prompt_at — STOP-prompt 24h cadence stamp

SMS Output (Spec 1) §2 — STOP opt-out prompt cadence. CTIA / 10DLC best
practice requires every recipient to be reminded, at a reasonable cadence,
that they can text STOP to opt out. Rather than append the opt-out line to
EVERY outbound member SMS (noisy, wastes segment budget on a member who
already knows), Compass appends " Reply STOP to opt out." to only the FIRST
member-facing SMS in any rolling 24-hour window per member, then stamps this
column with the send time. ``app.routers.conversations.with_stop_prompt``
reads/writes it (null or >24h old ⇒ append + stamp; otherwise unchanged).

Ships in the SAME PR as the model column it backs (PR-2). A model column
whose migration lands in a LATER PR would deploy new ORM code against an old
schema and 500 every member-profile read — the exact ``cinhash0715``
incident mode — so the column and its migration are always released together.

Revision ID: stopprompt0715
Revises: cinhash0715
"""

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "stopprompt0715"
down_revision: str | None = "cinhash0715"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "member_profiles",
        sa.Column("last_stop_prompt_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("member_profiles", "last_stop_prompt_at")

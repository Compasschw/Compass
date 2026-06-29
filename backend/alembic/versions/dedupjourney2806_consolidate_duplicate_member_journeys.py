"""consolidate duplicate active member journeys (one per member+name)

A member could end up with two active journeys that display the same name
(e.g. a canonical "Employment" plus a custom journey also named "Employment",
or two canonical journeys for the same need). This one-time cleanup keeps the
"best" active journey per (member_id, template name) and marks the rest
'abandoned'. Best = most completed steps, then earliest created.

Going forward, reconcile_member_journeys_to_needs collapses every name to a
single survivor, so duplicates won't reappear.

Revision ID: dedupjourney2806
Revises: jpriolevel2806
Create Date: 2026-06-28

"""
from __future__ import annotations

from alembic import op

# revision identifiers, used by Alembic.
revision = "dedupjourney2806"
down_revision = "jpriolevel2806"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        WITH completed AS (
            SELECT member_journey_id, COUNT(*) AS c
            FROM member_journey_step_states
            WHERE status = 'completed'
            GROUP BY member_journey_id
        ),
        ranked AS (
            SELECT
                mj.id,
                ROW_NUMBER() OVER (
                    PARTITION BY mj.member_id, jt.name
                    ORDER BY COALESCE(comp.c, 0) DESC, mj.created_at ASC, mj.id ASC
                ) AS rn
            FROM member_journeys mj
            JOIN journey_templates jt ON jt.id = mj.template_id
            LEFT JOIN completed comp ON comp.member_journey_id = mj.id
            WHERE mj.status = 'active'
        )
        UPDATE member_journeys
        SET status = 'abandoned'
        WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
        """
    )


def downgrade() -> None:
    # One-way data cleanup: the abandoned duplicates cannot be reliably
    # distinguished from intentionally-abandoned journeys, so there is no safe
    # automatic reversal.
    pass

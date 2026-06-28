"""rename the 'rehab' vertical to 'transportation' (data-only)

The 'rehab' vertical/resource-need is being repurposed to 'transportation'
app-wide. Vertical values are stored as plain strings (String(50)), so this is a
pure data migration — no schema change. Every column that can hold the slug is
rewritten, including the verticals/needs arrays and the resource_need_levels
JSONB keys, plus the canonical "Rehab & Recovery" journey template.

Note: 'employment' is added purely in code (new enum value); it requires no data
migration because no existing rows reference it.

Revision ID: reh2transp2606
Revises: c4d5e6f7a8b9
Create Date: 2026-06-28

"""
from __future__ import annotations

from alembic import op

# revision identifiers, used by Alembic.
revision = "reh2transp2606"
down_revision = "c4d5e6f7a8b9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── Scalar string columns ────────────────────────────────────────────────
    op.execute(
        "UPDATE service_requests SET vertical = 'transportation' "
        "WHERE vertical = 'rehab'"
    )
    op.execute(
        "UPDATE sessions SET vertical = 'transportation' WHERE vertical = 'rehab'"
    )
    op.execute(
        "UPDATE session_followups SET vertical = 'transportation' "
        "WHERE vertical = 'rehab'"
    )
    op.execute(
        "UPDATE calendar_events SET vertical = 'transportation' "
        "WHERE vertical = 'rehab'"
    )
    op.execute(
        "UPDATE member_profiles SET primary_need = 'transportation' "
        "WHERE primary_need = 'rehab'"
    )

    # ── Array columns ────────────────────────────────────────────────────────
    op.execute(
        "UPDATE service_requests "
        "SET verticals = array_replace(verticals, 'rehab', 'transportation') "
        "WHERE 'rehab' = ANY(verticals)"
    )
    op.execute(
        "UPDATE member_profiles "
        "SET additional_needs = array_replace(additional_needs, 'rehab', 'transportation') "
        "WHERE 'rehab' = ANY(additional_needs)"
    )

    # ── JSONB keys: resource_need_levels {"rehab": "high"} → {"transportation": ...} ──
    op.execute(
        """
        UPDATE member_profiles
        SET resource_need_levels =
            (resource_need_levels - 'rehab')
            || jsonb_build_object('transportation', resource_need_levels -> 'rehab')
        WHERE resource_need_levels ? 'rehab'
        """
    )

    # ── Canonical journey template rename ────────────────────────────────────
    # The reconciler created "Rehab & Recovery" with slug 'rehab_recovery'.
    # Member journeys reference it by template_id, so renaming in place keeps
    # every existing journey intact — it simply becomes a Transportation journey.
    op.execute(
        """
        UPDATE journey_templates
        SET name = 'Transportation', slug = 'transportation', category = 'transportation'
        WHERE slug = 'rehab_recovery'
        """
    )
    # Any other (non-canonical) templates still categorised 'rehab'.
    op.execute(
        "UPDATE journey_templates SET category = 'transportation' "
        "WHERE category = 'rehab'"
    )


def downgrade() -> None:
    # Best-effort reverse. NOTE: this is lossy — rows that were legitimately
    # 'transportation' AFTER the upgrade cannot be distinguished from migrated
    # 'rehab' rows, so a downgrade re-labels all 'transportation' back to 'rehab'.
    op.execute(
        "UPDATE journey_templates SET category = 'rehab' "
        "WHERE category = 'transportation'"
    )
    op.execute(
        """
        UPDATE journey_templates
        SET name = 'Rehab & Recovery', slug = 'rehab_recovery', category = 'rehab'
        WHERE slug = 'transportation'
        """
    )
    op.execute(
        """
        UPDATE member_profiles
        SET resource_need_levels =
            (resource_need_levels - 'transportation')
            || jsonb_build_object('rehab', resource_need_levels -> 'transportation')
        WHERE resource_need_levels ? 'transportation'
        """
    )
    op.execute(
        "UPDATE member_profiles "
        "SET additional_needs = array_replace(additional_needs, 'transportation', 'rehab') "
        "WHERE 'transportation' = ANY(additional_needs)"
    )
    op.execute(
        "UPDATE service_requests "
        "SET verticals = array_replace(verticals, 'transportation', 'rehab') "
        "WHERE 'transportation' = ANY(verticals)"
    )
    op.execute(
        "UPDATE member_profiles SET primary_need = 'rehab' "
        "WHERE primary_need = 'transportation'"
    )
    op.execute(
        "UPDATE calendar_events SET vertical = 'rehab' "
        "WHERE vertical = 'transportation'"
    )
    op.execute(
        "UPDATE session_followups SET vertical = 'rehab' "
        "WHERE vertical = 'transportation'"
    )
    op.execute(
        "UPDATE sessions SET vertical = 'rehab' WHERE vertical = 'transportation'"
    )
    op.execute(
        "UPDATE service_requests SET vertical = 'rehab' "
        "WHERE vertical = 'transportation'"
    )

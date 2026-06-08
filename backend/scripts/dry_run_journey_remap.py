"""Dry-run audit: show what the j0e1f2g3h4i5 migration WOULD do without
writing anything to the database.

Output per existing template:
  - count of MemberJourney rows that would be affected
  - count of MemberJourneyStepState rows that would be remapped
  - proposed step-name remap table (old name → new name, old pts → new pts)

Also prints:
  - total new JourneyTemplate + JourneyTemplateStep rows to be inserted
  - warning if any old step name in the remap table is not found in the DB
    (indicates the seed was never applied or was already remapped)

Exit codes:
    0  Dry-run completed successfully — review output before approving.
    1  Fatal error (DB unreachable, schema mismatch).

Usage:
    cd backend && source .venv/bin/activate && \\
      DATABASE_URL='postgresql+asyncpg://compass:compass_dev_password@localhost:5432/compass' \\
      ADMIN_KEY='local-dev-admin-key-aaaa1111' SECRET_KEY='local-dev-only-not-for-production-use-abc123' \\
      python -m scripts.dry_run_journey_remap
"""
from __future__ import annotations

import asyncio
import logging
import sys
from typing import Any

from sqlalchemy import func, select, text

from app.database import async_session
from app.models.journeys import (
    JourneyTemplate,
    JourneyTemplateStep,
    MemberJourney,
    MemberJourneyStepState,
)

logger = logging.getLogger("compass.dry_run_journey_remap")
logging.basicConfig(level=logging.INFO, format="%(message)s")

# ─── Step-name remap definition (mirrors migration j0e1f2g3h4i5) ──────────────

_STANDARD_STEPS: list[dict[str, Any]] = [
    {"order": 1, "name": "Need Identified",       "points": 10},
    {"order": 2, "name": "Eligibility Screening", "points": 25},
    {"order": 3, "name": "Upload Documents",      "points": 30},
    {"order": 4, "name": "Follow Up",             "points": 10},
    {"order": 5, "name": "Resource Connection",   "points": 25},
    {"order": 6, "name": "Journey Complete",      "points": 50},
]

# new_order → (name, points) — quick lookup
_NEW_BY_ORDER: dict[int, dict[str, Any]] = {
    s["order"]: s for s in _STANDARD_STEPS
}

# Per-template: old_step_name → new_order (mirrors _REMAP in migration file)
_REMAP: dict[str, dict[str, int]] = {
    "food_assistance": {
        "Need Identified":       1,
        "Eligibility Screening": 2,
        "Upload Documents":      3,
        "Follow Up":             4,
        "Resource Connection":   5,
        "Journey Complete":      6,
    },
    "housing": {
        "Need Identified":       1,
        "Eligibility Screening": 2,
        "Application":           3,
        "Documents Uploaded":    4,
        "Application Submitted": 5,
        "Placed":                6,
    },
    "mental_health": {
        "Need Identified":  1,
        "Screened":         2,
        "Referred":         3,
        "Intake Completed": 4,
        "First Session":    5,
        "Engaged in Care":  6,
    },
    "maternal_health": {
        "Need Identified": 1,
        "Provider Match":  2,
        "First Visit":     3,
        "WIC Enrolled":    4,
        "Engaged in Care": 5,
        # No old step maps to order=6; "Journey Complete" is a new insert only.
    },
}

# New templates to be inserted (6)
_NEW_TEMPLATES: list[dict[str, str]] = [
    {"slug": "rent_payment_assistance", "name": "Rent Payment Assistance", "category": "housing",     "icon": "building-2"},
    {"slug": "utility_support",         "name": "Utility Support",         "category": "housing",     "icon": "zap"},
    {"slug": "calfresh_enrollment",     "name": "CalFresh Enrollment",     "category": "food",        "icon": "shopping-basket"},
    {"slug": "healthcare_appointment",  "name": "Healthcare Appointment",  "category": "health",      "icon": "stethoscope"},
    {"slug": "food_pantry",             "name": "Food Pantry",             "category": "food",        "icon": "package"},
    {"slug": "health_education",        "name": "Health Education",        "category": "health",      "icon": "book-open"},
]


async def main() -> int:
    """Run read-only queries and print the planned remap summary."""
    try:
        async with async_session() as db:
            return await _audit(db)
    except Exception as exc:
        logger.error("Fatal error connecting to DB: %s", exc)
        return 1


async def _audit(db: Any) -> int:
    """Execute the dry-run audit queries. READ-ONLY — no writes, no commits."""
    sep = "─" * 70
    logger.info(sep)
    logger.info("DRY RUN: Journey Template remap (migration j0e1f2g3h4i5)")
    logger.info(sep)

    total_journeys_affected = 0
    total_states_affected = 0
    warnings: list[str] = []

    # ── Section 1: Per-template remap analysis ────────────────────────────────
    for slug, name_to_order in _REMAP.items():
        logger.info("")
        logger.info("Template: %s", slug)
        logger.info("  Step-name remap table:")
        logger.info(
            "    %-30s  %-5s  →  %-30s  %-5s  %s",
            "OLD NAME", "PTS", "NEW NAME", "PTS", "STATUS",
        )
        logger.info("    " + "-" * 90)

        # Fetch the template row.
        tpl_result = await db.execute(
            select(JourneyTemplate).where(JourneyTemplate.slug == slug)
        )
        tpl = tpl_result.scalar_one_or_none()
        if tpl is None:
            logger.info("    [SKIP] Template not found in DB — seed was never applied.")
            warnings.append(f"Template '{slug}' not found in DB.")
            continue

        # Fetch current steps from the DB.
        steps_result = await db.execute(
            select(JourneyTemplateStep)
            .where(JourneyTemplateStep.template_id == tpl.id)
            .order_by(JourneyTemplateStep.order)
        )
        db_steps = steps_result.scalars().all()
        db_step_by_name: dict[str, JourneyTemplateStep] = {s.name: s for s in db_steps}

        # Collect old_step_ids for which we have state rows to remap.
        old_step_ids_with_states: list[Any] = []

        for old_name, new_order in name_to_order.items():
            new_step_def = _NEW_BY_ORDER[new_order]
            old_step = db_step_by_name.get(old_name)
            if old_step is None:
                status = "WARN: old step not found in DB"
                warnings.append(
                    f"Template '{slug}': old step '{old_name}' not found in DB."
                )
            elif old_name == new_step_def["name"]:
                status = "exact match (re-insert at canonical points)"
            else:
                status = "rename"

            logger.info(
                "    %-30s  %-5s  →  %-30s  %-5s  %s",
                old_name,
                old_step.points_on_completion if old_step else "N/A",
                new_step_def["name"],
                new_step_def["points"],
                status,
            )
            if old_step is not None:
                old_step_ids_with_states.append(old_step.id)

        # For maternal_health, show the synthesized 6th step.
        if slug == "maternal_health":
            logger.info(
                "    %-30s  %-5s  →  %-30s  %-5s  %s",
                "(no old step)",
                "N/A",
                "Journey Complete",
                50,
                "INSERT only — no state rows to remap",
            )

        # Count MemberJourney rows for this template.
        journey_count_result = await db.execute(
            select(func.count())
            .select_from(MemberJourney)
            .where(MemberJourney.template_id == tpl.id)
        )
        journey_count: int = journey_count_result.scalar_one()

        # Count MemberJourneyStepState rows pointing at old steps.
        state_count: int = 0
        if old_step_ids_with_states:
            state_count_result = await db.execute(
                select(func.count())
                .select_from(MemberJourneyStepState)
                .where(
                    MemberJourneyStepState.template_step_id.in_(
                        old_step_ids_with_states
                    )
                )
            )
            state_count = state_count_result.scalar_one()

        logger.info(
            "  MemberJourney rows that would be affected:           %d",
            journey_count,
        )
        logger.info(
            "  MemberJourneyStepState rows that would be remapped:  %d",
            state_count,
        )

        total_journeys_affected += journey_count
        total_states_affected += state_count

    # ── Section 2: New templates to be inserted ───────────────────────────────
    logger.info("")
    logger.info(sep)
    logger.info("New templates to INSERT (6 templates × 6 steps each):")
    logger.info(sep)
    new_templates_to_insert: list[str] = []
    for tpl_def in _NEW_TEMPLATES:
        exists_result = await db.execute(
            select(JourneyTemplate).where(JourneyTemplate.slug == tpl_def["slug"])
        )
        exists = exists_result.scalar_one_or_none()
        if exists is not None:
            logger.info(
                "  [SKIP] %-30s — already exists in DB (slug collision)", tpl_def["slug"]
            )
        else:
            logger.info(
                "  [INSERT] %-30s  (%s / %s)",
                tpl_def["slug"], tpl_def["name"], tpl_def["category"],
            )
            new_templates_to_insert.append(tpl_def["slug"])

    new_template_rows = len(new_templates_to_insert)
    new_step_rows = new_template_rows * len(_STANDARD_STEPS)

    # ── Section 3: Summary ────────────────────────────────────────────────────
    logger.info("")
    logger.info(sep)
    logger.info("SUMMARY")
    logger.info(sep)
    logger.info(
        "  Existing templates remapped:                    4"
    )
    logger.info(
        "  MemberJourney rows affected:                    %d",
        total_journeys_affected,
    )
    logger.info(
        "  MemberJourneyStepState rows remapped:           %d",
        total_states_affected,
    )
    logger.info(
        "  New JourneyTemplate rows to INSERT:             %d",
        new_template_rows,
    )
    logger.info(
        "  New JourneyTemplateStep rows to INSERT:         %d  (%d new + 4×6 replacements = %d total)",
        new_step_rows + 4 * 6,
        new_step_rows,
        new_step_rows + 4 * 6,
    )

    if warnings:
        logger.info("")
        logger.info("WARNINGS (%d):", len(warnings))
        for w in warnings:
            logger.info("  - %s", w)

    logger.info("")
    logger.info(
        "NO WRITES PERFORMED. Review the above, then approve the migration."
    )
    logger.info(sep)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

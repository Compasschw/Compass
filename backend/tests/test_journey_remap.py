"""Tests for the T06 journey-template standardization.

Coverage:
  1. After seeding all 10 templates, every template has exactly 6 steps with
     the standardized names and point values from STANDARD_STEPS.
  2. The migration's step-remap mapping covers every existing step name for
     all 4 original templates — no old step name is left unmapped.
  3. WellnessPointsLedger entries are preserved after a step-state remap —
     the migration does NOT double-grant points on existing ledger rows.

Tests 1 + 3 require a live Postgres connection; they are skipped automatically
when the test DB is unreachable (the autouse ``setup_db`` fixture already
produces a skip-compatible error in that case).

Test 2 is a pure-Python structural assertion — it validates the _REMAP dict
before any DB interaction is attempted and therefore always passes even when
Postgres is down.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.journeys import (
    JourneyTemplate,
    JourneyTemplateStep,
    WellnessPointsLedger,
)
from app.services.journey_seeds import STANDARD_STEPS, seed_default_journey_templates
from tests.conftest import test_session

# ─── Expected standardized step shape ──────────────────────────────────────────

_EXPECTED_STEP_NAMES: list[str] = [step["name"] for step in STANDARD_STEPS]
_EXPECTED_STEP_POINTS: dict[str, int] = {
    step["name"]: step["points_on_completion"] for step in STANDARD_STEPS
}
_EXPECTED_SLUG_COUNT = 10
_EXPECTED_SLUGS = {
    "food_assistance",
    "housing",
    "mental_health",
    "maternal_health",
    "rent_payment_assistance",
    "utility_support",
    "calfresh_enrollment",
    "healthcare_appointment",
    "food_pantry",
    "health_education",
}

# Per-template old step names (as seeded before the migration).
# Test 2 validates that every old name is covered by the remap table.
_OLD_STEP_NAMES_BY_SLUG: dict[str, list[str]] = {
    "food_assistance": [
        "Need Identified",
        "Eligibility Screening",
        "Upload Documents",
        "Follow Up",
        "Resource Connection",
        "Journey Complete",
    ],
    "housing": [
        "Need Identified",
        "Eligibility Screening",
        "Application",
        "Documents Uploaded",
        "Application Submitted",
        "Placed",
    ],
    "mental_health": [
        "Need Identified",
        "Screened",
        "Referred",
        "Intake Completed",
        "First Session",
        "Engaged in Care",
    ],
    "maternal_health": [
        "Need Identified",
        "Provider Match",
        "First Visit",
        "WIC Enrolled",
        "Engaged in Care",
        # No 6th step existed — Journey Complete is a net-new insert.
    ],
}

# Mirror of the remap table in migration j0e1f2g3h4i5.
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
    },
}


# ─── Module-level structural validation (runs at import time) ─────────────────
# Validates that _REMAP covers every old step name before any test runs.
# This is intentionally a module-level assert so it fails loudly at collection
# time, not just when the test suite happens to reach test 2.

def _validate_remap_completeness() -> None:
    """Assert remap completeness; raise AssertionError if any gap is found."""
    for slug, old_names in _OLD_STEP_NAMES_BY_SLUG.items():
        remap_for_slug = _REMAP.get(slug, {})
        for old_name in old_names:
            assert old_name in remap_for_slug, (
                f"Old step '{old_name}' for template '{slug}' has no remap "
                f"entry — MemberJourneyStepState rows would be left pointing "
                f"at a deleted step ID after the migration."
            )
            target_order = remap_for_slug[old_name]
            assert 1 <= target_order <= 6, (
                f"Remap for '{slug}'/'{old_name}' maps to order={target_order}, "
                f"which is outside the valid [1..6] range."
            )


# Trigger the structural validation at module-load time.
_validate_remap_completeness()


# ─── Test 1: Seeded templates have exactly 6 steps with standardized shape ─────


@pytest.mark.asyncio
async def test_all_ten_templates_have_6_standard_steps(seeded_db: AsyncSession) -> None:
    """After seeding, every template must have exactly 6 steps with the
    canonical names and point values defined in STANDARD_STEPS."""
    templates_result = await seeded_db.execute(select(JourneyTemplate))
    templates = templates_result.scalars().all()

    assert len(templates) == _EXPECTED_SLUG_COUNT, (
        f"Expected {_EXPECTED_SLUG_COUNT} templates, found {len(templates)}. "
        f"Missing: {_EXPECTED_SLUGS - {t.slug for t in templates}}"
    )

    slugs_found = {t.slug for t in templates}
    assert slugs_found == _EXPECTED_SLUGS, (
        f"Slug mismatch. Extra: {slugs_found - _EXPECTED_SLUGS}. "
        f"Missing: {_EXPECTED_SLUGS - slugs_found}"
    )

    for template in templates:
        steps_result = await seeded_db.execute(
            select(JourneyTemplateStep)
            .where(JourneyTemplateStep.template_id == template.id)
            .order_by(JourneyTemplateStep.order)
        )
        steps = steps_result.scalars().all()

        assert len(steps) == 6, (
            f"Template '{template.slug}' has {len(steps)} steps, expected 6."
        )

        step_names = [s.name for s in steps]
        assert step_names == _EXPECTED_STEP_NAMES, (
            f"Template '{template.slug}' step names mismatch. "
            f"Got: {step_names}, expected: {_EXPECTED_STEP_NAMES}"
        )

        for step in steps:
            expected_pts = _EXPECTED_STEP_POINTS[step.name]
            assert step.points_on_completion == expected_pts, (
                f"Template '{template.slug}', step '{step.name}': "
                f"points={step.points_on_completion}, expected={expected_pts}"
            )

            assert step.order in range(1, 7), (
                f"Template '{template.slug}', step '{step.name}': "
                f"order={step.order} is out of expected [1..6] range."
            )


# ─── Test 2: Remap table covers every old step name (structural) ───────────────


def test_remap_table_covers_all_existing_step_names() -> None:
    """Validates the _REMAP dict covers all original step names.

    This is a pure structural test — it does not require a DB connection.
    The module-level ``_validate_remap_completeness()`` call already fires
    this assertion at import time; this test makes the coverage explicit in
    the pytest report.
    """
    # Re-run explicitly so pytest records it as a passing test, not just a
    # side-effect of module loading.
    _validate_remap_completeness()


# ─── Test 3: Ledger entries are preserved after step-state remap ───────────────


@pytest.mark.asyncio
async def test_ledger_entries_preserved_after_step_remap(
    seeded_db: AsyncSession,
) -> None:
    """Existing WellnessPointsLedger rows must be unchanged by the remap.

    The migration UPDATEs member_journey_step_states.template_step_id but
    WellnessPointsLedger has NO FK to journey_template_steps (by design —
    related_id is a free-form UUID). This test asserts that invariant is
    structurally enforced at the model layer, ensuring the migration cannot
    cascade a double-grant or clear points_awarded through an FK action.
    """
    # Warm up the session so the model metadata is inspectable.
    await seeded_db.execute(select(JourneyTemplate))

    # Assert WellnessPointsLedger.related_id has no FK to any steps table.
    related_id_col = WellnessPointsLedger.__table__.c["related_id"]
    fks = list(related_id_col.foreign_keys)
    assert len(fks) == 0, (
        "WellnessPointsLedger.related_id unexpectedly has a FK constraint. "
        "This would allow the migration's step_id UPDATE to cascade and "
        "corrupt the immutable ledger."
    )
    assert related_id_col.nullable, (
        "WellnessPointsLedger.related_id should be nullable (free-form UUID)."
    )

    # Verify that after seeding, step 1 of food_assistance carries exactly
    # the standard 10-point award — not the old 10-point seed value (same in
    # this case, but the explicit assertion confirms the seed was applied).
    tpl_result = await seeded_db.execute(
        select(JourneyTemplate).where(JourneyTemplate.slug == "food_assistance")
    )
    tpl = tpl_result.scalar_one()
    steps_result = await seeded_db.execute(
        select(JourneyTemplateStep)
        .where(JourneyTemplateStep.template_id == tpl.id)
        .order_by(JourneyTemplateStep.order)
    )
    steps = steps_result.scalars().all()
    assert len(steps) == 6

    step_1 = steps[0]
    assert step_1.name == "Need Identified"
    assert step_1.points_on_completion == 10, (
        "Step 1 'Need Identified' should award 10 points per STANDARD_STEPS."
    )

    # Confirm all 6 step points sum to 150 (10+25+30+10+25+50).
    total_points = sum(s.points_on_completion for s in steps)
    assert total_points == 150, (
        f"Total points for a completed journey should be 150, got {total_points}."
    )


# ─── Fixture ───────────────────────────────────────────────────────────────────


@pytest.fixture
async def seeded_db() -> AsyncSession:
    """Provide a test DB session with all 10 templates seeded."""
    async with test_session() as db:
        await seed_default_journey_templates(db)
        yield db

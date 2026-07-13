"""Seed data for default JourneyTemplates.

Call ``seed_default_journey_templates(db)`` once at startup or from a
management script. The function is idempotent — it skips any template whose
slug already exists in the database.

All 10 templates share the same standardized 6-step roadmap defined in
``STANDARD_STEPS``. Point values are identical across all templates so that
the wellness-points system is consistent regardless of which pathway a member
is assigned to.

Templates included (10 total):
  Existing 4 (preserved slugs):
    - food_assistance
    - housing
    - mental_health
    - maternal_health
  New 6:
    - rent_payment_assistance
    - utility_support
    - calfresh_enrollment
    - healthcare_appointment
    - food_pantry
    - health_education
"""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.journeys import JourneyTemplate, JourneyTemplateStep

# ─── Standardized 6-step roadmap ───────────────────────────────────────────────
#
# Every template uses exactly these 6 steps, in this order, with these exact
# point values. The step names must not diverge — the frontend roadmap and the
# data migration in j0e1f2g3h4i5 both key on these exact strings.

STANDARD_STEPS: list[dict] = [
    {
        "order": 1,
        "name": "Need Identified",
        "description": "CHW confirms the member's active need for this pathway.",
        "points_on_completion": 10,
        "required_documents": [],
    },
    {
        "order": 2,
        "name": "Eligibility Screening",
        "description": "Member completes eligibility screening for the relevant program.",
        "points_on_completion": 25,
        "required_documents": [],
    },
    {
        "order": 3,
        "name": "Upload Documents",
        "description": "Member uploads required supporting documents.",
        "points_on_completion": 30,
        "required_documents": [],
    },
    {
        "order": 4,
        "name": "Follow Up",
        "description": "CHW follows up to confirm progress and next actions.",
        "points_on_completion": 10,
        "required_documents": [],
    },
    {
        "order": 5,
        "name": "Resource Connection",
        "description": "Member is connected to the appropriate resource or provider.",
        "points_on_completion": 25,
        "required_documents": [],
    },
    {
        "order": 6,
        "name": "Journey Complete",
        "description": "Member's need has been addressed. Journey closed.",
        "points_on_completion": 50,
        "required_documents": [],
    },
]

# ─── Template definitions ───────────────────────────────────────────────────────
#
# ``steps`` is intentionally omitted here — all templates use STANDARD_STEPS.
# Template-specific step descriptions can be added in a future enhancement
# without altering the canonical 6-step structure.

# Epic C5 note: these are pre-built JOURNEY TEMPLATES (a richer catalog than
# the 6-vertical resource-need taxonomy — e.g. "Rent Payment Assistance" and
# "Utility Support" both already exist as distinct housing-category templates
# below), listed unrestricted via GET /journeys/templates with no code-level
# "selectable verticals" gate (unlike CHWMemberProfileScreen's Resource Needs
# picker or the member request form). The 'housing' template slug is
# INTENTIONALLY preserved, not removed: a CHW manually assigning a pre-built
# journey pathway to a member is a distinct action from tagging a NEW resource
# need/vertical, and "Housing" (the pathway — eviction prevention, shelter
# placement, etc.) remains a legitimate, ongoing case type distinct from a
# utility-bill-assistance case. Utility-bill assistance is already covered by
# the existing "Utility Support" template below (category="housing", since
# utility assistance historically nested under the housing/economic template
# grouping) — no new template was added here because one already existed
# pre-Epic-C5 covering this need.
_TEMPLATES: list[dict] = [
    # ── Existing 4 (slugs preserved) ───────────────────────────────────────────
    {
        "slug": "food_assistance",
        "name": "Food Assistance",
        "category": "food",
        "icon": "utensils",
    },
    {
        "slug": "housing",
        "name": "Housing",
        "category": "housing",
        "icon": "home",
    },
    {
        "slug": "mental_health",
        "name": "Mental Health",
        "category": "mental_health",
        "icon": "brain",
    },
    {
        "slug": "maternal_health",
        "name": "Maternal Health",
        "category": "maternal_health",
        "icon": "baby",
    },
    # ── New 6 ───────────────────────────────────────────────────────────────────
    {
        "slug": "rent_payment_assistance",
        "name": "Rent Payment Assistance",
        "category": "housing",
        "icon": "building-2",
    },
    {
        "slug": "utility_support",
        "name": "Utility Support",
        "category": "housing",
        "icon": "zap",
    },
    {
        "slug": "calfresh_enrollment",
        "name": "CalFresh Enrollment",
        "category": "food",
        "icon": "shopping-basket",
    },
    {
        "slug": "healthcare_appointment",
        "name": "Healthcare Appointment",
        "category": "health",
        "icon": "stethoscope",
    },
    {
        "slug": "food_pantry",
        "name": "Food Pantry",
        "category": "food",
        "icon": "package",
    },
    {
        "slug": "health_education",
        "name": "Health Education",
        "category": "health",
        "icon": "book-open",
    },
]


async def seed_default_journey_templates(db: AsyncSession) -> None:
    """Create all 10 default JourneyTemplates if they do not already exist.

    Idempotent: any template whose slug is already present in the database is
    skipped entirely. This makes the function safe to call at application
    startup or from a management script without duplicating data.

    All seeded templates receive the standardized 6-step roadmap from
    ``STANDARD_STEPS``. The Alembic migration j0e1f2g3h4i5 handles remapping
    existing MemberJourneyStepState rows for the original 4 templates — this
    seed function only creates new rows for slugs not yet present.

    Args:
        db: An active async database session. The caller is responsible for
            committing the transaction after this function returns.
    """
    for template_def in _TEMPLATES:
        # Guard: skip if the template already exists by slug.
        existing_result = await db.execute(
            select(JourneyTemplate).where(JourneyTemplate.slug == template_def["slug"])
        )
        existing = existing_result.scalar_one_or_none()
        if existing is not None:
            continue

        template = JourneyTemplate(
            id=uuid.uuid4(),
            slug=template_def["slug"],
            name=template_def["name"],
            category=template_def["category"],
            icon=template_def["icon"],
        )
        db.add(template)
        # Flush to obtain the PK before creating child step rows.
        await db.flush()

        for step_def in STANDARD_STEPS:
            step = JourneyTemplateStep(
                id=uuid.uuid4(),
                template_id=template.id,
                order=step_def["order"],
                name=step_def["name"],
                description=step_def["description"],
                points_on_completion=step_def["points_on_completion"],
                required_documents=step_def["required_documents"],
            )
            db.add(step)

    await db.commit()

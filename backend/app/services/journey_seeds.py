"""Seed data for default JourneyTemplates.

Call ``seed_default_journey_templates(db)`` once at startup or from a
management script. The function is idempotent — it skips any template whose
slug already exists in the database.

Templates included:
  - food_assistance  (6 steps)
  - housing          (6 steps)
  - mental_health    (6 steps)
  - maternal_health  (5 steps)
"""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.journeys import JourneyTemplate, JourneyTemplateStep

# ─── Seed definitions ──────────────────────────────────────────────────────────

_TEMPLATES: list[dict] = [
    {
        "slug": "food_assistance",
        "name": "Food Assistance",
        "category": "food",
        "icon": "utensils",
        "steps": [
            {
                "order": 1,
                "name": "Need Identified",
                "description": "CHW confirms the member has an active food-security need.",
                "points_on_completion": 10,
                "required_documents": [],
            },
            {
                "order": 2,
                "name": "Eligibility Screening",
                "description": "Member completes CalFresh/SNAP eligibility screening.",
                "points_on_completion": 15,
                "required_documents": [],
            },
            {
                "order": 3,
                "name": "Upload Documents",
                "description": "Member uploads proof of income and residency.",
                "points_on_completion": 20,
                "required_documents": ["proof_of_income", "proof_of_residency"],
            },
            {
                "order": 4,
                "name": "Follow Up",
                "description": "CHW follows up to confirm application was submitted.",
                "points_on_completion": 10,
                "required_documents": [],
            },
            {
                "order": 5,
                "name": "Resource Connection",
                "description": "Member connected to a local food bank or CalFresh benefits.",
                "points_on_completion": 25,
                "required_documents": [],
            },
            {
                "order": 6,
                "name": "Journey Complete",
                "description": "Member has consistent food access. Journey closed.",
                "points_on_completion": 50,
                "required_documents": [],
            },
        ],
    },
    {
        "slug": "housing",
        "name": "Housing",
        "category": "housing",
        "icon": "home",
        "steps": [
            {
                "order": 1,
                "name": "Need Identified",
                "description": "CHW confirms the member has an active housing need.",
                "points_on_completion": 10,
                "required_documents": [],
            },
            {
                "order": 2,
                "name": "Eligibility Screening",
                "description": "Member completes screening for housing assistance programs.",
                "points_on_completion": 15,
                "required_documents": [],
            },
            {
                "order": 3,
                "name": "Application",
                "description": "Member submits housing assistance application.",
                "points_on_completion": 20,
                "required_documents": [],
            },
            {
                "order": 4,
                "name": "Documents Uploaded",
                "description": "Member uploads ID, income verification, and lease documents.",
                "points_on_completion": 20,
                "required_documents": ["photo_id", "proof_of_income", "current_lease"],
            },
            {
                "order": 5,
                "name": "Application Submitted",
                "description": "CHW confirms the application has been formally submitted.",
                "points_on_completion": 15,
                "required_documents": [],
            },
            {
                "order": 6,
                "name": "Placed",
                "description": "Member secured stable housing. Journey closed.",
                "points_on_completion": 50,
                "required_documents": [],
            },
        ],
    },
    {
        "slug": "mental_health",
        "name": "Mental Health",
        "category": "mental_health",
        "icon": "brain",
        "steps": [
            {
                "order": 1,
                "name": "Need Identified",
                "description": "CHW identifies member's mental health support need.",
                "points_on_completion": 10,
                "required_documents": [],
            },
            {
                "order": 2,
                "name": "Screened",
                "description": "Member completes PHQ-9 / GAD-7 initial screening.",
                "points_on_completion": 15,
                "required_documents": [],
            },
            {
                "order": 3,
                "name": "Referred",
                "description": "CHW refers member to a licensed mental health provider.",
                "points_on_completion": 15,
                "required_documents": [],
            },
            {
                "order": 4,
                "name": "Intake Completed",
                "description": "Member completes intake appointment with the provider.",
                "points_on_completion": 25,
                "required_documents": [],
            },
            {
                "order": 5,
                "name": "First Session",
                "description": "Member attends first therapy or counseling session.",
                "points_on_completion": 30,
                "required_documents": [],
            },
            {
                "order": 6,
                "name": "Engaged in Care",
                "description": "Member is consistently attending care. Journey closed.",
                "points_on_completion": 50,
                "required_documents": [],
            },
        ],
    },
    {
        "slug": "maternal_health",
        "name": "Maternal Health",
        "category": "maternal_health",
        "icon": "baby",
        "steps": [
            {
                "order": 1,
                "name": "Need Identified",
                "description": "CHW identifies maternal health support need.",
                "points_on_completion": 10,
                "required_documents": [],
            },
            {
                "order": 2,
                "name": "Provider Match",
                "description": "Member matched with an OB/GYN or midwife accepting Medi-Cal.",
                "points_on_completion": 20,
                "required_documents": [],
            },
            {
                "order": 3,
                "name": "First Visit",
                "description": "Member attends first prenatal or postpartum visit.",
                "points_on_completion": 30,
                "required_documents": [],
            },
            {
                "order": 4,
                "name": "WIC Enrolled",
                "description": "Member enrolled in WIC for nutritional support.",
                "points_on_completion": 20,
                "required_documents": ["proof_of_pregnancy_or_postpartum"],
            },
            {
                "order": 5,
                "name": "Engaged in Care",
                "description": "Member is consistently attending prenatal/postpartum care. Journey closed.",
                "points_on_completion": 50,
                "required_documents": [],
            },
        ],
    },
]


async def seed_default_journey_templates(db: AsyncSession) -> None:
    """Create the four default JourneyTemplates if they do not already exist.

    Idempotent: any template whose slug is already present in the database is
    skipped entirely. This makes the function safe to call at application
    startup or from a management script without duplicating data.

    Args:
        db: An active async database session. The caller is responsible for
            committing the transaction after this function returns.
    """
    for template_def in _TEMPLATES:
        # Check if the template already exists by slug.
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

        for step_def in template_def["steps"]:
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

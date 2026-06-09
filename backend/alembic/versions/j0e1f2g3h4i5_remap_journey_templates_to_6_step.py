"""Remap all JourneyTemplate steps to the standardized 6-step roadmap and
seed 6 new templates.

Revision ID: j0e1f2g3h4i5
Revises:     i9d0e1f2g3h4
Create Date: 2026-06-08

Overview
--------
The cofounders standardized all care-pathway templates onto one 6-step
roadmap:

  1. Need Identified        (+10 pts)
  2. Eligibility Screening  (+25 pts)
  3. Upload Documents       (+30 pts)
  4. Follow Up              (+10 pts)
  5. Resource Connection    (+25 pts)
  6. Journey Complete       (+50 pts)

The 4 existing templates (food_assistance, housing, mental_health,
maternal_health) already had some of these step names but used different
names, orderings, and point values. This migration:

  1. For each existing template:
     a. Inserts 6 new JourneyTemplateStep rows using the standardized names +
        points.
     b. Remaps every MemberJourneyStepState.template_step_id from the old
        step UUID to the corresponding new step UUID.
     c. Recomputes MemberJourney.current_step_id for any journey whose
        current_step_id pointed at a now-deleted old step.
     d. Deletes the old JourneyTemplateStep rows.

  2. Inserts 6 new JourneyTemplate rows (rent_payment_assistance,
     utility_support, calfresh_enrollment, healthcare_appointment,
     food_pantry, health_education) each with the same 6 standard steps.

Step-name remap rationale
-------------------------
food_assistance (was 6 steps, already mostly aligned):
  "Need Identified"      → "Need Identified"        (exact match)
  "Eligibility Screening"→ "Eligibility Screening"  (exact match)
  "Upload Documents"     → "Upload Documents"        (exact match)
  "Follow Up"            → "Follow Up"               (exact match)
  "Resource Connection"  → "Resource Connection"     (exact match)
  "Journey Complete"     → "Journey Complete"        (exact match)

housing (was 6 steps):
  "Need Identified"      → "Need Identified"
  "Eligibility Screening"→ "Eligibility Screening"
  "Application"          → "Upload Documents"   (app phase overlaps doc upload)
  "Documents Uploaded"   → "Follow Up"          (docs submitted = follow-up gate)
  "Application Submitted"→ "Resource Connection"(submitted = resource connected)
  "Placed"               → "Journey Complete"

mental_health (was 6 steps):
  "Need Identified"      → "Need Identified"
  "Screened"             → "Eligibility Screening"  (PHQ-9/GAD-7 = screening)
  "Referred"             → "Upload Documents"        (referral paperwork/docs)
  "Intake Completed"     → "Follow Up"               (intake = first follow-up)
  "First Session"        → "Resource Connection"     (first session = connected)
  "Engaged in Care"      → "Journey Complete"

maternal_health (was 5 steps — 6th step synthesized):
  "Need Identified"      → "Need Identified"
  "Provider Match"       → "Eligibility Screening"  (matching = screening step)
  "First Visit"          → "Upload Documents"        (visit prep / docs)
  "WIC Enrolled"         → "Follow Up"               (enrollment confirmation)
  "Engaged in Care"      → "Resource Connection"    (engaged = resource connected)
  (no 6th step existed)  → "Journey Complete"       (new row, no states to remap)

One-way migration
-----------------
``downgrade()`` raises NotImplementedError. The old step names and custom
point values are permanently replaced. Take an RDS snapshot before applying.
"""

from __future__ import annotations

import uuid
from typing import Any

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "j0e1f2g3h4i5"
down_revision: str = "i9d0e1f2g3h4"
branch_labels = None
depends_on = None

# ─── Standardized step definitions (order → attrs) ────────────────────────────
# Must stay in sync with app/services/journey_seeds.py::STANDARD_STEPS.

_STANDARD_STEPS: list[dict[str, Any]] = [
    {"order": 1, "name": "Need Identified",       "points": 10},
    {"order": 2, "name": "Eligibility Screening", "points": 25},
    {"order": 3, "name": "Upload Documents",      "points": 30},
    {"order": 4, "name": "Follow Up",             "points": 10},
    {"order": 5, "name": "Resource Connection",   "points": 25},
    {"order": 6, "name": "Journey Complete",      "points": 50},
]

# ─── Per-template old-step → new-step-order mapping ───────────────────────────
# Key:   old step name (exactly as stored in the DB from the original seed).
# Value: the ``order`` integer in _STANDARD_STEPS that this old step maps to.
#
# Steps with no surviving MemberJourneyStepState rows (i.e., the template's
# 6th step that didn't exist in maternal_health) have no mapping entry — they
# are simply inserted as new rows with no state migration needed.

_REMAP: dict[str, dict[str, int]] = {
    # food_assistance — exact match across all 6 steps
    "food_assistance": {
        "Need Identified":       1,  # exact match
        "Eligibility Screening": 2,  # exact match
        "Upload Documents":      3,  # exact match
        "Follow Up":             4,  # exact match
        "Resource Connection":   5,  # exact match
        "Journey Complete":      6,  # exact match
    },
    # housing — 6 old steps
    "housing": {
        "Need Identified":       1,  # exact match
        "Eligibility Screening": 2,  # exact match
        "Application":           3,  # application phase → upload documents step
        "Documents Uploaded":    4,  # docs submitted → follow up gate
        "Application Submitted": 5,  # formally submitted → resource connection
        "Placed":                6,  # stable housing secured → journey complete
    },
    # mental_health — 6 old steps
    "mental_health": {
        "Need Identified":  1,  # exact match
        "Screened":         2,  # PHQ-9/GAD-7 screening → eligibility screening
        "Referred":         3,  # referral paperwork/docs → upload documents
        "Intake Completed": 4,  # intake appointment → follow up
        "First Session":    5,  # first therapy session → resource connection
        "Engaged in Care":  6,  # consistent attendance → journey complete
    },
    # maternal_health — 5 old steps (no old step maps to order=6)
    "maternal_health": {
        "Need Identified": 1,  # exact match
        "Provider Match":  2,  # OB/GYN matching → eligibility screening
        "First Visit":     3,  # prenatal visit prep/docs → upload documents
        "WIC Enrolled":    4,  # WIC enrollment confirmation → follow up
        "Engaged in Care": 5,  # consistent prenatal care → resource connection
        # No old step → order=6 ("Journey Complete"); new row, no state to remap.
    },
}

# ─── New templates to seed (6 new, same standard steps) ───────────────────────

_NEW_TEMPLATES: list[dict[str, str]] = [
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


def upgrade() -> None:
    """Apply the standardized 6-step remapping and seed 6 new templates.

    Execution order:
      1. Remap each of the 4 existing templates in isolation:
         a. Fetch the template_id by slug.
         b. Insert 6 new JourneyTemplateStep rows (new UUIDs).
         c. Build an old_step_id → new_step_id lookup from the DB.
         d. UPDATE MemberJourneyStepState rows to new step IDs.
         e. UPDATE MemberJourney.current_step_id for journeys whose pointer
            now targets a deleted step.
         f. DELETE the old JourneyTemplateStep rows.
      2. INSERT 6 new JourneyTemplate rows + their standard steps.
    """
    conn = op.get_bind()

    for slug, name_to_order in _REMAP.items():
        # ── 1a. Fetch existing template_id ────────────────────────────────────
        row = conn.execute(
            sa.text("SELECT id FROM journey_templates WHERE slug = :slug"),
            {"slug": slug},
        ).fetchone()
        if row is None:
            # Template not present in this DB (e.g., partial seed). Skip.
            continue
        template_id: str = str(row[0])

        # ── 1b. Fetch old steps for this template ─────────────────────────────
        old_steps = conn.execute(
            sa.text(
                "SELECT id, name FROM journey_template_steps "
                "WHERE template_id = :tid ORDER BY \"order\""
            ),
            {"tid": template_id},
        ).fetchall()
        # Build: old_step_name → old_step_id
        old_name_to_id: dict[str, str] = {
            row[1]: str(row[0]) for row in old_steps
        }

        # ── 1c. Insert 6 new standardized steps ───────────────────────────────
        # new_order → new_step_id (UUID str)
        # Note: required_documents inlined as '[]'::jsonb literal — using a bind
        # param with `::jsonb` (e.g. `:docs::jsonb`) collides with SQLAlchemy's
        # `::` cast operator parsing and yields "syntax error at or near :".
        new_order_to_id: dict[int, str] = {}
        for step_def in _STANDARD_STEPS:
            new_step_id = str(uuid.uuid4())
            new_order_to_id[step_def["order"]] = new_step_id
            conn.execute(
                sa.text(
                    "INSERT INTO journey_template_steps "
                    "(id, template_id, \"order\", name, description, "
                    " points_on_completion, required_documents) "
                    "VALUES (:id, :tid, :ord, :name, :desc, :pts, '[]'::jsonb)"
                ),
                {
                    "id": new_step_id,
                    "tid": template_id,
                    "ord": step_def["order"],
                    "name": step_def["name"],
                    "desc": "",
                    "pts": step_def["points"],
                },
            )

        # ── 1d. Build old_step_id → new_step_id remap pairs ──────────────────
        remap_pairs: list[tuple[str, str]] = []  # (old_id, new_id)
        for old_name, new_order in name_to_order.items():
            old_id = old_name_to_id.get(old_name)
            if old_id is None:
                # Old step name not found in DB (already remapped or seed
                # was never applied). Safe to skip.
                continue
            new_id = new_order_to_id[new_order]
            remap_pairs.append((old_id, new_id))

        # ── 1e. UPDATE MemberJourneyStepState rows ────────────────────────────
        for old_id, new_id in remap_pairs:
            conn.execute(
                sa.text(
                    "UPDATE member_journey_step_states "
                    "SET template_step_id = :new_id "
                    "WHERE template_step_id = :old_id"
                ),
                {"new_id": new_id, "old_id": old_id},
            )

        # ── 1f. UPDATE MemberJourney.current_step_id ──────────────────────────
        # Any journey whose current_step_id still points at an old step ID must
        # be advanced to the corresponding new step ID. We use the same
        # remap_pairs table — current_step_id is always a template_step_id.
        for old_id, new_id in remap_pairs:
            conn.execute(
                sa.text(
                    "UPDATE member_journeys "
                    "SET current_step_id = :new_id "
                    "WHERE current_step_id = :old_id"
                ),
                {"new_id": new_id, "old_id": old_id},
            )

        # ── 1g. DELETE old JourneyTemplateStep rows ───────────────────────────
        # Safe to delete now: all FK references in member_journey_step_states
        # and member_journeys have been updated to the new step IDs above.
        for old_id in old_name_to_id.values():
            conn.execute(
                sa.text(
                    "DELETE FROM journey_template_steps WHERE id = :id"
                ),
                {"id": old_id},
            )

    # ── 2. Seed 6 new templates ────────────────────────────────────────────────
    for tpl_def in _NEW_TEMPLATES:
        # Guard: skip if the template was already inserted by a prior partial run.
        exists = conn.execute(
            sa.text(
                "SELECT 1 FROM journey_templates WHERE slug = :slug LIMIT 1"
            ),
            {"slug": tpl_def["slug"]},
        ).fetchone()
        if exists:
            continue

        new_template_id = str(uuid.uuid4())
        conn.execute(
            sa.text(
                "INSERT INTO journey_templates (id, slug, name, category, icon) "
                "VALUES (:id, :slug, :name, :category, :icon)"
            ),
            {
                "id": new_template_id,
                "slug": tpl_def["slug"],
                "name": tpl_def["name"],
                "category": tpl_def["category"],
                "icon": tpl_def["icon"],
            },
        )
        for step_def in _STANDARD_STEPS:
            conn.execute(
                sa.text(
                    "INSERT INTO journey_template_steps "
                    "(id, template_id, \"order\", name, description, "
                    " points_on_completion, required_documents) "
                    "VALUES (:id, :tid, :ord, :name, :desc, :pts, '[]'::jsonb)"
                ),
                {
                    "id": str(uuid.uuid4()),
                    "tid": new_template_id,
                    "ord": step_def["order"],
                    "name": step_def["name"],
                    "desc": "",
                    "pts": step_def["points"],
                },
            )


def downgrade() -> None:
    """One-way migration — downgrade is not supported.

    The old step names and point-value schema have been permanently replaced.
    To restore to the previous state, apply the RDS snapshot taken immediately
    before this migration was run.
    """
    raise NotImplementedError(
        "j0e1f2g3h4i5 is a one-way data migration. "
        "Restore from the RDS snapshot taken before this migration was applied."
    )

"""Journey↔resource-need reconciliation service.

Keeps a member's active MemberJourney rows in 1:1 correspondence with their
stated resource needs. Exposed entry points:

  RESOURCE_NEED_LABELS  — canonical slug→label map for the 5 tracked needs.
  get_or_create_canonical_template — find or create a JourneyTemplate by label.
  create_journey_for_template      — shared low-level journey-creation helper.
  reconcile_member_journeys_to_needs — main reconciliation entry point.

Design notes:
  - Never deletes journeys; archives via status='abandoned'.
  - Preserves progress: when an active journey already exists for a need, the
    one with the most completed steps is kept (earliest created_at as tie-breaker).
  - Idempotent: calling twice with the same need_slugs produces no new journeys
    and no status churn.
  - Does NOT touch journeys with status 'completed' or 'paused'.
  - Callers own the transaction boundary — this module flushes but never commits.
"""

from __future__ import annotations

import re
import uuid
from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.journeys import (
    JourneyTemplate,
    JourneyTemplateStep,
    MemberJourney,
    MemberJourneyStepState,
)
from app.services.journey_seeds import STANDARD_STEPS

# ── Canonical resource-need slug → journey template label ─────────────────────
#
# Epic C5: 'housing' is GRANDFATHERED here, not removed. This map drives
# reconcile_member_journeys_to_needs, which is invoked on every resource-needs
# save (PATCH /chw/members/{id}/resource-needs) — including a legacy save that
# still carries 'housing' in its needs list (see schemas/chw.py
# _RESOURCE_NEED_VALUES for why that value keeps round-tripping). Dropping
# 'housing' here would cause reconcile_member_journeys_to_needs to silently
# drop it from target_labels (it's filtered out by "if slug in
# RESOURCE_NEED_LABELS"), which would ABANDON the member's existing Housing
# journey on their very next unrelated resource-needs edit — exactly the kind
# of silent data loss grandfathering is meant to prevent. 'utilities' is added
# as the new canonical mapping for the replacement vertical.
RESOURCE_NEED_LABELS: dict[str, str] = {
    "housing": "Housing",
    "utilities": "Utilities",
    "transportation": "Transportation",
    "food": "Food Security",
    "mental_health": "Mental Health",
    "healthcare": "Healthcare",
    "employment": "Employment",
}

# Pre-computed slug and (category, icon) for each canonical label so we avoid
# re-deriving them at runtime.  Unknown labels fall back to _slugify + defaults.
_LABEL_TO_SLUG: dict[str, str] = {
    "Housing": "housing",
    "Utilities": "utilities",
    "Transportation": "transportation",
    "Food Security": "food_security",
    "Mental Health": "mental_health",
    "Healthcare": "healthcare",
    "Employment": "employment",
}

_LABEL_TO_CATEGORY_ICON: dict[str, tuple[str, str]] = {
    "Housing": ("housing", "home"),
    "Utilities": ("utilities", "zap"),
    "Transportation": ("transportation", "bus"),
    "Food Security": ("food", "utensils"),
    "Mental Health": ("mental_health", "brain"),
    "Healthcare": ("health", "stethoscope"),
    "Employment": ("employment", "briefcase"),
}


# ── Internal utilities ────────────────────────────────────────────────────────


def _slugify(label: str) -> str:
    """Convert a human-readable label to a lowercase underscore slug.

    Example: "Rehab & Recovery" → "rehab_recovery"
    """
    slug = label.lower()
    slug = re.sub(r"[&\s]+", "_", slug)
    slug = re.sub(r"[^a-z0-9_]", "", slug)
    return slug.strip("_")


# ── Public helpers ────────────────────────────────────────────────────────────


async def get_or_create_canonical_template(
    db: AsyncSession,
    label: str,
) -> JourneyTemplate:
    """Return an active JourneyTemplate whose name == label, creating it if absent.

    If no active template with the given name exists, one is created with:
      - is_custom=False, is_active=True
      - slug derived from _LABEL_TO_SLUG (falls back to _slugify for unknowns)
      - category and icon from _LABEL_TO_CATEGORY_ICON (defaults "general"/"circle")
      - the 6 standard steps from STANDARD_STEPS (orders 1–6, canonical points)

    The new template is flushed so its id is available immediately.

    Args:
        db: An active async database session.
        label: Exact template name to look up or create (e.g. "Transportation").

    Returns:
        A JourneyTemplate (existing or newly flushed) whose name matches label.
    """
    # NOTE: use .first() (not scalar_one_or_none) — production data can hold more
    # than one active template with the same name (accumulated across seeds /
    # migrations / concurrent on-demand creation). scalar_one_or_none() would
    # raise MultipleResultsFound → an unhandled 500 that, on web, surfaces only as
    # "Failed to fetch" (the 500 is generated outside CORSMiddleware, so the
    # browser never sees the real error). See backend/TESTING.md rule #2.
    # Deterministic tie-break: oldest active template wins.
    result = await db.execute(
        select(JourneyTemplate)
        .where(JourneyTemplate.name == label)
        .where(JourneyTemplate.is_active.is_(True))
        .order_by(JourneyTemplate.created_at)
    )
    template = result.scalars().first()
    if template is not None:
        # Heal legacy/partially-seeded templates that have no steps. Without this,
        # create_journey_for_template raises ValueError("...has no steps...") →
        # another unhandled 500 on the resource-needs save.
        await _ensure_template_has_steps(db, template)
        return template

    slug = _LABEL_TO_SLUG.get(label, _slugify(label))
    category, icon = _LABEL_TO_CATEGORY_ICON.get(label, ("general", "circle"))

    template = JourneyTemplate(
        id=uuid.uuid4(),
        slug=slug,
        name=label,
        category=category,
        icon=icon,
        is_custom=False,
        is_active=True,
    )
    db.add(template)
    await db.flush()  # populate id before FK references in step rows

    for step_def in STANDARD_STEPS:
        db.add(
            JourneyTemplateStep(
                id=uuid.uuid4(),
                template_id=template.id,
                order=step_def["order"],
                name=step_def["name"],
                description=step_def["description"],
                points_on_completion=step_def["points_on_completion"],
                required_documents=step_def["required_documents"],
            )
        )

    await db.flush()
    return template


async def _ensure_template_has_steps(
    db: AsyncSession,
    template: JourneyTemplate,
) -> None:
    """Backfill the canonical STANDARD_STEPS for a template that has none.

    A canonical (non-custom) JourneyTemplate is expected to carry the 6 standard
    steps. Legacy rows, partial seeds, or older creation paths can leave a
    template with zero steps; instantiating a member journey from such a template
    raises ValueError in ``create_journey_for_template`` and 500s the caller.

    This heal is idempotent: it inserts steps only when the template currently has
    none, and flushes so the new rows are visible to the subsequent journey
    creation in the same transaction.

    Args:
        db: An active async database session.
        template: The (active, canonical) template to verify/heal.
    """
    step_count = await db.scalar(
        select(func.count())
        .select_from(JourneyTemplateStep)
        .where(JourneyTemplateStep.template_id == template.id)
    )
    if step_count and step_count > 0:
        return

    for step_def in STANDARD_STEPS:
        db.add(
            JourneyTemplateStep(
                id=uuid.uuid4(),
                template_id=template.id,
                order=step_def["order"],
                name=step_def["name"],
                description=step_def["description"],
                points_on_completion=step_def["points_on_completion"],
                required_documents=step_def["required_documents"],
            )
        )
    await db.flush()


async def create_journey_for_template(
    db: AsyncSession,
    member_id: uuid.UUID,
    chw_id: uuid.UUID,
    template: JourneyTemplate,
) -> MemberJourney:
    """Create and flush a MemberJourney + per-step states for the given template.

    This is the shared low-level helper used by both the journey-creation API
    handler (``create_member_journey``) and the reconciler.  It does NOT commit,
    check for duplicate active journeys, or validate authorization — those are
    the caller's responsibility.

    Step 1 starts as 'in_progress'; all subsequent steps start as 'upcoming'.
    ``current_step_id`` is set to the first step.

    Args:
        db: An active async database session.
        member_id: UUID of the member to assign the journey to.
        chw_id: UUID of the CHW creating or owning the journey.
        template: The JourneyTemplate to instantiate.

    Returns:
        The newly created MemberJourney (flushed, with id populated).

    Raises:
        ValueError: If the template has no steps configured.
    """
    steps_result = await db.execute(
        select(JourneyTemplateStep)
        .where(JourneyTemplateStep.template_id == template.id)
        .order_by(JourneyTemplateStep.order)
    )
    template_steps = steps_result.scalars().all()
    if not template_steps:
        raise ValueError(
            f"Journey template '{template.name}' (id={template.id}) has no steps configured."
        )

    now = datetime.now(UTC)
    first_step = template_steps[0]

    member_journey = MemberJourney(
        id=uuid.uuid4(),
        member_id=member_id,
        template_id=template.id,
        chw_id=chw_id,
        status="active",
        started_at=now,
        current_step_id=first_step.id,
    )
    db.add(member_journey)
    await db.flush()  # populate member_journey.id before step FK references

    for i, tpl_step in enumerate(template_steps):
        db.add(
            MemberJourneyStepState(
                id=uuid.uuid4(),
                member_journey_id=member_journey.id,
                template_step_id=tpl_step.id,
                status="in_progress" if i == 0 else "upcoming",
                started_at=now if i == 0 else None,
            )
        )

    await db.flush()
    return member_journey


# ── Main reconciliation entry point ──────────────────────────────────────────


async def reconcile_member_journeys_to_needs(
    db: AsyncSession,
    member_id: uuid.UUID,
    need_slugs: list[str],
    chw_id: uuid.UUID | None = None,
) -> None:
    """Synchronise a member's active journeys to their stated resource needs.

    For each slug in need_slugs (in given order):
      - Resolve the canonical template label from RESOURCE_NEED_LABELS.  Unknown
        slugs are silently dropped — they have no corresponding template.
      - Find active journey(s) for that template label:
          * ≥1 found  → keep the BEST one (most completed steps; earliest
            created_at as tie-breaker); set all other duplicates to 'abandoned'.
          * 0 found   → call get_or_create_canonical_template then
            create_journey_for_template to provision a fresh journey.

    After the per-need loop, every remaining active journey whose template name
    is NOT in the target label set is set to 'abandoned' (orphans, extra
    duplicates already abandoned in the inner pass are untouched).

    Idempotent guarantee: calling twice with identical need_slugs makes no
    further changes — no new journeys are created, no statuses are churned.

    This function does NOT touch journeys with status 'completed' or 'paused'.
    All changes are flushed but NOT committed; the caller owns the transaction.

    Args:
        db: An active async database session.
        member_id: UUID of the member whose journeys to reconcile.
        need_slugs: Ordered list of resource-need slugs (e.g. ["transportation", "housing"]).
        chw_id: UUID of the CHW to assign to newly created journeys.  If None,
            the member's most recent CHW is looked up from their Session /
            ServiceRequest history.  If no CHW is found, new-journey creation
            is silently skipped for that need.
    """
    # Resolve slugs → labels, dropping unknowns.
    target_labels: list[str] = [
        RESOURCE_NEED_LABELS[slug]
        for slug in need_slugs
        if slug in RESOURCE_NEED_LABELS
    ]
    target_label_set: set[str] = set(target_labels)

    # Load all currently active journeys + their templates in a single query.
    active_result = await db.execute(
        select(MemberJourney, JourneyTemplate)
        .join(JourneyTemplate, MemberJourney.template_id == JourneyTemplate.id)
        .where(MemberJourney.member_id == member_id)
        .where(MemberJourney.status == "active")
    )
    active_rows = active_result.all()

    # Group ALL active journeys by template name — including custom ones. Two
    # journeys that DISPLAY the same name (e.g. a canonical "Employment" plus a
    # custom journey a CHW also named "Employment") are duplicates to the member
    # and must be consolidated, so they are grouped together here.
    by_name: dict[str, list[MemberJourney]] = {}
    for journey, template in active_rows:
        by_name.setdefault(template.name, []).append(journey)

    # Resolve CHW once; used only when we need to create a new journey.
    resolved_chw_id: uuid.UUID | None = chw_id or await _lookup_member_chw(db, member_id)

    canonical_labels: set[str] = set(RESOURCE_NEED_LABELS.values())
    kept_ids: set[uuid.UUID] = set()

    # 1. Collapse every name to a single survivor — abandon the rest. This is the
    #    core "no copies" guarantee: at most one active journey per name.
    survivor_by_name: dict[str, MemberJourney] = {}
    for name, journeys in by_name.items():
        if len(journeys) > 1:
            ranked = await _rank_journeys_by_progress(db, journeys)
            survivor_by_name[name] = ranked[0]
            for duplicate in ranked[1:]:
                duplicate.status = "abandoned"
        else:
            survivor_by_name[name] = journeys[0]

    # 2. Ensure a journey exists for each selected need; mark survivors as kept.
    for label in target_labels:
        survivor = survivor_by_name.get(label)
        if survivor is not None:
            kept_ids.add(survivor.id)
        elif resolved_chw_id is not None:
            template_obj = await get_or_create_canonical_template(db, label)
            new_journey = await create_journey_for_template(
                db, member_id, resolved_chw_id, template_obj
            )
            kept_ids.add(new_journey.id)

    # 3. Abandon survivors that are canonical-named but not a current need
    #    (orphans). A true custom need — a custom name that is NOT one of the
    #    fixed-need labels — is always preserved; only canonical names (and custom
    #    journeys masquerading as a fixed need) are auto-managed here.
    for name, survivor in survivor_by_name.items():
        if survivor.id in kept_ids:
            continue
        if name in canonical_labels and name not in target_label_set:
            survivor.status = "abandoned"

    await db.flush()


# ── Internal helpers ──────────────────────────────────────────────────────────


async def _rank_journeys_by_progress(
    db: AsyncSession,
    journeys: list[MemberJourney],
) -> list[MemberJourney]:
    """Return journeys sorted by (completed_step_count DESC, created_at ASC).

    The first element is the canonical "best" journey to keep: most progress,
    oldest on ties.

    Args:
        db: An active async database session.
        journeys: Non-empty list of MemberJourney objects to rank.

    Returns:
        A new list with the same journey objects in ranked order.
    """
    journey_ids = [j.id for j in journeys]

    counts_result = await db.execute(
        select(
            MemberJourneyStepState.member_journey_id,
            func.count().label("completed_count"),
        )
        .where(MemberJourneyStepState.member_journey_id.in_(journey_ids))
        .where(MemberJourneyStepState.status == "completed")
        .group_by(MemberJourneyStepState.member_journey_id)
    )
    count_map: dict[uuid.UUID, int] = {row[0]: row[1] for row in counts_result.all()}

    return sorted(
        journeys,
        key=lambda j: (-count_map.get(j.id, 0), j.created_at),
    )


async def _lookup_member_chw(
    db: AsyncSession,
    member_id: uuid.UUID,
) -> uuid.UUID | None:
    """Return the id of the most recent CHW associated with this member.

    Checks Session rows first (most authoritative), then matched ServiceRequests.

    Args:
        db: An active async database session.
        member_id: UUID of the member to look up.

    Returns:
        The CHW's UUID, or None if no CHW relationship exists.
    """
    # Deferred imports avoid circular-import risk at module load time.
    from app.models.request import ServiceRequest
    from app.models.session import Session as CHWSession

    session_result = await db.execute(
        select(CHWSession.chw_id)
        .where(CHWSession.member_id == member_id)
        .order_by(CHWSession.created_at.desc())
        .limit(1)
    )
    chw_id = session_result.scalar_one_or_none()
    if chw_id is not None:
        return chw_id

    sr_result = await db.execute(
        select(ServiceRequest.matched_chw_id)
        .where(ServiceRequest.member_id == member_id)
        .where(ServiceRequest.matched_chw_id.is_not(None))
        .order_by(ServiceRequest.created_at.desc())
        .limit(1)
    )
    return sr_result.scalar_one_or_none()

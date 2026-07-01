"""Integration tests for journey↔resource-need reconciliation.

Tests the reconcile_member_journeys_to_needs service as exercised through the
PATCH /api/v1/chw/members/{member_id}/resource-needs endpoint.

Coverage:
  1. New needs with no existing journeys → exact 2 active journeys created.
  2. Pre-existing journey with 2 completed steps is KEPT (same id, progress intact).
  3. Duplicate active journeys for the same template → best kept, other abandoned.
  4. Active journey for a template NOT in the needs set → abandoned after reconcile.
  5. Idempotency: calling the endpoint twice with identical needs → stable journey
     set (same ids, no new rows).

TDD checklist (backend/TESTING.md):
  1. Negative auth — inherited from existing resource-need tests (403 without CHW
     relationship).  Not duplicated here.
  2. Invariant-violation state — duplicate-active test (case 3) seeds the
     violating state and asserts no 500 and correct dedup.
  3. No unhandled 500s — all happy-path tests exercise the new reconcile code path.
  4. Post-failure / post-retry DB state — idempotency test (case 5) asserts no
     orphan rows on repeated identical calls.
"""

from __future__ import annotations

import base64
import json
import uuid
from datetime import UTC, datetime

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select

from app.models.journeys import (
    JourneyTemplate,
    JourneyTemplateStep,
    MemberJourney,
    MemberJourneyStepState,
)
from app.services.journey_seeds import STANDARD_STEPS
from tests.conftest import auth_header, test_session


# ── Shared helpers ────────────────────────────────────────────────────────────


def _decode_jwt_sub(access_token: str) -> str:
    """Extract the 'sub' claim (user UUID string) from a JWT access token."""
    segment = access_token.split(".")[1]
    padded = segment + "=" * (4 - len(segment) % 4)
    return json.loads(base64.urlsafe_b64decode(padded))["sub"]


async def _register_user(client: AsyncClient, email: str, role: str, name: str) -> dict:
    """Register a user and return the token payload."""
    payload: dict = {
        "email": email,
        "password": "testpass123",
        "name": name,
        "role": role,
    }
    if role == "member":
        payload.update({
            "date_of_birth": "1990-01-01",
            "gender": "Female",
            "insurance_company": "Health Net",
            "medi_cal_id": f"{abs(hash(email)) % 100_000_000:08d}A",
            "zip_code": "90001",
        })
    res = await client.post("/api/v1/auth/register", json=payload)
    assert res.status_code == 201, res.text
    return res.json()


async def _establish_relationship(
    client: AsyncClient,
    member_tokens: dict,
    chw_tokens: dict,
) -> None:
    """Create a service request and have the CHW accept it to form a relationship."""
    res = await client.post(
        "/api/v1/requests/",
        json={
            "vertical": "housing",
            "urgency": "routine",
            "description": "Need help",
            "preferred_mode": "in_person",
        },
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 201, res.text
    request_id = res.json()["id"]

    res = await client.patch(
        f"/api/v1/requests/{request_id}/accept",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text


async def _patch_resource_needs(
    client: AsyncClient,
    member_id: str,
    chw_tokens: dict,
    needs: list[str],
    levels: list[dict],
) -> dict:
    """Call PATCH resource-needs and return the response body."""
    res = await client.patch(
        f"/api/v1/chw/members/{member_id}/resource-needs",
        json={"needs": needs, "levels": levels},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    return res.json()


async def _get_active_journeys(member_id: str) -> list[MemberJourney]:
    """Return all active MemberJourney rows for the given member from the test DB."""
    async with test_session() as db:
        result = await db.execute(
            select(MemberJourney)
            .where(MemberJourney.member_id == uuid.UUID(member_id))
            .where(MemberJourney.status == "active")
        )
        return list(result.scalars().all())


async def _get_all_journeys(member_id: str) -> list[MemberJourney]:
    """Return ALL MemberJourney rows for the given member from the test DB."""
    async with test_session() as db:
        result = await db.execute(
            select(MemberJourney)
            .where(MemberJourney.member_id == uuid.UUID(member_id))
        )
        return list(result.scalars().all())


# ── Fixtures ──────────────────────────────────────────────────────────────────


@pytest.fixture
async def chw_r(client: AsyncClient) -> dict:
    """Register a CHW for reconciliation tests."""
    return await _register_user(
        client, "chw_reconcile@example.com", "chw", "CHW Reconcile"
    )


@pytest.fixture
async def member_r(client: AsyncClient) -> dict:
    """Register a member for reconciliation tests."""
    return await _register_user(
        client, "member_reconcile@example.com", "member", "Member Reconcile"
    )


@pytest.fixture
async def reconcile_pair(
    client: AsyncClient, chw_r: dict, member_r: dict
) -> tuple[dict, dict, str]:
    """Return (chw_tokens, member_tokens, member_id) with an established relationship."""
    await _establish_relationship(client, member_r, chw_r)
    member_id = _decode_jwt_sub(member_r["access_token"])
    return chw_r, member_r, member_id


# ── Test 1: New needs with no existing journeys create matching journeys ───────


@pytest.mark.asyncio
async def test_new_needs_with_no_existing_journeys_creates_matching_journeys(
    client: AsyncClient,
    reconcile_pair: tuple[dict, dict, str],
) -> None:
    """Saving [transportation(high), housing(med)] with no pre-existing journeys
    creates exactly 2 active journeys named 'Transportation' and 'Housing'.

    Verifies:
      - Both journeys are active.
      - The 'Transportation' template is auto-created (not seeded).
      - The 'Housing' template is found or created correctly.
    """
    chw_tokens, _, member_id = reconcile_pair

    await _patch_resource_needs(
        client,
        member_id,
        chw_tokens,
        needs=["transportation", "housing"],
        levels=[
            {"slug": "transportation", "level": "high"},
            {"slug": "housing", "level": "medium"},
        ],
    )

    active = await _get_active_journeys(member_id)
    assert len(active) == 2, f"Expected 2 active journeys, got {len(active)}"

    # Verify the template names via the DB.
    async with test_session() as db:
        template_ids = [j.template_id for j in active]
        templates_result = await db.execute(
            select(JourneyTemplate).where(JourneyTemplate.id.in_(template_ids))
        )
        names = {t.name for t in templates_result.scalars().all()}

    assert names == {"Transportation", "Housing"}, (
        f"Expected exactly 'Transportation' and 'Housing'; got {names}"
    )

    # 'Transportation' was created by the reconciler (not in seeds).
    async with test_session() as db:
        tmpl_result = await db.execute(
            select(JourneyTemplate).where(JourneyTemplate.name == "Transportation")
        )
        tmpl = tmpl_result.scalar_one_or_none()

    assert tmpl is not None, "'Transportation' template was not created"
    assert tmpl.is_active is True
    assert tmpl.is_custom is False
    assert tmpl.slug == "transportation"


# ── Test 2: Pre-existing journey with progress is preserved ───────────────────


@pytest.mark.asyncio
async def test_existing_journey_with_progress_preserved_when_need_saved(
    client: AsyncClient,
    reconcile_pair: tuple[dict, dict, str],
) -> None:
    """A pre-existing 'Transportation' journey with 2 completed steps is KEPT
    (same id, progress intact) when transportation is saved as a need again.

    Verifies:
      - Reconcile does not recreate the journey if one already exists.
      - Step states remain untouched (completed steps stay completed).
    """
    chw_tokens, _, member_id = reconcile_pair

    # First call: create the Transportation journey.
    await _patch_resource_needs(
        client,
        member_id,
        chw_tokens,
        needs=["transportation"],
        levels=[{"slug": "transportation", "level": "high"}],
    )

    active_before = await _get_active_journeys(member_id)
    assert len(active_before) == 1
    journey_id = str(active_before[0].id)

    # Retrieve the journey via API to get step template_step_ids.
    journeys_res = await client.get(
        f"/api/v1/members/{member_id}/journeys",
        headers=auth_header(chw_tokens),
    )
    assert journeys_res.status_code == 200, journeys_res.text
    journeys_data = journeys_res.json()
    journey_data = next(j for j in journeys_data if j["id"] == journey_id)
    steps = sorted(journey_data["steps"], key=lambda s: s["step_order"])

    # Complete step 1 → step 2 auto-advances to in_progress.
    step1_id = steps[0]["template_step_id"]
    res = await client.patch(
        f"/api/v1/journeys/{journey_id}/steps/{step1_id}",
        json={"status": "completed"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text

    # Complete step 2.
    step2_id = steps[1]["template_step_id"]
    res = await client.patch(
        f"/api/v1/journeys/{journey_id}/steps/{step2_id}",
        json={"status": "completed"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text

    # Second call: same need (transportation) — reconciler keeps the same journey.
    await _patch_resource_needs(
        client,
        member_id,
        chw_tokens,
        needs=["transportation"],
        levels=[{"slug": "transportation", "level": "high"}],
    )

    active_after = await _get_active_journeys(member_id)
    assert len(active_after) == 1, "Expected exactly 1 active journey after reconcile"
    assert str(active_after[0].id) == journey_id, (
        "The original journey id must be preserved — reconciler must not recreate it"
    )

    # Verify the 2 completed steps are still intact.
    async with test_session() as db:
        completed_result = await db.execute(
            select(MemberJourneyStepState)
            .where(
                MemberJourneyStepState.member_journey_id == uuid.UUID(journey_id)
            )
            .where(MemberJourneyStepState.status == "completed")
        )
        completed_steps = list(completed_result.scalars().all())

    assert len(completed_steps) == 2, (
        f"Expected 2 completed steps to be preserved; found {len(completed_steps)}"
    )


# ── Test 3: Duplicate active journeys deduplicated to best ────────────────────


@pytest.mark.asyncio
async def test_duplicate_active_journeys_deduped_to_best(
    client: AsyncClient,
    reconcile_pair: tuple[dict, dict, str],
) -> None:
    """Two active 'Housing' journeys → after reconcile exactly one is active
    (the earlier-created one, since both have 0 completed steps), the other 'abandoned'.

    Verifies the invariant-violation path: seeds the duplicate state directly in
    the DB and asserts no 500 and correct dedup behaviour.
    """
    chw_tokens, _, member_id = reconcile_pair
    chw_id = _decode_jwt_sub(chw_tokens["access_token"])

    # First call creates J1 (Housing).
    await _patch_resource_needs(
        client,
        member_id,
        chw_tokens,
        needs=["housing"],
        levels=[{"slug": "housing", "level": "medium"}],
    )

    active_before = await _get_active_journeys(member_id)
    assert len(active_before) == 1
    j1_id = str(active_before[0].id)
    j1_template_id = str(active_before[0].template_id)

    # Directly insert a second active Housing journey (J2) to simulate the
    # invariant-violation state (two active journeys for the same template).
    j2_id = uuid.uuid4()
    async with test_session() as db:
        j2 = MemberJourney(
            id=j2_id,
            member_id=uuid.UUID(member_id),
            template_id=uuid.UUID(j1_template_id),
            chw_id=uuid.UUID(chw_id),
            status="active",
            started_at=datetime.now(UTC),
        )
        db.add(j2)
        await db.commit()

    # Reconcile with the same need — must dedup to exactly 1 active.
    await _patch_resource_needs(
        client,
        member_id,
        chw_tokens,
        needs=["housing"],
        levels=[{"slug": "housing", "level": "medium"}],
    )

    all_journeys = await _get_all_journeys(member_id)
    active = [j for j in all_journeys if j.status == "active"]
    abandoned = [j for j in all_journeys if j.status == "abandoned"]

    assert len(active) == 1, f"Expected 1 active journey; got {len(active)}"
    assert len(abandoned) == 1, f"Expected 1 abandoned journey; got {len(abandoned)}"

    # J1 was created first → kept as canonical (tie at 0 completed steps → earliest wins).
    assert str(active[0].id) == j1_id, (
        "The earlier-created journey (J1) must be the canonical kept journey"
    )
    assert str(abandoned[0].id) == str(j2_id), (
        "The later-inserted duplicate (J2) must be abandoned"
    )


# ── Test 4: Orphan journey abandoned when not in needs ────────────────────────


@pytest.mark.asyncio
async def test_orphan_journey_abandoned_when_not_in_needs(
    client: AsyncClient,
    reconcile_pair: tuple[dict, dict, str],
) -> None:
    """An active journey for a template NOT in the new needs set is abandoned.

    Setup: start with [housing] → Housing journey J1 active.
    Action: switch to [mental_health].
    Assert: J1 (Housing) is abandoned; a new Mental Health journey J2 is active.
    """
    chw_tokens, _, member_id = reconcile_pair

    # Initial needs: housing → creates J1.
    await _patch_resource_needs(
        client,
        member_id,
        chw_tokens,
        needs=["housing"],
        levels=[{"slug": "housing", "level": "medium"}],
    )

    active_initial = await _get_active_journeys(member_id)
    assert len(active_initial) == 1
    j1_id = str(active_initial[0].id)

    # Switch to a different need: mental_health.
    await _patch_resource_needs(
        client,
        member_id,
        chw_tokens,
        needs=["mental_health"],
        levels=[{"slug": "mental_health", "level": "medium"}],
    )

    all_journeys = await _get_all_journeys(member_id)
    active = [j for j in all_journeys if j.status == "active"]
    abandoned = [j for j in all_journeys if j.status == "abandoned"]

    assert len(active) == 1, f"Expected 1 active journey; got {len(active)}"
    assert len(abandoned) == 1, f"Expected 1 abandoned journey; got {len(abandoned)}"

    # J1 (Housing) must be abandoned.
    assert str(abandoned[0].id) == j1_id, "Housing journey must be abandoned"

    # The active journey must be for Mental Health.
    async with test_session() as db:
        active_template_result = await db.execute(
            select(JourneyTemplate).where(
                JourneyTemplate.id == active[0].template_id
            )
        )
        active_template = active_template_result.scalar_one()

    assert active_template.name == "Mental Health", (
        f"Expected active journey for 'Mental Health'; got '{active_template.name}'"
    )


# ── Test 5: Idempotency — same needs twice → stable journey set ───────────────


@pytest.mark.asyncio
async def test_resource_needs_update_is_idempotent(
    client: AsyncClient,
    reconcile_pair: tuple[dict, dict, str],
) -> None:
    """Calling the endpoint twice with identical needs produces no new journeys
    and no status churn — journey ids and count are stable across both calls.

    Verifies:
      - No duplicate rows created on second call.
      - Journey ids are identical before and after the second call.
    """
    chw_tokens, _, member_id = reconcile_pair

    needs = ["transportation", "housing"]
    levels = [
        {"slug": "transportation", "level": "high"},
        {"slug": "housing", "level": "medium"},
    ]

    # First call.
    await _patch_resource_needs(client, member_id, chw_tokens, needs, levels)
    active_after_first = await _get_active_journeys(member_id)
    assert len(active_after_first) == 2
    ids_after_first = {str(j.id) for j in active_after_first}

    # Second identical call.
    await _patch_resource_needs(client, member_id, chw_tokens, needs, levels)
    active_after_second = await _get_active_journeys(member_id)

    assert len(active_after_second) == 2, (
        f"Expected still 2 active journeys; got {len(active_after_second)}"
    )
    ids_after_second = {str(j.id) for j in active_after_second}

    assert ids_after_first == ids_after_second, (
        "Journey ids must be identical across both calls — no new rows created"
    )

    # Total journey count must be exactly 2 (no ghost abandoned rows).
    all_journeys = await _get_all_journeys(member_id)
    assert len(all_journeys) == 2, (
        f"Expected total of 2 journey rows; got {len(all_journeys)}"
    )


# ── Regression: resource-needs save must survive messy template data ──────────
# Reported bug: saving Resource Needs failed with "Could not save resource needs.
# Please try again." The reconcile step raised an UNHANDLED exception which, on
# web, the browser only saw as "Failed to fetch" (500 generated outside
# CORSMiddleware → no CORS header). Two prod-realistic data states trigger it.


@pytest.mark.asyncio
async def test_save_succeeds_with_duplicate_active_templates(
    client: AsyncClient,
    reconcile_pair: tuple[dict, dict, str],
) -> None:
    """Two active templates sharing a name must NOT 500 the resource-needs save.

    get_or_create_canonical_template used scalar_one_or_none(), which raised
    MultipleResultsFound on duplicate-named active templates (backend/TESTING.md
    rule #2). Fails on pre-fix code (500); passes after (.scalars().first()).
    """
    chw_tokens, _, member_id = reconcile_pair

    async with test_session() as db:
        for slug in ("housing", "housing_dup"):
            t = JourneyTemplate(
                id=uuid.uuid4(), slug=slug, name="Housing", category="housing",
                icon="home", is_custom=False, is_active=True,
            )
            db.add(t)
            await db.flush()
            for s in STANDARD_STEPS:
                db.add(JourneyTemplateStep(
                    id=uuid.uuid4(), template_id=t.id, order=s["order"],
                    name=s["name"], description=s["description"],
                    points_on_completion=s["points_on_completion"],
                    required_documents=s["required_documents"],
                ))
        await db.commit()

    # _patch_resource_needs asserts 200 — i.e. no MultipleResultsFound 500.
    await _patch_resource_needs(
        client, member_id, chw_tokens,
        needs=["housing"], levels=[{"slug": "housing", "level": "high"}],
    )

    active = await _get_active_journeys(member_id)
    assert len(active) == 1, f"Expected exactly 1 housing journey, got {len(active)}"


@pytest.mark.asyncio
async def test_save_succeeds_and_heals_stepless_template(
    client: AsyncClient,
    reconcile_pair: tuple[dict, dict, str],
) -> None:
    """An active canonical template with NO steps must be healed, not 500.

    create_journey_for_template raised ValueError('...has no steps...') for a
    stepless template → unhandled 500. Fails pre-fix (500); passes after
    (_ensure_template_has_steps backfills STANDARD_STEPS).
    """
    chw_tokens, _, member_id = reconcile_pair

    async with test_session() as db:
        db.add(JourneyTemplate(
            id=uuid.uuid4(), slug="housing", name="Housing", category="housing",
            icon="home", is_custom=False, is_active=True,
        ))
        await db.commit()

    await _patch_resource_needs(
        client, member_id, chw_tokens,
        needs=["housing"], levels=[{"slug": "housing", "level": "high"}],
    )

    active = await _get_active_journeys(member_id)
    assert len(active) == 1, f"Expected 1 housing journey, got {len(active)}"

    async with test_session() as db:
        count = await db.scalar(
            select(func.count())
            .select_from(JourneyTemplateStep)
            .where(JourneyTemplateStep.template_id == active[0].template_id)
        )
    assert count == len(STANDARD_STEPS), (
        f"Expected {len(STANDARD_STEPS)} backfilled steps, got {count}"
    )


@pytest.mark.asyncio
async def test_needs_persist_even_if_reconcile_raises(
    client: AsyncClient,
    reconcile_pair: tuple[dict, dict, str],
    monkeypatch,
) -> None:
    """If journey reconciliation raises, the needs must STILL save and the
    endpoint must return 200 — never a 500 (the invisible "Failed to fetch" on
    web). backend/TESTING.md rule #3: force an internal failure, assert a clean
    response and correct post-failure DB state.
    """
    chw_tokens, _, member_id = reconcile_pair

    async def _boom(*_args, **_kwargs):
        raise RuntimeError("simulated reconcile failure")

    # The endpoint imports the symbol from the module at call time, so patching
    # the module attribute is picked up by the next request.
    monkeypatch.setattr(
        "app.services.journey_reconciler.reconcile_member_journeys_to_needs", _boom
    )

    await _patch_resource_needs(
        client, member_id, chw_tokens,
        needs=["housing"], levels=[{"slug": "housing", "level": "high"}],
    )

    # Needs persisted on the member profile despite the reconcile failure.
    async with test_session() as db:
        from app.models.user import MemberProfile

        prof = (
            await db.execute(
                select(MemberProfile).where(
                    MemberProfile.user_id == uuid.UUID(member_id)
                )
            )
        ).scalar_one()
        assert prof.primary_need == "housing", (
            f"needs must persist even when reconcile fails; got {prof.primary_need!r}"
        )


# ── Vertical taxonomy: rehab→transportation rename + employment added ─────────


@pytest.mark.asyncio
async def test_transportation_and_employment_create_journeys(
    client: AsyncClient,
    reconcile_pair: tuple[dict, dict, str],
) -> None:
    """The renamed 'transportation' and new 'employment' needs are valid and
    each auto-provisions its canonical journey."""
    chw_tokens, _, member_id = reconcile_pair

    await _patch_resource_needs(
        client,
        member_id,
        chw_tokens,
        needs=["transportation", "employment"],
        levels=[
            {"slug": "transportation", "level": "high"},
            {"slug": "employment", "level": "medium"},
        ],
    )

    active = await _get_active_journeys(member_id)
    assert len(active) == 2, f"Expected 2 journeys, got {len(active)}"
    async with test_session() as db:
        names = {
            t.name
            for t in (
                await db.execute(
                    select(JourneyTemplate).where(
                        JourneyTemplate.id.in_([j.template_id for j in active])
                    )
                )
            ).scalars().all()
        }
    assert names == {"Transportation", "Employment"}, f"got {names}"


@pytest.mark.asyncio
async def test_rehab_is_no_longer_a_valid_need(
    client: AsyncClient,
    reconcile_pair: tuple[dict, dict, str],
) -> None:
    """'rehab' was repurposed to 'transportation' and must now be rejected (422)."""
    chw_tokens, _, member_id = reconcile_pair

    res = await client.patch(
        f"/api/v1/chw/members/{member_id}/resource-needs",
        json={"needs": ["rehab"], "levels": [{"slug": "rehab", "level": "high"}]},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 422, res.text


@pytest.mark.asyncio
async def test_custom_journey_survives_resource_needs_save(
    client: AsyncClient,
    reconcile_pair: tuple[dict, dict, str],
) -> None:
    """A CHW-authored custom journey must NOT be abandoned by a later needs save.

    The reconciler abandons active journeys whose template isn't in the needs
    set; a custom journey's name never matches a canonical need, so without the
    is_custom guard it would be silently abandoned the next time a CHW edits the
    member's resource needs.
    """
    chw_tokens, _, member_id = reconcile_pair

    # CHW creates a custom journey for the member.
    res = await client.post(
        "/api/v1/journeys/custom",
        json={"member_id": member_id, "title": "Get a driver's license"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    custom_journey_id = res.json()["id"]

    # CHW then saves an unrelated resource need (triggers reconciliation).
    await _patch_resource_needs(
        client,
        member_id,
        chw_tokens,
        needs=["housing"],
        levels=[{"slug": "housing", "level": "high"}],
    )

    # The custom journey must still be active.
    active_ids = {str(j.id) for j in await _get_active_journeys(member_id)}
    assert custom_journey_id in active_ids, (
        "custom journey was abandoned by the resource-needs reconciliation"
    )


# ── Consolidation: at most one active journey per name ────────────────────────


@pytest.mark.asyncio
async def test_two_canonical_journeys_for_same_need_are_consolidated(
    client: AsyncClient,
    reconcile_pair: tuple[dict, dict, str],
) -> None:
    """Two active journeys for the same canonical need collapse to one on save."""
    chw_tokens, _, member_id = reconcile_pair

    # Seed TWO active journeys for the member, both via templates named "Employment".
    async with test_session() as db:
        for slug in ("employment", "employment_dup"):
            t = JourneyTemplate(
                id=uuid.uuid4(), slug=slug, name="Employment", category="employment",
                icon="briefcase", is_custom=False, is_active=True,
            )
            db.add(t)
            await db.flush()
            steps = []
            for s in STANDARD_STEPS:
                st = JourneyTemplateStep(
                    id=uuid.uuid4(), template_id=t.id, order=s["order"], name=s["name"],
                    description=s["description"], points_on_completion=s["points_on_completion"],
                    required_documents=s["required_documents"],
                )
                db.add(st)
                steps.append(st)
            await db.flush()
            db.add(MemberJourney(
                id=uuid.uuid4(), member_id=uuid.UUID(member_id), template_id=t.id,
                chw_id=uuid.UUID(_decode_jwt_sub(chw_tokens["access_token"])),
                status="active", current_step_id=steps[0].id,
            ))
        await db.commit()

    assert len(await _get_active_journeys(member_id)) == 2  # precondition

    await _patch_resource_needs(
        client, member_id, chw_tokens,
        needs=["employment"], levels=[{"slug": "employment", "level": "high"}],
    )

    active = await _get_active_journeys(member_id)
    assert len(active) == 1, f"Expected the two Employment journeys to consolidate; got {len(active)}"


@pytest.mark.asyncio
async def test_custom_journey_named_like_a_fixed_need_is_rejected(
    client: AsyncClient,
    reconcile_pair: tuple[dict, dict, str],
) -> None:
    """A custom journey named exactly like an existing active need is rejected
    (409) by the duplicate guard — so the member never gets two "Employment"
    journeys in the first place."""
    chw_tokens, _, member_id = reconcile_pair

    # Select Employment → creates the canonical Employment journey.
    await _patch_resource_needs(
        client, member_id, chw_tokens,
        needs=["employment"], levels=[{"slug": "employment", "level": "high"}],
    )
    # A custom journey titled "Employment" duplicates the active need → 409.
    res = await client.post(
        "/api/v1/journeys/custom",
        json={"member_id": member_id, "title": "Employment"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 409, res.text
    assert "already exists" in res.json()["detail"].lower()

    # The guard means there is still exactly one active "Employment" journey.
    active = await _get_active_journeys(member_id)
    assert len(active) == 1, f"Expected one Employment journey; got {len(active)}"

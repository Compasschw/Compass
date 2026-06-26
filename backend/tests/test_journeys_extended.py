"""Extended integration tests for Member Journey Node Editor (Task 3).

Coverage:
  1. test_status_to_in_progress_standard_journey — PATCH step to in_progress: 200,
     no ledger entry, step status updated.
  2. test_status_to_completed_awards_points — complete a step: points awarded,
     ledger entry written.
  3. test_status_uncomplete_reverses_points — complete then un-complete: net balance
     zero; reversal ledger entry with reason='correction'.
  4. test_status_completed_idempotent — complete twice: exactly 1 positive ledger
     entry (no double award).
  5. test_insert_before_resequences_order — insert before step 2: new step gets
     order 2, old step 2 gets order 3.
  6. test_insert_after_resequences_order — insert after step 1: new step gets
     order 2, old step 2 gets order 3.
  7. test_insert_on_standard_journey_returns_403 — POST nodes on standard journey
     returns 403 or 409 (custom-only gate).
  8. test_insert_relative_to_nonexistent_step_returns_400 — POST nodes with fake
     relative_to_step_id returns 400.
  9. test_unrelated_chw_returns_403 — second CHW with no relationship: PATCH step
     returns 403; POST nodes returns 403.
"""

from __future__ import annotations

import base64
import json
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select

from app.models.journeys import (
    JourneyTemplate,
    JourneyTemplateStep,
    MemberJourney,
    MemberJourneyStepState,
    WellnessPointsLedger,
)
from app.models.user import MemberProfile
from app.services.journey_seeds import seed_default_journey_templates
from tests.conftest import auth_header, complete_member_signup_payload, test_session

# ─── Helpers ───────────────────────────────────────────────────────────────────


def _member_id(tokens: dict) -> str:
    """Extract the 'sub' (member UUID) from a JWT access token."""
    payload_b64 = tokens["access_token"].split(".")[1]
    padded = payload_b64 + "=" * (4 - len(payload_b64) % 4)
    return str(UUID(json.loads(base64.urlsafe_b64decode(padded).decode())["sub"]))


async def _relate(client: AsyncClient, member_tokens: dict, chw_tokens: dict) -> str:
    """Create a ServiceRequest and have the CHW accept it, establishing the
    CHW-member relationship. Returns the member_id as a string."""
    res = await client.post(
        "/api/v1/requests/",
        json={
            "vertical": "food",
            "urgency": "routine",
            "description": "Need help",
            "preferred_mode": "in_person",
        },
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 201, res.text
    rid = res.json()["id"]
    res = await client.patch(
        f"/api/v1/requests/{rid}/accept",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    return _member_id(member_tokens)


async def _seed_templates() -> None:
    """Seed the standard journey templates in the test DB."""
    async with test_session() as db:
        await seed_default_journey_templates(db)


async def _create_standard_journey(
    client: AsyncClient,
    chw_tokens: dict,
    member_id: str,
    template_slug: str = "food_assistance",
) -> dict:
    """Create a standard-template journey and return the response dict."""
    res = await client.post(
        f"/api/v1/members/{member_id}/journeys",
        json={"member_id": member_id, "template_slug": template_slug},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    return res.json()


async def _create_custom_journey(
    client: AsyncClient,
    chw_tokens: dict,
    member_id: str,
    title: str = "Test Journey",
) -> dict:
    """Create a custom (CHW-authored) journey and return the response dict."""
    res = await client.post(
        "/api/v1/journeys/custom",
        json={"member_id": member_id, "title": title},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    return res.json()


async def _register_user(
    client: AsyncClient,
    email: str,
    role: str,
    name: str,
) -> dict:
    """Register a new user and return the token dict.

    Members require all Pear-required fields (date_of_birth, gender, etc.) —
    uses ``complete_member_signup_payload`` for that role. CHWs only need the
    basic fields.
    """
    if role == "member":
        payload = complete_member_signup_payload(email=email, name=name)
    else:
        payload = {"email": email, "password": "pass12345", "name": name, "role": role}
    res = await client.post("/api/v1/auth/register", json=payload)
    assert res.status_code == 201, res.text
    return res.json()


# ─── Test 1: in_progress on standard journey ──────────────────────────────────


@pytest.mark.asyncio
async def test_status_to_in_progress_standard_journey(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """PATCH step 2 to in_progress on a standard journey: 200, no ledger entry,
    status updated to in_progress."""
    await _seed_templates()
    member_id = await _relate(client, member_tokens, chw_tokens)

    journey = await _create_standard_journey(client, chw_tokens, member_id)
    journey_id = journey["id"]
    steps = sorted(journey["steps"], key=lambda s: s["step_order"])

    # Step 1 starts as in_progress; PATCH step 2 (upcoming → in_progress).
    step2_template_step_id = steps[1]["template_step_id"]

    patch_res = await client.patch(
        f"/api/v1/journeys/{journey_id}/steps/{step2_template_step_id}",
        json={"status": "in_progress"},
        headers=auth_header(chw_tokens),
    )
    assert patch_res.status_code == 200, patch_res.text

    updated_steps = sorted(patch_res.json()["steps"], key=lambda s: s["step_order"])
    assert updated_steps[1]["status"] == "in_progress"

    # No ledger entry should be written for an in_progress transition.
    points_res = await client.get(
        f"/api/v1/members/{member_id}/wellness-points",
        headers=auth_header(chw_tokens),
    )
    assert points_res.status_code == 200, points_res.text
    data = points_res.json()
    assert data["total_points"] == 0
    assert len(data["ledger"]) == 0


# ─── Test 2: completing a step awards points ──────────────────────────────────


@pytest.mark.asyncio
async def test_status_to_completed_awards_points(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """Complete step 1 of a standard journey: 200, positive points_awarded,
    one ledger entry with reason='journey_step_completed'."""
    await _seed_templates()
    member_id = await _relate(client, member_tokens, chw_tokens)

    journey = await _create_standard_journey(client, chw_tokens, member_id)
    journey_id = journey["id"]
    steps = sorted(journey["steps"], key=lambda s: s["step_order"])
    step1_id = steps[0]["template_step_id"]
    step1_points = steps[0]["points_on_completion"]
    assert step1_points > 0, "Template step 1 must have points_on_completion > 0"

    patch_res = await client.patch(
        f"/api/v1/journeys/{journey_id}/steps/{step1_id}",
        json={"status": "completed"},
        headers=auth_header(chw_tokens),
    )
    assert patch_res.status_code == 200, patch_res.text
    body = patch_res.json()

    # Step 1 completed; points_awarded should match the template.
    updated_steps = sorted(body["steps"], key=lambda s: s["step_order"])
    assert updated_steps[0]["status"] == "completed"
    assert updated_steps[0]["points_awarded"] == step1_points

    # Wellness-points endpoint reflects the award.
    points_res = await client.get(
        f"/api/v1/members/{member_id}/wellness-points",
        headers=auth_header(chw_tokens),
    )
    assert points_res.status_code == 200, points_res.text
    pts = points_res.json()
    assert pts["total_points"] == step1_points
    assert len(pts["ledger"]) == 1
    assert pts["ledger"][0]["reason"] == "journey_step_completed"
    assert pts["ledger"][0]["points"] == step1_points


# ─── Test 3: un-completing reverses points ────────────────────────────────────


@pytest.mark.asyncio
async def test_status_uncomplete_reverses_points(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """Complete step 1 then PATCH it back to upcoming: net balance == 0.
    Ledger must contain a negative entry with reason='correction'."""
    await _seed_templates()
    member_id = await _relate(client, member_tokens, chw_tokens)

    journey = await _create_standard_journey(client, chw_tokens, member_id)
    journey_id = journey["id"]
    steps = sorted(journey["steps"], key=lambda s: s["step_order"])
    step1_id = steps[0]["template_step_id"]
    step1_points = steps[0]["points_on_completion"]

    # Complete step 1.
    complete_res = await client.patch(
        f"/api/v1/journeys/{journey_id}/steps/{step1_id}",
        json={"status": "completed"},
        headers=auth_header(chw_tokens),
    )
    assert complete_res.status_code == 200, complete_res.text

    # Verify non-zero balance after completion.
    pts_before = await client.get(
        f"/api/v1/members/{member_id}/wellness-points",
        headers=auth_header(chw_tokens),
    )
    assert pts_before.json()["total_points"] == step1_points

    # Now revert step 1 to upcoming (un-complete).
    revert_res = await client.patch(
        f"/api/v1/journeys/{journey_id}/steps/{step1_id}",
        json={"status": "upcoming"},
        headers=auth_header(chw_tokens),
    )
    assert revert_res.status_code == 200, revert_res.text

    # Balance should be net zero.
    pts_after = await client.get(
        f"/api/v1/members/{member_id}/wellness-points",
        headers=auth_header(chw_tokens),
    )
    assert pts_after.status_code == 200, pts_after.text
    after_data = pts_after.json()
    assert after_data["total_points"] == 0

    # Ledger must contain a correction entry with negative points.
    reasons = [e["reason"] for e in after_data["ledger"]]
    assert "correction" in reasons, f"Expected 'correction' in ledger, got: {reasons}"

    correction_entries = [e for e in after_data["ledger"] if e["reason"] == "correction"]
    assert any(e["points"] < 0 for e in correction_entries), (
        f"Expected a negative correction entry, got: {correction_entries}"
    )


# ─── Test 4: completing the same step twice is idempotent ─────────────────────


@pytest.mark.asyncio
async def test_status_completed_idempotent(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """PATCH step 1 to completed twice: exactly 1 positive ledger entry.
    The second PATCH is a no-op — no double award."""
    await _seed_templates()
    member_id = await _relate(client, member_tokens, chw_tokens)

    journey = await _create_standard_journey(client, chw_tokens, member_id)
    journey_id = journey["id"]
    steps = sorted(journey["steps"], key=lambda s: s["step_order"])
    step1_id = steps[0]["template_step_id"]

    # First completion.
    res1 = await client.patch(
        f"/api/v1/journeys/{journey_id}/steps/{step1_id}",
        json={"status": "completed"},
        headers=auth_header(chw_tokens),
    )
    assert res1.status_code == 200, res1.text

    # Second completion — should be a no-op.
    res2 = await client.patch(
        f"/api/v1/journeys/{journey_id}/steps/{step1_id}",
        json={"status": "completed"},
        headers=auth_header(chw_tokens),
    )
    assert res2.status_code == 200, res2.text

    # Only 1 positive ledger entry for this reason.
    async with test_session() as db:
        result = await db.execute(
            select(WellnessPointsLedger)
            .where(WellnessPointsLedger.member_id == member_id)
            .where(WellnessPointsLedger.reason == "journey_step_completed")
            .where(WellnessPointsLedger.points > 0)
        )
        positive_entries = result.scalars().all()

    assert len(positive_entries) == 1, (
        f"Expected exactly 1 positive ledger entry, got {len(positive_entries)}"
    )


# ─── Test 5: insert before re-sequences order ─────────────────────────────────


@pytest.mark.asyncio
async def test_insert_before_resequences_order(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """Insert a node before step 2 on a custom journey (3 nodes): new step gets
    order 2, old step 2 now has order 3, old step 3 now has order 4."""
    member_id = await _relate(client, member_tokens, chw_tokens)

    journey = await _create_custom_journey(client, chw_tokens, member_id, "Insert Before")
    journey_id = journey["id"]
    steps = sorted(journey["steps"], key=lambda s: s["step_order"])
    assert len(steps) == 3

    step2_template_step_id = steps[1]["template_step_id"]
    old_step3_template_step_id = steps[2]["template_step_id"]

    # Insert before step 2.
    insert_res = await client.post(
        f"/api/v1/journeys/{journey_id}/nodes",
        json={
            "name": "Inserted Before Step 2",
            "description": "A new step inserted before position 2",
            "position": "before",
            "relative_to_step_id": step2_template_step_id,
        },
        headers=auth_header(chw_tokens),
    )
    assert insert_res.status_code == 201, insert_res.text

    new_steps = sorted(insert_res.json()["steps"], key=lambda s: s["step_order"])
    assert len(new_steps) == 4, f"Expected 4 steps after insert, got {len(new_steps)}"

    # Find the new step by name.
    new_step = next(
        (s for s in new_steps if s["step_name"] == "Inserted Before Step 2"),
        None,
    )
    assert new_step is not None, "Inserted step not found in response"
    assert new_step["step_order"] == 2, (
        f"New step should be at order 2, got {new_step['step_order']}"
    )

    # Old step 2 should now be at order 3.
    old_step2_after = next(
        s for s in new_steps if s["template_step_id"] == step2_template_step_id
    )
    assert old_step2_after["step_order"] == 3, (
        f"Old step 2 should now be at order 3, got {old_step2_after['step_order']}"
    )

    # Old step 3 should now be at order 4.
    old_step3_after = next(
        s for s in new_steps if s["template_step_id"] == old_step3_template_step_id
    )
    assert old_step3_after["step_order"] == 4, (
        f"Old step 3 should now be at order 4, got {old_step3_after['step_order']}"
    )


# ─── Test 6: insert after re-sequences order ──────────────────────────────────


@pytest.mark.asyncio
async def test_insert_after_resequences_order(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """Insert a node after step 1 on a custom journey (3 nodes): new step gets
    order 2, old step 2 now has order 3, old step 3 now has order 4."""
    member_id = await _relate(client, member_tokens, chw_tokens)

    journey = await _create_custom_journey(client, chw_tokens, member_id, "Insert After")
    journey_id = journey["id"]
    steps = sorted(journey["steps"], key=lambda s: s["step_order"])
    assert len(steps) == 3

    step1_template_step_id = steps[0]["template_step_id"]
    old_step2_template_step_id = steps[1]["template_step_id"]

    # Insert after step 1.
    insert_res = await client.post(
        f"/api/v1/journeys/{journey_id}/nodes",
        json={
            "name": "Inserted After Step 1",
            "description": "A new step inserted after position 1",
            "position": "after",
            "relative_to_step_id": step1_template_step_id,
        },
        headers=auth_header(chw_tokens),
    )
    assert insert_res.status_code == 201, insert_res.text

    new_steps = sorted(insert_res.json()["steps"], key=lambda s: s["step_order"])
    assert len(new_steps) == 4, f"Expected 4 steps after insert, got {len(new_steps)}"

    # Find the new step by name.
    new_step = next(
        (s for s in new_steps if s["step_name"] == "Inserted After Step 1"),
        None,
    )
    assert new_step is not None, "Inserted step not found in response"
    assert new_step["step_order"] == 2, (
        f"New step should be at order 2, got {new_step['step_order']}"
    )

    # Old step 2 should now be at order 3.
    old_step2_after = next(
        s for s in new_steps if s["template_step_id"] == old_step2_template_step_id
    )
    assert old_step2_after["step_order"] == 3, (
        f"Old step 2 should now be at order 3, got {old_step2_after['step_order']}"
    )


# ─── Test 7: insert on standard journey transparently forks ───────────────────


@pytest.mark.asyncio
async def test_insert_on_standard_journey_returns_403(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """POST /journeys/{id}/nodes on a standard (non-custom) journey now transparently
    forks the template to a private per-member copy and succeeds with 201.

    The endpoint no longer raises 409; structural edits on built-in journeys are
    permitted — the fork happens atomically before the insert.
    """
    await _seed_templates()
    member_id = await _relate(client, member_tokens, chw_tokens)

    journey = await _create_standard_journey(client, chw_tokens, member_id)
    journey_id = journey["id"]

    insert_res = await client.post(
        f"/api/v1/journeys/{journey_id}/nodes",
        json={"name": "New Custom Step", "description": "Fork-on-insert test"},
        headers=auth_header(chw_tokens),
    )
    assert insert_res.status_code == 201, (
        f"Expected 201 (transparent fork+insert), got {insert_res.status_code}: "
        f"{insert_res.text}"
    )

    # The journey must now be backed by a custom template.
    async with test_session() as db:
        mj = (await db.execute(
            select(MemberJourney).where(MemberJourney.id == UUID(journey_id))
        )).scalar_one()
        new_tmpl = (await db.execute(
            select(JourneyTemplate).where(JourneyTemplate.id == mj.template_id)
        )).scalar_one()
    assert new_tmpl.is_custom is True, "Template must be custom after fork-on-insert"


# ─── Test 8: insert with nonexistent relative_to_step_id returns 400 ──────────


@pytest.mark.asyncio
async def test_insert_relative_to_nonexistent_step_returns_400(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """POST /journeys/{id}/nodes with a fake relative_to_step_id returns 400."""
    member_id = await _relate(client, member_tokens, chw_tokens)

    journey = await _create_custom_journey(client, chw_tokens, member_id, "Bad Ref Journey")
    journey_id = journey["id"]

    fake_step_id = str(uuid4())

    insert_res = await client.post(
        f"/api/v1/journeys/{journey_id}/nodes",
        json={
            "name": "Ghost Step",
            "description": "Relative to a step that does not exist",
            "position": "before",
            "relative_to_step_id": fake_step_id,
        },
        headers=auth_header(chw_tokens),
    )
    assert insert_res.status_code == 400, (
        f"Expected 400 for nonexistent relative_to_step_id, got {insert_res.status_code}: "
        f"{insert_res.text}"
    )


# ─── Test 9: unrelated CHW returns 403 on both PATCH and POST ─────────────────


@pytest.mark.asyncio
async def test_unrelated_chw_returns_403(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """A second CHW with no relationship to the member receives 403 when:
    - PATCHing a step on an existing journey
    - POSTing a node to an existing custom journey"""
    await _seed_templates()
    # chw_tokens has the relationship with member_tokens.
    member_id = await _relate(client, member_tokens, chw_tokens)

    # Create a standard journey and a custom journey with the first CHW.
    standard_journey = await _create_standard_journey(client, chw_tokens, member_id)
    custom_journey = await _create_custom_journey(
        client, chw_tokens, member_id, "Unrelated Access Check"
    )
    standard_journey_id = standard_journey["id"]
    custom_journey_id = custom_journey["id"]

    standard_steps = sorted(standard_journey["steps"], key=lambda s: s["step_order"])
    step1_id = standard_steps[0]["template_step_id"]

    # Register a second CHW with NO relationship to the member.
    reg_res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "otherchw@example.com",
            "password": "pass12345",
            "name": "Other CHW",
            "role": "chw",
        },
    )
    assert reg_res.status_code == 201, reg_res.text
    other_chw_tokens = reg_res.json()

    # Attempt PATCH on the standard journey — must be 403.
    patch_res = await client.patch(
        f"/api/v1/journeys/{standard_journey_id}/steps/{step1_id}",
        json={"status": "completed"},
        headers=auth_header(other_chw_tokens),
    )
    assert patch_res.status_code == 403, (
        f"Expected 403 for unrelated CHW PATCH, got {patch_res.status_code}: {patch_res.text}"
    )

    # Attempt POST nodes on the custom journey — must be 403 (not 409).
    # _load_custom_journey_for_chw checks chw_id first, so unrelated CHW hits 403
    # before the custom-only gate raises 409.
    node_res = await client.post(
        f"/api/v1/journeys/{custom_journey_id}/nodes",
        json={"name": "Illegal Node", "description": "Should not exist"},
        headers=auth_header(other_chw_tokens),
    )
    assert node_res.status_code == 403, (
        f"Expected 403 for unrelated CHW POST nodes, got {node_res.status_code}: {node_res.text}"
    )


# ─── DELETE /nodes/{step_id} tests ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_delete_middle_node_resequences_order(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """Delete the middle (order=2) step of a 3-step custom journey.

    After deletion:
      - The journey has 2 steps.
      - The former step-3 now has order=2 (gap closed).
      - The deleted step is no longer present.
    """
    member_id = await _relate(client, member_tokens, chw_tokens)
    journey = await _create_custom_journey(client, chw_tokens, member_id, "Delete Middle")
    journey_id = journey["id"]

    steps = sorted(journey["steps"], key=lambda s: s["step_order"])
    assert len(steps) == 3, f"Expected 3 starter steps, got {len(steps)}"

    step1_id = steps[0]["template_step_id"]
    step2_id = steps[1]["template_step_id"]
    step3_id = steps[2]["template_step_id"]

    # Delete step 2 (middle).
    del_res = await client.delete(
        f"/api/v1/journeys/{journey_id}/nodes/{step2_id}",
        headers=auth_header(chw_tokens),
    )
    assert del_res.status_code == 200, del_res.text

    remaining_steps = sorted(del_res.json()["steps"], key=lambda s: s["step_order"])
    assert len(remaining_steps) == 2, (
        f"Expected 2 steps after delete, got {len(remaining_steps)}"
    )

    step_ids_remaining = [s["template_step_id"] for s in remaining_steps]
    assert step2_id not in step_ids_remaining, "Deleted step should not appear in response"
    assert step1_id in step_ids_remaining, "Step 1 should still be present"
    assert step3_id in step_ids_remaining, "Former step 3 should still be present"

    # Former step 3 must now have order=2.
    former_step3 = next(s for s in remaining_steps if s["template_step_id"] == step3_id)
    assert former_step3["step_order"] == 2, (
        f"Former step 3 should now have order 2, got {former_step3['step_order']}"
    )

    # Orders must be contiguous [1, 2].
    orders = sorted(s["step_order"] for s in remaining_steps)
    assert orders == [1, 2], f"Expected contiguous orders [1, 2], got {orders}"


@pytest.mark.asyncio
async def test_delete_completed_node_reverses_points(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """Delete a step that was previously completed → its points are reversed.

    Setup: 3-step custom journey. Complete step 1 (awards points). Then delete
    step 1 and assert the ledger has a matching negative 'correction' entry
    and the net balance is zero.
    """
    await _seed_templates()
    member_id = await _relate(client, member_tokens, chw_tokens)
    journey = await _create_custom_journey(client, chw_tokens, member_id, "Delete Completed")
    journey_id = journey["id"]

    steps = sorted(journey["steps"], key=lambda s: s["step_order"])
    step1_id = steps[0]["template_step_id"]
    step1_state_id = steps[0]["id"]

    # Complete step 1 to award points.
    complete_res = await client.patch(
        f"/api/v1/journeys/{journey_id}/steps/{step1_id}",
        json={"status": "completed"},
        headers=auth_header(chw_tokens),
    )
    assert complete_res.status_code == 200, complete_res.text
    awarded_points = complete_res.json()["steps"][0]["points_awarded"]
    assert awarded_points > 0, "Step 1 should have awarded points after completion"

    # Verify balance is non-zero before deletion.
    pts_before = await client.get(
        f"/api/v1/members/{member_id}/wellness-points",
        headers=auth_header(chw_tokens),
    )
    assert pts_before.json()["total_points"] == awarded_points

    # Delete the completed step.
    del_res = await client.delete(
        f"/api/v1/journeys/{journey_id}/nodes/{step1_id}",
        headers=auth_header(chw_tokens),
    )
    assert del_res.status_code == 200, del_res.text

    # Net balance must be zero.
    pts_after = await client.get(
        f"/api/v1/members/{member_id}/wellness-points",
        headers=auth_header(chw_tokens),
    )
    assert pts_after.status_code == 200, pts_after.text
    after_data = pts_after.json()
    assert after_data["total_points"] == 0, (
        f"Expected net balance 0 after deleting completed step, got {after_data['total_points']}"
    )

    # Ledger must include a negative 'correction' entry referencing the deleted step state.
    correction_entries = [
        e for e in after_data["ledger"] if e["reason"] == "correction" and e["points"] < 0
    ]
    assert len(correction_entries) >= 1, (
        f"Expected at least 1 negative correction entry, got: {after_data['ledger']}"
    )
    assert any(e["points"] == -awarded_points for e in correction_entries), (
        f"Expected a correction of -{awarded_points}, got: {correction_entries}"
    )


@pytest.mark.asyncio
async def test_delete_node_unrelated_chw_returns_403(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """A CHW with no relationship to the member receives 403 on DELETE nodes.

    This is a relationship gate (chw_id check on MemberJourney), NOT a role
    gate — a valid CHW with a different member gets 403, not 401/404.
    """
    member_id = await _relate(client, member_tokens, chw_tokens)
    journey = await _create_custom_journey(client, chw_tokens, member_id, "Auth Guard Delete")
    journey_id = journey["id"]
    steps = sorted(journey["steps"], key=lambda s: s["step_order"])
    step2_id = steps[1]["template_step_id"]

    # Register a second CHW with NO relationship to the member.
    reg_res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "otherchw_delete@example.com",
            "password": "pass12345",
            "name": "Other CHW Delete",
            "role": "chw",
        },
    )
    assert reg_res.status_code == 201, reg_res.text
    other_chw_tokens = reg_res.json()

    del_res = await client.delete(
        f"/api/v1/journeys/{journey_id}/nodes/{step2_id}",
        headers=auth_header(other_chw_tokens),
    )
    assert del_res.status_code == 403, (
        f"Expected 403 for unrelated CHW DELETE, got {del_res.status_code}: {del_res.text}"
    )


@pytest.mark.asyncio
async def test_delete_nonexistent_node_returns_404(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """DELETE with a step_id that does not exist on the journey returns 404, not 500."""
    member_id = await _relate(client, member_tokens, chw_tokens)
    journey = await _create_custom_journey(client, chw_tokens, member_id, "Nonexistent Node")
    journey_id = journey["id"]
    fake_step_id = str(uuid4())

    del_res = await client.delete(
        f"/api/v1/journeys/{journey_id}/nodes/{fake_step_id}",
        headers=auth_header(chw_tokens),
    )
    assert del_res.status_code == 404, (
        f"Expected 404 for nonexistent step_id, got {del_res.status_code}: {del_res.text}"
    )
    assert del_res.status_code != 500, "Must never return 500 for a missing step"


@pytest.mark.asyncio
async def test_delete_last_node_returns_400(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """Deleting the last remaining step of a journey returns 400.

    A custom journey starts with 3 nodes. We delete 2 of them to leave 1,
    then attempt to delete the final step. That must be rejected with 400.
    The journey must be unchanged — the remaining step must still be present.
    """
    member_id = await _relate(client, member_tokens, chw_tokens)
    journey = await _create_custom_journey(client, chw_tokens, member_id, "Last Step Guard")
    journey_id = journey["id"]

    steps = sorted(journey["steps"], key=lambda s: s["step_order"])
    assert len(steps) == 3

    # Delete step 3 (last), then step 2.
    for step in reversed(steps[1:]):  # steps[2] then steps[1]
        del_res = await client.delete(
            f"/api/v1/journeys/{journey_id}/nodes/{step['template_step_id']}",
            headers=auth_header(chw_tokens),
        )
        assert del_res.status_code == 200, (
            f"Expected 200 deleting step, got {del_res.status_code}: {del_res.text}"
        )

    # Now only 1 step remains. Attempt to delete it.
    last_step_id = steps[0]["template_step_id"]
    guard_res = await client.delete(
        f"/api/v1/journeys/{journey_id}/nodes/{last_step_id}",
        headers=auth_header(chw_tokens),
    )
    assert guard_res.status_code == 400, (
        f"Expected 400 when deleting last step, got {guard_res.status_code}: {guard_res.text}"
    )

    # The journey must still have 1 step — no orphaning occurred.
    get_res = await client.get(
        f"/api/v1/journeys/{journey_id}",
        headers=auth_header(chw_tokens),
    )
    assert get_res.status_code == 200, get_res.text
    assert len(get_res.json()["steps"]) == 1, (
        "Journey should still have exactly 1 step after rejected delete"
    )


# ─── Fork-to-member tests ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_fork_on_delete_node_makes_template_custom(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """Deleting a node on a BUILT-IN journey forks the template to a private custom
    copy: template.is_custom becomes True and steps are cloned."""
    await _seed_templates()
    member_id = await _relate(client, member_tokens, chw_tokens)
    journey = await _create_standard_journey(client, chw_tokens, member_id)
    journey_id = journey["id"]
    steps = sorted(journey["steps"], key=lambda s: s["step_order"])

    # Capture the original template id before the fork.
    async with test_session() as db:
        mj = (await db.execute(
            select(MemberJourney).where(MemberJourney.id == UUID(journey_id))
        )).scalar_one()
        original_template_id = mj.template_id

    # The original template must be non-custom (built-in).
    async with test_session() as db:
        original_template = (await db.execute(
            select(JourneyTemplate).where(JourneyTemplate.id == original_template_id)
        )).scalar_one()
    assert not original_template.is_custom, "Pre-condition: must start with built-in template"
    assert len(steps) >= 2, "Pre-condition: need at least 2 steps to delete one"

    # Delete the FIRST step — this is a structural edit on a built-in journey.
    first_step_id = steps[0]["template_step_id"]
    del_res = await client.delete(
        f"/api/v1/journeys/{journey_id}/nodes/{first_step_id}",
        headers=auth_header(chw_tokens),
    )
    assert del_res.status_code == 200, del_res.text

    # After the delete: MemberJourney must point to a NEW custom template.
    async with test_session() as db:
        mj_after = (await db.execute(
            select(MemberJourney).where(MemberJourney.id == UUID(journey_id))
        )).scalar_one()
        new_template_id = mj_after.template_id

    assert new_template_id != original_template_id, "template_id must change after fork"

    async with test_session() as db:
        new_template = (await db.execute(
            select(JourneyTemplate).where(JourneyTemplate.id == new_template_id)
        )).scalar_one()
    assert new_template.is_custom is True, "forked template must be is_custom=True"
    assert new_template.slug == f"custom-{journey_id}", (
        "slug must follow custom-<journey_id> scheme"
    )


@pytest.mark.asyncio
async def test_fork_on_add_node_makes_template_custom(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """Adding a node on a BUILT-IN journey forks the template to a private custom copy."""
    await _seed_templates()
    member_id = await _relate(client, member_tokens, chw_tokens)
    journey = await _create_standard_journey(client, chw_tokens, member_id)
    journey_id = journey["id"]

    async with test_session() as db:
        mj = (await db.execute(
            select(MemberJourney).where(MemberJourney.id == UUID(journey_id))
        )).scalar_one()
        original_template_id = mj.template_id

    add_res = await client.post(
        f"/api/v1/journeys/{journey_id}/nodes",
        json={"name": "Extra Step", "description": "Added by CHW"},
        headers=auth_header(chw_tokens),
    )
    assert add_res.status_code == 201, add_res.text

    async with test_session() as db:
        mj_after = (await db.execute(
            select(MemberJourney).where(MemberJourney.id == UUID(journey_id))
        )).scalar_one()
        new_template = (await db.execute(
            select(JourneyTemplate).where(JourneyTemplate.id == mj_after.template_id)
        )).scalar_one()

    assert mj_after.template_id != original_template_id
    assert new_template.is_custom is True
    # Response should include the new extra node (one more than the original steps).
    assert len(add_res.json()["steps"]) == len(journey["steps"]) + 1


@pytest.mark.asyncio
async def test_fork_preserves_member_step_progress(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """After a fork, the member's prior step completion (status, points) is preserved
    on the cloned step states."""
    await _seed_templates()
    member_id = await _relate(client, member_tokens, chw_tokens)
    journey = await _create_standard_journey(client, chw_tokens, member_id)
    journey_id = journey["id"]
    steps = sorted(journey["steps"], key=lambda s: s["step_order"])

    # Complete step 1 (awards points).
    step1_id = steps[0]["template_step_id"]
    complete_res = await client.patch(
        f"/api/v1/journeys/{journey_id}/steps/{step1_id}",
        json={"status": "completed"},
        headers=auth_header(chw_tokens),
    )
    assert complete_res.status_code == 200, complete_res.text
    step1_points = steps[0]["points_on_completion"]

    # Trigger fork by deleting step 2 (not step 1, so step 1's completed state is tested).
    step2_id = steps[1]["template_step_id"]
    del_res = await client.delete(
        f"/api/v1/journeys/{journey_id}/nodes/{step2_id}",
        headers=auth_header(chw_tokens),
    )
    assert del_res.status_code == 200, del_res.text

    # After fork+delete, step 1's completion must still be in the response.
    updated_steps = sorted(del_res.json()["steps"], key=lambda s: s["step_order"])
    # Step 1 should still be completed with awarded points.
    assert updated_steps[0]["status"] == "completed", (
        "step 1 completion must survive the fork"
    )
    assert updated_steps[0]["points_awarded"] == step1_points, (
        "points_awarded must survive the fork"
    )

    # Wellness points ledger must still reflect the original award.
    pts_res = await client.get(
        f"/api/v1/members/{member_id}/wellness-points",
        headers=auth_header(chw_tokens),
    )
    assert pts_res.status_code == 200, pts_res.text
    pts = pts_res.json()
    # One positive award entry for step 1 completion.
    positive_entries = [e for e in pts["ledger"] if e["reason"] == "journey_step_completed"]
    assert len(positive_entries) == 1, (
        f"Expected 1 completion ledger entry, got: {pts['ledger']}"
    )


@pytest.mark.asyncio
async def test_fork_does_not_affect_other_members(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """A second member on the same built-in template still points to the ORIGINAL
    shared template with ALL original steps after member-1 forks."""
    await _seed_templates()

    # Member 1: related to CHW and given a built-in journey.
    member1_id = await _relate(client, member_tokens, chw_tokens)
    journey1 = await _create_standard_journey(client, chw_tokens, member1_id)
    journey1_id = journey1["id"]
    original_step_count = len(journey1["steps"])

    # Member 2: separate user, also related to the SAME CHW with the SAME template.
    member2_tokens = await _register_user(
        client, "member2fork@example.com", "member", "Member Two Fork"
    )
    member2_id = await _relate(client, member2_tokens, chw_tokens)
    journey2 = await _create_standard_journey(client, chw_tokens, member2_id)
    journey2_id = journey2["id"]

    # Capture member2's original template_id — must equal member1's original.
    async with test_session() as db:
        mj1_before = (await db.execute(
            select(MemberJourney).where(MemberJourney.id == UUID(journey1_id))
        )).scalar_one()
        mj2_before = (await db.execute(
            select(MemberJourney).where(MemberJourney.id == UUID(journey2_id))
        )).scalar_one()
    shared_template_id = mj1_before.template_id
    assert mj2_before.template_id == shared_template_id, (
        "Both members must start on same template"
    )

    # Member 1's CHW deletes a node — triggers fork for member 1.
    steps1 = sorted(journey1["steps"], key=lambda s: s["step_order"])
    del_res = await client.delete(
        f"/api/v1/journeys/{journey1_id}/nodes/{steps1[0]['template_step_id']}",
        headers=auth_header(chw_tokens),
    )
    assert del_res.status_code == 200, del_res.text

    # Member 1 now has a custom template.
    async with test_session() as db:
        mj1_after = (await db.execute(
            select(MemberJourney).where(MemberJourney.id == UUID(journey1_id))
        )).scalar_one()
    assert mj1_after.template_id != shared_template_id, (
        "Member 1 must be on forked template"
    )

    # Member 2 is still on the ORIGINAL shared template.
    async with test_session() as db:
        mj2_after = (await db.execute(
            select(MemberJourney).where(MemberJourney.id == UUID(journey2_id))
        )).scalar_one()
    assert mj2_after.template_id == shared_template_id, (
        "Member 2 must still be on shared template"
    )

    # Member 2's journey still has ALL original steps.
    async with test_session() as db:
        m2_steps = (await db.execute(
            select(JourneyTemplateStep)
            .where(JourneyTemplateStep.template_id == shared_template_id)
            .order_by(JourneyTemplateStep.order)
        )).scalars().all()
    assert len(list(m2_steps)) == original_step_count, (
        f"Original template must still have {original_step_count} steps, "
        f"got {len(list(m2_steps))}"
    )


@pytest.mark.asyncio
async def test_fork_is_idempotent_on_second_structural_edit(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """A second structural edit after the first fork does NOT create another fork
    (the template_id stays the same custom template)."""
    await _seed_templates()
    member_id = await _relate(client, member_tokens, chw_tokens)
    journey = await _create_standard_journey(client, chw_tokens, member_id)
    journey_id = journey["id"]

    # First structural edit: add a node → triggers fork.
    add_res1 = await client.post(
        f"/api/v1/journeys/{journey_id}/nodes",
        json={"name": "Added Step 1", "description": "First add"},
        headers=auth_header(chw_tokens),
    )
    assert add_res1.status_code == 201, add_res1.text

    async with test_session() as db:
        mj_after_first = (await db.execute(
            select(MemberJourney).where(MemberJourney.id == UUID(journey_id))
        )).scalar_one()
    template_id_after_first_fork = mj_after_first.template_id

    # Second structural edit: add another node → must NOT re-fork.
    add_res2 = await client.post(
        f"/api/v1/journeys/{journey_id}/nodes",
        json={"name": "Added Step 2", "description": "Second add"},
        headers=auth_header(chw_tokens),
    )
    assert add_res2.status_code == 201, add_res2.text

    async with test_session() as db:
        mj_after_second = (await db.execute(
            select(MemberJourney).where(MemberJourney.id == UUID(journey_id))
        )).scalar_one()

    assert mj_after_second.template_id == template_id_after_first_fork, (
        "template_id must not change on second structural edit (idempotent fork)"
    )

    # Confirm only ONE custom template with this journey's slug exists.
    async with test_session() as db:
        custom_template_count = (await db.execute(
            select(func.count()).select_from(JourneyTemplate).where(
                JourneyTemplate.slug == f"custom-{journey_id}"
            )
        )).scalar()
    assert custom_template_count == 1, (
        "Exactly one custom template should exist for this journey"
    )


@pytest.mark.asyncio
async def test_post_fork_delete_reorders_and_reverses_points(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """After a fork, delete still reorders remaining steps and reverses points for
    completed steps (standard delete behavior works on the forked template)."""
    await _seed_templates()
    member_id = await _relate(client, member_tokens, chw_tokens)
    journey = await _create_standard_journey(client, chw_tokens, member_id)
    journey_id = journey["id"]
    steps = sorted(journey["steps"], key=lambda s: s["step_order"])
    assert len(steps) >= 3, "Need at least 3 steps"

    # Complete step 1 to give it points.
    step1_id = steps[0]["template_step_id"]
    step1_points = steps[0]["points_on_completion"]
    await client.patch(
        f"/api/v1/journeys/{journey_id}/steps/{step1_id}",
        json={"status": "completed"},
        headers=auth_header(chw_tokens),
    )

    # Delete step 1 — this forks AND deletes (completed step → points reversal).
    del_res = await client.delete(
        f"/api/v1/journeys/{journey_id}/nodes/{step1_id}",
        headers=auth_header(chw_tokens),
    )
    assert del_res.status_code == 200, del_res.text
    body = del_res.json()

    # After deletion of original step 1, remaining steps should start at order 1.
    remaining = sorted(body["steps"], key=lambda s: s["step_order"])
    assert remaining[0]["step_order"] == 1, "Steps should be reordered starting at 1"

    # Points reversal: net balance should be 0 (awarded then reversed).
    pts_res = await client.get(
        f"/api/v1/members/{member_id}/wellness-points",
        headers=auth_header(chw_tokens),
    )
    assert pts_res.status_code == 200, pts_res.text
    pts = pts_res.json()
    assert pts["total_points"] == 0, (
        f"Expected net 0 points after delete-with-reversal, got {pts['total_points']}"
    )
    reasons = [e["reason"] for e in pts["ledger"]]
    assert "correction" in reasons, "Must have a correction ledger entry"


@pytest.mark.asyncio
async def test_unrelated_chw_cannot_edit_builtin_journey(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """A CHW who is NOT assigned to the journey gets 403 on structural edits,
    even if the journey is on a built-in template (fork gate must not change auth)."""
    await _seed_templates()
    member_id = await _relate(client, member_tokens, chw_tokens)
    journey = await _create_standard_journey(client, chw_tokens, member_id)
    journey_id = journey["id"]
    steps = sorted(journey["steps"], key=lambda s: s["step_order"])

    # Register a second CHW with NO relationship to this member.
    chw2_tokens = await _register_user(
        client, "chw2unrelated@example.com", "chw", "CHW Two Unrelated"
    )

    # Unrelated CHW tries to delete a node.
    del_res = await client.delete(
        f"/api/v1/journeys/{journey_id}/nodes/{steps[0]['template_step_id']}",
        headers=auth_header(chw2_tokens),
    )
    assert del_res.status_code == 403, (
        f"Expected 403, got {del_res.status_code}: {del_res.text}"
    )

    # Unrelated CHW tries to add a node.
    add_res = await client.post(
        f"/api/v1/journeys/{journey_id}/nodes",
        json={"name": "Unauthorized Step"},
        headers=auth_header(chw2_tokens),
    )
    assert add_res.status_code == 403, (
        f"Expected 403, got {add_res.status_code}: {add_res.text}"
    )


@pytest.mark.asyncio
async def test_delete_nonexistent_node_after_fork_returns_404(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """Deleting a non-existent step_id (random UUID) on a built-in journey returns 404
    even after the fork would have occurred."""
    await _seed_templates()
    member_id = await _relate(client, member_tokens, chw_tokens)
    journey = await _create_standard_journey(client, chw_tokens, member_id)
    journey_id = journey["id"]

    fake_step_id = str(uuid4())
    del_res = await client.delete(
        f"/api/v1/journeys/{journey_id}/nodes/{fake_step_id}",
        headers=auth_header(chw_tokens),
    )
    assert del_res.status_code == 404, (
        f"Expected 404 for nonexistent step, got {del_res.status_code}: {del_res.text}"
    )


# ─── Regression: split-brain rewards_balance bug ─────────────────────────────
#
# Before the fix, completing a journey step wrote only a WellnessPointsLedger
# row and never updated MemberProfile.rewards_balance. The balance endpoint
# (GET /members/{id}/rewards/balance) reads rewards_balance as its source of
# truth, so journey points never appeared there. The tests below FAIL on the
# pre-fix code and pass after.


@pytest.mark.asyncio
async def test_completing_step_credits_rewards_balance(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """Completing a journey step must increment MemberProfile.rewards_balance.

    Regression for: update_step_status wrote only the WellnessPointsLedger and
    never updated rewards_balance — so GET /rewards/balance showed 0 after a
    step completion.

    Asserts:
      - rewards_balance in DB increases by points_on_completion.
      - GET /members/{id}/rewards/balance returns the new current_balance.
    """
    await _seed_templates()
    member_id = await _relate(client, member_tokens, chw_tokens)
    member_uuid = UUID(member_id)

    journey = await _create_standard_journey(client, chw_tokens, member_id)
    journey_id = journey["id"]
    steps = sorted(journey["steps"], key=lambda s: s["step_order"])
    step1_id = steps[0]["template_step_id"]
    step1_points = steps[0]["points_on_completion"]
    assert step1_points > 0, "Template step 1 must have points_on_completion > 0"

    # Confirm baseline balance is zero before completion.
    async with test_session() as db:
        profile_before = (
            await db.execute(
                select(MemberProfile).where(MemberProfile.user_id == member_uuid)
            )
        ).scalar_one()
    assert profile_before.rewards_balance == 0, (
        f"Expected 0 balance before completion, got {profile_before.rewards_balance}"
    )

    # Complete step 1.
    patch_res = await client.patch(
        f"/api/v1/journeys/{journey_id}/steps/{step1_id}",
        json={"status": "completed"},
        headers=auth_header(chw_tokens),
    )
    assert patch_res.status_code == 200, patch_res.text

    # DB-level assertion: rewards_balance must have been incremented.
    async with test_session() as db:
        profile_after = (
            await db.execute(
                select(MemberProfile).where(MemberProfile.user_id == member_uuid)
            )
        ).scalar_one()
    assert profile_after.rewards_balance == step1_points, (
        f"Expected rewards_balance == {step1_points} after completion, "
        f"got {profile_after.rewards_balance} — balance was never updated (split-brain bug)"
    )

    # API-level assertion: GET /rewards/balance must reflect the new total.
    balance_res = await client.get(
        f"/api/v1/members/{member_id}/rewards/balance",
        headers=auth_header(member_tokens),
    )
    assert balance_res.status_code == 200, balance_res.text
    assert balance_res.json()["current_balance"] == step1_points, (
        f"rewards/balance endpoint returned {balance_res.json()['current_balance']}, "
        f"expected {step1_points}"
    )


@pytest.mark.asyncio
async def test_reversing_step_claws_back_rewards_balance(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """Reversing a completed step (complete → in_progress) must decrement
    MemberProfile.rewards_balance back to its pre-completion value.

    Regression: before the fix, reversal wrote a negative WellnessPointsLedger
    entry but never touched rewards_balance, so the balance remained inflated.
    """
    await _seed_templates()
    member_id = await _relate(client, member_tokens, chw_tokens)
    member_uuid = UUID(member_id)

    journey = await _create_standard_journey(client, chw_tokens, member_id)
    journey_id = journey["id"]
    steps = sorted(journey["steps"], key=lambda s: s["step_order"])
    step1_id = steps[0]["template_step_id"]
    step1_points = steps[0]["points_on_completion"]

    # Complete step 1.
    patch_res = await client.patch(
        f"/api/v1/journeys/{journey_id}/steps/{step1_id}",
        json={"status": "completed"},
        headers=auth_header(chw_tokens),
    )
    assert patch_res.status_code == 200, patch_res.text

    # Reverse step 1 back to in_progress.
    revert_res = await client.patch(
        f"/api/v1/journeys/{journey_id}/steps/{step1_id}",
        json={"status": "in_progress"},
        headers=auth_header(chw_tokens),
    )
    assert revert_res.status_code == 200, revert_res.text

    # DB: rewards_balance must be back to 0 (clamped, never negative).
    async with test_session() as db:
        profile = (
            await db.execute(
                select(MemberProfile).where(MemberProfile.user_id == member_uuid)
            )
        ).scalar_one()
    assert profile.rewards_balance == 0, (
        f"Expected rewards_balance == 0 after reversal, got {profile.rewards_balance} "
        f"— claw-back was not applied (split-brain bug)"
    )

    # API: GET /rewards/balance must show 0.
    balance_res = await client.get(
        f"/api/v1/members/{member_id}/rewards/balance",
        headers=auth_header(member_tokens),
    )
    assert balance_res.status_code == 200, balance_res.text
    assert balance_res.json()["current_balance"] == 0, (
        f"rewards/balance endpoint returned {balance_res.json()['current_balance']}, expected 0"
    )


@pytest.mark.asyncio
async def test_idempotent_completion_does_not_double_credit_balance(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """Completing an already-completed step twice must NOT double the balance.

    The idempotent no-op branch (completed → completed) must leave rewards_balance
    unchanged on the second call.
    """
    await _seed_templates()
    member_id = await _relate(client, member_tokens, chw_tokens)
    member_uuid = UUID(member_id)

    journey = await _create_standard_journey(client, chw_tokens, member_id)
    journey_id = journey["id"]
    steps = sorted(journey["steps"], key=lambda s: s["step_order"])
    step1_id = steps[0]["template_step_id"]
    step1_points = steps[0]["points_on_completion"]

    # First completion — valid credit.
    res1 = await client.patch(
        f"/api/v1/journeys/{journey_id}/steps/{step1_id}",
        json={"status": "completed"},
        headers=auth_header(chw_tokens),
    )
    assert res1.status_code == 200, res1.text

    # Second completion — must be a no-op.
    res2 = await client.patch(
        f"/api/v1/journeys/{journey_id}/steps/{step1_id}",
        json={"status": "completed"},
        headers=auth_header(chw_tokens),
    )
    assert res2.status_code == 200, res2.text

    async with test_session() as db:
        profile = (
            await db.execute(
                select(MemberProfile).where(MemberProfile.user_id == member_uuid)
            )
        ).scalar_one()
    assert profile.rewards_balance == step1_points, (
        f"Expected rewards_balance == {step1_points} (single credit), "
        f"got {profile.rewards_balance} — double-credit detected"
    )


@pytest.mark.asyncio
async def test_rewards_balance_never_goes_negative(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """Reversing a step when rewards_balance is already 0 must clamp at 0.

    Edge case: if the balance was manually zeroed (or was already 0 for another
    reason), a reversal must not push it below 0.
    """
    await _seed_templates()
    member_id = await _relate(client, member_tokens, chw_tokens)
    member_uuid = UUID(member_id)

    journey = await _create_standard_journey(client, chw_tokens, member_id)
    journey_id = journey["id"]
    steps = sorted(journey["steps"], key=lambda s: s["step_order"])
    step1_id = steps[0]["template_step_id"]

    # Complete step 1 to establish points_awarded on the step state.
    patch_res = await client.patch(
        f"/api/v1/journeys/{journey_id}/steps/{step1_id}",
        json={"status": "completed"},
        headers=auth_header(chw_tokens),
    )
    assert patch_res.status_code == 200, patch_res.text

    # Manually zero the balance (simulates an external adjustment or manual
    # redemption that drained the balance before the reversal arrives).
    async with test_session() as db:
        profile = (
            await db.execute(
                select(MemberProfile).where(MemberProfile.user_id == member_uuid)
            )
        ).scalar_one()
        profile.rewards_balance = 0
        await db.commit()

    # Reverse step 1 — balance is already 0; clamp must prevent going negative.
    revert_res = await client.patch(
        f"/api/v1/journeys/{journey_id}/steps/{step1_id}",
        json={"status": "in_progress"},
        headers=auth_header(chw_tokens),
    )
    assert revert_res.status_code == 200, revert_res.text

    async with test_session() as db:
        profile = (
            await db.execute(
                select(MemberProfile).where(MemberProfile.user_id == member_uuid)
            )
        ).scalar_one()
    assert profile.rewards_balance >= 0, (
        f"rewards_balance went negative ({profile.rewards_balance}) — clamp not applied"
    )

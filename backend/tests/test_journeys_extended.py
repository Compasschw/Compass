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
from sqlalchemy import select

from app.models.journeys import WellnessPointsLedger
from app.services.journey_seeds import seed_default_journey_templates
from tests.conftest import auth_header, test_session

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


# ─── Test 7: insert on standard journey returns 403/409 ───────────────────────


@pytest.mark.asyncio
async def test_insert_on_standard_journey_returns_403(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """POST /journeys/{id}/nodes on a standard (non-custom) journey returns 403 or 409.
    The custom-only gate in _load_custom_journey_for_chw raises 409 CONFLICT."""
    await _seed_templates()
    member_id = await _relate(client, member_tokens, chw_tokens)

    journey = await _create_standard_journey(client, chw_tokens, member_id)
    journey_id = journey["id"]

    insert_res = await client.post(
        f"/api/v1/journeys/{journey_id}/nodes",
        json={"name": "Should Not Work", "description": "This should fail"},
        headers=auth_header(chw_tokens),
    )
    assert insert_res.status_code in (403, 409), (
        f"Expected 403 or 409 for insert on standard journey, got {insert_res.status_code}: "
        f"{insert_res.text}"
    )


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

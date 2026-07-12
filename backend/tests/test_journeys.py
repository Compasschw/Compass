"""Integration tests for the Journeys feature.

Coverage:
  1. GET /journeys/templates — returns seeded templates after seed is called.
  2. POST /members/{id}/journeys — CHW without relationship gets 403.
  3. POST /members/{id}/journeys — creates MemberJourney + initializes step states.
  4. POST /members/{id}/journeys — duplicate active journey returns 409.
  5. PATCH /journeys/{id}/steps/{step_id} — completed awards points to ledger
     AND advances current_step_id.
  6. PATCH /journeys/{id}/steps/{step_id} — completing the final step marks
     journey as completed.
  7. GET /chw/journeys — returns only journeys for the authenticated CHW.
  8. GET /members/{id}/journeys — member can read own journeys.
  9. GET /members/{id}/journeys — member cannot read another member's journeys.
  10. GET /members/{id}/wellness-points — returns correct balance after step completion.
"""

import base64
import json

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.journeys import (
    MemberJourney,
    MemberJourneyStepState,
    WellnessPointsLedger,
)
from app.services.journey_seeds import seed_default_journey_templates
from tests.conftest import auth_header, test_session


# ─── Helpers ───────────────────────────────────────────────────────────────────


def _decode_jwt_sub(access_token: str) -> str:
    """Extract the 'sub' (user UUID string) from a JWT access token."""
    payload_segment = access_token.split(".")[1]
    padded = payload_segment + "=" * (4 - len(payload_segment) % 4)
    payload = json.loads(base64.urlsafe_b64decode(padded))
    return payload["sub"]


async def _register_user(client: AsyncClient, email: str, role: str, name: str) -> dict:
    """Register a user and return the token payload.

    Members must supply every Pear-required signup field (#14); the CIN is
    derived from the email so multiple members in one test stay distinct.
    """
    payload: dict = {
        "email": email, "password": "testpass123", "name": name, "role": role,
    }
    if role == "member":
        payload.update({
            "date_of_birth": "1990-01-01",
            "gender": "Female",
            "insurance_company": "Health Net",
            "medi_cal_id": f"{abs(hash(email)) % 100_000_000:08d}A",
            "zip_code": "90001",
            "terms_accepted": True,
            "communications_consent": True,
        })
    res = await client.post("/api/v1/auth/register", json=payload)
    assert res.status_code == 201, res.text
    return res.json()


async def _create_and_accept_request(
    client: AsyncClient, member_tokens: dict, chw_tokens: dict
) -> str:
    """Create a service request and have the CHW accept it. Returns request_id."""
    res = await client.post("/api/v1/requests/", json={
        "vertical": "food",
        "urgency": "routine",
        "description": "Need food assistance",
        "preferred_mode": "in_person",
    }, headers=auth_header(member_tokens))
    assert res.status_code == 201, res.text
    request_id = res.json()["id"]

    res = await client.patch(
        f"/api/v1/requests/{request_id}/accept",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    return request_id


async def _seed_templates(db: AsyncSession) -> None:
    """Seed the four default journey templates within the test DB session."""
    await seed_default_journey_templates(db)


# ─── Fixtures ──────────────────────────────────────────────────────────────────


@pytest.fixture
async def seeded_db():
    """Provide a test DB session with templates already seeded."""
    async with test_session() as db:
        await _seed_templates(db)
        yield db


@pytest.fixture
async def chw2_tokens(client: AsyncClient) -> dict:
    """A second CHW who has NO relationship with the default test member."""
    return await _register_user(client, "chw2@example.com", "chw", "CHW Two")


@pytest.fixture
async def member2_tokens(client: AsyncClient) -> dict:
    """A second member."""
    return await _register_user(client, "member2@example.com", "member", "Member Two")


# ─── Test 1: list templates ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_list_journey_templates_returns_seeded_data(
    client: AsyncClient, chw_tokens: dict, seeded_db: AsyncSession
):
    """GET /journeys/templates should return all active seeded templates."""
    res = await client.get(
        "/api/v1/journeys/templates",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    templates = res.json()
    slugs = {t["slug"] for t in templates}
    assert "food_assistance" in slugs
    assert "housing" in slugs
    assert "mental_health" in slugs
    assert "maternal_health" in slugs
    # Each template must have steps.
    for tpl in templates:
        assert len(tpl["steps"]) > 0, f"Template {tpl['slug']} has no steps"


# ─── Test 2: 403 without relationship ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_post_journey_403_without_relationship(
    client: AsyncClient,
    member_tokens: dict,
    chw2_tokens: dict,
    seeded_db: AsyncSession,
):
    """CHW2 has no session/request with the member → should receive 403."""
    member_id = _decode_jwt_sub(member_tokens["access_token"])
    res = await client.post(
        f"/api/v1/members/{member_id}/journeys",
        json={"member_id": member_id, "template_slug": "food_assistance"},
        headers=auth_header(chw2_tokens),
    )
    assert res.status_code == 403, res.text


# ─── Test 3: POST creates journey + step states ────────────────────────────────


@pytest.mark.asyncio
async def test_post_journey_creates_journey_and_step_states(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
    seeded_db: AsyncSession,
):
    """POST /members/{id}/journeys creates a MemberJourney with correct step states."""
    # Establish a relationship via service request.
    await _create_and_accept_request(client, member_tokens, chw_tokens)

    member_id = _decode_jwt_sub(member_tokens["access_token"])
    res = await client.post(
        f"/api/v1/members/{member_id}/journeys",
        json={"member_id": member_id, "template_slug": "food_assistance"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    data = res.json()

    # Journey fields.
    assert data["status"] == "active"
    assert data["member_id"] == member_id
    assert data["progress_percent"] == 0.0  # no steps completed yet

    # Steps initialized: 6 steps for food_assistance.
    assert len(data["steps"]) == 6

    # First step should be in_progress, rest upcoming.
    ordered = sorted(data["steps"], key=lambda s: s["step_order"])
    assert ordered[0]["status"] == "in_progress"
    for step in ordered[1:]:
        assert step["status"] == "upcoming"

    # current_step should be step 1.
    assert data["current_step"]["step_order"] == 1

    # Verify in the DB.
    async with test_session() as db:
        journey_result = await db.execute(
            select(MemberJourney).where(MemberJourney.id == data["id"])
        )
        db_journey = journey_result.scalar_one_or_none()
        assert db_journey is not None
        assert db_journey.status == "active"

        states_result = await db.execute(
            select(MemberJourneyStepState).where(
                MemberJourneyStepState.member_journey_id == db_journey.id
            )
        )
        states = states_result.scalars().all()
        assert len(states) == 6


# ─── Test 4: duplicate active journey returns 409 ─────────────────────────────


@pytest.mark.asyncio
async def test_post_journey_duplicate_returns_409(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
    seeded_db: AsyncSession,
):
    """Creating a second active journey for the same template should return 409."""
    await _create_and_accept_request(client, member_tokens, chw_tokens)
    member_id = _decode_jwt_sub(member_tokens["access_token"])

    payload = {"member_id": member_id, "template_slug": "food_assistance"}
    res1 = await client.post(
        f"/api/v1/members/{member_id}/journeys",
        json=payload,
        headers=auth_header(chw_tokens),
    )
    assert res1.status_code == 201, res1.text

    res2 = await client.post(
        f"/api/v1/members/{member_id}/journeys",
        json=payload,
        headers=auth_header(chw_tokens),
    )
    assert res2.status_code == 409, res2.text


# ─── Test 5: PATCH step completed awards points + advances current_step_id ────


@pytest.mark.asyncio
async def test_patch_step_completed_awards_points_and_advances(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
    seeded_db: AsyncSession,
):
    """Completing step 1 should write a ledger entry and advance to step 2."""
    await _create_and_accept_request(client, member_tokens, chw_tokens)
    member_id = _decode_jwt_sub(member_tokens["access_token"])

    # Create the journey.
    create_res = await client.post(
        f"/api/v1/members/{member_id}/journeys",
        json={"member_id": member_id, "template_slug": "food_assistance"},
        headers=auth_header(chw_tokens),
    )
    assert create_res.status_code == 201, create_res.text
    journey_data = create_res.json()
    journey_id = journey_data["id"]

    # Find step 1's template_step_id.
    steps = sorted(journey_data["steps"], key=lambda s: s["step_order"])
    step1_template_step_id = steps[0]["template_step_id"]
    step1_points_on_completion = steps[0]["points_on_completion"]

    # PATCH step 1 to completed.
    patch_res = await client.patch(
        f"/api/v1/journeys/{journey_id}/steps/{step1_template_step_id}",
        json={"status": "completed", "notes": "Step 1 done"},
        headers=auth_header(chw_tokens),
    )
    assert patch_res.status_code == 200, patch_res.text
    updated = patch_res.json()

    # Step 1 should be completed.
    updated_steps = sorted(updated["steps"], key=lambda s: s["step_order"])
    assert updated_steps[0]["status"] == "completed"
    assert updated_steps[0]["points_awarded"] == step1_points_on_completion

    # Step 2 should now be in_progress.
    assert updated_steps[1]["status"] == "in_progress"

    # current_step should be step 2.
    assert updated["current_step"]["step_order"] == 2

    # Progress percent should be 1/6 * 100 ≈ 16.7%.
    assert updated["progress_percent"] > 0.0

    # Wellness points earned should equal step1's points.
    assert updated["wellness_points_earned"] == step1_points_on_completion

    # Verify the WellnessPointsLedger row was created.
    async with test_session() as db:
        ledger_result = await db.execute(
            select(WellnessPointsLedger).where(
                WellnessPointsLedger.member_id == member_id
            )
        )
        ledger_rows = ledger_result.scalars().all()
        assert len(ledger_rows) == 1
        assert ledger_rows[0].points == step1_points_on_completion
        assert ledger_rows[0].reason == "journey_step_completed"


# ─── Test 6: completing last step marks journey completed ─────────────────────


@pytest.mark.asyncio
async def test_completing_all_steps_marks_journey_completed(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
    seeded_db: AsyncSession,
):
    """Completing all steps of a journey should set journey status to 'completed'."""
    await _create_and_accept_request(client, member_tokens, chw_tokens)
    member_id = _decode_jwt_sub(member_tokens["access_token"])

    # Use maternal_health (5 steps — shorter to iterate through in tests).
    create_res = await client.post(
        f"/api/v1/members/{member_id}/journeys",
        json={"member_id": member_id, "template_slug": "maternal_health"},
        headers=auth_header(chw_tokens),
    )
    assert create_res.status_code == 201, create_res.text
    journey_data = create_res.json()
    journey_id = journey_data["id"]
    steps = sorted(journey_data["steps"], key=lambda s: s["step_order"])

    latest = journey_data
    for step in steps:
        step_id = step["template_step_id"]
        res = await client.patch(
            f"/api/v1/journeys/{journey_id}/steps/{step_id}",
            json={"status": "completed"},
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 200, res.text
        latest = res.json()

    assert latest["status"] == "completed"
    assert latest["completed_at"] is not None
    assert latest["current_step"] is None
    assert latest["progress_percent"] == 100.0


# ─── Test 7: GET /chw/journeys returns only own journeys ──────────────────────


@pytest.mark.asyncio
async def test_chw_journeys_returns_only_own_caseload(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
    chw2_tokens: dict,
    member2_tokens: dict,
    seeded_db: AsyncSession,
):
    """GET /chw/journeys must not return journeys assigned to a different CHW."""
    # CHW1 <-> member1
    await _create_and_accept_request(client, member_tokens, chw_tokens)
    member_id = _decode_jwt_sub(member_tokens["access_token"])
    res = await client.post(
        f"/api/v1/members/{member_id}/journeys",
        json={"member_id": member_id, "template_slug": "food_assistance"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    chw1_journey_id = res.json()["id"]

    # CHW2 <-> member2 — separate relationship.
    res2 = await client.post("/api/v1/requests/", json={
        "vertical": "food",
        "urgency": "routine",
        "description": "Need food assistance",
        "preferred_mode": "in_person",
    }, headers=auth_header(member2_tokens))
    assert res2.status_code == 201, res2.text
    request2_id = res2.json()["id"]
    await client.patch(
        f"/api/v1/requests/{request2_id}/accept",
        headers=auth_header(chw2_tokens),
    )
    member2_id = _decode_jwt_sub(member2_tokens["access_token"])
    res3 = await client.post(
        f"/api/v1/members/{member2_id}/journeys",
        json={"member_id": member2_id, "template_slug": "food_assistance"},
        headers=auth_header(chw2_tokens),
    )
    assert res3.status_code == 201, res3.text
    chw2_journey_id = res3.json()["id"]

    # CHW1's caseload view.
    chw1_view = await client.get(
        "/api/v1/chw/journeys",
        headers=auth_header(chw_tokens),
    )
    assert chw1_view.status_code == 200, chw1_view.text
    chw1_ids = {j["id"] for j in chw1_view.json()}
    assert chw1_journey_id in chw1_ids
    assert chw2_journey_id not in chw1_ids

    # CHW2's caseload view.
    chw2_view = await client.get(
        "/api/v1/chw/journeys",
        headers=auth_header(chw2_tokens),
    )
    assert chw2_view.status_code == 200, chw2_view.text
    chw2_ids = {j["id"] for j in chw2_view.json()}
    assert chw2_journey_id in chw2_ids
    assert chw1_journey_id not in chw2_ids


# ─── Test 8: member can read own journeys ─────────────────────────────────────


@pytest.mark.asyncio
async def test_member_can_read_own_journeys(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
    seeded_db: AsyncSession,
):
    """GET /members/{id}/journeys should succeed when called by the member themselves."""
    await _create_and_accept_request(client, member_tokens, chw_tokens)
    member_id = _decode_jwt_sub(member_tokens["access_token"])
    await client.post(
        f"/api/v1/members/{member_id}/journeys",
        json={"member_id": member_id, "template_slug": "food_assistance"},
        headers=auth_header(chw_tokens),
    )

    res = await client.get(
        f"/api/v1/members/{member_id}/journeys",
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 200, res.text
    assert len(res.json()) == 1


# ─── Test 9: member cannot read another member's journeys ─────────────────────


@pytest.mark.asyncio
async def test_member_cannot_read_another_members_journeys(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
    member2_tokens: dict,
    seeded_db: AsyncSession,
):
    """A member should get 403 when requesting another member's journeys."""
    await _create_and_accept_request(client, member_tokens, chw_tokens)
    member_id = _decode_jwt_sub(member_tokens["access_token"])
    await client.post(
        f"/api/v1/members/{member_id}/journeys",
        json={"member_id": member_id, "template_slug": "food_assistance"},
        headers=auth_header(chw_tokens),
    )

    # Member2 tries to read member1's journeys.
    res = await client.get(
        f"/api/v1/members/{member_id}/journeys",
        headers=auth_header(member2_tokens),
    )
    assert res.status_code == 403, res.text


# ─── Test 10: wellness-points balance after step completion ───────────────────


@pytest.mark.asyncio
async def test_wellness_points_balance_after_step_completion(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
    seeded_db: AsyncSession,
):
    """GET /members/{id}/wellness-points should reflect completed step points."""
    await _create_and_accept_request(client, member_tokens, chw_tokens)
    member_id = _decode_jwt_sub(member_tokens["access_token"])

    create_res = await client.post(
        f"/api/v1/members/{member_id}/journeys",
        json={"member_id": member_id, "template_slug": "food_assistance"},
        headers=auth_header(chw_tokens),
    )
    assert create_res.status_code == 201, create_res.text
    journey_id = create_res.json()["id"]
    steps = sorted(create_res.json()["steps"], key=lambda s: s["step_order"])

    # Complete step 1.
    step1_id = steps[0]["template_step_id"]
    step1_points = steps[0]["points_on_completion"]
    await client.patch(
        f"/api/v1/journeys/{journey_id}/steps/{step1_id}",
        json={"status": "completed"},
        headers=auth_header(chw_tokens),
    )

    # Check the member's wellness-points balance via the CHW (has relationship).
    res = await client.get(
        f"/api/v1/members/{member_id}/wellness-points",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["total_points"] == step1_points
    assert len(data["ledger"]) == 1
    assert data["ledger"][0]["reason"] == "journey_step_completed"
    assert data["ledger"][0]["points"] == step1_points


# ─── Test 11: GET /journeys/{id} returns full detail for the assigned CHW ──────


@pytest.mark.asyncio
async def test_chw_journey_detail_returns_steps_and_current(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
    seeded_db: AsyncSession,
):
    """GET /journeys/{id} should return the full ordered step list + current step."""
    await _create_and_accept_request(client, member_tokens, chw_tokens)
    member_id = _decode_jwt_sub(member_tokens["access_token"])

    create_res = await client.post(
        f"/api/v1/members/{member_id}/journeys",
        json={"member_id": member_id, "template_slug": "food_assistance"},
        headers=auth_header(chw_tokens),
    )
    assert create_res.status_code == 201, create_res.text
    journey_id = create_res.json()["id"]

    detail = await client.get(
        f"/api/v1/journeys/{journey_id}",
        headers=auth_header(chw_tokens),
    )
    assert detail.status_code == 200, detail.text
    body = detail.json()
    assert body["id"] == journey_id
    assert len(body["steps"]) >= 1
    # Steps are returned in template order.
    orders = [s["step_order"] for s in body["steps"]]
    assert orders == sorted(orders)
    # A freshly-created journey has a current step (the first one).
    assert body["current_step"] is not None


# ─── Test 12: GET /journeys/{id} is 403 for a non-assigned CHW ────────────────


@pytest.mark.asyncio
async def test_chw_journey_detail_403_for_other_chw(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
    chw2_tokens: dict,
    seeded_db: AsyncSession,
):
    """A CHW who is not the assigned chw_id must get 403, never the journey detail."""
    await _create_and_accept_request(client, member_tokens, chw_tokens)
    member_id = _decode_jwt_sub(member_tokens["access_token"])

    create_res = await client.post(
        f"/api/v1/members/{member_id}/journeys",
        json={"member_id": member_id, "template_slug": "food_assistance"},
        headers=auth_header(chw_tokens),
    )
    assert create_res.status_code == 201, create_res.text
    journey_id = create_res.json()["id"]

    # CHW2 (no relationship to this journey) attempts to read it.
    res = await client.get(
        f"/api/v1/journeys/{journey_id}",
        headers=auth_header(chw2_tokens),
    )
    assert res.status_code == 403, res.text

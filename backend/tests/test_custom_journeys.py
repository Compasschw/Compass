"""Tests for CHW-authored custom journeys (POST /journeys/custom + nodes).

Coverage:
  - Create a custom journey → 201 with 3 blank nodes worth 10/5/5 points,
    node 1 in_progress.
  - Add a node → 4th node worth 5 points.
  - Edit a node's name/description.
  - A CHW with no relationship cannot create; a different CHW cannot add nodes.
"""

from __future__ import annotations

import base64
import json
from uuid import UUID

import pytest
from httpx import AsyncClient

from tests.conftest import auth_header


def _member_id(tokens: dict) -> str:
    payload_b64 = tokens["access_token"].split(".")[1]
    padded = payload_b64 + "=" * (4 - len(payload_b64) % 4)
    return str(UUID(json.loads(base64.urlsafe_b64decode(padded).decode())["sub"]))


async def _relate(client: AsyncClient, member_tokens: dict, chw_tokens: dict) -> str:
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
        f"/api/v1/requests/{rid}/accept", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200, res.text
    return _member_id(member_tokens)


@pytest.mark.asyncio
async def test_create_custom_journey_three_blank_nodes(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    member_id = await _relate(client, member_tokens, chw_tokens)
    res = await client.post(
        "/api/v1/journeys/custom",
        json={"member_id": member_id, "title": "Rehab"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["template"]["name"] == "Rehab"
    steps = sorted(body["steps"], key=lambda s: s["step_order"])
    assert len(steps) == 3
    assert [s["points_on_completion"] for s in steps] == [10, 5, 5]
    assert all(s["step_name"] == "" for s in steps)  # blank, CHW fills in
    assert steps[0]["status"] == "in_progress"


@pytest.mark.asyncio
async def test_add_and_edit_journey_node(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    member_id = await _relate(client, member_tokens, chw_tokens)
    res = await client.post(
        "/api/v1/journeys/custom",
        json={"member_id": member_id, "title": "Food Security"},
        headers=auth_header(chw_tokens),
    )
    journey_id = res.json()["id"]

    # Add a 4th node — worth 5 points.
    res = await client.post(
        f"/api/v1/journeys/{journey_id}/nodes",
        json={"name": "Apply for CalFresh", "description": "Submit the form"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    steps = sorted(res.json()["steps"], key=lambda s: s["step_order"])
    assert len(steps) == 4
    assert steps[3]["points_on_completion"] == 5
    assert steps[3]["step_name"] == "Apply for CalFresh"
    node_id = steps[3]["template_step_id"]

    # Edit that node's description.
    res = await client.patch(
        f"/api/v1/journeys/{journey_id}/nodes/{node_id}",
        json={"description": "Submit the CalFresh form online"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    edited = next(s for s in res.json()["steps"] if s["template_step_id"] == node_id)
    assert edited["step_description"] == "Submit the CalFresh form online"


@pytest.mark.asyncio
async def test_unrelated_chw_cannot_create_custom_journey(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """No relationship → 403."""
    unrelated_member_id = _member_id(member_tokens)  # no request/accept
    res = await client.post(
        "/api/v1/journeys/custom",
        json={"member_id": unrelated_member_id, "title": "Rehab"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 403, res.text


# ── Priority level on custom needs/journeys ───────────────────────────────────


@pytest.mark.asyncio
async def test_custom_journey_defaults_to_high_priority(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """A custom journey with no explicit priority defaults to 'high' (matches the
    fixed-need behaviour where a newly added need defaults to High)."""
    member_id = await _relate(client, member_tokens, chw_tokens)
    res = await client.post(
        "/api/v1/journeys/custom",
        json={"member_id": member_id, "title": "Legal Aid"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    assert res.json()["priority_level"] == "high"


@pytest.mark.asyncio
async def test_custom_journey_accepts_explicit_priority(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    member_id = await _relate(client, member_tokens, chw_tokens)
    res = await client.post(
        "/api/v1/journeys/custom",
        json={"member_id": member_id, "title": "Childcare", "priority_level": "low"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    assert res.json()["priority_level"] == "low"


@pytest.mark.asyncio
async def test_update_custom_journey_priority(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """PATCH /journeys/{id}/priority updates the level and persists it."""
    member_id = await _relate(client, member_tokens, chw_tokens)
    create = await client.post(
        "/api/v1/journeys/custom",
        json={"member_id": member_id, "title": "Childcare", "priority_level": "high"},
        headers=auth_header(chw_tokens),
    )
    journey_id = create.json()["id"]

    res = await client.patch(
        f"/api/v1/journeys/{journey_id}/priority",
        json={"priority_level": "medium"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    assert res.json()["priority_level"] == "medium"

    # Persisted: re-fetch the member's journeys and confirm.
    listing = await client.get(
        f"/api/v1/members/{member_id}/journeys", headers=auth_header(chw_tokens)
    )
    assert listing.status_code == 200, listing.text
    match = next(j for j in listing.json() if j["id"] == journey_id)
    assert match["priority_level"] == "medium"


@pytest.mark.asyncio
async def test_update_priority_rejects_unrelated_chw(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """A CHW who isn't the journey's assigned CHW cannot change its priority."""
    member_id = await _relate(client, member_tokens, chw_tokens)
    create = await client.post(
        "/api/v1/journeys/custom",
        json={"member_id": member_id, "title": "Childcare"},
        headers=auth_header(chw_tokens),
    )
    journey_id = create.json()["id"]

    other = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "other_chw_prio@example.com",
            "password": "testpass123",
            "name": "Other CHW",
            "role": "chw",
        },
    )
    assert other.status_code == 201, other.text

    res = await client.patch(
        f"/api/v1/journeys/{journey_id}/priority",
        json={"priority_level": "low"},
        headers=auth_header(other.json()),
    )
    assert res.status_code == 403, res.text


@pytest.mark.asyncio
async def test_remove_custom_journey_abandons_it(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """DELETE /journeys/{id} abandons a custom journey; it drops out of the
    active-journey list."""
    member_id = await _relate(client, member_tokens, chw_tokens)
    create = await client.post(
        "/api/v1/journeys/custom",
        json={"member_id": member_id, "title": "Childcare"},
        headers=auth_header(chw_tokens),
    )
    journey_id = create.json()["id"]

    res = await client.delete(
        f"/api/v1/journeys/{journey_id}", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "abandoned"

    # No longer present among the member's active journeys.
    listing = await client.get(
        f"/api/v1/members/{member_id}/journeys", headers=auth_header(chw_tokens)
    )
    active_ids = [j["id"] for j in listing.json() if j["status"] == "active"]
    assert journey_id not in active_ids


@pytest.mark.asyncio
async def test_remove_rejects_unrelated_chw(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """A CHW who isn't the journey's assigned CHW cannot remove it."""
    member_id = await _relate(client, member_tokens, chw_tokens)
    create = await client.post(
        "/api/v1/journeys/custom",
        json={"member_id": member_id, "title": "Childcare"},
        headers=auth_header(chw_tokens),
    )
    journey_id = create.json()["id"]

    other = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "other_chw_remove@example.com",
            "password": "testpass123",
            "name": "Other CHW",
            "role": "chw",
        },
    )
    assert other.status_code == 201, other.text

    res = await client.delete(
        f"/api/v1/journeys/{journey_id}", headers=auth_header(other.json())
    )
    assert res.status_code == 403, res.text


@pytest.mark.asyncio
async def test_remove_canonical_journey_also_drops_the_need(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """Removing a canonical journey abandons it AND drops the matching resource
    need, so a later reconcile won't recreate it."""
    member_id = await _relate(client, member_tokens, chw_tokens)

    # Create the canonical Employment journey via the resource-needs flow.
    res = await client.patch(
        f"/api/v1/chw/members/{member_id}/resource-needs",
        json={"needs": ["employment"], "levels": [{"slug": "employment", "level": "high"}]},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    listing = await client.get(
        f"/api/v1/members/{member_id}/journeys", headers=auth_header(chw_tokens)
    )
    journey = next(
        j for j in listing.json()
        if j["template"]["name"] == "Employment" and j["status"] == "active"
    )

    # Remove it.
    res = await client.delete(
        f"/api/v1/journeys/{journey['id']}", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "abandoned"

    # The resource need is gone from the member's profile.
    detail = await client.get(
        f"/api/v1/chw/members/{member_id}", headers=auth_header(chw_tokens)
    )
    assert "employment" not in detail.json()["resource_needs"]

    # And no active Employment journey remains.
    listing2 = await client.get(
        f"/api/v1/members/{member_id}/journeys", headers=auth_header(chw_tokens)
    )
    assert not any(
        j["template"]["name"] == "Employment" and j["status"] == "active"
        for j in listing2.json()
    )

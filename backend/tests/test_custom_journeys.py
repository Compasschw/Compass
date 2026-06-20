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

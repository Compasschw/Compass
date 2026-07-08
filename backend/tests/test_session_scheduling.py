"""Tests for POST /api/v1/sessions/schedule — CHW member-direct scheduling.

Coverage:
  - A CHW can schedule a session with a related member (returns 201 with the
    scheduling fields); it shows up in the CHW's sessions list.
  - A CHW cannot schedule with an unrelated member (403 relationship gate).
"""

from __future__ import annotations

import base64
import json
from uuid import UUID

import pytest
from httpx import AsyncClient

from tests.conftest import auth_header, complete_member_signup_payload


def _member_id(tokens: dict) -> str:
    payload_b64 = tokens["access_token"].split(".")[1]
    padded = payload_b64 + "=" * (4 - len(payload_b64) % 4)
    return str(UUID(json.loads(base64.urlsafe_b64decode(padded).decode())["sub"]))


async def _establish_relationship(
    client: AsyncClient, member_tokens: dict, chw_tokens: dict
) -> str:
    """Member files a request, CHW accepts it → care relationship. Returns member_id."""
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
        f"/api/v1/requests/{request_id}/accept", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200, res.text
    return _member_id(member_tokens)


@pytest.mark.asyncio
async def test_chw_schedules_with_related_member(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)

    res = await client.post(
        "/api/v1/sessions/schedule",
        json={
            "member_id": member_id,
            "scheduled_at": "2026-07-01T17:00:00Z",
            "scheduled_end_at": "2026-07-01T18:00:00Z",
            "mode": "phone",
            "scheduling_status": "confirmed",
            "notes": "Follow-up call",
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["member_id"] == member_id
    assert body["mode"] == "phone"
    assert body["status"] == "scheduled"
    assert body["scheduling_status"] == "confirmed"
    assert body["scheduled_end_at"] is not None

    # It appears in the CHW's sessions list (feeds the calendar).
    res = await client.get("/api/v1/sessions/", headers=auth_header(chw_tokens))
    assert res.status_code == 200, res.text
    assert any(s["id"] == body["id"] for s in res.json())


@pytest.mark.asyncio
async def test_chw_cannot_schedule_with_unrelated_member(
    client: AsyncClient, chw_tokens: dict, setup_db
):
    """No shared session and no matched request → 403."""
    # Register a fresh, unrelated member.
    payload = complete_member_signup_payload(
        email="unrelated_sched@example.com", name="Unrelated Member"
    )
    payload["medi_cal_id"] = "87654321B"
    res = await client.post("/api/v1/auth/register", json=payload)
    assert res.status_code == 201, res.text
    unrelated_member_id = _member_id(res.json())
    res = await client.post(
        "/api/v1/sessions/schedule",
        json={
            "member_id": unrelated_member_id,
            "scheduled_at": "2026-07-01T17:00:00Z",
            "mode": "in_person",
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 403, res.text


@pytest.mark.asyncio
async def test_member_schedules_with_their_chw(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """A member can schedule with their CHW. The booking is forced to pending
    (a request the CHW confirms) and appears on BOTH sessions lists.
    """
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)
    chw_id = _member_id(chw_tokens)  # CHW's user id (sub claim)

    res = await client.post(
        "/api/v1/sessions/schedule",
        json={
            "chw_id": chw_id,
            "scheduled_at": "2026-07-02T17:00:00Z",
            "scheduled_end_at": "2026-07-02T18:00:00Z",
            "mode": "phone",
            # Even if the member sends confirmed, the server forces pending.
            "scheduling_status": "confirmed",
        },
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["member_id"] == member_id
    assert body["chw_id"] == chw_id
    assert body["status"] == "scheduled"
    assert body["scheduling_status"] == "pending"

    # Appears on the member's calendar…
    res = await client.get("/api/v1/sessions/", headers=auth_header(member_tokens))
    assert any(s["id"] == body["id"] for s in res.json()), "missing from member list"
    # …and the CHW's (surfaces as a pending session to confirm).
    res = await client.get("/api/v1/sessions/", headers=auth_header(chw_tokens))
    assert any(s["id"] == body["id"] for s in res.json()), "missing from CHW list"


@pytest.mark.asyncio
async def test_member_cannot_schedule_with_unrelated_chw(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """No care relationship → 403."""
    chw_id = _member_id(chw_tokens)
    res = await client.post(
        "/api/v1/sessions/schedule",
        json={
            "chw_id": chw_id,
            "scheduled_at": "2026-07-02T17:00:00Z",
            "mode": "phone",
        },
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 403, res.text

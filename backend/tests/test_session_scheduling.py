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


async def _member_pending_session_id(
    client: AsyncClient, member_tokens: dict, chw_tokens: dict
) -> str:
    """Establish a relationship, member schedules → returns the pending session id."""
    await _establish_relationship(client, member_tokens, chw_tokens)
    chw_id = _member_id(chw_tokens)
    res = await client.post(
        "/api/v1/sessions/schedule",
        json={"chw_id": chw_id, "scheduled_at": "2026-07-03T17:00:00Z", "mode": "phone"},
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 201, res.text
    assert res.json()["scheduling_status"] == "pending"
    return res.json()["id"]


@pytest.mark.asyncio
async def test_chw_confirms_member_pending_session(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """The owning CHW confirms a member-proposed pending session → confirmed.
    The member cannot confirm their OWN proposal (409 — initiator-inversion
    rule; the member is a legitimate participant, just not the party allowed
    to act on a proposal they themselves made — see
    test_session_confirm_decline_participants.py for the full inversion
    matrix)."""
    sid = await _member_pending_session_id(client, member_tokens, chw_tokens)

    res = await client.patch(
        f"/api/v1/sessions/{sid}/confirm", headers=auth_header(member_tokens)
    )
    assert res.status_code == 409, res.text

    res = await client.patch(
        f"/api/v1/sessions/{sid}/confirm", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200, res.text
    assert res.json()["scheduling_status"] == "confirmed"
    assert res.json()["status"] == "scheduled"

    # A confirmation message posts to the shared thread — the member sees it too.
    assert await _thread_has_message(client, member_tokens, "confirmed")


@pytest.mark.asyncio
async def test_chw_declines_member_pending_session(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """The owning CHW declines a member's pending session → cancelled, and a
    rejection message posts to the shared thread."""
    sid = await _member_pending_session_id(client, member_tokens, chw_tokens)

    res = await client.patch(
        f"/api/v1/sessions/{sid}/decline", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "cancelled"

    assert await _thread_has_message(client, member_tokens, "declined")


async def _thread_has_message(client: AsyncClient, tokens: dict, needle: str) -> bool:
    """True when the caller's first conversation contains a message with `needle`."""
    convos = await client.get("/api/v1/conversations/", headers=auth_header(tokens))
    assert convos.status_code == 200, convos.text
    items = convos.json()
    if not items:
        return False
    conv_id = items[0]["id"]
    msgs = await client.get(
        f"/api/v1/conversations/{conv_id}/messages", headers=auth_header(tokens)
    )
    assert msgs.status_code == 200, msgs.text
    return any(needle.lower() in m["body"].lower() for m in msgs.json())


@pytest.mark.asyncio
async def test_member_cancels_own_session(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """A member removes their own scheduled session → cancelled + thread message.
    A non-participant cannot (404)."""
    sid = await _member_pending_session_id(client, member_tokens, chw_tokens)

    # A stranger CHW (not on the session) cannot cancel it.
    stranger = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "stranger_cancel@example.com",
            "password": "Testpass123!",
            "name": "Stranger CHW",
            "role": "chw",
        },
    )
    assert stranger.status_code == 201, stranger.text
    res = await client.patch(
        f"/api/v1/sessions/{sid}/cancel", headers=auth_header(stranger.json())
    )
    assert res.status_code == 404, res.text

    # The member cancels their own session.
    res = await client.patch(
        f"/api/v1/sessions/{sid}/cancel", headers=auth_header(member_tokens)
    )
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "cancelled"
    assert await _thread_has_message(client, member_tokens, "cancelled")


# ─── Epic L — Resource Needs replaces the free-text Notes field ─────────────
#
# The CHW "Schedule Session" modal no longer sends `notes`; it sends
# `resource_needs`: a list of Vertical enum values (Housing, Food,
# Transportation, ...). Coverage:
#   - scheduling with resource_needs persists + returns them
#   - an unknown vertical value is rejected (422) before the handler runs
#   - a session predating this field (no resource_needs ever sent) still
#     serializes cleanly with a null value — the regression case that fails
#     on pre-change code (SessionResponse lacked the field entirely, so
#     accessing it below would KeyError).


@pytest.mark.asyncio
async def test_chw_schedules_with_resource_needs_persists_and_returns_them(
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
            "resource_needs": ["housing", "food"],
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["resource_needs"] == ["housing", "food"]

    # Persisted, not just echoed — a fresh GET returns the same value.
    res = await client.get(f"/api/v1/sessions/{body['id']}", headers=auth_header(chw_tokens))
    assert res.status_code == 200, res.text
    assert res.json()["resource_needs"] == ["housing", "food"]


@pytest.mark.asyncio
async def test_chw_schedules_with_no_resource_needs_returns_null(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """Omitting resource_needs entirely (the field defaults to []) must not
    error, and the stored/returned value is null — never an empty-list vs.
    null mismatch that would trip up frontend rendering."""
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)

    res = await client.post(
        "/api/v1/sessions/schedule",
        json={
            "member_id": member_id,
            "scheduled_at": "2026-07-01T17:00:00Z",
            "mode": "phone",
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    assert res.json()["resource_needs"] is None


@pytest.mark.asyncio
async def test_scheduling_with_unknown_vertical_is_rejected(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """An unrecognized resource_needs value must 422, not silently persist a
    value the frontend's VERTICAL_LABEL map can't render."""
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)

    res = await client.post(
        "/api/v1/sessions/schedule",
        json={
            "member_id": member_id,
            "scheduled_at": "2026-07-01T17:00:00Z",
            "mode": "phone",
            "resource_needs": ["not_a_real_vertical"],
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 422, res.text


@pytest.mark.asyncio
async def test_pre_epic_l_session_without_resource_needs_still_serializes(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """A session created via the legacy POST /sessions/ path (SessionCreate has
    no resource_needs field at all) never wrote the column — simulating a row
    that predates Epic L. GETting it must not 500/KeyError; resource_needs
    must serialize as null."""
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

    res = await client.post(
        "/api/v1/sessions/",
        json={
            "request_id": request_id,
            "scheduled_at": "2026-07-04T10:00:00Z",
            "mode": "in_person",
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    session_id = res.json()["id"]
    assert res.json()["resource_needs"] is None

    res = await client.get(f"/api/v1/sessions/{session_id}", headers=auth_header(chw_tokens))
    assert res.status_code == 200, res.text
    assert res.json()["resource_needs"] is None

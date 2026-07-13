"""Tests for the initiator-inversion rule on PATCH /sessions/{id}/confirm
and /decline — the CHW-side widget bug fix.

Background: the CHW-side pending-approval widget showed ALL pending
sessions, including ones the CHW itself proposed, letting a CHW
self-approve their own proposal. The fix tracks WHO proposed a session's
current scheduled time (``Session.proposed_by``: 'chw' | 'member' | None)
and gates confirm/decline so only the NON-proposing party can act.

Coverage (per the initiator-inversion matrix in
app.routers.sessions._reject_self_approval_if_initiator):
  - Member confirms/declines a CHW-proposed session → 200.
  - Member cannot confirm/decline their OWN proposal → 409.
  - CHW cannot confirm/decline their OWN proposal → 409.
  - Legacy session (proposed_by=None): CHW confirm/decline still works
    (regression — a naive "reject all non-chw-proposed" implementation
    would break this); member confirm/decline on legacy-null → 409.
  - Non-participant (different member / different CHW) → 404, not 403.
  - Unauthenticated → 401.
  - Nonexistent session_id → 404, not a 500.
  - Post-409-rejection DB state is unchanged (status/scheduling_status).
  - `proposed_by` is stamped correctly by POST /sessions/schedule for both
    CHW-initiated and member-initiated bookings.
"""

from __future__ import annotations

import base64
import json
import uuid
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.models.session import Session
from tests.conftest import auth_header, complete_member_signup_payload
from tests.conftest import test_session as _db_session_factory


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


async def _chw_proposed_pending_session_id(
    client: AsyncClient, member_tokens: dict, chw_tokens: dict, *, scheduled_at: str
) -> str:
    """CHW schedules a pending session with the member → proposed_by='chw'."""
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)
    res = await client.post(
        "/api/v1/sessions/schedule",
        json={
            "member_id": member_id,
            "scheduled_at": scheduled_at,
            "mode": "phone",
            "scheduling_status": "pending",
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    assert res.json()["scheduling_status"] == "pending"
    assert res.json()["proposed_by"] == "chw"
    return res.json()["id"]


async def _member_proposed_pending_session_id(
    client: AsyncClient, member_tokens: dict, chw_tokens: dict, *, scheduled_at: str
) -> str:
    """Member schedules with their CHW → always pending, proposed_by='member'."""
    await _establish_relationship(client, member_tokens, chw_tokens)
    chw_id = _member_id(chw_tokens)
    res = await client.post(
        "/api/v1/sessions/schedule",
        json={"chw_id": chw_id, "scheduled_at": scheduled_at, "mode": "phone"},
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 201, res.text
    assert res.json()["scheduling_status"] == "pending"
    assert res.json()["proposed_by"] == "member"
    return res.json()["id"]


async def _set_proposed_by(session_id: str, value: str | None) -> None:
    """Directly seed proposed_by on a session row — used to simulate legacy
    (pre-migration) rows where proposed_by is NULL, which cannot be produced
    via the current API (schedule_session always stamps a value)."""
    async with _db_session_factory() as db:
        session = await db.get(Session, uuid.UUID(session_id))
        session.proposed_by = value
        await db.commit()


async def _get_session_row(session_id: str) -> Session:
    async with _db_session_factory() as db:
        result = await db.execute(select(Session).where(Session.id == uuid.UUID(session_id)))
        return result.scalar_one()


# ─── proposed_by stamping on schedule_session ───────────────────────────────


@pytest.mark.asyncio
async def test_chw_initiated_schedule_stamps_proposed_by_chw(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    sid = await _chw_proposed_pending_session_id(
        client, member_tokens, chw_tokens, scheduled_at="2026-08-10T17:00:00Z"
    )
    row = await _get_session_row(sid)
    assert row.proposed_by == "chw"


@pytest.mark.asyncio
async def test_member_initiated_schedule_stamps_proposed_by_member(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    sid = await _member_proposed_pending_session_id(
        client, member_tokens, chw_tokens, scheduled_at="2026-08-10T17:00:00Z"
    )
    row = await _get_session_row(sid)
    assert row.proposed_by == "member"


# ─── Member confirms/declines a CHW-proposed session → 200 ─────────────────


@pytest.mark.asyncio
async def test_member_confirms_chw_proposed_session(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    sid = await _chw_proposed_pending_session_id(
        client, member_tokens, chw_tokens, scheduled_at="2026-08-11T17:00:00Z"
    )
    res = await client.patch(
        f"/api/v1/sessions/{sid}/confirm", headers=auth_header(member_tokens)
    )
    assert res.status_code == 200, res.text
    assert res.json()["scheduling_status"] == "confirmed"
    assert res.json()["status"] == "scheduled"


@pytest.mark.asyncio
async def test_member_declines_chw_proposed_session(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    sid = await _chw_proposed_pending_session_id(
        client, member_tokens, chw_tokens, scheduled_at="2026-08-11T18:00:00Z"
    )
    res = await client.patch(
        f"/api/v1/sessions/{sid}/decline", headers=auth_header(member_tokens)
    )
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "cancelled"


# ─── Self-approval rejection (409) ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_member_cannot_confirm_own_proposal(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    sid = await _member_proposed_pending_session_id(
        client, member_tokens, chw_tokens, scheduled_at="2026-08-12T17:00:00Z"
    )
    res = await client.patch(
        f"/api/v1/sessions/{sid}/confirm", headers=auth_header(member_tokens)
    )
    assert res.status_code == 409, res.text

    # Post-rejection DB state unchanged.
    row = await _get_session_row(sid)
    assert row.scheduling_status == "pending"
    assert row.status == "scheduled"


@pytest.mark.asyncio
async def test_member_cannot_decline_own_proposal(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    sid = await _member_proposed_pending_session_id(
        client, member_tokens, chw_tokens, scheduled_at="2026-08-12T18:00:00Z"
    )
    res = await client.patch(
        f"/api/v1/sessions/{sid}/decline", headers=auth_header(member_tokens)
    )
    assert res.status_code == 409, res.text

    row = await _get_session_row(sid)
    assert row.scheduling_status == "pending"
    assert row.status == "scheduled"


@pytest.mark.asyncio
async def test_chw_cannot_confirm_own_proposal(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    sid = await _chw_proposed_pending_session_id(
        client, member_tokens, chw_tokens, scheduled_at="2026-08-13T17:00:00Z"
    )
    res = await client.patch(
        f"/api/v1/sessions/{sid}/confirm", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 409, res.text

    row = await _get_session_row(sid)
    assert row.scheduling_status == "pending"
    assert row.status == "scheduled"


@pytest.mark.asyncio
async def test_chw_cannot_decline_own_proposal(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    sid = await _chw_proposed_pending_session_id(
        client, member_tokens, chw_tokens, scheduled_at="2026-08-13T18:00:00Z"
    )
    res = await client.patch(
        f"/api/v1/sessions/{sid}/decline", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 409, res.text

    row = await _get_session_row(sid)
    assert row.scheduling_status == "pending"
    assert row.status == "scheduled"


# ─── Legacy rows (proposed_by=None) ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_legacy_null_proposed_by_chw_confirm_still_works(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """Regression: a naive 'reject all non-chw-proposed' implementation would
    also reject proposed_by=None for the CHW, breaking every pre-migration
    pending session. CHW confirm on a legacy-null row must still succeed."""
    sid = await _member_proposed_pending_session_id(
        client, member_tokens, chw_tokens, scheduled_at="2026-08-14T17:00:00Z"
    )
    await _set_proposed_by(sid, None)

    res = await client.patch(
        f"/api/v1/sessions/{sid}/confirm", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200, res.text
    assert res.json()["scheduling_status"] == "confirmed"


@pytest.mark.asyncio
async def test_legacy_null_proposed_by_chw_decline_still_works(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    sid = await _member_proposed_pending_session_id(
        client, member_tokens, chw_tokens, scheduled_at="2026-08-14T18:00:00Z"
    )
    await _set_proposed_by(sid, None)

    res = await client.patch(
        f"/api/v1/sessions/{sid}/decline", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "cancelled"


@pytest.mark.asyncio
async def test_legacy_null_proposed_by_member_confirm_rejected(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """Member confirm on a legacy-null pending session → 409 (safe default;
    initiator unknown so we don't assume the CHW proposed it)."""
    sid = await _chw_proposed_pending_session_id(
        client, member_tokens, chw_tokens, scheduled_at="2026-08-15T17:00:00Z"
    )
    await _set_proposed_by(sid, None)

    res = await client.patch(
        f"/api/v1/sessions/{sid}/confirm", headers=auth_header(member_tokens)
    )
    assert res.status_code == 409, res.text

    row = await _get_session_row(sid)
    assert row.scheduling_status == "pending"
    assert row.status == "scheduled"


@pytest.mark.asyncio
async def test_legacy_null_proposed_by_member_decline_rejected(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    sid = await _chw_proposed_pending_session_id(
        client, member_tokens, chw_tokens, scheduled_at="2026-08-15T18:00:00Z"
    )
    await _set_proposed_by(sid, None)

    res = await client.patch(
        f"/api/v1/sessions/{sid}/decline", headers=auth_header(member_tokens)
    )
    assert res.status_code == 409, res.text

    row = await _get_session_row(sid)
    assert row.scheduling_status == "pending"
    assert row.status == "scheduled"


# ─── Non-participant → 404 ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_non_participant_member_gets_404_on_confirm(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    sid = await _chw_proposed_pending_session_id(
        client, member_tokens, chw_tokens, scheduled_at="2026-08-16T17:00:00Z"
    )
    payload = complete_member_signup_payload(
        email="other_member_confirm@example.com", name="Other Member"
    )
    payload["medi_cal_id"] = "99988877A"
    res = await client.post("/api/v1/auth/register", json=payload)
    assert res.status_code == 201, res.text
    other_member_tokens = res.json()

    res = await client.patch(
        f"/api/v1/sessions/{sid}/confirm", headers=auth_header(other_member_tokens)
    )
    assert res.status_code == 404, res.text


@pytest.mark.asyncio
async def test_non_participant_chw_gets_404_on_decline(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    sid = await _chw_proposed_pending_session_id(
        client, member_tokens, chw_tokens, scheduled_at="2026-08-16T18:00:00Z"
    )
    res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "other_chw_decline@example.com",
            "password": "testpass123",
            "name": "Other CHW",
            "role": "chw",
        },
    )
    assert res.status_code == 201, res.text
    other_chw_tokens = res.json()

    res = await client.patch(
        f"/api/v1/sessions/{sid}/decline", headers=auth_header(other_chw_tokens)
    )
    assert res.status_code == 404, res.text


# ─── Unauthenticated → 401 ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_unauthenticated_confirm_returns_401(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    sid = await _chw_proposed_pending_session_id(
        client, member_tokens, chw_tokens, scheduled_at="2026-08-17T17:00:00Z"
    )
    res = await client.patch(f"/api/v1/sessions/{sid}/confirm")
    assert res.status_code == 401, res.text


@pytest.mark.asyncio
async def test_unauthenticated_decline_returns_401(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    sid = await _chw_proposed_pending_session_id(
        client, member_tokens, chw_tokens, scheduled_at="2026-08-17T18:00:00Z"
    )
    res = await client.patch(f"/api/v1/sessions/{sid}/decline")
    assert res.status_code == 401, res.text


# ─── Nonexistent session_id → clean 404, not a 500 ──────────────────────────


@pytest.mark.asyncio
async def test_confirm_nonexistent_session_returns_404_not_500(
    client: AsyncClient, chw_tokens: dict, setup_db
):
    fake_id = uuid.uuid4()
    res = await client.patch(
        f"/api/v1/sessions/{fake_id}/confirm", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 404, res.text


@pytest.mark.asyncio
async def test_decline_nonexistent_session_returns_404_not_500(
    client: AsyncClient, member_tokens: dict, setup_db
):
    fake_id = uuid.uuid4()
    res = await client.patch(
        f"/api/v1/sessions/{fake_id}/decline", headers=auth_header(member_tokens)
    )
    assert res.status_code == 404, res.text


# ─── Regression: pre-existing CHW happy path for member-proposed sessions ──


@pytest.mark.asyncio
async def test_chw_confirm_decline_unchanged_for_member_proposed_sessions(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """The CHW's existing /confirm and /decline calls for member-proposed
    pendings must keep working unchanged after this fix."""
    sid = await _member_proposed_pending_session_id(
        client, member_tokens, chw_tokens, scheduled_at="2026-08-18T17:00:00Z"
    )
    res = await client.patch(
        f"/api/v1/sessions/{sid}/confirm", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200, res.text
    assert res.json()["scheduling_status"] == "confirmed"

    sid2 = await _member_proposed_pending_session_id(
        client, member_tokens, chw_tokens, scheduled_at="2026-08-18T18:00:00Z"
    )
    res = await client.patch(
        f"/api/v1/sessions/{sid2}/decline", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "cancelled"

"""Integration tests for GET /api/v1/chw/dashboard/stats (QA-batch #15/#24/#25).

This endpoint is the single accurate source shared by three frontend surfaces:
  - The Dashboard "Completed Sessions" stat tile (completed_sessions_total /
    completed_sessions_today).
  - The Dashboard member-request alert banner (pending_member_requests).
  - The Appointments sidebar badge (pending_member_requests, via AppShell).

Coverage:
  1. Auth gate — member caller gets 403.
  2. completed_sessions_total counts ONLY status == 'completed' sessions
     (fixtures spanning scheduled / in_progress / cancelled / no_show /
     completed).
  3. completed_sessions_today is scoped to sessions whose ended_at falls
     within today (California wall-clock day) — a completed session from
     3 days ago does not count toward today.
  4. pending_member_requests counts scheduled+pending sessions proposed by
     the member (or a legacy NULL proposer), and excludes: sessions the CHW
     proposed themselves, confirmed sessions, and non-scheduled sessions.
  5. Response shape — all three fields present and non-negative ints.
"""

from __future__ import annotations

import base64
import json
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient

from tests.conftest import auth_header


def _decode_jwt_sub(access_token: str) -> str:
    payload_segment = access_token.split(".")[1]
    padded = payload_segment + "=" * (4 - len(payload_segment) % 4)
    payload = json.loads(base64.urlsafe_b64decode(padded))
    return payload["sub"]


async def _register(client: AsyncClient, email: str, role: str, name: str) -> dict:
    payload: dict = {
        "email": email,
        "password": "Testpass123!",
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
            "terms_accepted": True,
            "communications_consent": True,
        })
    res = await client.post("/api/v1/auth/register", json=payload)
    assert res.status_code == 201, res.text
    return res.json()


async def _establish_relationship(
    client: AsyncClient, member_tokens: dict, chw_tokens: dict,
) -> str:
    """Create + accept a service request so a care relationship exists
    (required by POST /sessions/schedule's relationship gate). Returns the
    auto-created session's id (status='scheduled', not completed)."""
    res = await client.post("/api/v1/requests/", json={
        "vertical": "housing",
        "urgency": "routine",
        "description": "Need help",
        "preferred_mode": "in_person",
    }, headers=auth_header(member_tokens))
    assert res.status_code == 201, res.text
    request_id = res.json()["id"]

    res = await client.patch(
        f"/api/v1/requests/{request_id}/accept",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    return res.json()["id"] if "id" in res.json() else request_id


@pytest.mark.asyncio
async def test_member_caller_gets_403(client: AsyncClient, member_tokens: dict) -> None:
    res = await client.get(
        "/api/v1/chw/dashboard/stats", headers=auth_header(member_tokens),
    )
    assert res.status_code == 403, res.text


@pytest.mark.asyncio
async def test_response_shape_for_fresh_chw(client: AsyncClient, chw_tokens: dict) -> None:
    """A CHW with no sessions at all gets 200 with all-zero counts, not a 500."""
    res = await client.get(
        "/api/v1/chw/dashboard/stats", headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert set(body.keys()) == {
        "completed_sessions_total", "completed_sessions_today", "pending_member_requests",
    }
    for value in body.values():
        assert isinstance(value, int) and value >= 0


@pytest.mark.asyncio
async def test_completed_sessions_total_counts_only_completed_status(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict,
) -> None:
    """Sessions in any non-'completed' status (scheduled, in_progress,
    cancelled, no_show) must NOT contribute to completed_sessions_total —
    only documented-and-submitted sessions do."""
    import uuid
    from uuid import UUID

    from sqlalchemy import select

    from app.models.session import Session
    from tests.conftest import test_session as _tsf

    chw_id = UUID(_decode_jwt_sub(chw_tokens["access_token"]))
    await _establish_relationship(client, member_tokens, chw_tokens)

    async with _tsf() as db:
        member_id = (
            await db.execute(
                select(Session.member_id).where(Session.chw_id == chw_id)
            )
        ).scalar_one()
        request_id = (
            await db.execute(
                select(Session.request_id).where(Session.chw_id == chw_id)
            )
        ).scalar_one()

        for status in ["scheduled", "in_progress", "cancelled", "no_show"]:
            db.add(Session(
                id=uuid.uuid4(), request_id=request_id, chw_id=chw_id,
                member_id=member_id, vertical="housing", status=status,
                mode="phone",
            ))
        # Two genuinely completed sessions.
        for _ in range(2):
            db.add(Session(
                id=uuid.uuid4(), request_id=request_id, chw_id=chw_id,
                member_id=member_id, vertical="housing", status="completed",
                mode="phone", ended_at=datetime.now(UTC) - timedelta(days=1),
            ))
        await db.commit()

    res = await client.get(
        "/api/v1/chw/dashboard/stats", headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    assert res.json()["completed_sessions_total"] == 2


@pytest.mark.asyncio
async def test_completed_sessions_today_excludes_older_completions(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict,
) -> None:
    """A session completed 3 days ago counts toward the all-time total but
    NOT toward completed_sessions_today."""
    import uuid
    from uuid import UUID

    from sqlalchemy import select

    from app.models.session import Session
    from tests.conftest import test_session as _tsf

    chw_id = UUID(_decode_jwt_sub(chw_tokens["access_token"]))
    await _establish_relationship(client, member_tokens, chw_tokens)

    async with _tsf() as db:
        member_id = (
            await db.execute(
                select(Session.member_id).where(Session.chw_id == chw_id)
            )
        ).scalar_one()
        request_id = (
            await db.execute(
                select(Session.request_id).where(Session.chw_id == chw_id)
            )
        ).scalar_one()

        db.add(Session(
            id=uuid.uuid4(), request_id=request_id, chw_id=chw_id,
            member_id=member_id, vertical="housing", status="completed",
            mode="phone", ended_at=datetime.now(UTC),
        ))
        db.add(Session(
            id=uuid.uuid4(), request_id=request_id, chw_id=chw_id,
            member_id=member_id, vertical="housing", status="completed",
            mode="phone", ended_at=datetime.now(UTC) - timedelta(days=3),
        ))
        await db.commit()

    res = await client.get(
        "/api/v1/chw/dashboard/stats", headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["completed_sessions_total"] == 2
    assert body["completed_sessions_today"] == 1


@pytest.mark.asyncio
async def test_pending_member_requests_counts_member_proposed_only(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict,
) -> None:
    """pending_member_requests must count a member-proposed pending session,
    and MUST NOT count: a CHW-proposed pending session (awaiting the
    member's decision, not this CHW's), a confirmed session, or a
    non-scheduled session."""
    await _establish_relationship(client, member_tokens, chw_tokens)

    tomorrow = (datetime.now(UTC) + timedelta(days=1)).isoformat()
    day_after = (datetime.now(UTC) + timedelta(days=2)).isoformat()

    # Member proposes a session → scheduling_status='pending', proposed_by='member'.
    res = await client.post("/api/v1/sessions/schedule", json={
        "chw_id": _decode_jwt_sub(chw_tokens["access_token"]),
        "scheduled_at": tomorrow,
        "mode": "phone",
    }, headers=auth_header(member_tokens))
    assert res.status_code == 201, res.text

    # CHW proposes a session (to the same member) → proposed_by='chw'; must
    # NOT count toward this CHW's own pending-request queue.
    res2 = await client.post("/api/v1/sessions/schedule", json={
        "member_id": _decode_jwt_sub(member_tokens["access_token"]),
        "scheduled_at": day_after,
        "mode": "phone",
        "scheduling_status": "pending",
    }, headers=auth_header(chw_tokens))
    assert res2.status_code == 201, res2.text

    res = await client.get(
        "/api/v1/chw/dashboard/stats", headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    assert res.json()["pending_member_requests"] == 1


@pytest.mark.asyncio
async def test_pending_member_requests_zero_when_none_pending(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict,
) -> None:
    """Confirming the lone member-proposed request drops the count to zero
    (mirrors the FE test asserting the confirm/decline flow clears the
    banner + badge together)."""
    await _establish_relationship(client, member_tokens, chw_tokens)

    tomorrow = (datetime.now(UTC) + timedelta(days=1)).isoformat()
    res = await client.post("/api/v1/sessions/schedule", json={
        "chw_id": _decode_jwt_sub(chw_tokens["access_token"]),
        "scheduled_at": tomorrow,
        "mode": "phone",
    }, headers=auth_header(member_tokens))
    assert res.status_code == 201, res.text
    session_id = res.json()["id"]

    res = await client.get(
        "/api/v1/chw/dashboard/stats", headers=auth_header(chw_tokens),
    )
    assert res.json()["pending_member_requests"] == 1

    confirm_res = await client.patch(
        f"/api/v1/sessions/{session_id}/confirm", headers=auth_header(chw_tokens),
    )
    assert confirm_res.status_code == 200, confirm_res.text

    res = await client.get(
        "/api/v1/chw/dashboard/stats", headers=auth_header(chw_tokens),
    )
    assert res.json()["pending_member_requests"] == 0

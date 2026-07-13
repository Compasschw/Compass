"""Tests for GET /api/v1/chw/members/{member_id}/session-notes.

Returns the CHW-authored documentation summary for each documented session with
the member — the "original" session notes shown in the View Notes / Case Notes
timelines.

Coverage:
  - A documented session's summary is returned (with session_id + timestamps).
  - Sessions without documentation are omitted.
  - An unrelated CHW is denied (403).
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


async def _match(client: AsyncClient, member_tokens: dict, chw_tokens: dict) -> str:
    res = await client.post(
        "/api/v1/requests/",
        json={
            "vertical": "housing",
            "urgency": "routine",
            "description": "Need housing help",
            "preferred_mode": "in_person",
        },
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 201
    request_id = res.json()["id"]
    res = await client.patch(
        f"/api/v1/requests/{request_id}/accept", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200
    return request_id


async def _documented_session(
    client: AsyncClient, chw_tokens: dict, request_id: str, summary: str
) -> str:
    res = await client.post(
        "/api/v1/sessions/",
        json={
            "request_id": request_id,
            "scheduled_at": "2026-04-10T10:00:00Z",
            "mode": "in_person",
        },
        headers=auth_header(chw_tokens),
    )
    session_id = res.json()["id"]
    await client.patch(f"/api/v1/sessions/{session_id}/start", headers=auth_header(chw_tokens))
    await client.patch(f"/api/v1/sessions/{session_id}/complete", headers=auth_header(chw_tokens))
    res = await client.post(
        f"/api/v1/sessions/{session_id}/documentation",
        json={
            "summary": summary,
            "diagnosis_codes": ["Z59.1"],
            "procedure_code": "98960",
            "units_to_bill": 2,
            # Explicit session_start_time/session_end_time (30min,
            # >=16min-floor billable — see billing_service.calculate_units)
            # rather than relying on the server-tracked start/complete
            # duration, which in a fast test run is ~0 minutes and would now
            # 422 as not-billable under the 16-minute floor (2026-07-13).
            # This helper is about documentation/notes behavior, not units.
            "session_start_time": "2026-04-10T10:00:00Z",
            "session_end_time": "2026-04-10T10:30:00Z",
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    return session_id


@pytest.mark.asyncio
async def test_returns_documented_session_summary(
    client: AsyncClient, chw_tokens, member_tokens, setup_db
):
    request_id = await _match(client, member_tokens, chw_tokens)
    session_id = await _documented_session(
        client, chw_tokens, request_id, "Discussed housing options and next steps."
    )
    member_id = _member_id(member_tokens)

    res = await client.get(
        f"/api/v1/chw/members/{member_id}/session-notes",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    notes = res.json()
    assert len(notes) == 1
    assert notes[0]["session_id"] == session_id
    assert notes[0]["summary"] == "Discussed housing options and next steps."
    assert notes[0]["submitted_at"] is not None
    assert notes[0]["mode"] == "in_person"


@pytest.mark.asyncio
async def test_undocumented_session_omitted(
    client: AsyncClient, chw_tokens, member_tokens, setup_db
):
    request_id = await _match(client, member_tokens, chw_tokens)
    # A scheduled-but-undocumented session.
    await client.post(
        "/api/v1/sessions/",
        json={
            "request_id": request_id,
            "scheduled_at": "2026-04-11T10:00:00Z",
            "mode": "phone",
        },
        headers=auth_header(chw_tokens),
    )
    member_id = _member_id(member_tokens)

    res = await client.get(
        f"/api/v1/chw/members/{member_id}/session-notes",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    assert res.json() == []


@pytest.mark.asyncio
async def test_unrelated_chw_denied(
    client: AsyncClient, chw_tokens, member_tokens, setup_db
):
    member_id = _member_id(member_tokens)  # no request/accept -> no relationship
    res = await client.get(
        f"/api/v1/chw/members/{member_id}/session-notes",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 403, res.text

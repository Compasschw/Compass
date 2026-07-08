"""Member-facing CHW available-slots endpoint.

GET /api/v1/member/chws/{chw_id}/available-slots?date=YYYY-MM-DD returns the
CHW's open 30-minute slots for that day (default Mon–Fri 9–5, minus booked),
relationship-gated. These tests avoid manual timezone math by booking a slot the
endpoint itself returned and asserting it disappears.
"""

from __future__ import annotations

import base64
import json
from datetime import date, timedelta
from uuid import UUID

import pytest
from httpx import AsyncClient

from tests.conftest import auth_header


def _sub(tokens: dict) -> str:
    p = tokens["access_token"].split(".")[1]
    p += "=" * (4 - len(p) % 4)
    return str(UUID(json.loads(base64.urlsafe_b64decode(p).decode())["sub"]))


async def _relationship(client: AsyncClient, member_tokens: dict, chw_tokens: dict) -> str:
    """Member files a request, CHW accepts → relationship. Returns chw_id."""
    res = await client.post(
        "/api/v1/requests/",
        json={
            "vertical": "housing",
            "urgency": "routine",
            "description": "x",
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
    return _sub(chw_tokens)


def _next_weekday() -> str:
    d = date.today() + timedelta(days=7)
    while d.weekday() >= 5:
        d += timedelta(days=1)
    return d.isoformat()


def _next_weekend() -> str:
    d = date.today() + timedelta(days=1)
    while d.weekday() < 5:
        d += timedelta(days=1)
    return d.isoformat()


def _slots_url(chw_id: str, day: str) -> str:
    return f"/api/v1/member/chws/{chw_id}/available-slots?date={day}"


@pytest.mark.asyncio
async def test_available_slots_default_hours(client: AsyncClient, chw_tokens, member_tokens, setup_db):
    chw_id = await _relationship(client, member_tokens, chw_tokens)
    res = await client.get(_slots_url(chw_id, _next_weekday()), headers=auth_header(member_tokens))
    assert res.status_code == 200, res.text
    assert len(res.json()["slots"]) > 0  # default Mon–Fri 9–5 → 30-min slots


@pytest.mark.asyncio
async def test_available_slots_empty_on_weekend(client: AsyncClient, chw_tokens, member_tokens, setup_db):
    chw_id = await _relationship(client, member_tokens, chw_tokens)
    res = await client.get(_slots_url(chw_id, _next_weekend()), headers=auth_header(member_tokens))
    assert res.status_code == 200, res.text
    assert res.json()["slots"] == []  # default has no weekend hours


@pytest.mark.asyncio
async def test_available_slots_excludes_booked(client: AsyncClient, chw_tokens, member_tokens, setup_db):
    chw_id = await _relationship(client, member_tokens, chw_tokens)
    day = _next_weekday()
    res = await client.get(_slots_url(chw_id, day), headers=auth_header(member_tokens))
    slots = res.json()["slots"]
    assert slots
    first = slots[0]

    booked = await client.post(
        "/api/v1/sessions/schedule",
        json={"chw_id": chw_id, "scheduled_at": first, "mode": "phone"},
        headers=auth_header(member_tokens),
    )
    assert booked.status_code == 201, booked.text

    res = await client.get(_slots_url(chw_id, day), headers=auth_header(member_tokens))
    assert first not in res.json()["slots"], "booked slot should no longer be offered"


@pytest.mark.asyncio
async def test_available_slots_bad_date(client: AsyncClient, chw_tokens, member_tokens, setup_db):
    chw_id = await _relationship(client, member_tokens, chw_tokens)
    res = await client.get(_slots_url(chw_id, "not-a-date"), headers=auth_header(member_tokens))
    assert res.status_code == 422


@pytest.mark.asyncio
async def test_available_slots_requires_relationship(client: AsyncClient, chw_tokens, member_tokens, setup_db):
    chw_id = _sub(chw_tokens)  # no relationship established
    res = await client.get(_slots_url(chw_id, _next_weekday()), headers=auth_header(member_tokens))
    assert res.status_code == 403

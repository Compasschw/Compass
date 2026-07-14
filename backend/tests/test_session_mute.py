"""Regression tests for the CHW Messages inbox mute action.

Covers the new ``PATCH /api/v1/sessions/{id}/mute`` endpoint and the
``muted_at`` field on ``SessionResponse``:

  1. mute toggles ``muted_at`` (true stamps it, false clears it)
  2. only the owning CHW may mute — a non-owner CHW gets 404 (existence is
     not leaked, mirroring the pin/archive ownership gate)
  3. ``SessionResponse`` exposes ``muted_at`` (defaulting to null)

Pin/archive already have coverage elsewhere; these tests are mute-specific.
"""
import pytest
from httpx import AsyncClient

from tests.conftest import auth_header


async def _create_session(
    client: AsyncClient, member_tokens: dict, chw_tokens: dict
) -> str:
    """Create a matched request + session and return the session id."""
    req_res = await client.post(
        "/api/v1/requests/",
        json={
            "vertical": "housing",
            "urgency": "routine",
            "description": "Need housing help",
            "preferred_mode": "in_person",
        },
        headers=auth_header(member_tokens),
    )
    assert req_res.status_code == 201, req_res.text
    request_id = req_res.json()["id"]

    accept_res = await client.patch(
        f"/api/v1/requests/{request_id}/accept",
        headers=auth_header(chw_tokens),
    )
    assert accept_res.status_code == 200, accept_res.text

    sess_res = await client.post(
        "/api/v1/sessions/",
        json={"request_id": request_id, "scheduled_at": "2026-07-10T10:00:00Z"},
        headers=auth_header(chw_tokens),
    )
    assert sess_res.status_code == 201, sess_res.text
    return sess_res.json()["id"]


@pytest.mark.asyncio
async def test_mute_toggles_muted_at(client: AsyncClient, chw_tokens, member_tokens):
    """PATCH /mute with muted=true stamps muted_at; muted=false clears it."""
    session_id = await _create_session(client, member_tokens, chw_tokens)

    # A freshly created session is not muted.
    res = await client.get(
        f"/api/v1/sessions/{session_id}", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200
    assert res.json()["muted_at"] is None

    # Mute → muted_at populated.
    res = await client.patch(
        f"/api/v1/sessions/{session_id}/mute",
        json={"muted": True},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    assert res.json()["muted_at"] is not None

    # Unmute → muted_at cleared.
    res = await client.patch(
        f"/api/v1/sessions/{session_id}/mute",
        json={"muted": False},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    assert res.json()["muted_at"] is None


@pytest.mark.asyncio
async def test_only_owning_chw_can_mute(client: AsyncClient, chw_tokens, member_tokens):
    """A CHW who does not own the session gets 404 (not 403) on /mute."""
    session_id = await _create_session(client, member_tokens, chw_tokens)

    # Register a second, unrelated CHW.
    other = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "other_chw_mute@example.com",
            "password": "Testpass123!",
            "name": "Other CHW",
            "role": "chw",
        },
    )
    assert other.status_code == 201, other.text
    other_tokens = other.json()

    res = await client.patch(
        f"/api/v1/sessions/{session_id}/mute",
        json={"muted": True},
        headers=auth_header(other_tokens),
    )
    # 404 avoids leaking the existence of sessions the caller cannot see.
    assert res.status_code == 404

    # And the owning CHW still sees it unmuted (the non-owner call was a no-op).
    res = await client.get(
        f"/api/v1/sessions/{session_id}", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200
    assert res.json()["muted_at"] is None


@pytest.mark.asyncio
async def test_session_response_includes_muted_at(
    client: AsyncClient, chw_tokens, member_tokens
):
    """SessionResponse always carries the muted_at field (null by default)."""
    session_id = await _create_session(client, member_tokens, chw_tokens)

    res = await client.get(
        f"/api/v1/sessions/{session_id}", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200
    body = res.json()
    assert "muted_at" in body
    assert body["muted_at"] is None

"""Integration tests: one-active-session-per-CHW constraint.

Covers:
  1. Starting session A succeeds.
  2. Starting session B (different session, same CHW) while A is in_progress
     returns HTTP 409 with code=ANOTHER_SESSION_IN_PROGRESS and the correct
     active_session_id pointing at A.
  3. Completing A, then starting B succeeds — the constraint is lifted.
"""

import pytest
from httpx import AsyncClient

from tests.conftest import auth_header


# ─── Shared helpers ────────────────────────────────────────────────────────────


async def _create_matched_request(
    client: AsyncClient,
    member_tokens: dict,
    chw_tokens: dict,
) -> str:
    """Create a service request as member and accept it as CHW. Returns request_id."""
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
    assert res.status_code == 201, f"Create request failed: {res.text}"
    request_id = res.json()["id"]

    res = await client.patch(
        f"/api/v1/requests/{request_id}/accept",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, f"Accept request failed: {res.text}"
    return request_id


async def _create_session(
    client: AsyncClient,
    chw_tokens: dict,
    request_id: str,
) -> str:
    """Create a scheduled session for the given request. Returns session_id."""
    res = await client.post(
        "/api/v1/sessions/",
        json={
            "request_id": request_id,
            "scheduled_at": "2026-06-01T10:00:00Z",
            "mode": "in_person",
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, f"Create session failed: {res.text}"
    return res.json()["id"]


# ─── Tests ────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_cannot_start_second_session_while_one_in_progress(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """
    Full lifecycle:
      1. Create two service requests (both matched to the same CHW).
      2. Create a session for each request.
      3. Start session A — succeeds (200, status=in_progress).
      4. Attempt to start session B — must be rejected with 409,
         detail.code == 'ANOTHER_SESSION_IN_PROGRESS', and
         detail.active_session_id == session_a_id.
      5. Complete session A (200, status=completed).
      6. Start session B — now succeeds (200, status=in_progress).
    """
    # ── Setup: two matched requests → two sessions ─────────────────────────────
    request_a_id = await _create_matched_request(client, member_tokens, chw_tokens)
    session_a_id = await _create_session(client, chw_tokens, request_a_id)

    # For session B we need a second, independent service request.
    # The member creates another request and the CHW accepts it.
    request_b_id = await _create_matched_request(client, member_tokens, chw_tokens)
    session_b_id = await _create_session(client, chw_tokens, request_b_id)

    # ── Step 3: Start session A — must succeed ─────────────────────────────────
    res = await client.patch(
        f"/api/v1/sessions/{session_a_id}/start",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, f"Start session A failed: {res.text}"
    assert res.json()["status"] == "in_progress"

    # ── Step 4: Start session B — must be rejected ─────────────────────────────
    res = await client.patch(
        f"/api/v1/sessions/{session_b_id}/start",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 409, (
        f"Expected 409 when starting second session; got {res.status_code}: {res.text}"
    )

    body = res.json()
    detail = body.get("detail", {})

    # FastAPI wraps the dict detail under a "detail" key.
    assert isinstance(detail, dict), (
        f"Expected detail to be a dict, got {type(detail)}: {detail}"
    )
    assert detail.get("code") == "ANOTHER_SESSION_IN_PROGRESS", (
        f"Expected code=ANOTHER_SESSION_IN_PROGRESS, got: {detail.get('code')}"
    )
    assert detail.get("active_session_id") == session_a_id, (
        f"Expected active_session_id={session_a_id!r}, got: {detail.get('active_session_id')!r}"
    )
    assert "message" in detail, "Expected 'message' key in 409 detail"

    # ── Step 5: Complete session A ─────────────────────────────────────────────
    res = await client.patch(
        f"/api/v1/sessions/{session_a_id}/complete",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, f"Complete session A failed: {res.text}"
    assert res.json()["status"] == "completed"

    # ── Step 6: Start session B — must now succeed ─────────────────────────────
    res = await client.patch(
        f"/api/v1/sessions/{session_b_id}/start",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, (
        f"Expected session B to start after A completed; got {res.status_code}: {res.text}"
    )
    assert res.json()["status"] == "in_progress"


@pytest.mark.asyncio
async def test_same_session_cannot_be_started_twice(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """Starting the same session a second time must return 409 (already in_progress)."""
    request_id = await _create_matched_request(client, member_tokens, chw_tokens)
    session_id = await _create_session(client, chw_tokens, request_id)

    res = await client.patch(
        f"/api/v1/sessions/{session_id}/start",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200

    # Second start on the SAME session: hits the existing status guard,
    # NOT the new concurrent-session guard (status is already in_progress,
    # not scheduled). Both reject with 409, but via the older guard.
    res = await client.patch(
        f"/api/v1/sessions/{session_id}/start",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 409


@pytest.mark.asyncio
async def test_different_chws_can_each_have_active_session(
    client: AsyncClient,
    member_tokens: dict,
) -> None:
    """Two different CHWs may each have a session in_progress simultaneously."""
    # Register a second CHW.
    res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "secondchw@example.com",
            "password": "testpass123",
            "name": "Second CHW",
            "role": "chw",
        },
    )
    assert res.status_code == 201
    chw2_tokens = res.json()

    # Register a second member so both CHWs have distinct requests to match.
    res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "member2@example.com",
            "password": "testpass123",
            "name": "Member Two",
            "role": "member",
        },
    )
    assert res.status_code == 201
    member2_tokens = res.json()

    # CHW1 tokens — register fresh to get their own account.
    res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "chw1_isolation@example.com",
            "password": "testpass123",
            "name": "CHW One",
            "role": "chw",
        },
    )
    assert res.status_code == 201
    chw1_tokens = res.json()

    # Member1 → request → CHW1 session
    request_1_id = await _create_matched_request(client, member_tokens, chw1_tokens)
    session_1_id = await _create_session(client, chw1_tokens, request_1_id)

    # Member2 → request → CHW2 session
    request_2_id = await _create_matched_request(client, member2_tokens, chw2_tokens)
    session_2_id = await _create_session(client, chw2_tokens, request_2_id)

    # CHW1 starts their session.
    res = await client.patch(
        f"/api/v1/sessions/{session_1_id}/start",
        headers=auth_header(chw1_tokens),
    )
    assert res.status_code == 200, f"CHW1 session start failed: {res.text}"

    # CHW2 starts their session — must succeed even though CHW1 is in_progress.
    res = await client.patch(
        f"/api/v1/sessions/{session_2_id}/start",
        headers=auth_header(chw2_tokens),
    )
    assert res.status_code == 200, (
        f"CHW2 session start blocked incorrectly; got {res.status_code}: {res.text}"
    )
    assert res.json()["status"] == "in_progress"

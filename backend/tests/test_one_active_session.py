"""Integration tests: one-active-session-per-CHW constraint.

Covers:
  1. Starting session A succeeds.
  2. Starting session B (different session, same CHW) while A is in_progress
     SUPERSEDES A — B becomes in_progress and A is auto-cancelled (a CHW can only
     be in one session at a time). Replaced the old 409 ANOTHER_SESSION_IN_PROGRESS
     hard-block (2026-06-17); also self-heals stale in_progress orphans.
  3. Two different CHWs may each hold an in_progress session simultaneously.
  4. Start does not depend on the masked-call provider.
"""

import pytest
from httpx import AsyncClient

from tests.conftest import auth_header, complete_member_signup_payload


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
async def test_starting_a_second_session_supersedes_the_first(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """
    A CHW can only physically be in one session at a time, so starting a second
    session auto-cancels (supersedes) the first rather than blocking:

      1. Create two service requests (both matched to the same CHW).
      2. Create a session for each request.
      3. Start session A — succeeds (200, status=in_progress).
      4. Start session B — succeeds (200, status=in_progress); A is auto-cancelled.
      5. Verify A is now 'cancelled' and B is the only in_progress session.

    This also self-heals stale in_progress rows (the orphans that previously
    accumulated and made the one-active check raise MultipleResultsFound → 500).
    """
    # ── Setup: two matched requests → two sessions ─────────────────────────────
    request_a_id = await _create_matched_request(client, member_tokens, chw_tokens)
    session_a_id = await _create_session(client, chw_tokens, request_a_id)

    request_b_id = await _create_matched_request(client, member_tokens, chw_tokens)
    session_b_id = await _create_session(client, chw_tokens, request_b_id)

    # ── Start session A — succeeds ─────────────────────────────────────────────
    res = await client.patch(
        f"/api/v1/sessions/{session_a_id}/start",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, f"Start session A failed: {res.text}"
    assert res.json()["status"] == "in_progress"

    # ── Start session B — succeeds and supersedes A ────────────────────────────
    res = await client.patch(
        f"/api/v1/sessions/{session_b_id}/start",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, (
        f"Expected session B to start (superseding A); got {res.status_code}: {res.text}"
    )
    assert res.json()["status"] == "in_progress"

    # ── Session A must now be cancelled (auto-superseded, not billable) ────────
    res = await client.get(
        f"/api/v1/sessions/{session_a_id}",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, f"Fetch session A failed: {res.text}"
    assert res.json()["status"] == "cancelled", (
        f"Expected session A to be auto-cancelled; got {res.json()['status']!r}"
    )


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
    # Members must supply every Pear-required signup field (#14); the CIN is
    # derived from the email so it differs from the conftest member fixture's.
    member2_email = "member2@example.com"
    member2_payload = complete_member_signup_payload(
        email=member2_email, name="Member Two"
    )
    member2_payload["medi_cal_id"] = f"{abs(hash(member2_email)) % 100_000_000:08d}A"
    res = await client.post("/api/v1/auth/register", json=member2_payload)
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


# ─── Regression: masked-call provisioning failure must not 500 the start ───────


class _CommFailProvider:
    """A provider whose proxy session forces the communication_sessions INSERT to
    violate the ``proxy_number`` varchar(20) constraint.

    Reproduces the production 500 where starting a session ran a real (configured)
    Vonage provider; the comm-session work was committed in the same transaction
    as the status change, so a failure there took down the whole request (the
    browser saw "Failed to fetch" because the 500 carried no CORS header).
    """

    async def create_proxy_session(self, session_id, chw_phone, member_phone):
        from app.services.communication.base import ProxySession

        return ProxySession(
            provider_session_id="compass-session-regression",
            # 64 chars — exceeds communication_sessions.proxy_number varchar(20),
            # so the comm-session commit raises on Postgres.
            proxy_number="9" * 64,
            provider="vonage",
        )


@pytest.mark.asyncio
async def test_start_does_not_provision_masked_calling(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
    monkeypatch,
) -> None:
    """Starting a session must succeed (200, in_progress) and must NOT touch the
    masked-call provider — provisioning is deferred to POST /sessions/{id}/call.

    A provider whose proxy session would break the comm-session commit is patched
    in; if start ever calls it again the broken write would 500 the request (the
    original production bug, surfaced in the browser as "Failed to fetch"). This
    test guards against re-coupling start to telephony.
    """
    request_id = await _create_matched_request(client, member_tokens, chw_tokens)
    session_id = await _create_session(client, chw_tokens, request_id)

    # The /call endpoint resolves get_provider() from app.services.communication
    # at call time; patch it there. start() must never invoke it.
    monkeypatch.setattr(
        "app.services.communication.get_provider",
        lambda: _CommFailProvider(),
    )

    res = await client.patch(
        f"/api/v1/sessions/{session_id}/start",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, (
        f"Start must not depend on the masked-call provider; got {res.status_code}: {res.text}"
    )
    assert res.json()["status"] == "in_progress"
    assert res.json()["started_at"] is not None, "start must stamp started_at"

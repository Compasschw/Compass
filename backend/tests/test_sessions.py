import pytest
from httpx import AsyncClient

from tests.conftest import auth_header


async def create_request_and_match(client: AsyncClient, member_tokens: dict, chw_tokens: dict) -> str:
    res = await client.post("/api/v1/requests/", json={
        "vertical": "housing", "urgency": "routine",
        "description": "Need housing help", "preferred_mode": "in_person",
    }, headers=auth_header(member_tokens))
    assert res.status_code == 201
    request_id = res.json()["id"]

    res = await client.patch(f"/api/v1/requests/{request_id}/accept", headers=auth_header(chw_tokens))
    assert res.status_code == 200
    return request_id


@pytest.mark.asyncio
async def test_session_lifecycle(client: AsyncClient, chw_tokens, member_tokens):
    request_id = await create_request_and_match(client, member_tokens, chw_tokens)

    res = await client.post("/api/v1/sessions/", json={
        "request_id": request_id, "scheduled_at": "2026-04-10T10:00:00Z", "mode": "in_person",
    }, headers=auth_header(chw_tokens))
    assert res.status_code == 201
    session_id = res.json()["id"]
    assert res.json()["status"] == "scheduled"

    res = await client.patch(f"/api/v1/sessions/{session_id}/start", headers=auth_header(chw_tokens))
    assert res.status_code == 200
    assert res.json()["status"] == "in_progress"

    res = await client.patch(f"/api/v1/sessions/{session_id}/complete", headers=auth_header(chw_tokens))
    assert res.status_code == 200
    assert res.json()["status"] == "completed"


@pytest.mark.asyncio
async def test_cannot_start_completed_session(client: AsyncClient, chw_tokens, member_tokens):
    request_id = await create_request_and_match(client, member_tokens, chw_tokens)

    res = await client.post("/api/v1/sessions/", json={
        "request_id": request_id, "scheduled_at": "2026-04-10T10:00:00Z", "mode": "in_person",
    }, headers=auth_header(chw_tokens))
    session_id = res.json()["id"]

    await client.patch(f"/api/v1/sessions/{session_id}/start", headers=auth_header(chw_tokens))
    await client.patch(f"/api/v1/sessions/{session_id}/complete", headers=auth_header(chw_tokens))

    res = await client.patch(f"/api/v1/sessions/{session_id}/start", headers=auth_header(chw_tokens))
    assert res.status_code == 409


@pytest.mark.asyncio
async def test_cannot_complete_scheduled_session(client: AsyncClient, chw_tokens, member_tokens):
    request_id = await create_request_and_match(client, member_tokens, chw_tokens)

    res = await client.post("/api/v1/sessions/", json={
        "request_id": request_id, "scheduled_at": "2026-04-10T10:00:00Z", "mode": "in_person",
    }, headers=auth_header(chw_tokens))
    session_id = res.json()["id"]

    res = await client.patch(f"/api/v1/sessions/{session_id}/complete", headers=auth_header(chw_tokens))
    assert res.status_code == 409


@pytest.mark.asyncio
async def test_consent_requires_session_member(client: AsyncClient, chw_tokens, member_tokens):
    request_id = await create_request_and_match(client, member_tokens, chw_tokens)

    res = await client.post("/api/v1/sessions/", json={
        "request_id": request_id, "scheduled_at": "2026-04-10T10:00:00Z", "mode": "in_person",
    }, headers=auth_header(chw_tokens))
    session_id = res.json()["id"]

    res = await client.post(f"/api/v1/sessions/{session_id}/consent", json={
        "consent_type": "medical_billing", "typed_signature": "Test CHW",
    }, headers=auth_header(chw_tokens))
    assert res.status_code == 403

    res = await client.post(f"/api/v1/sessions/{session_id}/consent", json={
        "consent_type": "medical_billing", "typed_signature": "Test Member",
    }, headers=auth_header(member_tokens))
    assert res.status_code == 200


@pytest.mark.asyncio
async def test_documentation_duplicate_rejected(client: AsyncClient, chw_tokens, member_tokens):
    request_id = await create_request_and_match(client, member_tokens, chw_tokens)

    res = await client.post("/api/v1/sessions/", json={
        "request_id": request_id, "scheduled_at": "2026-04-10T10:00:00Z", "mode": "in_person",
    }, headers=auth_header(chw_tokens))
    session_id = res.json()["id"]

    await client.patch(f"/api/v1/sessions/{session_id}/start", headers=auth_header(chw_tokens))
    await client.patch(f"/api/v1/sessions/{session_id}/complete", headers=auth_header(chw_tokens))

    doc_payload = {
        "summary": "Helped with housing", "diagnosis_codes": ["Z59.1"],
        "procedure_code": "98960", "units_to_bill": 2,
    }

    res = await client.post(f"/api/v1/sessions/{session_id}/documentation", json=doc_payload, headers=auth_header(chw_tokens))
    assert res.status_code == 200

    res = await client.post(f"/api/v1/sessions/{session_id}/documentation", json=doc_payload, headers=auth_header(chw_tokens))
    assert res.status_code == 409


@pytest.mark.asyncio
async def test_invalid_enum_rejected(client: AsyncClient, member_tokens):
    res = await client.post("/api/v1/requests/", json={
        "vertical": "invalid_vertical", "urgency": "routine",
        "description": "Test", "preferred_mode": "in_person",
    }, headers=auth_header(member_tokens))
    assert res.status_code == 422


# ── End Session lifecycle tests ───────────────────────────────────────────────


async def _create_in_progress_session(
    client: AsyncClient,
    member_tokens: dict,
    chw_tokens: dict,
) -> str:
    """Helper: create a service request, create a session, and start it.

    Returns the session_id (str) of the in_progress session.
    """
    request_id = await create_request_and_match(client, member_tokens, chw_tokens)

    res = await client.post(
        "/api/v1/sessions/",
        json={"request_id": request_id, "scheduled_at": "2026-06-10T10:00:00Z", "mode": "in_person"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201
    session_id = res.json()["id"]

    res = await client.patch(
        f"/api/v1/sessions/{session_id}/start",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200
    assert res.json()["status"] == "in_progress"
    return session_id


@pytest.mark.asyncio
async def test_end_session_transitions_to_awaiting_documentation(
    client: AsyncClient, chw_tokens, member_tokens
):
    """POST /end on an in_progress session should return awaiting_documentation."""
    session_id = await _create_in_progress_session(client, member_tokens, chw_tokens)

    res = await client.post(
        f"/api/v1/sessions/{session_id}/end",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "awaiting_documentation"
    assert data["ended_at"] is not None


@pytest.mark.asyncio
async def test_end_session_idempotent(client: AsyncClient, chw_tokens, member_tokens):
    """Calling /end a second time returns 200 with current state (no error)."""
    session_id = await _create_in_progress_session(client, member_tokens, chw_tokens)

    # First call: transitions correctly.
    res = await client.post(
        f"/api/v1/sessions/{session_id}/end",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200
    assert res.json()["status"] == "awaiting_documentation"

    # Second call: idempotent — still 200, no status change.
    res = await client.post(
        f"/api/v1/sessions/{session_id}/end",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200
    assert res.json()["status"] == "awaiting_documentation"


@pytest.mark.asyncio
async def test_end_session_rejects_scheduled(client: AsyncClient, chw_tokens, member_tokens):
    """POST /end on a scheduled (not yet started) session should return 409."""
    request_id = await create_request_and_match(client, member_tokens, chw_tokens)

    res = await client.post(
        "/api/v1/sessions/",
        json={"request_id": request_id, "scheduled_at": "2026-06-10T10:00:00Z", "mode": "in_person"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201
    session_id = res.json()["id"]
    assert res.json()["status"] == "scheduled"

    res = await client.post(
        f"/api/v1/sessions/{session_id}/end",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 409


@pytest.mark.asyncio
async def test_end_session_rejects_completed(client: AsyncClient, chw_tokens, member_tokens):
    """POST /end on an already-completed session should return 409."""
    session_id = await _create_in_progress_session(client, member_tokens, chw_tokens)

    # Transition to completed via /complete
    res = await client.patch(
        f"/api/v1/sessions/{session_id}/complete",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200
    assert res.json()["status"] == "completed"

    # Now attempt /end on a completed session
    res = await client.post(
        f"/api/v1/sessions/{session_id}/end",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 409


@pytest.mark.asyncio
async def test_end_session_relationship_gate(client: AsyncClient, chw_tokens, member_tokens):
    """A second CHW must not be able to end a session they don't own.

    This verifies both the 404-not-403 behaviour (don't reveal existence).
    """
    session_id = await _create_in_progress_session(client, member_tokens, chw_tokens)

    # Register a second CHW.
    res = await client.post("/api/v1/auth/register", json={
        "email": "chw2@example.com", "password": "testpass123",
        "name": "Second CHW", "role": "chw",
    })
    assert res.status_code == 201
    other_chw_tokens = res.json()

    res = await client.post(
        f"/api/v1/sessions/{session_id}/end",
        headers=auth_header(other_chw_tokens),
    )
    assert res.status_code == 404

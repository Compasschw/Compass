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
async def test_documentation_completes_awaiting_session(
    client: AsyncClient, chw_tokens, member_tokens
):
    """Submitting documentation completes an awaiting_documentation session.

    Regression: the real CHW flow is Complete Session → /end
    (awaiting_documentation) → /documentation. Before the fix, /documentation
    left the session in awaiting_documentation, so the CHW's "Complete Session"
    button never flipped back to "Begin Session".
    """
    session_id = await _create_in_progress_session(client, member_tokens, chw_tokens)

    # End → awaiting_documentation
    res = await client.post(
        f"/api/v1/sessions/{session_id}/end", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200
    assert res.json()["status"] == "awaiting_documentation"

    # Submit documentation → should complete the session.
    doc_payload = {
        "summary": "Helped with housing",
        "diagnosis_codes": ["Z59.1"],
        "procedure_code": "98960",
        "units_to_bill": 1,
    }
    res = await client.post(
        f"/api/v1/sessions/{session_id}/documentation",
        json=doc_payload,
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200

    # The session is now completed (the bug left it in awaiting_documentation).
    res = await client.get(
        f"/api/v1/sessions/{session_id}", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200
    assert res.json()["status"] == "completed"


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


@pytest.mark.asyncio
async def test_roadmap_item_includes_session_id_and_mark_complete_succeeds(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict
) -> None:
    """Regression: GET /member/roadmap must include session_id on each item so
    the member-side 'mark complete' PATCH /sessions/{id}/followups/{id} can
    resolve the correct session row.  Without session_id the client falls back
    to 'unknown' and the PATCH 404s.

    This test FAILS on the pre-fix frontend type (SessionFollowup lacked
    sessionId) and would FAIL on a backend that stopped returning session_id.
    """
    import base64
    import json as _json
    import uuid as _uuid

    from app.models.followup import SessionFollowup as SessionFollowupModel
    from tests.conftest import test_session

    # ── Setup: request → accept → session ────────────────────────────────────
    request_id = await create_request_and_match(client, member_tokens, chw_tokens)

    res = await client.post(
        "/api/v1/sessions/",
        json={"request_id": request_id, "scheduled_at": "2026-04-10T10:00:00Z", "mode": "in_person"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    session_id = res.json()["id"]

    def _decode_sub(tokens: dict) -> str:
        seg = tokens["access_token"].split(".")[1]
        padded = seg + "=" * (4 - len(seg) % 4)
        return _json.loads(base64.urlsafe_b64decode(padded))["sub"]

    member_id = _decode_sub(member_tokens)
    chw_id = _decode_sub(chw_tokens)

    # ── Seed a roadmap followup row (no HTTP endpoint creates followups) ──────
    followup_id = _uuid.uuid4()
    async with test_session() as db:
        followup = SessionFollowupModel(
            id=followup_id,
            session_id=_uuid.UUID(session_id),
            chw_id=_uuid.UUID(chw_id),
            member_id=_uuid.UUID(member_id),
            kind="action_item",
            description="Schedule a housing intake appointment",
            show_on_roadmap=True,
            status="pending",
        )
        db.add(followup)
        await db.commit()

    # ── Assert: GET /member/roadmap returns session_id ────────────────────────
    res = await client.get("/api/v1/member/roadmap", headers=auth_header(member_tokens))
    assert res.status_code == 200, res.text
    items = res.json()
    assert len(items) == 1, f"Expected 1 roadmap item, got {len(items)}"
    item = items[0]
    assert str(item["session_id"]) == session_id, (
        "roadmap item missing session_id — mark-complete PATCH would 404 with 'unknown'"
    )
    assert str(item["id"]) == str(followup_id)

    # ── Assert: PATCH mark-complete as member succeeds ────────────────────────
    res = await client.patch(
        f"/api/v1/sessions/{session_id}/followups/{followup_id}",
        json={"status": "completed"},
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "completed"

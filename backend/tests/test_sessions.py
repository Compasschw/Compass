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

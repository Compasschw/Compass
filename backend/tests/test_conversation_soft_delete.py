"""Regression tests for Conversation soft-delete (messaging sprint).

Covers TESTING.md requirements:
  1. Negative auth (403) — non-participant cannot delete
  2. Member participant can also delete (both roles allowed)
  3. Idempotency — deleting an already-deleted thread is a safe no-op
  4. List filter — soft-deleted thread absent from GET /conversations/
  5. Message history preserved after soft-delete (HIPAA: no PHI lost)
  6. Auto-restore — sending a message to a deleted thread reactivates it
  7. No unhandled 500 on missing conversation (404 with CORS-safe response)
"""
from __future__ import annotations

import uuid

import pytest
from httpx import AsyncClient

from tests.conftest import auth_header


# ─── Shared setup helper ──────────────────────────────────────────────────────


async def _setup_conversation(
    client: AsyncClient,
    *,
    chw_email: str = "sd_chw@example.com",
    member_email: str = "sd_member@example.com",
) -> tuple[dict, dict, str]:
    """Register a CHW + member pair, build the relationship, return conversation_id.

    Registers both users, creates a service request, CHW accepts, CHW schedules
    a session (satisfies the relationship guard), then calls find-or-create to
    obtain the canonical conversation UUID.

    Args:
        client:       The ASGI test client (request scope).
        chw_email:    Email for the CHW being registered.
        member_email: Email for the member being registered.

    Returns:
        Tuple of (chw_tokens, member_tokens, conversation_id).
    """
    chw_res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": chw_email,
            "password": "testpass123",
            "name": "Soft Delete CHW",
            "role": "chw",
        },
    )
    assert chw_res.status_code == 201, f"CHW register failed: {chw_res.text}"
    chw_tokens = chw_res.json()

    member_res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": member_email,
            "password": "testpass123",
            "name": "Soft Delete Member",
            "role": "member",
            "terms_accepted": True,
            "communications_consent": True,
            "phone": "+13105550100",
            "date_of_birth": "1993-01-05",
            "gender": "Female",
            "insurance_company": "Health Net",
            "medi_cal_id": "12345678A",
            "address_line1": "1 Main St",
            "city": "Los Angeles",
            "state": "CA",
            "zip_code": "90001",
        },
    )
    assert member_res.status_code == 201, f"Member register failed: {member_res.text}"
    member_tokens = member_res.json()

    # Build CHW↔member relationship: request → accept → schedule session.
    # The relationship guard on find-or-create requires at least one shared session.
    req_res = await client.post(
        "/api/v1/requests/",
        json={
            "vertical": "housing",
            "urgency": "routine",
            "description": "SD test request",
            "preferred_mode": "phone",
        },
        headers=auth_header(member_tokens),
    )
    assert req_res.status_code == 201, f"Request create failed: {req_res.text}"
    request_id = req_res.json()["id"]

    accept_res = await client.patch(
        f"/api/v1/requests/{request_id}/accept",
        headers=auth_header(chw_tokens),
    )
    assert accept_res.status_code == 200, f"Accept failed: {accept_res.text}"

    sess_res = await client.post(
        "/api/v1/sessions/",
        json={
            "request_id": request_id,
            "scheduled_at": "2026-07-01T10:00:00Z",
            "mode": "phone",
        },
        headers=auth_header(chw_tokens),
    )
    assert sess_res.status_code == 201, f"Session create failed: {sess_res.text}"

    # Decode CHW id from the JWT payload (no network round-trip needed).
    import base64
    import json as _json

    parts = chw_tokens["access_token"].split(".")
    padded = parts[1] + "=" * (4 - len(parts[1]) % 4)
    chw_id = _json.loads(base64.urlsafe_b64decode(padded))["sub"]

    foc_res = await client.post(
        "/api/v1/conversations/find-or-create",
        json={"peer_id": chw_id},
        headers=auth_header(member_tokens),
    )
    assert foc_res.status_code == 200, f"find-or-create failed: {foc_res.text}"
    conversation_id = foc_res.json()["id"]

    return chw_tokens, member_tokens, conversation_id


# ─── Tests ────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_soft_delete_conversation_returns_200_with_deleted_at(client: AsyncClient):
    """Happy path: participant can soft-delete; response carries deleted_at."""
    chw_tokens, _, conversation_id = await _setup_conversation(client)

    res = await client.delete(
        f"/api/v1/conversations/{conversation_id}",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, f"Expected 200, got {res.status_code}: {res.text}"
    body = res.json()
    assert body["id"] == conversation_id
    assert body["deleted_at"] is not None
    assert body["deleted_by_user_id"] is not None


@pytest.mark.asyncio
async def test_soft_delete_non_participant_returns_403(client: AsyncClient):
    """TESTING.md rule 1 (negative auth): a third-party CHW cannot delete.

    This is the regression test for the negative-auth case. A CHW who shares
    no session with the member must receive 403, not 200 or 404.
    """
    _, _, conversation_id = await _setup_conversation(client)

    # Register a second, unrelated CHW — no shared session with the member.
    other_chw_res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "other_sd_chw@example.com",
            "password": "testpass123",
            "name": "Other CHW",
            "role": "chw",
        },
    )
    assert other_chw_res.status_code == 201, f"Other CHW register: {other_chw_res.text}"
    other_chw_tokens = other_chw_res.json()

    res = await client.delete(
        f"/api/v1/conversations/{conversation_id}",
        headers=auth_header(other_chw_tokens),
    )
    assert res.status_code == 403, (
        f"Expected 403 for non-participant, got {res.status_code}: {res.text}"
    )


@pytest.mark.asyncio
async def test_soft_delete_by_member_participant_is_forbidden(client: AsyncClient):
    """Members cannot delete threads — deletion is CHW-only.

    Soft-delete is global (it hides the thread from the CHW too), so a member
    must not be able to remove a thread from the CHW's inbox. The member on the
    thread gets 403, and the thread stays intact.
    """
    chw_tokens, member_tokens, conversation_id = await _setup_conversation(client)

    res = await client.delete(
        f"/api/v1/conversations/{conversation_id}",
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 403, (
        f"Member delete should be forbidden: {res.status_code}: {res.text}"
    )

    # Thread must still be present in the CHW's inbox (not deleted).
    listing = await client.get(
        "/api/v1/conversations/",
        headers=auth_header(chw_tokens),
    )
    assert listing.status_code == 200
    ids = [c["id"] for c in listing.json()]
    assert conversation_id in ids, "Thread must remain after a rejected member delete"


@pytest.mark.asyncio
async def test_soft_delete_is_idempotent(client: AsyncClient):
    """Deleting an already-deleted thread returns 200 with unchanged deleted_at.

    TESTING.md rule 4: post-failure / post-retry DB state.
    Double-deleting must not produce a 500 or change deleted_at.
    """
    chw_tokens, _, conversation_id = await _setup_conversation(client)

    first = await client.delete(
        f"/api/v1/conversations/{conversation_id}",
        headers=auth_header(chw_tokens),
    )
    assert first.status_code == 200, f"First delete: {first.text}"
    first_deleted_at = first.json()["deleted_at"]

    second = await client.delete(
        f"/api/v1/conversations/{conversation_id}",
        headers=auth_header(chw_tokens),
    )
    assert second.status_code == 200, f"Second delete: {second.status_code}: {second.text}"
    # deleted_at must NOT change on the second call (idempotent).
    assert second.json()["deleted_at"] == first_deleted_at, (
        "Idempotency violated: deleted_at changed on second call."
    )


@pytest.mark.asyncio
async def test_soft_deleted_thread_absent_from_list(client: AsyncClient):
    """GET /conversations/ must hide soft-deleted threads."""
    chw_tokens, _, conversation_id = await _setup_conversation(client)

    # Verify the thread IS in the list before deletion.
    before_list = await client.get(
        "/api/v1/conversations/",
        headers=auth_header(chw_tokens),
    )
    assert before_list.status_code == 200
    before_ids = [c["id"] for c in before_list.json()]
    assert conversation_id in before_ids, "Thread should be in list before deletion."

    await client.delete(
        f"/api/v1/conversations/{conversation_id}",
        headers=auth_header(chw_tokens),
    )

    after_list = await client.get(
        "/api/v1/conversations/",
        headers=auth_header(chw_tokens),
    )
    assert after_list.status_code == 200
    after_ids = [c["id"] for c in after_list.json()]
    assert conversation_id not in after_ids, (
        "Soft-deleted thread must not appear in GET /conversations/ list."
    )


@pytest.mark.asyncio
async def test_soft_delete_preserves_message_history(client: AsyncClient):
    """Messages survive the soft-delete — HIPAA: no PHI loss."""
    chw_tokens, _, conversation_id = await _setup_conversation(client)

    # Send a message before deletion.
    msg_res = await client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"body": "HIPAA test message — must survive delete", "type": "text"},
        headers=auth_header(chw_tokens),
    )
    assert msg_res.status_code == 201, f"Send message: {msg_res.text}"
    message_id = msg_res.json()["id"]

    # Soft-delete the thread.
    del_res = await client.delete(
        f"/api/v1/conversations/{conversation_id}",
        headers=auth_header(chw_tokens),
    )
    assert del_res.status_code == 200

    # Messages are still fetchable by conversation id (audit access).
    msgs_res = await client.get(
        f"/api/v1/conversations/{conversation_id}/messages",
        headers=auth_header(chw_tokens),
    )
    assert msgs_res.status_code == 200
    msg_ids = [m["id"] for m in msgs_res.json()]
    assert message_id in msg_ids, (
        "Message must be preserved after soft-delete (HIPAA 6-year retention)."
    )


@pytest.mark.asyncio
async def test_auto_restore_on_new_message(client: AsyncClient):
    """Sending a message to a soft-deleted thread reactivates it.

    After restoration, the thread must reappear in the GET /conversations/ list.
    """
    chw_tokens, member_tokens, conversation_id = await _setup_conversation(client)

    # Soft-delete the thread.
    del_res = await client.delete(
        f"/api/v1/conversations/{conversation_id}",
        headers=auth_header(chw_tokens),
    )
    assert del_res.status_code == 200

    # Verify it's gone from the CHW's list.
    list_res = await client.get("/api/v1/conversations/", headers=auth_header(chw_tokens))
    assert list_res.status_code == 200
    assert conversation_id not in [c["id"] for c in list_res.json()], (
        "Thread should be absent from list after soft-delete."
    )

    # Member sends a message — this should auto-restore the thread.
    restore_res = await client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"body": "Reactivating thread", "type": "text"},
        headers=auth_header(member_tokens),
    )
    assert restore_res.status_code == 201, (
        f"Send to deleted thread: {restore_res.status_code}: {restore_res.text}"
    )

    # Thread must be back in the CHW's inbox list.
    list_after = await client.get("/api/v1/conversations/", headers=auth_header(chw_tokens))
    assert list_after.status_code == 200
    after_ids = [c["id"] for c in list_after.json()]
    assert conversation_id in after_ids, (
        "Thread must reappear in list after a new message triggers auto-restore."
    )


@pytest.mark.asyncio
async def test_soft_delete_nonexistent_conversation_returns_404(client: AsyncClient):
    """TESTING.md rule 3 (no unhandled 500): missing conversation gets 404 not 500."""
    chw_tokens, _, _ = await _setup_conversation(client)
    fake_id = str(uuid.uuid4())

    res = await client.delete(
        f"/api/v1/conversations/{fake_id}",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 404, (
        f"Expected 404 for missing conversation, got {res.status_code}: {res.text}"
    )

"""Integration tests for GET /chw/members/{member_id}/attachments.

QA item ② — CHW Documents page becomes a member list -> per-member repository.
This endpoint feeds the "From Chat" side of that repository: chat file
attachments merged (client-side) with uploaded MemberDocument rows.

Coverage (per backend/TESTING.md):
  1. Happy path — attachment sent in a chat conversation appears with correct
     metadata (filename, content_type, size_bytes, created_at, and an `id`
     that is the MESSAGE id, matching what the attachment-url download
     endpoint expects).
  2. Pagination — page_size respected, total reflects full count, page 2
     returns the remaining item.
  3. Non-owning CHW negative — a second CHW with NO relationship to the
     member gets 403, not the attachment data.
  4. A CHW with a relationship to the member, but via a DIFFERENT CHW's
     conversation, does not see that other CHW's chat attachments (scoping
     to "conversations WITH THE CALLING CHW", not just any relationship).
  5. Member-role negative — a member (even the owning member) gets 403;
     this is a CHW/admin-only endpoint.
  6. Unauthenticated — 401.
  7. Member with no conversations at all — empty page, not an error.
  8. Member with a conversation but no attachments — empty page.
  9. Admin — sees attachments across ALL CHWs' conversations with the member.
"""
from __future__ import annotations

import base64
import json as _json

import pytest
from httpx import AsyncClient

from tests.conftest import auth_header, complete_member_signup_payload

# ─── Shared helpers ────────────────────────────────────────────────────────────


async def _register_chw(client: AsyncClient, *, email: str, name: str = "CHW User") -> dict:
    res = await client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "Testpass123!", "name": name, "role": "chw"},
    )
    assert res.status_code == 201, f"CHW register failed: {res.text}"
    return res.json()


async def _register_member(client: AsyncClient, *, email: str, name: str = "Member User") -> dict:
    res = await client.post(
        "/api/v1/auth/register",
        json=complete_member_signup_payload(email=email, name=name),
    )
    assert res.status_code == 201, f"Member register failed: {res.text}"
    return res.json()


def _decode_user_id(tokens: dict) -> str:
    parts = tokens["access_token"].split(".")
    padded = parts[1] + "=" * (4 - len(parts[1]) % 4)
    return _json.loads(base64.urlsafe_b64decode(padded))["sub"]


async def _get_member_user_id(client: AsyncClient, member_tokens: dict) -> str:
    res = await client.get("/api/v1/member/profile", headers=auth_header(member_tokens))
    assert res.status_code == 200, res.text
    return res.json()["user_id"]


async def _build_relationship_and_conversation(
    client: AsyncClient,
    *,
    chw_tokens: dict,
    member_tokens: dict,
) -> str:
    """Create request -> accept -> schedule session -> find-or-create conversation.

    Establishes the CHW<->member care relationship (via a scheduled Session)
    AND returns the conversation_id UUID string for that pair.
    """
    req_res = await client.post(
        "/api/v1/requests/",
        json={"vertical": "housing", "urgency": "routine", "description": "Test", "preferred_mode": "phone"},
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
        json={"request_id": request_id, "scheduled_at": "2026-07-01T10:00:00Z", "mode": "phone"},
        headers=auth_header(chw_tokens),
    )
    assert sess_res.status_code == 201, sess_res.text

    chw_id = _decode_user_id(chw_tokens)

    foc_res = await client.post(
        "/api/v1/conversations/find-or-create",
        json={"peer_id": chw_id},
        headers=auth_header(member_tokens),
    )
    assert foc_res.status_code == 200, foc_res.text
    return foc_res.json()["id"]


async def _send_attachment_message(
    client: AsyncClient,
    *,
    conversation_id: str,
    sender_tokens: dict,
    filename: str,
    s3_key: str | None = None,
    content_type: str = "application/pdf",
    size_bytes: int = 2048,
    body: str = "Sharing a file",
) -> dict:
    res = await client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={
            "body": body,
            "type": "file",
            "attachment_s3_key": s3_key or f"conversations/{conversation_id}/{filename}",
            "attachment_filename": filename,
            "attachment_size_bytes": size_bytes,
            "attachment_content_type": content_type,
        },
        headers=auth_header(sender_tokens),
    )
    assert res.status_code == 201, res.text
    return res.json()


# ─── Fixtures ──────────────────────────────────────────────────────────────────


@pytest.fixture
async def chw_tokens(client: AsyncClient) -> dict:
    return await _register_chw(client, email="chw_attach_1@example.com", name="Primary CHW")


@pytest.fixture
async def chw2_tokens(client: AsyncClient) -> dict:
    return await _register_chw(client, email="chw_attach_2@example.com", name="Other CHW")


@pytest.fixture
async def member_tokens(client: AsyncClient) -> dict:
    return await _register_member(client, email="member_attach_1@example.com", name="Attach Member")


@pytest.fixture
async def member_id(client: AsyncClient, member_tokens: dict) -> str:
    return await _get_member_user_id(client, member_tokens)


# ─── 1. Happy path ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_chat_attachment_appears_with_correct_metadata(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, member_id: str
) -> None:
    conversation_id = await _build_relationship_and_conversation(
        client, chw_tokens=chw_tokens, member_tokens=member_tokens
    )
    sent = await _send_attachment_message(
        client,
        conversation_id=conversation_id,
        sender_tokens=member_tokens,
        filename="id_card.pdf",
        content_type="application/pdf",
        size_bytes=4096,
    )

    res = await client.get(
        f"/api/v1/chw/members/{member_id}/attachments",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["total"] == 1
    assert len(body["items"]) == 1
    item = body["items"][0]
    # The id must be the MESSAGE id — the download endpoint
    # (GET /conversations/messages/{message_id}/attachment-url) keys off it.
    assert item["id"] == sent["id"]
    assert item["filename"] == "id_card.pdf"
    assert item["content_type"] == "application/pdf"
    assert item["size_bytes"] == 4096
    assert "created_at" in item and item["created_at"]


@pytest.mark.asyncio
async def test_text_only_messages_are_not_returned_as_attachments(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, member_id: str
) -> None:
    conversation_id = await _build_relationship_and_conversation(
        client, chw_tokens=chw_tokens, member_tokens=member_tokens
    )
    res = await client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"body": "just text, no file", "type": "text"},
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 201, res.text

    res = await client.get(
        f"/api/v1/chw/members/{member_id}/attachments",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    assert res.json()["total"] == 0
    assert res.json()["items"] == []


# ─── 2. Pagination ──────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_pagination_respects_page_size_and_total(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, member_id: str
) -> None:
    conversation_id = await _build_relationship_and_conversation(
        client, chw_tokens=chw_tokens, member_tokens=member_tokens
    )
    for i in range(3):
        await _send_attachment_message(
            client,
            conversation_id=conversation_id,
            sender_tokens=member_tokens,
            filename=f"doc_{i}.pdf",
        )

    res = await client.get(
        f"/api/v1/chw/members/{member_id}/attachments?page=1&page_size=2",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["total"] == 3
    assert len(body["items"]) == 2
    assert body["page"] == 1
    assert body["page_size"] == 2

    res2 = await client.get(
        f"/api/v1/chw/members/{member_id}/attachments?page=2&page_size=2",
        headers=auth_header(chw_tokens),
    )
    assert res2.status_code == 200, res2.text
    body2 = res2.json()
    assert body2["total"] == 3
    assert len(body2["items"]) == 1

    # Newest-first ordering: page 1's newest item should not repeat on page 2.
    page1_ids = {it["id"] for it in body["items"]}
    page2_ids = {it["id"] for it in body2["items"]}
    assert page1_ids.isdisjoint(page2_ids)


# ─── 3. Non-owning CHW negative ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_chw_without_relationship_gets_403(
    client: AsyncClient, chw_tokens: dict, chw2_tokens: dict, member_tokens: dict, member_id: str
) -> None:
    conversation_id = await _build_relationship_and_conversation(
        client, chw_tokens=chw_tokens, member_tokens=member_tokens
    )
    await _send_attachment_message(
        client, conversation_id=conversation_id, sender_tokens=member_tokens, filename="secret.pdf"
    )

    res = await client.get(
        f"/api/v1/chw/members/{member_id}/attachments",
        headers=auth_header(chw2_tokens),
    )
    assert res.status_code == 403, res.text


# ─── 4. Relationship via ONE CHW must not leak another CHW's thread ────────────


@pytest.mark.asyncio
async def test_chw_with_own_relationship_does_not_see_other_chws_attachments(
    client: AsyncClient,
    chw_tokens: dict,
    chw2_tokens: dict,
    member_tokens: dict,
    member_id: str,
) -> None:
    """Both CHWs build an independent relationship + conversation with the same
    member. chw2 must see ONLY its own conversation's attachments, never
    chw_tokens' — the scope is "conversations WITH THE CALLING CHW", not
    "any CHW who has ever had a relationship with this member".
    """
    conv1 = await _build_relationship_and_conversation(
        client, chw_tokens=chw_tokens, member_tokens=member_tokens
    )
    await _send_attachment_message(
        client, conversation_id=conv1, sender_tokens=member_tokens, filename="for_chw1.pdf"
    )

    conv2 = await _build_relationship_and_conversation(
        client, chw_tokens=chw2_tokens, member_tokens=member_tokens
    )
    sent2 = await _send_attachment_message(
        client, conversation_id=conv2, sender_tokens=member_tokens, filename="for_chw2.pdf"
    )

    res = await client.get(
        f"/api/v1/chw/members/{member_id}/attachments",
        headers=auth_header(chw2_tokens),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["total"] == 1
    assert body["items"][0]["id"] == sent2["id"]
    assert body["items"][0]["filename"] == "for_chw2.pdf"


# ─── 5. Member-role negative ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_member_caller_gets_403(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, member_id: str
) -> None:
    conversation_id = await _build_relationship_and_conversation(
        client, chw_tokens=chw_tokens, member_tokens=member_tokens
    )
    await _send_attachment_message(
        client, conversation_id=conversation_id, sender_tokens=member_tokens, filename="own.pdf"
    )

    # Even the owning member cannot call this CHW-only endpoint.
    res = await client.get(
        f"/api/v1/chw/members/{member_id}/attachments",
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 403, res.text


# ─── 6. Unauthenticated ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_unauthenticated_gets_401(client: AsyncClient, member_id: str) -> None:
    res = await client.get(f"/api/v1/chw/members/{member_id}/attachments")
    assert res.status_code == 401, res.text


# ─── 7 & 8. Empty states — no conversations / no attachments ──────────────────────


@pytest.mark.asyncio
async def test_member_with_no_conversations_returns_empty_page_not_error(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, member_id: str
) -> None:
    """A CHW with a relationship (via ServiceRequest, no conversation ever
    created) must get an empty page, never a 404/500."""
    req_res = await client.post(
        "/api/v1/requests/",
        json={"vertical": "housing", "urgency": "routine", "description": "Test", "preferred_mode": "phone"},
        headers=auth_header(member_tokens),
    )
    assert req_res.status_code == 201, req_res.text
    request_id = req_res.json()["id"]

    accept_res = await client.patch(
        f"/api/v1/requests/{request_id}/accept",
        headers=auth_header(chw_tokens),
    )
    assert accept_res.status_code == 200, accept_res.text

    res = await client.get(
        f"/api/v1/chw/members/{member_id}/attachments",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["total"] == 0
    assert body["items"] == []


@pytest.mark.asyncio
async def test_member_with_conversation_but_no_attachments_returns_empty_page(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, member_id: str
) -> None:
    await _build_relationship_and_conversation(
        client, chw_tokens=chw_tokens, member_tokens=member_tokens
    )
    res = await client.get(
        f"/api/v1/chw/members/{member_id}/attachments",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["total"] == 0
    assert body["items"] == []


# ─── 9. Admin sees across all CHWs ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_admin_sees_attachments_across_all_chws(
    client: AsyncClient,
    chw_tokens: dict,
    chw2_tokens: dict,
    member_tokens: dict,
    member_id: str,
) -> None:
    from app.config import settings

    conv1 = await _build_relationship_and_conversation(
        client, chw_tokens=chw_tokens, member_tokens=member_tokens
    )
    await _send_attachment_message(
        client, conversation_id=conv1, sender_tokens=member_tokens, filename="for_chw1.pdf"
    )
    conv2 = await _build_relationship_and_conversation(
        client, chw_tokens=chw2_tokens, member_tokens=member_tokens
    )
    await _send_attachment_message(
        client, conversation_id=conv2, sender_tokens=member_tokens, filename="for_chw2.pdf"
    )

    res = await client.get(
        f"/api/v1/chw/members/{member_id}/attachments",
        headers={"Authorization": f"Bearer {settings.admin_key}"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["total"] == 2
    filenames = {it["filename"] for it in body["items"]}
    assert filenames == {"for_chw1.pdf", "for_chw2.pdf"}

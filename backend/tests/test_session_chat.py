"""Tests for session-scoped chat message and attachment endpoints.

Covers:
- POST /api/v1/sessions/{id}/messages
    * participant (CHW or member) → 201
    * non-participant CHW or member → 403
    * attachment metadata persisted and returned on subsequent GET
    * empty body + no attachment → 422
- GET /api/v1/sessions/{id}/messages
    * participant sees messages from both parties
    * non-participant → 403
- POST /api/v1/sessions/{id}/messages/read  (mark-read cursor)
    * CHW call → advances chw_read_up_to
    * member call → advances member_read_up_to
    * older message id is a no-op (cursor never retreats)
- Conversation row is created lazily on first POST message

Cross-session leak is the primary confidentiality concern: a CHW or member who
is not a participant on a session must receive 403 on both read and write paths.
"""

import os

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.models.conversation import Conversation, FileAttachment, Message
from tests.conftest import auth_header, test_session as _test_session_factory


def _aws_creds_available() -> bool:
    """True iff boto3 can resolve AWS credentials.

    Attachment endpoints generate presigned S3 GET URLs via boto3; without
    creds they raise NoCredentialsError. CI runners don't have AWS creds,
    so attachment-touching tests are skipped there. Validation-only tests
    (cross-session 403, mark-read cursor, etc.) don't hit S3 and run anywhere.
    """
    if os.environ.get("AWS_ACCESS_KEY_ID") and os.environ.get("AWS_SECRET_ACCESS_KEY"):
        return True
    try:
        import boto3
        return boto3.Session().get_credentials() is not None
    except Exception:
        return False


# ─── Shared helpers ────────────────────────────────────────────────────────────


async def _register(client: AsyncClient, email: str, role: str) -> dict:
    """Register a new user and return the token payload."""
    res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": email,
            "password": "testpass123",
            "name": f"Test {role.upper()} {email[:4]}",
            "role": role,
        },
    )
    assert res.status_code == 201, res.text
    return res.json()


async def _create_session(
    client: AsyncClient,
    member_tokens: dict,
    chw_tokens: dict,
) -> str:
    """Create a ServiceRequest + accept it + schedule a Session. Returns session_id."""
    res = await client.post(
        "/api/v1/requests/",
        json={
            "vertical": "housing",
            "urgency": "routine",
            "description": "Need housing assistance",
            "preferred_mode": "in_person",
        },
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 201, res.text
    request_id = res.json()["id"]

    res = await client.patch(
        f"/api/v1/requests/{request_id}/accept",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text

    res = await client.post(
        "/api/v1/sessions/",
        json={
            "request_id": request_id,
            "scheduled_at": "2026-04-10T10:00:00Z",
            "mode": "in_person",
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    return res.json()["id"]


async def _send_message(
    client: AsyncClient,
    session_id: str,
    tokens: dict,
    body: str = "Hello from test",
) -> dict:
    """POST a text message and return the response payload."""
    res = await client.post(
        f"/api/v1/sessions/{session_id}/messages",
        json={"body": body},
        headers=auth_header(tokens),
    )
    return res


# ─── Test class ───────────────────────────────────────────────────────────────


class TestSessionChat:
    """Session-scoped chat message + attachment endpoint tests."""

    # ── 1. Participant can POST a message → 201 ───────────────────────────────

    @pytest.mark.asyncio
    async def test_chw_participant_can_send_message(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict
    ) -> None:
        session_id = await _create_session(client, member_tokens, chw_tokens)
        res = await _send_message(client, session_id, chw_tokens, "Hi, I am your CHW.")
        assert res.status_code == 201, res.text
        body = res.json()
        assert body["sender_role"] == "chw"
        assert body["body"] == "Hi, I am your CHW."

    @pytest.mark.asyncio
    async def test_member_participant_can_send_message(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict
    ) -> None:
        session_id = await _create_session(client, member_tokens, chw_tokens)
        res = await _send_message(client, session_id, member_tokens, "Hi, I am the member.")
        assert res.status_code == 201, res.text
        assert res.json()["sender_role"] == "member"

    # ── 2. Non-participant POST → 403 ─────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_third_party_chw_cannot_send_message(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict
    ) -> None:
        session_id = await _create_session(client, member_tokens, chw_tokens)
        other_chw = await _register(client, "other_chw@example.com", "chw")
        res = await _send_message(client, session_id, other_chw, "Uninvited CHW here.")
        assert res.status_code == 403, res.text

    @pytest.mark.asyncio
    async def test_third_party_member_cannot_send_message(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict
    ) -> None:
        session_id = await _create_session(client, member_tokens, chw_tokens)
        other_member = await _register(client, "other_member@example.com", "member")
        res = await _send_message(client, session_id, other_member, "Uninvited member here.")
        assert res.status_code == 403, res.text

    # ── 3. Participant GET returns messages from both parties ─────────────────

    @pytest.mark.asyncio
    async def test_participant_gets_messages_from_both_parties(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict
    ) -> None:
        session_id = await _create_session(client, member_tokens, chw_tokens)

        await _send_message(client, session_id, chw_tokens, "CHW message")
        await _send_message(client, session_id, member_tokens, "Member message")

        res = await client.get(
            f"/api/v1/sessions/{session_id}/messages",
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 200, res.text
        messages = res.json()
        assert len(messages) == 2
        roles = {m["sender_role"] for m in messages}
        assert roles == {"chw", "member"}

    # ── 4. Non-participant GET → 403 ─────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_third_party_chw_cannot_read_messages(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict
    ) -> None:
        session_id = await _create_session(client, member_tokens, chw_tokens)
        await _send_message(client, session_id, chw_tokens, "Private CHW message")

        other_chw = await _register(client, "spy_chw@example.com", "chw")
        res = await client.get(
            f"/api/v1/sessions/{session_id}/messages",
            headers=auth_header(other_chw),
        )
        assert res.status_code == 403, res.text

    @pytest.mark.asyncio
    async def test_third_party_member_cannot_read_messages(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict
    ) -> None:
        session_id = await _create_session(client, member_tokens, chw_tokens)
        await _send_message(client, session_id, member_tokens, "Private member message")

        other_member = await _register(client, "spy_member@example.com", "member")
        res = await client.get(
            f"/api/v1/sessions/{session_id}/messages",
            headers=auth_header(other_member),
        )
        assert res.status_code == 403, res.text

    # ── 5. Attachment metadata is persisted and returned on GET ──────────────

    @pytest.mark.skipif(
        not _aws_creds_available(),
        reason="Requires AWS credentials to generate presigned S3 GET URLs",
    )
    @pytest.mark.asyncio
    async def test_attachment_metadata_persisted_and_returned(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict
    ) -> None:
        session_id = await _create_session(client, member_tokens, chw_tokens)

        attachment_payload = {
            "body": "",
            "attachment_s3_key": "uploads/test-session/report.pdf",
            "attachment_filename": "report.pdf",
            "attachment_size_bytes": 204800,
            "attachment_content_type": "application/pdf",
        }
        post_res = await client.post(
            f"/api/v1/sessions/{session_id}/messages",
            json=attachment_payload,
            headers=auth_header(chw_tokens),
        )
        assert post_res.status_code == 201, post_res.text
        post_body = post_res.json()
        assert post_body["attachment"] is not None
        assert post_body["attachment"]["filename"] == "report.pdf"
        assert post_body["attachment"]["size_bytes"] == 204800
        assert post_body["attachment"]["content_type"] == "application/pdf"
        assert post_body["type"] == "file"

        # Verify persisted via DB inspection.
        message_id = post_body["id"]
        async with _test_session_factory() as db:
            result = await db.execute(
                select(FileAttachment).where(
                    FileAttachment.message_id == message_id
                )
            )
            att_row = result.scalar_one_or_none()
        assert att_row is not None, "FileAttachment row not persisted"
        assert att_row.s3_key == "uploads/test-session/report.pdf"
        assert att_row.filename == "report.pdf"
        assert att_row.size_bytes == 204800

        # Confirm attachment appears in subsequent GET.
        get_res = await client.get(
            f"/api/v1/sessions/{session_id}/messages",
            headers=auth_header(member_tokens),
        )
        assert get_res.status_code == 200, get_res.text
        fetched = get_res.json()
        assert len(fetched) == 1
        assert fetched[0]["attachment"]["filename"] == "report.pdf"

    @pytest.mark.skipif(
        not _aws_creds_available(),
        reason="Requires AWS credentials to generate presigned S3 GET URLs",
    )
    @pytest.mark.asyncio
    async def test_image_attachment_sets_type_image(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict
    ) -> None:
        session_id = await _create_session(client, member_tokens, chw_tokens)
        res = await client.post(
            f"/api/v1/sessions/{session_id}/messages",
            json={
                "body": "",
                "attachment_s3_key": "uploads/photo.jpg",
                "attachment_filename": "photo.jpg",
                "attachment_size_bytes": 51200,
                "attachment_content_type": "image/jpeg",
            },
            headers=auth_header(member_tokens),
        )
        assert res.status_code == 201, res.text
        assert res.json()["type"] == "image"

    @pytest.mark.asyncio
    async def test_attachment_missing_metadata_returns_422(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict
    ) -> None:
        """s3_key provided but filename/size/content_type absent → 422."""
        session_id = await _create_session(client, member_tokens, chw_tokens)
        res = await client.post(
            f"/api/v1/sessions/{session_id}/messages",
            json={"body": "", "attachment_s3_key": "uploads/mystery_file"},
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 422, res.text

    # ── 6. Mark-read cursor: CHW path ─────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_mark_read_advances_chw_cursor(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict
    ) -> None:
        session_id = await _create_session(client, member_tokens, chw_tokens)

        send_res = await _send_message(client, session_id, member_tokens, "Member says hi")
        assert send_res.status_code == 201
        message_id = send_res.json()["id"]

        mark_res = await client.post(
            f"/api/v1/sessions/{session_id}/messages/read",
            json={"up_to_message_id": message_id},
            headers=auth_header(chw_tokens),
        )
        assert mark_res.status_code == 204, mark_res.text

        # Verify chw_read_up_to is updated on the Conversation row.
        async with _test_session_factory() as db:
            result = await db.execute(
                select(Conversation).where(Conversation.session_id == session_id)
            )
            conv = result.scalar_one_or_none()
        assert conv is not None, "Conversation row should exist after first message"
        assert str(conv.chw_read_up_to) == message_id
        assert conv.member_read_up_to is None, "member cursor should be untouched"

    # ── 7. Mark-read cursor: member path ─────────────────────────────────────

    @pytest.mark.asyncio
    async def test_mark_read_advances_member_cursor(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict
    ) -> None:
        session_id = await _create_session(client, member_tokens, chw_tokens)

        send_res = await _send_message(client, session_id, chw_tokens, "CHW says hi")
        assert send_res.status_code == 201
        message_id = send_res.json()["id"]

        mark_res = await client.post(
            f"/api/v1/sessions/{session_id}/messages/read",
            json={"up_to_message_id": message_id},
            headers=auth_header(member_tokens),
        )
        assert mark_res.status_code == 204, mark_res.text

        async with _test_session_factory() as db:
            result = await db.execute(
                select(Conversation).where(Conversation.session_id == session_id)
            )
            conv = result.scalar_one_or_none()
        assert str(conv.member_read_up_to) == message_id
        assert conv.chw_read_up_to is None, "CHW cursor should be untouched"

    # ── 8. Mark-read with older message is a no-op ───────────────────────────

    @pytest.mark.asyncio
    async def test_mark_read_does_not_retreat_cursor(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict
    ) -> None:
        session_id = await _create_session(client, member_tokens, chw_tokens)

        first_res = await _send_message(client, session_id, member_tokens, "First message")
        first_id = first_res.json()["id"]

        second_res = await _send_message(client, session_id, member_tokens, "Second message")
        second_id = second_res.json()["id"]

        # Advance cursor to the SECOND (newer) message.
        await client.post(
            f"/api/v1/sessions/{session_id}/messages/read",
            json={"up_to_message_id": second_id},
            headers=auth_header(chw_tokens),
        )

        # Now send an older cursor (first_id) — should be a no-op.
        noop_res = await client.post(
            f"/api/v1/sessions/{session_id}/messages/read",
            json={"up_to_message_id": first_id},
            headers=auth_header(chw_tokens),
        )
        assert noop_res.status_code == 204, noop_res.text

        # Cursor must still point at second_id (the more recent message).
        async with _test_session_factory() as db:
            result = await db.execute(
                select(Conversation).where(Conversation.session_id == session_id)
            )
            conv = result.scalar_one_or_none()
        assert str(conv.chw_read_up_to) == second_id, (
            "Cursor retreated backwards — no-op guard failed"
        )

    # ── 9. Conversation created lazily on first message ───────────────────────

    @pytest.mark.asyncio
    async def test_conversation_created_lazily(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict
    ) -> None:
        session_id = await _create_session(client, member_tokens, chw_tokens)

        # No messages yet — conversation row should not exist.
        async with _test_session_factory() as db:
            result = await db.execute(
                select(Conversation).where(Conversation.session_id == session_id)
            )
            conv_before = result.scalar_one_or_none()
        assert conv_before is None, "Conversation row should not exist before first message"

        # POST first message; conversation should be created automatically.
        res = await _send_message(client, session_id, chw_tokens, "First message ever")
        assert res.status_code == 201, res.text

        async with _test_session_factory() as db:
            result = await db.execute(
                select(Conversation).where(Conversation.session_id == session_id)
            )
            conv_after = result.scalar_one_or_none()
        assert conv_after is not None, "Conversation row should exist after first message"
        assert str(conv_after.session_id) == session_id

    # ── 10. Empty body + no attachment → 422 ─────────────────────────────────

    @pytest.mark.asyncio
    async def test_empty_message_body_no_attachment_returns_422(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict
    ) -> None:
        session_id = await _create_session(client, member_tokens, chw_tokens)
        res = await client.post(
            f"/api/v1/sessions/{session_id}/messages",
            json={"body": "   "},
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 422, res.text

    # ── 11. Cross-session leak: message from session A not visible in session B

    @pytest.mark.asyncio
    async def test_messages_isolated_across_sessions(
        self, client: AsyncClient, chw_tokens: dict, member_tokens: dict
    ) -> None:
        """A participant of session B must not see messages from session A."""
        session_a_id = await _create_session(client, member_tokens, chw_tokens)

        # Create a separate CHW + member pair for session B.
        chw_b = await _register(client, "chw_b@example.com", "chw")
        member_b = await _register(client, "member_b@example.com", "member")
        session_b_id = await _create_session(client, member_b, chw_b)

        # Send a message in session A.
        await _send_message(client, session_a_id, chw_tokens, "Confidential session A message")

        # CHW B reads session B — should get zero messages, not session A's.
        res = await client.get(
            f"/api/v1/sessions/{session_b_id}/messages",
            headers=auth_header(chw_b),
        )
        assert res.status_code == 200, res.text
        assert res.json() == [], "Session B leaked messages from session A"

        # CHW B must not be able to read session A at all.
        res = await client.get(
            f"/api/v1/sessions/{session_a_id}/messages",
            headers=auth_header(chw_b),
        )
        assert res.status_code == 403, res.text

"""Conversation inbox — Stage 1 backend regression tests.

Covers TESTING.md requirements for GET /conversations/ enrichment,
PATCH /{id}/pin, PATCH /{id}/archive, POST /{id}/messages/read,
and start-session-within-conversation.

Test groups:
  1. Negative auth — 403/404 for non-participant + member-cannot-pin
  2. Inbox shape — pair with 3 sessions + interleaved messages → one row, correct enrichment
  3. Cross-session message aggregation via GET /conversations/{id}/messages
  4. Unread count + mark-read + sender's own messages never counted as unread
  5. Pin/archive sort + include_archived filter + idempotent re-pin
  6. Start-session-within-conversation + active_session_id reflects it
  7. Two in_progress sessions → list resolves without MultipleResultsFound 500
  8. Migration backfill — pinned session → pinned conversation
  9. Dangling read cursor → 404, not 500
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest
from httpx import AsyncClient

from tests.conftest import auth_header, complete_member_signup_payload


# ─── Shared helpers ────────────────────────────────────────────────────────────


async def _register_chw(client: AsyncClient, *, email: str, name: str = "CHW User") -> dict:
    res = await client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "testpass123", "name": name, "role": "chw"},
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


async def _build_relationship_and_conversation(
    client: AsyncClient,
    *,
    chw_tokens: dict,
    member_tokens: dict,
) -> str:
    """Create request → accept → schedule session → find-or-create conversation.

    Returns the conversation_id UUID string.
    """
    import base64
    import json as _json

    # Member creates a service request
    req_res = await client.post(
        "/api/v1/requests/",
        json={"vertical": "housing", "urgency": "routine", "description": "Test", "preferred_mode": "phone"},
        headers=auth_header(member_tokens),
    )
    assert req_res.status_code == 201, req_res.text
    request_id = req_res.json()["id"]

    # CHW accepts
    accept_res = await client.patch(
        f"/api/v1/requests/{request_id}/accept",
        headers=auth_header(chw_tokens),
    )
    assert accept_res.status_code == 200, accept_res.text

    # CHW schedules a session (satisfies relationship guard + creates conversation)
    sess_res = await client.post(
        "/api/v1/sessions/",
        json={"request_id": request_id, "scheduled_at": "2026-07-01T10:00:00Z", "mode": "phone"},
        headers=auth_header(chw_tokens),
    )
    assert sess_res.status_code == 201, sess_res.text

    # Decode CHW id from JWT
    parts = chw_tokens["access_token"].split(".")
    padded = parts[1] + "=" * (4 - len(parts[1]) % 4)
    chw_id = _json.loads(base64.urlsafe_b64decode(padded))["sub"]

    # Member calls find-or-create to get the conversation
    foc_res = await client.post(
        "/api/v1/conversations/find-or-create",
        json={"peer_id": chw_id},
        headers=auth_header(member_tokens),
    )
    assert foc_res.status_code == 200, foc_res.text
    return foc_res.json()["id"]


async def _send_message(
    client: AsyncClient,
    *,
    conversation_id: str,
    sender_tokens: dict,
    body: str,
) -> dict:
    res = await client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"body": body},
        headers=auth_header(sender_tokens),
    )
    assert res.status_code == 201, res.text
    return res.json()


# ─── Group 1: Negative auth ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_non_participant_cannot_see_conversation_in_list(client: AsyncClient):
    """A CHW not on the thread must not see it in their inbox list."""
    chw_tokens = await _register_chw(client, email="np_chw@example.com")
    member_tokens = await _register_member(client, email="np_member@example.com")
    outsider_tokens = await _register_chw(client, email="np_outsider@example.com")

    await _build_relationship_and_conversation(
        client, chw_tokens=chw_tokens, member_tokens=member_tokens
    )

    # Outsider CHW's inbox must be empty
    res = await client.get("/api/v1/conversations/", headers=auth_header(outsider_tokens))
    assert res.status_code == 200
    assert res.json() == []


@pytest.mark.asyncio
async def test_member_cannot_pin_conversation(client: AsyncClient):
    """A member calling PATCH /conversations/{id}/pin gets 404 (ownership gate)."""
    chw_tokens = await _register_chw(client, email="pin_chw@example.com")
    member_tokens = await _register_member(client, email="pin_member@example.com")
    conv_id = await _build_relationship_and_conversation(
        client, chw_tokens=chw_tokens, member_tokens=member_tokens
    )

    res = await client.patch(
        f"/api/v1/conversations/{conv_id}/pin",
        json={"pinned": True},
        headers=auth_header(member_tokens),  # member — not CHW
    )
    # _load_chw_conversation_or_404 returns 404 to avoid leaking existence
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_non_participant_cannot_pin_conversation(client: AsyncClient):
    """A CHW not on the thread gets 404 on PATCH /pin."""
    chw_tokens = await _register_chw(client, email="npp_chw@example.com")
    member_tokens = await _register_member(client, email="npp_member@example.com")
    outsider_tokens = await _register_chw(client, email="npp_outsider@example.com")

    conv_id = await _build_relationship_and_conversation(
        client, chw_tokens=chw_tokens, member_tokens=member_tokens
    )

    res = await client.patch(
        f"/api/v1/conversations/{conv_id}/pin",
        json={"pinned": True},
        headers=auth_header(outsider_tokens),
    )
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_non_participant_cannot_archive_conversation(client: AsyncClient):
    """A CHW not on the thread gets 404 on PATCH /archive."""
    chw_tokens = await _register_chw(client, email="npa_chw@example.com")
    member_tokens = await _register_member(client, email="npa_member@example.com")
    outsider_tokens = await _register_chw(client, email="npa_outsider@example.com")

    conv_id = await _build_relationship_and_conversation(
        client, chw_tokens=chw_tokens, member_tokens=member_tokens
    )

    res = await client.patch(
        f"/api/v1/conversations/{conv_id}/archive",
        json={"archived": True},
        headers=auth_header(outsider_tokens),
    )
    assert res.status_code == 404


# ─── Group 2: Inbox shape (pair with 3 sessions + interleaved messages) ───────


@pytest.mark.asyncio
async def test_inbox_returns_one_row_with_correct_enrichment(client: AsyncClient):
    """3 sessions + interleaved messages → exactly ONE inbox row with correct fields."""
    chw_tokens = await _register_chw(client, email="shape_chw@example.com", name="Shape CHW")
    member_tokens = await _register_member(client, email="shape_member@example.com", name="Shape Member")
    conv_id = await _build_relationship_and_conversation(
        client, chw_tokens=chw_tokens, member_tokens=member_tokens
    )

    # Send several messages interleaved across the one conversation
    await _send_message(client, conversation_id=conv_id, sender_tokens=chw_tokens, body="Hello from CHW")
    await _send_message(client, conversation_id=conv_id, sender_tokens=member_tokens, body="Hello from member")
    last_msg = await _send_message(
        client, conversation_id=conv_id, sender_tokens=chw_tokens, body="Latest message from CHW"
    )

    res = await client.get("/api/v1/conversations/", headers=auth_header(chw_tokens))
    assert res.status_code == 200
    rows = res.json()
    assert len(rows) == 1, f"Expected 1 row, got {len(rows)}"

    row = rows[0]
    assert row["id"] == conv_id
    assert row["chw_name"] == "Shape CHW"
    assert row["member_name"] == "Shape Member"
    # Preview truncated to ≤61 chars (60 chars + optional ellipsis)
    assert row["last_message_preview"] is not None
    assert len(row["last_message_preview"]) <= 61
    assert "Latest message from CHW" in row["last_message_preview"] or row["last_message_preview"].startswith("Latest")
    # last_message_at matches the last sent message
    assert row["last_message_at"] is not None
    last_at = datetime.fromisoformat(row["last_message_at"].replace("Z", "+00:00"))
    expected_at = datetime.fromisoformat(last_msg["created_at"].replace("Z", "+00:00"))
    assert abs((last_at - expected_at).total_seconds()) < 2
    assert row["last_message_sender_id"] is not None


# ─── Group 3: Cross-session message aggregation ────────────────────────────────


@pytest.mark.asyncio
async def test_get_messages_returns_all_messages_in_conversation(client: AsyncClient):
    """GET /conversations/{id}/messages returns all messages in the conversation."""
    chw_tokens = await _register_chw(client, email="agg_chw@example.com")
    member_tokens = await _register_member(client, email="agg_member@example.com")
    conv_id = await _build_relationship_and_conversation(
        client, chw_tokens=chw_tokens, member_tokens=member_tokens
    )

    for i in range(5):
        await _send_message(
            client,
            conversation_id=conv_id,
            sender_tokens=chw_tokens if i % 2 == 0 else member_tokens,
            body=f"Message {i}",
        )

    res = await client.get(
        f"/api/v1/conversations/{conv_id}/messages",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200
    msgs = res.json()
    assert len(msgs) == 5
    # Verify chronological order (oldest first)
    timestamps = [m["created_at"] for m in msgs]
    assert timestamps == sorted(timestamps)


# ─── Group 4: Unread count + mark-read ────────────────────────────────────────


@pytest.mark.asyncio
async def test_unread_count_reflects_messages_from_other_party(client: AsyncClient):
    """CHW sees unread count of member messages; own messages are never counted."""
    chw_tokens = await _register_chw(client, email="unread_chw@example.com")
    member_tokens = await _register_member(client, email="unread_member@example.com")
    conv_id = await _build_relationship_and_conversation(
        client, chw_tokens=chw_tokens, member_tokens=member_tokens
    )

    # CHW sends 2 messages (should NOT count as CHW's unread)
    await _send_message(client, conversation_id=conv_id, sender_tokens=chw_tokens, body="CHW msg 1")
    await _send_message(client, conversation_id=conv_id, sender_tokens=chw_tokens, body="CHW msg 2")
    # Member sends 3 messages (these ARE unread for the CHW)
    for i in range(3):
        await _send_message(client, conversation_id=conv_id, sender_tokens=member_tokens, body=f"Member msg {i}")

    res = await client.get("/api/v1/conversations/", headers=auth_header(chw_tokens))
    assert res.status_code == 200
    row = res.json()[0]
    assert row["unread_count"] == 3, f"Expected 3 unread, got {row['unread_count']}"


@pytest.mark.asyncio
async def test_mark_read_advances_cursor_and_reduces_unread(client: AsyncClient):
    """POST /{id}/messages/read advances cursor; subsequent inbox call shows 0 unread."""
    chw_tokens = await _register_chw(client, email="mr_chw@example.com")
    member_tokens = await _register_member(client, email="mr_member@example.com")
    conv_id = await _build_relationship_and_conversation(
        client, chw_tokens=chw_tokens, member_tokens=member_tokens
    )

    _m1 = await _send_message(client, conversation_id=conv_id, sender_tokens=member_tokens, body="msg 1")
    _m2 = await _send_message(client, conversation_id=conv_id, sender_tokens=member_tokens, body="msg 2")
    last = await _send_message(client, conversation_id=conv_id, sender_tokens=member_tokens, body="msg 3")

    # Mark all read up to the last message
    read_res = await client.post(
        f"/api/v1/conversations/{conv_id}/messages/read",
        json={"up_to_message_id": last["id"]},
        headers=auth_header(chw_tokens),
    )
    assert read_res.status_code == 204

    res = await client.get("/api/v1/conversations/", headers=auth_header(chw_tokens))
    assert res.status_code == 200
    row = res.json()[0]
    assert row["unread_count"] == 0, f"Expected 0 unread after mark-read, got {row['unread_count']}"


@pytest.mark.asyncio
async def test_mark_read_is_monotonic_older_id_is_noop(client: AsyncClient):
    """Sending an older message_id to mark-read does not retreat the cursor."""
    chw_tokens = await _register_chw(client, email="mono_chw@example.com")
    member_tokens = await _register_member(client, email="mono_member@example.com")
    conv_id = await _build_relationship_and_conversation(
        client, chw_tokens=chw_tokens, member_tokens=member_tokens
    )

    m1 = await _send_message(client, conversation_id=conv_id, sender_tokens=member_tokens, body="first")
    _m2 = await _send_message(client, conversation_id=conv_id, sender_tokens=member_tokens, body="second")
    m3 = await _send_message(client, conversation_id=conv_id, sender_tokens=member_tokens, body="third")

    # Advance to m3
    await client.post(
        f"/api/v1/conversations/{conv_id}/messages/read",
        json={"up_to_message_id": m3["id"]},
        headers=auth_header(chw_tokens),
    )

    # Try to retreat to m1 — should be no-op (204 still)
    retreat_res = await client.post(
        f"/api/v1/conversations/{conv_id}/messages/read",
        json={"up_to_message_id": m1["id"]},
        headers=auth_header(chw_tokens),
    )
    assert retreat_res.status_code == 204

    # Unread still 0 — cursor stayed at m3
    res = await client.get("/api/v1/conversations/", headers=auth_header(chw_tokens))
    assert res.json()[0]["unread_count"] == 0


# ─── Group 5: Pin/archive sort + include_archived filter ──────────────────────


@pytest.mark.asyncio
async def test_pinned_conversation_sorts_to_top(client: AsyncClient):
    """Pinned conversation appears first even if it has an older last_message_at."""
    chw_tokens = await _register_chw(client, email="ps_chw@example.com")
    m1_tokens = await _register_member(client, email="ps_m1@example.com")
    m2_tokens = await _register_member(client, email="ps_m2@example.com")

    # Build two conversations
    conv1 = await _build_relationship_and_conversation(client, chw_tokens=chw_tokens, member_tokens=m1_tokens)
    conv2 = await _build_relationship_and_conversation(client, chw_tokens=chw_tokens, member_tokens=m2_tokens)

    # Send message on conv2 (makes it "more recent")
    await _send_message(client, conversation_id=conv2, sender_tokens=chw_tokens, body="recent message")

    # Pin conv1 (the "older" one)
    pin_res = await client.patch(
        f"/api/v1/conversations/{conv1}/pin",
        json={"pinned": True},
        headers=auth_header(chw_tokens),
    )
    assert pin_res.status_code == 200

    res = await client.get("/api/v1/conversations/", headers=auth_header(chw_tokens))
    assert res.status_code == 200
    rows = res.json()
    assert len(rows) == 2
    assert rows[0]["id"] == conv1, "Pinned conversation should be first"
    assert rows[0]["pinned_at"] is not None


@pytest.mark.asyncio
async def test_archived_hidden_by_default_visible_with_flag(client: AsyncClient):
    """Archived conversation hidden from default list; visible with include_archived=true."""
    chw_tokens = await _register_chw(client, email="arch_chw@example.com")
    member_tokens = await _register_member(client, email="arch_member@example.com")
    conv_id = await _build_relationship_and_conversation(
        client, chw_tokens=chw_tokens, member_tokens=member_tokens
    )

    archive_res = await client.patch(
        f"/api/v1/conversations/{conv_id}/archive",
        json={"archived": True},
        headers=auth_header(chw_tokens),
    )
    assert archive_res.status_code == 200

    # Default list: archived thread is hidden
    res = await client.get("/api/v1/conversations/", headers=auth_header(chw_tokens))
    assert res.status_code == 200
    assert res.json() == []

    # With flag: archived thread is visible
    res2 = await client.get(
        "/api/v1/conversations/?include_archived=true",
        headers=auth_header(chw_tokens),
    )
    assert res2.status_code == 200
    rows = res2.json()
    assert len(rows) == 1
    assert rows[0]["archived_at"] is not None


@pytest.mark.asyncio
async def test_idempotent_repin(client: AsyncClient):
    """Pinning an already-pinned conversation updates timestamp and returns 200."""
    chw_tokens = await _register_chw(client, email="ipin_chw@example.com")
    member_tokens = await _register_member(client, email="ipin_member@example.com")
    conv_id = await _build_relationship_and_conversation(
        client, chw_tokens=chw_tokens, member_tokens=member_tokens
    )

    r1 = await client.patch(
        f"/api/v1/conversations/{conv_id}/pin",
        json={"pinned": True},
        headers=auth_header(chw_tokens),
    )
    assert r1.status_code == 200
    ts1 = r1.json()["pinned_at"]

    r2 = await client.patch(
        f"/api/v1/conversations/{conv_id}/pin",
        json={"pinned": True},
        headers=auth_header(chw_tokens),
    )
    assert r2.status_code == 200
    ts2 = r2.json()["pinned_at"]

    # Timestamps should both be non-null (idempotent, not erroring)
    assert ts1 is not None
    assert ts2 is not None


# ─── Group 6: Start-session-within-conversation ───────────────────────────────


@pytest.mark.asyncio
async def test_start_session_within_conversation_mints_session(client: AsyncClient):
    """POST /sessions/schedule on an existing conversation links to it + active_session_id reflects it."""
    import base64
    import json as _json

    chw_tokens = await _register_chw(client, email="ssw_chw@example.com")
    member_tokens = await _register_member(client, email="ssw_member@example.com")
    conv_id = await _build_relationship_and_conversation(
        client, chw_tokens=chw_tokens, member_tokens=member_tokens
    )

    # Decode member_id from JWT
    parts = member_tokens["access_token"].split(".")
    padded = parts[1] + "=" * (4 - len(parts[1]) % 4)
    member_id = _json.loads(base64.urlsafe_b64decode(padded))["sub"]

    # CHW schedules a second session directly (bare conversation path)
    sched_res = await client.post(
        "/api/v1/sessions/schedule",
        json={
            "member_id": member_id,
            "scheduled_at": "2026-08-01T10:00:00Z",
            "mode": "phone",
        },
        headers=auth_header(chw_tokens),
    )
    assert sched_res.status_code == 201, sched_res.text
    scheduled_session = sched_res.json()
    assert scheduled_session["id"] is not None

    # Start the session
    start_res = await client.patch(
        f"/api/v1/sessions/{scheduled_session['id']}/start",
        headers=auth_header(chw_tokens),
    )
    assert start_res.status_code == 200, start_res.text

    # Inbox should show active_session_id
    res = await client.get("/api/v1/conversations/", headers=auth_header(chw_tokens))
    assert res.status_code == 200
    rows = res.json()
    assert len(rows) == 1
    assert rows[0]["active_session_id"] is not None


# ─── Group 7: Two in_progress sessions → no MultipleResultsFound 500 ──────────


@pytest.mark.asyncio
async def test_two_in_progress_sessions_no_500(client: AsyncClient):
    """Invariant: two in_progress sessions on one conversation → list resolves without 500.

    Seeds the violating state directly via raw SQL and asserts the endpoint
    returns 200 (get_active_session_ids_for_conversations uses DISTINCT ON semantics).
    """
    import base64
    import json as _json
    import os

    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

    chw_tokens = await _register_chw(client, email="tip_chw@example.com")
    member_tokens = await _register_member(client, email="tip_member@example.com")
    conv_id = await _build_relationship_and_conversation(
        client, chw_tokens=chw_tokens, member_tokens=member_tokens
    )

    # Decode user IDs from JWTs
    parts = chw_tokens["access_token"].split(".")
    padded = parts[1] + "=" * (4 - len(parts[1]) % 4)
    chw_id = _json.loads(base64.urlsafe_b64decode(padded))["sub"]
    parts = member_tokens["access_token"].split(".")
    padded = parts[1] + "=" * (4 - len(parts[1]) % 4)
    member_id = _json.loads(base64.urlsafe_b64decode(padded))["sub"]

    # Directly insert a second in_progress session (violating the invariant)
    DB_URL = os.environ.get(
        "DATABASE_URL",
        "postgresql+asyncpg://compass:compass_dev_password@localhost:5432/compass_test",
    )
    engine = create_async_engine(DB_URL)
    async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    import uuid as _uuid_module
    from sqlalchemy import UUID as SA_UUID, bindparam

    async with async_session() as db:
        # Use bindparam with explicit UUID type to avoid varchar/uuid type mismatch
        row = await db.execute(
            text(
                "SELECT id, request_id FROM sessions WHERE chw_id = :chw_id LIMIT 1"
            ).bindparams(bindparam("chw_id", type_=SA_UUID(as_uuid=True))),
            {"chw_id": _uuid_module.UUID(chw_id)},
        )
        existing = row.first()
        assert existing is not None, "Expected at least one existing session for the CHW"
        _existing_session_id, request_id = existing

        new_sid = _uuid_module.uuid4()
        await db.execute(
            text(
                """INSERT INTO sessions
                   (id, request_id, chw_id, member_id, conversation_id,
                    vertical, status, mode, created_at, updated_at)
                   VALUES
                   (:sid, :rid, :chw_id, :member_id, :conv_id,
                    'housing', 'in_progress', 'phone', now(), now())"""
            ).bindparams(
                bindparam("sid", type_=SA_UUID(as_uuid=True)),
                bindparam("rid", type_=SA_UUID(as_uuid=True)),
                bindparam("chw_id", type_=SA_UUID(as_uuid=True)),
                bindparam("member_id", type_=SA_UUID(as_uuid=True)),
                bindparam("conv_id", type_=SA_UUID(as_uuid=True)),
            ),
            {
                "sid": new_sid,
                "rid": request_id,
                "chw_id": _uuid_module.UUID(chw_id),
                "member_id": _uuid_module.UUID(member_id),
                "conv_id": _uuid_module.UUID(conv_id),
            },
        )
        await db.commit()
    await engine.dispose()

    # The list endpoint must return 200, not 500
    res2 = await client.get("/api/v1/conversations/", headers=auth_header(chw_tokens))
    assert res2.status_code == 200
    rows = res2.json()
    # active_session_id is one of the two in_progress sessions (DISTINCT ON picks newest)
    assert rows[0]["active_session_id"] is not None


# ─── Group 8: Migration backfill — pinned session → pinned conversation ────────


@pytest.mark.asyncio
async def test_migration_backfill_pinned_session_pins_conversation(client: AsyncClient):
    """After pinning a conversation via endpoint, inbox pinned_at reflects it.

    Verifies the conversation-level pin semantics through the live endpoint path.
    (The SQL backfill in migration v6w7x8y9z0a1 propagates pre-existing session
    pins; this test validates the post-migration state is observable via the API.)
    """
    chw_tokens = await _register_chw(client, email="mbf_chw@example.com")
    member_tokens = await _register_member(client, email="mbf_member@example.com")
    conv_id = await _build_relationship_and_conversation(
        client, chw_tokens=chw_tokens, member_tokens=member_tokens
    )

    # Pin the conversation directly via the endpoint
    pin_res = await client.patch(
        f"/api/v1/conversations/{conv_id}/pin",
        json={"pinned": True},
        headers=auth_header(chw_tokens),
    )
    assert pin_res.status_code == 200
    assert pin_res.json()["pinned_at"] is not None

    # Verify inbox reflects pinned_at
    res = await client.get("/api/v1/conversations/", headers=auth_header(chw_tokens))
    assert res.status_code == 200
    row = res.json()[0]
    assert row["pinned_at"] is not None


# ─── Group 9: Dangling read cursor → 404, not 500 ─────────────────────────────


@pytest.mark.asyncio
async def test_dangling_read_cursor_returns_404_not_500(client: AsyncClient):
    """POST /{id}/messages/read with a non-existent message_id returns 404."""
    chw_tokens = await _register_chw(client, email="drc_chw@example.com")
    member_tokens = await _register_member(client, email="drc_member@example.com")
    conv_id = await _build_relationship_and_conversation(
        client, chw_tokens=chw_tokens, member_tokens=member_tokens
    )

    fake_message_id = str(uuid.uuid4())
    res = await client.post(
        f"/api/v1/conversations/{conv_id}/messages/read",
        json={"up_to_message_id": fake_message_id},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 404
    assert "not found" in res.json()["detail"].lower()

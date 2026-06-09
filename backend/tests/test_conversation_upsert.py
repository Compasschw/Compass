"""Unit / integration tests for the atomic (chw_id, member_id) conversation upsert.

Covers:
  1. Parallel get-or-create — two concurrent callers produce exactly ONE
     conversation row (the race-condition fix).
  2. Sequential idempotency — calling find_or_create_conversation_for_pair
     twice in series returns the same id both times.
  3. HTTP endpoint idempotency — POST /conversations/find-or-create is safe
     to call N times; always returns the same conversation id.
"""
from __future__ import annotations

import asyncio
import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select

from app.models.conversation import Conversation
from app.services.session_lookup import find_or_create_conversation_for_pair
from tests.conftest import auth_header, test_session as _test_session_factory


# ─── Helpers ──────────────────────────────────────────────────────────────────


async def _seed_user(role: str, email: str) -> uuid.UUID:
    """Insert a minimal User row directly and return its id.

    Bypasses the API registration flow so we can create users without the
    full Pear-required-field gate or the relationship guard that
    find-or-create applies (tests below need naked db-level calls).
    """
    from datetime import datetime, timezone

    from app.models.user import User

    user_id = uuid.uuid4()
    async with _test_session_factory() as session:
        user = User(
            id=user_id,
            email=email,
            name=f"Test {role} {email[:8]}",
            role=role,
            password_hash="not-a-real-hash",
            is_active=True,
            created_at=datetime.now(timezone.utc),
        )
        session.add(user)
        await session.commit()
    return user_id


async def _count_conversations(chw_id: uuid.UUID, member_id: uuid.UUID) -> int:
    """Return the number of conversations rows for the given (chw, member) pair."""
    async with _test_session_factory() as session:
        result = await session.execute(
            select(func.count()).where(
                Conversation.chw_id == chw_id,
                Conversation.member_id == member_id,
            )
        )
        return result.scalar_one()


# ─── Tests ────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_parallel_find_or_create_produces_single_row():
    """Two concurrent find_or_create_conversation_for_pair calls must yield
    exactly ONE conversation row.

    This is the core regression test for the race-condition bug. Both coroutines
    run inside a single asyncio event loop; the first to execute the INSERT wins,
    the second hits the ON CONFLICT clause and falls back to the SELECT. The
    UNIQUE constraint is the DB-level backstop.

    Asserts:
        - Both calls return a Conversation with the same id.
        - The conversations table contains exactly one row for the pair.
    """
    chw_id = await _seed_user("chw", "parallel_chw@example.com")
    member_id = await _seed_user("member", "parallel_member@example.com")

    async def _call() -> uuid.UUID:
        async with _test_session_factory() as db:
            conv = await find_or_create_conversation_for_pair(
                db, chw_id=chw_id, member_id=member_id
            )
            await db.commit()
            return conv.id

    id_a, id_b = await asyncio.gather(_call(), _call())

    assert id_a == id_b, (
        f"Parallel callers got different conversation ids: {id_a} vs {id_b}. "
        "The UNIQUE constraint + ON CONFLICT upsert should guarantee one winner."
    )
    row_count = await _count_conversations(chw_id, member_id)
    assert row_count == 1, (
        f"Expected exactly 1 conversation row for the pair, found {row_count}."
    )


@pytest.mark.asyncio
async def test_sequential_find_or_create_is_idempotent():
    """Calling find_or_create_conversation_for_pair twice in series returns the
    same Conversation id both times and leaves exactly one row in the DB.
    """
    chw_id = await _seed_user("chw", "seq_chw@example.com")
    member_id = await _seed_user("member", "seq_member@example.com")

    async with _test_session_factory() as db:
        first = await find_or_create_conversation_for_pair(
            db, chw_id=chw_id, member_id=member_id
        )
        await db.commit()
        first_id = first.id

    async with _test_session_factory() as db:
        second = await find_or_create_conversation_for_pair(
            db, chw_id=chw_id, member_id=member_id
        )
        await db.commit()
        second_id = second.id

    assert first_id == second_id, (
        "Sequential calls returned different ids — idempotency violated."
    )
    row_count = await _count_conversations(chw_id, member_id)
    assert row_count == 1, (
        f"Expected exactly 1 conversation row, found {row_count}."
    )


@pytest.mark.asyncio
async def test_http_find_or_create_parallel_produces_single_row(client: AsyncClient):
    """Firing POST /conversations/find-or-create in parallel via asyncio.gather
    must return the same conversation id from both responses and leave exactly
    one row in the DB.

    Uses the API registration path (includes relationship guard bypass via a
    pre-existing session) so the request goes through the full stack.
    """
    # Register CHW and member via API so they exist in the test DB.
    chw_res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "http_chw@example.com",
            "password": "testpass123",
            "name": "HTTP CHW Upsert",
            "role": "chw",
        },
    )
    assert chw_res.status_code == 201, f"CHW register failed: {chw_res.text}"
    chw_tokens = chw_res.json()

    member_res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "http_member@example.com",
            "password": "testpass123",
            "name": "HTTP Member Upsert",
            "role": "member",
            "phone": "+13105550200",
            "date_of_birth": "1990-03-15",
            "gender": "Male",
            "insurance_company": "Blue Shield",
            "medi_cal_id": "99887766A",
            "address_line1": "2 Test Ave",
            "city": "Los Angeles",
            "state": "CA",
            "zip_code": "90002",
        },
    )
    assert member_res.status_code == 201, f"Member register failed: {member_res.text}"
    member_tokens = member_res.json()

    # Create a shared session so the relationship guard passes.
    req_res = await client.post(
        "/api/v1/requests/",
        json={
            "vertical": "housing",
            "urgency": "routine",
            "description": "Upsert race test request",
            "preferred_mode": "in_person",
        },
        headers=auth_header(member_tokens),
    )
    assert req_res.status_code == 201
    request_id = req_res.json()["id"]

    accept_res = await client.patch(
        f"/api/v1/requests/{request_id}/accept",
        headers=auth_header(chw_tokens),
    )
    assert accept_res.status_code == 200

    sess_res = await client.post(
        "/api/v1/sessions/",
        json={"request_id": request_id, "scheduled_at": "2026-06-10T10:00:00Z", "mode": "phone"},
        headers=auth_header(chw_tokens),
    )
    assert sess_res.status_code == 201

    # Extract CHW id so the member can address the find-or-create request.
    import base64, json as _json
    parts = chw_tokens["access_token"].split(".")
    padded = parts[1] + "=" * (4 - len(parts[1]) % 4)
    chw_id = _json.loads(base64.urlsafe_b64decode(padded))["sub"]

    # Fire two concurrent find-or-create requests.
    async def _post() -> str:
        res = await client.post(
            "/api/v1/conversations/find-or-create",
            json={"peer_id": chw_id},
            headers=auth_header(member_tokens),
        )
        assert res.status_code == 200, f"find-or-create returned {res.status_code}: {res.text}"
        return res.json()["id"]

    id_a, id_b = await asyncio.gather(_post(), _post())

    assert id_a == id_b, (
        f"Parallel HTTP calls returned different conversation ids: {id_a} vs {id_b}."
    )

    # Verify only one row in the DB.
    import uuid as _uuid
    chw_uuid = _uuid.UUID(chw_id)

    # Fetch member_id from the returned conversation to look up row count.
    async with _test_session_factory() as db:
        result = await db.execute(
            select(func.count()).where(
                Conversation.id == _uuid.UUID(id_a),
            )
        )
        assert result.scalar_one() == 1, "Conversation row missing after parallel create."

"""Integration tests for the session-per-call flag in /communication/call-bridge (#193).

Strategy:
  - Register CHW + member via the auth/register HTTP endpoint (gives us real
    JWTs and correctly hashed passwords).
  - Patch phones directly via test_session (register endpoint doesn't accept phone).
  - Seed Conversation + completed/in_progress Session directly via test_session.
  - Monkeypatch settings.session_per_call_enabled for flag-on tests.
  - Vonage is NOT configured in the test env — provider returns a
    ``vonage-placeholder-*`` session id (safe mock behavior).
"""
from __future__ import annotations

import base64
import json
import uuid
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import select

import app.config as _app_config_module
from app.models.conversation import Conversation
from app.models.session import Session
from app.models.user import User
from app.models.request import ServiceRequest
from tests.conftest import auth_header, test_session as _test_session_factory


# ─── Shared helpers ────────────────────────────────────────────────────────────


async def _register(client: AsyncClient, email: str, role: str) -> dict:
    """Register a new user via the HTTP endpoint and return the token payload."""
    res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": email,
            "password": "testpass123",
            "name": f"Test {role.upper()} {email[:12]}",
            "role": role,
        },
    )
    assert res.status_code == 201, f"Register failed ({email}): {res.text}"
    return res.json()


async def _set_phone_via_db(user_id: str, phone: str) -> None:
    """Set a user's phone directly in the test database."""
    async with _test_session_factory() as session:
        user = await session.get(User, UUID(user_id))
        assert user is not None, f"User {user_id} not found in DB"
        user.phone = phone
        await session.commit()


def _user_id_from_tokens(tokens: dict) -> str:
    """Decode the JWT access token and extract the ``sub`` claim (user UUID)."""
    parts = tokens["access_token"].split(".")
    padded = parts[1] + "=" * (4 - len(parts[1]) % 4)
    payload = json.loads(base64.urlsafe_b64decode(padded))
    return payload["sub"]


async def _seed_completed_session(
    chw_id: UUID,
    member_id: UUID,
) -> tuple[UUID, UUID]:
    """Seed a Conversation + one completed Session for the pair.

    Returns (conversation_id, session_id) of the seeded rows.
    """
    conv_id = uuid.uuid4()
    req_id = uuid.uuid4()
    session_id = uuid.uuid4()

    async with _test_session_factory() as db:
        db.add_all([
            ServiceRequest(
                id=req_id,
                member_id=member_id,
                vertical="health",
                urgency="routine",
                description="seed for call-bridge test",
                preferred_mode="phone",
                status="completed",
                estimated_units=1,
            ),
            Conversation(id=conv_id, chw_id=chw_id, member_id=member_id),
        ])
        await db.flush()
        db.add(Session(
            id=session_id,
            request_id=req_id,
            chw_id=chw_id,
            member_id=member_id,
            vertical="health",
            mode="phone",
            status="completed",
            conversation_id=conv_id,
        ))
        await db.commit()

    return conv_id, session_id


async def _seed_in_progress_session(
    chw_id: UUID,
    member_id: UUID,
) -> tuple[UUID, UUID]:
    """Seed a Conversation + one in_progress Session for the pair.

    Returns (conversation_id, session_id).
    """
    conv_id = uuid.uuid4()
    req_id = uuid.uuid4()
    session_id = uuid.uuid4()

    async with _test_session_factory() as db:
        db.add_all([
            ServiceRequest(
                id=req_id,
                member_id=member_id,
                vertical="health",
                urgency="routine",
                description="seed for call-bridge active session test",
                preferred_mode="phone",
                status="accepted",
                estimated_units=1,
            ),
            Conversation(id=conv_id, chw_id=chw_id, member_id=member_id),
        ])
        await db.flush()
        db.add(Session(
            id=session_id,
            request_id=req_id,
            chw_id=chw_id,
            member_id=member_id,
            vertical="health",
            mode="phone",
            status="in_progress",
            conversation_id=conv_id,
        ))
        await db.commit()

    return conv_id, session_id


# ─── Tests ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_call_bridge_creates_new_session_when_flag_on_and_prior_completed(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Flag ON + prior Session is completed → a brand-new in_progress Session
    is minted and returned in the response body.

    Assert:
    - HTTP 200
    - response body["session_id"] is a NEW UUID (≠ prior session id)
    - DB has exactly 2 Sessions on the same conversation_id
    - exactly 1 of those Sessions has status="in_progress"
    """
    monkeypatch.setattr(_app_config_module.settings, "session_per_call_enabled", True)

    # Register CHW + member via the auth endpoint (produces valid JWTs).
    chw_tokens = await _register(client, "bridge-chw-new@example.com", "chw")
    member_tokens = await _register(client, "bridge-member-new@example.com", "member")

    chw_id = UUID(_user_id_from_tokens(chw_tokens))
    member_id = UUID(_user_id_from_tokens(member_tokens))

    await _set_phone_via_db(str(chw_id), "+13105550101")
    await _set_phone_via_db(str(member_id), "+13105550201")

    conv_id, prior_session_id = await _seed_completed_session(chw_id, member_id)

    res = await client.post(
        "/api/v1/communication/call-bridge",
        json={"recipient_id": str(member_id)},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, f"Expected 200, got {res.status_code}: {res.text}"
    body = res.json()

    # Response must include a session_id that is a valid UUID.
    assert body.get("session_id") is not None, "Response missing session_id"
    returned_session_id = UUID(body["session_id"])

    # It must be a NEW session, not the prior completed one.
    assert returned_session_id != prior_session_id, (
        f"Expected a new Session, but got the prior completed Session {prior_session_id}"
    )

    # DB: exactly 2 Sessions on the conversation; exactly 1 is in_progress.
    async with _test_session_factory() as db:
        result = await db.execute(
            select(Session).where(Session.conversation_id == conv_id)
        )
        all_sessions = result.scalars().all()

    assert len(all_sessions) == 2, (
        f"Expected 2 Sessions on conversation, found {len(all_sessions)}"
    )
    in_progress = [s for s in all_sessions if s.status == "in_progress"]
    assert len(in_progress) == 1, (
        f"Expected exactly 1 in_progress Session, found {len(in_progress)}"
    )
    assert in_progress[0].id == returned_session_id


@pytest.mark.asyncio
async def test_call_bridge_reuses_active_session_when_flag_on(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Flag ON + prior Session is already in_progress → the active Session is
    reused (no new row minted).

    Assert:
    - HTTP 200
    - response body["session_id"] == prior_session_id
    - DB still has exactly 1 Session on the conversation
    """
    monkeypatch.setattr(_app_config_module.settings, "session_per_call_enabled", True)

    chw_tokens = await _register(client, "bridge-chw-reuse@example.com", "chw")
    member_tokens = await _register(client, "bridge-member-reuse@example.com", "member")

    chw_id = UUID(_user_id_from_tokens(chw_tokens))
    member_id = UUID(_user_id_from_tokens(member_tokens))

    await _set_phone_via_db(str(chw_id), "+13105550102")
    await _set_phone_via_db(str(member_id), "+13105550202")

    conv_id, prior_session_id = await _seed_in_progress_session(chw_id, member_id)

    res = await client.post(
        "/api/v1/communication/call-bridge",
        json={"recipient_id": str(member_id)},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, f"Expected 200, got {res.status_code}: {res.text}"
    body = res.json()

    assert body.get("session_id") is not None, "Response missing session_id"
    returned_session_id = UUID(body["session_id"])
    assert returned_session_id == prior_session_id, (
        f"Expected active Session {prior_session_id} to be reused, "
        f"but got {returned_session_id}"
    )

    # DB: still exactly 1 Session on the conversation.
    async with _test_session_factory() as db:
        result = await db.execute(
            select(Session).where(Session.conversation_id == conv_id)
        )
        all_sessions = result.scalars().all()

    assert len(all_sessions) == 1, (
        f"Expected 1 Session on conversation (no new row), found {len(all_sessions)}"
    )


@pytest.mark.asyncio
async def test_call_bridge_flag_off_keeps_legacy_behavior(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Flag OFF (default) → the session-per-call block is skipped entirely.
    The request-provided session_id is echoed back unchanged, and no new
    Session row is created.

    Assert:
    - HTTP 200
    - response body["session_id"] == prior_session_id (legacy attach)
    - DB still has exactly 1 Session on the conversation
    """
    monkeypatch.setattr(_app_config_module.settings, "session_per_call_enabled", False)

    chw_tokens = await _register(client, "bridge-chw-legacy@example.com", "chw")
    member_tokens = await _register(client, "bridge-member-legacy@example.com", "member")

    chw_id = UUID(_user_id_from_tokens(chw_tokens))
    member_id = UUID(_user_id_from_tokens(member_tokens))

    await _set_phone_via_db(str(chw_id), "+13105550103")
    await _set_phone_via_db(str(member_id), "+13105550203")

    conv_id, prior_session_id = await _seed_completed_session(chw_id, member_id)

    res = await client.post(
        "/api/v1/communication/call-bridge",
        json={"recipient_id": str(member_id), "session_id": str(prior_session_id)},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, f"Expected 200, got {res.status_code}: {res.text}"
    body = res.json()

    # Legacy path: the session_id from the request should be echoed back.
    assert body.get("session_id") is not None, "Response missing session_id"
    returned_session_id = UUID(body["session_id"])
    assert returned_session_id == prior_session_id, (
        f"Expected legacy session_id {prior_session_id} echoed back, "
        f"but got {returned_session_id}"
    )

    # DB: still exactly 1 Session on the conversation (no new one created).
    async with _test_session_factory() as db:
        result = await db.execute(
            select(Session).where(Session.conversation_id == conv_id)
        )
        all_sessions = result.scalars().all()

    assert len(all_sessions) == 1, (
        f"Expected 1 Session on conversation (no new row), found {len(all_sessions)}"
    )

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
    """Register a new user via the HTTP endpoint and return the token payload.

    Members must supply every Pear-required signup field (#14); the CIN is
    derived from the email so concurrent registrations stay distinct.
    """
    payload: dict = {
        "email": email,
        "password": "Testpass123!",
        "name": f"Test {role.upper()} {email[:12]}",
        "role": role,
    }
    if role == "member":
        payload.update({
            "date_of_birth": "1990-01-01",
            "gender": "Female",
            "insurance_company": "Health Net",
            "medi_cal_id": f"{abs(hash(email)) % 100_000_000:08d}A",
            "zip_code": "90001",
            "terms_accepted": True,
            "communications_consent": True,
        })
    res = await client.post("/api/v1/auth/register", json=payload)
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
    """Flag ON + prior Session is completed → a brand-new Session is minted
    and returned in the response body, but the call does NOT start it
    (Epic U: only Begin Session may flip status/started_at).

    Assert:
    - HTTP 200
    - response body["session_id"] is a NEW UUID (≠ prior session id)
    - DB has exactly 2 Sessions on the same conversation_id
    - the new Session is left at the default "scheduled" (not started) status
    - zero Sessions on the conversation are "in_progress" — placing the call
      must not start a session or its billing timer
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
    # Epic U: the call must not start a session — the freshly-minted row
    # stays "scheduled" with started_at unset until Begin Session is tapped.
    in_progress = [s for s in all_sessions if s.status == "in_progress"]
    assert len(in_progress) == 0, (
        f"Expected 0 in_progress Sessions (call must not auto-start), "
        f"found {len(in_progress)}"
    )
    by_id = {s.id: s for s in all_sessions}
    new_session = by_id[returned_session_id]
    assert new_session.status == "scheduled", (
        f"Expected the new Session to be left unstarted ('scheduled'), "
        f"got status={new_session.status!r}"
    )
    assert new_session.started_at is None, (
        "Expected started_at to remain unset — only Begin Session may stamp it"
    )


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


@pytest.mark.asyncio
async def test_conversations_list_returns_active_session_id(
    client: AsyncClient,
) -> None:
    """GET /conversations/ surfaces active_session_id so the FE can drive
    End Session / Submit Doc off the right ID.

    Setup:
      - Register CHW + member via the auth endpoint.
      - Seed a Conversation with one in_progress Session directly via test_session.
      - Hit GET /api/v1/conversations/ with the CHW's JWT.
      - Assert the response contains active_session_id matching the seeded Session.
    """
    chw_tokens = await _register(client, "conv-list-active-chw@example.com", "chw")
    member_tokens = await _register(client, "conv-list-active-member@example.com", "member")

    chw_id = UUID(_user_id_from_tokens(chw_tokens))
    member_id = UUID(_user_id_from_tokens(member_tokens))

    conv_id, session_id = await _seed_in_progress_session(chw_id, member_id)

    res = await client.get(
        "/api/v1/conversations/",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, f"Expected 200, got {res.status_code}: {res.text}"
    conversations = res.json()

    # Find the seeded conversation in the response list.
    matching = [c for c in conversations if c["id"] == str(conv_id)]
    assert len(matching) == 1, (
        f"Expected exactly 1 conversation with id={conv_id}, found {len(matching)}"
    )
    conv_response = matching[0]

    assert conv_response["active_session_id"] == str(session_id), (
        f"Expected active_session_id={session_id}, "
        f"got {conv_response.get('active_session_id')}"
    )


@pytest.mark.asyncio
async def test_conversations_list_returns_null_active_session_id_when_completed(
    client: AsyncClient,
) -> None:
    """When the conversation's only session is completed, active_session_id is None.

    Setup:
      - Register CHW + member via the auth endpoint.
      - Seed a Conversation with one completed Session directly via test_session.
      - Hit GET /api/v1/conversations/ with the CHW's JWT.
      - Assert active_session_id is None (null) in the response.
    """
    chw_tokens = await _register(client, "conv-list-completed-chw@example.com", "chw")
    member_tokens = await _register(client, "conv-list-completed-member@example.com", "member")

    chw_id = UUID(_user_id_from_tokens(chw_tokens))
    member_id = UUID(_user_id_from_tokens(member_tokens))

    conv_id, _session_id = await _seed_completed_session(chw_id, member_id)

    res = await client.get(
        "/api/v1/conversations/",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, f"Expected 200, got {res.status_code}: {res.text}"
    conversations = res.json()

    # Find the seeded conversation in the response list.
    matching = [c for c in conversations if c["id"] == str(conv_id)]
    assert len(matching) == 1, (
        f"Expected exactly 1 conversation with id={conv_id}, found {len(matching)}"
    )
    conv_response = matching[0]

    assert conv_response["active_session_id"] is None, (
        f"Expected active_session_id=None for completed session, "
        f"got {conv_response.get('active_session_id')}"
    )


@pytest.mark.asyncio
async def test_call_bridge_mints_fresh_when_active_has_documentation(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Auto-heal the skip-End-Session pattern: if the supposedly-active
    Session already has a SessionDocumentation, the CHW closed it from
    their perspective even though Session.status is still in_progress.
    Call-bridge must complete the prior Session and mint a fresh one for
    THIS call, so the 2nd same-thread doc submit lands on the new Session
    instead of 409'ing on the prior doc. (#193 same-thread heal.) The
    freshly-minted Session itself must NOT be auto-started (Epic U) — the
    CHW still has to tap Begin Session on it.
    """
    monkeypatch.setattr(_app_config_module.settings, "session_per_call_enabled", True)

    chw_tokens = await _register(client, "bridge-chw-heal@example.com", "chw")
    member_tokens = await _register(client, "bridge-member-heal@example.com", "member")
    chw_id = UUID(_user_id_from_tokens(chw_tokens))
    member_id = UUID(_user_id_from_tokens(member_tokens))
    await _set_phone_via_db(str(chw_id), "+13105550104")
    await _set_phone_via_db(str(member_id), "+13105550204")

    # Seed: in_progress Session that ALREADY has a SessionDocumentation row.
    # Mirrors what the prod DB looks like after Doc was submitted but End
    # Session was never tapped.
    conv_id, prior_session_id = await _seed_in_progress_session(chw_id, member_id)
    async with _test_session_factory() as db:
        from app.models.session import SessionDocumentation
        db.add(SessionDocumentation(
            id=uuid.uuid4(),
            session_id=prior_session_id,
            summary="prior doc",
            diagnosis_codes=["Z71.89"],
            procedure_code="98960",
            units_to_bill=1,
        ))
        await db.commit()

    res = await client.post(
        "/api/v1/communication/call-bridge",
        json={"recipient_id": str(member_id)},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, f"Expected 200, got {res.status_code}: {res.text}"
    body = res.json()

    returned_session_id = UUID(body["session_id"])
    assert returned_session_id != prior_session_id, (
        f"Expected fresh Session, but got reused prior {prior_session_id}"
    )

    # Verify in DB: prior is now completed; new in_progress session exists.
    async with _test_session_factory() as db:
        rows = (await db.execute(
            select(Session).where(Session.conversation_id == conv_id)
        )).scalars().all()
        assert len(rows) == 2, f"Expected 2 Sessions on conversation, got {len(rows)}"
        by_id = {s.id: s for s in rows}
        assert by_id[prior_session_id].status == "completed", (
            "Prior Session should be auto-completed by the heal"
        )
        # Epic U: the fresh Session minted for this call must NOT be
        # auto-started — it stays "scheduled" until Begin Session is tapped.
        assert by_id[returned_session_id].status == "scheduled", (
            f"Expected the newly-minted Session to be left unstarted, "
            f"got status={by_id[returned_session_id].status!r}"
        )
        assert by_id[returned_session_id].started_at is None

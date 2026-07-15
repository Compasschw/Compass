"""Regression tests for Epic U — call initiation must NOT start a session.

``PATCH /sessions/{id}/start`` (Begin Session) is the single, universal
trigger that sets ``Session.status='in_progress'`` and stamps
``started_at`` — that's what drives the CHW's session timer / badge.
``POST /sessions/{id}/call`` (``initiate_session_call``) places a masked
Vonage call and, when ``session_per_call_enabled`` is on, may resolve or
mint a per-call Session via
``app.services.session_lookup.resolve_target_session_for_call``. Before this
fix, the per-call-mint path (``create_followup_session``) also stamped the
new row ``status='in_progress'`` / ``started_at=now()`` — i.e. simply
placing a call could silently start a session and its billing timer without
the CHW ever tapping Begin Session. These tests fail on the pre-fix code
(which stamped the new/target session as started) and pass after.

Strategy mirrors ``test_call_bridge_session_per_call.py``: register real
users via the HTTP auth endpoint (valid JWTs + hashed passwords), set phones
directly via the DB, seed Conversation/Session rows directly, then hit
``POST /api/v1/sessions/{id}/call``. Vonage is unconfigured in the test env,
so ``get_provider()`` returns the safe ``vonage-placeholder-*`` mock.
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
from app.models.communication import CommunicationSession
from app.models.conversation import Conversation
from app.models.session import Session
from app.models.user import User
from app.models.request import ServiceRequest
from app.utils.phone import PLACEHOLDER_PHONE_CALL_BLOCK_MESSAGE, PLACEHOLDER_PHONE_E164
from tests.conftest import auth_header, test_session as _test_session_factory


# ─── Shared helpers (mirrors test_call_bridge_session_per_call.py) ───────────


async def _register(client: AsyncClient, email: str, role: str) -> dict:
    """Register a new user via the HTTP endpoint and return the token payload."""
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
    async with _test_session_factory() as session:
        user = await session.get(User, UUID(user_id))
        assert user is not None, f"User {user_id} not found in DB"
        user.phone = phone
        await session.commit()


def _user_id_from_tokens(tokens: dict) -> str:
    parts = tokens["access_token"].split(".")
    padded = parts[1] + "=" * (4 - len(parts[1]) % 4)
    payload = json.loads(base64.urlsafe_b64decode(padded))
    return payload["sub"]


async def _seed_scheduled_session(chw_id: UUID, member_id: UUID) -> UUID:
    """Seed a single, never-started Session (no Conversation back-link).

    Mirrors a session created via ServiceRequest→accept but never Begun.
    """
    req_id = uuid.uuid4()
    session_id = uuid.uuid4()
    async with _test_session_factory() as db:
        db.add(ServiceRequest(
            id=req_id,
            member_id=member_id,
            vertical="health",
            urgency="routine",
            description="seed for call-no-autostart test",
            preferred_mode="phone",
            status="accepted",
            estimated_units=1,
        ))
        await db.flush()
        db.add(Session(
            id=session_id,
            request_id=req_id,
            chw_id=chw_id,
            member_id=member_id,
            vertical="health",
            mode="phone",
            status="scheduled",
        ))
        await db.commit()
    return session_id


async def _seed_completed_session_with_conversation(
    chw_id: UUID, member_id: UUID
) -> tuple[UUID, UUID]:
    """Seed a Conversation + one completed Session for the pair.

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
                description="seed for call-no-autostart test",
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


# ─── Tests ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_call_on_scheduled_session_leaves_it_unstarted(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """POST /sessions/{id}/call on a never-started ('scheduled') session must
    NOT flip it to in_progress or stamp started_at — only Begin Session may.

    session_per_call_enabled is OFF (default) here, which is the path the FE
    currently exercises for a same-thread first call.
    """
    monkeypatch.setattr(_app_config_module.settings, "session_per_call_enabled", False)

    chw_tokens = await _register(client, "call-noautostart-chw1@example.com", "chw")
    member_tokens = await _register(client, "call-noautostart-member1@example.com", "member")
    chw_id = UUID(_user_id_from_tokens(chw_tokens))
    member_id = UUID(_user_id_from_tokens(member_tokens))
    await _set_phone_via_db(str(chw_id), "+13105550301")
    await _set_phone_via_db(str(member_id), "+13105550401")

    session_id = await _seed_scheduled_session(chw_id, member_id)

    res = await client.post(
        f"/api/v1/sessions/{session_id}/call",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, f"Expected 200, got {res.status_code}: {res.text}"

    async with _test_session_factory() as db:
        session = await db.get(Session, session_id)
        assert session is not None
        assert session.status == "scheduled", (
            f"Expected the session to remain 'scheduled' after /call, "
            f"got status={session.status!r}"
        )
        assert session.started_at is None, (
            "Expected started_at to remain unset after /call — only Begin "
            "Session may stamp it"
        )


@pytest.mark.asyncio
async def test_call_with_session_per_call_mints_session_without_starting_it(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Flag ON + prior Session is completed → /sessions/{id}/call mints a
    fresh per-call Session (via resolve_target_session_for_call), but that
    new Session must NOT be auto-started.

    Fails on the pre-fix code, which stamped the freshly-minted Session
    status='in_progress' / started_at=now() as a side effect of placing
    the call.
    """
    monkeypatch.setattr(_app_config_module.settings, "session_per_call_enabled", True)

    chw_tokens = await _register(client, "call-noautostart-chw2@example.com", "chw")
    member_tokens = await _register(client, "call-noautostart-member2@example.com", "member")
    chw_id = UUID(_user_id_from_tokens(chw_tokens))
    member_id = UUID(_user_id_from_tokens(member_tokens))
    await _set_phone_via_db(str(chw_id), "+13105550302")
    await _set_phone_via_db(str(member_id), "+13105550402")

    conv_id, prior_session_id = await _seed_completed_session_with_conversation(
        chw_id, member_id
    )

    res = await client.post(
        f"/api/v1/sessions/{prior_session_id}/call",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, f"Expected 200, got {res.status_code}: {res.text}"
    body = res.json()

    returned_session_id = UUID(body["session_id"])
    assert returned_session_id != prior_session_id, (
        "Expected a freshly-minted Session distinct from the completed prior one"
    )

    async with _test_session_factory() as db:
        rows = (
            await db.execute(select(Session).where(Session.conversation_id == conv_id))
        ).scalars().all()
        assert len(rows) == 2, f"Expected 2 Sessions on conversation, got {len(rows)}"

        in_progress = [s for s in rows if s.status == "in_progress"]
        assert len(in_progress) == 0, (
            f"Expected 0 in_progress Sessions (call must not auto-start), "
            f"found {len(in_progress)}"
        )

        by_id = {s.id: s for s in rows}
        new_session = by_id[returned_session_id]
        assert new_session.status == "scheduled", (
            f"Expected the new Session to be left unstarted, "
            f"got status={new_session.status!r}"
        )
        assert new_session.started_at is None


# ─── QA feedback batch (2026-07-14), Part 3 — placeholder-phone call block ──
#
# POST /sessions/{id}/call is the endpoint the mobile app actually calls
# (both the CHW Messages call flow and the member Messages call flow route
# through it) — see initiate_session_call's docstring. These tests cover
# both directions (CHW-initiates, member-initiates) when the MEMBER's phone
# is the 555-555-5555 placeholder sentinel.


@pytest.mark.asyncio
async def test_chw_initiated_call_blocked_when_member_has_placeholder_phone(
    client: AsyncClient,
) -> None:
    """CHW taps call on a session where the member's phone is the sentinel
    -> clean 422 with the documented message, no Vonage attempt (no
    CommunicationSession row is written)."""
    chw_tokens = await _register(client, "call-block-chw1@example.com", "chw")
    member_tokens = await _register(client, "call-block-member1@example.com", "member")
    chw_id = UUID(_user_id_from_tokens(chw_tokens))
    member_id = UUID(_user_id_from_tokens(member_tokens))
    await _set_phone_via_db(str(chw_id), "+13105550501")
    await _set_phone_via_db(str(member_id), PLACEHOLDER_PHONE_E164)

    session_id = await _seed_scheduled_session(chw_id, member_id)

    res = await client.post(
        f"/api/v1/sessions/{session_id}/call",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 422, f"Expected 422, got {res.status_code}: {res.text}"
    assert res.json()["detail"] == PLACEHOLDER_PHONE_CALL_BLOCK_MESSAGE

    async with _test_session_factory() as db:
        rows = (
            await db.execute(
                select(CommunicationSession).where(CommunicationSession.session_id == session_id)
            )
        ).scalars().all()
        assert rows == [], "No provider call should have been attempted"


@pytest.mark.asyncio
async def test_member_initiated_call_blocked_when_own_phone_is_placeholder(
    client: AsyncClient,
) -> None:
    """Member (whose own phone is the sentinel) taps call -> same clean 422,
    no Vonage attempt — covers the member-initiates direction."""
    chw_tokens = await _register(client, "call-block-chw2@example.com", "chw")
    member_tokens = await _register(client, "call-block-member2@example.com", "member")
    chw_id = UUID(_user_id_from_tokens(chw_tokens))
    member_id = UUID(_user_id_from_tokens(member_tokens))
    await _set_phone_via_db(str(chw_id), "+13105550502")
    await _set_phone_via_db(str(member_id), PLACEHOLDER_PHONE_E164)

    session_id = await _seed_scheduled_session(chw_id, member_id)

    res = await client.post(
        f"/api/v1/sessions/{session_id}/call",
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 422, f"Expected 422, got {res.status_code}: {res.text}"
    assert res.json()["detail"] == PLACEHOLDER_PHONE_CALL_BLOCK_MESSAGE

    async with _test_session_factory() as db:
        rows = (
            await db.execute(
                select(CommunicationSession).where(CommunicationSession.session_id == session_id)
            )
        ).scalars().all()
        assert rows == [], "No provider call should have been attempted"

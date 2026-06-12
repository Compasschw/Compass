"""Tests for the voice/consent-result NCCO (member-leg consent IVR continuation).

Scope
-----
Exercises the NCCO construction paths of
POST /api/v1/communication/voice/consent-result.

Current product contract (see app/routers/communication.py):
  digit == "1" → [talk, conversation(name="compass-session-<id>")]
      The member leg joins the named Vonage Conversation that the CHW leg
      already joined in /voice/answer. Recording is owned by the CHW leg's
      conversation action (``record: True`` set by the first joiner), so the
      member-leg NCCO carries NO record action.
  anything else → [talk] polite goodbye.

Per-leg WebSocket audio forks are intentionally NOT emitted by this endpoint
anymore: ``connect(websocket)`` blocks a phone leg for its entire duration,
which prevents the leg from joining the named ``conversation`` that bridges
the call. Live phone-call captions would require Vonage's Audio Connector and
are out of scope. These tests pin that contract so the WS fork does not creep
back into the NCCO and silently break call bridging again.

Settings are patched with ``patch.object`` on the real settings object —
never by replacing ``app.config.settings`` wholesale — so untouched
attributes (notably ``vonage_signature_secret`` and ``environment``) keep
their real test-env values and the Vonage webhook signature dependency stays
disarmed in non-production.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator
from typing import Any
from unittest.mock import patch

import pytest
from httpx import ASGITransport, AsyncClient

# ---------------------------------------------------------------------------
# App bootstrap — must happen before importing from app.*
# ---------------------------------------------------------------------------
import os

os.environ.setdefault("DISABLE_RATE_LIMIT", "1")
os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://compass:compass_dev_password@localhost:5432/compass_test",
)

from app.main import app  # noqa: E402  (app import must follow env setup)
from app.config import settings  # noqa: E402
from app.database import get_db  # noqa: E402


# ---------------------------------------------------------------------------
# Lightweight DB stub — avoids the full conftest postgres setup for unit-
# style assertions.  The digit==1 branch does a db.get(Session, ...) then
# db.add / db.commit; we stub those so we never need a real DB here.
# ---------------------------------------------------------------------------


class _StubSession:
    """Minimal async SQLAlchemy session stub."""

    def __init__(self, session_row: Any = None) -> None:
        self._session_row = session_row

    async def get(self, model: Any, pk: Any) -> Any:  # noqa: ANN401
        return self._session_row

    def add(self, obj: Any) -> None:  # noqa: ANN401
        pass

    async def commit(self) -> None:
        pass

    async def rollback(self) -> None:
        pass

    async def __aenter__(self) -> "_StubSession":
        return self

    async def __aexit__(self, *_: Any) -> None:
        pass


class _StubSessionRow:
    """Minimal Session ORM row stub."""

    def __init__(self, session_id: uuid.UUID) -> None:
        self.id = session_id
        self.member_id = uuid.uuid4()
        self.status = "in_progress"
        self.recording_consent_given_at = None


def _make_stub_db(session_row: Any = None):
    """Return an async generator that yields a _StubSession."""

    async def _override() -> AsyncGenerator[_StubSession, None]:
        yield _StubSession(session_row=session_row)

    return _override


# ---------------------------------------------------------------------------
# DTMF payload helpers
# ---------------------------------------------------------------------------

_SESSION_ID = str(uuid.uuid4())

_DIGIT_1_PAYLOAD = {
    "dtmf": {"digits": "1"},
    "from": "15551234567",
    "to": "18001112222",
}

_DIGIT_2_PAYLOAD = {
    "dtmf": {"digits": "2"},
    "from": "15551234567",
    "to": "18001112222",
}


# ---------------------------------------------------------------------------
# Helper: send digit to consent-result endpoint
# ---------------------------------------------------------------------------


async def _post_consent_result(
    client: AsyncClient,
    payload: dict,
    session_id: str = _SESSION_ID,
) -> Any:
    return await client.post(
        f"/api/v1/communication/voice/consent-result?session={session_id}",
        json=payload,
    )


# ---------------------------------------------------------------------------
# Test 1: digit=1 → talk + conversation-bridge NCCO (no connect / no record)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_digit_1_returns_talk_then_conversation_bridge() -> None:
    """digit=1 → NCCO is [talk, conversation] in that order.

    The conversation name must be ``compass-session-<session_id>`` so the
    member leg joins the same named bridge the CHW leg created in
    /voice/answer. No connect (WS fork) and no record action — recording is
    owned by the CHW leg's conversation action.
    """
    session_id = str(uuid.uuid4())
    stub_row = _StubSessionRow(uuid.UUID(session_id))

    app.dependency_overrides[get_db] = _make_stub_db(stub_row)
    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await _post_consent_result(
                client, _DIGIT_1_PAYLOAD, session_id=session_id
            )

        assert resp.status_code == 200
        ncco = resp.json()

        action_types = [a["action"] for a in ncco]
        assert action_types[0] == "talk", f"First action must be 'talk', got: {action_types}"
        assert "conversation" in action_types, (
            f"Member leg must join the named conversation, got: {action_types}"
        )
        assert "connect" not in action_types, (
            "connect(websocket) blocks the leg and must never appear on the "
            f"member consent continuation NCCO, got: {action_types}"
        )
        assert "record" not in action_types, (
            "Recording is owned by the CHW leg's conversation action — the "
            f"member-leg NCCO must not carry its own record action, got: {action_types}"
        )

        conversation_action = next(a for a in ncco if a["action"] == "conversation")
        assert conversation_action["name"] == f"compass-session-{session_id}", (
            f"Conversation name must match the CHW leg's: {conversation_action}"
        )
    finally:
        app.dependency_overrides.pop(get_db, None)


# ---------------------------------------------------------------------------
# Test 2: conversation name embeds the session id from the query param
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_conversation_name_uses_session_id_from_query_param() -> None:
    """The session_id threaded into the conversation name must match the
    query param value, not a hardcoded or default value — otherwise the two
    call legs land in different conversations and never bridge.
    """
    # Use a distinct UUID so we catch any hardcoded value.
    unique_session = str(uuid.uuid4())
    stub_row = _StubSessionRow(uuid.UUID(unique_session))

    app.dependency_overrides[get_db] = _make_stub_db(stub_row)
    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await _post_consent_result(
                client, _DIGIT_1_PAYLOAD, session_id=unique_session
            )

        assert resp.status_code == 200
        ncco = resp.json()

        conversation_actions = [a for a in ncco if a["action"] == "conversation"]
        assert conversation_actions, "Expected a conversation action"

        conversation_name = conversation_actions[0].get("name", "")
        assert unique_session in conversation_name, (
            f"Session ID {unique_session!r} not found in conversation name: "
            f"{conversation_name!r}"
        )
    finally:
        app.dependency_overrides.pop(get_db, None)


# ---------------------------------------------------------------------------
# Test 3: digit=1 → no WS fork even when vonage_ws_audio_url_base IS set
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_digit_1_no_ws_fork_even_when_ws_base_configured() -> None:
    """digit=1 with vonage_ws_audio_url_base configured → still no websocket
    connect action.

    The WS fork was removed from this NCCO on purpose (it blocks the leg and
    breaks the conversation bridge); configuring the URL base must not bring
    it back.
    """
    session_id = str(uuid.uuid4())
    stub_row = _StubSessionRow(uuid.UUID(session_id))

    app.dependency_overrides[get_db] = _make_stub_db(stub_row)
    try:
        with patch.object(
            settings, "vonage_ws_audio_url_base", "wss://api.joincompasschw.com"
        ):
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                resp = await _post_consent_result(
                    client, _DIGIT_1_PAYLOAD, session_id=session_id
                )

        assert resp.status_code == 200
        ncco = resp.json()

        action_types = [a["action"] for a in ncco]
        assert "connect" not in action_types, (
            "No websocket connect action may appear even when "
            f"vonage_ws_audio_url_base is configured, got: {action_types}"
        )
        assert "conversation" in action_types, (
            f"Member leg must still join the conversation bridge, got: {action_types}"
        )
    finally:
        app.dependency_overrides.pop(get_db, None)


# ---------------------------------------------------------------------------
# Test 4: digit=1 + broken WS token generation → handler unaffected (no 500)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_digit_1_unaffected_when_token_generation_would_raise() -> None:
    """digit=1 must succeed even if create_vonage_ws_token would raise.

    The handler no longer mints per-leg WS tokens, so a misconfigured
    vonage_ws_jwt_secret (RuntimeError from create_vonage_ws_token) must have
    zero effect on the consent continuation: 200, conversation bridge intact,
    no websocket connect action.
    """
    session_id = str(uuid.uuid4())
    stub_row = _StubSessionRow(uuid.UUID(session_id))

    app.dependency_overrides[get_db] = _make_stub_db(stub_row)
    try:
        with (
            patch.object(
                settings, "vonage_ws_audio_url_base", "wss://api.joincompasschw.com"
            ),
            patch(
                "app.utils.security.create_vonage_ws_token",
                side_effect=RuntimeError("vonage_ws_jwt_secret is not configured"),
            ),
        ):
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                resp = await _post_consent_result(
                    client, _DIGIT_1_PAYLOAD, session_id=session_id
                )
    finally:
        app.dependency_overrides.pop(get_db, None)

    # Must not 500 — the handler never invokes token generation on this path.
    assert resp.status_code == 200, (
        f"Handler must not depend on WS token generation; got {resp.status_code}"
    )
    ncco = resp.json()
    action_types = [a["action"] for a in ncco]
    assert "connect" not in action_types, (
        f"No websocket connect action expected, got: {action_types}"
    )
    assert "conversation" in action_types, (
        f"Conversation bridge must survive, got: {action_types}"
    )


# ---------------------------------------------------------------------------
# Test 5: digit=2 → unchanged decline NCCO (no websocket fork)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_digit_2_unchanged_decline_ncco() -> None:
    """digit=2 → decline path is completely unaffected by the WS fork feature.

    The NCCO must contain only a talk action (polite goodbye) and must NOT
    contain any connect or record action.
    """
    session_id = str(uuid.uuid4())
    stub_row = _StubSessionRow(uuid.UUID(session_id))
    # For digit=2 the handler reads the session to set status; provide a row
    stub_row.status = "in_progress"

    app.dependency_overrides[get_db] = _make_stub_db(stub_row)
    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await _post_consent_result(
                client, _DIGIT_2_PAYLOAD, session_id=session_id
            )

        assert resp.status_code == 200
        ncco = resp.json()

        action_types = [a["action"] for a in ncco]
        assert "connect" not in action_types, (
            "Decline path must never emit a connect action"
        )
        assert "record" not in action_types, (
            "Decline path must never emit a record action"
        )
        assert "talk" in action_types, (
            "Decline path must emit a polite goodbye talk action"
        )
        # Confirm the talk text is the decline message, not the consent talk
        talk_texts = [a["text"] for a in ncco if a["action"] == "talk"]
        assert any("could not record consent" in t.lower() or "goodbye" in t.lower() for t in talk_texts), (
            f"Expected decline talk text, got: {talk_texts}"
        )
    finally:
        app.dependency_overrides.pop(get_db, None)

"""Tests for the voice/consent-result NCCO WebSocket fork (feat/vonage-ws-ncco).

Scope
-----
Exercises only the digit==1 NCCO construction path of
POST /api/v1/communication/voice/consent-result.

Tests that require ``create_vonage_ws_token`` from ``app.utils.security``
(built by the parallel compass-wt-backend agent) are marked::

    # un-skipped after feat/vonage-ws-backend merged into main

so this suite stays green before the parallel branch lands. The parent will
unskip them after merging feat/vonage-ws-backend into main.

All other tests (fallback paths, digit==2) run immediately and need no
external dependency.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator
from typing import Any
from unittest.mock import MagicMock, patch

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
# Test 1 (skipped): digit=1 + both env vars set → WS connect in NCCO
# ---------------------------------------------------------------------------


# un-skipped after feat/vonage-ws-backend merged into main
@pytest.mark.asyncio
async def test_digit_1_ws_fork_present_when_fully_configured() -> None:
    """digit=1 with vonage_ws_audio_url_base + vonage_ws_jwt_secret set →
    NCCO contains a websocket connect action with the correct URI.

    Skipped until create_vonage_ws_token is available from feat/vonage-ws-backend.
    """
    session_id = str(uuid.uuid4())
    stub_row = _StubSessionRow(uuid.UUID(session_id))
    fake_token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test"
    ws_base = "wss://api.joincompasschw.com"

    app.dependency_overrides[get_db] = _make_stub_db(stub_row)
    try:
        with (
            patch(
                "app.config.settings",
                vonage_ws_audio_url_base=ws_base,
                vonage_from_number="18127224291",
            ),
            patch(
                "app.utils.security.create_vonage_ws_token",
                return_value=fake_token,
            ),
        ):
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                resp = await _post_consent_result(
                    client, _DIGIT_1_PAYLOAD, session_id=session_id
                )

        assert resp.status_code == 200
        ncco = resp.json()

        action_types = [a["action"] for a in ncco]
        assert "connect" in action_types, f"Expected websocket connect in NCCO, got: {action_types}"
        assert "record" in action_types, f"Expected record action in NCCO, got: {action_types}"

        # connect must come before record (Vonage action ordering contract)
        connect_idx = action_types.index("connect")
        record_idx = action_types.index("record")
        assert connect_idx < record_idx, "websocket connect must precede record action"

        # Verify the websocket URI is well-formed
        connect_action = ncco[connect_idx]
        ws_endpoint = connect_action["endpoint"][0]
        expected_uri = (
            f"{ws_base}/api/v1/sessions/{session_id}/transcript/vonage-stream"
            f"?token={fake_token}"
        )
        assert ws_endpoint["uri"] == expected_uri, (
            f"WebSocket URI mismatch.\n  expected: {expected_uri}\n  got:      {ws_endpoint['uri']}"
        )
        assert ws_endpoint["type"] == "websocket"
        assert ws_endpoint["content-type"] == "audio/l16;rate=16000"
        assert ws_endpoint["headers"]["session_id"] == session_id

    finally:
        app.dependency_overrides.pop(get_db, None)


# ---------------------------------------------------------------------------
# Test 2 (skipped): websocket URI embeds the session id from the query param
# ---------------------------------------------------------------------------


# un-skipped after feat/vonage-ws-backend merged into main
@pytest.mark.asyncio
async def test_websocket_uri_uses_session_id_from_query_param() -> None:
    """The session_id threaded through the WS URI must match the query param
    value, not a hardcoded or default value.

    Skipped until create_vonage_ws_token is available from feat/vonage-ws-backend.
    """
    # Use a distinct UUID so we catch any hardcoded value
    unique_session = str(uuid.uuid4())
    stub_row = _StubSessionRow(uuid.UUID(unique_session))
    fake_token = "test-token-xyz"
    ws_base = "wss://api.joincompasschw.com"

    app.dependency_overrides[get_db] = _make_stub_db(stub_row)
    try:
        with (
            patch(
                "app.config.settings",
                vonage_ws_audio_url_base=ws_base,
                vonage_from_number="18127224291",
            ),
            patch(
                "app.utils.security.create_vonage_ws_token",
                return_value=fake_token,
            ),
        ):
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                resp = await _post_consent_result(
                    client, _DIGIT_1_PAYLOAD, session_id=unique_session
                )

        assert resp.status_code == 200
        ncco = resp.json()

        connect_actions = [a for a in ncco if a["action"] == "connect"]
        assert connect_actions, "Expected at least one connect action"

        ws_uri = connect_actions[0]["endpoint"][0]["uri"]
        assert unique_session in ws_uri, (
            f"Session ID {unique_session!r} not found in WebSocket URI: {ws_uri!r}"
        )
    finally:
        app.dependency_overrides.pop(get_db, None)


# ---------------------------------------------------------------------------
# Test 3: digit=1 + vonage_ws_audio_url_base empty → no WS fork, record stays
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_digit_1_no_ws_fork_when_url_base_empty() -> None:
    """digit=1 with vonage_ws_audio_url_base='' → no websocket connect action,
    record action still present (backup path must survive the fallback).
    """
    session_id = str(uuid.uuid4())
    stub_row = _StubSessionRow(uuid.UUID(session_id))

    app.dependency_overrides[get_db] = _make_stub_db(stub_row)
    try:
        # Both _public_base_url() and the WS-fork block do `from app.config import settings`
        # lazily inside the function, so we patch the canonical object on app.config.
        import app.config as _app_config

        original_settings = _app_config.settings
        mock_settings = MagicMock()
        mock_settings.vonage_ws_audio_url_base = ""
        mock_settings.vonage_from_number = "18127224291"
        # magic_link_base_url is consumed by _public_base_url() for the record eventUrl.
        mock_settings.magic_link_base_url = "https://api.joincompasschw.com/auth/magic"

        _app_config.settings = mock_settings
        try:
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                resp = await _post_consent_result(
                    client, _DIGIT_1_PAYLOAD, session_id=session_id
                )
        finally:
            _app_config.settings = original_settings

        assert resp.status_code == 200
        ncco = resp.json()

        action_types = [a["action"] for a in ncco]
        assert "connect" not in action_types, (
            "No websocket connect action expected when vonage_ws_audio_url_base is empty"
        )
        assert "record" in action_types, (
            "Record action must always be present as the backup mp3 path"
        )
    finally:
        app.dependency_overrides.pop(get_db, None)


# ---------------------------------------------------------------------------
# Test 4: digit=1 + token generation raises → no WS fork, no exception bubbles
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_digit_1_no_ws_fork_when_token_generation_raises() -> None:
    """digit=1 with vonage_ws_audio_url_base set but create_vonage_ws_token
    raising RuntimeError (vonage_ws_jwt_secret missing) → graceful fallback,
    no websocket connect action, no 500.

    We patch app.utils.security.create_vonage_ws_token with a stub that raises
    RuntimeError immediately.  The stub is importable even before the parallel
    branch lands because we inject it at test runtime via patch — the real
    module does not need to exist for the mock target to work when the path
    is imported inside the handler function body.
    """
    session_id = str(uuid.uuid4())
    stub_row = _StubSessionRow(uuid.UUID(session_id))

    app.dependency_overrides[get_db] = _make_stub_db(stub_row)

    import app.config as _app_config

    original_settings = _app_config.settings
    mock_settings = MagicMock()
    mock_settings.vonage_ws_audio_url_base = "wss://api.joincompasschw.com"
    mock_settings.vonage_from_number = "18127224291"
    mock_settings.magic_link_base_url = "https://api.joincompasschw.com/auth/magic"

    def _raise_runtime(*_args: Any, **_kwargs: Any) -> str:
        raise RuntimeError("vonage_ws_jwt_secret is not configured")

    _app_config.settings = mock_settings
    try:
        # Inject a stub module at app.utils.security so the `from app.utils.security
        # import create_vonage_ws_token` inside the handler resolves to our raising stub.
        import sys
        import types

        security_stub = types.ModuleType("app.utils.security")
        security_stub.create_vonage_ws_token = _raise_runtime  # type: ignore[attr-defined]
        sys.modules["app.utils.security"] = security_stub
        try:
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                resp = await _post_consent_result(
                    client, _DIGIT_1_PAYLOAD, session_id=session_id
                )
        finally:
            # Restore the original module slot (or remove if it wasn't there).
            sys.modules.pop("app.utils.security", None)
    finally:
        _app_config.settings = original_settings
        app.dependency_overrides.pop(get_db, None)

    # Must not 500 — the handler must degrade gracefully.
    assert resp.status_code == 200, (
        f"Handler must not raise when token generation fails; got {resp.status_code}"
    )
    ncco = resp.json()
    action_types = [a["action"] for a in ncco]
    assert "connect" not in action_types, (
        "No websocket connect action expected when token generation raised"
    )
    assert "record" in action_types, (
        "Record action must survive the fallback path"
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

"""Tests for per-leg Vonage WS forking (feat/phone-per-leg-ws).

Scope
-----
1. Token helpers — create_vonage_ws_token / verify_vonage_ws_token with role
2. voice/consent-result digit==1 NCCO joins the member leg into the named
   Vonage Conversation. Per-leg WS forks are intentionally NOT emitted
   anymore — ``connect(websocket)`` blocks a phone leg for its entire
   duration and prevents the ``conversation`` join that actually bridges the
   call. These tests pin the no-WS-fork contract.
3. Vonage WS endpoint routes chw-role token to CHW provider stream.
4. Vonage WS endpoint routes member-role token to member provider stream.
5. Wrong role in token → still accepted (role IS the routing signal, not a
   permission gate — any well-formed role token passes auth).
6. voice/answer NCCO joins the CHW leg into the same named conversation with
   ``record: True``; the member leg is dialed by a SEPARATE outbound call
   (see VonageProvider.create_proxy_session) whose answer_url runs the
   consent IVR — so the CHW NCCO carries no phone connect either.

All DB interactions use the _StubSession helper to avoid requiring a live
Postgres instance.  WebSocket integration tests use starlette's TestClient.

Settings are patched with ``patch.object`` on the real settings object —
never by replacing ``app.config.settings`` wholesale — so untouched
attributes (notably ``vonage_signature_secret`` and ``environment``) keep
their real test-env values and the Vonage webhook signature dependency stays
disarmed in non-production.
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient
from jose import jwt as jose_jwt
from starlette.websockets import WebSocketDisconnect

# ---------------------------------------------------------------------------
# App bootstrap
# ---------------------------------------------------------------------------
import os

os.environ.setdefault("DISABLE_RATE_LIMIT", "1")
os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://compass:compass_dev_password@localhost:5432/compass_test",
)

from app.main import app  # noqa: E402
from app.config import settings  # noqa: E402
from app.database import get_db  # noqa: E402
from app.utils.security import create_vonage_ws_token, verify_vonage_ws_token  # noqa: E402

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_TEST_SECRET = "test-vonage-per-leg-secret-aaaabbbbccccdddd1111"

_BASE_WS_PATH = "/api/v1/sessions/{session_id}/transcript/vonage-stream"

# Vonage mandatory first-frame envelope.
_CONNECTED_ENVELOPE = json.dumps(
    {
        "event": "websocket:connected",
        "content-type": "audio/l16;rate=16000",
        "uuid": "ddddeeee-ffff-0000-1111-222233334444",
    }
)

# Shared TestClient — synchronous, required for WS tests.
_sync_client = TestClient(app, raise_server_exceptions=False)

WS_CLOSE_AUTH_FAILED = 4001


# ---------------------------------------------------------------------------
# DB stub — avoids Postgres for unit-style tests
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
    from collections.abc import AsyncGenerator

    async def _override() -> AsyncGenerator[_StubSession, None]:
        yield _StubSession(session_row=session_row)

    return _override


# ---------------------------------------------------------------------------
# Token mint helper (bypasses the runtime secret requirement for negative tests)
# ---------------------------------------------------------------------------


def _mint_token(
    session_id: uuid.UUID,
    secret: str = _TEST_SECRET,
    role: str = "chw",
    sub: str = "vonage",
    ttl_seconds: int = 300,
) -> str:
    """Mint a raw JWT for testing — does not go through create_vonage_ws_token."""
    now = datetime.now(UTC)
    payload = {
        "sub": sub,
        "session_id": str(session_id),
        "role": role,
        "exp": int((now + timedelta(seconds=ttl_seconds)).timestamp()),
        "iat": int(now.timestamp()),
        "jti": uuid.uuid4().hex,
    }
    return jose_jwt.encode(payload, secret, algorithm="HS256")


def _ws_url(session_id: uuid.UUID, token: str | None) -> str:
    base = _BASE_WS_PATH.format(session_id=session_id)
    return f"{base}?token={token}" if token else base


# ===========================================================================
# 1. Token helpers — role-aware create / verify
# ===========================================================================


class TestPerLegTokenHelpers:
    """Verify that create_vonage_ws_token embeds role and verify returns (session_id, role)."""

    def _patch_secret(self):
        return patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "vonage_ws_jwt_secret",
            _TEST_SECRET,
        )

    def test_chw_token_roundtrip(self):
        """create(role='chw') → verify returns ('chw' role, correct session_id)."""
        session_id = uuid.uuid4()
        with self._patch_secret():
            token = create_vonage_ws_token(session_id, role="chw")
            result = verify_vonage_ws_token(token)

        assert result is not None, "verify must succeed for a valid CHW token"
        returned_session_id, returned_role = result
        assert returned_session_id == session_id
        assert returned_role == "chw"

    def test_member_token_roundtrip(self):
        """create(role='member') → verify returns ('member' role, correct session_id)."""
        session_id = uuid.uuid4()
        with self._patch_secret():
            token = create_vonage_ws_token(session_id, role="member")
            result = verify_vonage_ws_token(token)

        assert result is not None, "verify must succeed for a valid member token"
        returned_session_id, returned_role = result
        assert returned_session_id == session_id
        assert returned_role == "member"

    def test_chw_and_member_tokens_are_distinct(self):
        """Tokens for the same session but different roles must not be interchangeable
        at the claims level — both verify but return different roles."""
        session_id = uuid.uuid4()
        with self._patch_secret():
            chw_token = create_vonage_ws_token(session_id, role="chw")
            member_token = create_vonage_ws_token(session_id, role="member")
            result_chw = verify_vonage_ws_token(chw_token)
            result_member = verify_vonage_ws_token(member_token)

        assert result_chw is not None
        assert result_member is not None
        _, role_chw = result_chw
        _, role_member = result_member
        assert role_chw == "chw"
        assert role_member == "member"
        assert role_chw != role_member

    def test_verify_returns_tuple_not_bare_uuid(self):
        """verify_vonage_ws_token must return a 2-tuple, not a bare UUID."""
        session_id = uuid.uuid4()
        with self._patch_secret():
            token = create_vonage_ws_token(session_id, role="chw")
            result = verify_vonage_ws_token(token)

        assert isinstance(result, tuple), (
            f"Expected tuple, got {type(result)}: {result!r}"
        )
        assert len(result) == 2

    def test_role_claim_embedded_in_jwt(self):
        """The JWT payload must contain a 'role' claim for each token."""
        session_id = uuid.uuid4()
        with self._patch_secret():
            chw_token = create_vonage_ws_token(session_id, role="chw")
            member_token = create_vonage_ws_token(session_id, role="member")

        chw_claims = jose_jwt.get_unverified_claims(chw_token)
        member_claims = jose_jwt.get_unverified_claims(member_token)

        assert chw_claims.get("role") == "chw"
        assert member_claims.get("role") == "member"

    def test_invalid_role_raises_value_error(self):
        """create_vonage_ws_token with an unknown role must raise ValueError."""
        session_id = uuid.uuid4()
        with self._patch_secret():
            with pytest.raises(ValueError, match="Invalid role"):
                create_vonage_ws_token(session_id, role="supervisor")

    def test_verify_rejects_unknown_role_in_token(self):
        """A token carrying an unknown role claim must return None — not a tuple."""
        session_id = uuid.uuid4()
        bad_role_token = _mint_token(session_id, secret=_TEST_SECRET, role="operator")

        with patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "vonage_ws_jwt_secret",
            _TEST_SECRET,
        ):
            result = verify_vonage_ws_token(bad_role_token)

        assert result is None, "Tokens with unrecognised roles must be rejected"


# ===========================================================================
# 2. voice/consent-result NCCO — per-leg WS URIs
# ===========================================================================

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


async def _post_consent_result(
    client: AsyncClient,
    payload: dict,
    session_id: str,
) -> Any:
    return await client.post(
        f"/api/v1/communication/voice/consent-result?session={session_id}",
        json=payload,
    )


async def _post_voice_answer(
    client: AsyncClient,
    session_id: str,
    member_phone: str = "15559876543",
) -> Any:
    return await client.post(
        f"/api/v1/communication/voice/answer?session={session_id}&member={member_phone}",
        json={},
    )


class TestConsentResultPerLegNcco:
    """voice/consent-result digit=1 → member leg joins the named conversation.

    Per-leg WS forks are intentionally NOT emitted (``connect(websocket)``
    blocks the leg and prevents the conversation join that bridges the call).
    Recording is owned by the CHW leg's conversation action, so the member
    NCCO carries no record action either.
    """

    @pytest.mark.asyncio
    async def test_digit_1_member_leg_joins_conversation_no_ws_fork(self) -> None:
        """digit=1 with WS config present → NCCO is [talk, conversation]; the
        configured vonage_ws_audio_url_base must NOT re-introduce a WS connect
        or a member-leg record action."""
        session_id = str(uuid.uuid4())
        stub_row = _StubSessionRow(uuid.UUID(session_id))
        ws_base = "wss://api.joincompasschw.com"

        app.dependency_overrides[get_db] = _make_stub_db(stub_row)
        try:
            with patch.object(settings, "vonage_ws_audio_url_base", ws_base):
                transport = ASGITransport(app=app)
                async with AsyncClient(transport=transport, base_url="http://test") as client:
                    resp = await _post_consent_result(
                        client, _DIGIT_1_PAYLOAD, session_id=session_id
                    )
        finally:
            app.dependency_overrides.pop(get_db, None)

        assert resp.status_code == 200
        ncco = resp.json()

        action_types = [a["action"] for a in ncco]
        assert "connect" not in action_types, (
            "connect(websocket) blocks the member leg and must never appear "
            f"on the consent continuation NCCO, got: {action_types}"
        )
        assert "record" not in action_types, (
            "Recording is owned by the CHW leg's conversation action — no "
            f"member-leg record action, got: {action_types}"
        )
        assert "conversation" in action_types, (
            f"Member leg must join the named conversation, got: {action_types}"
        )

        conversation_action = next(a for a in ncco if a["action"] == "conversation")
        assert conversation_action["name"] == f"compass-session-{session_id}", (
            "Conversation name must match the CHW leg's "
            f"compass-session-<id>: {conversation_action}"
        )

    @pytest.mark.asyncio
    async def test_digit_1_conversation_join_present(self) -> None:
        """digit=1 → NCCO must include a conversation action to bridge the two legs."""
        session_id = str(uuid.uuid4())
        stub_row = _StubSessionRow(uuid.UUID(session_id))

        app.dependency_overrides[get_db] = _make_stub_db(stub_row)
        try:
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                resp = await _post_consent_result(
                    client, _DIGIT_1_PAYLOAD, session_id=session_id
                )
        finally:
            app.dependency_overrides.pop(get_db, None)

        assert resp.status_code == 200
        ncco = resp.json()

        action_types = [a["action"] for a in ncco]
        assert "conversation" in action_types, (
            f"Member leg must join the named conversation. Got NCCO: {action_types}"
        )

        # Conversation name must be keyed on the session_id.
        conversation_action = next(a for a in ncco if a["action"] == "conversation")
        assert session_id in conversation_action.get("name", ""), (
            f"Conversation name must embed session_id. Got: {conversation_action}"
        )

    @pytest.mark.asyncio
    async def test_digit_1_ncco_action_ordering(self) -> None:
        """digit=1 → action ordering must be: talk (ack) → conversation (join)."""
        session_id = str(uuid.uuid4())
        stub_row = _StubSessionRow(uuid.UUID(session_id))

        app.dependency_overrides[get_db] = _make_stub_db(stub_row)
        try:
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                resp = await _post_consent_result(
                    client, _DIGIT_1_PAYLOAD, session_id=session_id
                )
        finally:
            app.dependency_overrides.pop(get_db, None)

        assert resp.status_code == 200
        ncco = resp.json()
        action_types = [a["action"] for a in ncco]

        # Required ordering: talk (acknowledgement) first, then the
        # conversation join. No connect/record actions on this leg.
        assert action_types[0] == "talk", f"First action must be 'talk', got: {action_types}"
        assert "conversation" in action_types, (
            f"Conversation join must be present, got: {action_types}"
        )
        assert action_types.index("talk") < action_types.index("conversation"), (
            "talk acknowledgement must precede the conversation join"
        )
        assert "connect" not in action_types, (
            f"No connect action may appear on the member leg, got: {action_types}"
        )
        assert "record" not in action_types, (
            f"No record action may appear on the member leg, got: {action_types}"
        )

    @pytest.mark.asyncio
    async def test_digit_1_no_ws_fork_when_url_base_empty(self) -> None:
        """digit=1 with vonage_ws_audio_url_base='' → no WS fork, conversation
        bridge still present."""
        session_id = str(uuid.uuid4())
        stub_row = _StubSessionRow(uuid.UUID(session_id))

        app.dependency_overrides[get_db] = _make_stub_db(stub_row)
        try:
            with patch.object(settings, "vonage_ws_audio_url_base", ""):
                transport = ASGITransport(app=app)
                async with AsyncClient(transport=transport, base_url="http://test") as client:
                    resp = await _post_consent_result(
                        client, _DIGIT_1_PAYLOAD, session_id=session_id
                    )
        finally:
            app.dependency_overrides.pop(get_db, None)

        assert resp.status_code == 200
        ncco = resp.json()

        action_types = [a["action"] for a in ncco]
        assert "connect" not in action_types, (
            "No WS connect when vonage_ws_audio_url_base is empty"
        )
        assert "conversation" in action_types, (
            "Conversation bridge must be present regardless of WS config"
        )

    @pytest.mark.asyncio
    async def test_digit_1_token_generation_failure_degrades_gracefully(self) -> None:
        """digit=1 with create_vonage_ws_token raising → no 500; the handler
        never mints per-leg WS tokens so the bridge NCCO is unaffected."""
        session_id = str(uuid.uuid4())
        stub_row = _StubSessionRow(uuid.UUID(session_id))

        def _raise(*_args: Any, **_kwargs: Any) -> str:
            raise RuntimeError("VONAGE_WS_JWT_SECRET is not configured")

        app.dependency_overrides[get_db] = _make_stub_db(stub_row)
        try:
            with (
                patch.object(
                    settings, "vonage_ws_audio_url_base", "wss://api.joincompasschw.com"
                ),
                patch("app.utils.security.create_vonage_ws_token", side_effect=_raise),
            ):
                transport = ASGITransport(app=app)
                async with AsyncClient(transport=transport, base_url="http://test") as client:
                    resp = await _post_consent_result(
                        client, _DIGIT_1_PAYLOAD, session_id=session_id
                    )
        finally:
            app.dependency_overrides.pop(get_db, None)

        assert resp.status_code == 200, (
            f"Handler must not raise when token generation fails; got {resp.status_code}"
        )
        ncco = resp.json()
        action_types = [a["action"] for a in ncco]
        assert "connect" not in action_types, "No WS connect expected when token generation fails"
        assert "conversation" in action_types, (
            "Conversation bridge must survive a broken WS token configuration"
        )


# ===========================================================================
# 3 & 4. Vonage WS endpoint routes audio by role
# ===========================================================================


class TestVonageWsPerLegRouting:
    """The WS endpoint must route audio to the role-keyed provider stream."""

    def test_chw_token_routes_audio_to_chw_provider_stream(self):
        """A CHW-role token must cause get_or_create_provider_stream to be
        called with role='chw'."""
        session_id = uuid.uuid4()
        token = _mint_token(session_id, secret=_TEST_SECRET, role="chw")
        url = _ws_url(session_id, token)

        received_calls: list[tuple] = []

        class _RoleCapturingProvider:
            async def send_audio(self, chunk: bytes) -> None:
                pass

        async def _mock_get_or_create(sid: uuid.UUID, role: str) -> _RoleCapturingProvider:
            received_calls.append((sid, role))
            return _RoleCapturingProvider()

        with (
            patch.object(
                __import__("app.config", fromlist=["settings"]).settings,
                "vonage_ws_jwt_secret",
                _TEST_SECRET,
            ),
            patch(
                "app.routers.vonage_audio.transcript_hub.get_or_create_provider_stream",
                side_effect=_mock_get_or_create,
            ),
        ):
            with _sync_client.websocket_connect(url) as ws:
                ws.send_text(_CONNECTED_ENVELOPE)
                ws.send_bytes(bytes(100))

        assert len(received_calls) == 1, f"Expected exactly one hub call, got {received_calls}"
        called_session_id, called_role = received_calls[0]
        assert called_session_id == session_id
        assert called_role == "chw", (
            f"Expected role='chw' forwarded to hub, got {called_role!r}"
        )

    def test_member_token_routes_audio_to_member_provider_stream(self):
        """A member-role token must cause get_or_create_provider_stream to be
        called with role='member'."""
        session_id = uuid.uuid4()
        token = _mint_token(session_id, secret=_TEST_SECRET, role="member")
        url = _ws_url(session_id, token)

        received_calls: list[tuple] = []

        class _RoleCapturingProvider:
            async def send_audio(self, chunk: bytes) -> None:
                pass

        async def _mock_get_or_create(sid: uuid.UUID, role: str) -> _RoleCapturingProvider:
            received_calls.append((sid, role))
            return _RoleCapturingProvider()

        with (
            patch.object(
                __import__("app.config", fromlist=["settings"]).settings,
                "vonage_ws_jwt_secret",
                _TEST_SECRET,
            ),
            patch(
                "app.routers.vonage_audio.transcript_hub.get_or_create_provider_stream",
                side_effect=_mock_get_or_create,
            ),
        ):
            with _sync_client.websocket_connect(url) as ws:
                ws.send_text(_CONNECTED_ENVELOPE)
                ws.send_bytes(bytes(100))

        assert len(received_calls) == 1
        called_session_id, called_role = received_calls[0]
        assert called_session_id == session_id
        assert called_role == "member", (
            f"Expected role='member' forwarded to hub, got {called_role!r}"
        )

    def test_role_is_not_overridable_via_query_param(self):
        """The role must come from the verified JWT, not from any query parameter.

        Even if a ?role=member query param is appended alongside a chw-role token,
        the server must honour the token's role, not the query param.
        """
        session_id = uuid.uuid4()
        # Token says 'chw'...
        token = _mint_token(session_id, secret=_TEST_SECRET, role="chw")
        # ...but URL includes a spurious role=member query param.
        url = f"/api/v1/sessions/{session_id}/transcript/vonage-stream?token={token}&role=member"

        received_roles: list[str] = []

        class _RoleCapturingProvider:
            async def send_audio(self, chunk: bytes) -> None:
                pass

        async def _mock_get_or_create(sid: uuid.UUID, role: str) -> _RoleCapturingProvider:
            received_roles.append(role)
            return _RoleCapturingProvider()

        with (
            patch.object(
                __import__("app.config", fromlist=["settings"]).settings,
                "vonage_ws_jwt_secret",
                _TEST_SECRET,
            ),
            patch(
                "app.routers.vonage_audio.transcript_hub.get_or_create_provider_stream",
                side_effect=_mock_get_or_create,
            ),
        ):
            with _sync_client.websocket_connect(url) as ws:
                ws.send_text(_CONNECTED_ENVELOPE)
                ws.send_bytes(bytes(100))

        # Role must be 'chw' (from the token), NOT 'member' (from the query param).
        assert received_roles == ["chw"], (
            f"Role must be taken from JWT claim, not query param. Got: {received_roles}"
        )


# ===========================================================================
# 5. Role in token is an auth signal — any well-formed role is accepted
# ===========================================================================


class TestVonageWsRoleIsRoutingSignal:
    """The role in a token is a routing signal, not a permission gate.

    Any token with a valid (known) role passes auth. There is no per-role
    access control at the WebSocket layer — both "chw" and "member" tokens
    are equally accepted. The role simply determines which provider stream
    receives the audio.
    """

    def test_member_role_token_is_accepted_by_ws(self):
        """A member-role token must be accepted (not rejected with 4001)."""
        session_id = uuid.uuid4()
        token = _mint_token(session_id, secret=_TEST_SECRET, role="member")
        url = _ws_url(session_id, token)

        class _NoOpProvider:
            async def send_audio(self, chunk: bytes) -> None:
                pass

        accepted = False
        with (
            patch.object(
                __import__("app.config", fromlist=["settings"]).settings,
                "vonage_ws_jwt_secret",
                _TEST_SECRET,
            ),
            patch(
                "app.routers.vonage_audio.transcript_hub.get_or_create_provider_stream",
                return_value=_NoOpProvider(),
            ),
        ):
            try:
                with _sync_client.websocket_connect(url) as ws:
                    ws.send_text(_CONNECTED_ENVELOPE)
                    accepted = True
            except WebSocketDisconnect as exc:
                assert exc.code != 4001, (
                    "Member-role token must NOT be rejected with 4001 — "
                    "role is a routing signal, not a permission gate"
                )

        assert accepted, "WebSocket with member-role token must be accepted successfully"

    def test_chw_role_token_is_accepted_by_ws(self):
        """A chw-role token must be accepted."""
        session_id = uuid.uuid4()
        token = _mint_token(session_id, secret=_TEST_SECRET, role="chw")
        url = _ws_url(session_id, token)

        class _NoOpProvider:
            async def send_audio(self, chunk: bytes) -> None:
                pass

        accepted = False
        with (
            patch.object(
                __import__("app.config", fromlist=["settings"]).settings,
                "vonage_ws_jwt_secret",
                _TEST_SECRET,
            ),
            patch(
                "app.routers.vonage_audio.transcript_hub.get_or_create_provider_stream",
                return_value=_NoOpProvider(),
            ),
        ):
            try:
                with _sync_client.websocket_connect(url) as ws:
                    ws.send_text(_CONNECTED_ENVELOPE)
                    accepted = True
            except WebSocketDisconnect as exc:
                assert exc.code != 4001, "CHW-role token must not be rejected"

        assert accepted, "WebSocket with chw-role token must be accepted successfully"

    def test_unknown_role_token_is_rejected(self):
        """A token with an unrecognised role must be rejected with 4001."""
        session_id = uuid.uuid4()
        # Mint manually — bypasses the role validation in create_vonage_ws_token.
        bad_role_token = _mint_token(session_id, secret=_TEST_SECRET, role="dispatcher")
        url = _ws_url(session_id, bad_role_token)

        with (
            patch.object(
                __import__("app.config", fromlist=["settings"]).settings,
                "vonage_ws_jwt_secret",
                _TEST_SECRET,
            ),
        ):
            try:
                with _sync_client.websocket_connect(url) as ws:
                    ws.receive_text()
            except WebSocketDisconnect as exc:
                assert exc.code == 4001, (
                    f"Unknown role must be rejected with 4001, got code={exc.code}"
                )


# ===========================================================================
# 6. voice/answer NCCO — CHW-leg WS fork
# ===========================================================================


class TestVoiceAnswerChwLegNcco:
    """voice/answer → CHW leg joins the named conversation with record=True.

    The CHW NCCO carries NO connect actions at all:
      - no connect(websocket) — it would block the leg and break the bridge;
      - no connect(phone) — the member leg is dialed by a SEPARATE outbound
        call placed by VonageProvider.create_proxy_session, whose answer_url
        runs the /voice/consent-prompt IVR.
    """

    @pytest.mark.asyncio
    async def test_chw_leg_joins_recorded_conversation_no_ws_fork(self) -> None:
        """voice/answer with WS config present → [talk, conversation] only.

        The conversation action must be keyed on the session id, carry
        ``record: True`` (first joiner sets the recording policy for the
        bridge), and point its eventUrl at /voice/events. Configuring
        vonage_ws_audio_url_base must NOT re-introduce a WS connect.
        """
        session_id = str(uuid.uuid4())
        ws_base = "wss://api.joincompasschw.com"
        member_phone = "15559876543"

        with patch.object(settings, "vonage_ws_audio_url_base", ws_base):
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                resp = await _post_voice_answer(
                    client, session_id=session_id, member_phone=member_phone
                )

        assert resp.status_code == 200
        ncco = resp.json()
        action_types = [a["action"] for a in ncco]

        assert action_types[0] == "talk", f"First action must be 'talk', got: {action_types}"
        assert "conversation" in action_types, (
            f"CHW-leg NCCO must include the conversation join, got: {action_types}"
        )
        assert "connect" not in action_types, (
            "connect actions block the CHW leg and must never appear in the "
            f"voice/answer NCCO, got: {action_types}"
        )

        conversation_action = next(a for a in ncco if a["action"] == "conversation")
        assert conversation_action["name"] == f"compass-session-{session_id}", (
            f"Conversation name must embed the session id: {conversation_action}"
        )
        assert conversation_action.get("record") is True, (
            "The CHW leg (first joiner) must set record=True so the bridged "
            f"audio is captured for both legs: {conversation_action}"
        )
        event_urls = conversation_action.get("eventUrl") or []
        assert event_urls and "/voice/events" in event_urls[0], (
            f"Conversation eventUrl must point at /voice/events: {conversation_action}"
        )

    @pytest.mark.asyncio
    async def test_chw_ncco_has_no_phone_connect_to_member(self) -> None:
        """voice/answer NCCO must NOT dial the member via connect(phone).

        The member leg is placed as a separate outbound call by
        VonageProvider.create_proxy_session (answer_url → /voice/consent-prompt),
        because a nested ``connect(phone)`` blocks until the child leg ends and
        the conversation join after it never executes — the bridge silently
        fails. This test pins the no-phone-connect contract.
        """
        session_id = str(uuid.uuid4())
        member_phone = "15559998888"

        with patch.object(settings, "vonage_ws_audio_url_base", ""):
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                resp = await _post_voice_answer(
                    client, session_id=session_id, member_phone=member_phone
                )

        assert resp.status_code == 200
        ncco = resp.json()

        phone_connects = [
            a for a in ncco
            if a["action"] == "connect"
            and a.get("endpoint", [{}])[0].get("type") == "phone"
        ]
        assert len(phone_connects) == 0, (
            "CHW-leg NCCO must not dial the member via connect(phone) — the "
            "member leg is a separate outbound call through the consent IVR. "
            f"Got: {phone_connects}"
        )
        # The bridge itself must still be set up.
        assert any(a["action"] == "conversation" for a in ncco), (
            "CHW-leg NCCO must join the named conversation"
        )

    @pytest.mark.asyncio
    async def test_chw_ncco_no_ws_when_url_base_empty(self) -> None:
        """voice/answer with vonage_ws_audio_url_base='' → no WS fork in CHW NCCO."""
        session_id = str(uuid.uuid4())

        with patch.object(settings, "vonage_ws_audio_url_base", ""):
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as client:
                resp = await _post_voice_answer(
                    client, session_id=session_id, member_phone="15551111222"
                )

        assert resp.status_code == 200
        ncco = resp.json()

        ws_connects = [
            a for a in ncco
            if a["action"] == "connect"
            and a.get("endpoint", [{}])[0].get("type") == "websocket"
        ]
        assert len(ws_connects) == 0, (
            "No WS connect expected in CHW NCCO when vonage_ws_audio_url_base is empty"
        )

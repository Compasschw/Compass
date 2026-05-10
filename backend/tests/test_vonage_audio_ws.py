"""Tests for the Vonage Voice audio-ingestion WebSocket endpoint.

Endpoint: WS /api/v1/sessions/{session_id}/transcript/vonage-stream?token=<jwt>

Test categories
---------------
Token helper unit tests (no HTTP):
  - Roundtrip: create then verify returns the correct session_id.
  - Wrong-secret: a token signed with a different secret is rejected.
  - Expired: an already-expired token is rejected.
  - Wrong sub: a token with sub != "vonage" is rejected.
  - Missing secret: create raises RuntimeError when the secret is not set.

WebSocket integration tests (via TestClient):
  - Missing token → 4001.
  - Session-id mismatch between path and token claim → 4001.
  - Valid auth + connected envelope → accepted.
  - Binary frames forwarded to the provider stream.
  - Text metadata (websocket:dtmf) is logged at DEBUG and ignored (no crash).
  - Other text events ignored silently.
  - Provider send_audio raises → WS stays open (single bad frame resilience).

HIPAA invariants:
  - Audio bytes never appear in any log output.

Close code reference (routers/vonage_audio.py):
  4001 — JWT missing, bad signature, expired, wrong sub, or session mismatch.
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, patch
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from jose import jwt
from starlette.websockets import WebSocketDisconnect

from app.main import app
from app.utils.security import create_vonage_ws_token, verify_vonage_ws_token

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

WS_CLOSE_AUTH_FAILED = 4001

_BASE_PATH = "/api/v1/sessions/{session_id}/transcript/vonage-stream"

# A distinct secret used ONLY in these tests — never the real app secret.
_TEST_SECRET = "test-vonage-secret-aaaabbbbccccddddeeeeffff11112222"

# Vonage sends this as the first text frame after the handshake.
_CONNECTED_ENVELOPE = json.dumps(
    {
        "event": "websocket:connected",
        "content-type": "audio/l16;rate=16000",
        "uuid": "aaaabbbb-cccc-dddd-eeee-ffff00001111",
    }
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _ws_url(session_id: UUID, token: str | None) -> str:
    base = _BASE_PATH.format(session_id=session_id)
    if token is None:
        return base
    return f"{base}?token={token}"


def _make_vonage_token_with_secret(
    session_id: UUID,
    secret: str,
    ttl_seconds: int = 1800,
    sub: str = "vonage",
    role: str = "chw",
) -> str:
    """Mint a Vonage WS JWT signed with an arbitrary secret (for negative tests).

    Includes a ``role`` claim so the token matches the current schema.  Negative
    tests that need to exercise a missing/bad role can pass an explicit value.
    """
    now = datetime.now(UTC)
    payload = {
        "sub": sub,
        "session_id": str(session_id),
        "role": role,
        "exp": int((now + timedelta(seconds=ttl_seconds)).timestamp()),
        "iat": int(now.timestamp()),
        "jti": uuid.uuid4().hex,
    }
    return jwt.encode(payload, secret, algorithm="HS256")


def _make_expired_vonage_token(session_id: UUID, secret: str) -> str:
    """Mint a Vonage WS JWT that is already expired."""
    now = datetime.now(UTC)
    payload = {
        "sub": "vonage",
        "session_id": str(session_id),
        "exp": int((now - timedelta(seconds=60)).timestamp()),
        "iat": int((now - timedelta(seconds=1860)).timestamp()),
        "jti": uuid.uuid4().hex,
    }
    return jwt.encode(payload, secret, algorithm="HS256")


# ---------------------------------------------------------------------------
# Shared sync TestClient — reused across all WS tests in this module.
# DB fixture (from conftest.py) truncates schema between tests.
# ---------------------------------------------------------------------------

_sync_client = TestClient(app, raise_server_exceptions=False)


# ===========================================================================
# Token helper unit tests
# ===========================================================================


class TestCreateVonageWsToken:
    """Unit tests for create_vonage_ws_token()."""

    def test_roundtrip_chw_role_returns_correct_claims(self):
        """A token created for session_id X with role='chw' must verify back to
        (session_id=X, role='chw').
        """
        session_id = uuid.uuid4()
        with patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "vonage_ws_jwt_secret",
            _TEST_SECRET,
        ):
            token = create_vonage_ws_token(session_id, role="chw", ttl_seconds=300)
            result = verify_vonage_ws_token(token)

        assert result is not None
        returned_session_id, returned_role = result
        assert returned_session_id == session_id
        assert returned_role == "chw"

    def test_roundtrip_member_role_returns_correct_claims(self):
        """A token created with role='member' must verify back to (session_id, 'member')."""
        session_id = uuid.uuid4()
        with patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "vonage_ws_jwt_secret",
            _TEST_SECRET,
        ):
            token = create_vonage_ws_token(session_id, role="member", ttl_seconds=300)
            result = verify_vonage_ws_token(token)

        assert result is not None
        returned_session_id, returned_role = result
        assert returned_session_id == session_id
        assert returned_role == "member"

    def test_default_role_is_chw(self):
        """create_vonage_ws_token with no role arg must default to 'chw'."""
        session_id = uuid.uuid4()
        with patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "vonage_ws_jwt_secret",
            _TEST_SECRET,
        ):
            token = create_vonage_ws_token(session_id)

        decoded = jwt.get_unverified_claims(token)
        assert decoded["role"] == "chw"

    def test_invalid_role_raises_value_error(self):
        """create_vonage_ws_token with an unknown role must raise ValueError."""
        session_id = uuid.uuid4()
        with patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "vonage_ws_jwt_secret",
            _TEST_SECRET,
        ):
            with pytest.raises(ValueError, match="Invalid role"):
                create_vonage_ws_token(session_id, role="admin")

    def test_token_contains_vonage_sub(self):
        """The JWT sub claim must be the literal string 'vonage'."""
        session_id = uuid.uuid4()
        with patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "vonage_ws_jwt_secret",
            _TEST_SECRET,
        ):
            token = create_vonage_ws_token(session_id, role="chw")

        # Decode without verification to inspect the raw claims.
        decoded = jwt.get_unverified_claims(token)
        assert decoded["sub"] == "vonage"

    def test_token_contains_role_claim(self):
        """The JWT must embed the role claim for cryptographic binding."""
        session_id = uuid.uuid4()
        with patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "vonage_ws_jwt_secret",
            _TEST_SECRET,
        ):
            token_chw = create_vonage_ws_token(session_id, role="chw")
            token_member = create_vonage_ws_token(session_id, role="member")

        assert jwt.get_unverified_claims(token_chw)["role"] == "chw"
        assert jwt.get_unverified_claims(token_member)["role"] == "member"

    def test_token_contains_jti_nonce(self):
        """Every issued token must carry a unique jti claim."""
        session_id = uuid.uuid4()
        with patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "vonage_ws_jwt_secret",
            _TEST_SECRET,
        ):
            token_a = create_vonage_ws_token(session_id, role="chw")
            token_b = create_vonage_ws_token(session_id, role="chw")

        claims_a = jwt.get_unverified_claims(token_a)
        claims_b = jwt.get_unverified_claims(token_b)
        assert claims_a["jti"] != claims_b["jti"]

    def test_missing_secret_raises_runtime_error(self):
        """create_vonage_ws_token must raise RuntimeError when the secret is not set."""
        session_id = uuid.uuid4()
        with patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "vonage_ws_jwt_secret",
            "",
        ):
            with pytest.raises(RuntimeError, match="VONAGE_WS_JWT_SECRET"):
                create_vonage_ws_token(session_id, role="chw")


class TestVerifyVonageWsToken:
    """Unit tests for verify_vonage_ws_token().

    verify_vonage_ws_token now returns (session_id, role) on success, or None.
    All negative paths still return None; callers destructure the tuple only
    after confirming the result is not None.
    """

    def test_wrong_secret_is_rejected(self):
        """A token signed with a different secret must not verify."""
        session_id = uuid.uuid4()
        bad_token = _make_vonage_token_with_secret(session_id, secret="wrong-secret-xyz")

        with patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "vonage_ws_jwt_secret",
            _TEST_SECRET,
        ):
            result = verify_vonage_ws_token(bad_token)

        assert result is None

    def test_expired_token_is_rejected(self):
        """An expired token (exp in the past) must not verify."""
        session_id = uuid.uuid4()
        expired_token = _make_expired_vonage_token(session_id, secret=_TEST_SECRET)

        with patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "vonage_ws_jwt_secret",
            _TEST_SECRET,
        ):
            result = verify_vonage_ws_token(expired_token)

        assert result is None

    def test_non_vonage_sub_is_rejected(self):
        """A token with sub != 'vonage' must not verify even if signature is valid."""
        session_id = uuid.uuid4()
        # Use a user-access-token style sub.
        impersonation_token = _make_vonage_token_with_secret(
            session_id, secret=_TEST_SECRET, sub=str(uuid.uuid4())
        )

        with patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "vonage_ws_jwt_secret",
            _TEST_SECRET,
        ):
            result = verify_vonage_ws_token(impersonation_token)

        assert result is None

    def test_garbage_token_returns_none(self):
        """A non-JWT string must return None without raising."""
        with patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "vonage_ws_jwt_secret",
            _TEST_SECRET,
        ):
            result = verify_vonage_ws_token("this-is-not-a-jwt")

        assert result is None

    def test_missing_secret_returns_none(self):
        """verify_vonage_ws_token must return None (not raise) when the secret is empty."""
        session_id = uuid.uuid4()
        token = _make_vonage_token_with_secret(session_id, secret=_TEST_SECRET)

        with patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "vonage_ws_jwt_secret",
            "",
        ):
            result = verify_vonage_ws_token(token)

        assert result is None

    def test_empty_string_token_returns_none(self):
        """An empty token string must return None without raising."""
        with patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "vonage_ws_jwt_secret",
            _TEST_SECRET,
        ):
            result = verify_vonage_ws_token("")

        assert result is None

    def test_valid_token_returns_tuple_with_session_id_and_role(self):
        """A fully valid token must return a (UUID, str) tuple — not a bare UUID."""
        session_id = uuid.uuid4()
        with patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "vonage_ws_jwt_secret",
            _TEST_SECRET,
        ):
            token = create_vonage_ws_token(session_id, role="member")
            result = verify_vonage_ws_token(token)

        assert result is not None
        assert isinstance(result, tuple)
        assert len(result) == 2
        returned_session_id, returned_role = result
        assert returned_session_id == session_id
        assert returned_role == "member"

    def test_legacy_token_without_role_defaults_to_chw(self):
        """A token without a 'role' claim (pre-migration) must default to 'chw'."""
        session_id = uuid.uuid4()
        # Mint a legacy-style token without the role field.
        now = datetime.now(UTC)
        legacy_payload = {
            "sub": "vonage",
            "session_id": str(session_id),
            "exp": int((now + timedelta(seconds=300)).timestamp()),
            "iat": int(now.timestamp()),
            "jti": uuid.uuid4().hex,
            # Deliberately omit "role".
        }
        legacy_token = jwt.encode(legacy_payload, _TEST_SECRET, algorithm="HS256")

        with patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "vonage_ws_jwt_secret",
            _TEST_SECRET,
        ):
            result = verify_vonage_ws_token(legacy_token)

        assert result is not None
        returned_session_id, returned_role = result
        assert returned_session_id == session_id
        assert returned_role == "chw", "Legacy tokens without role must default to 'chw'"

    def test_unknown_role_in_token_is_rejected(self):
        """A token with an unrecognised role claim must return None."""
        session_id = uuid.uuid4()
        now = datetime.now(UTC)
        bad_role_payload = {
            "sub": "vonage",
            "session_id": str(session_id),
            "role": "superuser",  # not a valid role
            "exp": int((now + timedelta(seconds=300)).timestamp()),
            "iat": int(now.timestamp()),
            "jti": uuid.uuid4().hex,
        }
        bad_role_token = jwt.encode(bad_role_payload, _TEST_SECRET, algorithm="HS256")

        with patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "vonage_ws_jwt_secret",
            _TEST_SECRET,
        ):
            result = verify_vonage_ws_token(bad_role_token)

        assert result is None, "Tokens with unknown roles must be rejected"


# ===========================================================================
# WebSocket integration tests
# ===========================================================================


class TestVonageWsAuthEnforcement:
    """WebSocket auth checks — run before the handshake is accepted.

    A regression here means unauthenticated access to the audio pipeline.
    """

    def test_missing_token_is_rejected_with_4001(self):
        """Connecting without ?token= must be closed with code 4001."""
        session_id = uuid.uuid4()
        url = _ws_url(session_id, token=None)
        with patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "vonage_ws_jwt_secret",
            _TEST_SECRET,
        ):
            try:
                with _sync_client.websocket_connect(url) as ws:
                    ws.receive_text()
            except WebSocketDisconnect as exc:
                assert exc.code == WS_CLOSE_AUTH_FAILED

    def test_garbage_token_is_rejected_with_4001(self):
        """A malformed token string must close with 4001."""
        session_id = uuid.uuid4()
        url = _ws_url(session_id, token="not-a-jwt-at-all")
        with patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "vonage_ws_jwt_secret",
            _TEST_SECRET,
        ):
            try:
                with _sync_client.websocket_connect(url) as ws:
                    ws.receive_text()
            except WebSocketDisconnect as exc:
                assert exc.code == WS_CLOSE_AUTH_FAILED

    def test_wrong_secret_token_is_rejected_with_4001(self):
        """A token signed with a different secret must close with 4001."""
        session_id = uuid.uuid4()
        bad_token = _make_vonage_token_with_secret(session_id, secret="wrong-secret")
        url = _ws_url(session_id, token=bad_token)
        with patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "vonage_ws_jwt_secret",
            _TEST_SECRET,
        ):
            try:
                with _sync_client.websocket_connect(url) as ws:
                    ws.receive_text()
            except WebSocketDisconnect as exc:
                assert exc.code == WS_CLOSE_AUTH_FAILED

    def test_session_id_mismatch_is_rejected_with_4001(self):
        """A token bound to session A presented against session B's path → 4001.

        This is the replay-attack guard: even a valid token cannot be used for
        a different session than the one it was issued for.
        """
        session_a = uuid.uuid4()
        session_b = uuid.uuid4()
        # Token is valid and correctly signed — but for session_a.
        token_for_a = _make_vonage_token_with_secret(session_a, secret=_TEST_SECRET)
        # Present it against session_b's path.
        url = _ws_url(session_b, token=token_for_a)
        with patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "vonage_ws_jwt_secret",
            _TEST_SECRET,
        ):
            try:
                with _sync_client.websocket_connect(url) as ws:
                    ws.receive_text()
            except WebSocketDisconnect as exc:
                assert exc.code == WS_CLOSE_AUTH_FAILED

    def test_expired_token_is_rejected_with_4001(self):
        """An expired token must close with 4001."""
        session_id = uuid.uuid4()
        expired_token = _make_expired_vonage_token(session_id, secret=_TEST_SECRET)
        url = _ws_url(session_id, token=expired_token)
        with patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "vonage_ws_jwt_secret",
            _TEST_SECRET,
        ):
            try:
                with _sync_client.websocket_connect(url) as ws:
                    ws.receive_text()
            except WebSocketDisconnect as exc:
                assert exc.code == WS_CLOSE_AUTH_FAILED

    def test_non_vonage_sub_is_rejected_with_4001(self):
        """A token with sub != 'vonage' (e.g., a user access token) must be rejected."""
        session_id = uuid.uuid4()
        # Mint a token that looks like a user access JWT.
        user_like_token = _make_vonage_token_with_secret(
            session_id, secret=_TEST_SECRET, sub=str(uuid.uuid4())
        )
        url = _ws_url(session_id, token=user_like_token)
        with patch.object(
            __import__("app.config", fromlist=["settings"]).settings,
            "vonage_ws_jwt_secret",
            _TEST_SECRET,
        ):
            try:
                with _sync_client.websocket_connect(url) as ws:
                    ws.receive_text()
            except WebSocketDisconnect as exc:
                assert exc.code == WS_CLOSE_AUTH_FAILED


class TestVonageWsAudioForwarding:
    """Functional tests for the per-leg audio pipeline path.

    We patch ``transcript_hub.get_or_create_provider_stream`` to inject a
    mock provider so we never touch a real AssemblyAI connection in tests.

    get_or_create_provider_stream now takes (session_id, role) — mocks must
    accept and optionally inspect both arguments.
    """

    def _make_valid_token(self, session_id: UUID, role: str = "chw") -> str:
        return _make_vonage_token_with_secret(session_id, secret=_TEST_SECRET, role=role)

    def test_valid_connection_is_accepted(self):
        """A valid token must result in a successful WebSocket handshake.

        We verify this by sending the connected envelope and then closing
        cleanly — if the server had rejected auth the context manager would
        raise before we could send.
        """
        session_id = uuid.uuid4()
        token = self._make_valid_token(session_id, role="chw")
        url = _ws_url(session_id, token=token)

        mock_provider = AsyncMock()

        with (
            patch.object(
                __import__("app.config", fromlist=["settings"]).settings,
                "vonage_ws_jwt_secret",
                _TEST_SECRET,
            ),
            patch(
                "app.routers.vonage_audio.transcript_hub.get_or_create_provider_stream",
                new_callable=AsyncMock,
                return_value=mock_provider,
            ),
        ):
            with _sync_client.websocket_connect(url) as ws:
                ws.send_text(_CONNECTED_ENVELOPE)
                # Server accepted — connection is live.  Close cleanly.

    def test_chw_role_token_routes_to_chw_provider_stream(self):
        """A token with role='chw' must call get_or_create_provider_stream with role='chw'."""
        session_id = uuid.uuid4()
        token = self._make_valid_token(session_id, role="chw")
        url = _ws_url(session_id, token=token)

        received_roles: list[str] = []

        class _RoleCapturingProvider:
            async def send_audio(self, chunk: bytes) -> None:
                pass

        async def _mock_get_or_create(sid: UUID, role: str) -> _RoleCapturingProvider:
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

        assert received_roles == ["chw"], (
            f"Expected get_or_create_provider_stream called with role='chw', got: {received_roles}"
        )

    def test_member_role_token_routes_to_member_provider_stream(self):
        """A token with role='member' must call get_or_create_provider_stream with role='member'."""
        session_id = uuid.uuid4()
        token = self._make_valid_token(session_id, role="member")
        url = _ws_url(session_id, token=token)

        received_roles: list[str] = []

        class _RoleCapturingProvider:
            async def send_audio(self, chunk: bytes) -> None:
                pass

        async def _mock_get_or_create(sid: UUID, role: str) -> _RoleCapturingProvider:
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

        assert received_roles == ["member"], (
            f"Expected get_or_create_provider_stream called with role='member', got: {received_roles}"
        )

    def test_binary_frames_are_forwarded_to_provider(self):
        """Binary PCM frames sent by Vonage must be forwarded to provider.send_audio()."""
        session_id = uuid.uuid4()
        token = self._make_valid_token(session_id, role="chw")
        url = _ws_url(session_id, token=token)

        # A realistic 250 ms chunk: 16000 Hz × 0.25 s × 2 bytes/sample = 8000 bytes.
        audio_chunk = bytes(8000)

        forwarded_chunks: list[bytes] = []

        class _CapturingProvider:
            async def send_audio(self, chunk: bytes) -> None:
                forwarded_chunks.append(chunk)

        with (
            patch.object(
                __import__("app.config", fromlist=["settings"]).settings,
                "vonage_ws_jwt_secret",
                _TEST_SECRET,
            ),
            patch(
                "app.routers.vonage_audio.transcript_hub.get_or_create_provider_stream",
                return_value=_CapturingProvider(),
            ),
        ):
            with _sync_client.websocket_connect(url) as ws:
                ws.send_text(_CONNECTED_ENVELOPE)
                ws.send_bytes(audio_chunk)
                ws.send_bytes(audio_chunk)
                # Allow the loop to process both frames before closing.

        assert len(forwarded_chunks) == 2, (
            f"Expected 2 forwarded chunks, got {len(forwarded_chunks)}"
        )
        assert forwarded_chunks[0] == audio_chunk
        assert forwarded_chunks[1] == audio_chunk

    def test_dtmf_text_event_is_ignored_without_crash(self, caplog):
        """Receiving a websocket:dtmf text event must not crash the WS loop."""
        session_id = uuid.uuid4()
        token = self._make_valid_token(session_id, role="chw")
        url = _ws_url(session_id, token=token)

        dtmf_event = json.dumps({"event": "websocket:dtmf", "digit": "5", "duration": 150})

        forwarded_chunks: list[bytes] = []

        class _CapturingProvider:
            async def send_audio(self, chunk: bytes) -> None:
                forwarded_chunks.append(chunk)

        with (
            patch.object(
                __import__("app.config", fromlist=["settings"]).settings,
                "vonage_ws_jwt_secret",
                _TEST_SECRET,
            ),
            patch(
                "app.routers.vonage_audio.transcript_hub.get_or_create_provider_stream",
                return_value=_CapturingProvider(),
            ),
            caplog.at_level(logging.DEBUG, logger="compass.transcript.vonage"),
        ):
            with _sync_client.websocket_connect(url) as ws:
                ws.send_text(_CONNECTED_ENVELOPE)
                ws.send_text(dtmf_event)
                # Still alive after the DTMF event — send an audio chunk to prove it.
                ws.send_bytes(bytes(100))

        # At least one audio chunk must have been forwarded (proving WS stayed open).
        assert len(forwarded_chunks) == 1

    def test_unknown_text_event_is_silently_ignored(self):
        """An unknown text event type must not crash the loop."""
        session_id = uuid.uuid4()
        token = self._make_valid_token(session_id, role="chw")
        url = _ws_url(session_id, token=token)

        unknown_event = json.dumps({"event": "websocket:unknown-future-event", "data": "x"})

        forwarded_chunks: list[bytes] = []

        class _CapturingProvider:
            async def send_audio(self, chunk: bytes) -> None:
                forwarded_chunks.append(chunk)

        with (
            patch.object(
                __import__("app.config", fromlist=["settings"]).settings,
                "vonage_ws_jwt_secret",
                _TEST_SECRET,
            ),
            patch(
                "app.routers.vonage_audio.transcript_hub.get_or_create_provider_stream",
                return_value=_CapturingProvider(),
            ),
        ):
            with _sync_client.websocket_connect(url) as ws:
                ws.send_text(_CONNECTED_ENVELOPE)
                ws.send_text(unknown_event)
                ws.send_bytes(bytes(50))

        assert len(forwarded_chunks) == 1

    def test_provider_error_does_not_kill_websocket(self):
        """A provider.send_audio() exception must not terminate the WebSocket.

        The next audio frame must still be forwarded (proving the loop continues).
        """
        session_id = uuid.uuid4()
        token = self._make_valid_token(session_id, role="chw")
        url = _ws_url(session_id, token=token)

        call_count = 0

        class _FlakyProvider:
            async def send_audio(self, chunk: bytes) -> None:
                nonlocal call_count
                call_count += 1
                if call_count == 1:
                    # First call raises — simulates a transient provider error.
                    raise RuntimeError("transient provider failure")
                # Second and subsequent calls succeed.

        with (
            patch.object(
                __import__("app.config", fromlist=["settings"]).settings,
                "vonage_ws_jwt_secret",
                _TEST_SECRET,
            ),
            patch(
                "app.routers.vonage_audio.transcript_hub.get_or_create_provider_stream",
                return_value=_FlakyProvider(),
            ),
        ):
            with _sync_client.websocket_connect(url) as ws:
                ws.send_text(_CONNECTED_ENVELOPE)
                ws.send_bytes(bytes(100))  # First chunk → provider raises
                ws.send_bytes(bytes(100))  # Second chunk → provider succeeds

        # The provider was called twice — the WS loop survived the first error.
        assert call_count == 2, (
            f"Expected provider to be called twice (first raises, second succeeds), "
            f"got call_count={call_count}"
        )


class TestVonageWsHipaaLogging:
    """HIPAA invariant: audio bytes must never appear in log output."""

    def test_audio_bytes_do_not_appear_in_logs(self, caplog):
        """Binary audio frames must never be logged at any level.

        We use a recognisable sentinel byte sequence and assert it is absent
        from every log record emitted during the WebSocket session.
        """
        session_id = uuid.uuid4()
        token = _make_vonage_token_with_secret(session_id, secret=_TEST_SECRET, role="chw")
        url = _ws_url(session_id, token=token)

        # Sentinel: a known bytes pattern that would stand out in logs if encoded.
        sentinel_chunk = b"\xDE\xAD\xBE\xEF" * 100

        class _NoOpProvider:
            async def send_audio(self, chunk: bytes) -> None:
                pass  # Discard — we only care about logs

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
            caplog.at_level(logging.DEBUG, logger="compass.transcript.vonage"),
        ):
            with _sync_client.websocket_connect(url) as ws:
                ws.send_text(_CONNECTED_ENVELOPE)
                ws.send_bytes(sentinel_chunk)

        # Encode sentinel as hex and repr for log-scanning.
        sentinel_hex = sentinel_chunk.hex()
        sentinel_repr = repr(sentinel_chunk)

        for record in caplog.records:
            message = record.getMessage()
            assert sentinel_hex not in message, (
                "HIPAA violation: audio bytes (hex) found in log record"
            )
            assert sentinel_repr not in message, (
                "HIPAA violation: audio bytes (repr) found in log record"
            )

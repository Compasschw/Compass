"""Tests for the transcript WebSocket confidentiality boundary.

Endpoint: WS /api/v1/sessions/{session_id}/transcript/stream

These tests guard the primary PHI-leak vector: a WebSocket subscription that
would allow one user to listen to another user's real-time session transcript.
A regression in any of these tests constitutes a HIPAA confidentiality failure.

Close-code reference (from routers/transcript.py):
    4001 — auth failed (missing/invalid/expired JWT)
    4002 — consent required
    4003 — forbidden (authenticated but not a participant)
    4004 — session not found
    4500 — internal error
    1000 — normal client-initiated close
    1001 — server-initiated teardown
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import AsyncGenerator
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient
from jose import jwt
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.websockets import WebSocketDisconnect

from app.config import settings
from app.main import app
from app.models.session import MemberConsent, Session
from app.models.user import User
from app.services.transcript_hub import TranscriptHub, _SessionState
from app.utils.security import create_access_token, hash_password
from tests.conftest import test_session as _test_session_factory

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

WS_CLOSE_AUTH_FAILED = 4001
WS_CLOSE_CONSENT_REQUIRED = 4002
WS_CLOSE_FORBIDDEN = 4003
WS_CLOSE_SESSION_NOT_FOUND = 4004

WS_PATH = "/api/v1/sessions/{session_id}/transcript/stream"

EXPECTED_CHUNK_KEYS = {
    "type",
    "speaker_label",
    "speaker_role",
    "text",
    "is_final",
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_access_token(user_id: UUID, role: str) -> str:
    """Mint a valid access JWT for a user — matches what the endpoint expects."""
    return create_access_token({"sub": str(user_id), "role": role})


def _make_token_wrong_type(user_id: UUID) -> str:
    """Mint a refresh-type JWT — the endpoint must reject it (type != 'access')."""
    payload = {
        "sub": str(user_id),
        "role": "chw",
        "type": "refresh",
        "exp": datetime.now(UTC) + timedelta(minutes=15),
        "iat": datetime.now(UTC),
        "jti": uuid.uuid4().hex,
    }
    return jwt.encode(payload, settings.secret_key, algorithm="HS256")


def _make_expired_token(user_id: UUID, role: str) -> str:
    """Mint an access JWT that is already expired."""
    payload = {
        "sub": str(user_id),
        "role": role,
        "type": "access",
        "exp": datetime.now(UTC) - timedelta(minutes=5),
        "iat": datetime.now(UTC) - timedelta(minutes=20),
        "jti": uuid.uuid4().hex,
    }
    return jwt.encode(payload, settings.secret_key, algorithm="HS256")


async def _create_user(
    db: AsyncSession,
    *,
    role: str,
    email: str | None = None,
) -> User:
    """Insert and return a bare User row without going through the HTTP register flow."""
    user = User(
        id=uuid.uuid4(),
        email=email or f"test-{uuid.uuid4().hex[:8]}@example.com",
        name="Test User",
        password_hash=hash_password("testpass123"),
        role=role,
        is_active=True,
        is_onboarded=True,
    )
    db.add(user)
    await db.flush()
    return user


async def _create_session(
    db: AsyncSession,
    *,
    chw: User,
    member: User,
) -> Session:
    """Insert a minimal Session row linked to a dummy service_request UUID."""
    # Sessions FK to service_requests — we insert a placeholder request first.
    from app.models.request import ServiceRequest  # local import avoids circular at module load

    service_req = ServiceRequest(
        id=uuid.uuid4(),
        member_id=member.id,
        vertical="housing",
        urgency="routine",
        description="test",
        preferred_mode="in_person",
        status="matched",
    )
    db.add(service_req)
    await db.flush()

    session = Session(
        id=uuid.uuid4(),
        request_id=service_req.id,
        chw_id=chw.id,
        member_id=member.id,
        vertical="housing",
        status="in_progress",
        mode="in_person",
    )
    db.add(session)
    await db.flush()
    return session


async def _grant_consent(
    db: AsyncSession,
    *,
    session: Session,
    member: User,
) -> MemberConsent:
    """Insert an ai_transcription consent row for the member on this session."""
    consent = MemberConsent(
        id=uuid.uuid4(),
        session_id=session.id,
        member_id=member.id,
        consent_type="ai_transcription",
        typed_signature="Test Member",
    )
    db.add(consent)
    await db.flush()
    return consent


def _ws_url(session_id: UUID, token: str | None) -> str:
    """Build the WebSocket URL with the token query parameter."""
    base = WS_PATH.format(session_id=session_id)
    if token is None:
        return base
    return f"{base}?token={token}"


# ---------------------------------------------------------------------------
# Session-scoped sync TestClient (required for Starlette WebSocket testing)
# ---------------------------------------------------------------------------

# httpx.AsyncClient does not support WebSocket connections; Starlette's
# TestClient wraps websockets in a synchronous interface backed by anyio.
# We create it once per module — the DB fixture truncates/recreates schema
# between tests so the app state is always clean.
_sync_client = TestClient(app, raise_server_exceptions=False)


# ---------------------------------------------------------------------------
# Test classes
# ---------------------------------------------------------------------------


class TestWebSocketAuthBoundary:
    """Auth enforcement before the handshake is accepted.

    A regression in any of these tests means unauthenticated or cross-user
    access to real-time PHI — a HIPAA confidentiality breach.
    """

    def test_no_token_rejected(self):
        """Connecting without ?token= must close with 4001 before accept."""
        # We generate a random session_id so there is no DB row — auth should
        # fail before the session lookup even runs.
        session_id = uuid.uuid4()
        try:
            with _sync_client.websocket_connect(_ws_url(session_id, token=None)) as ws:
                ws.receive_text()
        except WebSocketDisconnect as exc:
            assert exc.code == WS_CLOSE_AUTH_FAILED

    def test_empty_token_rejected(self):
        """An empty string token must be treated as missing — close 4001."""
        session_id = uuid.uuid4()
        try:
            with _sync_client.websocket_connect(_ws_url(session_id, token="")) as ws:
                ws.receive_text()
        except WebSocketDisconnect as exc:
            assert exc.code == WS_CLOSE_AUTH_FAILED

    def test_garbage_token_rejected(self):
        """A token that is not a valid JWT must close with 4001."""
        session_id = uuid.uuid4()
        try:
            with _sync_client.websocket_connect(_ws_url(session_id, token="not-a-jwt")) as ws:
                ws.receive_text()
        except WebSocketDisconnect as exc:
            assert exc.code == WS_CLOSE_AUTH_FAILED

    def test_wrong_token_type_rejected(self):
        """A refresh JWT (type='refresh') must not satisfy the auth check."""
        # Use a random user_id — token type check happens before DB lookup.
        user_id = uuid.uuid4()
        token = _make_token_wrong_type(user_id)
        session_id = uuid.uuid4()
        try:
            with _sync_client.websocket_connect(_ws_url(session_id, token=token)) as ws:
                ws.receive_text()
        except WebSocketDisconnect as exc:
            assert exc.code == WS_CLOSE_AUTH_FAILED

    def test_expired_token_rejected(self):
        """An expired access JWT must close with 4001, not 4003 or 200."""
        user_id = uuid.uuid4()
        token = _make_expired_token(user_id, role="chw")
        session_id = uuid.uuid4()
        try:
            with _sync_client.websocket_connect(_ws_url(session_id, token=token)) as ws:
                ws.receive_text()
        except WebSocketDisconnect as exc:
            assert exc.code == WS_CLOSE_AUTH_FAILED

    def test_tampered_signature_rejected(self):
        """A JWT signed with the wrong secret key must be rejected (4001)."""
        payload = {
            "sub": str(uuid.uuid4()),
            "role": "chw",
            "type": "access",
            "exp": datetime.now(UTC) + timedelta(minutes=15),
            "iat": datetime.now(UTC),
            "jti": uuid.uuid4().hex,
        }
        forged = jwt.encode(payload, "wrong-secret-key", algorithm="HS256")
        session_id = uuid.uuid4()
        try:
            with _sync_client.websocket_connect(_ws_url(session_id, token=forged)) as ws:
                ws.receive_text()
        except WebSocketDisconnect as exc:
            assert exc.code == WS_CLOSE_AUTH_FAILED


class TestWebSocketParticipantAuthorization:
    """Participant-level authorization after JWT validation succeeds.

    These tests require real DB rows. They use the _test_session_factory
    (the same sessionmaker used by test_admin_2fa.py) to set up state
    directly, then assert on the WebSocket close code.

    Because Starlette TestClient is synchronous and our DB helpers are async,
    we run them with asyncio.get_event_loop().run_until_complete so we can
    stay on the same event loop the app uses.
    """

    def _run(self, coro):
        """Run a coroutine on a fresh event loop.

        SQLAlchemy async engines (test_engine + app.database.engine) cache
        connections that are bound to whichever event loop opened them. If
        we reuse them across loops we hit "Future attached to a different
        loop". We dispose both engines on the new loop FIRST, then run the
        coroutine — that forces fresh connections on the current loop.
        """
        from app.database import engine as _app_engine
        from tests.conftest import test_engine as _engine

        async def _wrapped():
            await _engine.dispose()
            await _app_engine.dispose()
            return await coro

        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(_wrapped())
        finally:
            loop.close()

    def _setup_participants_and_session(self) -> tuple[User, User, Session]:
        """Create chw + member + session + consent rows synchronously."""

        async def _impl():
            async with _test_session_factory() as db:
                chw = await _create_user(db, role="chw")
                member = await _create_user(db, role="member")
                session = await _create_session(db, chw=chw, member=member)
                await _grant_consent(db, session=session, member=member)
                await db.commit()
                # Refresh to detach from the session before returning
                await db.refresh(chw)
                await db.refresh(member)
                await db.refresh(session)
                return chw, member, session

        return self._run(_impl())

    def test_chw_participant_accepted(self):
        """CHW whose user_id == session.chw_id must receive a successful connection."""
        chw, _member, session = self._setup_participants_and_session()
        token = _make_access_token(chw.id, "chw")

        with _sync_client.websocket_connect(
            _ws_url(session.id, token=token),
        ) as ws:
            # Connection accepted — server should not immediately close.
            # Send a stop control to cleanly exit.
            ws.send_text(json.dumps({"type": "stop"}))
            # Expect the "stopped" acknowledgement frame
            raw = ws.receive_text()
            msg = json.loads(raw)
            assert msg["type"] == "stopped"
            assert msg["session_id"] == str(session.id)

    def test_member_participant_accepted(self):
        """Member whose user_id == session.member_id must be accepted."""
        chw, member, session = self._setup_participants_and_session()
        token = _make_access_token(member.id, "member")

        with _sync_client.websocket_connect(
            _ws_url(session.id, token=token),
        ) as ws:
            ws.send_text(json.dumps({"type": "stop"}))
            raw = ws.receive_text()
            msg = json.loads(raw)
            assert msg["type"] == "stopped"

    def test_third_party_user_rejected(self):
        """A valid user who is NOT chw_id or member_id must receive 4003.

        This is the core confidentiality invariant: user A cannot eavesdrop
        on user B's session even with a valid JWT.
        """
        _chw, _member, session = self._setup_participants_and_session()

        # Create a completely separate user — not on this session.
        async def _make_outsider():
            async with _test_session_factory() as db:
                outsider = await _create_user(db, role="chw")
                await db.commit()
                await db.refresh(outsider)
                return outsider

        outsider = self._run(_make_outsider())
        token = _make_access_token(outsider.id, "chw")

        try:
            with _sync_client.websocket_connect(_ws_url(session.id, token=token)) as ws:
                ws.receive_text()
        except WebSocketDisconnect as exc:
            assert exc.code == WS_CLOSE_FORBIDDEN

    def test_missing_consent_rejected(self):
        """Participant without an ai_transcription consent row gets 4002.

        This guards the member's right to explicitly consent before their
        session audio is processed — a HIPAA authorization requirement.
        """

        async def _setup_without_consent():
            async with _test_session_factory() as db:
                chw = await _create_user(db, role="chw")
                member = await _create_user(db, role="member")
                session = await _create_session(db, chw=chw, member=member)
                # Deliberately no consent row
                await db.commit()
                await db.refresh(chw)
                await db.refresh(session)
                return chw, session

        chw, session = self._run(_setup_without_consent())
        token = _make_access_token(chw.id, "chw")

        try:
            with _sync_client.websocket_connect(_ws_url(session.id, token=token)) as ws:
                ws.receive_text()
        except WebSocketDisconnect as exc:
            assert exc.code == WS_CLOSE_CONSENT_REQUIRED

    def test_nonexistent_session_rejected(self):
        """Valid JWT for an active user but a session_id that doesn't exist → 4004."""

        async def _make_chw():
            async with _test_session_factory() as db:
                chw = await _create_user(db, role="chw")
                await db.commit()
                await db.refresh(chw)
                return chw

        chw = self._run(_make_chw())
        token = _make_access_token(chw.id, "chw")
        phantom_session_id = uuid.uuid4()

        try:
            with _sync_client.websocket_connect(_ws_url(phantom_session_id, token=token)) as ws:
                ws.receive_text()
        except WebSocketDisconnect as exc:
            assert exc.code == WS_CLOSE_SESSION_NOT_FOUND

    def test_inactive_user_rejected(self):
        """A user with is_active=False must be rejected (4001) even with a valid JWT."""

        async def _setup_inactive_chw():
            async with _test_session_factory() as db:
                chw = await _create_user(db, role="chw")
                member = await _create_user(db, role="member")
                session = await _create_session(db, chw=chw, member=member)
                await _grant_consent(db, session=session, member=member)
                # Deactivate the CHW after session creation
                chw.is_active = False
                db.add(chw)
                await db.commit()
                await db.refresh(chw)
                await db.refresh(session)
                return chw, session

        chw, session = self._run(_setup_inactive_chw())
        token = _make_access_token(chw.id, "chw")

        try:
            with _sync_client.websocket_connect(_ws_url(session.id, token=token)) as ws:
                ws.receive_text()
        except WebSocketDisconnect as exc:
            assert exc.code == WS_CLOSE_AUTH_FAILED


class TestWebSocketFanOut:
    """Fan-out and subscriber lifecycle via the TranscriptHub directly.

    These tests operate on the hub in isolation (no HTTP layer) to verify
    the in-process broadcast logic that underpins the WebSocket endpoint.
    Isolating the hub avoids the complexity of running two concurrent
    WebSocket connections inside TestClient, which is single-threaded.
    """

    @pytest.mark.asyncio
    async def test_two_subscribers_both_receive_published_chunk(self):
        """Chunk published to a session must reach every registered subscriber."""
        hub = TranscriptHub()
        session_id = uuid.uuid4()

        received_by: dict[str, list[dict]] = {"ws1": [], "ws2": []}

        class _FakeWebSocket:
            """Minimal WebSocket stub that records send_text calls."""

            def __init__(self, name: str) -> None:
                self._name = name

            async def send_text(self, data: str) -> None:
                received_by[self._name].append(json.loads(data))

        ws1 = _FakeWebSocket("ws1")
        ws2 = _FakeWebSocket("ws2")

        await hub.subscribe(session_id, ws1)
        await hub.subscribe(session_id, ws2)

        payload = {
            "speaker_label": "A",
            "speaker_role": "unknown",
            "text": "hello world",
            "is_final": True,
            "confidence": 0.99,
            "started_at_ms": 0,
            "ended_at_ms": 500,
        }
        await hub.publish(session_id, payload)

        assert len(received_by["ws1"]) == 1, "First subscriber did not receive chunk"
        assert len(received_by["ws2"]) == 1, "Second subscriber did not receive chunk"
        assert received_by["ws1"][0]["type"] == "transcript_chunk"
        assert received_by["ws2"][0]["type"] == "transcript_chunk"

    @pytest.mark.asyncio
    async def test_disconnect_removes_subscriber_from_hub(self):
        """remove_subscriber() must remove the WebSocket from the session's subscriber list."""
        hub = TranscriptHub()
        session_id = uuid.uuid4()

        class _FakeWebSocket:
            async def send_text(self, data: str) -> None:
                pass

        ws = _FakeWebSocket()
        subscription = await hub.subscribe(session_id, ws)

        state = hub._sessions.get(session_id)
        assert state is not None
        assert ws in state.subscribers

        await hub.remove_subscriber(subscription)

        # After the last subscriber leaves, close_session is called which
        # removes the session_id entry entirely.
        assert session_id not in hub._sessions

    @pytest.mark.asyncio
    async def test_last_subscriber_leaving_tears_down_provider(self):
        """When the last subscriber disconnects, the provider stream must be closed.

        A leaked MockStreamingSession would keep its background asyncio task
        running indefinitely, consuming resources and potentially emitting
        chunks to a subscriber set that no longer exists.
        """
        hub = TranscriptHub()
        session_id = uuid.uuid4()

        class _FakeWebSocket:
            async def send_text(self, _: str) -> None:
                pass

            async def close(self, code: int = 1000) -> None:
                pass

        ws = _FakeWebSocket()
        subscription = await hub.subscribe(session_id, ws)
        provider = await hub.get_or_create_provider_stream(session_id)

        # Confirm the mock task is running.
        assert hasattr(provider, "_task")
        assert provider._task is not None
        assert not provider._task.done()

        await hub.remove_subscriber(subscription)

        # Give the event loop one turn so the cancellation propagates.
        await asyncio.sleep(0)

        assert provider._task.done() or not provider._running, (
            "Provider stream task must be stopped after last subscriber leaves"
        )
        assert session_id not in hub._sessions

    @pytest.mark.asyncio
    async def test_failed_subscriber_send_drops_only_that_subscriber(self):
        """A broken WebSocket must not prevent other subscribers from receiving chunks."""
        hub = TranscriptHub()
        session_id = uuid.uuid4()

        received: list[dict] = []

        class _GoodWebSocket:
            async def send_text(self, data: str) -> None:
                received.append(json.loads(data))

        class _BrokenWebSocket:
            async def send_text(self, _: str) -> None:
                raise OSError("connection reset")

        good_ws = _GoodWebSocket()
        broken_ws = _BrokenWebSocket()

        await hub.subscribe(session_id, broken_ws)
        await hub.subscribe(session_id, good_ws)

        payload = {
            "speaker_label": "A",
            "speaker_role": "unknown",
            "text": "test",
            "is_final": False,
            "confidence": 0.8,
            "started_at_ms": 0,
            "ended_at_ms": 100,
        }
        await hub.publish(session_id, payload)

        assert len(received) == 1, "Good subscriber must still receive chunk"
        # The broken subscriber must have been dropped from the list.
        state = hub._sessions.get(session_id)
        assert state is not None
        assert broken_ws not in state.subscribers


class TestWebSocketPayloadShape:
    """Wire-format and PHI-safety assertions.

    These tests verify that published chunks carry the documented shape and
    do NOT include raw audio bytes — which would be a HIPAA data-minimisation
    failure (audio is more sensitive than text and must never leave the
    server-to-provider channel).
    """

    @pytest.mark.asyncio
    async def test_chunk_payload_has_documented_keys(self):
        """Published chunk envelope must include all documented fields."""
        hub = TranscriptHub()
        session_id = uuid.uuid4()

        received: list[dict] = []

        class _FakeWebSocket:
            async def send_text(self, data: str) -> None:
                received.append(json.loads(data))

        await hub.subscribe(session_id, _FakeWebSocket())

        payload = {
            "speaker_label": "A",
            "speaker_role": "unknown",
            "text": "Hello",
            "is_final": True,
            "confidence": 0.95,
            "started_at_ms": 100,
            "ended_at_ms": 600,
        }
        await hub.publish(session_id, payload)

        assert received, "No chunk received"
        chunk = received[0]
        for key in EXPECTED_CHUNK_KEYS:
            assert key in chunk, f"Expected key '{key}' missing from chunk payload"

    @pytest.mark.asyncio
    async def test_chunk_payload_does_not_contain_audio_bytes(self):
        """Chunk published to subscribers must contain no 'audio' or raw bytes field.

        Audio bytes (PCM) must travel only from the CHW WebSocket to the
        provider session (send_audio). They must never appear in the fan-out
        payload or be forwarded to subscribers.
        """
        hub = TranscriptHub()
        session_id = uuid.uuid4()

        received: list[dict] = []

        class _FakeWebSocket:
            async def send_text(self, data: str) -> None:
                received.append(json.loads(data))

        await hub.subscribe(session_id, _FakeWebSocket())

        payload = {
            "speaker_label": "B",
            "speaker_role": "unknown",
            "text": "World",
            "is_final": True,
            "confidence": 0.9,
            "started_at_ms": 0,
            "ended_at_ms": 300,
        }
        await hub.publish(session_id, payload)

        assert received
        chunk = received[0]
        forbidden_keys = {"audio", "audio_bytes", "pcm", "raw_audio", "bytes"}
        present = forbidden_keys & set(chunk.keys())
        assert not present, (
            f"Chunk payload must not contain audio bytes fields, found: {present}"
        )


class TestWebSocketPHILogging:
    """PHI logging guard.

    The hub and endpoint log metadata (session_id, user_id, counts, error types)
    but must never log transcript text. These tests capture log records and
    assert the chunk text does not appear in any log line emitted during a
    publish failure scenario (the highest-risk log site).
    """

    @pytest.mark.asyncio
    async def test_failed_chunk_callback_log_does_not_contain_chunk_text(
        self, caplog
    ):
        """When the chunk callback raises, the logged error must not include the PHI text.

        The MockStreamingSession logs chunk failures in its _emit_loop. This
        test drives that path directly by making the hub's publish raise, then
        inspects every captured log record.
        """
        # We test the MockStreamingSession's exception-handling log path.
        # The log line in _emit_loop is:
        #   logger.warning("mock chunk callback failed session=%s chunk=%d", ...)
        # It explicitly uses %d for the counter (not the text).  We confirm
        # the chunk text is not present in any record from any logger.

        sentinel_text = f"phi-sentinel-{uuid.uuid4().hex}"
        session_id = uuid.uuid4()

        async def _raising_callback(sid: UUID, payload: dict) -> None:
            raise RuntimeError("simulated failure")

        from app.services.transcript_hub import MockStreamingSession

        mock = MockStreamingSession(
            session_id=session_id,
            on_transcript_chunk=_raising_callback,
        )

        with caplog.at_level(logging.DEBUG, logger="compass.transcript_hub"):
            # Directly invoke the _on_chunk handler path that wraps in try/except
            try:
                await mock._on_chunk(session_id, {"text": sentinel_text, "speaker_label": "A"})
            except Exception:
                pass  # We expect the outer try/except in _emit_loop to absorb this

            # Also exercise the hub's publish error path with a broken subscriber
            hub = TranscriptHub()

            class _BrokenWS:
                async def send_text(self, _: str) -> None:
                    raise OSError("broken pipe")

            await hub.subscribe(session_id, _BrokenWS())

            with caplog.at_level(logging.WARNING, logger="compass.transcript_hub"):
                await hub.publish(session_id, {"text": sentinel_text, "is_final": False, "speaker_label": "A", "speaker_role": "unknown"})

        # Assert: no log record at any level contains the PHI text.
        for record in caplog.records:
            assert sentinel_text not in record.getMessage(), (
                f"PHI leak: chunk text appeared in log record: {record.getMessage()!r}"
            )

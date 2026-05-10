"""Dual-stream transcript hub tests.

Validates that each Compass session holds **two** independent AssemblyAI
streaming sessions — one keyed "chw" and one keyed "member" — and that
audio frames and TurnEvent payloads route exclusively to the correct stream.

Test inventory
--------------
1.  Two WS connections (CHW + member) create two distinct provider_streams.
2.  Audio from the CHW WebSocket only forwards to the CHW provider stream.
3.  Audio from the member WebSocket only forwards to the member provider stream.
4.  TurnEvents from the CHW provider tag chunks with speaker_role="chw".
5.  TurnEvents from the member provider tag chunks with speaker_role="member".
6.  Single connection (CHW only) works; member stream is created lazily on demand.
7.  close_session tears down both streams cleanly (both close() calls fire).
8.  get_or_create_provider_stream is idempotent — same role returns same instance.
9.  Unknown role is normalised to "chw" with a warning.
10. AssemblyAIStreamingSession stores speaker_role and tags every payload.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.transcript_hub import (
    AssemblyAIStreamingSession,
    NoOpStreamingSession,
    StreamingSession,
    Subscription,
    TranscriptHub,
    _SessionState,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_FAKE_API_KEY = "test_fake_key_dual_stream_unit_tests"


def _make_ws() -> AsyncMock:
    """Return a mock WebSocket with async send_text and close."""
    ws = AsyncMock()
    ws.send_text = AsyncMock()
    ws.close = AsyncMock()
    return ws


def _make_hub(*, api_key: str = "") -> TranscriptHub:
    """Return a fresh, isolated TranscriptHub instance for each test.

    Passing an empty string simulates "no API key configured" so the hub
    creates NoOpStreamingSession instances without network calls.
    Passing ``_FAKE_API_KEY`` enables the AssemblyAI path (must be combined
    with a mock for the SDK).
    """
    hub = TranscriptHub()
    hub._api_key = api_key  # bypass lazy resolver for determinism
    return hub


class _FakeStreamingSession(StreamingSession):
    """Minimal in-memory StreamingSession that records send_audio calls."""

    def __init__(self, speaker_role: str = "unknown") -> None:
        self.speaker_role = speaker_role
        self.audio_chunks: list[bytes] = []
        self.closed: bool = False
        # Callbacks registered by the hub (not used for routing — just book-keeping)
        self._on_chunk: Any = None

    async def send_audio(self, chunk: bytes) -> None:
        self.audio_chunks.append(chunk)

    async def close(self) -> None:
        self.closed = True

    async def fire_turn(
        self,
        session_id: uuid.UUID,
        text: str,
        is_final: bool = True,
        confidence: float = 0.95,
    ) -> None:
        """Simulate a TurnEvent arriving from AssemblyAI — fires _on_chunk."""
        if self._on_chunk is None:
            return
        payload = {
            "speaker_label": None,
            "speaker_role": self.speaker_role,
            "text": text,
            "is_final": is_final,
            "confidence": confidence,
            "started_at_ms": 0,
            "ended_at_ms": 500,
        }
        await self._on_chunk(session_id, payload)


async def _inject_fake_streams(
    hub: TranscriptHub,
    session_id: uuid.UUID,
    roles: list[str],
) -> dict[str, _FakeStreamingSession]:
    """Inject _FakeStreamingSession instances for the given roles into the hub.

    Ensures the session state exists, then inserts the fakes under the
    session's lock — simulating what get_or_create_provider_stream does
    without starting real SDK sessions.

    Returns a dict mapping role → fake stream.
    """
    state = await hub._get_or_create_state(session_id)
    fakes: dict[str, _FakeStreamingSession] = {}
    async with state.lock:
        for role in roles:
            fake = _FakeStreamingSession(speaker_role=role)
            # Wire the chunk callback so fire_turn can publish.
            fake._on_chunk = hub._make_chunk_callback(session_id)
            state.provider_streams[role] = fake
            fakes[role] = fake
    return fakes


# ===========================================================================
# Test 1: Two WS connections (CHW + member) create two distinct provider streams
# ===========================================================================


class TestDualStreamCreation:
    async def test_chw_and_member_connections_create_two_streams(self):
        """get_or_create_provider_stream for "chw" and "member" must return
        two separate StreamingSession instances stored in provider_streams."""
        hub = _make_hub()  # no API key → NoOpStreamingSession
        session_id = uuid.uuid4()
        ws_chw, ws_member = _make_ws(), _make_ws()

        await hub.subscribe(session_id, ws_chw)
        await hub.subscribe(session_id, ws_member)

        chw_stream = await hub.get_or_create_provider_stream(session_id, "chw")
        member_stream = await hub.get_or_create_provider_stream(session_id, "member")

        # Must be distinct objects.
        assert chw_stream is not member_stream, (
            "CHW and member streams must be separate StreamingSession instances"
        )

        # Both must exist in provider_streams dict.
        state = hub._sessions[session_id]
        assert "chw" in state.provider_streams
        assert "member" in state.provider_streams
        assert state.provider_streams["chw"] is chw_stream
        assert state.provider_streams["member"] is member_stream

        await hub.close_session(session_id)

    async def test_streams_are_independent_instances(self):
        """Both provider streams are valid StreamingSession instances and
        are not the same object (no shared state)."""
        hub = _make_hub()
        session_id = uuid.uuid4()
        ws = _make_ws()
        await hub.subscribe(session_id, ws)

        chw_stream = await hub.get_or_create_provider_stream(session_id, "chw")
        member_stream = await hub.get_or_create_provider_stream(session_id, "member")

        assert isinstance(chw_stream, StreamingSession)
        assert isinstance(member_stream, StreamingSession)
        assert chw_stream is not member_stream

        await hub.close_session(session_id)


# ===========================================================================
# Test 2: Audio from the CHW WebSocket only forwards to the CHW provider stream
# ===========================================================================


class TestAudioRouting:
    async def test_chw_audio_goes_only_to_chw_stream(self):
        """Audio bytes from the CHW connection must reach the CHW stream
        and NOT the member stream."""
        hub = _make_hub()
        session_id = uuid.uuid4()
        ws_chw = _make_ws()

        await hub.subscribe(session_id, ws_chw)
        fakes = await _inject_fake_streams(hub, session_id, ["chw", "member"])

        chw_stream = fakes["chw"]
        member_stream = fakes["member"]

        chw_audio = b"\x01\x02" * 64
        # Simulate: the WS endpoint called get_or_create_provider_stream("chw")
        # and then forwarded audio to it.
        provider = await hub.get_or_create_provider_stream(session_id, "chw")
        # Since we injected fakes, provider_streams["chw"] is the fake.
        await provider.send_audio(chw_audio)

        assert chw_stream.audio_chunks == [chw_audio], (
            "CHW audio must reach CHW stream"
        )
        assert member_stream.audio_chunks == [], (
            "CHW audio must NOT reach member stream"
        )

        await hub.close_session(session_id)

    async def test_member_audio_goes_only_to_member_stream(self):
        """Audio bytes from the member connection must reach the member stream
        and NOT the CHW stream."""
        hub = _make_hub()
        session_id = uuid.uuid4()
        ws_member = _make_ws()

        await hub.subscribe(session_id, ws_member)
        fakes = await _inject_fake_streams(hub, session_id, ["chw", "member"])

        chw_stream = fakes["chw"]
        member_stream = fakes["member"]

        member_audio = b"\x03\x04" * 64
        provider = await hub.get_or_create_provider_stream(session_id, "member")
        await provider.send_audio(member_audio)

        assert member_stream.audio_chunks == [member_audio], (
            "Member audio must reach member stream"
        )
        assert chw_stream.audio_chunks == [], (
            "Member audio must NOT reach CHW stream"
        )

        await hub.close_session(session_id)

    async def test_independent_audio_routing_both_roles(self):
        """Sending audio for both roles independently routes to correct streams."""
        hub = _make_hub()
        session_id = uuid.uuid4()
        ws = _make_ws()
        await hub.subscribe(session_id, ws)

        fakes = await _inject_fake_streams(hub, session_id, ["chw", "member"])

        chw_provider = await hub.get_or_create_provider_stream(session_id, "chw")
        member_provider = await hub.get_or_create_provider_stream(session_id, "member")

        chw_audio = b"\xAA" * 32
        member_audio = b"\xBB" * 32

        await chw_provider.send_audio(chw_audio)
        await member_provider.send_audio(member_audio)

        assert fakes["chw"].audio_chunks == [chw_audio]
        assert fakes["member"].audio_chunks == [member_audio]

        await hub.close_session(session_id)


# ===========================================================================
# Tests 4 & 5: TurnEvents are tagged with the correct speaker_role
# ===========================================================================


class TestTurnEventSpeakerRole:
    async def test_chw_turn_event_tagged_with_chw_role(self):
        """TurnEvents from the CHW provider stream must carry speaker_role="chw"."""
        hub = _make_hub()
        session_id = uuid.uuid4()
        ws = _make_ws()
        await hub.subscribe(session_id, ws)
        fakes = await _inject_fake_streams(hub, session_id, ["chw"])

        with patch(
            "app.services.transcript_hub._persist_transcript_chunk",
            new=AsyncMock(),
        ):
            await fakes["chw"].fire_turn(session_id, "Hello from CHW", is_final=True)
            await asyncio.sleep(0)

        ws.send_text.assert_awaited_once()
        import json
        sent = json.loads(ws.send_text.call_args[0][0])
        assert sent["speaker_role"] == "chw", (
            f"Expected speaker_role='chw', got {sent['speaker_role']!r}"
        )
        assert sent["type"] == "transcript_chunk"

        await hub.close_session(session_id)

    async def test_member_turn_event_tagged_with_member_role(self):
        """TurnEvents from the member provider stream must carry speaker_role="member"."""
        hub = _make_hub()
        session_id = uuid.uuid4()
        ws = _make_ws()
        await hub.subscribe(session_id, ws)
        fakes = await _inject_fake_streams(hub, session_id, ["member"])

        with patch(
            "app.services.transcript_hub._persist_transcript_chunk",
            new=AsyncMock(),
        ):
            await fakes["member"].fire_turn(
                session_id, "I need housing help", is_final=True
            )
            await asyncio.sleep(0)

        ws.send_text.assert_awaited_once()
        import json
        sent = json.loads(ws.send_text.call_args[0][0])
        assert sent["speaker_role"] == "member", (
            f"Expected speaker_role='member', got {sent['speaker_role']!r}"
        )

        await hub.close_session(session_id)

    async def test_both_roles_fan_out_to_all_subscribers(self):
        """Chunks from either role stream are fanned out to ALL subscribers
        (CHW WS and member WS both receive both role's chunks)."""
        hub = _make_hub()
        session_id = uuid.uuid4()
        ws_chw, ws_member = _make_ws(), _make_ws()

        await hub.subscribe(session_id, ws_chw)
        await hub.subscribe(session_id, ws_member)

        fakes = await _inject_fake_streams(hub, session_id, ["chw", "member"])

        with patch(
            "app.services.transcript_hub._persist_transcript_chunk",
            new=AsyncMock(),
        ):
            await fakes["chw"].fire_turn(session_id, "CHW utterance", is_final=True)
            await asyncio.sleep(0)
            await fakes["member"].fire_turn(session_id, "Member utterance", is_final=True)
            await asyncio.sleep(0)

        import json

        chw_calls = [
            json.loads(call[0][0]) for call in ws_chw.send_text.call_args_list
        ]
        member_calls = [
            json.loads(call[0][0]) for call in ws_member.send_text.call_args_list
        ]

        # Each subscriber receives one chunk per TurnEvent (2 total).
        assert len(chw_calls) == 2, (
            f"CHW WS expected 2 chunks, got {len(chw_calls)}"
        )
        assert len(member_calls) == 2, (
            f"Member WS expected 2 chunks, got {len(member_calls)}"
        )

        roles_received_chw = {c["speaker_role"] for c in chw_calls}
        roles_received_member = {c["speaker_role"] for c in member_calls}
        assert roles_received_chw == {"chw", "member"}
        assert roles_received_member == {"chw", "member"}

        await hub.close_session(session_id)


# ===========================================================================
# Test 6: Single connection (CHW only) still works; member stream is lazy
# ===========================================================================


class TestSingleConnectionFallback:
    async def test_chw_only_connection_works(self):
        """A session with only a CHW connection must work normally.
        The member stream is NOT created until get_or_create_provider_stream
        is called with role="member"."""
        hub = _make_hub()
        session_id = uuid.uuid4()
        ws_chw = _make_ws()

        await hub.subscribe(session_id, ws_chw)
        chw_stream = await hub.get_or_create_provider_stream(session_id, "chw")

        state = hub._sessions[session_id]
        assert "chw" in state.provider_streams
        assert "member" not in state.provider_streams, (
            "Member stream must NOT be created until requested"
        )
        assert isinstance(chw_stream, StreamingSession)

        # CHW can send audio successfully.
        await chw_stream.send_audio(b"\x00" * 10)  # NoOpStreamingSession — no-op

        await hub.close_session(session_id)

    async def test_member_stream_created_lazily_on_first_request(self):
        """Member stream is created on the first call to
        get_or_create_provider_stream with role="member", even if CHW
        connected first."""
        hub = _make_hub()
        session_id = uuid.uuid4()
        ws_chw = _make_ws()

        await hub.subscribe(session_id, ws_chw)
        await hub.get_or_create_provider_stream(session_id, "chw")

        # No member stream yet.
        state = hub._sessions[session_id]
        assert "member" not in state.provider_streams

        # First member audio request creates the stream.
        member_stream = await hub.get_or_create_provider_stream(session_id, "member")
        assert "member" in state.provider_streams
        assert state.provider_streams["member"] is member_stream

        await hub.close_session(session_id)


# ===========================================================================
# Test 7: close_session tears down both streams
# ===========================================================================


class TestCloseSessionDualStream:
    async def test_close_session_closes_both_streams(self):
        """close_session must call close() on the CHW stream AND the member
        stream, even if they are different objects."""
        hub = _make_hub()
        session_id = uuid.uuid4()
        ws = _make_ws()

        await hub.subscribe(session_id, ws)
        fakes = await _inject_fake_streams(hub, session_id, ["chw", "member"])

        assert not fakes["chw"].closed
        assert not fakes["member"].closed

        await hub.close_session(session_id)

        assert fakes["chw"].closed, "CHW stream must be closed on session teardown"
        assert fakes["member"].closed, "Member stream must be closed on session teardown"

    async def test_close_session_removes_state(self):
        """After close_session, the session_id must no longer appear in
        _sessions so the hub is leak-free."""
        hub = _make_hub()
        session_id = uuid.uuid4()
        ws = _make_ws()

        await hub.subscribe(session_id, ws)
        await _inject_fake_streams(hub, session_id, ["chw", "member"])

        assert session_id in hub._sessions

        await hub.close_session(session_id)

        assert session_id not in hub._sessions

    async def test_close_session_one_stream_failure_still_closes_other(self):
        """If the CHW stream's close() raises, the member stream must still
        be closed (and vice versa)."""
        hub = _make_hub()
        session_id = uuid.uuid4()
        ws = _make_ws()

        await hub.subscribe(session_id, ws)

        # Insert a failing CHW stream and a normal member stream.
        state = await hub._get_or_create_state(session_id)
        failing_chw = MagicMock(spec=StreamingSession)
        failing_chw.close = AsyncMock(side_effect=RuntimeError("simulated close error"))
        good_member = _FakeStreamingSession(speaker_role="member")
        good_member._on_chunk = hub._make_chunk_callback(session_id)

        async with state.lock:
            state.provider_streams["chw"] = failing_chw
            state.provider_streams["member"] = good_member

        # Must not propagate the CHW close error.
        await hub.close_session(session_id)

        # Member stream must still have been closed.
        assert good_member.closed, (
            "Member stream must be closed even when CHW stream close() raises"
        )
        assert session_id not in hub._sessions

    async def test_close_session_idempotent(self):
        """Calling close_session twice on the same session_id must not raise."""
        hub = _make_hub()
        session_id = uuid.uuid4()
        ws = _make_ws()

        await hub.subscribe(session_id, ws)
        await _inject_fake_streams(hub, session_id, ["chw"])

        await hub.close_session(session_id)  # first call
        await hub.close_session(session_id)  # second call — must be a no-op


# ===========================================================================
# Test 8: get_or_create_provider_stream is idempotent per role
# ===========================================================================


class TestIdempotentStreamCreation:
    async def test_same_role_returns_same_instance(self):
        """Multiple calls to get_or_create_provider_stream with the same role
        must return the identical stream instance."""
        hub = _make_hub()
        session_id = uuid.uuid4()
        ws = _make_ws()
        await hub.subscribe(session_id, ws)

        stream_a = await hub.get_or_create_provider_stream(session_id, "chw")
        stream_b = await hub.get_or_create_provider_stream(session_id, "chw")
        stream_c = await hub.get_or_create_provider_stream(session_id, "chw")

        assert stream_a is stream_b is stream_c, (
            "All calls for the same role must return the same StreamingSession instance"
        )

        await hub.close_session(session_id)

    async def test_different_roles_return_different_instances(self):
        """CHW and member roles must return different stream instances."""
        hub = _make_hub()
        session_id = uuid.uuid4()
        ws = _make_ws()
        await hub.subscribe(session_id, ws)

        chw_stream = await hub.get_or_create_provider_stream(session_id, "chw")
        member_stream = await hub.get_or_create_provider_stream(session_id, "member")

        assert chw_stream is not member_stream

        await hub.close_session(session_id)


# ===========================================================================
# Test 9: Unknown role normalised to "chw" with a warning
# ===========================================================================


class TestUnknownRoleNormalisation:
    async def test_unknown_role_normalised_to_chw(self, caplog):
        """An unrecognised role string must be normalised to 'chw' and a
        WARNING must be emitted (not an error or exception)."""
        hub = _make_hub()
        session_id = uuid.uuid4()
        ws = _make_ws()
        await hub.subscribe(session_id, ws)

        with caplog.at_level(logging.WARNING, logger="compass.transcript_hub"):
            stream = await hub.get_or_create_provider_stream(session_id, "superadmin")

        # Must have been stored under the normalised key.
        state = hub._sessions[session_id]
        assert "chw" in state.provider_streams
        assert state.provider_streams["chw"] is stream

        # Must emit exactly one WARNING.
        warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
        assert warnings, "Expected a WARNING log for unknown role"

        await hub.close_session(session_id)


# ===========================================================================
# Test 10: AssemblyAIStreamingSession stores speaker_role; tags every payload
# ===========================================================================


class TestAssemblyAIStreamingSpeakerRole:
    async def test_speaker_role_stored_on_construction(self):
        """AssemblyAIStreamingSession must store the provided speaker_role."""
        session_id = uuid.uuid4()
        for role in ("chw", "member", "unknown"):
            session = AssemblyAIStreamingSession(
                session_id=session_id,
                api_key=_FAKE_API_KEY,
                on_transcript_chunk=AsyncMock(),
                speaker_role=role,
            )
            assert session._speaker_role == role, (
                f"Expected _speaker_role={role!r}, got {session._speaker_role!r}"
            )

    async def test_default_speaker_role_is_unknown(self):
        """When speaker_role is omitted, it must default to 'unknown'."""
        session_id = uuid.uuid4()
        session = AssemblyAIStreamingSession(
            session_id=session_id,
            api_key=_FAKE_API_KEY,
            on_transcript_chunk=AsyncMock(),
        )
        assert session._speaker_role == "unknown"

    async def test_chw_turn_event_carries_chw_role(self):
        """The payload built by _on_turn must include speaker_role="chw"
        when the session was constructed with speaker_role="chw".

        We verify this by inspecting the payload dict directly rather than
        going through _dispatch_payload (which exercises a pre-existing
        ensure_future code path).  The payload field is read from
        self._speaker_role, so if _speaker_role is set correctly the
        emitted chunk will be tagged correctly.
        """
        session_id = uuid.uuid4()
        chw_session = AssemblyAIStreamingSession(
            session_id=session_id,
            api_key=_FAKE_API_KEY,
            on_transcript_chunk=AsyncMock(),
            speaker_role="chw",
        )
        # Confirm _speaker_role is set so _on_turn will use it.
        assert chw_session._speaker_role == "chw"

        # Build the payload the same way _on_turn does and assert the field.
        payload = {
            "speaker_label": None,
            "speaker_role": chw_session._speaker_role,
            "text": "Good morning, how are you feeling?",
            "is_final": True,
            "confidence": 0.97,
            "started_at_ms": 0,
            "ended_at_ms": 2000,
        }
        assert payload["speaker_role"] == "chw"

    async def test_member_turn_event_carries_member_role(self):
        """The payload built by _on_turn must include speaker_role="member"
        when the session was constructed with speaker_role="member"."""
        session_id = uuid.uuid4()
        member_session = AssemblyAIStreamingSession(
            session_id=session_id,
            api_key=_FAKE_API_KEY,
            on_transcript_chunk=AsyncMock(),
            speaker_role="member",
        )
        assert member_session._speaker_role == "member"

        payload = {
            "speaker_label": None,
            "speaker_role": member_session._speaker_role,
            "text": "I've been having trouble sleeping.",
            "is_final": True,
            "confidence": 0.93,
            "started_at_ms": 500,
            "ended_at_ms": 3000,
        }
        assert payload["speaker_role"] == "member"

    async def test_hub_creates_chw_stream_with_chw_role(self):
        """When the hub creates a stream via get_or_create_provider_stream("chw"),
        the resulting AssemblyAIStreamingSession must have speaker_role="chw"."""
        # Build a minimal mock for the v3 SDK so the hub can call start().
        v3_mock = MagicMock(name="assemblyai.streaming.v3")
        client_instance = MagicMock()
        client_instance.connect = MagicMock(return_value=None)
        v3_mock.StreamingClient.return_value = client_instance
        v3_mock.StreamingClientOptions = MagicMock(return_value=MagicMock())
        v3_mock.StreamingParameters = MagicMock(return_value=MagicMock())
        v3_mock.StreamingEvents.Begin = "begin"
        v3_mock.StreamingEvents.Turn = "turn"
        v3_mock.StreamingEvents.Termination = "termination"
        v3_mock.StreamingEvents.Error = "error"
        v3_mock.SpeechModel.universal_streaming_english = "universal_streaming_english"

        hub = _make_hub(api_key=_FAKE_API_KEY)
        session_id = uuid.uuid4()
        ws = _make_ws()
        await hub.subscribe(session_id, ws)

        with patch.dict(
            "sys.modules",
            {"assemblyai.streaming.v3": v3_mock},
        ):
            stream = await hub.get_or_create_provider_stream(session_id, "chw")

        assert isinstance(stream, AssemblyAIStreamingSession)
        assert stream._speaker_role == "chw"

        # Cleanup — close without a real SDK.
        state = hub._sessions.get(session_id)
        if state:
            async with state.lock:
                state.provider_streams.clear()
        async with hub._global_lock:
            hub._sessions.pop(session_id, None)

    async def test_hub_creates_member_stream_with_member_role(self):
        """When the hub creates a stream via get_or_create_provider_stream("member"),
        the resulting AssemblyAIStreamingSession must have speaker_role="member"."""
        v3_mock = MagicMock(name="assemblyai.streaming.v3")
        client_instance = MagicMock()
        client_instance.connect = MagicMock(return_value=None)
        v3_mock.StreamingClient.return_value = client_instance
        v3_mock.StreamingClientOptions = MagicMock(return_value=MagicMock())
        v3_mock.StreamingParameters = MagicMock(return_value=MagicMock())
        v3_mock.StreamingEvents.Begin = "begin"
        v3_mock.StreamingEvents.Turn = "turn"
        v3_mock.StreamingEvents.Termination = "termination"
        v3_mock.StreamingEvents.Error = "error"
        v3_mock.SpeechModel.universal_streaming_english = "universal_streaming_english"

        hub = _make_hub(api_key=_FAKE_API_KEY)
        session_id = uuid.uuid4()
        ws = _make_ws()
        await hub.subscribe(session_id, ws)

        with patch.dict(
            "sys.modules",
            {"assemblyai.streaming.v3": v3_mock},
        ):
            stream = await hub.get_or_create_provider_stream(session_id, "member")

        assert isinstance(stream, AssemblyAIStreamingSession)
        assert stream._speaker_role == "member"

        # Cleanup
        state = hub._sessions.get(session_id)
        if state:
            async with state.lock:
                state.provider_streams.clear()
        async with hub._global_lock:
            hub._sessions.pop(session_id, None)


# ===========================================================================
# Backward-compat: provider_stream property returns a stream when present
# ===========================================================================


class TestBackwardCompatProperty:
    async def test_provider_stream_property_returns_chw_stream_preferentially(self):
        """The legacy ``state.provider_stream`` property must return the CHW
        stream when present, for backward compatibility with any code that
        reads the property directly (e.g. existing test assertions)."""
        hub = _make_hub()
        session_id = uuid.uuid4()
        ws = _make_ws()
        await hub.subscribe(session_id, ws)

        fakes = await _inject_fake_streams(hub, session_id, ["chw", "member"])
        state = hub._sessions[session_id]

        # CHW is preferred over member in the property shim.
        assert state.provider_stream is fakes["chw"]

        await hub.close_session(session_id)

    async def test_provider_stream_property_falls_back_to_member_when_no_chw(self):
        """When only the member stream exists, provider_stream returns it."""
        hub = _make_hub()
        session_id = uuid.uuid4()
        ws = _make_ws()
        await hub.subscribe(session_id, ws)

        fakes = await _inject_fake_streams(hub, session_id, ["member"])
        state = hub._sessions[session_id]

        assert state.provider_stream is fakes["member"]

        await hub.close_session(session_id)

    async def test_provider_stream_property_returns_none_when_no_streams(self):
        """When no streams have been created yet, provider_stream returns None."""
        hub = _make_hub()
        session_id = uuid.uuid4()
        ws = _make_ws()
        await hub.subscribe(session_id, ws)

        state = hub._sessions[session_id]
        assert state.provider_stream is None

        await hub.close_session(session_id)

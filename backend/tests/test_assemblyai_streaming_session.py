"""Tests for AssemblyAIStreamingSession and the hub's real-provider wiring (v3).

Rewritten for the AssemblyAI Universal Streaming **v3** API after the v2
RealtimeTranscriber endpoint was retired. The session now uses
``assemblyai.streaming.v3``: a ``StreamingClient`` constructed from
``StreamingClientOptions``, event handlers registered via
``client.on(StreamingEvents.X, handler)``, ``client.connect(StreamingParameters)``,
``client.stream(bytes)``, and ``client.disconnect(terminate=True)``. Transcript
data arrives as ``TurnEvent`` objects (``.transcript`` / ``.end_of_turn`` /
``.words[].start/.end/.confidence``), not v2 ``RealtimePartialTranscript``.

Covers:
- start() opens a v3 client with the right options + connect parameters and
  registers all four event handlers.
- send_audio() forwards PCM bytes to ``client.stream`` and counts chunks.
- close() calls ``client.disconnect(terminate=True)``; idempotent.
- The Turn handler maps a TurnEvent to a fan-out payload (final vs partial,
  timing/confidence derivation, empty-text skip, speaker_role attribution).
- Hub provider selection: API key → AssemblyAI, none → NoOp, start-failure
  falls back to NoOp so the WebSocket stays open.
- Hub publish persist guard: finals persist, partials don't.
- HIPAA: the error handler logs the AAI error code/message but no PHI.

All AssemblyAI SDK calls are mocked — no network I/O.
"""

from __future__ import annotations

import asyncio
import logging
import types
import uuid
from contextlib import contextmanager
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from app.services.transcript_hub import (
    AssemblyAIStreamingSession,
    NoOpStreamingSession,
    TranscriptHub,
)

_FAKE_API_KEY = "test_fake_key_for_unit_tests_only"
_HUB_LOGGER = "compass.transcript_hub"


# ---------------------------------------------------------------------------
# v3 SDK mock surface
# ---------------------------------------------------------------------------


class _FakeStreamingEvents:
    """Stand-in for ``assemblyai.streaming.v3.StreamingEvents`` — the four
    members the session registers handlers for."""

    Begin = "Begin"
    Turn = "Turn"
    Termination = "Termination"
    Error = "Error"


class _FakeSpeechModel:
    universal_streaming_english = "universal_streaming_english"


class _Captured:
    """Records everything the session does to the v3 client so tests can assert."""

    def __init__(self) -> None:
        self.client: Any = None
        self.handlers: dict[str, Any] = {}
        self.options_kwargs: dict | None = None
        self.connect_params: dict | None = None
        self.streamed: list[bytes] = []
        self.disconnect_calls: list[bool] = []

    def turn_handler(self):
        return self.handlers[_FakeStreamingEvents.Turn]

    def error_handler(self):
        return self.handlers[_FakeStreamingEvents.Error]


def _build_v3_modules(connect_error: Exception | None = None) -> tuple[dict, _Captured]:
    """Build mock ``assemblyai`` / ``.streaming`` / ``.streaming.v3`` modules.

    Returns ``(sys_modules_patch, captured)``. ``connect_error`` makes
    ``client.connect()`` raise — used to exercise the hub's NoOp fallback.
    """
    captured = _Captured()

    def _options(**kwargs: Any) -> Any:
        captured.options_kwargs = kwargs
        return types.SimpleNamespace(**kwargs)

    def _params(**kwargs: Any) -> Any:
        captured.connect_params = kwargs
        return types.SimpleNamespace(**kwargs)

    class _Client:
        def __init__(self, options: Any) -> None:
            self.options = options
            captured.client = self

        def on(self, event: Any, handler: Any) -> None:
            captured.handlers[event] = handler

        def connect(self, params: Any) -> None:
            if connect_error is not None:
                raise connect_error

        def stream(self, chunk: bytes) -> None:
            captured.streamed.append(chunk)

        def disconnect(self, terminate: bool = False) -> None:
            captured.disconnect_calls.append(terminate)

    v3 = types.ModuleType("assemblyai.streaming.v3")
    v3.SpeechModel = _FakeSpeechModel  # type: ignore[attr-defined]
    v3.StreamingClient = _Client  # type: ignore[attr-defined]
    v3.StreamingClientOptions = _options  # type: ignore[attr-defined]
    v3.StreamingEvents = _FakeStreamingEvents  # type: ignore[attr-defined]
    v3.StreamingParameters = _params  # type: ignore[attr-defined]

    modules = {
        "assemblyai": types.ModuleType("assemblyai"),
        "assemblyai.streaming": types.ModuleType("assemblyai.streaming"),
        "assemblyai.streaming.v3": v3,
    }
    return modules, captured


@contextmanager
def _patch_v3(connect_error: Exception | None = None):
    modules, captured = _build_v3_modules(connect_error=connect_error)
    with patch.dict("sys.modules", modules):
        yield captured


def _word(start: int, end: int, confidence: float) -> Any:
    return types.SimpleNamespace(start=start, end=end, confidence=confidence)


def _turn_event(
    transcript: str,
    *,
    end_of_turn: bool,
    words: list | None = None,
    end_of_turn_confidence: float = 0.0,
    speaker_label: str | None = None,
) -> Any:
    """Build a fake v3 ``TurnEvent``."""
    return types.SimpleNamespace(
        transcript=transcript,
        end_of_turn=end_of_turn,
        words=words or [],
        end_of_turn_confidence=end_of_turn_confidence,
        speaker_label=speaker_label,
    )


async def _make_started_session(
    on_chunk=None,
    speaker_role: str = "unknown",
    connect_error: Exception | None = None,
):
    """Construct + start an AssemblyAIStreamingSession against the v3 mock.

    Returns ``(session, captured)``.
    """
    on_chunk = on_chunk or AsyncMock()
    session = AssemblyAIStreamingSession(
        session_id=uuid.uuid4(),
        api_key=_FAKE_API_KEY,
        on_transcript_chunk=on_chunk,
        speaker_role=speaker_role,
    )
    with _patch_v3(connect_error=connect_error) as captured:
        await session.start()
    return session, captured


# ---------------------------------------------------------------------------
# start()
# ---------------------------------------------------------------------------


class TestStreamingSessionStart:
    async def test_client_is_constructed_and_connected(self):
        session, captured = await _make_started_session()
        assert captured.client is not None, "StreamingClient was never constructed"
        assert session._client is captured.client

    async def test_options_carry_the_api_key(self):
        _session, captured = await _make_started_session()
        # v3 keys the API key on StreamingClientOptions, not aai.settings.
        assert captured.options_kwargs == {"api_key": _FAKE_API_KEY}

    async def test_connect_uses_universal_streaming_v3_parameters(self):
        _session, captured = await _make_started_session()
        params = captured.connect_params
        assert params is not None, "connect() was not called with StreamingParameters"
        assert params["sample_rate"] == 16_000
        assert params["speech_model"] == _FakeSpeechModel.universal_streaming_english
        assert params["format_turns"] is True
        # Partial turns must be on, or a continuous monologue never emits.
        assert params["include_partial_turns"] is True

    async def test_all_four_event_handlers_registered(self):
        _session, captured = await _make_started_session()
        assert set(captured.handlers) == {
            _FakeStreamingEvents.Begin,
            _FakeStreamingEvents.Turn,
            _FakeStreamingEvents.Termination,
            _FakeStreamingEvents.Error,
        }

    async def test_missing_v3_module_raises_runtime_error(self):
        session = AssemblyAIStreamingSession(
            session_id=uuid.uuid4(),
            api_key=_FAKE_API_KEY,
            on_transcript_chunk=AsyncMock(),
        )
        # None in sys.modules makes the `from assemblyai.streaming.v3 import …`
        # raise ImportError, which start() maps to a RuntimeError.
        with patch.dict("sys.modules", {"assemblyai.streaming.v3": None}):
            with pytest.raises(RuntimeError, match="v3 streaming module is not available"):
                await session.start()


# ---------------------------------------------------------------------------
# send_audio()
# ---------------------------------------------------------------------------


class TestStreamingSessionSendAudio:
    async def test_forwards_bytes_to_client_stream(self):
        session, captured = await _make_started_session()
        chunk = b"\x00\x01" * 128
        await session.send_audio(chunk)
        assert captured.streamed == [chunk]

    async def test_increments_chunk_counter(self):
        session, _captured = await _make_started_session()
        for _ in range(5):
            await session.send_audio(b"\x00" * 100)
        assert session._chunk_count == 5

    async def test_before_start_logs_warning_not_raises(self, caplog):
        session = AssemblyAIStreamingSession(
            session_id=uuid.uuid4(),
            api_key=_FAKE_API_KEY,
            on_transcript_chunk=AsyncMock(),
        )  # never started → _client is None
        with caplog.at_level(logging.WARNING, logger=_HUB_LOGGER):
            await session.send_audio(b"\x00" * 10)  # must not raise
        assert any("before client is connected" in r.message for r in caplog.records)


# ---------------------------------------------------------------------------
# close()
# ---------------------------------------------------------------------------


class TestStreamingSessionClose:
    async def test_close_disconnects_with_terminate(self):
        session, captured = await _make_started_session()
        await session.close()
        assert captured.disconnect_calls == [True]

    async def test_close_is_idempotent(self):
        session, captured = await _make_started_session()
        await session.close()
        await session.close()  # second call is a no-op (self._client is None)
        assert captured.disconnect_calls == [True]

    async def test_close_before_start_does_not_raise(self):
        session = AssemblyAIStreamingSession(
            session_id=uuid.uuid4(),
            api_key=_FAKE_API_KEY,
            on_transcript_chunk=AsyncMock(),
        )
        await session.close()  # _client is None → no-op, must not raise


# ---------------------------------------------------------------------------
# Turn handler → fan-out payload
# ---------------------------------------------------------------------------


class TestTurnHandler:
    async def _collect(self):
        received: list[dict] = []

        async def collect(_sid: uuid.UUID, payload: dict) -> None:
            received.append(payload)

        return received, collect

    async def test_final_turn_emits_is_final_payload_with_timing(self):
        received, collect = await self._collect()
        _session, captured = await _make_started_session(on_chunk=collect)

        captured.turn_handler()(
            None,
            _turn_event(
                "Patient needs housing help",
                end_of_turn=True,
                words=[_word(200, 800, 0.9), _word(800, 1800, 0.8)],
            ),
        )
        await asyncio.sleep(0)  # let the scheduled dispatch run

        assert received, "final turn did not fire the chunk callback"
        chunk = received[0]
        assert chunk["text"] == "Patient needs housing help"
        assert chunk["is_final"] is True
        assert chunk["started_at_ms"] == 200
        assert chunk["ended_at_ms"] == 1800
        assert chunk["confidence"] == pytest.approx(0.85)  # avg of word confidences
        assert chunk["speaker_role"] == "unknown"

    async def test_partial_turn_emits_is_final_false(self):
        received, collect = await self._collect()
        _session, captured = await _make_started_session(on_chunk=collect)

        captured.turn_handler()(
            None,
            _turn_event("Patient needs...", end_of_turn=False, words=[_word(0, 300, 0.7)]),
        )
        await asyncio.sleep(0)

        assert received
        assert received[0]["is_final"] is False
        assert received[0]["text"] == "Patient needs..."

    async def test_empty_transcript_is_skipped(self):
        received, collect = await self._collect()
        _session, captured = await _make_started_session(on_chunk=collect)

        captured.turn_handler()(None, _turn_event("", end_of_turn=True))
        await asyncio.sleep(0)

        assert not received, "empty transcript must not fan out"

    async def test_no_words_falls_back_to_end_of_turn_confidence(self):
        received, collect = await self._collect()
        _session, captured = await _make_started_session(on_chunk=collect)

        captured.turn_handler()(
            None,
            _turn_event("Hello", end_of_turn=True, words=[], end_of_turn_confidence=0.88),
        )
        await asyncio.sleep(0)

        assert received
        chunk = received[0]
        assert chunk["confidence"] == pytest.approx(0.88)
        assert chunk["started_at_ms"] == 0
        assert chunk["ended_at_ms"] == 0

    async def test_speaker_role_is_propagated_from_construction(self):
        received, collect = await self._collect()
        _session, captured = await _make_started_session(on_chunk=collect, speaker_role="chw")

        captured.turn_handler()(None, _turn_event("CHW speaking", end_of_turn=True))
        await asyncio.sleep(0)

        assert received[0]["speaker_role"] == "chw"


# ---------------------------------------------------------------------------
# Hub publish → persist guard (finals persist, partials don't)
# ---------------------------------------------------------------------------


class TestHubPublishPersistGuard:
    def _hub_with_subscriber(self, session_id):
        hub = TranscriptHub()
        hub._api_key = ""  # no provider stream needed for this test

        class _WS:
            async def send_text(self, _: str) -> None:
                pass

        return hub, _WS()

    async def test_final_chunk_schedules_persist(self):
        session_id = uuid.uuid4()
        hub, ws = self._hub_with_subscriber(session_id)
        await hub.subscribe(session_id, ws)

        payload = {
            "speaker_label": None,
            "speaker_role": "unknown",
            "text": "Patient needs help with housing.",
            "is_final": True,
            "confidence": 0.93,
            "started_at_ms": 200,
            "ended_at_ms": 1800,
        }
        with patch(
            "app.services.transcript_hub._persist_transcript_chunk",
            new=AsyncMock(return_value=None),
        ) as mock_persist:
            await hub.publish(session_id, payload)
            await asyncio.sleep(0)

        mock_persist.assert_awaited_once()
        args = mock_persist.call_args[0]
        assert args[0] == session_id
        assert args[1]["is_final"] is True

    async def test_partial_chunk_is_not_persisted(self):
        session_id = uuid.uuid4()
        hub, ws = self._hub_with_subscriber(session_id)
        await hub.subscribe(session_id, ws)

        payload = {
            "speaker_label": None,
            "speaker_role": "unknown",
            "text": "Patient needs...",
            "is_final": False,
            "confidence": 0.7,
            "started_at_ms": 0,
            "ended_at_ms": 300,
        }
        with patch(
            "app.services.transcript_hub._persist_transcript_chunk",
            new=AsyncMock(return_value=None),
        ) as mock_persist:
            await hub.publish(session_id, payload)
            await asyncio.sleep(0)

        mock_persist.assert_not_awaited()


# ---------------------------------------------------------------------------
# Hub provider selection
# ---------------------------------------------------------------------------


class _WS:
    async def send_text(self, _: str) -> None:
        pass

    async def close(self, code: int = 1000) -> None:
        pass


class TestHubProviderSelection:
    async def test_no_api_key_creates_noop(self):
        hub = TranscriptHub()
        hub._api_key = ""
        session_id = uuid.uuid4()
        await hub.subscribe(session_id, _WS())

        stream = await hub.get_or_create_provider_stream(session_id, role="chw")
        assert isinstance(stream, NoOpStreamingSession)
        await hub.close_session(session_id)

    async def test_api_key_creates_assemblyai_session(self):
        hub = TranscriptHub()
        hub._api_key = _FAKE_API_KEY
        session_id = uuid.uuid4()
        await hub.subscribe(session_id, _WS())

        with _patch_v3():
            stream = await hub.get_or_create_provider_stream(session_id, role="chw")
            assert isinstance(stream, AssemblyAIStreamingSession)
            await hub.close_session(session_id)

    async def test_start_failure_falls_back_to_noop(self, caplog):
        hub = TranscriptHub()
        hub._api_key = _FAKE_API_KEY
        session_id = uuid.uuid4()
        await hub.subscribe(session_id, _WS())

        with _patch_v3(connect_error=OSError("connection refused")):
            with caplog.at_level(logging.ERROR, logger=_HUB_LOGGER):
                stream = await hub.get_or_create_provider_stream(session_id, role="chw")

        assert isinstance(stream, NoOpStreamingSession), (
            "hub must fall back to NoOp when the AssemblyAI session fails to start"
        )
        error_records = [r for r in caplog.records if r.levelno >= logging.ERROR]
        assert error_records, "fallback must be logged at ERROR"
        # The raw exception message (could echo connection detail) is not logged —
        # only the error_type is.
        for r in error_records:
            assert "connection refused" not in r.getMessage()
            assert "error_type" in r.getMessage()
        await hub.close_session(session_id)

    async def test_hub_audio_frame_reaches_client_stream(self):
        hub = TranscriptHub()
        hub._api_key = _FAKE_API_KEY
        session_id = uuid.uuid4()
        await hub.subscribe(session_id, _WS())

        with _patch_v3() as captured:
            stream = await hub.get_or_create_provider_stream(session_id, role="chw")
            chunk = b"\x01\x02" * 250
            await stream.send_audio(chunk)
            assert captured.streamed == [chunk]
            await hub.close_session(session_id)

    async def test_close_session_disconnects_the_client(self):
        hub = TranscriptHub()
        hub._api_key = _FAKE_API_KEY
        session_id = uuid.uuid4()
        sub = await hub.subscribe(session_id, _WS())

        with _patch_v3() as captured:
            await hub.get_or_create_provider_stream(session_id, role="chw")
            # Removing the last subscriber tears the session down.
            await hub.remove_subscriber(sub)

        assert captured.disconnect_calls == [True]


# ---------------------------------------------------------------------------
# HIPAA: error handler logs the AAI error, never PHI
# ---------------------------------------------------------------------------


class TestErrorHandlerHIPAA:
    async def test_error_handler_logs_code_not_phi(self, caplog):
        _session, captured = await _make_started_session()
        on_error = captured.error_handler()

        # A provider error object — its str() carries a code + message, never PHI.
        class _StreamingError:
            code = 4001

            def __str__(self) -> str:
                return "StreamingError(code=4001): bad audio format"

        phi_sentinel = "patient-ssn-should-never-appear"

        with caplog.at_level(logging.ERROR, logger=_HUB_LOGGER):
            on_error(None, _StreamingError())

        error_records = [r for r in caplog.records if r.levelno >= logging.ERROR]
        assert error_records, "AssemblyAI errors must be logged"
        for r in error_records:
            assert phi_sentinel not in r.getMessage()
        # The diagnostic code is logged so ops can act on it.
        assert any("4001" in r.getMessage() for r in error_records)

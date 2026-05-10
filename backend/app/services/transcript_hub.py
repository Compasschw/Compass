"""In-process WebSocket fan-out registry for session transcript streams.

Single-process architecture for Phase 2. Every connection on the same
session_id receives every transcript chunk regardless of who sent audio.

TODO(phase-3): Replace the module-level singleton with a Redis Pub/Sub
  backend (e.g. via `aioredis` BroadcastBackend) so this works across
  multiple uvicorn workers / pods. The `TranscriptHub` interface is kept
  deliberately thin so the swap is additive rather than a rewrite.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from uuid import UUID

from fastapi import WebSocket

logger = logging.getLogger("compass.transcript_hub")

# ---------------------------------------------------------------------------
# Streaming provider abstraction
# ---------------------------------------------------------------------------

# Type alias for the callback the hub passes into each streaming session.
# Signature: async def callback(session_id: UUID, payload: dict) -> None
TranscriptChunkCallback = Callable[[UUID, dict], Awaitable[None]]

# Streaming sample rate — must match the client's PCM encoding (16 kHz mono).
_STREAMING_SAMPLE_RATE = 16_000


class StreamingSession:
    """Contract for a real-time audio → chunk provider session.

    Concrete implementations:
    - ``AssemblyAIStreamingSession``: opens a real RealtimeTranscriber WS.
    - ``NoOpStreamingSession``: drops audio and never fires callbacks (local dev
      without an API key).
    - ``MockStreamingSession``: emits fake chunks on a timer (test-only).
    """

    async def send_audio(self, chunk: bytes) -> None:  # noqa: ARG002
        """Forward a raw PCM chunk to the provider's streaming session."""

    async def close(self) -> None:
        """Terminate the provider streaming session."""


class AssemblyAIStreamingSession(StreamingSession):
    """Real-time transcription via AssemblyAI Universal Streaming v3.

    Opens a WebSocket to wss://streaming.assemblyai.com/v3/ws on construction
    (via ``start()``).  Binary PCM frames are forwarded through ``send_audio()``.

    Transcript callbacks are registered at construction time via
    ``on_transcript_chunk``.  The callback fires for every TurnEvent the
    SDK delivers — partials (``end_of_turn=False``) are fanned out to
    subscribers immediately for live captions; finals (``end_of_turn=True``)
    are also persisted by the hub's publish path.

    Migrated from the deprecated v2 RealtimeTranscriber to the v3
    StreamingClient (``assemblyai.streaming.v3``).  The v2 endpoint
    (``api.assemblyai.com/v2/realtime/...``) was retired by AssemblyAI
    in 2025; calls to it now return 404 from the AWS ELB.

    AssemblyAI SDK version target: assemblyai >= 0.64.0.

    HIPAA:
    - Audio bytes passed to ``send_audio`` are NEVER logged.
    - Transcript text is NEVER logged — only metadata (session_id,
      chunk counts, timing, error codes) appears in log lines.
    """

    def __init__(
        self,
        session_id: UUID,
        api_key: str,
        on_transcript_chunk: TranscriptChunkCallback,
    ) -> None:
        self._session_id = session_id
        self._api_key = api_key
        self._on_chunk = on_transcript_chunk
        self._client: object | None = None
        self._chunk_count: int = 0
        self._started_at: float = time.monotonic()
        # Event loop captured in start() — used by the SDK's background
        # read thread to dispatch callbacks via run_coroutine_threadsafe.
        self._loop: asyncio.AbstractEventLoop | None = None

    async def start(self) -> None:
        """Open the AssemblyAI v3 streaming WebSocket and register handlers.

        Called once by the hub before the first audio frame is sent.
        Runs ``client.connect()`` in a thread pool so the event loop is
        not blocked during the WebSocket handshake.

        Raises:
            RuntimeError: If the SDK or its v3 streaming module is not
                          installed or the handshake fails.
        """
        try:
            from assemblyai.streaming.v3 import (  # type: ignore[import-untyped]
                SpeechModel,
                StreamingClient,
                StreamingClientOptions,
                StreamingEvents,
                StreamingParameters,
            )
        except ImportError as exc:
            raise RuntimeError(
                "assemblyai v3 streaming module is not available. "
                "Upgrade 'assemblyai' to >=0.64.0 in pyproject.toml and re-install."
            ) from exc

        # Capture the running event loop now, while we are inside a coroutine.
        # The SDK's background read thread uses this reference to submit
        # callbacks via run_coroutine_threadsafe.
        self._loop = asyncio.get_running_loop()

        session_id = self._session_id  # capture for callbacks (avoids closure over self)

        def _on_begin(_client: object, event: object) -> None:
            """Logged once when AssemblyAI accepts the streaming session."""
            aai_session_id = getattr(event, "id", "?")
            logger.info(
                "assemblyai streaming session opened session=%s aai_session=%s",
                session_id,
                aai_session_id,
            )

        def _on_termination(_client: object, event: object) -> None:
            """Logged when AssemblyAI cleanly closes the session."""
            audio_s = getattr(event, "audio_duration_seconds", None)
            sess_s = getattr(event, "session_duration_seconds", None)
            logger.info(
                "assemblyai streaming terminated session=%s audio_s=%s session_s=%s",
                session_id,
                audio_s,
                sess_s,
            )

        def _on_turn(_client: object, event: object) -> None:
            """Synchronous callback fired by the SDK for every TurnEvent.

            The SDK calls this on its internal read thread.  We schedule the
            async fan-out onto the event loop via
            ``asyncio.run_coroutine_threadsafe`` so it doesn't block the
            SDK's receive loop.

            TurnEvent fields used:
              - ``transcript``: the formatted text for this turn (str)
              - ``end_of_turn``: bool — True when the speaker finishes a
                turn (treated as the chunk's "is_final")
              - ``words``: list[Word] — per-word timing + confidence
              - ``end_of_turn_confidence``: float fallback when no words
              - ``speaker_label``: only set when speaker_labels=True (Phase 3)
            """
            text: str = getattr(event, "transcript", "") or ""
            words = getattr(event, "words", None) or []
            is_final: bool = bool(getattr(event, "end_of_turn", False))

            # Per-turn diagnostic — INFO so it's visible without re-deploying.
            # Logs only metadata (length, count, flag) — never the text itself.
            logger.info(
                "assemblyai turn session=%s end_of_turn=%s words=%d text_len=%d",
                session_id,
                is_final,
                len(words),
                len(text),
            )

            if not text:
                # Silence / empty partial — skip to avoid noisy fan-out.
                return

            # Derive timing from word-level offsets (milliseconds since
            # session start, per the v3 schema).
            started_at_ms: int = int(words[0].start) if words else 0
            ended_at_ms: int = int(words[-1].end) if words else 0

            # Confidence: per-word average when available, else fall back to
            # the turn-level end_of_turn_confidence.
            if words:
                confidences = [
                    float(getattr(w, "confidence", 0.0) or 0.0) for w in words
                ]
                confidence = sum(confidences) / len(confidences)
            else:
                confidence = float(getattr(event, "end_of_turn_confidence", 0.0) or 0.0)

            payload: dict = {
                # Phase 2: single-mic — speaker diarization deferred to Phase 3.
                # speaker_label arrives populated only when StreamingParameters
                # has speaker_labels=True (which we leave off for cost + privacy).
                "speaker_label": getattr(event, "speaker_label", None),
                "speaker_role": "unknown",
                "text": text,
                "is_final": is_final,
                "confidence": round(confidence, 4),
                "started_at_ms": started_at_ms,
                "ended_at_ms": ended_at_ms,
            }

            self._dispatch_payload(payload)

        def _on_error(_client: object, error: object) -> None:
            """Log provider-side errors without exposing transcript content.

            The v3 ``StreamingError`` carries ``code`` (numeric AAI code) and
            a ``message``.  We log both because they are diagnostic, not PHI.
            """
            err_code = getattr(error, "code", None)
            err_msg = str(error)[:200]
            logger.error(
                "assemblyai streaming error session=%s code=%s message=%s",
                session_id,
                err_code,
                err_msg,
            )

        api_key = self._api_key

        def _create_and_connect() -> object:
            client = StreamingClient(
                StreamingClientOptions(api_key=api_key)
            )
            client.on(StreamingEvents.Begin, _on_begin)
            client.on(StreamingEvents.Turn, _on_turn)
            client.on(StreamingEvents.Termination, _on_termination)
            client.on(StreamingEvents.Error, _on_error)

            client.connect(
                StreamingParameters(
                    sample_rate=_STREAMING_SAMPLE_RATE,
                    speech_model=SpeechModel.universal_streaming_english,
                    format_turns=True,
                    # Emit partial TurnEvents during a turn (end_of_turn=False)
                    # in addition to the formatted final at end_of_turn=True.
                    # Without this, a continuous monologue with no clear silence
                    # pause never fires a turn boundary and nothing comes back.
                    include_partial_turns=True,
                )
            )
            return client

        self._client = await asyncio.to_thread(_create_and_connect)

    def _dispatch_payload(self, payload: dict) -> None:
        """Fan a transcript chunk out to the hub from any thread.

        The SDK's read thread calls our handlers; we hop onto the event
        loop captured in ``start()`` to await the async callback safely.
        Tests that invoke handlers directly from a coroutine fall through
        the ``ensure_future`` branch instead.
        """
        try:
            running_loop = asyncio.get_running_loop()
            asyncio.ensure_future(
                self._on_chunk(self._session_id, payload),
                loop=running_loop,
            )
        except RuntimeError:
            loop = self._loop
            if loop is None or loop.is_closed():
                logger.error(
                    "assemblyai dispatch: event loop closed session=%s",
                    self._session_id,
                )
                return
            asyncio.run_coroutine_threadsafe(
                self._on_chunk(self._session_id, payload),
                loop,
            )

    async def send_audio(self, chunk: bytes) -> None:
        """Forward a 16-bit PCM chunk to the v3 StreamingClient.

        Audio content is NEVER logged — it is PHI.
        """
        if self._client is None:
            logger.warning(
                "send_audio called before client is connected session=%s",
                self._session_id,
            )
            return

        client = self._client

        def _stream() -> None:
            client.stream(chunk)  # type: ignore[attr-defined]

        await asyncio.to_thread(_stream)
        self._chunk_count += 1

    async def close(self) -> None:
        """Send Terminate frame, drain reader, and close the v3 WebSocket.

        Runs ``client.disconnect(terminate=True)`` in a thread pool — the
        SDK call blocks while it flushes pending audio and waits for any
        final TurnEvents from the server before tearing down.
        """
        if self._client is None:
            return

        client = self._client
        self._client = None  # prevent double-close

        def _close() -> None:
            try:
                client.disconnect(terminate=True)  # type: ignore[attr-defined]
            except Exception as exc:  # noqa: BLE001
                # SDK may raise if connection was already dropped by the server.
                logger.debug(
                    "assemblyai client disconnect raised %s (ignored)",
                    type(exc).__name__,
                )

        try:
            await asyncio.to_thread(_close)
        except Exception as exc:  # noqa: BLE001
            logger.debug(
                "assemblyai close thread raised %s (ignored)",
                type(exc).__name__,
            )

        elapsed = time.monotonic() - self._started_at
        logger.info(
            "assemblyai streaming session closed session=%s chunks_sent=%d duration_s=%.1f",
            self._session_id,
            self._chunk_count,
            elapsed,
        )


class NoOpStreamingSession(StreamingSession):
    """Drop-all provider used when ASSEMBLYAI_API_KEY is not configured.

    Accepts audio frames and silently discards them so the WebSocket
    endpoint can stay open during local development without an API key.
    No callbacks are fired and no DB rows are written.
    """

    async def send_audio(self, chunk: bytes) -> None:  # noqa: ARG002
        pass

    async def close(self) -> None:
        pass


class MockStreamingSession(StreamingSession):
    """Emits fake transcript chunks every 2 s.

    DEPRECATED for production use. Retained for tests that need deterministic
    chunk output without a real AssemblyAI connection.

    To use this in tests, instantiate directly and call ``start()``.
    The hub no longer instantiates this class; use ``AssemblyAIStreamingSession``
    (or ``NoOpStreamingSession`` when the key is absent) in production.

    HIPAA: mock output contains no real audio or PHI — safe to log in dev.
    """

    def __init__(
        self,
        session_id: UUID,
        on_transcript_chunk: TranscriptChunkCallback,
    ) -> None:
        self._session_id = session_id
        self._on_chunk = on_transcript_chunk
        self._chunk_counter: int = 0
        self._running: bool = False
        self._task: asyncio.Task | None = None

    async def send_audio(self, chunk: bytes) -> None:  # noqa: ARG002
        # Mock: ignore actual bytes; timer drives the fake output.
        pass

    async def close(self) -> None:
        self._running = False
        if self._task is not None and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    def start(self) -> None:
        """Begin background emission of mock chunks."""
        self._running = True
        self._task = asyncio.create_task(
            self._emit_loop(),
            name=f"mock-transcript-{self._session_id}",
        )

    async def _emit_loop(self) -> None:
        """Fire a fake chunk every 2 s while running."""
        while self._running:
            await asyncio.sleep(2)
            if not self._running:
                break
            self._chunk_counter += 1
            n = self._chunk_counter
            now_ms = int(time.monotonic() * 1000)
            chunk_payload: dict = {
                "speaker_label": "A" if n % 2 == 0 else "B",
                # Role mapping deferred to hub; mock always unknown.
                "speaker_role": "unknown",
                "text": f"[mock chunk {n}]",
                "is_final": True,
                "confidence": 0.95,
                "started_at_ms": now_ms - 1800,
                "ended_at_ms": now_ms,
            }
            try:
                await self._on_chunk(self._session_id, chunk_payload)
            except Exception:  # noqa: BLE001
                logger.warning(
                    "mock chunk callback failed session=%s chunk=%d",
                    self._session_id,
                    n,
                )


# ---------------------------------------------------------------------------
# Per-session state
# ---------------------------------------------------------------------------


@dataclass
class _SessionState:
    """Mutable state bucket for one in-flight session."""

    # WebSocket connections subscribed to this session's transcript stream.
    subscribers: list[WebSocket] = field(default_factory=list)

    # Lazily created when the first subscriber joins.
    provider_stream: StreamingSession | None = None

    # The user_id of the CHW whose device is the audio source.
    # Used for speaker-role attribution (CHW = primary audio sender).
    # None until the CHW connects and sends audio.
    chw_user_id: UUID | None = None

    # Protects mutations to subscribers + provider_stream.
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


@dataclass
class Subscription:
    """Handle returned to the WebSocket endpoint for cleanup bookkeeping."""

    session_id: UUID
    websocket: WebSocket


# ---------------------------------------------------------------------------
# Hub
# ---------------------------------------------------------------------------


async def _persist_transcript_chunk(session_id: UUID, payload: dict) -> None:
    """INSERT one final transcript chunk into ``session_transcripts``.

    Uses a fresh ``AsyncSession`` per call so the long-lived WebSocket loop
    never shares a DB connection across await boundaries.

    Failures are caught and logged without re-raising — a DB hiccup must not
    interrupt the live fan-out stream.

    HIPAA: ``text`` (PHI) is never included in log output.
    """
    from app.database import async_session
    from app.models.session import SessionTranscript

    chunk_id = uuid.uuid4()
    try:
        # Build the row + commit inside the same try so a malformed payload
        # (e.g., missing 'text') is treated as any other persist failure:
        # log the type name + IDs only (never the payload contents — PHI),
        # then return cleanly so the live fan-out stream is not interrupted.
        row = SessionTranscript(
            id=chunk_id,
            session_id=session_id,
            speaker_label=payload.get("speaker_label"),
            speaker_role=payload.get("speaker_role"),
            speaker_user_id=payload.get("speaker_user_id"),
            text=payload["text"],
            is_final=payload.get("is_final", True),
            confidence=payload.get("confidence"),
            started_at_ms=payload.get("started_at_ms"),
            ended_at_ms=payload.get("ended_at_ms"),
        )
        async with async_session() as db:
            db.add(row)
            await db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.error(
            "transcript persist failed session=%s chunk_id=%s: %s",
            session_id,
            chunk_id,
            type(exc).__name__,
        )


def _resolve_api_key() -> str:
    """Return the AssemblyAI API key from settings, empty string if absent.

    Reads from ``app.config.settings`` first (populated from .env / env vars),
    then falls back to the raw environment variable so tests that set
    ``ASSEMBLYAI_API_KEY`` directly also work.
    """
    try:
        from app.config import settings
        key: str = getattr(settings, "assemblyai_api_key", "") or ""
        if key:
            return key
    except Exception as exc:  # noqa: BLE001
        logger.debug("settings import for assemblyai key failed: %s (falling back to env)", type(exc).__name__)
    return os.environ.get("ASSEMBLYAI_API_KEY", "")


class TranscriptHub:
    """In-process fan-out registry for session transcript subscribers.

    One instance is created at module level and lives for the process lifetime.

    Thread-safety: uses asyncio.Lock per session — compatible with FastAPI's
    event loop (single-threaded async). Do NOT call from sync threads.

    Provider selection:
    - ``ASSEMBLYAI_API_KEY`` is set  → ``AssemblyAIStreamingSession``
    - ``ASSEMBLYAI_API_KEY`` is unset → ``NoOpStreamingSession`` (local dev,
      logs a one-time warning at startup)

    TODO(phase-3): This singleton is not safe across multiple uvicorn
      workers. If --workers > 1 (or if gunicorn spawns multiple processes),
      each worker maintains its own isolated hub — fan-out breaks silently.
      For now, run with a single worker: ``uvicorn app.main:app --workers 1``
      Switching to Redis Pub/Sub (or a shared message broker) lifts this
      restriction without changing the public interface.
    """

    def __init__(self) -> None:
        # Map from session_id → _SessionState. The outer dict itself is only
        # mutated under _global_lock; individual _SessionState mutations use
        # per-session locks.
        self._sessions: dict[UUID, _SessionState] = {}
        self._global_lock: asyncio.Lock = asyncio.Lock()
        # Resolved once at first use so tests that patch the env var see the
        # updated value rather than a stale module-level snapshot.
        self._api_key: str | None = None

    def _get_api_key(self) -> str:
        """Return the cached API key, resolving it once on first call."""
        if self._api_key is None:
            self._api_key = _resolve_api_key()
            if not self._api_key:
                logger.warning(
                    "ASSEMBLYAI_API_KEY is not set — transcript hub will use "
                    "NoOpStreamingSession (audio discarded, no transcripts). "
                    "Set the key in .env to enable live transcription."
                )
        return self._api_key

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def subscribe(self, session_id: UUID, websocket: WebSocket) -> Subscription:
        """Register a WebSocket as a subscriber. Returns handle for cleanup.

        Idempotent — connecting the same socket twice is a no-op (the second
        call finds it already in the list).
        """
        state = await self._get_or_create_state(session_id)
        async with state.lock:
            if websocket not in state.subscribers:
                state.subscribers.append(websocket)
        logger.info(
            "transcript subscriber added session=%s total=%d",
            session_id,
            len(state.subscribers),
        )
        return Subscription(session_id=session_id, websocket=websocket)

    async def publish(self, session_id: UUID, payload: dict) -> None:
        """Send payload to every subscribed WebSocket on this session.

        If the chunk is final (``is_final=True``), it is also persisted to
        ``session_transcripts`` via ``_persist_transcript_chunk``.  The persist
        call is fire-and-forget: failures are logged but never propagated to
        callers, so a DB hiccup cannot interrupt the live stream.

        Failed sends are logged and the failed subscriber is dropped without
        raising — one broken connection must not interrupt others.

        HIPAA: payload dict contains transcript text (PHI). We log only
        metadata (session_id, subscriber count) — never the text itself.
        """
        state = self._sessions.get(session_id)
        if state is None:
            return

        # Persist final chunks to the audit table before fan-out so the record
        # exists even if all WebSocket sends fail.
        if payload.get("is_final"):
            asyncio.create_task(
                _persist_transcript_chunk(session_id, payload),
                name=f"transcript-persist-{session_id}",
            )

        envelope = {"type": "transcript_chunk", **payload}
        raw = json.dumps(envelope)

        dead: list[WebSocket] = []
        async with state.lock:
            targets = list(state.subscribers)  # snapshot under lock

        for ws in targets:
            try:
                await ws.send_text(raw)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "transcript send failed session=%s — dropping subscriber: %s",
                    session_id,
                    type(exc).__name__,
                )
                dead.append(ws)

        if dead:
            async with state.lock:
                for ws in dead:
                    state.subscribers.remove(ws)

    async def get_or_create_provider_stream(
        self,
        session_id: UUID,
        role: str = "chw",
    ) -> StreamingSession:
        """Lazy-create the provider streaming session for a given session and speaker role.

        The dual-stream backend (``compass-wt-dual-stream-backend``) will replace
        this implementation with per-role keying so each role ("chw" | "member")
        gets its own independent AssemblyAI streaming session.  Until that branch
        is merged, this shim accepts the ``role`` parameter for API compatibility
        but maps all audio to a single shared stream keyed only on ``session_id``
        (Phase 2 behaviour, unchanged).

        When the dual-stream backend is merged, this method will:
          - key provider streams on (session_id, role)
          - tag every chunk payload with ``speaker_role=role``
          - allow the hub's publish path to route transcripts with authoritative
            speaker attribution

        Args:
            session_id: Compass session UUID the audio belongs to.
            role:       Speaker role — "chw" or "member".  Validated by the WS
                        auth layer; any value arriving here is already known-good.

        Returns:
            A ``StreamingSession`` that accepts ``send_audio(chunk)`` calls.

        Provider selection (Phase 2 behaviour, pending dual-stream refactor):
        - ``AssemblyAIStreamingSession`` when the API key is available.
        - ``NoOpStreamingSession`` otherwise (graceful degrade for local dev).
        """
        # Phase 2: log the role for observability so we can verify per-leg
        # routing is working end-to-end before the dual-stream backend lands.
        logger.debug(
            "get_or_create_provider_stream session=%s role=%s (Phase 2: single shared stream)",
            session_id,
            role,
        )

        state = await self._get_or_create_state(session_id)
        async with state.lock:
            if state.provider_stream is not None:
                return state.provider_stream

            api_key = self._get_api_key()

            if api_key:
                session = AssemblyAIStreamingSession(
                    session_id=session_id,
                    api_key=api_key,
                    on_transcript_chunk=self._make_chunk_callback(session_id),
                )
                try:
                    await session.start()
                except Exception as exc:  # noqa: BLE001
                    logger.error(
                        "assemblyai session start failed session=%s role=%s error_type=%s — "
                        "falling back to NoOpStreamingSession",
                        session_id,
                        role,
                        type(exc).__name__,
                    )
                    # Fall back to no-op so the WebSocket stays open
                    # and the UI doesn't see a hard failure.
                    session = NoOpStreamingSession()
                state.provider_stream = session
                logger.info(
                    "assemblyai provider stream created session=%s role=%s",
                    session_id,
                    role,
                )
            else:
                noop = NoOpStreamingSession()
                state.provider_stream = noop
                logger.info(
                    "noop provider stream created (no API key) session=%s role=%s",
                    session_id,
                    role,
                )

            return state.provider_stream

    async def close_session(self, session_id: UUID) -> None:
        """Tear down provider stream and disconnect all subscribers.

        Idempotent — calling on a session that no longer exists is a no-op.
        """
        async with self._global_lock:
            state = self._sessions.pop(session_id, None)

        if state is None:
            return

        async with state.lock:
            if state.provider_stream is not None:
                try:
                    await state.provider_stream.close()
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "provider stream close error session=%s: %s",
                        session_id,
                        type(exc).__name__,
                    )

            close_code = 1001  # Going Away — server-initiated
            for ws in state.subscribers:
                try:
                    await ws.close(code=close_code)
                except Exception:  # noqa: BLE001, S110 — websocket may already be closed; nothing to log
                    pass  # Already closed — fine

        logger.info("transcript session closed session=%s", session_id)

    async def remove_subscriber(self, subscription: Subscription) -> None:
        """Remove a single subscriber, closing the session if it's the last one.

        Called from the WebSocket endpoint's finally block.
        """
        session_id = subscription.session_id
        websocket = subscription.websocket

        state = self._sessions.get(session_id)
        if state is None:
            return

        async with state.lock:
            try:
                state.subscribers.remove(websocket)
            except ValueError:
                pass  # Already removed (e.g., dropped due to failed send)
            remaining = len(state.subscribers)

        logger.info(
            "transcript subscriber removed session=%s remaining=%d",
            session_id,
            remaining,
        )

        if remaining == 0:
            await self.close_session(session_id)

    def set_chw_user_id(self, session_id: UUID, user_id: UUID) -> None:
        """Record which user_id is the CHW audio source for speaker attribution.

        Non-async: only mutates a UUID field; no lock needed for single
        assignment (Python GIL + asyncio single-thread guarantees atomicity
        here). Called once when the CHW connection is accepted.
        """
        state = self._sessions.get(session_id)
        if state is not None:
            state.chw_user_id = user_id

    def get_chw_user_id(self, session_id: UUID) -> UUID | None:
        """Return the CHW user_id for this session, or None if not yet set."""
        state = self._sessions.get(session_id)
        return state.chw_user_id if state else None

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _get_or_create_state(self, session_id: UUID) -> _SessionState:
        """Return the _SessionState for session_id, creating it if absent."""
        async with self._global_lock:
            if session_id not in self._sessions:
                self._sessions[session_id] = _SessionState()
            return self._sessions[session_id]

    def _make_chunk_callback(
        self,
        session_id: UUID,
    ) -> TranscriptChunkCallback:
        """Return an async callable that publishes a chunk to all subscribers."""

        async def _bound(sid: UUID, payload: dict) -> None:  # noqa: ARG001
            await self.publish(session_id, payload)

        return _bound


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

# TODO(phase-3): This singleton is process-local. If uvicorn is started with
#   --workers N (N > 1), each worker has its own TranscriptHub and fan-out
#   between workers is broken. For Phase 2, always run with --workers 1.
#   Phase 3 replaces this with a Redis-backed broadcast channel.
transcript_hub = TranscriptHub()

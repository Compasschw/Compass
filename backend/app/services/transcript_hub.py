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
    """Real-time transcription via AssemblyAI RealtimeTranscriber.

    Opens a WebSocket to AssemblyAI on construction (via ``start()``).
    Binary PCM frames are forwarded through ``send_audio()``.

    Transcript callbacks are registered at construction time via
    ``on_transcript_chunk``. The callback fires for **every** turn the
    SDK delivers — partials and finals. Partial chunks are fanned out
    to subscribers immediately so the UI shows live captions; final
    chunks are also persisted by the hub's publish path.

    AssemblyAI SDK version target: assemblyai >= 0.63.0.
    Uses ``aai.RealtimeTranscriber`` (the stable streaming interface in
    the 0.63.x series). The v3 ``StreamingClient`` API described in
    the AssemblyAI v3 docs applies to a *different* SDK major version
    that has not yet landed in the 0.x series; we target what the
    pyproject.toml actually pins.

    HIPAA:
    - Audio bytes passed to ``send_audio`` are NEVER logged.
    - Transcript text is NEVER logged — only metadata (session_id,
      chunk counts, timing, error types) appears in log lines.
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
        self._transcriber: object | None = None
        self._chunk_count: int = 0
        self._started_at: float = time.monotonic()
        # Event loop captured in start() — used by the SDK's background thread
        # to dispatch callbacks via run_coroutine_threadsafe.
        self._loop: asyncio.AbstractEventLoop | None = None

    async def start(self) -> None:
        """Open the AssemblyAI WebSocket and begin receiving transcripts.

        Called once by the hub before the first audio frame is sent.
        Runs ``transcriber.connect()`` in a thread pool so the event loop
        is not blocked during the WebSocket handshake (which can take
        50–300 ms).

        Raises:
            RuntimeError: If the SDK is not installed or the WebSocket
                          handshake fails.
        """
        try:
            import assemblyai as aai  # type: ignore[import-untyped]
        except ImportError as exc:
            raise RuntimeError(
                "assemblyai SDK is not installed. "
                "Add 'assemblyai>=0.63.0' to pyproject.toml and re-install."
            ) from exc

        # Capture the running event loop now, while we are inside a coroutine.
        # The SDK's background thread uses this reference to submit callbacks
        # via run_coroutine_threadsafe.
        self._loop = asyncio.get_running_loop()

        aai.settings.api_key = self._api_key
        session_id = self._session_id  # capture for callbacks (avoids closure over self)

        def _on_data(transcript: object) -> None:
            """Synchronous callback fired by the SDK for each transcript event.

            The SDK calls this on its internal thread.  We schedule the async
            fan-out onto the event loop via ``asyncio.run_coroutine_threadsafe``
            so it doesn't block the SDK's receive loop.
            """
            # The SDK delivers both RealtimePartialTranscript and
            # RealtimeFinalTranscript objects here.  Both have .text and .words.
            text: str = getattr(transcript, "text", "") or ""
            if not text:
                # Silence / empty partial — skip to avoid noisy fan-out.
                return

            words = getattr(transcript, "words", None) or []
            is_final: bool = hasattr(transcript, "created") and not isinstance(
                transcript,
                aai.RealtimePartialTranscript,  # type: ignore[attr-defined]
            )

            # Derive timing from word-level offsets (milliseconds).
            started_at_ms: int = int(words[0].start) if words else 0
            ended_at_ms: int = int(words[-1].end) if words else 0

            # Confidence is per-word average when available; fall back to 0.
            if words:
                confidences = [getattr(w, "confidence", 0.0) or 0.0 for w in words]
                confidence = sum(confidences) / len(confidences)
            else:
                confidence = 0.0

            payload: dict = {
                # Phase 2: single-mic — speaker diarization deferred to Phase 3.
                # AssemblyAI streaming returns speaker labels only when
                # diarization is enabled; we leave that off for v1.
                "speaker_label": None,
                "speaker_role": "unknown",
                "text": text,
                "is_final": is_final,
                "confidence": round(confidence, 4),
                "started_at_ms": started_at_ms,
                "ended_at_ms": ended_at_ms,
            }

            # Dispatch the async callback onto the event loop.
            #
            # Two cases:
            # 1. Production: the SDK calls _on_data on its internal I/O thread
            #    (outside the event loop). We use run_coroutine_threadsafe to
            #    safely submit the coroutine from that foreign thread.
            # 2. Tests: _on_data is called directly from within a test coroutine
            #    (i.e., from the running event loop). In that case
            #    get_running_loop() succeeds and we use ensure_future so the
            #    coroutine is scheduled as an asyncio.Task on the same loop.
            try:
                running_loop = asyncio.get_running_loop()
                # We are inside the event loop — schedule as a Task.
                asyncio.ensure_future(
                    self._on_chunk(session_id, payload),
                    loop=running_loop,
                )
            except RuntimeError:
                # No running loop in this thread — we are on a background thread.
                # Try to get the loop that owns this session via the stored reference.
                try:
                    loop = self._loop
                except AttributeError:
                    logger.error(
                        "assemblyai callback: event loop unavailable session=%s",
                        session_id,
                    )
                    return
                if loop is None or loop.is_closed():
                    logger.error(
                        "assemblyai callback: event loop closed session=%s",
                        session_id,
                    )
                    return
                asyncio.run_coroutine_threadsafe(
                    self._on_chunk(session_id, payload),
                    loop,
                )

        def _on_error(error: object) -> None:
            """Log provider-side errors without exposing transcript content."""
            logger.error(
                "assemblyai streaming error session=%s error_type=%s",
                session_id,
                type(error).__name__,
            )

        def _create_and_connect() -> object:
            transcriber = aai.RealtimeTranscriber(  # type: ignore[attr-defined]
                sample_rate=_STREAMING_SAMPLE_RATE,
                on_data=_on_data,
                on_error=_on_error,
            )
            transcriber.connect()
            return transcriber

        self._transcriber = await asyncio.to_thread(_create_and_connect)
        logger.info(
            "assemblyai streaming session opened session=%s",
            self._session_id,
        )

    async def send_audio(self, chunk: bytes) -> None:
        """Forward a 16-bit PCM chunk to the open RealtimeTranscriber.

        Audio content is NEVER logged — it is PHI.
        """
        if self._transcriber is None:
            logger.warning(
                "send_audio called before transcriber is connected session=%s",
                self._session_id,
            )
            return

        transcriber = self._transcriber

        def _stream() -> None:
            transcriber.stream(chunk)  # type: ignore[attr-defined]

        await asyncio.to_thread(_stream)
        self._chunk_count += 1

    async def close(self) -> None:
        """Flush buffered audio and cleanly disconnect from AssemblyAI.

        Runs ``transcriber.close()`` in a thread pool — the SDK call blocks
        while it flushes pending audio and waits for final segments.
        """
        if self._transcriber is None:
            return

        transcriber = self._transcriber
        self._transcriber = None  # prevent double-close

        def _close() -> None:
            try:
                transcriber.close()  # type: ignore[attr-defined]
            except Exception as exc:  # noqa: BLE001
                # SDK may raise if connection was already dropped by the server.
                logger.debug("assemblyai transcriber close raised %s (ignored)", type(exc).__name__)

        try:
            await asyncio.to_thread(_close)
        except Exception as exc:  # noqa: BLE001
            logger.debug("assemblyai close thread raised %s (ignored)", type(exc).__name__)

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

    async def get_or_create_provider_stream(self, session_id: UUID) -> StreamingSession:
        """Lazy-create the provider streaming session on first audio frame.

        The provider is started exactly once per session_id; subsequent calls
        return the same instance. This is safe because _SessionState.lock
        serialises creation.

        Provider selection:
        - ``AssemblyAIStreamingSession`` when the API key is available.
        - ``NoOpStreamingSession`` otherwise (graceful degrade for local dev).
        """
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
                        "assemblyai session start failed session=%s error_type=%s — "
                        "falling back to NoOpStreamingSession",
                        session_id,
                        type(exc).__name__,
                    )
                    # Fall back to no-op so the WebSocket stays open
                    # and the UI doesn't see a hard failure.
                    session = NoOpStreamingSession()
                state.provider_stream = session
                logger.info(
                    "assemblyai provider stream created session=%s",
                    session_id,
                )
            else:
                noop = NoOpStreamingSession()
                state.provider_stream = noop
                logger.info(
                    "noop provider stream created (no API key) session=%s",
                    session_id,
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

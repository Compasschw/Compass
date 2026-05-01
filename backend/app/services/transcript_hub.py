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
import time
import uuid
from dataclasses import dataclass, field
from typing import TYPE_CHECKING
from uuid import UUID

from fastapi import WebSocket

if TYPE_CHECKING:
    from app.services.transcript_hub import StreamingSession  # avoid circular

logger = logging.getLogger("compass.transcript_hub")

# ---------------------------------------------------------------------------
# Streaming provider abstraction
# ---------------------------------------------------------------------------


class StreamingSession:
    """Contract for a real-time audio → chunk provider session.

    This base class is the stub that lives until the sister agent wires in
    AssemblyAI's streaming WebSocket (assemblyai-python-sdk v3 ``Transcriber``).

    TODO(assemblyai-streaming): Replace MockStreamingSession with a real
      implementation that:
        1. Opens a WebSocket to wss://api.assemblyai.com/v3/realtime/ws
        2. Forwards audio bytes verbatim via ``send_audio(chunk)``
        3. Fires ``on_transcript_chunk`` for each partial + final segment
      Keep this ABC in place so the hub doesn't care which provider runs.
    """

    async def send_audio(self, chunk: bytes) -> None:  # noqa: ARG002
        """Forward a raw PCM chunk to the provider's streaming session."""

    async def close(self) -> None:
        """Terminate the provider streaming session."""


class MockStreamingSession(StreamingSession):
    """Emits fake transcript chunks every 2 s for end-to-end testing.

    Maintains an internal counter so each chunk carries a unique label.
    The callback fires with a dict that mirrors the wire format the hub
    publishes to subscribers, minus the ``type`` envelope (hub wraps it).

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
# Type aliases
# ---------------------------------------------------------------------------

TranscriptChunkCallback = "type[Callable[[UUID, dict], Awaitable[None]]]"


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

    row = SessionTranscript(
        id=uuid.uuid4(),
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

    try:
        async with async_session() as db:
            db.add(row)
            await db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.error(
            "transcript persist failed session=%s chunk_id=%s: %s",
            session_id,
            row.id,
            type(exc).__name__,
        )


class TranscriptHub:
    """In-process fan-out registry for session transcript subscribers.

    One instance is created at module level and lives for the process lifetime.

    Thread-safety: uses asyncio.Lock per session — compatible with FastAPI's
    event loop (single-threaded async). Do NOT call from sync threads.

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
        """Lazy-create the provider streaming session on first subscriber.

        The provider is started exactly once per session_id; subsequent calls
        return the same instance. This is safe because _SessionState.lock
        serialises creation.

        TODO(assemblyai-streaming): Swap MockStreamingSession for a real
          AssemblyAI streaming session once the streaming API key and SDK
          wiring are in place. The real implementation should call:
            from app.services.transcription import get_transcription_provider
            provider = get_transcription_provider()
            return await provider.open_streaming_session(
                session_id=session_id,
                on_chunk=self._make_chunk_callback(session_id),
            )
          Keep the same return-type contract (StreamingSession).
        """
        state = await self._get_or_create_state(session_id)
        async with state.lock:
            if state.provider_stream is None:
                mock = MockStreamingSession(
                    session_id=session_id,
                    on_transcript_chunk=self._make_chunk_callback(session_id),
                )
                mock.start()
                state.provider_stream = mock
                logger.info(
                    "mock streaming session started session=%s",
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
    ):
        """Return an async callable that publishes a chunk to all subscribers."""

        async def _callback(sid: UUID, payload: dict) -> None:
            await self.publish(sid, payload)

        # Bind session_id into a trivial wrapper so the mock can call it
        # without knowing about the hub.
        async def _bound(sid: UUID, payload: dict) -> None:
            await _callback(session_id, payload)

        return _bound


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

# TODO(phase-3): This singleton is process-local. If uvicorn is started with
#   --workers N (N > 1), each worker has its own TranscriptHub and fan-out
#   between workers is broken. For Phase 2, always run with --workers 1.
#   Phase 3 replaces this with a Redis-backed broadcast channel.
transcript_hub = TranscriptHub()

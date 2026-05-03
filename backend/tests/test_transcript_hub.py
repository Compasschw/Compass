"""Tests for the in-process transcript fan-out hub.

Covers:
- MockStreamingSession lifecycle (start / stop / chunk format)
- TranscriptHub subscriber management (add, share, fan-out, remove)
- _persist_transcript_chunk (DB write success and silent failure)
- PHI log hygiene (transcript text must never appear in log lines)

These guard session cost and HIPAA compliance: a leaked task burns money and
a logged ``text`` field is a confidentiality boundary failure.
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy import select

from app.models.session import SessionTranscript
from app.services.transcript_hub import (
    MockStreamingSession,
    Subscription,
    TranscriptHub,
    _SessionState,
    _persist_transcript_chunk,
)
from tests.conftest import test_session as _test_session_factory

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_ws() -> AsyncMock:
    """Return a mock WebSocket with an async send_text."""
    ws = AsyncMock()
    ws.send_text = AsyncMock()
    ws.close = AsyncMock()
    return ws


def _make_hub() -> TranscriptHub:
    """Return a fresh, isolated TranscriptHub instance for each test."""
    return TranscriptHub()


def _make_chunk_payload(n: int = 1) -> dict[str, Any]:
    return {
        "speaker_label": "A" if n % 2 == 0 else "B",
        "speaker_role": "unknown",
        "text": f"[test chunk {n}]",
        "is_final": True,
        "confidence": 0.95,
        "started_at_ms": 1000,
        "ended_at_ms": 2000,
    }


# ---------------------------------------------------------------------------
# Seed helpers for DB tests (session_transcripts FK chain requires a real
# sessions row which in turn requires users + service_requests rows).
# ---------------------------------------------------------------------------


async def _seed_session_row(db_session) -> uuid.UUID:
    """Insert the minimum FK chain and return a valid sessions.id."""
    from app.models.request import ServiceRequest
    from app.models.session import Session
    from app.models.user import User

    chw = User(
        id=uuid.uuid4(),
        email=f"chw-{uuid.uuid4().hex[:6]}@test.com",
        password_hash="hash",
        role="chw",
        name="Test CHW",
    )
    member = User(
        id=uuid.uuid4(),
        email=f"member-{uuid.uuid4().hex[:6]}@test.com",
        password_hash="hash",
        role="member",
        name="Test Member",
    )
    db_session.add_all([chw, member])
    await db_session.flush()

    request = ServiceRequest(
        id=uuid.uuid4(),
        member_id=member.id,
        matched_chw_id=chw.id,
        vertical="mental_health",
        urgency="routine",
        description="test",
        preferred_mode="video",
    )
    db_session.add(request)
    await db_session.flush()

    session = Session(
        id=uuid.uuid4(),
        request_id=request.id,
        chw_id=chw.id,
        member_id=member.id,
        vertical="mental_health",
        mode="video",
    )
    db_session.add(session)
    await db_session.commit()
    return session.id


# ===========================================================================
# 1. MockStreamingSession.start() begins emitting; close() stops it
# ===========================================================================


class TestMockStreamingSession:
    async def test_start_emits_and_close_stops(self, monkeypatch):
        """close() must stop the emission loop within a short time window.

        We monkeypatch asyncio.sleep so the 2-second cadence collapses to
        zero, making the test deterministic and instant.
        """
        received: list[dict] = []
        session_id = uuid.uuid4()

        original_sleep = asyncio.sleep

        async def fast_sleep(delay: float) -> None:  # noqa: ARG001
            # Yield control once per tick without blocking 2 seconds
            await original_sleep(0)

        monkeypatch.setattr(asyncio, "sleep", fast_sleep)

        async def on_chunk(sid: uuid.UUID, payload: dict) -> None:
            received.append(payload)

        mock = MockStreamingSession(session_id=session_id, on_transcript_chunk=on_chunk)
        mock.start()
        # Let the loop fire several chunks
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        await asyncio.sleep(0)

        chunks_before_close = len(received)
        assert chunks_before_close >= 1, "Expected at least one chunk before close"

        await mock.close()

        # Drain any remaining pending callbacks
        await asyncio.sleep(0)
        chunks_after_close = len(received)

        # After close, no more chunks should arrive
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert len(received) == chunks_after_close, "No chunks expected after close()"

    # -----------------------------------------------------------------------
    # 2. Chunk format: incrementing counter and alternating speaker label
    # -----------------------------------------------------------------------

    async def test_chunk_counter_and_speaker_label_alternate(self, monkeypatch):
        """Each emitted chunk has a monotonically incrementing counter and
        the speaker_label alternates B/A (odd=B, even=A)."""
        received: list[dict] = []
        session_id = uuid.uuid4()

        original_sleep = asyncio.sleep

        async def fast_sleep(delay: float) -> None:  # noqa: ARG001
            await original_sleep(0)

        monkeypatch.setattr(asyncio, "sleep", fast_sleep)

        async def on_chunk(sid: uuid.UUID, payload: dict) -> None:
            received.append(payload)

        mock = MockStreamingSession(session_id=session_id, on_transcript_chunk=on_chunk)
        mock.start()

        # Spin until we have at least 4 chunks to validate the pattern
        for _ in range(20):
            await asyncio.sleep(0)
            if len(received) >= 4:
                break

        await mock.close()

        assert len(received) >= 4, "Need at least 4 chunks to validate alternation"
        for idx, chunk in enumerate(received):
            n = idx + 1  # 1-based counter
            expected_label = "B" if n % 2 != 0 else "A"
            assert chunk["speaker_label"] == expected_label, (
                f"Chunk {n}: expected speaker_label={expected_label!r}, "
                f"got {chunk['speaker_label']!r}"
            )
            assert f"[mock chunk {n}]" in chunk["text"]


# ===========================================================================
# 3. Adding a subscriber to an empty session creates _SessionState +
#    starts the provider stream.
# ===========================================================================


class TestTranscriptHubSubscribe:
    async def test_first_subscriber_creates_state(self):
        hub = _make_hub()
        session_id = uuid.uuid4()
        ws = _make_ws()

        subscription = await hub.subscribe(session_id, ws)

        assert session_id in hub._sessions
        state = hub._sessions[session_id]
        assert isinstance(state, _SessionState)
        assert ws in state.subscribers
        assert isinstance(subscription, Subscription)
        assert subscription.session_id == session_id
        assert subscription.websocket is ws

    async def test_first_subscriber_can_start_provider_stream(self):
        hub = _make_hub()
        session_id = uuid.uuid4()
        ws = _make_ws()

        await hub.subscribe(session_id, ws)
        stream = await hub.get_or_create_provider_stream(session_id)

        assert stream is not None
        assert isinstance(stream, MockStreamingSession)

        # Teardown: prevent leaked background task
        await hub.close_session(session_id)

    # -----------------------------------------------------------------------
    # 4. Multiple subscribers share ONE _SessionState and ONE provider stream
    # -----------------------------------------------------------------------

    async def test_multiple_subscribers_share_single_state(self):
        hub = _make_hub()
        session_id = uuid.uuid4()
        ws1, ws2 = _make_ws(), _make_ws()

        await hub.subscribe(session_id, ws1)
        await hub.subscribe(session_id, ws2)

        assert len(hub._sessions) == 1, "Must have exactly one _SessionState"
        state = hub._sessions[session_id]
        assert ws1 in state.subscribers
        assert ws2 in state.subscribers

    async def test_multiple_subscribers_share_single_provider_stream(self):
        hub = _make_hub()
        session_id = uuid.uuid4()
        ws1, ws2 = _make_ws(), _make_ws()

        await hub.subscribe(session_id, ws1)
        await hub.subscribe(session_id, ws2)
        stream1 = await hub.get_or_create_provider_stream(session_id)
        stream2 = await hub.get_or_create_provider_stream(session_id)

        assert stream1 is stream2, "Both calls must return the same provider instance"

        await hub.close_session(session_id)

    # -----------------------------------------------------------------------
    # 5. A chunk from the provider is fanned out to ALL subscribers
    # -----------------------------------------------------------------------

    async def test_publish_fans_out_to_all_subscribers(self):
        hub = _make_hub()
        session_id = uuid.uuid4()
        ws1, ws2, ws3 = _make_ws(), _make_ws(), _make_ws()

        await hub.subscribe(session_id, ws1)
        await hub.subscribe(session_id, ws2)
        await hub.subscribe(session_id, ws3)

        payload = _make_chunk_payload(1)
        # Patch out persist so we don't touch the DB
        with patch(
            "app.services.transcript_hub._persist_transcript_chunk",
            new=AsyncMock(),
        ):
            await hub.publish(session_id, payload)

        for ws in (ws1, ws2, ws3):
            ws.send_text.assert_awaited_once()
            sent_arg = ws.send_text.call_args[0][0]
            assert "transcript_chunk" in sent_arg
            assert "[test chunk 1]" in sent_arg


# ===========================================================================
# 6. remove_subscriber: removing one of two leaves the stream running
# ===========================================================================


class TestRemoveSubscriber:
    async def test_remove_one_of_two_leaves_stream_alive(self):
        hub = _make_hub()
        session_id = uuid.uuid4()
        ws1, ws2 = _make_ws(), _make_ws()

        sub1 = await hub.subscribe(session_id, ws1)
        await hub.subscribe(session_id, ws2)
        stream = await hub.get_or_create_provider_stream(session_id)

        await hub.remove_subscriber(sub1)

        # Session state must still exist for ws2
        assert session_id in hub._sessions
        state = hub._sessions[session_id]
        assert ws1 not in state.subscribers
        assert ws2 in state.subscribers
        # Provider stream must still be the same running instance
        assert state.provider_stream is stream

        await hub.close_session(session_id)

    # -----------------------------------------------------------------------
    # 7. remove_subscriber: removing the LAST subscriber closes provider +
    #    cleans up state
    # -----------------------------------------------------------------------

    async def test_remove_last_subscriber_closes_provider_and_cleans_state(self):
        hub = _make_hub()
        session_id = uuid.uuid4()
        ws = _make_ws()

        subscription = await hub.subscribe(session_id, ws)
        stream = await hub.get_or_create_provider_stream(session_id)

        # Spy on the provider's close method
        original_close = stream.close
        close_called = False

        async def spy_close() -> None:
            nonlocal close_called
            close_called = True
            await original_close()

        stream.close = spy_close

        await hub.remove_subscriber(subscription)

        assert close_called, "Provider stream.close() must be called on last removal"
        assert session_id not in hub._sessions, (
            "_sessions must drop the entry after last subscriber leaves"
        )


# ===========================================================================
# 8. _persist_transcript_chunk: row is inserted for a valid payload
# ===========================================================================


class TestPersistTranscriptChunk:
    async def test_persist_inserts_row(self):
        """A valid payload produces a committed row in session_transcripts."""
        async with _test_session_factory() as db:
            session_id = await _seed_session_row(db)

        payload = {
            "speaker_label": "A",
            "speaker_role": "chw",
            "text": "Hello from CHW",
            "is_final": True,
            "confidence": 0.98,
            "started_at_ms": 100,
            "ended_at_ms": 1500,
        }

        await _persist_transcript_chunk(session_id, payload)

        async with _test_session_factory() as db:
            result = await db.execute(
                select(SessionTranscript).where(
                    SessionTranscript.session_id == session_id
                )
            )
            row = result.scalar_one_or_none()

        assert row is not None, "Expected a persisted SessionTranscript row"
        assert row.session_id == session_id
        assert row.text == "Hello from CHW"
        assert row.speaker_label == "A"

    # -----------------------------------------------------------------------
    # 9. _persist_transcript_chunk: bad payload doesn't propagate (silent fail)
    # -----------------------------------------------------------------------

    async def test_persist_bad_payload_does_not_propagate(self, caplog):
        """A KeyError on missing 'text' must be caught; no exception escapes."""
        import logging

        session_id = uuid.uuid4()
        bad_payload: dict = {
            "speaker_label": "A",
            # "text" intentionally omitted — triggers KeyError in the SUT
        }

        with caplog.at_level(logging.ERROR, logger="compass.transcript_hub"):
            # Must not raise
            await _persist_transcript_chunk(session_id, bad_payload)

        # The error must be logged (the SUT catches and logs)
        error_lines = [r for r in caplog.records if r.levelno >= logging.ERROR]
        assert error_lines, "Expected at least one ERROR log entry on persist failure"

    # -----------------------------------------------------------------------
    # 10. PHI log check: error log lines must NOT contain transcript text
    # -----------------------------------------------------------------------

    async def test_persist_error_log_does_not_contain_phi_text(self, caplog):
        """Even on failure, the log line must never contain PHI text content.

        The SUT logs only session_id, chunk_id, and exception type — never
        the actual transcript text.
        """
        import logging

        session_id = uuid.uuid4()
        # A payload with a real text value that would be PHI
        phi_text = "Patient reports severe chest pain"
        # Trigger a DB error by passing a bad session_id (no FK row) but a
        # valid payload shape so we reach the DB call.
        bad_session_id = uuid.uuid4()  # no FK row → IntegrityError on commit
        payload = {
            "speaker_label": "B",
            "speaker_role": "member",
            "text": phi_text,
            "is_final": True,
            "confidence": 0.90,
            "started_at_ms": 0,
            "ended_at_ms": 500,
        }

        with caplog.at_level(logging.ERROR, logger="compass.transcript_hub"):
            await _persist_transcript_chunk(bad_session_id, payload)

        for record in caplog.records:
            assert phi_text not in record.getMessage(), (
                f"PHI text found in log line: {record.getMessage()!r}"
            )

"""Tests for the AI summary feature.

Coverage:
1. ``AnthropicSummarizer.summarize`` — unit test with a mocked Anthropic client,
   no real network call.
2. ``NoopSummarizer.summarize`` — always returns empty result.
3. ``get_summarizer`` factory — returns Noop when key absent, Anthropic when set.
4. POST /sessions/{id}/ai-summary endpoint — returns correct shape; returns
   empty when session status is wrong.
5. POST /sessions/{id}/documentation — persists ai_summary fields when supplied.

Pattern follows test_followup_extraction.py: async tests, DB via conftest
test_session factory, LLM providers mocked — zero external service calls.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.models.request import ServiceRequest
from app.models.session import Session, SessionDocumentation
from app.models.user import User
from app.services.transcription.summarizer import (
    AnthropicSummarizer,
    NoopSummarizer,
    SummaryResult,
    get_summarizer,
)
from tests.conftest import auth_header, test_session as _test_session_factory

# ---------------------------------------------------------------------------
# SummaryResult — pure unit (no async, no DB)
# ---------------------------------------------------------------------------


def test_summary_result_empty_has_no_text_and_no_timestamp() -> None:
    result = SummaryResult.empty()
    assert result.text == ""
    assert result.generated_at is None


def test_summary_result_populated() -> None:
    ts = datetime.now(UTC)
    result = SummaryResult(text="Summary text.", generated_at=ts)
    assert result.text == "Summary text."
    assert result.generated_at == ts


# ---------------------------------------------------------------------------
# NoopSummarizer (async unit)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_noop_summarizer_returns_empty_for_any_input() -> None:
    noop = NoopSummarizer()
    result = await noop.summarize("A full transcript of a CHW visit about housing.")
    assert result.text == ""
    assert result.generated_at is None


@pytest.mark.asyncio
async def test_noop_summarizer_returns_empty_for_short_transcript() -> None:
    noop = NoopSummarizer()
    result = await noop.summarize("")
    assert result == SummaryResult.empty()


# ---------------------------------------------------------------------------
# AnthropicSummarizer (mocked SDK client — no real network call)
#
# The Anthropic client is created inside __init__ via `import anthropic`.
# We construct the summarizer, then replace ._client with a MagicMock so the
# mock controls what messages.create returns.  This avoids brittle patch-path
# issues with the lazy `import anthropic` inside the method body.
# ---------------------------------------------------------------------------


def _make_fake_anthropic_response(text: str) -> MagicMock:
    """Build a minimal fake anthropic.types.Message with one TextBlock."""
    block = MagicMock()
    block.text = text
    response = MagicMock()
    response.content = [block]
    response.stop_reason = "end_turn"
    return response


@pytest.mark.asyncio
async def test_anthropic_summarizer_returns_summary_text() -> None:
    """AnthropicSummarizer with a mocked client returns the API response text."""
    fake_response = _make_fake_anthropic_response(
        "The member discussed housing instability and was referred to a local "
        "shelter programme. The CHW committed to following up within 48 hours."
    )

    summarizer = AnthropicSummarizer(api_key="sk-ant-fake-key")
    mock_client = MagicMock()
    mock_client.messages.create = AsyncMock(return_value=fake_response)
    summarizer._client = mock_client

    transcript = (
        "[chw] Good morning! Can you tell me about your current housing situation?\n"
        "[member] I have been struggling to pay rent and may face eviction next month.\n"
        "[chw] I understand. Let me refer you to the local shelter programme."
    )
    result = await summarizer.summarize(transcript, vertical="housing")

    assert result.text.startswith("The member discussed")
    assert result.generated_at is not None
    mock_client.messages.create.assert_called_once()
    call_kwargs = mock_client.messages.create.call_args.kwargs
    assert call_kwargs["model"] == "claude-haiku-4-5"
    assert call_kwargs["max_tokens"] == 500


@pytest.mark.asyncio
async def test_anthropic_summarizer_empty_on_short_transcript() -> None:
    """AnthropicSummarizer must NOT call the API for very short transcripts."""
    summarizer = AnthropicSummarizer(api_key="sk-ant-fake-key")
    mock_client = MagicMock()
    mock_client.messages.create = AsyncMock()
    summarizer._client = mock_client

    result = await summarizer.summarize("Hi.")

    assert result == SummaryResult.empty()
    mock_client.messages.create.assert_not_called()


@pytest.mark.asyncio
async def test_anthropic_summarizer_degrades_on_api_error() -> None:
    """AnthropicSummarizer must return empty result (not raise) on API failure."""
    summarizer = AnthropicSummarizer(api_key="sk-ant-fake-key")
    mock_client = MagicMock()
    mock_client.messages.create = AsyncMock(side_effect=RuntimeError("rate limit"))
    summarizer._client = mock_client

    long_transcript = "x " * 50  # 100 chars — above the 50-char threshold
    result = await summarizer.summarize(long_transcript)

    assert result == SummaryResult.empty()


@pytest.mark.asyncio
async def test_anthropic_summarizer_strips_summary_echo() -> None:
    """Model echoing 'Summary:' prefix is stripped from the returned text."""
    fake_response = _make_fake_anthropic_response("Summary: The member needed food.")

    summarizer = AnthropicSummarizer(api_key="sk-ant-fake-key")
    mock_client = MagicMock()
    mock_client.messages.create = AsyncMock(return_value=fake_response)
    summarizer._client = mock_client

    result = await summarizer.summarize("x " * 60)

    assert result.text == "The member needed food."
    assert not result.text.startswith("Summary:")


# ---------------------------------------------------------------------------
# get_summarizer factory
# ---------------------------------------------------------------------------


def test_get_summarizer_returns_noop_when_key_absent() -> None:
    """Factory returns NoopSummarizer when anthropic_api_key is None or empty.

    We patch ``app.config.settings`` — the object that ``get_summarizer``
    accesses via ``from app.config import settings`` inside the function body.
    """
    get_summarizer.cache_clear()
    with patch("app.config.settings") as mock_settings:
        mock_settings.anthropic_api_key = None
        result = get_summarizer()
    get_summarizer.cache_clear()
    assert isinstance(result, NoopSummarizer)


def test_get_summarizer_returns_anthropic_when_key_present() -> None:
    """Factory returns AnthropicSummarizer when anthropic_api_key is set."""
    get_summarizer.cache_clear()
    with patch("app.config.settings") as mock_settings:
        mock_settings.anthropic_api_key = "sk-ant-test-key"
        result = get_summarizer()
    get_summarizer.cache_clear()
    assert isinstance(result, AnthropicSummarizer)


# ---------------------------------------------------------------------------
# Integration: POST /sessions/{id}/ai-summary endpoint
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ai_summary_endpoint_returns_empty_for_non_completed_session(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict
) -> None:
    """Endpoint returns {"ai_summary": "", "generated_at": null} for scheduled sessions."""
    res = await client.post(
        "/api/v1/requests/",
        json={
            "vertical": "housing",
            "urgency": "routine",
            "description": "Need housing help",
            "preferred_mode": "in_person",
        },
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 201
    request_id = res.json()["id"]

    res = await client.patch(
        f"/api/v1/requests/{request_id}/accept", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200

    res = await client.post(
        "/api/v1/sessions/",
        json={
            "request_id": request_id,
            "scheduled_at": "2026-06-01T10:00:00Z",
            "mode": "in_person",
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201
    session_id = res.json()["id"]

    # Session is still "scheduled" — summariser must return empty, not 4xx/5xx.
    with patch(
        "app.services.summary_generation.get_summarizer",
        return_value=NoopSummarizer(),
    ):
        res = await client.post(
            f"/api/v1/sessions/{session_id}/ai-summary",
            headers=auth_header(chw_tokens),
        )

    assert res.status_code == 200
    body = res.json()
    assert body["ai_summary"] == ""
    assert body["generated_at"] is None


# ---------------------------------------------------------------------------
# Integration: POST /sessions/{id}/documentation persists ai_summary fields
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_documentation_persists_ai_summary_fields(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict
) -> None:
    """Submit documentation with ai_summary fields; verify they are persisted."""
    res = await client.post(
        "/api/v1/requests/",
        json={
            "vertical": "food",
            "urgency": "routine",
            "description": "Need food help",
            "preferred_mode": "in_person",
        },
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 201
    request_id = res.json()["id"]

    res = await client.patch(
        f"/api/v1/requests/{request_id}/accept", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200

    res = await client.post(
        "/api/v1/sessions/",
        json={
            "request_id": request_id,
            "scheduled_at": "2026-06-01T10:00:00Z",
            "mode": "in_person",
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201
    session_id = res.json()["id"]

    await client.patch(
        f"/api/v1/sessions/{session_id}/start", headers=auth_header(chw_tokens)
    )
    await client.patch(
        f"/api/v1/sessions/{session_id}/complete", headers=auth_header(chw_tokens)
    )

    ai_ts = "2026-05-06T12:34:56+00:00"
    doc_payload = {
        "summary": "CHW discussed food access challenges with member.",
        "diagnosis_codes": ["Z59.7"],  # Z59.7 = food insecurity (valid code)
        "procedure_code": "98960",
        "units_to_bill": 1,
        # AI summary provenance — frontend passes through from POST /ai-summary.
        "ai_summary": "The member expressed concerns about food insecurity. "
                      "The CHW referred them to the local food bank programme "
                      "and scheduled a follow-up call for next week.",
        "ai_summary_generated_at": ai_ts,
        "ai_summary_excluded": False,
    }

    res = await client.post(
        f"/api/v1/sessions/{session_id}/documentation",
        json=doc_payload,
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    doc_id = res.json()["documentation_id"]

    # Verify the fields were persisted in the database.
    async with _test_session_factory() as db:
        doc = await db.get(SessionDocumentation, uuid.UUID(doc_id))
        assert doc is not None
        # CHW-authored note is unchanged.
        assert doc.summary == "CHW discussed food access challenges with member."
        # AI fields are stored exactly as submitted.
        assert doc.ai_summary is not None
        assert "food insecurity" in doc.ai_summary
        assert doc.ai_summary_generated_at is not None
        assert doc.ai_summary_excluded is False


@pytest.mark.asyncio
async def test_documentation_persists_without_ai_summary(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict
) -> None:
    """Submitting without ai_summary is valid (backwards-compatible with old clients)."""
    res = await client.post(
        "/api/v1/requests/",
        json={
            "vertical": "mental_health",
            "urgency": "routine",
            "description": "Mental health support",
            "preferred_mode": "in_person",
        },
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 201
    request_id = res.json()["id"]

    res = await client.patch(
        f"/api/v1/requests/{request_id}/accept", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200

    res = await client.post(
        "/api/v1/sessions/",
        json={
            "request_id": request_id,
            "scheduled_at": "2026-06-02T10:00:00Z",
            "mode": "in_person",
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201
    session_id = res.json()["id"]

    await client.patch(
        f"/api/v1/sessions/{session_id}/start", headers=auth_header(chw_tokens)
    )
    await client.patch(
        f"/api/v1/sessions/{session_id}/complete", headers=auth_header(chw_tokens)
    )

    doc_payload = {
        "summary": "Discussed coping strategies.",
        "diagnosis_codes": ["Z13.89"],
        "procedure_code": "98960",
        "units_to_bill": 1,
        # No ai_summary fields — old client behaviour.
    }

    res = await client.post(
        f"/api/v1/sessions/{session_id}/documentation",
        json=doc_payload,
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    doc_id = res.json()["documentation_id"]

    async with _test_session_factory() as db:
        doc = await db.get(SessionDocumentation, uuid.UUID(doc_id))
        assert doc is not None
        assert doc.ai_summary is None
        assert doc.ai_summary_generated_at is None
        assert doc.ai_summary_excluded is False


# ---------------------------------------------------------------------------
# Regression: AI summary across multiple CommunicationSession rows per Session
# ---------------------------------------------------------------------------
#
# Real-world reproduction: a single Compass Session can have several
# ``communication_sessions`` rows when the CHW retries the call (each
# /call-bridge attempt inserts a fresh row).  Before the fix in summary_
# generation._build_transcript_text, the fallback path used
# ``scalar_one_or_none()`` on a query that matched all of them, which
# raises ``MultipleResultsFound``; the broad try/except swallowed the
# exception and the AI summary endpoint silently returned the empty
# "AI summary unavailable" sentinel even when the freshest row had a
# perfectly good transcript on it.
#
# This test pins the fix: with two completed CommunicationSession rows
# (older one with transcript A, newer one with transcript B), the
# summarizer is invoked exactly once with transcript B.


@pytest.mark.asyncio
async def test_ai_summary_uses_newest_communication_session_transcript(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict
) -> None:
    """Verify that when a session has multiple CommunicationSession rows,
    generate_session_summary picks the most-recently-created row's
    ``transcript_text`` instead of falling through to "unavailable"."""
    from app.models.communication import CommunicationSession

    # ── Create a request + accept + session ────────────────────────────
    res = await client.post(
        "/api/v1/requests/",
        json={
            "vertical": "mental_health",
            "urgency": "routine",
            "description": "Need someone to talk to",
            "preferred_mode": "phone",
        },
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 201
    request_id = res.json()["id"]

    res = await client.patch(
        f"/api/v1/requests/{request_id}/accept", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200

    res = await client.post(
        "/api/v1/sessions/",
        json={
            "request_id": request_id,
            "scheduled_at": "2026-07-01T10:00:00Z",
            "mode": "phone",
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201
    session_id = res.json()["id"]

    # Start the session — generate_session_summary returns empty for any
    # status outside {completed, in_progress}, and a freshly created
    # session is still "scheduled".
    res = await client.patch(
        f"/api/v1/sessions/{session_id}/start", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200, res.text

    # ── Insert two CommunicationSession rows (older + newer) ──────────
    # Simulates a CHW who retried the call: each /call-bridge attempt
    # creates a fresh comm row.  The post-call finalizer stamps
    # transcript_text on each as AssemblyAI finishes.
    older_transcript = "Older attempt transcript — short call that didn't go anywhere useful."
    newer_transcript = (
        "Newer attempt transcript — full conversation about housing, food security, "
        "and follow-up steps the CHW will take next week."
    )
    older_created = datetime(2026, 7, 1, 10, 5, 0, tzinfo=UTC)
    newer_created = datetime(2026, 7, 1, 10, 15, 0, tzinfo=UTC)

    async with _test_session_factory() as db:
        db.add(
            CommunicationSession(
                session_id=uuid.UUID(session_id),
                provider="vonage",
                provider_session_id=f"compass-session-{session_id}-attempt-1",
                proxy_number="+18127224291",
                status="completed",
                transcript_text=older_transcript,
                transcript_confidence=0.78,
                created_at=older_created,
            )
        )
        db.add(
            CommunicationSession(
                session_id=uuid.UUID(session_id),
                provider="vonage",
                provider_session_id=f"compass-session-{session_id}-attempt-2",
                proxy_number="+18127224291",
                status="completed",
                transcript_text=newer_transcript,
                transcript_confidence=0.91,
                created_at=newer_created,
            )
        )
        await db.commit()

    # ── Spy on the summarizer so we can assert which transcript it saw ─
    # NoopSummarizer always returns empty; we replace it with a MagicMock
    # that returns a SummaryResult with a known text so we can both
    # verify the endpoint returns it AND inspect the input it was given.
    expected_summary = "Member discussed housing + food needs; CHW to follow up."
    spy_summarizer = MagicMock()
    spy_summarizer.summarize = AsyncMock(
        return_value=SummaryResult(text=expected_summary, generated_at=datetime.now(UTC)),
    )

    with patch(
        "app.services.summary_generation.get_summarizer",
        return_value=spy_summarizer,
    ):
        res = await client.post(
            f"/api/v1/sessions/{session_id}/ai-summary",
            headers=auth_header(chw_tokens),
        )

    # ── Assertions ────────────────────────────────────────────────────
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["ai_summary"] == expected_summary
    assert body["generated_at"] is not None

    # The summarizer must have been called with the NEWER transcript.
    spy_summarizer.summarize.assert_called_once()
    call_args = spy_summarizer.summarize.call_args
    transcript_passed = call_args.kwargs.get("transcript") or call_args.args[0]
    assert newer_transcript in transcript_passed, (
        f"Summarizer received the wrong transcript. Expected the newer "
        f"transcript to win; got:\n{transcript_passed[:200]}…"
    )
    assert older_transcript not in transcript_passed, (
        "Summarizer received the older transcript — multi-row regression "
        "is back; check summary_generation._build_transcript_text."
    )

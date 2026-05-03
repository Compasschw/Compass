"""Tests for app.services.followup_extraction.

Invariants under test:
- The LLM wrapper (_call_extract_followups) degrades gracefully: a missing
  provider interface or any runtime exception returns an empty ExtractedFollowups
  and must NEVER raise.
- _build_transcript_text resolves transcript text in priority order: comm session
  transcript_text > session.notes > "".
- extract_session_followups (public API) persists zero SessionFollowup rows when
  the LLM returns empty results and does not raise.
- HIPAA: NO log line may contain transcript text or member name — only UUIDs,
  counts, and type names may appear in structured logs.

Pattern: async tests use @pytest.mark.asyncio. DB setup reuses the test_session
factory from conftest (drops/recreates schema per test via the autouse fixture).
LLM providers are monkeypatched — no external service calls.
"""

import logging
import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy import select

from app.models.communication import CommunicationSession
from app.models.followup import SessionFollowup
from app.models.request import ServiceRequest
from app.models.session import Session
from app.models.user import User
from app.services.followup_extraction import (
    ExtractedFollowupItem,
    ExtractedFollowups,
    _build_transcript_text,
    _call_extract_followups,
    extract_session_followups,
)
from tests.conftest import test_session as _test_session_factory

pytestmark = pytest.mark.asyncio

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_SENSITIVE_TRANSCRIPT = "CHW: How is your housing situation? Member: I was evicted last month."
_SENSITIVE_MEMBER_NAME = "Evangelina Reyes"


async def _make_users(db) -> tuple[User, User]:
    """Insert a CHW and a member; return (chw, member)."""
    chw = User(
        id=uuid.uuid4(),
        email=f"chw-{uuid.uuid4().hex[:6]}@test.com",
        password_hash="x",
        role="chw",
        name="Test CHW",
    )
    member = User(
        id=uuid.uuid4(),
        email=f"member-{uuid.uuid4().hex[:6]}@test.com",
        password_hash="x",
        role="member",
        name=_SENSITIVE_MEMBER_NAME,
    )
    db.add_all([chw, member])
    await db.flush()
    return chw, member


async def _make_session(
    db,
    chw: User,
    member: User,
    *,
    status: str = "completed",
    notes: str | None = None,
) -> Session:
    """Insert a minimal Session row (with required ServiceRequest FK)."""
    req = ServiceRequest(
        id=uuid.uuid4(),
        member_id=member.id,
        matched_chw_id=chw.id,
        vertical="housing",
        urgency="medium",
        description="test request",
        preferred_mode="virtual",
        status="matched",
    )
    db.add(req)
    await db.flush()

    session = Session(
        id=uuid.uuid4(),
        request_id=req.id,
        chw_id=chw.id,
        member_id=member.id,
        vertical="housing",
        status=status,
        mode="virtual",
        notes=notes,
    )
    db.add(session)
    await db.flush()
    return session


# ---------------------------------------------------------------------------
# _call_extract_followups — provider missing extract_followups method
# ---------------------------------------------------------------------------


class TestCallExtractFollowupsNoMethod:
    async def test_returns_empty_when_provider_lacks_extract_followups(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """If the provider object has no extract_followups attribute, the
        wrapper must return an empty ExtractedFollowups without raising.

        This guards the in-progress phase where the sister agent hasn't shipped
        the extraction method yet — callers must never crash on a stub provider.
        """
        stub_provider = MagicMock(spec=[])  # no attributes whatsoever
        mock_get_provider = MagicMock(return_value=stub_provider)

        monkeypatch.setitem(
            __import__("sys").modules,
            "app.services.transcription",
            MagicMock(get_transcription_provider=mock_get_provider),
        )

        result = await _call_extract_followups("any transcript", "Alice")

        assert isinstance(result, ExtractedFollowups)
        assert result.items == []

    async def test_does_not_raise_when_provider_lacks_extract_followups(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """Absence of extract_followups must be a silent no-op, not an exception."""
        stub_provider = MagicMock(spec=[])
        monkeypatch.setitem(
            __import__("sys").modules,
            "app.services.transcription",
            MagicMock(get_transcription_provider=MagicMock(return_value=stub_provider)),
        )

        # Would raise AttributeError if not guarded by hasattr check.
        try:
            await _call_extract_followups("transcript", "Bob")
        except Exception as exc:  # noqa: BLE001
            pytest.fail(f"_call_extract_followups raised unexpectedly: {exc!r}")


# ---------------------------------------------------------------------------
# _call_extract_followups — provider raises an exception
# ---------------------------------------------------------------------------


class TestCallExtractFollowupsProviderException:
    async def test_returns_empty_on_provider_exception(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """A runtime error from the LLM provider must be swallowed and return
        an empty ExtractedFollowups so the session-completion workflow is never
        blocked by a flaky LLM call.
        """
        async def _boom(*_args, **_kwargs):
            raise RuntimeError("LLM timeout — upstream unavailable")

        mock_provider = MagicMock()
        mock_provider.extract_followups = _boom

        monkeypatch.setitem(
            __import__("sys").modules,
            "app.services.transcription",
            MagicMock(get_transcription_provider=MagicMock(return_value=mock_provider)),
        )

        result = await _call_extract_followups("transcript", "Carlos")

        assert isinstance(result, ExtractedFollowups)
        assert result.items == []

    async def test_logs_warning_on_provider_exception(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ):
        """A provider exception must be logged at WARNING level so on-call
        engineers see it without it polluting ERROR dashboards under normal
        LLM degradation.
        """
        async def _boom(*_args, **_kwargs):
            raise ValueError("JSON parse error from LLM output")

        mock_provider = MagicMock()
        mock_provider.extract_followups = _boom

        monkeypatch.setitem(
            __import__("sys").modules,
            "app.services.transcription",
            MagicMock(get_transcription_provider=MagicMock(return_value=mock_provider)),
        )

        with caplog.at_level(logging.WARNING, logger="compass.followup_extraction"):
            await _call_extract_followups("transcript", "Dana")

        warning_records = [r for r in caplog.records if r.levelno == logging.WARNING]
        assert warning_records, "Expected at least one WARNING log on provider exception"

    async def test_does_not_raise_on_provider_exception(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """Provider exceptions must never propagate — callers get [] not a 500."""
        async def _boom(*_args, **_kwargs):
            raise Exception("catastrophic LLM failure")  # noqa: TRY002

        mock_provider = MagicMock()
        mock_provider.extract_followups = _boom

        monkeypatch.setitem(
            __import__("sys").modules,
            "app.services.transcription",
            MagicMock(get_transcription_provider=MagicMock(return_value=mock_provider)),
        )

        try:
            await _call_extract_followups("transcript", "Eve")
        except Exception as exc:  # noqa: BLE001
            pytest.fail(f"Exception leaked out of _call_extract_followups: {exc!r}")


# ---------------------------------------------------------------------------
# _build_transcript_text — resolution order
# ---------------------------------------------------------------------------


class TestBuildTranscriptText:
    async def test_returns_comm_session_transcript_when_set(self):
        """Resolution priority 1: CommunicationSession.transcript_text wins over
        session.notes. The returned string is the raw provider text, unchanged.
        """
        async with _test_session_factory() as db:
            chw, member = await _make_users(db)
            session = await _make_session(
                db, chw, member, notes="manual notes that should be ignored"
            )

            comm = CommunicationSession(
                id=uuid.uuid4(),
                session_id=session.id,
                provider="vonage",
                provider_session_id="vonage-abc-123",
                proxy_number="+15550001234",
                transcript_text=_SENSITIVE_TRANSCRIPT,
            )
            db.add(comm)
            await db.flush()

            result = await _build_transcript_text(session, db)

        assert result == _SENSITIVE_TRANSCRIPT

    async def test_falls_back_to_session_notes_when_no_comm_transcript(self):
        """Resolution priority 2: when no CommunicationSession with a transcript
        exists, session.notes is returned as the transcript text.
        """
        async with _test_session_factory() as db:
            chw, member = await _make_users(db)
            notes_text = "CHW manually noted: member needs food assistance"
            session = await _make_session(db, chw, member, notes=notes_text)

            result = await _build_transcript_text(session, db)

        assert result == notes_text

    async def test_returns_empty_string_when_neither_transcript_nor_notes(self):
        """Resolution priority 3: when no transcript and no notes exist, the
        function must return '' and must not raise — callers expect an empty
        extraction result, not an exception.
        """
        async with _test_session_factory() as db:
            chw, member = await _make_users(db)
            session = await _make_session(db, chw, member, notes=None)

            result = await _build_transcript_text(session, db)

        assert result == ""

    async def test_ignores_comm_session_with_null_transcript(self):
        """A CommunicationSession row with transcript_text=NULL must NOT
        satisfy the comm-session resolution path — the query filters
        .where(transcript_text.isnot(None)).
        """
        async with _test_session_factory() as db:
            chw, member = await _make_users(db)
            notes_text = "fallback notes"
            session = await _make_session(db, chw, member, notes=notes_text)

            comm = CommunicationSession(
                id=uuid.uuid4(),
                session_id=session.id,
                provider="vonage",
                provider_session_id="vonage-xyz-999",
                proxy_number="+15550009999",
                transcript_text=None,  # explicitly null
            )
            db.add(comm)
            await db.flush()

            result = await _build_transcript_text(session, db)

        # Must fall through to session.notes
        assert result == notes_text


# ---------------------------------------------------------------------------
# extract_session_followups — end-to-end with empty LLM result
# ---------------------------------------------------------------------------


class TestExtractSessionFollowupsEmptyLLM:
    async def test_returns_empty_list_when_llm_returns_no_items(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """When the LLM extraction returns zero items, extract_session_followups
        must return an empty list — not raise, not return None.
        """
        # Patch _call_extract_followups at the module level so the real LLM
        # is never reached regardless of import-time side effects.
        monkeypatch.setattr(
            "app.services.followup_extraction._call_extract_followups",
            AsyncMock(return_value=ExtractedFollowups(items=[])),
        )

        async with _test_session_factory() as db:
            chw, member = await _make_users(db)
            session = await _make_session(db, chw, member, notes="some notes")

            result = await extract_session_followups(session.id, db)

        assert result == []

    async def test_persists_zero_followup_rows_when_llm_returns_empty(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """Zero LLM items must mean zero rows in session_followups — idempotency
        stamp is still written, but no PHI rows are created.
        """
        monkeypatch.setattr(
            "app.services.followup_extraction._call_extract_followups",
            AsyncMock(return_value=ExtractedFollowups(items=[])),
        )

        async with _test_session_factory() as db:
            chw, member = await _make_users(db)
            session = await _make_session(db, chw, member, notes="some notes")
            session_id = session.id

            await extract_session_followups(session_id, db)

        # Open a fresh session to confirm no rows were committed.
        async with _test_session_factory() as db:
            rows = (
                await db.execute(
                    select(SessionFollowup).where(
                        SessionFollowup.session_id == session_id
                    )
                )
            ).scalars().all()

        assert rows == []

    async def test_skips_non_completed_sessions(self, monkeypatch: pytest.MonkeyPatch):
        """Sessions not in 'completed' status must be silently skipped.

        The extraction job is triggered post-session-completion; running it on
        'scheduled' or 'in_progress' sessions would extract partial data.
        """
        call_mock = AsyncMock(return_value=ExtractedFollowups(items=[]))
        monkeypatch.setattr(
            "app.services.followup_extraction._call_extract_followups", call_mock
        )

        async with _test_session_factory() as db:
            chw, member = await _make_users(db)
            session = await _make_session(db, chw, member, status="in_progress")

            result = await extract_session_followups(session.id, db)

        assert result == []
        call_mock.assert_not_called()

    async def test_returns_empty_for_unknown_session_id(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """A session_id that doesn't exist in the DB must return [] without
        raising — the service is called from background jobs that may race with
        deletions.
        """
        monkeypatch.setattr(
            "app.services.followup_extraction._call_extract_followups",
            AsyncMock(return_value=ExtractedFollowups(items=[])),
        )

        async with _test_session_factory() as db:
            result = await extract_session_followups(uuid.uuid4(), db)

        assert result == []

    async def test_does_not_post_chat_message_when_llm_returns_empty(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """With zero extracted items, _post_extraction_chat_message must not
        write a Message row — the chat summary only fires when there is
        something to report.
        """
        monkeypatch.setattr(
            "app.services.followup_extraction._call_extract_followups",
            AsyncMock(return_value=ExtractedFollowups(items=[])),
        )

        chat_mock = AsyncMock()
        monkeypatch.setattr(
            "app.services.followup_extraction._post_extraction_chat_message",
            chat_mock,
        )

        async with _test_session_factory() as db:
            chw, member = await _make_users(db)
            session = await _make_session(db, chw, member, notes="some notes")

            await extract_session_followups(session.id, db)

        chat_mock.assert_not_called()


# ---------------------------------------------------------------------------
# HIPAA critical: NO PHI in log output
# ---------------------------------------------------------------------------


class TestPhiNotLeakedInLogs:
    async def test_no_transcript_text_in_logs_on_empty_result(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ):
        """HIPAA boundary: the transcript string must NEVER appear in any log
        record, regardless of which code path runs. Log lines are permitted to
        contain only UUIDs, counts, and type names.

        A regression here would be a BAA violation — transcript content is PHI
        under 45 CFR §164.501.
        """
        monkeypatch.setattr(
            "app.services.followup_extraction._call_extract_followups",
            AsyncMock(return_value=ExtractedFollowups(items=[])),
        )

        with caplog.at_level(logging.DEBUG, logger="compass.followup_extraction"):
            async with _test_session_factory() as db:
                chw, member = await _make_users(db)
                session = await _make_session(
                    db, chw, member, notes=_SENSITIVE_TRANSCRIPT
                )
                await extract_session_followups(session.id, db)

        all_log_text = " ".join(r.getMessage() for r in caplog.records)

        # The transcript or any meaningful word from it must not appear.
        for sensitive_fragment in [
            "evicted",
            "housing situation",
            "CHW:",
            "Member:",
        ]:
            assert sensitive_fragment not in all_log_text, (
                f"PHI fragment {sensitive_fragment!r} found in log output — "
                "HIPAA violation. Log only UUIDs and counts."
            )

    async def test_no_member_name_in_logs(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ):
        """The member's name (first or full) must not appear in any log line.

        The service resolves first-name only for the LLM prompt and must pass
        it directly to the provider without writing it to the logger.
        """
        monkeypatch.setattr(
            "app.services.followup_extraction._call_extract_followups",
            AsyncMock(return_value=ExtractedFollowups(items=[])),
        )

        with caplog.at_level(logging.DEBUG, logger="compass.followup_extraction"):
            async with _test_session_factory() as db:
                chw, member = await _make_users(db)
                session = await _make_session(
                    db, chw, member, notes="Member discussed food access challenges."
                )
                await extract_session_followups(session.id, db)

        all_log_text = " ".join(r.getMessage() for r in caplog.records)

        # Neither first name nor full name should appear.
        assert "Evangelina" not in all_log_text, (
            "Member first name found in logs — HIPAA violation."
        )
        assert "Reyes" not in all_log_text, (
            "Member last name found in logs — HIPAA violation."
        )

    async def test_no_phi_in_logs_on_provider_exception(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ):
        """Even when the LLM provider raises, the warning log must contain only
        the exception type name — NOT the transcript or member name. The service
        catches and re-logs the exception type (type(exc).__name__) only.
        """
        async def _boom(*_args, **_kwargs):
            raise RuntimeError("LLM call failed")

        mock_provider = MagicMock()
        mock_provider.extract_followups = _boom

        monkeypatch.setitem(
            __import__("sys").modules,
            "app.services.transcription",
            MagicMock(get_transcription_provider=MagicMock(return_value=mock_provider)),
        )

        with caplog.at_level(logging.DEBUG, logger="compass.followup_extraction"):
            await _call_extract_followups(_SENSITIVE_TRANSCRIPT, _SENSITIVE_MEMBER_NAME)

        all_log_text = " ".join(r.getMessage() for r in caplog.records)

        assert "evicted" not in all_log_text
        assert "Evangelina" not in all_log_text
        assert "Reyes" not in all_log_text
        # The type name IS expected — assert the warning is informative but safe.
        assert "RuntimeError" in all_log_text

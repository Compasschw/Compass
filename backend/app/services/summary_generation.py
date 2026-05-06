"""LLM-generated session summary service.

Assembles the session transcript and delegates to the configured
``SummarizerProvider`` (currently ``AnthropicSummarizer`` via Claude, or
``NoopSummarizer`` when the API key is absent).

  1. Loads the session and validates it is in a summarisable state.
  2. Assembles the transcript text (chat messages + persisted transcript chunks).
  3. Calls ``get_summarizer().summarize(...)`` and returns a ``SummaryResult``.

Distinct from extract_session_followups (which persists structured rows).
This function does NOT persist anything — the CHW edits the draft and
submits it as part of the documentation save, which is the persistence point.

Why a separate file: same plumbing pattern as followup_extraction.py
(transcript assembly, status guards, provider call) but a different output
shape (SummaryResult vs structured ExtractedFollowups). Keeping them
parallel makes it obvious where to add the next derived-from-transcript
artifact (e.g., suggested procedure code, vertical reclassification).
"""

import logging
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.session import Session
from app.services.transcription.summarizer import SummaryResult, get_summarizer

logger = logging.getLogger("compass.sessions.summary")


async def generate_session_summary(
    session_id: UUID,
    db: AsyncSession,
) -> SummaryResult:
    """Generate a draft summary for the given session via the configured LLM.

    Returns a ``SummaryResult`` (text + generated_at).  ``SummaryResult.empty()``
    is returned when:
      - session doesn't exist
      - session is not completed or in_progress
      - transcript is empty or under the minimum length threshold
      - provider key is missing or the LLM call fails

    Caller (the /sessions/{id}/ai-summary endpoint) maps the result to the
    ``{"ai_summary": ..., "generated_at": ...}`` response shape.

    PHI contract: session_id is the only value safe to log here.
    """
    session = await db.get(Session, session_id)
    if session is None:
        logger.warning("generate_session_summary: unknown session_id=%s", session_id)
        return SummaryResult.empty()
    if session.status not in {"completed", "in_progress"}:
        # We allow in_progress so a CHW can pre-generate a draft mid-call —
        # useful for chat sessions where the CHW wraps up by writing the note
        # while the conversation is still technically open.
        logger.info(
            "generate_session_summary: session=%s status=%s — skipping",
            session_id, session.status,
        )
        return SummaryResult.empty()

    transcript_text = await _build_transcript_text(session, db)
    if not transcript_text.strip():
        return SummaryResult.empty()

    summarizer = get_summarizer()
    result = await summarizer.summarize(
        transcript_text,
        vertical=getattr(session, "vertical", None),
    )
    return result


async def _build_transcript_text(session: Session, db: AsyncSession) -> str:
    """Assemble a single transcript string from chat messages + persisted
    audio-derived transcript chunks.

    Mirrors the assembly logic in followup_extraction so the summary and
    follow-up extraction always operate on the same view of the conversation.
    """
    from app.models.communication import CommunicationSession
    from app.models.session import SessionTranscript

    # 1. Chat messages on this session, time-ordered
    pieces: list[str] = []
    try:
        from app.models.session import SessionMessage  # type: ignore[attr-defined]

        msg_result = await db.execute(
            select(SessionMessage)
            .where(SessionMessage.session_id == session.id)
            .order_by(SessionMessage.created_at.asc())
        )
        for msg in msg_result.scalars().all():
            speaker = getattr(msg, "sender_role", None) or "speaker"
            content = getattr(msg, "content", "") or ""
            if content.strip():
                pieces.append(f"[{speaker}] {content.strip()}")
    except Exception as exc:  # noqa: BLE001
        # SessionMessage may not exist as an importable model in all builds;
        # fall through to other sources.
        logger.debug("transcript build: SessionMessage source skipped: %s", exc)

    # 2. Persisted audio transcript chunks (Vonage recording → AssemblyAI)
    try:
        chunk_result = await db.execute(
            select(SessionTranscript)
            .where(SessionTranscript.session_id == session.id)
            .order_by(SessionTranscript.started_at_ms.asc())
        )
        for chunk in chunk_result.scalars().all():
            text = (chunk.text or "").strip()
            if text:
                role = chunk.speaker_role or chunk.speaker_label or "speaker"
                pieces.append(f"[{role}] {text}")
    except Exception as exc:  # noqa: BLE001
        logger.debug("transcript build: SessionTranscript source skipped: %s", exc)

    # 3. Fallback: comm_session.transcript_text (post-call full Vonage transcript)
    if not pieces:
        try:
            comm_result = await db.execute(
                select(CommunicationSession).where(
                    CommunicationSession.session_id == session.id
                )
            )
            comm = comm_result.scalar_one_or_none()
            if comm is not None and getattr(comm, "transcript_text", None):
                return comm.transcript_text or ""
        except Exception as exc:  # noqa: BLE001
            logger.debug(
                "transcript build: CommunicationSession source skipped: %s", exc
            )

    # 4. Final fallback: free-text Session.notes
    if not pieces and session.notes:
        return session.notes

    return "\n".join(pieces)



"""LLM-generated session summary service.

Wrapper around the transcription provider's `summarize_transcript` method that:
  1. Loads the session and validates it's completed.
  2. Assembles the transcript text (chat messages + persisted transcript chunks).
  3. Calls the provider's summarize.
  4. Returns the draft summary string for the DocumentationModal to pre-fill.

Distinct from extract_session_followups (which persists structured rows).
This function does NOT persist anything — the CHW edits the draft and
submits it as part of the documentation save, which is the persistence point.

Why a separate file: same plumbing pattern as followup_extraction.py
(transcript assembly, status guards, provider call) but a different output
shape (free-text string vs structured ExtractedFollowups). Keeping them
parallel makes it obvious where to add the next derived-from-transcript
artifact (e.g., suggested procedure code, vertical reclassification).
"""

import logging
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.session import Session
from app.models.user import User

logger = logging.getLogger("compass.sessions.summary")


async def generate_session_summary(
    session_id: UUID,
    db: AsyncSession,
) -> str:
    """Generate a draft summary for the given session.

    Returns the summary text, or empty string when:
      - session doesn't exist
      - session is not completed
      - transcript is empty
      - provider key is missing or the LLM call fails

    Caller (the /sessions/{id}/summary endpoint) treats empty string as
    "no draft available — CHW types from scratch".
    """
    session = await db.get(Session, session_id)
    if session is None:
        logger.warning("generate_session_summary: unknown session_id=%s", session_id)
        return ""
    if session.status not in {"completed", "in_progress"}:
        # We allow in_progress so a CHW can pre-generate a draft mid-call —
        # useful for chat sessions where the CHW wraps up by writing the note
        # while the conversation is still technically open.
        logger.info(
            "generate_session_summary: session=%s status=%s — skipping",
            session_id, session.status,
        )
        return ""

    transcript_text = await _build_transcript_text(session, db)
    if not transcript_text.strip():
        return ""

    member_first_name = await _resolve_member_first_name(session.member_id, db)

    # Lazy import — keeps the transcription provider out of the import graph
    # for tests that don't need it.
    from app.services.transcription import get_transcription_provider

    try:
        provider = get_transcription_provider()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Transcription provider unavailable for summary: %s", exc)
        return ""

    if not hasattr(provider, "summarize_transcript"):
        return ""

    try:
        summary = await provider.summarize_transcript(transcript_text, member_first_name)
    except Exception as exc:  # noqa: BLE001
        logger.error("summarize_transcript raised: %s", type(exc).__name__)
        return ""

    return summary or ""


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


async def _resolve_member_first_name(
    member_id: UUID, db: AsyncSession
) -> str | None:
    """Pull the member's first name to personalise the LLM prompt.

    Returns None on any error so the prompt falls back to the unpersonalised
    template — never block summary generation on a missing name.
    """
    try:
        member = await db.get(User, member_id)
        if member is None or not member.name:
            return None
        return member.name.split(" ")[0] or None
    except Exception:  # noqa: BLE001
        return None

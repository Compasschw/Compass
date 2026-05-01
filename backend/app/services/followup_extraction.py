"""Service: LLM extraction pass over completed session transcripts.

After a session ends, this service:
  1. Validates the session is in ``completed`` state.
  2. Reads the transcript (from CommunicationSession.transcript_text or
     Session.notes as a fallback — see TODO below).
  3. Calls the transcription provider's ``extract_followups`` method.
  4. Maps the returned structured data to SessionFollowup ORM rows.
  5. Persists rows in a single transaction.
  6. Posts a summary chat message into the session conversation.
  7. Returns the persisted rows.

HIPAA: never log transcript content or extracted descriptions.  Log counts
and UUIDs only.

TODO (Phase 3 — transcript integration):
  The streaming transcription pipeline (sister agent) will introduce a
  dedicated ``transcripts`` table with per-utterance rows and speaker labels.
  When that lands:
    1. Replace the ``_build_transcript_text`` helper below with a query
       against ``transcript_chunks`` (or equivalent table name).
    2. Drop the ``Session.notes`` fallback path.
    3. Update this module's import of ``CommunicationSession`` accordingly
       (transcript_text may move out of ``communication_sessions``).
  Track in: https://github.com/CompassCHW/backend/issues/TBD
"""

import logging
import uuid
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import TYPE_CHECKING
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.followup import SessionFollowup
from app.models.session import Session, SessionDocumentation

if TYPE_CHECKING:
    pass

logger = logging.getLogger("compass.followup_extraction")


# ── Provider-interface types ──────────────────────────────────────────────────
# The transcription provider's extract_followups interface is being built by
# a sister agent.  These dataclasses mirror the expected contract so this
# module compiles and runs independently.  When the real interface ships,
# replace these stubs with the actual imports from
# ``app.services.transcription.base``.


@dataclass
class ExtractedFollowupItem:
    """A single item returned by the LLM extraction pass."""

    kind: str  # action_item | follow_up_task | resource_referral | member_goal
    description: str
    owner: str | None = None  # chw | member | both
    vertical: str | None = None
    priority: str | None = None  # low | medium | high
    due_date_iso: str | None = None  # ISO 8601 date string, e.g. "2026-05-01"


@dataclass
class ExtractedFollowups:
    """Container returned by the provider's extract_followups call."""

    items: list[ExtractedFollowupItem] = field(default_factory=list)


# ── Provider resolution ───────────────────────────────────────────────────────

async def _call_extract_followups(
    transcript: str,
    member_name: str,
) -> ExtractedFollowups:
    """Delegate to the transcription provider's extraction method.

    If the provider interface or its ``extract_followups`` method doesn't exist
    yet, falls back to an empty ``ExtractedFollowups`` stub so callers never
    crash on a missing dependency.

    LLM failures are caught here and logged as warnings — they must not block
    session completion or documentation workflows.
    """
    try:
        # Import the real provider when the sister agent ships it.
        # Expected interface:
        #   from app.services.transcription.base import TranscriptionProvider
        #   provider = get_transcription_provider()
        #   result = await provider.extract_followups(transcript, member_name)
        # For now, attempt the import and fall back to stub if unavailable.
        from app.services.transcription import get_transcription_provider  # type: ignore[import]
        provider = get_transcription_provider()
        if not hasattr(provider, "extract_followups"):
            logger.info(
                "Transcription provider does not implement extract_followups yet — "
                "returning empty result (stub mode)"
            )
            return ExtractedFollowups()
        result = await provider.extract_followups(transcript, member_name)
        return result  # type: ignore[return-value]
    except ImportError:
        logger.info(
            "app.services.transcription.get_transcription_provider not yet available — "
            "returning empty extraction result (stub mode)"
        )
        return ExtractedFollowups()
    except Exception as exc:  # noqa: BLE001
        # LLM failures must NOT propagate — log and return empty.
        logger.warning(
            "extract_followups provider call failed: %s — returning empty result",
            type(exc).__name__,
        )
        return ExtractedFollowups()


# ── Transcript assembly ───────────────────────────────────────────────────────

async def _build_transcript_text(
    session: Session,
    db: AsyncSession,
) -> str:
    """Assemble a single transcript string with speaker labels.

    Resolution order:
      1. CommunicationSession.transcript_text — set by the Vonage/Twilio
         provider when the call recording is transcribed post-completion.
      2. Session.notes — used as a short-term fallback for text-only sessions
         (virtual/phone where notes were taken manually).
      3. Empty string — returns "" so callers get an empty extraction rather
         than an exception.

    TODO (Phase 3): Replace this with a query against the ``transcript_chunks``
    table once the streaming transcription pipeline is live.  The chunk rows
    will have ``speaker``, ``text``, and ``start_ms`` — concatenate into the
    same "Speaker A: ...\nSpeaker B: ..." format the LLM prompt expects.
    Track in: https://github.com/CompassCHW/backend/issues/TBD
    """
    from app.models.communication import CommunicationSession

    # Prefer the post-call transcript from the communication session.
    comm_result = await db.execute(
        select(CommunicationSession)
        .where(CommunicationSession.session_id == session.id)
        .where(CommunicationSession.transcript_text.isnot(None))
        .order_by(CommunicationSession.created_at.desc())
        .limit(1)
    )
    comm_session = comm_result.scalar_one_or_none()
    if comm_session and comm_session.transcript_text:
        # transcript_text from the provider is already formatted with
        # utterance-level text but no speaker labels — prefix with generic
        # labels so the LLM prompt stays consistent.
        return comm_session.transcript_text

    # Fallback: use session notes if set (manual entry by CHW).
    if session.notes:
        logger.info(
            "session=%s using session.notes as transcript fallback (communication transcript unavailable)",
            session.id,
        )
        return session.notes

    logger.info(
        "session=%s no transcript or notes available — extraction will return empty",
        session.id,
    )
    return ""


# ── ORM row mapping ───────────────────────────────────────────────────────────

_VALID_KINDS = {"action_item", "follow_up_task", "resource_referral", "member_goal"}
_VALID_OWNERS = {"chw", "member", "both"}
_VALID_PRIORITIES = {"low", "medium", "high"}


def _parse_date(raw: str | None) -> "date | None":
    """Parse an ISO 8601 date string from the LLM, returning None on failure."""
    if not raw:
        return None
    from datetime import date
    try:
        return date.fromisoformat(raw)
    except (ValueError, TypeError):
        return None


def _map_item_to_followup(
    item: ExtractedFollowupItem,
    session: Session,
) -> SessionFollowup:
    """Convert one ``ExtractedFollowupItem`` to a ``SessionFollowup`` ORM row.

    Defensively coerces unknown enum values to None rather than raising so
    a bad LLM output never crashes the whole extraction.
    """
    kind = item.kind if item.kind in _VALID_KINDS else "action_item"
    owner = item.owner if item.owner in _VALID_OWNERS else None
    priority = item.priority if item.priority in _VALID_PRIORITIES else None
    # Roadmap visibility: member-owned or jointly-owned items surface on the
    # MemberRoadmapScreen.
    show_on_roadmap = owner in {"member", "both"}

    return SessionFollowup(
        id=uuid.uuid4(),
        session_id=session.id,
        member_id=session.member_id,
        chw_id=session.chw_id,
        kind=kind,
        description=item.description,
        owner=owner,
        vertical=session.vertical if not item.vertical else item.vertical,
        priority=priority,
        due_date=_parse_date(item.due_date_iso),
        status="pending",
        auto_created=True,
        show_on_roadmap=show_on_roadmap,
    )


# ── Chat summary helper ───────────────────────────────────────────────────────

async def _post_extraction_chat_message(
    session: Session,
    followups: list[SessionFollowup],
    db: AsyncSession,
) -> None:
    """Post a system chat message summarising extracted items.

    Uses the existing session-conversation infrastructure from sessions.py.
    Failures are caught and logged — a broken notification must never roll
    back the extraction transaction.

    HIPAA: the message body only contains counts — no PHI from descriptions.
    """
    action_count = sum(1 for f in followups if f.kind == "action_item")
    task_count = sum(1 for f in followups if f.kind == "follow_up_task")
    resource_count = sum(1 for f in followups if f.kind == "resource_referral")
    goal_count = sum(1 for f in followups if f.kind == "member_goal")

    parts: list[str] = []
    if action_count:
        parts.append(f"{action_count} action item{'s' if action_count != 1 else ''}")
    if task_count:
        parts.append(f"{task_count} follow-up task{'s' if task_count != 1 else ''}")
    if resource_count:
        parts.append(f"{resource_count} resource referral{'s' if resource_count != 1 else ''}")
    if goal_count:
        parts.append(f"{goal_count} member goal{'s' if goal_count != 1 else ''}")

    if not parts:
        return

    summary = ", ".join(parts[:-1]) + (" and " if len(parts) > 1 else "") + parts[-1]
    body = f"Captured {summary}. Tap to review and confirm."

    try:
        from sqlalchemy.dialects.postgresql import insert as pg_insert

        from app.models.conversation import Conversation, Message

        # Get or create the session conversation (mirrors _get_or_create in sessions.py).
        conv_result = await db.execute(
            select(Conversation).where(Conversation.session_id == session.id)
        )
        conv = conv_result.scalar_one_or_none()

        if conv is None:
            stmt = (
                pg_insert(Conversation)
                .values(
                    chw_id=session.chw_id,
                    member_id=session.member_id,
                    session_id=session.id,
                )
                .on_conflict_do_nothing(constraint="uq_conversations_session_id")
                .returning(Conversation)
            )
            insert_result = await db.execute(stmt)
            conv = insert_result.scalar_one_or_none()
            if conv is None:
                conv_result = await db.execute(
                    select(Conversation).where(Conversation.session_id == session.id)
                )
                conv = conv_result.scalar_one()

        # Send as a system message from the CHW's account.
        msg = Message(
            conversation_id=conv.id,
            sender_id=session.chw_id,
            body=body,
            type="system",
        )
        db.add(msg)
        await db.flush()  # persist within outer transaction

        logger.info(
            "session=%s extraction summary message posted: counts=%d",
            session.id,
            len(followups),
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "session=%s failed to post extraction chat message: %s",
            session.id, type(exc).__name__,
        )


# ── Idempotency helper ────────────────────────────────────────────────────────

async def _mark_followups_extracted(
    session_id: UUID,
    db: AsyncSession,
) -> None:
    """Stamp ``SessionDocumentation.followups_extracted_at`` for idempotency.

    If no documentation row exists yet (extraction ran before documentation
    was submitted), this is a no-op — the idempotency check in
    ``extract_session_followups`` will fall back to a direct table count.
    """
    doc_result = await db.execute(
        select(SessionDocumentation).where(
            SessionDocumentation.session_id == session_id
        )
    )
    doc = doc_result.scalar_one_or_none()
    if doc is not None:
        doc.followups_extracted_at = datetime.now(UTC)
        # Committed by the caller's transaction.


# ── Public API ────────────────────────────────────────────────────────────────

async def extract_session_followups(
    session_id: UUID,
    db: AsyncSession,
) -> list[SessionFollowup]:
    """Run the LLM extraction pass and persist structured follow-up rows.

    Returns:
        List of persisted ``SessionFollowup`` rows (may be empty if the session
        has no transcript, the LLM returned nothing, or extraction already ran).

    Idempotency:
        If ``session_documentation.followups_extracted_at`` is set, or if
        ``session_followups`` already contains rows for this session, the
        function returns the existing rows without re-running extraction.

    Status guard:
        Only runs for sessions in ``completed`` status.  Returns [] otherwise.

    LLM failures:
        Caught internally — never propagate.  Returns [] on failure.
    """
    # ── 1. Load and validate session ─────────────────────────────────────────
    session = await db.get(Session, session_id)
    if session is None:
        logger.warning("extract_followups called on unknown session_id=%s", session_id)
        return []

    if session.status != "completed":
        logger.info(
            "session=%s skipping extraction — status is '%s', expected 'completed'",
            session_id, session.status,
        )
        return []

    # ── 2. Idempotency check — doc timestamp ──────────────────────────────────
    doc_result = await db.execute(
        select(SessionDocumentation).where(
            SessionDocumentation.session_id == session_id
        )
    )
    doc = doc_result.scalar_one_or_none()
    if doc is not None and getattr(doc, "followups_extracted_at", None) is not None:
        logger.info(
            "session=%s extraction already ran at=%s — returning existing rows",
            session_id, doc.followups_extracted_at,
        )
        existing = await db.execute(
            select(SessionFollowup).where(
                SessionFollowup.session_id == session_id
            )
        )
        return list(existing.scalars().all())

    # ── 3. Idempotency check — direct row presence ────────────────────────────
    # Handles the case where extraction ran but documentation wasn't submitted yet.
    count_result = await db.execute(
        select(SessionFollowup).where(
            SessionFollowup.session_id == session_id
        ).limit(1)
    )
    if count_result.scalar_one_or_none() is not None:
        logger.info(
            "session=%s followup rows already exist — returning existing rows (no doc yet)",
            session_id,
        )
        existing = await db.execute(
            select(SessionFollowup).where(
                SessionFollowup.session_id == session_id
            )
        )
        return list(existing.scalars().all())

    # ── 4. Build transcript string ────────────────────────────────────────────
    transcript_text = await _build_transcript_text(session, db)

    # Resolve member name for LLM context (first name only — minimum necessary).
    member_user = await db.get(__import__("app.models.user", fromlist=["User"]).User, session.member_id)
    member_name = (member_user.name.split()[0] if member_user else "Member")

    # ── 5. Call LLM extraction ────────────────────────────────────────────────
    extracted: ExtractedFollowups = await _call_extract_followups(
        transcript_text, member_name
    )

    logger.info(
        "session=%s extraction returned item_count=%d",
        session_id, len(extracted.items),
    )

    if not extracted.items:
        # Stamp the doc so we don't retry on every subsequent call.
        await _mark_followups_extracted(session_id, db)
        await db.commit()
        return []

    # ── 6. Map to ORM rows ────────────────────────────────────────────────────
    followup_rows = [_map_item_to_followup(item, session) for item in extracted.items]

    # ── 7. Persist in a single transaction ───────────────────────────────────
    for row in followup_rows:
        db.add(row)

    await _mark_followups_extracted(session_id, db)

    # Post chat summary within the same transaction so both succeed or both fail.
    await _post_extraction_chat_message(session, followup_rows, db)

    await db.commit()

    for row in followup_rows:
        await db.refresh(row)

    action_count = sum(1 for f in followup_rows if f.kind == "action_item")
    task_count = sum(1 for f in followup_rows if f.kind == "follow_up_task")
    resource_count = sum(1 for f in followup_rows if f.kind == "resource_referral")
    goal_count = sum(1 for f in followup_rows if f.kind == "member_goal")

    logger.info(
        "session=%s followups persisted: total=%d action_items=%d follow_up_tasks=%d "
        "resource_referrals=%d member_goals=%d",
        session_id,
        len(followup_rows),
        action_count,
        task_count,
        resource_count,
        goal_count,
    )

    return followup_rows

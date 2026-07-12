"""Service helpers for the session-per-call refactor (#193).

Owns the "which Session is active for this conversation" lookup and the
factory that mints a new Session row when a call bridges into a
conversation that has no in_progress Session.

Keep this thin — these helpers are called from the call-bridge hot path
and from the CHW inbox endpoint, both of which are latency-sensitive.
"""
from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.conversation import Conversation
from app.models.session import Session
from app.models.user import User


async def get_active_session_for_conversation(
    db: AsyncSession,
    conversation_id: UUID,
) -> Session | None:
    """Return the conversation's currently in_progress Session.

    If multiple in_progress rows exist (defensive edge case), the newest
    by created_at is returned. Returns None when none exist.

    Args:
        db: The async SQLAlchemy session.
        conversation_id: UUID of the Conversation to query.

    Returns:
        The most-recently-created in_progress Session, or None.
    """
    result = await db.execute(
        select(Session)
        .where(
            Session.conversation_id == conversation_id,
            Session.status == "in_progress",
        )
        .order_by(Session.created_at.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def get_active_session_ids_for_conversations(
    db: AsyncSession,
    conversation_ids: list[UUID],
) -> dict[UUID, UUID]:
    """Batch variant of :func:`get_active_session_for_conversation`.

    Resolves the in_progress Session id for every conversation in one
    ``DISTINCT ON`` query (newest per conversation wins, matching the
    single-row helper's tie-break). Conversations with no in_progress
    Session are simply absent from the result.

    Args:
        db: The async SQLAlchemy session.
        conversation_ids: Conversation UUIDs to resolve (empty list is fine).

    Returns:
        Mapping of conversation_id → active session_id.
    """
    if not conversation_ids:
        return {}
    result = await db.execute(
        select(Session.conversation_id, Session.id)
        .where(
            Session.conversation_id.in_(conversation_ids),
            Session.status == "in_progress",
        )
        .order_by(Session.conversation_id, Session.created_at.desc())
        .distinct(Session.conversation_id)
    )
    return {conversation_id: session_id for conversation_id, session_id in result.all()}


async def get_active_session_started_ats_for_conversations(
    db: AsyncSession,
    conversation_ids: list[UUID],
) -> dict[UUID, datetime]:
    """Return the ``started_at`` of each conversation's in_progress Session.

    Companion to :func:`get_active_session_ids_for_conversations`, kept separate
    so that helper's contract is unchanged. Drives the CHW Messages session
    timer, which counts up from the active session's start. Same DISTINCT ON
    tie-break (newest per conversation). Conversations with no in_progress
    Session — or an in_progress Session whose ``started_at`` is NULL — are absent
    from the result.

    Args:
        db: The async SQLAlchemy session.
        conversation_ids: Conversation UUIDs to resolve (empty list is fine).

    Returns:
        Mapping of conversation_id → the active session's ``started_at``.
    """
    if not conversation_ids:
        return {}
    result = await db.execute(
        select(Session.conversation_id, Session.started_at)
        .where(
            Session.conversation_id.in_(conversation_ids),
            Session.status == "in_progress",
        )
        .order_by(Session.conversation_id, Session.created_at.desc())
        .distinct(Session.conversation_id)
    )
    return {
        conversation_id: started_at
        for conversation_id, started_at in result.all()
        if started_at is not None
    }


async def find_or_create_conversation_for_pair(
    db: AsyncSession,
    *,
    chw_id: UUID,
    member_id: UUID,
) -> Conversation:
    """Return the existing Conversation between the pair, or create one atomically.

    Uses ``INSERT ... ON CONFLICT (chw_id, member_id) DO NOTHING RETURNING``
    so that two concurrent callers racing to create the first conversation for a
    pair will both end up with the same row rather than producing duplicates.
    The ``uq_conversations_chw_member`` UNIQUE constraint (added in migration
    ab1c2d3e4f5a) is the DB-level guard; this pattern is the application-level
    complement.

    Flow:
        1. Attempt an INSERT via ``pg_insert ... ON CONFLICT DO NOTHING``.
        2. If the INSERT returns a row (we won the race), load the full ORM
           object by primary key and return it.
        3. If the INSERT returns nothing (conflict — another request beat us),
           SELECT the existing row by (chw_id, member_id).

    Keyword-only args prevent accidental positional-argument swaps.
    The returned Conversation is flushed (not committed) so callers that build
    further objects in the same transaction get a valid ``id`` immediately.

    Args:
        db: The async SQLAlchemy session.
        chw_id: UUID of the Community Health Worker user.
        member_id: UUID of the member user.

    Returns:
        The existing or newly-inserted Conversation row (never a duplicate).
    """
    from sqlalchemy.dialects.postgresql import insert as pg_insert

    stmt = (
        pg_insert(Conversation)
        .values(chw_id=chw_id, member_id=member_id)
        .on_conflict_do_nothing(index_elements=["chw_id", "member_id"])
        .returning(Conversation.id)
    )
    result = await db.execute(stmt)
    row = result.first()

    if row is not None:
        # We inserted: load the full ORM object so callers get all columns.
        conv = await db.get(Conversation, row[0])
        # conv is guaranteed non-None — we just inserted the row in this
        # transaction. The type-narrowing assert keeps mypy happy.
        assert conv is not None
        return conv

    # Conflict: another concurrent request created this row first.
    # The UNIQUE constraint guarantees exactly one row exists now.
    existing = await db.execute(
        select(Conversation).where(
            Conversation.chw_id == chw_id,
            Conversation.member_id == member_id,
        )
    )
    conv = existing.scalar_one()
    return conv


async def create_followup_session(
    db: AsyncSession,
    *,
    conversation: Conversation,
    chw_user: User,
    member_user: User,
) -> Session:
    """Mint a new in_progress Session for a fresh call in an existing conversation.

    Billing lineage (request_id, vertical, mode) is cloned from the most
    recent prior Session so that billing claims chain correctly.

    Raises:
        ValueError: If the conversation already has an active (in_progress)
            Session — callers should reuse it rather than creating a duplicate.
        ValueError: If the conversation has no prior Sessions — the first
            Session must be created via the normal
            ``ServiceRequest → accept → start`` flow.

    Args:
        db: The async SQLAlchemy session.
        conversation: The Conversation this call belongs to.
        chw_user: User object for the CHW; must have an ``id`` attribute.
        member_user: User object for the member; must have an ``id`` attribute.

    Returns:
        The newly-flushed in_progress Session.
    """
    active = await get_active_session_for_conversation(db, conversation.id)
    if active is not None:
        raise ValueError(
            f"Conversation {conversation.id} already has an active session "
            f"({active.id}); reuse it instead of creating a duplicate."
        )

    prior_result = await db.execute(
        select(Session)
        .where(Session.conversation_id == conversation.id)
        .order_by(Session.created_at.desc())
        .limit(1)
    )
    prior = prior_result.scalar_one_or_none()
    if prior is None:
        raise ValueError(
            f"Conversation {conversation.id} has no prior Session to clone "
            "lineage from; create the first Session via the normal "
            "ServiceRequest→accept→start flow instead."
        )

    new_session = Session(
        request_id=prior.request_id,
        chw_id=chw_user.id,
        member_id=member_user.id,
        vertical=prior.vertical,
        mode=prior.mode,
        status="in_progress",
        started_at=datetime.now(UTC),
        conversation_id=conversation.id,
    )
    db.add(new_session)
    await db.flush()
    return new_session


async def resolve_target_session_for_call(
    db: AsyncSession,
    *,
    chw_id: UUID,
    member_id: UUID,
    chw_user,
    member_user,
    fallback_session_id: UUID | None,
) -> UUID | None:
    """Resolve the Session id a fresh call-bridge should attach its
    CommunicationSession (and Vonage outbound legs) to.

    Both ``/api/v1/communication/call-bridge`` and ``/api/v1/sessions/{id}/call``
    need exactly this logic when ``session_per_call_enabled=True``:

      1. Find the (chw, member) Conversation (or create it).
      2. Look up the Conversation's currently in_progress Session.
      3. Heal: if that "active" Session already has a
         ``SessionDocumentation`` row, the CHW has already closed it from
         their perspective (submit-doc without explicit End Session).
         Mark it ``completed`` and treat as no-active so a fresh Session
         gets minted for THIS call.
      4. If no active Session remains, ``create_followup_session`` mints
         one cloning lineage (``request_id``, ``vertical``, ``mode``)
         from the conversation's most recent prior Session.
      5. If ``create_followup_session`` raises (no prior Session in the
         conversation), fall back to ``fallback_session_id`` — the URL's
         id for /sessions/{id}/call, or ``body.session_id`` for
         /communication/call-bridge — so the call still proceeds.

    Until this helper existed both endpoints carried hand-copied versions
    of this block. One drifted (the /sessions/{id}/call copy didn't have
    the flag-on logic at all), every "same-thread multi-call" test
    silently used the stale Session, and every 2nd doc submit 409'd. The
    fix took most of a night to track down. Centralizing here so we
    never paste-then-diverge again.

    Returns the resolved Session id (may be a brand-new uuid or the
    fallback). Returns ``fallback_session_id`` unchanged when the flag
    is off — callers should check the flag themselves so this helper
    isn't paying for the conversation lookup in the legacy path.
    """
    import logging
    log = logging.getLogger("compass.communication")

    conversation = await find_or_create_conversation_for_pair(
        db, chw_id=chw_id, member_id=member_id,
    )
    active = await get_active_session_for_conversation(db, conversation.id)

    if active is not None:
        from app.models.session import SessionDocumentation
        existing_doc_row = await db.execute(
            select(SessionDocumentation.id).where(
                SessionDocumentation.session_id == active.id
            )
        )
        if existing_doc_row.scalar_one_or_none() is not None:
            log.info(
                "resolve_target_session_for_call: prior 'active' session %s "
                "already has a SessionDocumentation — auto-completing and "
                "minting a fresh Session (#193 skip-End-Session heal)",
                active.id,
            )
            active.status = "completed"
            if active.ended_at is None:
                active.ended_at = datetime.now(UTC)
            await db.flush()
            active = None

    if active is not None:
        return active.id

    try:
        new_session = await create_followup_session(
            db,
            conversation=conversation,
            chw_user=chw_user,
            member_user=member_user,
        )
        log.info(
            "resolve_target_session_for_call: #193 minted fresh Session %s "
            "for this call (fallback was %s, conv=%s)",
            new_session.id, fallback_session_id, conversation.id,
        )
        return new_session.id
    except ValueError as exc:
        # No prior Session in the conversation to clone lineage from.
        # Fall back to whatever the caller had — for /sessions/{id}/call
        # that's the URL session_id, for /communication/call-bridge it's
        # body.session_id (possibly None). Logged loudly because each
        # occurrence here means the call won't have a fresh billable
        # Session and the BE redirect on submit doc won't have anything
        # to redirect to.
        log.warning(
            "resolve_target_session_for_call: session_per_call_enabled but "
            "conv %s has no prior Session to clone — falling back to %s. "
            "Reason: %s",
            conversation.id, fallback_session_id, exc,
        )
        return fallback_session_id


async def resolve_active_session_id_for_redirect(
    db: AsyncSession,
    *,
    requested_session_id: UUID,
) -> UUID:
    """Transitional resolver for the session-per-call rollout (#193 Task 11
    server-side stand-in).

    When ``session_per_call_enabled=True`` but the FE hasn't shipped Task 11
    yet, the FE keeps submitting End Session / Submit Doc against the
    originally-clicked ``session.id`` (a stale, completed Session that
    already has a SessionDocumentation row). This helper returns the
    conversation's currently in_progress Session id so the BE can silently
    redirect the operation to the freshly-minted followup Session.

    Returns ``requested_session_id`` unchanged when no redirect applies:
    the session doesn't exist, has no ``conversation_id`` back-link
    (legacy data pre-migration), or the conversation has no active
    in_progress Session. Callers can use the result as a drop-in
    replacement for the URL ``session_id`` without additional gating.

    Becomes a true no-op once Task 11 ships and the FE starts sending the
    active_session_id directly — the requested id will already equal the
    active id, so this returns it unchanged.
    """
    session = await db.get(Session, requested_session_id)
    if session is None or session.conversation_id is None:
        return requested_session_id

    # Step 1: prefer the in_progress Session for this conversation (the
    # target for End Session). This handles the call → /complete leg.
    active = await get_active_session_for_conversation(db, session.conversation_id)
    if active is not None and active.id != requested_session_id:
        return active.id

    # Step 2: fall back to the most recent Session in this conversation
    # that lacks a SessionDocumentation. This handles the Submit Doc leg
    # that immediately follows End Session: by then the freshly-completed
    # Session is no longer in_progress, but it's still the target the FE
    # wants to document. The user describes the FE workflow as:
    #   Call ends → tap End Session → tap Submit Doc → done.
    # Both BE hits arrive with the original (stale) session_id and both
    # must redirect to the same freshly-minted Session.
    #
    # RECENCY FILTER: only consider Sessions whose started_at OR ended_at
    # is within the last hour. The (chw, member) conversation may have
    # weeks of legacy undocumented Sessions (pre-#193 data had a UC on
    # Conversation.session_id, so every prior Session got its own
    # Conversation row; the dedup helper currently returns the OLDEST
    # such Conversation, which can contain ancient siblings). Without the
    # recency filter, the resolver picked a 27-day-old Session as the
    # "current Submit Doc target" — observed in prod the night of
    # 2026-05-31. Ordering by ended_at DESC NULLS LAST puts the most
    # recently completed Session first.
    from datetime import UTC, datetime, timedelta

    from sqlalchemy import or_

    from app.models.session import SessionDocumentation

    recent_cutoff = datetime.now(UTC) - timedelta(hours=1)
    documented_subq = select(SessionDocumentation.session_id).subquery()
    result = await db.execute(
        select(Session)
        .where(
            Session.conversation_id == session.conversation_id,
            Session.id.notin_(select(documented_subq.c.session_id)),
            or_(
                Session.ended_at >= recent_cutoff,
                Session.started_at >= recent_cutoff,
                Session.created_at >= recent_cutoff,
            ),
        )
        .order_by(
            Session.ended_at.desc().nulls_last(),
            Session.started_at.desc().nulls_last(),
            Session.created_at.desc(),
        )
        .limit(1)
    )
    undocumented = result.scalar_one_or_none()
    if undocumented is not None and undocumented.id != requested_session_id:
        return undocumented.id

    return requested_session_id

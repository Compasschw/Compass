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


async def find_or_create_conversation_for_pair(
    db: AsyncSession,
    *,
    chw_id: UUID,
    member_id: UUID,
) -> Conversation:
    """Return the existing Conversation between the pair, or create one.

    Keyword-only args (``chw_id``, ``member_id``) prevent accidental
    positional-argument swaps.  When a new Conversation is created it is
    flushed to the DB (but not committed) so that the returned object
    carries a valid ``id``.

    Args:
        db: The async SQLAlchemy session.
        chw_id: UUID of the Community Health Worker user.
        member_id: UUID of the member user.

    Returns:
        The existing or newly-created Conversation row.
    """
    # Pick the oldest matching Conversation if duplicates exist. Legacy data
    # from before the session-per-call refactor had a UC on session_id (not
    # on the (chw,member) pair), so each prior Session got its own row and
    # the same pair can have N Conversation rows. scalar_one_or_none() would
    # raise MultipleResultsFound on those — which surfaces as a 500 in every
    # Accept Request flow for the pair. ORDER BY + LIMIT 1 makes the lookup
    # deterministic and safe; the follow-up UNIQUE (chw_id, member_id)
    # constraint will eventually prevent duplicates from being created at
    # all (tracked separately).
    result = await db.execute(
        select(Conversation)
        .where(
            Conversation.chw_id == chw_id,
            Conversation.member_id == member_id,
        )
        .order_by(Conversation.created_at.asc())
        .limit(1)
    )
    conv = result.scalar_one_or_none()
    if conv is not None:
        return conv

    conv = Conversation(chw_id=chw_id, member_id=member_id)
    db.add(conv)
    await db.flush()
    return conv


async def create_followup_session(
    db: AsyncSession,
    *,
    conversation: Conversation,
    chw_user: object,
    member_user: object,
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
    active = await get_active_session_for_conversation(db, session.conversation_id)
    if active is None or active.id == requested_session_id:
        return requested_session_id
    return active.id

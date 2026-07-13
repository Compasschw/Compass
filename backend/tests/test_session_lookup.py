"""Tests for app.services.session_lookup helpers (#193)."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.conversation import Conversation
from app.models.session import Session
from app.models.user import User
from app.models.request import ServiceRequest
from app.services.session_lookup import (
    create_followup_session,
    find_or_create_conversation_for_pair,
    get_active_session_for_conversation,
    get_active_session_started_ats_for_conversations,
)
from tests.conftest import test_session


async def _seed_pair(db: AsyncSession) -> tuple[User, User, ServiceRequest]:
    """Build a minimal CHW + member + ServiceRequest trio and flush.

    Each call generates unique UUIDs and emails so tests can run in parallel
    without PK / unique-index collisions.
    """
    chw = User(
        id=uuid.uuid4(),
        email=f"chw-{uuid.uuid4()}@example.com",
        password_hash="x",
        role="chw",
        name="CHW Tester",
    )
    member = User(
        id=uuid.uuid4(),
        email=f"member-{uuid.uuid4()}@example.com",
        password_hash="x",
        role="member",
        name="Member Tester",
    )
    req = ServiceRequest(
        id=uuid.uuid4(),
        member_id=member.id,
        vertical="health",
        urgency="routine",
        description="seed",
        preferred_mode="phone",
        status="completed",
        estimated_units=1,
    )
    # Flush users before the ServiceRequest so the FK constraint is satisfied.
    db.add_all([chw, member])
    await db.flush()
    db.add(req)
    await db.flush()
    return chw, member, req


# ── get_active_session_for_conversation ─────────────────────────────────────


@pytest.mark.asyncio
async def test_active_session_returns_in_progress_session() -> None:
    """When a conversation has one in_progress and one completed Session,
    the in_progress one is returned."""
    async with test_session() as db:
        chw, member, req = await _seed_pair(db)
        conv = Conversation(chw_id=chw.id, member_id=member.id)
        db.add(conv)
        await db.flush()

        completed = Session(
            request_id=req.id,
            chw_id=chw.id,
            member_id=member.id,
            vertical="health",
            mode="phone",
            status="completed",
            conversation_id=conv.id,
        )
        active = Session(
            request_id=req.id,
            chw_id=chw.id,
            member_id=member.id,
            vertical="health",
            mode="phone",
            status="in_progress",
            conversation_id=conv.id,
        )
        db.add_all([completed, active])
        await db.flush()

        result = await get_active_session_for_conversation(db, conv.id)
        assert result is not None
        assert result.id == active.id


# ── get_active_session_started_ats_for_conversations (session-timer source) ──


@pytest.mark.asyncio
async def test_started_ats_empty_input_returns_empty_dict() -> None:
    """Empty conversation list short-circuits to {} without a query."""
    async with test_session() as db:
        assert await get_active_session_started_ats_for_conversations(db, []) == {}


@pytest.mark.asyncio
async def test_started_ats_returns_start_time_for_in_progress_session() -> None:
    """The in_progress session's started_at is returned, keyed by conversation."""
    async with test_session() as db:
        chw, member, req = await _seed_pair(db)
        conv = Conversation(chw_id=chw.id, member_id=member.id)
        db.add(conv)
        await db.flush()

        start = datetime(2026, 7, 11, 10, 0, tzinfo=UTC)
        active = Session(
            request_id=req.id, chw_id=chw.id, member_id=member.id,
            vertical="health", mode="phone", status="in_progress",
            conversation_id=conv.id, started_at=start,
        )
        db.add(active)
        await db.flush()

        result = await get_active_session_started_ats_for_conversations(db, [conv.id])
        assert result[conv.id] == start


@pytest.mark.asyncio
async def test_started_ats_excludes_in_progress_session_with_null_start() -> None:
    """An in_progress session whose started_at is NULL is omitted (not None-valued).

    Guards the session-timer field: a half-initialized session must not surface a
    null timer value — the conversation is simply absent from the map.
    """
    async with test_session() as db:
        chw, member, req = await _seed_pair(db)
        conv = Conversation(chw_id=chw.id, member_id=member.id)
        db.add(conv)
        await db.flush()

        active_no_start = Session(
            request_id=req.id, chw_id=chw.id, member_id=member.id,
            vertical="health", mode="phone", status="in_progress",
            conversation_id=conv.id, started_at=None,
        )
        db.add(active_no_start)
        await db.flush()

        result = await get_active_session_started_ats_for_conversations(db, [conv.id])
        assert conv.id not in result


@pytest.mark.asyncio
async def test_active_session_returns_none_when_no_in_progress() -> None:
    """When a conversation has only completed Sessions, None is returned."""
    async with test_session() as db:
        chw, member, req = await _seed_pair(db)
        conv = Conversation(chw_id=chw.id, member_id=member.id)
        db.add(conv)
        await db.flush()

        completed = Session(
            request_id=req.id,
            chw_id=chw.id,
            member_id=member.id,
            vertical="health",
            mode="phone",
            status="completed",
            conversation_id=conv.id,
        )
        db.add(completed)
        await db.flush()

        result = await get_active_session_for_conversation(db, conv.id)
        assert result is None


@pytest.mark.asyncio
async def test_active_session_picks_most_recent_when_tied() -> None:
    """When two in_progress Sessions exist (defensive scenario),
    the one with the later created_at is returned."""
    async with test_session() as db:
        chw, member, req = await _seed_pair(db)
        conv = Conversation(chw_id=chw.id, member_id=member.id)
        db.add(conv)
        await db.flush()

        now = datetime.now(UTC)
        older = Session(
            request_id=req.id,
            chw_id=chw.id,
            member_id=member.id,
            vertical="health",
            mode="phone",
            status="in_progress",
            conversation_id=conv.id,
            created_at=now - timedelta(minutes=10),
        )
        newer = Session(
            request_id=req.id,
            chw_id=chw.id,
            member_id=member.id,
            vertical="health",
            mode="phone",
            status="in_progress",
            conversation_id=conv.id,
            created_at=now,
        )
        db.add_all([older, newer])
        await db.flush()

        result = await get_active_session_for_conversation(db, conv.id)
        assert result is not None
        assert result.id == newer.id


# ── find_or_create_conversation_for_pair ────────────────────────────────────


@pytest.mark.asyncio
async def test_find_or_create_returns_existing_conversation() -> None:
    """When a Conversation already exists for the pair, the same row is
    returned (no new row created)."""
    async with test_session() as db:
        chw, member, req = await _seed_pair(db)
        existing = Conversation(chw_id=chw.id, member_id=member.id)
        db.add(existing)
        await db.flush()

        result = await find_or_create_conversation_for_pair(
            db, chw_id=chw.id, member_id=member.id
        )
        assert result.id == existing.id


@pytest.mark.asyncio
async def test_find_or_create_creates_when_absent() -> None:
    """When no Conversation exists for the pair, a new one is created and
    its chw_id / member_id are set correctly."""
    async with test_session() as db:
        chw, member, req = await _seed_pair(db)

        result = await find_or_create_conversation_for_pair(
            db, chw_id=chw.id, member_id=member.id
        )
        assert result.id is not None
        assert result.chw_id == chw.id
        assert result.member_id == member.id


@pytest.mark.asyncio
async def test_find_or_create_enforces_unique_constraint() -> None:
    """The UNIQUE constraint on (chw_id, member_id) prevents duplicate
    Conversation rows from being created.

    Pre-migration: legacy data could have multiple rows per pair (one per
    Session under the old 1:1 UC). Migration ab1c2d3e4f5a consolidated those
    duplicates and added the UNIQUE constraint. This test verifies that the
    constraint is present and enforced — a second direct INSERT for the same
    pair must fail with an IntegrityError. The find_or_create helper itself
    uses ON CONFLICT DO NOTHING to avoid raising, returning the existing row.
    """
    import sqlalchemy.exc

    async with test_session() as db:
        chw, member, req = await _seed_pair(db)

        # First insert: must succeed.
        first = Conversation(chw_id=chw.id, member_id=member.id)
        db.add(first)
        await db.flush()

        # Second direct INSERT for the same pair: must raise IntegrityError.
        second = Conversation(chw_id=chw.id, member_id=member.id)
        db.add(second)
        with pytest.raises(
            sqlalchemy.exc.IntegrityError,
            match="uq_conversations_chw_member",
        ):
            await db.flush()

    # find_or_create handles the conflict gracefully: returns the existing row.
    async with test_session() as db:
        chw2, member2, _ = await _seed_pair(db)
        created = await find_or_create_conversation_for_pair(
            db, chw_id=chw2.id, member_id=member2.id
        )
        fetched = await find_or_create_conversation_for_pair(
            db, chw_id=chw2.id, member_id=member2.id
        )
        assert created.id == fetched.id, (
            "find_or_create must return the same row on a second call "
            "instead of raising on the UNIQUE constraint."
        )


# ── create_followup_session ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_create_followup_session_clones_billing_lineage() -> None:
    """A completed prior Session exists; create_followup_session mints a new
    Session that inherits request_id, vertical, and mode, with conversation_id
    matching."""
    async with test_session() as db:
        chw, member, req = await _seed_pair(db)
        conv = Conversation(chw_id=chw.id, member_id=member.id)
        db.add(conv)
        await db.flush()

        prior = Session(
            request_id=req.id,
            chw_id=chw.id,
            member_id=member.id,
            vertical="health",
            mode="phone",
            status="completed",
            conversation_id=conv.id,
        )
        db.add(prior)
        await db.flush()

        new_session = await create_followup_session(
            db, conversation=conv, chw_user=chw, member_user=member
        )

        assert new_session.id is not None
        assert new_session.id != prior.id
        assert new_session.request_id == req.id
        assert new_session.vertical == "health"
        assert new_session.mode == "phone"
        assert new_session.conversation_id == conv.id


@pytest.mark.asyncio
async def test_create_followup_session_does_not_auto_start() -> None:
    """Epic U regression: minting a followup Session for a fresh call must NOT
    start it. Begin Session (PATCH /sessions/{id}/start) is the only trigger
    that may set status='in_progress' / stamp started_at — a call landing on
    a conversation whose prior session is already documented used to mint
    (and silently start) a brand-new billable session, starting the timer
    without the CHW ever tapping Begin Session. Fails on the pre-fix code,
    which set status='in_progress' and started_at=now() here."""
    async with test_session() as db:
        chw, member, req = await _seed_pair(db)
        conv = Conversation(chw_id=chw.id, member_id=member.id)
        db.add(conv)
        await db.flush()

        prior = Session(
            request_id=req.id,
            chw_id=chw.id,
            member_id=member.id,
            vertical="health",
            mode="phone",
            status="completed",
            conversation_id=conv.id,
        )
        db.add(prior)
        await db.flush()

        new_session = await create_followup_session(
            db, conversation=conv, chw_user=chw, member_user=member
        )

        assert new_session.status == "scheduled"
        assert new_session.started_at is None


@pytest.mark.asyncio
async def test_create_followup_session_rejects_when_active_exists() -> None:
    """If the conversation already has an in_progress Session, a ValueError
    is raised containing 'already has an active session'."""
    async with test_session() as db:
        chw, member, req = await _seed_pair(db)
        conv = Conversation(chw_id=chw.id, member_id=member.id)
        db.add(conv)
        await db.flush()

        active = Session(
            request_id=req.id,
            chw_id=chw.id,
            member_id=member.id,
            vertical="health",
            mode="phone",
            status="in_progress",
            conversation_id=conv.id,
        )
        db.add(active)
        await db.flush()

        with pytest.raises(ValueError, match="already has an active session"):
            await create_followup_session(
                db, conversation=conv, chw_user=chw, member_user=member
            )


@pytest.mark.asyncio
async def test_create_followup_session_rejects_when_no_prior_session() -> None:
    """If the conversation has no prior Sessions at all, a ValueError is
    raised containing 'no prior Session to clone lineage from'."""
    async with test_session() as db:
        chw, member, req = await _seed_pair(db)
        conv = Conversation(chw_id=chw.id, member_id=member.id)
        db.add(conv)
        await db.flush()

        with pytest.raises(ValueError, match="no prior Session to clone lineage from"):
            await create_followup_session(
                db, conversation=conv, chw_user=chw, member_user=member
            )


# ── resolve_active_session_id_for_redirect (#193 BE redirect, transitional) ──


@pytest.mark.asyncio
async def test_resolve_redirects_to_active_when_requested_is_stale() -> None:
    """The FE submits against the original (completed) Session id; the
    resolver swaps to the conversation's currently in_progress Session."""
    from app.services.session_lookup import resolve_active_session_id_for_redirect

    async with test_session() as db:
        chw, member, req = await _seed_pair(db)
        conv = Conversation(chw_id=chw.id, member_id=member.id)
        db.add(conv)
        await db.flush()
        stale = Session(
            request_id=req.id, chw_id=chw.id, member_id=member.id,
            vertical="health", mode="phone",
            status="completed", conversation_id=conv.id,
        )
        active = Session(
            request_id=req.id, chw_id=chw.id, member_id=member.id,
            vertical="health", mode="phone",
            status="in_progress", conversation_id=conv.id,
        )
        db.add_all([stale, active])
        await db.flush()

        resolved = await resolve_active_session_id_for_redirect(
            db, requested_session_id=stale.id,
        )
        assert resolved == active.id


@pytest.mark.asyncio
async def test_resolve_returns_requested_when_already_active() -> None:
    """No-op when the requested id IS the active Session — the Task 11
    future state where the FE sends the right id."""
    from app.services.session_lookup import resolve_active_session_id_for_redirect

    async with test_session() as db:
        chw, member, req = await _seed_pair(db)
        conv = Conversation(chw_id=chw.id, member_id=member.id)
        db.add(conv)
        await db.flush()
        active = Session(
            request_id=req.id, chw_id=chw.id, member_id=member.id,
            vertical="health", mode="phone",
            status="in_progress", conversation_id=conv.id,
        )
        db.add(active)
        await db.flush()

        resolved = await resolve_active_session_id_for_redirect(
            db, requested_session_id=active.id,
        )
        assert resolved == active.id


@pytest.mark.asyncio
async def test_resolve_returns_requested_when_no_active_exists() -> None:
    """No active in_progress Session → don't redirect; let the caller's
    normal 409 path fire."""
    from app.services.session_lookup import resolve_active_session_id_for_redirect

    async with test_session() as db:
        chw, member, req = await _seed_pair(db)
        conv = Conversation(chw_id=chw.id, member_id=member.id)
        db.add(conv)
        await db.flush()
        completed = Session(
            request_id=req.id, chw_id=chw.id, member_id=member.id,
            vertical="health", mode="phone",
            status="completed", conversation_id=conv.id,
        )
        db.add(completed)
        await db.flush()

        resolved = await resolve_active_session_id_for_redirect(
            db, requested_session_id=completed.id,
        )
        assert resolved == completed.id


@pytest.mark.asyncio
async def test_resolve_returns_requested_when_no_conversation_link() -> None:
    """Legacy data without conversation_id back-link → pass through unchanged."""
    from app.services.session_lookup import resolve_active_session_id_for_redirect

    async with test_session() as db:
        chw, member, req = await _seed_pair(db)
        legacy = Session(
            request_id=req.id, chw_id=chw.id, member_id=member.id,
            vertical="health", mode="phone",
            status="completed", conversation_id=None,
        )
        db.add(legacy)
        await db.flush()

        resolved = await resolve_active_session_id_for_redirect(
            db, requested_session_id=legacy.id,
        )
        assert resolved == legacy.id


@pytest.mark.asyncio
async def test_resolve_returns_requested_when_session_missing() -> None:
    """Nonexistent session id → pass through unchanged (no crash)."""
    from uuid import uuid4
    from app.services.session_lookup import resolve_active_session_id_for_redirect

    async with test_session() as db:
        missing_id = uuid4()
        resolved = await resolve_active_session_id_for_redirect(
            db, requested_session_id=missing_id,
        )
        assert resolved == missing_id


@pytest.mark.asyncio
async def test_resolve_redirects_to_undocumented_completed_when_no_in_progress() -> None:
    """End-Session-then-Submit-Doc flow: by the time /documentation fires,
    the freshly-minted Session has already been completed by the prior
    /complete call, so step 1 (in_progress lookup) finds nothing. The
    resolver must fall back to "most recent Session in conv that lacks
    a SessionDocumentation" so doc submission lands on the right Session
    instead of 409'ing on the FE's stale session_id."""
    from app.models.session import SessionDocumentation
    from app.services.session_lookup import resolve_active_session_id_for_redirect

    async with test_session() as db:
        chw, member, req = await _seed_pair(db)
        conv = Conversation(chw_id=chw.id, member_id=member.id)
        db.add(conv)
        await db.flush()

        # Stale (S1) — completed AND has documentation.
        from datetime import UTC, datetime, timedelta
        stale = Session(
            request_id=req.id, chw_id=chw.id, member_id=member.id,
            vertical="health", mode="phone",
            status="completed", conversation_id=conv.id,
            created_at=datetime.now(UTC) - timedelta(hours=2),
        )
        db.add(stale)
        await db.flush()
        db.add(SessionDocumentation(
            session_id=stale.id, summary="prior",
            diagnosis_codes=["Z71.89"], procedure_code="98960", units_to_bill=1,
        ))

        # Freshly-completed (S2) — completed by the immediately-prior
        # /complete redirect, no doc yet.
        fresh_completed = Session(
            request_id=req.id, chw_id=chw.id, member_id=member.id,
            vertical="health", mode="phone",
            status="completed", conversation_id=conv.id,
        )
        db.add(fresh_completed)
        await db.flush()

        # FE submits doc against the stale id. Resolver must redirect to S2.
        resolved = await resolve_active_session_id_for_redirect(
            db, requested_session_id=stale.id,
        )
        assert resolved == fresh_completed.id, (
            "End-Session-then-Submit-Doc flow: resolver must fall through "
            "to the most-recent-undocumented Session when no in_progress "
            "exists. Without the fallback the 2nd same-thread doc submit "
            "409s on the FE's stale session_id."
        )


@pytest.mark.asyncio
async def test_resolve_prefers_in_progress_over_undocumented_when_both_exist() -> None:
    """When both an in_progress Session and a completed-undocumented one
    exist, the in_progress takes precedence (the /complete leg). Otherwise
    /complete would target the wrong Session."""
    from app.services.session_lookup import resolve_active_session_id_for_redirect

    async with test_session() as db:
        chw, member, req = await _seed_pair(db)
        conv = Conversation(chw_id=chw.id, member_id=member.id)
        db.add(conv)
        await db.flush()

        from datetime import UTC, datetime, timedelta
        # Older, completed, no doc.
        older = Session(
            request_id=req.id, chw_id=chw.id, member_id=member.id,
            vertical="health", mode="phone",
            status="completed", conversation_id=conv.id,
            created_at=datetime.now(UTC) - timedelta(hours=3),
        )
        # Stale FE id — completed and documented.
        stale = Session(
            request_id=req.id, chw_id=chw.id, member_id=member.id,
            vertical="health", mode="phone",
            status="completed", conversation_id=conv.id,
            created_at=datetime.now(UTC) - timedelta(hours=2),
        )
        # Most recent: in_progress.
        active = Session(
            request_id=req.id, chw_id=chw.id, member_id=member.id,
            vertical="health", mode="phone",
            status="in_progress", conversation_id=conv.id,
        )
        db.add_all([older, stale, active])
        await db.flush()

        resolved = await resolve_active_session_id_for_redirect(
            db, requested_session_id=stale.id,
        )
        assert resolved == active.id, (
            "In_progress must win over older undocumented completed Sessions"
        )


@pytest.mark.asyncio
async def test_resolve_step2_ignores_ancient_undocumented_sessions() -> None:
    """Prod 2026-05-31 night: the (jemal, jt) conversation contained both
    today's a2d17d19 (with doc) and ea5fab8b from 27 days earlier (without
    doc). Step 2 fell back to ea5fab8b and the 2nd doc submit landed on
    the May-3 ghost session. Step 2 must filter by recency so ancient
    undocumented siblings don't get redirected to."""
    from datetime import UTC, datetime, timedelta
    from app.services.session_lookup import resolve_active_session_id_for_redirect
    from app.models.session import SessionDocumentation

    async with test_session() as db:
        chw, member, req = await _seed_pair(db)
        conv = Conversation(chw_id=chw.id, member_id=member.id)
        db.add(conv)
        await db.flush()

        # Ancient completed session WITHOUT a doc — must NOT be picked.
        ancient = Session(
            request_id=req.id, chw_id=chw.id, member_id=member.id,
            vertical="health", mode="phone",
            status="completed", conversation_id=conv.id,
            created_at=datetime.now(UTC) - timedelta(days=27),
            started_at=datetime.now(UTC) - timedelta(days=27),
            ended_at=datetime.now(UTC) - timedelta(days=27),
        )
        # Recent stale (FE's session_id) WITH a doc — has documentation.
        stale = Session(
            request_id=req.id, chw_id=chw.id, member_id=member.id,
            vertical="health", mode="phone",
            status="scheduled", conversation_id=conv.id,
        )
        db.add_all([ancient, stale])
        await db.flush()
        db.add(SessionDocumentation(
            session_id=stale.id, summary="prior",
            diagnosis_codes=["Z71.89"], procedure_code="98960", units_to_bill=1,
        ))
        await db.flush()

        # No in_progress + only undocumented is the ancient one → must
        # NOT redirect (would have picked ancient pre-fix).
        resolved = await resolve_active_session_id_for_redirect(
            db, requested_session_id=stale.id,
        )
        assert resolved == stale.id, (
            f"Resolver should NOT redirect to a 27-day-old undocumented Session — "
            f"would corrupt billing rows with stale CommunicationSession data."
        )

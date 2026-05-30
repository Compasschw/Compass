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


# ── create_followup_session ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_create_followup_session_clones_billing_lineage() -> None:
    """A completed prior Session exists; create_followup_session mints a new
    in_progress Session that inherits request_id, vertical, and mode, with
    started_at stamped and conversation_id matching."""
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
        assert new_session.status == "in_progress"
        assert new_session.started_at is not None
        assert new_session.conversation_id == conv.id


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

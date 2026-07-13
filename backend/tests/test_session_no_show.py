"""Tests for PATCH /api/v1/sessions/{id}/no-show (Epic O2 — "Missed" no-show status).

Mirrors the abort test suite's shape (test_sessions.py's
test_abort_active_session_cancels_without_claim etc.) — see backend/TESTING.md's
TDD checklist: negative-auth, invariant-violation-state, and post-failure DB
state coverage for every new endpoint.
"""
import pytest
from httpx import AsyncClient

from tests.conftest import auth_header
from tests.test_sessions import _create_in_progress_session, create_request_and_match


@pytest.mark.asyncio
async def test_no_show_marks_active_session_without_claim(
    client: AsyncClient, chw_tokens, member_tokens
):
    """Marking an in_progress session as a no-show sets status='no_show',
    stamps ended_at, and files NO billing claim (no-show generates no claim)."""
    from uuid import UUID

    from sqlalchemy import select

    from app.models.billing import BillingClaim
    from tests.conftest import test_session as _tsf

    session_id = await _create_in_progress_session(client, member_tokens, chw_tokens)

    res = await client.patch(
        f"/api/v1/sessions/{session_id}/no-show", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["status"] == "no_show"
    assert data["ended_at"] is not None

    async with _tsf() as db:
        claims = (
            await db.execute(
                select(BillingClaim).where(BillingClaim.session_id == UUID(session_id))
            )
        ).scalars().all()
    assert claims == []


@pytest.mark.asyncio
async def test_no_show_rejects_scheduled_session(
    client: AsyncClient, chw_tokens, member_tokens
):
    """A member can't be a no-show for a session that never started → 409."""
    request_id = await create_request_and_match(client, member_tokens, chw_tokens)
    res = await client.post(
        "/api/v1/sessions/",
        json={"request_id": request_id, "scheduled_at": "2026-06-10T10:00:00Z", "mode": "in_person"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201
    session_id = res.json()["id"]
    assert res.json()["status"] == "scheduled"

    res = await client.patch(
        f"/api/v1/sessions/{session_id}/no-show", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 409, res.text


@pytest.mark.asyncio
async def test_no_show_rejects_completed_session(
    client: AsyncClient, chw_tokens, member_tokens
):
    """A completed session cannot be retroactively marked a no-show → 409."""
    session_id = await _create_in_progress_session(client, member_tokens, chw_tokens)
    res = await client.patch(
        f"/api/v1/sessions/{session_id}/complete", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200
    assert res.json()["status"] == "completed"

    res = await client.patch(
        f"/api/v1/sessions/{session_id}/no-show", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 409, res.text


@pytest.mark.asyncio
async def test_no_show_rejects_cancelled_session(
    client: AsyncClient, chw_tokens, member_tokens
):
    """A session already cancelled (via /abort) cannot be marked a no-show → 409."""
    session_id = await _create_in_progress_session(client, member_tokens, chw_tokens)
    res = await client.patch(
        f"/api/v1/sessions/{session_id}/abort", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200
    assert res.json()["status"] == "cancelled"

    res = await client.patch(
        f"/api/v1/sessions/{session_id}/no-show", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 409, res.text


@pytest.mark.asyncio
async def test_no_show_rejects_awaiting_documentation_session(
    client: AsyncClient, chw_tokens, member_tokens
):
    """Unlike /abort, /no-show does NOT accept awaiting_documentation — only
    in_progress. A session already ended (End Session tapped) must be
    documented or aborted, not marked a no-show, to avoid an ambiguous
    half-completed-then-missed state."""
    session_id = await _create_in_progress_session(client, member_tokens, chw_tokens)
    res = await client.post(
        f"/api/v1/sessions/{session_id}/end", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200
    assert res.json()["status"] == "awaiting_documentation"

    res = await client.patch(
        f"/api/v1/sessions/{session_id}/no-show", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 409, res.text


@pytest.mark.asyncio
async def test_no_show_relationship_gate_non_owning_chw(
    client: AsyncClient, chw_tokens, member_tokens
):
    """A CHW who doesn't own the session gets 404 (existence not leaked) —
    mirrors test_abort_relationship_gate."""
    session_id = await _create_in_progress_session(client, member_tokens, chw_tokens)
    res = await client.post("/api/v1/auth/register", json={
        "email": "chw_noshow2@example.com", "password": "testpass123",
        "name": "Other CHW", "role": "chw",
    })
    assert res.status_code == 201
    other = res.json()
    res = await client.patch(
        f"/api/v1/sessions/{session_id}/no-show", headers=auth_header(other)
    )
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_no_show_rejects_member_role(
    client: AsyncClient, chw_tokens, member_tokens
):
    """The session's own member cannot mark their own session a no-show —
    this is a CHW-only action. _load_chw_session_or_404 returns 404 (not
    403) for any non-owning-CHW/non-admin caller, matching the existing
    abort/end/pin/archive/mute endpoints' existence-hiding pattern."""
    session_id = await _create_in_progress_session(client, member_tokens, chw_tokens)
    res = await client.patch(
        f"/api/v1/sessions/{session_id}/no-show", headers=auth_header(member_tokens)
    )
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_no_show_requires_authentication(client: AsyncClient, chw_tokens, member_tokens):
    """No bearer token → 401, not a 404/500."""
    session_id = await _create_in_progress_session(client, member_tokens, chw_tokens)
    res = await client.patch(f"/api/v1/sessions/{session_id}/no-show")
    assert res.status_code == 401


@pytest.mark.asyncio
async def test_no_show_clears_active_session_lookup(
    client: AsyncClient, chw_tokens, member_tokens
):
    """After marking a no-show, the conversation's active-session lookup no
    longer returns this session — mirrors what /abort does so the CHW
    Messages timer/ActiveSessionBadge disappear. get_active_session_for_conversation
    filters strictly on status == 'in_progress', so flipping to 'no_show'
    must remove the row from that lookup."""
    from uuid import UUID

    from app.services.session_lookup import get_active_session_for_conversation
    from tests.conftest import test_session as _tsf

    session_id = await _create_in_progress_session(client, member_tokens, chw_tokens)

    async with _tsf() as db:
        from app.models.session import Session as SessionModel
        session_row = await db.get(SessionModel, UUID(session_id))
        conversation_id = session_row.conversation_id
        assert conversation_id is not None
        active_before = await get_active_session_for_conversation(db, conversation_id)
        assert active_before is not None
        assert active_before.id == UUID(session_id)

    res = await client.patch(
        f"/api/v1/sessions/{session_id}/no-show", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200, res.text

    async with _tsf() as db:
        active_after = await get_active_session_for_conversation(db, conversation_id)
    assert active_after is None


@pytest.mark.asyncio
async def test_no_show_is_not_idempotent_second_call_409s(
    client: AsyncClient, chw_tokens, member_tokens
):
    """Unlike /abort (idempotent — repeat calls no-op to the same terminal
    state), a second /no-show call on an already-no_show session 409s: the
    guard only accepts 'in_progress', and no_show is not in_progress. This
    is intentional — no-show is a one-shot terminal transition, invoked once
    from a UI action that immediately clears the active-session badge."""
    session_id = await _create_in_progress_session(client, member_tokens, chw_tokens)
    res = await client.patch(
        f"/api/v1/sessions/{session_id}/no-show", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200
    assert res.json()["status"] == "no_show"

    res = await client.patch(
        f"/api/v1/sessions/{session_id}/no-show", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 409, res.text


@pytest.mark.asyncio
async def test_abort_still_works_unchanged(client: AsyncClient, chw_tokens, member_tokens):
    """Regression: adding /no-show must not disturb /abort's existing
    behavior — an in_progress session can still be aborted to 'cancelled'
    with no billing claim."""
    from uuid import UUID

    from sqlalchemy import select

    from app.models.billing import BillingClaim
    from tests.conftest import test_session as _tsf

    session_id = await _create_in_progress_session(client, member_tokens, chw_tokens)
    res = await client.patch(
        f"/api/v1/sessions/{session_id}/abort", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "cancelled"

    async with _tsf() as db:
        claims = (
            await db.execute(
                select(BillingClaim).where(BillingClaim.session_id == UUID(session_id))
            )
        ).scalars().all()
    assert claims == []


@pytest.mark.asyncio
async def test_complete_session_still_works_unchanged(
    client: AsyncClient, chw_tokens, member_tokens
):
    """Regression: adding /no-show must not disturb /complete's existing
    behavior — an in_progress session can still be completed normally."""
    session_id = await _create_in_progress_session(client, member_tokens, chw_tokens)
    res = await client.patch(
        f"/api/v1/sessions/{session_id}/complete", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "completed"

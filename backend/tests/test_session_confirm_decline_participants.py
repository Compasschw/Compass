"""Tests for the initiator-inversion rule on PATCH /sessions/{id}/confirm
and /decline — the CHW-side widget bug fix, PLUS the QA2 A2 fix for
"Propose New Time doesn't remove the original" (confirmed-likely root cause).

Background: the CHW-side pending-approval widget showed ALL pending
sessions, including ones the CHW itself proposed, letting a CHW
self-approve their own proposal. The fix tracks WHO proposed a session's
current scheduled time (``Session.proposed_by``: 'chw' | 'member' | None)
and gates CONFIRM so only the NON-proposing party can act.

QA2 A2 root-cause fix: the initiator-inversion rule used to ALSO gate
``decline_session`` — which broke "Propose New Time". That flow books a new
pending session, then declines the OLD one; but the CHW (or member) who just
proposed the new time is also the proposer of the OLD session being
replaced, so the old "decline" inversion check 409'd their own retraction,
leaving BOTH the old and new pending sessions live instead of just the new
one. Fix: ``decline_session`` no longer calls the inversion helper at all —
declining/retracting a pending session is now unconditional for either
participant. Only ``confirm_session`` keeps the inversion check (accepting
your own proposal is the one case that really is invalid self-approval).

Coverage (per the initiator-inversion matrix in
app.routers.sessions._reject_self_approval_if_initiator, CONFIRM ONLY now):
  - Member confirms/declines a CHW-proposed session → 200.
  - Member cannot confirm their OWN proposal → 409 (decline: now 200, see
    "proposer may retract" section below).
  - CHW cannot confirm their OWN proposal → 409 (decline: now 200).
  - Legacy session (proposed_by=None): CHW confirm/decline still works
    (regression — a naive "reject all non-chw-proposed" implementation
    would break this); member confirm on legacy-null → 409, member DECLINE
    on legacy-null → 200 (decline has no inversion rule at all anymore).
  - Non-participant (different member / different CHW) → 404, not 403.
  - Unauthenticated → 401.
  - Nonexistent session_id → 404, not a 500.
  - Post-409-rejection DB state is unchanged (status/scheduling_status).
  - `proposed_by` is stamped correctly by POST /sessions/schedule for both
    CHW-initiated and member-initiated bookings.
  - Full "Propose New Time" simulation (book new pending + decline old, for
    both a CHW-initiated retraction and a member-initiated retraction):
    exactly ONE scheduled session remains; the old one is cancelled.
"""

from __future__ import annotations

import base64
import json
import uuid
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.models.session import Session
from tests.conftest import auth_header, complete_member_signup_payload
from tests.conftest import test_session as _db_session_factory


def _member_id(tokens: dict) -> str:
    payload_b64 = tokens["access_token"].split(".")[1]
    padded = payload_b64 + "=" * (4 - len(payload_b64) % 4)
    return str(UUID(json.loads(base64.urlsafe_b64decode(padded).decode())["sub"]))


async def _establish_relationship(
    client: AsyncClient, member_tokens: dict, chw_tokens: dict
) -> str:
    """Member files a request, CHW accepts it → care relationship. Returns member_id."""
    res = await client.post(
        "/api/v1/requests/",
        json={
            "vertical": "housing",
            "urgency": "routine",
            "description": "Need help",
            "preferred_mode": "in_person",
        },
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 201, res.text
    request_id = res.json()["id"]
    res = await client.patch(
        f"/api/v1/requests/{request_id}/accept", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200, res.text
    return _member_id(member_tokens)


async def _chw_proposed_pending_session_id(
    client: AsyncClient, member_tokens: dict, chw_tokens: dict, *, scheduled_at: str
) -> str:
    """CHW schedules a pending session with the member → proposed_by='chw'."""
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)
    res = await client.post(
        "/api/v1/sessions/schedule",
        json={
            "member_id": member_id,
            "scheduled_at": scheduled_at,
            "mode": "phone",
            "scheduling_status": "pending",
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    assert res.json()["scheduling_status"] == "pending"
    assert res.json()["proposed_by"] == "chw"
    return res.json()["id"]


async def _member_proposed_pending_session_id(
    client: AsyncClient, member_tokens: dict, chw_tokens: dict, *, scheduled_at: str
) -> str:
    """Member schedules with their CHW → always pending, proposed_by='member'."""
    await _establish_relationship(client, member_tokens, chw_tokens)
    chw_id = _member_id(chw_tokens)
    res = await client.post(
        "/api/v1/sessions/schedule",
        json={"chw_id": chw_id, "scheduled_at": scheduled_at, "mode": "phone"},
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 201, res.text
    assert res.json()["scheduling_status"] == "pending"
    assert res.json()["proposed_by"] == "member"
    return res.json()["id"]


async def _set_proposed_by(session_id: str, value: str | None) -> None:
    """Directly seed proposed_by on a session row — used to simulate legacy
    (pre-migration) rows where proposed_by is NULL, which cannot be produced
    via the current API (schedule_session always stamps a value)."""
    async with _db_session_factory() as db:
        session = await db.get(Session, uuid.UUID(session_id))
        session.proposed_by = value
        await db.commit()


async def _get_session_row(session_id: str) -> Session:
    async with _db_session_factory() as db:
        result = await db.execute(select(Session).where(Session.id == uuid.UUID(session_id)))
        return result.scalar_one()


# ─── proposed_by stamping on schedule_session ───────────────────────────────


@pytest.mark.asyncio
async def test_chw_initiated_schedule_stamps_proposed_by_chw(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    sid = await _chw_proposed_pending_session_id(
        client, member_tokens, chw_tokens, scheduled_at="2026-08-10T17:00:00Z"
    )
    row = await _get_session_row(sid)
    assert row.proposed_by == "chw"


@pytest.mark.asyncio
async def test_member_initiated_schedule_stamps_proposed_by_member(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    sid = await _member_proposed_pending_session_id(
        client, member_tokens, chw_tokens, scheduled_at="2026-08-10T17:00:00Z"
    )
    row = await _get_session_row(sid)
    assert row.proposed_by == "member"


# ─── Member confirms/declines a CHW-proposed session → 200 ─────────────────


@pytest.mark.asyncio
async def test_member_confirms_chw_proposed_session(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    sid = await _chw_proposed_pending_session_id(
        client, member_tokens, chw_tokens, scheduled_at="2026-08-11T17:00:00Z"
    )
    res = await client.patch(
        f"/api/v1/sessions/{sid}/confirm", headers=auth_header(member_tokens)
    )
    assert res.status_code == 200, res.text
    assert res.json()["scheduling_status"] == "confirmed"
    assert res.json()["status"] == "scheduled"


@pytest.mark.asyncio
async def test_member_declines_chw_proposed_session(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    sid = await _chw_proposed_pending_session_id(
        client, member_tokens, chw_tokens, scheduled_at="2026-08-11T18:00:00Z"
    )
    res = await client.patch(
        f"/api/v1/sessions/{sid}/decline", headers=auth_header(member_tokens)
    )
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "cancelled"


# ─── Self-approval rejection on CONFIRM (409) ───────────────────────────────


@pytest.mark.asyncio
async def test_member_cannot_confirm_own_proposal(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    sid = await _member_proposed_pending_session_id(
        client, member_tokens, chw_tokens, scheduled_at="2026-08-12T17:00:00Z"
    )
    res = await client.patch(
        f"/api/v1/sessions/{sid}/confirm", headers=auth_header(member_tokens)
    )
    assert res.status_code == 409, res.text

    # Post-rejection DB state unchanged.
    row = await _get_session_row(sid)
    assert row.scheduling_status == "pending"
    assert row.status == "scheduled"


@pytest.mark.asyncio
async def test_chw_cannot_confirm_own_proposal(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    sid = await _chw_proposed_pending_session_id(
        client, member_tokens, chw_tokens, scheduled_at="2026-08-13T17:00:00Z"
    )
    res = await client.patch(
        f"/api/v1/sessions/{sid}/confirm", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 409, res.text

    row = await _get_session_row(sid)
    assert row.scheduling_status == "pending"
    assert row.status == "scheduled"


# ─── Proposer MAY retract (decline) their own proposal — QA2 A2 fix ────────
#
# This is the failing-first regression for the "Propose New Time doesn't
# remove the original" root cause: on the PRE-fix code (decline also gated by
# _reject_self_approval_if_initiator), both of these asserted 409 — a
# proposer could not decline/retract their own pending session. That's
# exactly what CHWCalendarScreen's and MemberPendingRequestsList's "Propose
# New Time" flows do internally (book new pending, then decline the OLD
# session, whose proposer is the SAME caller who just re-proposed) — so the
# old rule broke that flow's second step every time. Post-fix, both succeed.


@pytest.mark.asyncio
async def test_member_can_decline_own_proposal_retraction(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """A member retracting their OWN proposal (e.g. mid "Propose New Time")
    must succeed — decline has no initiator-inversion rule."""
    sid = await _member_proposed_pending_session_id(
        client, member_tokens, chw_tokens, scheduled_at="2026-08-12T18:00:00Z"
    )
    res = await client.patch(
        f"/api/v1/sessions/{sid}/decline", headers=auth_header(member_tokens)
    )
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "cancelled"


@pytest.mark.asyncio
async def test_chw_can_decline_own_proposal_retraction(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """A CHW retracting their OWN proposal (e.g. mid "Propose New Time") must
    succeed — decline has no initiator-inversion rule."""
    sid = await _chw_proposed_pending_session_id(
        client, member_tokens, chw_tokens, scheduled_at="2026-08-13T18:00:00Z"
    )
    res = await client.patch(
        f"/api/v1/sessions/{sid}/decline", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "cancelled"


# ─── Legacy rows (proposed_by=None) ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_legacy_null_proposed_by_chw_confirm_still_works(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """Regression: a naive 'reject all non-chw-proposed' implementation would
    also reject proposed_by=None for the CHW, breaking every pre-migration
    pending session. CHW confirm on a legacy-null row must still succeed."""
    sid = await _member_proposed_pending_session_id(
        client, member_tokens, chw_tokens, scheduled_at="2026-08-14T17:00:00Z"
    )
    await _set_proposed_by(sid, None)

    res = await client.patch(
        f"/api/v1/sessions/{sid}/confirm", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200, res.text
    assert res.json()["scheduling_status"] == "confirmed"


@pytest.mark.asyncio
async def test_legacy_null_proposed_by_chw_decline_still_works(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    sid = await _member_proposed_pending_session_id(
        client, member_tokens, chw_tokens, scheduled_at="2026-08-14T18:00:00Z"
    )
    await _set_proposed_by(sid, None)

    res = await client.patch(
        f"/api/v1/sessions/{sid}/decline", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "cancelled"


@pytest.mark.asyncio
async def test_legacy_null_proposed_by_member_confirm_rejected(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """Member confirm on a legacy-null pending session → 409 (safe default;
    initiator unknown so we don't assume the CHW proposed it)."""
    sid = await _chw_proposed_pending_session_id(
        client, member_tokens, chw_tokens, scheduled_at="2026-08-15T17:00:00Z"
    )
    await _set_proposed_by(sid, None)

    res = await client.patch(
        f"/api/v1/sessions/{sid}/confirm", headers=auth_header(member_tokens)
    )
    assert res.status_code == 409, res.text

    row = await _get_session_row(sid)
    assert row.scheduling_status == "pending"
    assert row.status == "scheduled"


@pytest.mark.asyncio
async def test_legacy_null_proposed_by_member_decline_now_allowed(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """Decline has no initiator-inversion rule at all (QA2 A2) — a member
    declining a legacy-null pending session now succeeds, unlike confirm
    (which still conservatively 409s on legacy-null for a member caller;
    see test_legacy_null_proposed_by_member_confirm_rejected below)."""
    sid = await _chw_proposed_pending_session_id(
        client, member_tokens, chw_tokens, scheduled_at="2026-08-15T18:00:00Z"
    )
    await _set_proposed_by(sid, None)

    res = await client.patch(
        f"/api/v1/sessions/{sid}/decline", headers=auth_header(member_tokens)
    )
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "cancelled"


# ─── Non-participant → 404 ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_non_participant_member_gets_404_on_confirm(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    sid = await _chw_proposed_pending_session_id(
        client, member_tokens, chw_tokens, scheduled_at="2026-08-16T17:00:00Z"
    )
    payload = complete_member_signup_payload(
        email="other_member_confirm@example.com", name="Other Member"
    )
    payload["medi_cal_id"] = "99988877A"
    res = await client.post("/api/v1/auth/register", json=payload)
    assert res.status_code == 201, res.text
    other_member_tokens = res.json()

    res = await client.patch(
        f"/api/v1/sessions/{sid}/confirm", headers=auth_header(other_member_tokens)
    )
    assert res.status_code == 404, res.text


@pytest.mark.asyncio
async def test_non_participant_chw_gets_404_on_decline(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    sid = await _chw_proposed_pending_session_id(
        client, member_tokens, chw_tokens, scheduled_at="2026-08-16T18:00:00Z"
    )
    res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "other_chw_decline@example.com",
            "password": "testpass123",
            "name": "Other CHW",
            "role": "chw",
        },
    )
    assert res.status_code == 201, res.text
    other_chw_tokens = res.json()

    res = await client.patch(
        f"/api/v1/sessions/{sid}/decline", headers=auth_header(other_chw_tokens)
    )
    assert res.status_code == 404, res.text


# ─── Unauthenticated → 401 ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_unauthenticated_confirm_returns_401(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    sid = await _chw_proposed_pending_session_id(
        client, member_tokens, chw_tokens, scheduled_at="2026-08-17T17:00:00Z"
    )
    res = await client.patch(f"/api/v1/sessions/{sid}/confirm")
    assert res.status_code == 401, res.text


@pytest.mark.asyncio
async def test_unauthenticated_decline_returns_401(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    sid = await _chw_proposed_pending_session_id(
        client, member_tokens, chw_tokens, scheduled_at="2026-08-17T18:00:00Z"
    )
    res = await client.patch(f"/api/v1/sessions/{sid}/decline")
    assert res.status_code == 401, res.text


# ─── Nonexistent session_id → clean 404, not a 500 ──────────────────────────


@pytest.mark.asyncio
async def test_confirm_nonexistent_session_returns_404_not_500(
    client: AsyncClient, chw_tokens: dict, setup_db
):
    fake_id = uuid.uuid4()
    res = await client.patch(
        f"/api/v1/sessions/{fake_id}/confirm", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 404, res.text


@pytest.mark.asyncio
async def test_decline_nonexistent_session_returns_404_not_500(
    client: AsyncClient, member_tokens: dict, setup_db
):
    fake_id = uuid.uuid4()
    res = await client.patch(
        f"/api/v1/sessions/{fake_id}/decline", headers=auth_header(member_tokens)
    )
    assert res.status_code == 404, res.text


# ─── Regression: pre-existing CHW happy path for member-proposed sessions ──


@pytest.mark.asyncio
async def test_chw_confirm_decline_unchanged_for_member_proposed_sessions(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """The CHW's existing /confirm and /decline calls for member-proposed
    pendings must keep working unchanged after this fix."""
    sid = await _member_proposed_pending_session_id(
        client, member_tokens, chw_tokens, scheduled_at="2026-08-18T17:00:00Z"
    )
    res = await client.patch(
        f"/api/v1/sessions/{sid}/confirm", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200, res.text
    assert res.json()["scheduling_status"] == "confirmed"

    sid2 = await _member_proposed_pending_session_id(
        client, member_tokens, chw_tokens, scheduled_at="2026-08-18T18:00:00Z"
    )
    res = await client.patch(
        f"/api/v1/sessions/{sid2}/decline", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "cancelled"


# ─── Full "Propose New Time" simulation — the actual FE flow end-to-end ────
#
# CHWCalendarScreen.ScheduleSessionModal (propose mode) and
# MemberPendingRequestsList.ProposeNewTimeModal both: (1) POST
# /sessions/schedule to book the new pending session, THEN (2) PATCH
# /sessions/{old_id}/decline to retract the original — in that order, so a
# failed re-book never loses the original. Step (2) is the caller retracting
# THEIR OWN proposal (they're the same person who proposed the session being
# replaced), which is exactly what the old inversion rule 409'd. These tests
# run both steps back-to-back and assert the end state: exactly ONE
# `scheduled`+non-cancelled session survives, and the original is cancelled.


async def _list_sessions_for_pair(chw_id: str, member_id: str) -> list[dict]:
    """Sessions for this EXACT chw/member pair only — scoped narrowly (not a
    global chw_id-OR-member_id query) because the shared `chw_tokens`/
    `member_tokens` fixtures accumulate sessions across every test in this
    module's run, which would otherwise leak unrelated rows into the count."""
    async with _db_session_factory() as db:
        result = await db.execute(
            select(Session).where(
                Session.chw_id == UUID(chw_id),
                Session.member_id == UUID(member_id),
            )
        )
        return [
            {"id": str(s.id), "status": s.status, "scheduling_status": s.scheduling_status}
            for s in result.scalars().all()
        ]


@pytest.mark.asyncio
async def test_chw_propose_new_time_leaves_exactly_one_scheduled_session(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """CHW schedules a pending session (proposed_by='chw'), then uses
    "Propose New Time" to counter-offer a different slot: books the new
    pending session, then declines the old one. End state: exactly one
    non-cancelled `scheduled` session remains (the new one); the old one is
    `cancelled`.

    This is the failing-first regression for the confirmed root cause: on
    the pre-fix code, step 2 (the CHW declining their own chw-proposed
    original) 409'd, leaving BOTH sessions pending/scheduled instead of one.
    """
    old_sid = await _chw_proposed_pending_session_id(
        client, member_tokens, chw_tokens, scheduled_at="2026-08-20T17:00:00Z"
    )
    member_id = (await _get_session_row(old_sid)).member_id

    # Step 1: book the new pending session (the counter-offer).
    res = await client.post(
        "/api/v1/sessions/schedule",
        json={
            "member_id": str(member_id),
            "scheduled_at": "2026-08-20T19:00:00Z",
            "mode": "phone",
            "scheduling_status": "pending",
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    new_sid = res.json()["id"]
    assert res.json()["proposed_by"] == "chw"

    # Step 2: decline (retract) the OLD chw-proposed session — the CHW is
    # both the original proposer AND the caller here. Pre-fix this 409'd.
    res = await client.patch(
        f"/api/v1/sessions/{old_sid}/decline", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "cancelled"

    old_row = await _get_session_row(old_sid)
    new_row = await _get_session_row(new_sid)
    assert old_row.status == "cancelled"
    assert new_row.status == "scheduled"
    assert new_row.scheduling_status == "pending"

    # Exactly one non-cancelled PENDING session survives for this pair — i.e.
    # of the two sessions produced by the propose-new-time exchange
    # (old_sid, new_sid), only new_sid remains active. `_establish_relationship`
    # separately auto-creates one already-`confirmed` session as a side effect
    # of accepting the ServiceRequest (routers/requests.py accept_request) —
    # that's pre-existing, unrelated behavior, so this assertion scopes to
    # `scheduling_status == "pending"` rows rather than every row for the pair.
    all_rows = await _list_sessions_for_pair(_member_id(chw_tokens), str(member_id))
    pending_non_cancelled = [
        r for r in all_rows if r["status"] != "cancelled" and r["scheduling_status"] == "pending"
    ]
    assert len(pending_non_cancelled) == 1, all_rows
    assert pending_non_cancelled[0]["id"] == new_sid


@pytest.mark.asyncio
async def test_member_propose_new_time_leaves_exactly_one_scheduled_session(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """Member schedules with their CHW (always pending, proposed_by='member'),
    then uses "Propose New Time" (MemberPendingRequestsList) to counter-offer:
    books the new pending session, then declines the old one — retracting
    their OWN proposal. End state: exactly one non-cancelled `scheduled`
    session remains; the old one is `cancelled`.
    """
    old_sid = await _member_proposed_pending_session_id(
        client, member_tokens, chw_tokens, scheduled_at="2026-08-21T17:00:00Z"
    )
    chw_id = _member_id(chw_tokens)

    # Step 1: book the new pending session (the member's counter-offer).
    res = await client.post(
        "/api/v1/sessions/schedule",
        json={
            "chw_id": chw_id,
            "scheduled_at": "2026-08-21T20:00:00Z",
            "mode": "phone",
        },
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 201, res.text
    new_sid = res.json()["id"]
    assert res.json()["proposed_by"] == "member"

    # Step 2: decline (retract) the OLD member-proposed session — the member
    # is both the original proposer AND the caller here. Pre-fix this 409'd.
    res = await client.patch(
        f"/api/v1/sessions/{old_sid}/decline", headers=auth_header(member_tokens)
    )
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "cancelled"

    old_row = await _get_session_row(old_sid)
    new_row = await _get_session_row(new_sid)
    assert old_row.status == "cancelled"
    assert new_row.status == "scheduled"
    assert new_row.scheduling_status == "pending"

    # See the CHW-side test above for why this scopes to `scheduling_status
    # == "pending"` rather than every row for the pair (accept_request
    # auto-creates one unrelated already-confirmed session).
    all_rows = await _list_sessions_for_pair(chw_id, _member_id(member_tokens))
    pending_non_cancelled = [
        r for r in all_rows if r["status"] != "cancelled" and r["scheduling_status"] == "pending"
    ]
    assert len(pending_non_cancelled) == 1, all_rows
    assert pending_non_cancelled[0]["id"] == new_sid

import pytest
from httpx import AsyncClient

from tests.conftest import auth_header


async def create_request_and_match(client: AsyncClient, member_tokens: dict, chw_tokens: dict) -> str:
    res = await client.post("/api/v1/requests/", json={
        "vertical": "housing", "urgency": "routine",
        "description": "Need housing help", "preferred_mode": "in_person",
    }, headers=auth_header(member_tokens))
    assert res.status_code == 201
    request_id = res.json()["id"]

    res = await client.patch(f"/api/v1/requests/{request_id}/accept", headers=auth_header(chw_tokens))
    assert res.status_code == 200
    return request_id


@pytest.mark.asyncio
async def test_session_lifecycle(client: AsyncClient, chw_tokens, member_tokens):
    request_id = await create_request_and_match(client, member_tokens, chw_tokens)

    res = await client.post("/api/v1/sessions/", json={
        "request_id": request_id, "scheduled_at": "2026-04-10T10:00:00Z", "mode": "in_person",
    }, headers=auth_header(chw_tokens))
    assert res.status_code == 201
    session_id = res.json()["id"]
    assert res.json()["status"] == "scheduled"

    res = await client.patch(f"/api/v1/sessions/{session_id}/start", headers=auth_header(chw_tokens))
    assert res.status_code == 200
    assert res.json()["status"] == "in_progress"

    res = await client.patch(f"/api/v1/sessions/{session_id}/complete", headers=auth_header(chw_tokens))
    assert res.status_code == 200
    assert res.json()["status"] == "completed"


@pytest.mark.asyncio
async def test_cannot_start_completed_session(client: AsyncClient, chw_tokens, member_tokens):
    request_id = await create_request_and_match(client, member_tokens, chw_tokens)

    res = await client.post("/api/v1/sessions/", json={
        "request_id": request_id, "scheduled_at": "2026-04-10T10:00:00Z", "mode": "in_person",
    }, headers=auth_header(chw_tokens))
    session_id = res.json()["id"]

    await client.patch(f"/api/v1/sessions/{session_id}/start", headers=auth_header(chw_tokens))
    await client.patch(f"/api/v1/sessions/{session_id}/complete", headers=auth_header(chw_tokens))

    res = await client.patch(f"/api/v1/sessions/{session_id}/start", headers=auth_header(chw_tokens))
    assert res.status_code == 409


@pytest.mark.asyncio
async def test_cannot_complete_scheduled_session(client: AsyncClient, chw_tokens, member_tokens):
    request_id = await create_request_and_match(client, member_tokens, chw_tokens)

    res = await client.post("/api/v1/sessions/", json={
        "request_id": request_id, "scheduled_at": "2026-04-10T10:00:00Z", "mode": "in_person",
    }, headers=auth_header(chw_tokens))
    session_id = res.json()["id"]

    res = await client.patch(f"/api/v1/sessions/{session_id}/complete", headers=auth_header(chw_tokens))
    assert res.status_code == 409


@pytest.mark.asyncio
async def test_consent_requires_session_member(client: AsyncClient, chw_tokens, member_tokens):
    request_id = await create_request_and_match(client, member_tokens, chw_tokens)

    res = await client.post("/api/v1/sessions/", json={
        "request_id": request_id, "scheduled_at": "2026-04-10T10:00:00Z", "mode": "in_person",
    }, headers=auth_header(chw_tokens))
    session_id = res.json()["id"]

    res = await client.post(f"/api/v1/sessions/{session_id}/consent", json={
        "consent_type": "medical_billing", "typed_signature": "Test CHW",
    }, headers=auth_header(chw_tokens))
    assert res.status_code == 403

    res = await client.post(f"/api/v1/sessions/{session_id}/consent", json={
        "consent_type": "medical_billing", "typed_signature": "Test Member",
    }, headers=auth_header(member_tokens))
    assert res.status_code == 200


@pytest.mark.asyncio
async def test_documentation_duplicate_rejected(client: AsyncClient, chw_tokens, member_tokens):
    request_id = await create_request_and_match(client, member_tokens, chw_tokens)

    res = await client.post("/api/v1/sessions/", json={
        "request_id": request_id, "scheduled_at": "2026-04-10T10:00:00Z", "mode": "in_person",
    }, headers=auth_header(chw_tokens))
    session_id = res.json()["id"]

    await client.patch(f"/api/v1/sessions/{session_id}/start", headers=auth_header(chw_tokens))
    await client.patch(f"/api/v1/sessions/{session_id}/complete", headers=auth_header(chw_tokens))

    # Explicit session_start_time/session_end_time (30min, >=16min-floor
    # billable — see billing_service.calculate_units) rather than relying on
    # the server-tracked start/complete duration, which in a fast test run
    # is ~0 minutes and would now 422 as not-billable under the 16-minute
    # floor (2026-07-13). This test is about duplicate-submission rejection,
    # not the units bracket, so it supplies an unambiguously billable window.
    doc_payload = {
        "summary": "Helped with housing", "diagnosis_codes": ["Z59.1"],
        "procedure_code": "98960", "units_to_bill": 2,
        "session_start_time": "2026-04-10T10:00:00Z",
        "session_end_time": "2026-04-10T10:30:00Z",
    }

    res = await client.post(f"/api/v1/sessions/{session_id}/documentation", json=doc_payload, headers=auth_header(chw_tokens))
    assert res.status_code == 200

    res = await client.post(f"/api/v1/sessions/{session_id}/documentation", json=doc_payload, headers=auth_header(chw_tokens))
    assert res.status_code == 409


@pytest.mark.asyncio
async def test_documentation_completes_awaiting_session(
    client: AsyncClient, chw_tokens, member_tokens
):
    """Submitting documentation completes an awaiting_documentation session.

    Regression: the real CHW flow is Complete Session → /end
    (awaiting_documentation) → /documentation. Before the fix, /documentation
    left the session in awaiting_documentation, so the CHW's "Complete Session"
    button never flipped back to "Begin Session".
    """
    session_id = await _create_in_progress_session(client, member_tokens, chw_tokens)

    # End → awaiting_documentation
    res = await client.post(
        f"/api/v1/sessions/{session_id}/end", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200
    assert res.json()["status"] == "awaiting_documentation"

    # Submit documentation → should complete the session. Explicit
    # session_start_time/session_end_time (30min, >=16min-floor billable)
    # rather than relying on the server-tracked duration, which in a fast
    # test run is ~0 minutes and would now 422 as not-billable under the
    # 16-minute floor (2026-07-13) — this test is about the status
    # transition, not the units bracket.
    doc_payload = {
        "summary": "Helped with housing",
        "diagnosis_codes": ["Z59.1"],
        "procedure_code": "98960",
        "units_to_bill": 1,
        "session_start_time": "2026-06-10T10:00:00Z",
        "session_end_time": "2026-06-10T10:30:00Z",
    }
    res = await client.post(
        f"/api/v1/sessions/{session_id}/documentation",
        json=doc_payload,
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200

    # The session is now completed (the bug left it in awaiting_documentation).
    res = await client.get(
        f"/api/v1/sessions/{session_id}", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200
    assert res.json()["status"] == "completed"


@pytest.mark.asyncio
async def test_invalid_enum_rejected(client: AsyncClient, member_tokens):
    res = await client.post("/api/v1/requests/", json={
        "vertical": "invalid_vertical", "urgency": "routine",
        "description": "Test", "preferred_mode": "in_person",
    }, headers=auth_header(member_tokens))
    assert res.status_code == 422


# ── End Session lifecycle tests ───────────────────────────────────────────────


async def _create_in_progress_session(
    client: AsyncClient,
    member_tokens: dict,
    chw_tokens: dict,
) -> str:
    """Helper: create a service request, create a session, and start it.

    Returns the session_id (str) of the in_progress session.
    """
    request_id = await create_request_and_match(client, member_tokens, chw_tokens)

    res = await client.post(
        "/api/v1/sessions/",
        json={"request_id": request_id, "scheduled_at": "2026-06-10T10:00:00Z", "mode": "in_person"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201
    session_id = res.json()["id"]

    res = await client.patch(
        f"/api/v1/sessions/{session_id}/start",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200
    assert res.json()["status"] == "in_progress"
    return session_id


@pytest.mark.asyncio
async def test_end_session_transitions_to_awaiting_documentation(
    client: AsyncClient, chw_tokens, member_tokens
):
    """POST /end on an in_progress session should return awaiting_documentation."""
    session_id = await _create_in_progress_session(client, member_tokens, chw_tokens)

    res = await client.post(
        f"/api/v1/sessions/{session_id}/end",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "awaiting_documentation"
    assert data["ended_at"] is not None


@pytest.mark.asyncio
async def test_end_session_idempotent(client: AsyncClient, chw_tokens, member_tokens):
    """Calling /end a second time returns 200 with current state (no error)."""
    session_id = await _create_in_progress_session(client, member_tokens, chw_tokens)

    # First call: transitions correctly.
    res = await client.post(
        f"/api/v1/sessions/{session_id}/end",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200
    assert res.json()["status"] == "awaiting_documentation"

    # Second call: idempotent — still 200, no status change.
    res = await client.post(
        f"/api/v1/sessions/{session_id}/end",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200
    assert res.json()["status"] == "awaiting_documentation"


@pytest.mark.asyncio
async def test_end_session_rejects_scheduled(client: AsyncClient, chw_tokens, member_tokens):
    """POST /end on a scheduled (not yet started) session should return 409."""
    request_id = await create_request_and_match(client, member_tokens, chw_tokens)

    res = await client.post(
        "/api/v1/sessions/",
        json={"request_id": request_id, "scheduled_at": "2026-06-10T10:00:00Z", "mode": "in_person"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201
    session_id = res.json()["id"]
    assert res.json()["status"] == "scheduled"

    res = await client.post(
        f"/api/v1/sessions/{session_id}/end",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 409


@pytest.mark.asyncio
async def test_end_session_rejects_completed(client: AsyncClient, chw_tokens, member_tokens):
    """POST /end on an already-completed session should return 409."""
    session_id = await _create_in_progress_session(client, member_tokens, chw_tokens)

    # Transition to completed via /complete
    res = await client.patch(
        f"/api/v1/sessions/{session_id}/complete",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200
    assert res.json()["status"] == "completed"

    # Now attempt /end on a completed session
    res = await client.post(
        f"/api/v1/sessions/{session_id}/end",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 409


@pytest.mark.asyncio
async def test_end_session_relationship_gate(client: AsyncClient, chw_tokens, member_tokens):
    """A second CHW must not be able to end a session they don't own.

    This verifies both the 404-not-403 behaviour (don't reveal existence).
    """
    session_id = await _create_in_progress_session(client, member_tokens, chw_tokens)

    # Register a second CHW.
    res = await client.post("/api/v1/auth/register", json={
        "email": "chw2@example.com", "password": "Testpass123!",
        "name": "Second CHW", "role": "chw",
    })
    assert res.status_code == 201
    other_chw_tokens = res.json()

    res = await client.post(
        f"/api/v1/sessions/{session_id}/end",
        headers=auth_header(other_chw_tokens),
    )
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_documentation_bills_units_from_chw_entered_times(
    client: AsyncClient, chw_tokens, member_tokens
):
    """When the CHW supplies session_start_time/session_end_time, units are
    billed from that entered window (not the ~0-min server-tracked duration of
    a just-started test session), and the window is persisted on the session."""
    from uuid import UUID

    from sqlalchemy import select

    from app.models.billing import BillingClaim
    from app.models.session import Session
    from tests.conftest import test_session as _tsf

    session_id = await _create_in_progress_session(client, member_tokens, chw_tokens)

    # 80-minute window → 3 units (>75, ≤105 bracket in calculate_units).
    payload = {
        "summary": "Worked on housing goals",
        "diagnosis_codes": ["Z59.1"],
        "procedure_code": "98960",
        "session_start_time": "2026-07-10T15:00:00Z",
        "session_end_time": "2026-07-10T16:20:00Z",
    }
    res = await client.post(
        f"/api/v1/sessions/{session_id}/documentation",
        json=payload, headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text

    async with _tsf() as db:
        claim = (
            await db.execute(
                select(BillingClaim).where(BillingClaim.session_id == UUID(session_id))
            )
        ).scalar_one()
        sess = await db.get(Session, UUID(session_id))

    assert claim.units == 3
    assert sess.duration_minutes == 80
    assert sess.started_at.isoformat().startswith("2026-07-10T15:00")
    assert sess.ended_at.isoformat().startswith("2026-07-10T16:20")


@pytest.mark.asyncio
async def test_documentation_rejects_end_not_after_start(
    client: AsyncClient, chw_tokens, member_tokens
):
    """End time must be strictly after start time → 422, no claim created."""
    session_id = await _create_in_progress_session(client, member_tokens, chw_tokens)
    payload = {
        "summary": "x",
        "diagnosis_codes": ["Z59.1"],
        "procedure_code": "98960",
        "session_start_time": "2026-07-10T16:00:00Z",
        "session_end_time": "2026-07-10T15:00:00Z",
    }
    res = await client.post(
        f"/api/v1/sessions/{session_id}/documentation",
        json=payload, headers=auth_header(chw_tokens),
    )
    assert res.status_code == 422, res.text


@pytest.mark.asyncio
async def test_abort_active_session_cancels_without_claim(
    client: AsyncClient, chw_tokens, member_tokens
):
    """Aborting an in_progress session cancels it and files NO billing claim."""
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
async def test_abort_rejects_scheduled_session(
    client: AsyncClient, chw_tokens, member_tokens
):
    """A scheduled (not-yet-started) session can't be aborted → 409 (use /cancel)."""
    request_id = await create_request_and_match(client, member_tokens, chw_tokens)
    res = await client.post(
        "/api/v1/sessions/",
        json={"request_id": request_id, "scheduled_at": "2026-06-10T10:00:00Z", "mode": "in_person"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201
    session_id = res.json()["id"]

    res = await client.patch(
        f"/api/v1/sessions/{session_id}/abort", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 409, res.text


@pytest.mark.asyncio
async def test_abort_is_idempotent(client: AsyncClient, chw_tokens, member_tokens):
    """Aborting an already-cancelled session returns 200 with current state."""
    session_id = await _create_in_progress_session(client, member_tokens, chw_tokens)
    res = await client.patch(
        f"/api/v1/sessions/{session_id}/abort", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200
    res = await client.patch(
        f"/api/v1/sessions/{session_id}/abort", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "cancelled"


@pytest.mark.asyncio
async def test_abort_relationship_gate(client: AsyncClient, chw_tokens, member_tokens):
    """A CHW who doesn't own the session gets 404 (existence not leaked)."""
    session_id = await _create_in_progress_session(client, member_tokens, chw_tokens)
    res = await client.post("/api/v1/auth/register", json={
        "email": "chw_abort2@example.com", "password": "Testpass123!",
        "name": "Other CHW", "role": "chw",
    })
    assert res.status_code == 201
    other = res.json()
    res = await client.patch(
        f"/api/v1/sessions/{session_id}/abort", headers=auth_header(other)
    )
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_roadmap_item_includes_session_id_and_mark_complete_succeeds(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict
) -> None:
    """Regression: GET /member/roadmap must include session_id on each item so
    the member-side 'mark complete' PATCH /sessions/{id}/followups/{id} can
    resolve the correct session row.  Without session_id the client falls back
    to 'unknown' and the PATCH 404s.

    This test FAILS on the pre-fix frontend type (SessionFollowup lacked
    sessionId) and would FAIL on a backend that stopped returning session_id.
    """
    import base64
    import json as _json
    import uuid as _uuid

    from app.models.followup import SessionFollowup as SessionFollowupModel
    from tests.conftest import test_session

    # ── Setup: request → accept → session ────────────────────────────────────
    request_id = await create_request_and_match(client, member_tokens, chw_tokens)

    res = await client.post(
        "/api/v1/sessions/",
        json={"request_id": request_id, "scheduled_at": "2026-04-10T10:00:00Z", "mode": "in_person"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    session_id = res.json()["id"]

    def _decode_sub(tokens: dict) -> str:
        seg = tokens["access_token"].split(".")[1]
        padded = seg + "=" * (4 - len(seg) % 4)
        return _json.loads(base64.urlsafe_b64decode(padded))["sub"]

    member_id = _decode_sub(member_tokens)
    chw_id = _decode_sub(chw_tokens)

    # ── Seed a roadmap followup row (no HTTP endpoint creates followups) ──────
    followup_id = _uuid.uuid4()
    async with test_session() as db:
        followup = SessionFollowupModel(
            id=followup_id,
            session_id=_uuid.UUID(session_id),
            chw_id=_uuid.UUID(chw_id),
            member_id=_uuid.UUID(member_id),
            kind="action_item",
            description="Schedule a housing intake appointment",
            show_on_roadmap=True,
            status="pending",
        )
        db.add(followup)
        await db.commit()

    # ── Assert: GET /member/roadmap returns session_id ────────────────────────
    res = await client.get("/api/v1/member/roadmap", headers=auth_header(member_tokens))
    assert res.status_code == 200, res.text
    items = res.json()
    assert len(items) == 1, f"Expected 1 roadmap item, got {len(items)}"
    item = items[0]
    assert str(item["session_id"]) == session_id, (
        "roadmap item missing session_id — mark-complete PATCH would 404 with 'unknown'"
    )
    assert str(item["id"]) == str(followup_id)

    # ── Assert: PATCH mark-complete as member succeeds ────────────────────────
    res = await client.patch(
        f"/api/v1/sessions/{session_id}/followups/{followup_id}",
        json={"status": "completed"},
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "completed"


# ── Part 9 (QA batch 2026-07-14 #9): draft case notes finalize on submit ──────


@pytest.mark.asyncio
async def test_submit_documentation_finalizes_only_this_sessions_drafts(
    client: AsyncClient, chw_tokens, member_tokens
):
    """submit_documentation must, in the same transaction that completes the
    session, flip exactly THIS session's draft case notes to 'final' — never
    another session's drafts, and never a soft-deleted note (it stays exactly
    as it was, since it's no longer a live record to "finish").

    This test FAILS on the pre-fix code (no case_notes.status column / no
    finalize step at all — every note stays whatever it was created as).
    """
    import uuid as _uuid

    from app.models.case_note import CaseNote
    from tests.conftest import test_session as _tsf

    session_a = await _create_in_progress_session(client, member_tokens, chw_tokens)
    session_b = await _create_in_progress_session(client, member_tokens, chw_tokens)

    # Get member_id once (both sessions share the same member/CHW fixtures).
    profile_res = await client.get(
        "/api/v1/member/profile", headers=auth_header(member_tokens)
    )
    member_id = profile_res.json()["user_id"]

    # Draft note on session A — the one that will be submitted.
    res = await client.post(
        "/api/v1/case-notes",
        json={"member_id": member_id, "body": "Note on session A.", "session_id": session_a},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201
    note_a_id = res.json()["id"]
    assert res.json()["status"] == "draft"

    # A second draft note on session A that gets soft-deleted before submit —
    # must be left exactly as-is (deleted_at IS NULL guard on the bulk update).
    res = await client.post(
        "/api/v1/case-notes",
        json={"member_id": member_id, "body": "Deleted before submit.", "session_id": session_a},
        headers=auth_header(chw_tokens),
    )
    note_a_deleted_id = res.json()["id"]
    res = await client.delete(
        f"/api/v1/case-notes/{note_a_deleted_id}", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 204

    # Draft note on session B — an unrelated, still-open session. Must remain
    # untouched when session A's documentation is submitted.
    res = await client.post(
        "/api/v1/case-notes",
        json={"member_id": member_id, "body": "Note on session B.", "session_id": session_b},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201
    note_b_id = res.json()["id"]
    assert res.json()["status"] == "draft"

    # Submit documentation for session A only.
    doc_payload = {
        "summary": "Helped with housing",
        "diagnosis_codes": ["Z59.1"],
        "procedure_code": "98960",
        "session_start_time": "2026-06-10T10:00:00Z",
        "session_end_time": "2026-06-10T10:30:00Z",
    }
    res = await client.post(
        f"/api/v1/sessions/{session_a}/documentation",
        json=doc_payload,
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text

    async with _tsf() as db:
        note_a = await db.get(CaseNote, _uuid.UUID(note_a_id))
        note_a_deleted = await db.get(CaseNote, _uuid.UUID(note_a_deleted_id))
        note_b = await db.get(CaseNote, _uuid.UUID(note_b_id))

    assert note_a.status == "final", "session A's live draft must finalize on submit"
    assert note_a_deleted.status == "draft", (
        "a soft-deleted note must never be touched by the finalize bulk-update"
    )
    assert note_b.status == "draft", (
        "session B's draft must stay untouched when session A's docs are submitted"
    )

    # Sanity: the finalized note is still visible + editable via the normal
    # list/patch endpoints (finalizing is a status flip, not a lock).
    res = await client.get(
        f"/api/v1/members/{member_id}/case-notes",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200
    statuses = {item["id"]: item["status"] for item in res.json()["items"]}
    assert statuses[note_a_id] == "final"
    assert statuses[note_b_id] == "draft"


# ── Part 13 (QA batch 2026-07-14 #13): session end time = entered value ───────


@pytest.mark.asyncio
async def test_submit_while_in_progress_persists_entered_end_exactly(
    client: AsyncClient, chw_tokens, member_tokens
):
    """Submitting documentation while the session is still 'in_progress' (the
    CHW's live timer never stopped — Akram's exact QA flow, no /end call in
    between) must persist the CHW-typed Session End value exactly as the
    session's ended_at — never `datetime.now()` at submit time.
    """
    from uuid import UUID as _UUID

    from app.models.session import Session
    from tests.conftest import test_session as _tsf

    session_id = await _create_in_progress_session(client, member_tokens, chw_tokens)

    entered_end = "2026-06-10T10:30:00+00:00"
    doc_payload = {
        "summary": "Submitted while the timer was still running.",
        "diagnosis_codes": ["Z59.1"],
        "procedure_code": "98960",
        "session_start_time": "2026-06-10T10:00:00Z",
        "session_end_time": entered_end,
    }
    res = await client.post(
        f"/api/v1/sessions/{session_id}/documentation",
        json=doc_payload,
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text

    async with _tsf() as db:
        sess = await db.get(Session, _UUID(session_id))
    assert sess.ended_at.isoformat() == "2026-06-10T10:30:00+00:00"


@pytest.mark.asyncio
async def test_submit_after_end_overwrites_tracked_end_with_entered_value(
    client: AsyncClient, chw_tokens, member_tokens
):
    """When the CHW has already pressed Complete (POST /end stamps
    ended_at=now()), a subsequently CHW-entered Session End on the
    documentation form must OVERWRITE the tracked now()-stamped value — the
    typed value is authoritative, not whichever timestamp got there first.
    """
    from uuid import UUID as _UUID

    from app.models.session import Session
    from tests.conftest import test_session as _tsf

    session_id = await _create_in_progress_session(client, member_tokens, chw_tokens)

    res = await client.post(
        f"/api/v1/sessions/{session_id}/end", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200
    assert res.json()["status"] == "awaiting_documentation"

    async with _tsf() as db:
        tracked_end = (await db.get(Session, _UUID(session_id))).ended_at
    assert tracked_end is not None  # /end stamped now()

    entered_end = "2026-06-10T11:45:00+00:00"
    doc_payload = {
        "summary": "Entered a different end time than /end tracked.",
        "diagnosis_codes": ["Z59.1"],
        "procedure_code": "98960",
        "session_start_time": "2026-06-10T10:00:00Z",
        "session_end_time": entered_end,
    }
    res = await client.post(
        f"/api/v1/sessions/{session_id}/documentation",
        json=doc_payload,
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text

    async with _tsf() as db:
        sess = await db.get(Session, _UUID(session_id))
    assert sess.ended_at.isoformat() == "2026-06-10T11:45:00+00:00"
    assert sess.ended_at != tracked_end


@pytest.mark.asyncio
async def test_entered_end_time_round_trips_across_timezone_offset(
    client: AsyncClient, chw_tokens, member_tokens
):
    """A non-UTC entered end time (e.g. 08:40 PM Pacific, sent as an
    ISO string carrying a -07:00 offset — the shape
    parseSessionDateTimeInputToIso produces from the DocumentationModal's
    typed local time) must round-trip to the exact same instant — no
    naive-UTC shift when the server normalizes it.
    """
    from datetime import datetime as _dt
    from uuid import UUID as _UUID

    from app.models.session import Session
    from tests.conftest import test_session as _tsf

    session_id = await _create_in_progress_session(client, member_tokens, chw_tokens)

    # 2026-06-10T20:40:00-07:00 == 2026-06-11T03:40:00Z
    entered_start = "2026-06-10T19:00:00-07:00"
    entered_end = "2026-06-10T20:40:00-07:00"
    doc_payload = {
        "summary": "Pacific-time entry.",
        "diagnosis_codes": ["Z59.1"],
        "procedure_code": "98960",
        "session_start_time": entered_start,
        "session_end_time": entered_end,
    }
    res = await client.post(
        f"/api/v1/sessions/{session_id}/documentation",
        json=doc_payload,
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text

    async with _tsf() as db:
        sess = await db.get(Session, _UUID(session_id))

    expected_instant = _dt.fromisoformat(entered_end)
    assert sess.ended_at == expected_instant
    # 100-minute window (19:00 -> 20:40) — confirms no offset was dropped when
    # computing duration_minutes either.
    assert sess.duration_minutes == 100


@pytest.mark.asyncio
async def test_csv_export_row_shows_the_entered_end_time(
    client: AsyncClient, chw_tokens, member_tokens
):
    """The billing CSV export's Activity End Time must be the CHW-entered
    Session End value (Session.ended_at), not the documentation's
    submitted_at wall-clock timestamp — see billing_csv_writer.build_row_from_models.
    """
    from uuid import UUID as _UUID

    from sqlalchemy import select as _select

    from app.models.billing import BillingClaim
    from app.models.session import Session
    from app.models.user import MemberProfile, User
    from app.services.billing_csv_writer import build_row_from_models
    from tests.conftest import test_session as _tsf

    session_id = await _create_in_progress_session(client, member_tokens, chw_tokens)

    entered_end = "2026-06-10T10:30:00+00:00"
    doc_payload = {
        "summary": "CSV export check.",
        "diagnosis_codes": ["Z59.1"],
        "procedure_code": "98960",
        "session_start_time": "2026-06-10T10:00:00Z",
        "session_end_time": entered_end,
    }
    res = await client.post(
        f"/api/v1/sessions/{session_id}/documentation",
        json=doc_payload,
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text

    async with _tsf() as db:
        from app.models.session import SessionDocumentation

        sess = await db.get(Session, _UUID(session_id))
        claim = (
            await db.execute(
                _select(BillingClaim).where(BillingClaim.session_id == sess.id)
            )
        ).scalar_one()
        documentation = (
            await db.execute(
                _select(SessionDocumentation).where(
                    SessionDocumentation.session_id == sess.id
                )
            )
        ).scalar_one()
        member_user = await db.get(User, sess.member_id)
        member_profile = (
            await db.execute(
                _select(MemberProfile).where(MemberProfile.user_id == sess.member_id)
            )
        ).scalar_one_or_none()
        chw_user = await db.get(User, sess.chw_id)

        row = build_row_from_models(
            claim=claim,
            session=sess,
            member_user=member_user,
            member_profile=member_profile,
            chw_user=chw_user,
            documentation=documentation,
            consent_given=True,
        )

    assert row.activity_end_utc is not None
    assert row.activity_end_utc.isoformat() == "2026-06-10T10:30:00+00:00"
    # Confirms it's NOT the documentation submission wall-clock time.
    assert row.activity_end_utc != documentation.submitted_at

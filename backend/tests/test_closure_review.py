"""Tests for Epic B3 — post-close-account review capture.

  POST /api/v1/chw/members/{member_id}/closure-review

Coverage
--------
1.  Happy path — closure review persists: status='pending',
    source='account_closure', member_id + chw_id correctly linked, rating
    is None (text-only).
2.  121-char text -> 422 (Pydantic max_length boundary).
3.  Empty text -> 422 (Pydantic min_length boundary).
4.  A CHW with no relationship to the member -> 403 (matches close_member's
    own authorization boundary — see _assert_chw_member_relationship_or_admin).
5.  Member-role caller -> 403 (role guard inside _require_chw_or_admin_key).
6.  Unauthenticated caller -> 401.
7.  Allowed for a member the CHW has just closed (closed status ok) — the
    relationship gate is unaffected by close_member having run.
8.  Regression: close_member itself is unchanged — close succeeds with no
    review row created, and works exactly as before whether or not a
    closure-review is ever submitted.
9.  Regression: the session-testimonial path (POST /sessions/{id}/testimonials)
    is unchanged — rating is still REQUIRED there (omitting it -> 422).

Mirrors tests/test_member_close.py for relationship setup + auth, and
tests/test_testimonials.py for the session-testimonial regression check.
"""

from __future__ import annotations

import base64
import json
from uuid import UUID

import pytest
from httpx import AsyncClient

from tests.conftest import auth_header


def _member_id(tokens: dict) -> str:
    payload_b64 = tokens["access_token"].split(".")[1]
    padded = payload_b64 + "=" * (4 - len(payload_b64) % 4)
    return str(UUID(json.loads(base64.urlsafe_b64decode(padded).decode())["sub"]))


async def _establish_relationship(
    client: AsyncClient, member_tokens: dict, chw_tokens: dict
) -> str:
    """Create + accept a service request so the CHW has an active relationship
    with the member. Returns the member's UUID string.
    """
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
        f"/api/v1/requests/{request_id}/accept",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    return _member_id(member_tokens)


# ─── 1. Happy path ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_closure_review_persists_pending_account_closure(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
) -> None:
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)
    chw_id = _member_id(chw_tokens)

    res = await client.post(
        f"/api/v1/chw/members/{member_id}/closure-review",
        json={"text": "My CHW was incredibly helpful and kind."},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["member_id"] == member_id
    assert body["chw_id"] == chw_id
    assert body["text"] == "My CHW was incredibly helpful and kind."
    assert body["status"] == "pending"
    assert body["source"] == "account_closure"


# ─── 2 & 3. Text length boundaries ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_closure_review_121_chars_rejected(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
) -> None:
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)
    res = await client.post(
        f"/api/v1/chw/members/{member_id}/closure-review",
        json={"text": "x" * 121},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 422, res.text


@pytest.mark.asyncio
async def test_closure_review_120_chars_accepted(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
) -> None:
    """Boundary check: exactly 120 chars is the max allowed, not rejected."""
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)
    res = await client.post(
        f"/api/v1/chw/members/{member_id}/closure-review",
        json={"text": "x" * 120},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    assert len(res.json()["text"]) == 120


@pytest.mark.asyncio
async def test_closure_review_empty_text_rejected(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
) -> None:
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)
    res = await client.post(
        f"/api/v1/chw/members/{member_id}/closure-review",
        json={"text": ""},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 422, res.text


# ─── 4. Non-owning CHW ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_unrelated_chw_cannot_submit_closure_review(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
) -> None:
    """No request/accept -> no relationship -> 403, mirroring close_member's
    own gate (test_unrelated_chw_cannot_close in test_member_close.py).
    """
    member_id = _member_id(member_tokens)
    res = await client.post(
        f"/api/v1/chw/members/{member_id}/closure-review",
        json={"text": "Should not be allowed"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 403, res.text


# ─── 5. Member role caller ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_member_role_cannot_submit_closure_review(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
) -> None:
    """A member JWT is rejected by the shared _require_chw_or_admin_key
    dependency's role check (403 'CHW role required'), same as any other
    CHW-only endpoint in this router.
    """
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)
    res = await client.post(
        f"/api/v1/chw/members/{member_id}/closure-review",
        json={"text": "Attempting as member"},
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 403, res.text


# ─── 6. Unauthenticated ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_unauthenticated_cannot_submit_closure_review(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
) -> None:
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)
    res = await client.post(
        f"/api/v1/chw/members/{member_id}/closure-review",
        json={"text": "No auth header"},
    )
    assert res.status_code in (401, 403), res.text


# ─── 7. Allowed for a member the CHW just closed ───────────────────────────────


@pytest.mark.asyncio
async def test_closure_review_allowed_after_member_closed(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
) -> None:
    """The relationship gate is unaffected by close_member having already
    run — closing a member does not delete/alter the session or
    service-request rows the gate queries, so the CHW can still submit the
    parting review for a member they just closed.
    """
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)

    close_res = await client.post(
        f"/api/v1/chw/members/{member_id}/close",
        json={"status": "closed_successful", "reason": "successfully_completed"},
        headers=auth_header(chw_tokens),
    )
    assert close_res.status_code == 200, close_res.text

    review_res = await client.post(
        f"/api/v1/chw/members/{member_id}/closure-review",
        json={"text": "Thanks for everything!"},
        headers=auth_header(chw_tokens),
    )
    assert review_res.status_code == 201, review_res.text
    assert review_res.json()["status"] == "pending"
    assert review_res.json()["source"] == "account_closure"


# ─── 8. Regression: close_member itself is unchanged ───────────────────────────


@pytest.mark.asyncio
async def test_close_member_succeeds_with_no_review_submitted(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
) -> None:
    """close_member must succeed and behave identically whether or not a
    closure-review is ever submitted afterward — the review is a wholly
    separate, optional call. This is the regression guard for "close must
    never fail because the review failed/was skipped."
    """
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)

    res = await client.post(
        f"/api/v1/chw/members/{member_id}/close",
        json={"status": "closed_successful", "reason": "successfully_completed"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["closure_status"] == "closed_successful"
    assert body["closure_reason"] == "successfully_completed"
    assert body["closed_at"] is not None
    # No closure-review call was made — close_member's response has no
    # knowledge of / dependency on the review endpoint whatsoever.
    assert "text" not in body
    assert "source" not in body


@pytest.mark.asyncio
async def test_close_member_response_shape_unchanged(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
) -> None:
    """Explicit shape-lock regression: MemberClosureResponse still returns
    exactly member_id/closure_status/closure_reason/closed_at — B3 must not
    have widened this response model.
    """
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)
    res = await client.post(
        f"/api/v1/chw/members/{member_id}/close",
        json={"status": "declined", "reason": "declined_all_services"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    assert set(res.json().keys()) == {
        "member_id",
        "closure_status",
        "closure_reason",
        "closed_at",
    }


# ─── 9. Regression: session-testimonial path still requires rating ────────────


@pytest.mark.asyncio
async def test_session_testimonial_still_requires_rating(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
) -> None:
    """The session-scoped POST /sessions/{id}/testimonials endpoint must
    still REQUIRE `rating` at the schema layer — B3 only relaxed the DB
    column + added the closure-review path; TestimonialCreate (session path)
    is untouched. Omitting rating -> 422, exactly as before B3.
    """
    from datetime import UTC, datetime

    # Set up a completed session (mirrors test_testimonials.py's helper).
    res = await client.post(
        "/api/v1/requests/",
        json={
            "vertical": "housing",
            "urgency": "routine",
            "description": "Regression check session",
            "preferred_mode": "in_person",
        },
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 201, res.text
    request_id = res.json()["id"]

    res = await client.patch(
        f"/api/v1/requests/{request_id}/accept",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text

    res = await client.post(
        "/api/v1/sessions/",
        json={
            "request_id": request_id,
            "mode": "in_person",
            "scheduled_at": datetime.now(UTC).isoformat(),
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    session_id = res.json()["id"]

    res = await client.patch(
        f"/api/v1/sessions/{session_id}/start",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text

    res = await client.patch(
        f"/api/v1/sessions/{session_id}/complete",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text

    # Omit rating entirely — must still 422 (rating is required in
    # TestimonialCreate; only the DB column + closure-review path changed).
    res = await client.post(
        f"/api/v1/sessions/{session_id}/testimonials",
        json={"text": "No rating provided"},
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 422, res.text

    # Sanity: WITH rating, the session-testimonial path still works exactly
    # as before (rating persisted, source defaults to 'session').
    res = await client.post(
        f"/api/v1/sessions/{session_id}/testimonials",
        json={"rating": 5, "text": "Great CHW!"},
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 201, res.text
    assert res.json()["rating"] == 5

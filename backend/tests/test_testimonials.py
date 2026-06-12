"""Integration tests for the Testimonials system.

Coverage
--------
1.  Member-only POST gate — CHW caller receives 403
2.  Session ownership gate — member who did NOT own the session receives 403
3.  Session completed-status gate — rating a scheduled session → 422
4.  Happy path POST — creates a pending testimonial (201)
5.  Duplicate (member, session) → 409
6.  Public GET /chws/{id}/testimonials returns ONLY approved testimonials
7.  Public GET hides member_id; returns first-initial author_initial only
8.  Admin queue GET — filters by status correctly
9.  Admin moderation approve → status becomes 'approved'
10. Admin moderation reject → status becomes 'rejected'
11. Admin re-moderate (approve → reject) is allowed (no 409)
12. Summary endpoint returns correct avg and count for approved only
13. Summary endpoint NULL-safe when no testimonials exist (rating_avg=None, count=0)
14. Rating out-of-range (0 and 6) → 422 from Pydantic validation
15. Text length > 500 chars → 422 from Pydantic validation
16. Unknown session_id → 404
17. CHW JWT cannot POST a testimonial (403 — role guard)
18. Admin key required for admin endpoints (missing key → 403)

All tests run against a live PostgreSQL test database via the shared conftest.
No mocks — full request → router → ORM → commit path.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from httpx import AsyncClient

from tests.conftest import auth_header, complete_member_signup_payload


# ─── Shared fixtures and helpers ──────────────────────────────────────────────


# Read the live settings value — CI's workflow env sets a different ADMIN_KEY
# than conftest's local setdefault, so a hardcoded literal 401s in CI.
from app.config import settings as _settings

ADMIN_KEY = _settings.admin_key


def admin_auth_header() -> dict:
    """Return the Authorization header for admin-key-protected endpoints."""
    return {"Authorization": f"Bearer {ADMIN_KEY}"}


async def _register_extra_member(client: AsyncClient, email: str = "other@example.com") -> dict:
    """Register a second member and return its tokens dict.

    Members must supply every Pear-required signup field (#14); the CIN is
    derived from the email so multiple members in one test stay distinct.
    """
    payload = complete_member_signup_payload(
        email=email,
        name="Other Member",
        password="testpass123",
    )
    payload["medi_cal_id"] = f"{abs(hash(email)) % 100_000_000:08d}A"
    res = await client.post("/api/v1/auth/register", json=payload)
    assert res.status_code == 201, res.text
    return res.json()


async def _create_completed_session(
    client: AsyncClient,
    member_tokens: dict,
    chw_tokens: dict,
) -> str:
    """Create a service request, have the CHW accept it, create a session,
    then mark it completed. Returns the session UUID string.
    """
    # Member creates a request.
    res = await client.post(
        "/api/v1/requests/",
        json={
            "vertical": "housing",
            "urgency": "routine",
            "description": "Test testimonials session",
            "preferred_mode": "in_person",
        },
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 201, res.text
    request_id = res.json()["id"]

    # CHW accepts the request.
    res = await client.patch(
        f"/api/v1/requests/{request_id}/accept",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text

    # CHW creates a session.
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

    # CHW starts the session (scheduled → in_progress).
    res = await client.patch(
        f"/api/v1/sessions/{session_id}/start",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text

    # CHW marks the session completed (in_progress → completed).
    res = await client.patch(
        f"/api/v1/sessions/{session_id}/complete",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "completed"

    return session_id


async def _create_scheduled_session(
    client: AsyncClient,
    member_tokens: dict,
    chw_tokens: dict,
) -> str:
    """Create a service request + session in 'scheduled' status (not completed)."""
    res = await client.post(
        "/api/v1/requests/",
        json={
            "vertical": "food",
            "urgency": "routine",
            "description": "Scheduled-only test",
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
    return res.json()["id"]


async def _submit_testimonial(
    client: AsyncClient,
    member_tokens: dict,
    session_id: str,
    rating: int = 5,
    text: str | None = "Great CHW!",
) -> dict:
    """POST a testimonial and return the response body."""
    res = await client.post(
        f"/api/v1/sessions/{session_id}/testimonials",
        json={"rating": rating, "text": text},
        headers=auth_header(member_tokens),
    )
    return res


# ─── 1. Member-only POST gate ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_chw_cannot_post_testimonial(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """A CHW JWT on the POST endpoint must return 403."""
    session_id = await _create_completed_session(client, member_tokens, chw_tokens)
    res = await client.post(
        f"/api/v1/sessions/{session_id}/testimonials",
        json={"rating": 4, "text": "Test"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 403, res.text


# ─── 2. Session ownership gate ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_non_owner_member_cannot_post_testimonial(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """A member who was NOT part of the session receives 403."""
    session_id = await _create_completed_session(client, member_tokens, chw_tokens)
    other_member = await _register_extra_member(client, "other2@example.com")

    res = await client.post(
        f"/api/v1/sessions/{session_id}/testimonials",
        json={"rating": 3, "text": "Not my session"},
        headers=auth_header(other_member),
    )
    assert res.status_code == 403, res.text


# ─── 3. Completed-status gate ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_cannot_rate_scheduled_session(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """Rating a session that is still 'scheduled' must return 422."""
    session_id = await _create_scheduled_session(client, member_tokens, chw_tokens)

    res = await client.post(
        f"/api/v1/sessions/{session_id}/testimonials",
        json={"rating": 5, "text": "Premature"},
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 422, res.text


# ─── 4. Happy path POST ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_create_testimonial_success(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """Valid POST returns 201 with a pending testimonial."""
    session_id = await _create_completed_session(client, member_tokens, chw_tokens)

    res = await _submit_testimonial(client, member_tokens, session_id, rating=5, text="Excellent!")
    assert res.status_code == 201, res.text

    body = res.json()
    assert body["status"] == "pending"
    assert body["rating"] == 5
    assert body["text"] == "Excellent!"
    assert body["session_id"] == session_id
    assert "member_id" in body  # full row returned to the submitting member
    assert "id" in body


# ─── 5. Duplicate (member, session) → 409 ────────────────────────────────────


@pytest.mark.asyncio
async def test_duplicate_testimonial_returns_409(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """Second POST for the same (member, session) returns 409."""
    session_id = await _create_completed_session(client, member_tokens, chw_tokens)

    first = await _submit_testimonial(client, member_tokens, session_id, rating=4)
    assert first.status_code == 201, first.text

    second = await _submit_testimonial(client, member_tokens, session_id, rating=3)
    assert second.status_code == 409, second.text


# ─── 6. Public GET only returns approved ─────────────────────────────────────


@pytest.mark.asyncio
async def test_public_list_returns_only_approved(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """Pending and rejected testimonials must not appear in the public list."""
    import json
    import base64

    # Extract chw_id from the CHW JWT.
    token = chw_tokens["access_token"]
    payload_b64 = token.split(".")[1]
    padded = payload_b64 + "=" * (4 - len(payload_b64) % 4)
    chw_id = json.loads(base64.urlsafe_b64decode(padded))["sub"]

    session_id = await _create_completed_session(client, member_tokens, chw_tokens)
    await _submit_testimonial(client, member_tokens, session_id, rating=5, text="Pending one")

    # Public list should be empty (testimonial is still pending).
    res = await client.get(
        f"/api/v1/chws/{chw_id}/testimonials",
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 200, res.text
    assert res.json() == []

    # Admin approves the testimonial.
    admin_list = await client.get(
        "/api/v1/admin/testimonials?status=pending",
        headers=admin_auth_header(),
    )
    assert admin_list.status_code == 200, admin_list.text
    items = admin_list.json()
    assert len(items) == 1

    testimonial_id = items[0]["id"]
    mod_res = await client.post(
        f"/api/v1/admin/testimonials/{testimonial_id}/moderate",
        json={"action": "approve"},
        headers=admin_auth_header(),
    )
    assert mod_res.status_code == 200, mod_res.text

    # Now the public list should contain the approved testimonial.
    res2 = await client.get(
        f"/api/v1/chws/{chw_id}/testimonials",
        headers=auth_header(member_tokens),
    )
    assert res2.status_code == 200, res2.text
    listed = res2.json()
    assert len(listed) == 1
    assert listed[0]["rating"] == 5
    assert listed[0]["text"] == "Pending one"


# ─── 7. Public GET hides member_id, returns author_initial ───────────────────


@pytest.mark.asyncio
async def test_public_list_returns_author_initial_not_member_id(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """PublicTestimonial must include author_initial and must NOT include member_id."""
    import json, base64

    token = chw_tokens["access_token"]
    payload_b64 = token.split(".")[1]
    padded = payload_b64 + "=" * (4 - len(payload_b64) % 4)
    chw_id = json.loads(base64.urlsafe_b64decode(padded))["sub"]

    session_id = await _create_completed_session(client, member_tokens, chw_tokens)
    await _submit_testimonial(client, member_tokens, session_id, rating=4, text="Good session")

    # Approve via admin.
    admin_list = await client.get(
        "/api/v1/admin/testimonials?status=pending",
        headers=admin_auth_header(),
    )
    testimonial_id = admin_list.json()[0]["id"]
    await client.post(
        f"/api/v1/admin/testimonials/{testimonial_id}/moderate",
        json={"action": "approve"},
        headers=admin_auth_header(),
    )

    # Public list response.
    res = await client.get(
        f"/api/v1/chws/{chw_id}/testimonials",
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 200, res.text
    item = res.json()[0]

    # member_id must NOT be present.
    assert "member_id" not in item

    # author_initial must be "T." (from "Test Member" registered in conftest).
    assert "author_initial" in item
    assert item["author_initial"] == "T."


# ─── 8. Admin queue GET filters by status ────────────────────────────────────


@pytest.mark.asyncio
async def test_admin_queue_filters_by_status(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """Admin GET with status=pending returns only pending items."""
    session_id = await _create_completed_session(client, member_tokens, chw_tokens)
    await _submit_testimonial(client, member_tokens, session_id)

    res = await client.get(
        "/api/v1/admin/testimonials?status=pending",
        headers=admin_auth_header(),
    )
    assert res.status_code == 200, res.text
    items = res.json()
    assert len(items) == 1
    assert items[0]["status"] == "pending"
    assert "member_name" in items[0]
    assert "chw_name" in items[0]

    # Approved queue should be empty initially.
    res2 = await client.get(
        "/api/v1/admin/testimonials?status=approved",
        headers=admin_auth_header(),
    )
    assert res2.status_code == 200, res2.text
    assert res2.json() == []


# ─── 9. Admin moderation: approve ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_admin_approve_testimonial(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """Admin approve transitions status to 'approved'."""
    session_id = await _create_completed_session(client, member_tokens, chw_tokens)
    post_res = await _submit_testimonial(client, member_tokens, session_id, rating=5)
    testimonial_id = post_res.json()["id"]

    res = await client.post(
        f"/api/v1/admin/testimonials/{testimonial_id}/moderate",
        json={"action": "approve", "notes": "Looks good"},
        headers=admin_auth_header(),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["status"] == "approved"
    assert body["moderation_notes"] == "Looks good"
    assert body["moderated_at"] is not None


# ─── 10. Admin moderation: reject ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_admin_reject_testimonial(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """Admin reject transitions status to 'rejected'."""
    session_id = await _create_completed_session(client, member_tokens, chw_tokens)
    post_res = await _submit_testimonial(client, member_tokens, session_id, rating=1)
    testimonial_id = post_res.json()["id"]

    res = await client.post(
        f"/api/v1/admin/testimonials/{testimonial_id}/moderate",
        json={"action": "reject", "notes": "Inappropriate content"},
        headers=admin_auth_header(),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["status"] == "rejected"
    assert body["moderation_notes"] == "Inappropriate content"


# ─── 11. Admin re-moderate (approve → reject) ────────────────────────────────


@pytest.mark.asyncio
async def test_admin_can_re_moderate(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """An admin can reverse a moderation decision (approve → reject)."""
    session_id = await _create_completed_session(client, member_tokens, chw_tokens)
    post_res = await _submit_testimonial(client, member_tokens, session_id, rating=3)
    testimonial_id = post_res.json()["id"]

    # First: approve.
    await client.post(
        f"/api/v1/admin/testimonials/{testimonial_id}/moderate",
        json={"action": "approve"},
        headers=admin_auth_header(),
    )

    # Then: reject (should succeed, not 409).
    res = await client.post(
        f"/api/v1/admin/testimonials/{testimonial_id}/moderate",
        json={"action": "reject", "notes": "Changed mind"},
        headers=admin_auth_header(),
    )
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "rejected"


# ─── 12. Summary endpoint correctness ────────────────────────────────────────


@pytest.mark.asyncio
async def test_summary_returns_correct_avg_and_count(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """Summary reflects only approved testimonials, not pending."""
    import json, base64

    token = chw_tokens["access_token"]
    payload_b64 = token.split(".")[1]
    padded = payload_b64 + "=" * (4 - len(payload_b64) % 4)
    chw_id = json.loads(base64.urlsafe_b64decode(padded))["sub"]

    # Create two completed sessions (requires two separate member+request flows).
    session1 = await _create_completed_session(client, member_tokens, chw_tokens)

    # Register a second member and create a second session.
    second_member = await _register_extra_member(client, "member2@example.com")

    # Second member creates a request + session.
    res = await client.post(
        "/api/v1/requests/",
        json={"vertical": "food", "urgency": "routine", "description": "Second session", "preferred_mode": "in_person"},
        headers=auth_header(second_member),
    )
    assert res.status_code == 201, res.text
    req2_id = res.json()["id"]
    await client.patch(f"/api/v1/requests/{req2_id}/accept", headers=auth_header(chw_tokens))
    sess2_res = await client.post(
        "/api/v1/sessions/",
        json={"request_id": req2_id, "mode": "in_person", "scheduled_at": datetime.now(UTC).isoformat()},
        headers=auth_header(chw_tokens),
    )
    session2 = sess2_res.json()["id"]
    await client.patch(f"/api/v1/sessions/{session2}/start", headers=auth_header(chw_tokens))
    await client.patch(f"/api/v1/sessions/{session2}/complete", headers=auth_header(chw_tokens))

    # Submit testimonials: rating 4 and rating 2.
    r1 = await _submit_testimonial(client, member_tokens, session1, rating=4)
    t1_id = r1.json()["id"]
    r2 = await _submit_testimonial(client, second_member, session2, rating=2)
    t2_id = r2.json()["id"]

    # Approve only the first testimonial.
    await client.post(
        f"/api/v1/admin/testimonials/{t1_id}/moderate",
        json={"action": "approve"},
        headers=admin_auth_header(),
    )

    # Summary: only 1 approved → avg should be 4.0.
    res = await client.get(
        f"/api/v1/chws/{chw_id}/testimonials/summary",
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["rating_count"] == 1
    assert body["rating_avg"] == 4.0

    # Approve the second testimonial.
    await client.post(
        f"/api/v1/admin/testimonials/{t2_id}/moderate",
        json={"action": "approve"},
        headers=admin_auth_header(),
    )

    # Summary: 2 approved → avg should be 3.0.
    res2 = await client.get(
        f"/api/v1/chws/{chw_id}/testimonials/summary",
        headers=auth_header(member_tokens),
    )
    body2 = res2.json()
    assert body2["rating_count"] == 2
    assert body2["rating_avg"] == 3.0


# ─── 13. Summary NULL-safe when no testimonials ───────────────────────────────


@pytest.mark.asyncio
async def test_summary_null_safe_no_testimonials(
    client: AsyncClient,
    member_tokens: dict,
) -> None:
    """Summary for a CHW with no testimonials: rating_avg=None, rating_count=0."""
    import uuid
    fake_chw_id = str(uuid.uuid4())

    res = await client.get(
        f"/api/v1/chws/{fake_chw_id}/testimonials/summary",
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["rating_avg"] is None
    assert body["rating_count"] == 0


# ─── 14. Rating out-of-range → 422 ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_rating_zero_returns_422(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """Rating of 0 (below minimum) must return 422."""
    session_id = await _create_completed_session(client, member_tokens, chw_tokens)
    res = await client.post(
        f"/api/v1/sessions/{session_id}/testimonials",
        json={"rating": 0},
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 422, res.text


@pytest.mark.asyncio
async def test_rating_six_returns_422(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """Rating of 6 (above maximum) must return 422."""
    session_id = await _create_completed_session(client, member_tokens, chw_tokens)
    res = await client.post(
        f"/api/v1/sessions/{session_id}/testimonials",
        json={"rating": 6},
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 422, res.text


# ─── 15. Text length > 500 → 422 ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_text_over_500_chars_returns_422(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """Free-text body exceeding 500 characters must return 422."""
    session_id = await _create_completed_session(client, member_tokens, chw_tokens)
    long_text = "A" * 501
    res = await client.post(
        f"/api/v1/sessions/{session_id}/testimonials",
        json={"rating": 4, "text": long_text},
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 422, res.text


@pytest.mark.asyncio
async def test_text_exactly_500_chars_accepted(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """Exactly 500-character text must be accepted (boundary condition)."""
    session_id = await _create_completed_session(client, member_tokens, chw_tokens)
    boundary_text = "B" * 500
    res = await client.post(
        f"/api/v1/sessions/{session_id}/testimonials",
        json={"rating": 3, "text": boundary_text},
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 201, res.text
    assert res.json()["text"] == boundary_text


# ─── 16. Unknown session_id → 404 ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_unknown_session_id_returns_404(
    client: AsyncClient,
    member_tokens: dict,
) -> None:
    """Posting a testimonial for a non-existent session returns 404."""
    import uuid
    fake_id = str(uuid.uuid4())
    res = await client.post(
        f"/api/v1/sessions/{fake_id}/testimonials",
        json={"rating": 5, "text": "Ghost session"},
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 404, res.text


# ─── 17. Missing admin key → 401 ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_admin_endpoints_require_admin_key(
    client: AsyncClient,
    member_tokens: dict,
) -> None:
    """Admin queue endpoint with a user JWT (not ADMIN_KEY) must return 401."""
    res = await client.get(
        "/api/v1/admin/testimonials",
        headers=auth_header(member_tokens),  # regular member JWT, not admin key
    )
    # The require_admin_key dependency compares the bearer token against ADMIN_KEY;
    # a user JWT won't match, so it returns 401.
    assert res.status_code == 401, res.text


# ─── 18. Admin moderate unknown testimonial → 404 ────────────────────────────


@pytest.mark.asyncio
async def test_moderate_unknown_testimonial_returns_404(
    client: AsyncClient,
) -> None:
    """Moderating a non-existent testimonial UUID returns 404."""
    import uuid
    fake_id = str(uuid.uuid4())
    res = await client.post(
        f"/api/v1/admin/testimonials/{fake_id}/moderate",
        json={"action": "approve"},
        headers=admin_auth_header(),
    )
    assert res.status_code == 404, res.text

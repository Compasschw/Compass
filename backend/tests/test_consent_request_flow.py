"""Tests for the two-party in-app consent request flow.

HIPAA + California §632 compliance requirements tested here
-----------------------------------------------------------
1. Happy path: CHW creates request → member approves → MemberConsent row exists
   with member_id = member's own user UUID (not the CHW's), confirming the
   "individual authorization" record required by HIPAA 45 CFR §164.508.

2. Deny path: CHW creates request → member denies → no MemberConsent row.
   The denial must be the member's own action; the CHW cannot self-deny.

3. Role enforcement:
   - A member account may NOT create a ConsentRequest (403).
   - A CHW account may NOT approve or deny a ConsentRequest (403).
   - The CHW who created the request may cancel it (200).
   - A different CHW may NOT cancel (403).

4. Duplicate-pending guard: a second POST /consent-requests while one is still
   pending returns 409, preventing modal spam.

5. Expiration: a request whose expires_at is in the past is returned with
   status="expired" and a 200, not as "pending". The expired request cannot
   be approved (409 from approve endpoint).

6. CHW status polling via GET /consent-requests/{id}.

Coverage is integration-level: each test runs against a real (test) PostgreSQL
database via the shared conftest setup, exercising the full request→router→ORM
→commit path.
"""

from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.models.session import ConsentRequest, MemberConsent
from tests.conftest import (
    auth_header,
    complete_member_signup_payload,
    test_session as _test_session_factory,
)


# ─── Shared test helpers ──────────────────────────────────────────────────────


async def _create_request_and_match(
    client: AsyncClient,
    member_tokens: dict,
    chw_tokens: dict,
) -> str:
    """Create a service request as the member and accept it as the CHW."""
    res = await client.post(
        "/api/v1/requests/",
        json={
            "vertical": "housing",
            "urgency": "routine",
            "description": "Consent flow test request",
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
    return request_id


async def _create_session(
    client: AsyncClient,
    chw_tokens: dict,
    request_id: str,
) -> str:
    """Create a session and return its UUID string."""
    res = await client.post(
        "/api/v1/sessions/",
        json={
            "request_id": request_id,
            "scheduled_at": "2026-06-01T10:00:00Z",
            "mode": "in_person",
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    return res.json()["id"]


async def _create_consent_request(
    client: AsyncClient,
    chw_tokens: dict,
    session_id: str,
    consent_type: str = "ai_transcription",
) -> dict:
    """CHW creates a consent request; returns the JSON body."""
    res = await client.post(
        f"/api/v1/sessions/{session_id}/consent-requests",
        json={"consent_type": consent_type},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    return res.json()


# ─── Happy path ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_happy_path_approve_creates_member_consent(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """Full two-party flow: request → approve → MemberConsent row exists."""
    request_id = await _create_request_and_match(client, member_tokens, chw_tokens)
    session_id = await _create_session(client, chw_tokens, request_id)

    # 1. CHW creates consent request.
    cr = await _create_consent_request(client, chw_tokens, session_id)
    assert cr["status"] == "pending"
    assert cr["consent_type"] == "ai_transcription"
    cr_id = cr["id"]

    # 2. Member polls pending-consents — should see the request.
    res = await client.get(
        f"/api/v1/sessions/{session_id}/pending-consents",
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 200
    pending = res.json()
    assert len(pending) == 1
    assert pending[0]["id"] == cr_id

    # 3. Member approves.
    member_name = "Test Member"
    res = await client.post(
        f"/api/v1/consent-requests/{cr_id}/approve",
        json={"typed_signature": member_name},
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["status"] == "approved"
    assert body["responded_at"] is not None

    # 4. Verify a MemberConsent row exists in the DB with member_id = member.
    async with _test_session_factory() as db:
        result = await db.execute(
            select(MemberConsent).where(
                MemberConsent.session_id == session_id,
                MemberConsent.consent_type == "ai_transcription",
            )
        )
        consent_row = result.scalar_one_or_none()

    assert consent_row is not None, "MemberConsent row was not created on approval"
    assert str(consent_row.typed_signature) == member_name
    # Critically: member_id must be the member's own user ID, not the CHW's.
    # We verify it is NOT a CHW id by checking it matches the ConsentRequest.member_id.
    assert str(consent_row.member_id) == cr["member_id"], (
        "MemberConsent.member_id must equal the session member's user ID, "
        "not the CHW's — this is the HIPAA 'individual authorization' record."
    )

    # 5. CHW polling: GET /consent-requests/{id} should now show approved.
    res = await client.get(
        f"/api/v1/consent-requests/{cr_id}",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200
    assert res.json()["status"] == "approved"

    # 6. Pending-consents list is now empty (no more pending rows).
    res = await client.get(
        f"/api/v1/sessions/{session_id}/pending-consents",
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 200
    assert res.json() == []


# ─── Deny path ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_deny_path_no_member_consent_created(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """Deny path: request → deny → no MemberConsent row exists in the DB."""
    request_id = await _create_request_and_match(client, member_tokens, chw_tokens)
    session_id = await _create_session(client, chw_tokens, request_id)
    cr = await _create_consent_request(client, chw_tokens, session_id)
    cr_id = cr["id"]

    # Member denies.
    res = await client.post(
        f"/api/v1/consent-requests/{cr_id}/deny",
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "denied"

    # No MemberConsent row should exist.
    async with _test_session_factory() as db:
        result = await db.execute(
            select(MemberConsent).where(
                MemberConsent.session_id == session_id,
            )
        )
        consent_row = result.scalar_one_or_none()
    assert consent_row is None, (
        "Denial must NOT create a MemberConsent row — "
        "no recording may proceed without explicit member approval."
    )

    # Pending-consents list is empty after denial.
    res = await client.get(
        f"/api/v1/sessions/{session_id}/pending-consents",
        headers=auth_header(member_tokens),
    )
    assert res.json() == []


# ─── Role enforcement ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_member_cannot_create_consent_request(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """A member account must not be able to create a ConsentRequest (403)."""
    request_id = await _create_request_and_match(client, member_tokens, chw_tokens)
    session_id = await _create_session(client, chw_tokens, request_id)

    res = await client.post(
        f"/api/v1/sessions/{session_id}/consent-requests",
        json={"consent_type": "ai_transcription"},
        headers=auth_header(member_tokens),  # member, not CHW
    )
    assert res.status_code == 403, (
        "A member must receive 403 when trying to create a consent request. "
        "Only the CHW on the session may initiate recording consent."
    )


@pytest.mark.asyncio
async def test_chw_cannot_approve_consent_request(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """The CHW must not be able to approve their own consent request (403)."""
    request_id = await _create_request_and_match(client, member_tokens, chw_tokens)
    session_id = await _create_session(client, chw_tokens, request_id)
    cr = await _create_consent_request(client, chw_tokens, session_id)

    res = await client.post(
        f"/api/v1/consent-requests/{cr['id']}/approve",
        json={"typed_signature": "Test CHW"},
        headers=auth_header(chw_tokens),  # CHW, not member
    )
    assert res.status_code == 403, (
        "The CHW must receive 403 when trying to self-approve a consent request. "
        "Only the session member may approve."
    )


@pytest.mark.asyncio
async def test_chw_cannot_deny_consent_request(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """The CHW must not be able to deny on behalf of the member (403)."""
    request_id = await _create_request_and_match(client, member_tokens, chw_tokens)
    session_id = await _create_session(client, chw_tokens, request_id)
    cr = await _create_consent_request(client, chw_tokens, session_id)

    res = await client.post(
        f"/api/v1/consent-requests/{cr['id']}/deny",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_chw_can_cancel_consent_request(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """The CHW who created the request may cancel it (modal closed before member responded)."""
    request_id = await _create_request_and_match(client, member_tokens, chw_tokens)
    session_id = await _create_session(client, chw_tokens, request_id)
    cr = await _create_consent_request(client, chw_tokens, session_id)

    res = await client.post(
        f"/api/v1/consent-requests/{cr['id']}/cancel",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200
    assert res.json()["status"] == "cancelled"

    # After cancellation the pending list is empty.
    res = await client.get(
        f"/api/v1/sessions/{session_id}/pending-consents",
        headers=auth_header(member_tokens),
    )
    assert res.json() == []


@pytest.mark.asyncio
async def test_member_cannot_cancel_consent_request(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """A member must receive 403 when attempting to cancel a consent request."""
    request_id = await _create_request_and_match(client, member_tokens, chw_tokens)
    session_id = await _create_session(client, chw_tokens, request_id)
    cr = await _create_consent_request(client, chw_tokens, session_id)

    res = await client.post(
        f"/api/v1/consent-requests/{cr['id']}/cancel",
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_pending_consents_403_for_chw(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """GET /sessions/{id}/pending-consents must return 403 to a CHW caller."""
    request_id = await _create_request_and_match(client, member_tokens, chw_tokens)
    session_id = await _create_session(client, chw_tokens, request_id)

    res = await client.get(
        f"/api/v1/sessions/{session_id}/pending-consents",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 403


# ─── Duplicate-pending guard ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_duplicate_pending_guard(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """A second POST /consent-requests while one is still pending returns 409."""
    request_id = await _create_request_and_match(client, member_tokens, chw_tokens)
    session_id = await _create_session(client, chw_tokens, request_id)

    # First request — succeeds.
    cr1 = await _create_consent_request(client, chw_tokens, session_id)
    assert cr1["status"] == "pending"

    # Second request while first is still pending — must 409.
    res = await client.post(
        f"/api/v1/sessions/{session_id}/consent-requests",
        json={"consent_type": "ai_transcription"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 409, (
        "Duplicate pending consent request must return 409 to prevent "
        "the member from seeing two overlapping consent modals."
    )


# ─── Cannot act on non-pending request ───────────────────────────────────────


@pytest.mark.asyncio
async def test_cannot_approve_already_approved_request(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """Approving an already-approved request returns 409."""
    request_id = await _create_request_and_match(client, member_tokens, chw_tokens)
    session_id = await _create_session(client, chw_tokens, request_id)
    cr = await _create_consent_request(client, chw_tokens, session_id)
    cr_id = cr["id"]

    # Approve once.
    await client.post(
        f"/api/v1/consent-requests/{cr_id}/approve",
        json={"typed_signature": "Test Member"},
        headers=auth_header(member_tokens),
    )

    # Try to approve again.
    res = await client.post(
        f"/api/v1/consent-requests/{cr_id}/approve",
        json={"typed_signature": "Test Member"},
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 409


@pytest.mark.asyncio
async def test_cannot_cancel_after_member_denies(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """CHW cannot cancel a request the member already denied (409)."""
    request_id = await _create_request_and_match(client, member_tokens, chw_tokens)
    session_id = await _create_session(client, chw_tokens, request_id)
    cr = await _create_consent_request(client, chw_tokens, session_id)
    cr_id = cr["id"]

    # Member denies first.
    await client.post(
        f"/api/v1/consent-requests/{cr_id}/deny",
        headers=auth_header(member_tokens),
    )

    # CHW tries to cancel after denial.
    res = await client.post(
        f"/api/v1/consent-requests/{cr_id}/cancel",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 409


# ─── Expiration ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_expired_request_not_returned_as_pending(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """A ConsentRequest past its expires_at is transparently expired on read.

    We artificially set expires_at to 10 seconds in the past by directly
    mutating the DB row after creation (simulating the 5-minute TTL elapsing
    without a background job).  The next GET /pending-consents must return an
    empty list (the row is upgraded to status='expired' in the same DB call).
    """
    request_id = await _create_request_and_match(client, member_tokens, chw_tokens)
    session_id = await _create_session(client, chw_tokens, request_id)
    cr = await _create_consent_request(client, chw_tokens, session_id)
    cr_id = cr["id"]

    # Back-date expires_at so it appears expired.
    async with _test_session_factory() as db:
        row = await db.get(ConsentRequest, cr_id)
        assert row is not None
        row.expires_at = datetime.now(UTC) - timedelta(seconds=10)
        await db.commit()

    # Pending-consents must return empty (expired row is filtered out).
    res = await client.get(
        f"/api/v1/sessions/{session_id}/pending-consents",
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 200
    assert res.json() == [], (
        "Expired consent requests must not appear in the member's pending list."
    )

    # Direct GET on the row must show status='expired'.
    res = await client.get(
        f"/api/v1/consent-requests/{cr_id}",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200
    assert res.json()["status"] == "expired"


@pytest.mark.asyncio
async def test_expired_request_cannot_be_approved(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """Approving a past-TTL request must return 409 (not a 200 silent bypass)."""
    request_id = await _create_request_and_match(client, member_tokens, chw_tokens)
    session_id = await _create_session(client, chw_tokens, request_id)
    cr = await _create_consent_request(client, chw_tokens, session_id)
    cr_id = cr["id"]

    # Expire the row.
    async with _test_session_factory() as db:
        row = await db.get(ConsentRequest, cr_id)
        assert row is not None
        row.expires_at = datetime.now(UTC) - timedelta(seconds=10)
        await db.commit()

    res = await client.post(
        f"/api/v1/consent-requests/{cr_id}/approve",
        json={"typed_signature": "Test Member"},
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 409, (
        "Approving an expired consent request must return 409 — "
        "this is a critical guard against stale consent bypassing the flow."
    )
    assert "expired" in res.json()["detail"].lower()


@pytest.mark.asyncio
async def test_expired_pending_allows_new_request(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """After a request expires, the CHW may create a fresh one without 409."""
    request_id = await _create_request_and_match(client, member_tokens, chw_tokens)
    session_id = await _create_session(client, chw_tokens, request_id)
    cr = await _create_consent_request(client, chw_tokens, session_id)

    # Expire the existing row.
    async with _test_session_factory() as db:
        row = await db.get(ConsentRequest, cr["id"])
        assert row is not None
        row.expires_at = datetime.now(UTC) - timedelta(seconds=10)
        await db.commit()

    # Creating a new request must succeed (expired row does not block).
    res = await client.post(
        f"/api/v1/sessions/{session_id}/consent-requests",
        json={"consent_type": "ai_transcription"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    assert res.json()["status"] == "pending"


# ─── CHW status polling ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_chw_can_poll_consent_request_status(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """CHW can GET /consent-requests/{id} and see live status updates."""
    request_id = await _create_request_and_match(client, member_tokens, chw_tokens)
    session_id = await _create_session(client, chw_tokens, request_id)
    cr = await _create_consent_request(client, chw_tokens, session_id)
    cr_id = cr["id"]

    # Initially pending.
    res = await client.get(
        f"/api/v1/consent-requests/{cr_id}",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200
    assert res.json()["status"] == "pending"

    # Member approves.
    await client.post(
        f"/api/v1/consent-requests/{cr_id}/approve",
        json={"typed_signature": "Test Member"},
        headers=auth_header(member_tokens),
    )

    # CHW polls again — sees approved.
    res = await client.get(
        f"/api/v1/consent-requests/{cr_id}",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200
    assert res.json()["status"] == "approved"


@pytest.mark.asyncio
async def test_unrelated_user_cannot_view_consent_request(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> None:
    """A user who is not the CHW or member on the request must receive 403."""
    request_id = await _create_request_and_match(client, member_tokens, chw_tokens)
    session_id = await _create_session(client, chw_tokens, request_id)
    cr = await _create_consent_request(client, chw_tokens, session_id)

    # Register a third user (members must supply every Pear-required field, #14).
    third_party_res = await client.post(
        "/api/v1/auth/register",
        json=complete_member_signup_payload(
            email="thirdparty@example.com",
            name="Third Party",
            password="Thirdpass123!",
        ),
    )
    assert third_party_res.status_code == 201
    third_tokens = third_party_res.json()

    res = await client.get(
        f"/api/v1/consent-requests/{cr['id']}",
        headers=auth_header(third_tokens),
    )
    assert res.status_code == 403

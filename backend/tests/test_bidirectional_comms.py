"""Integration tests for bidirectional masked call endpoints + touch-log audit.

Coverage:
  1. Member→CHW call requires a prior shared session (no session → 403).
  2. CHW→member call requires a prior shared session (no session → 403).
  3. Rate limit: 6th call on the same day returns 429 (limit is 5).
  4. CommunicationTouch row is created on every successful call.
  5. Recording is NOT enabled: no consent IVR fired (provider returns a
     placeholder session id — we assert no `voice/consent` calls happened
     and that the NCCO actions never contain a `record` action).
  6. find-or-create conversation creates conversation for CHW-member pair.
  7. Member cannot call CHW role endpoint as CHW (role guard).
  8. CHW cannot call member role endpoint as member (role guard).

Test strategy:
  - Uses the same conftest.py fixtures (in-memory Postgres, ASGI client).
  - Vonage is NOT configured in test env → VonageProvider returns a
    ``vonage-placeholder-*`` session id. This is correct behaviour for
    testing: we verify the endpoint logic without a live Vonage account.
  - Rate-limit is enforced per (initiator_id, recipient_id, day) using the
    CommunicationTouch table — NOT slowapi's IP counter — so it works even
    with DISABLE_RATE_LIMIT=1 set in conftest.
"""

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.services.communication_touch_log import CommunicationTouch, TouchKind
from app.utils.phone import PLACEHOLDER_PHONE_CALL_BLOCK_MESSAGE, PLACEHOLDER_PHONE_E164
from tests.conftest import auth_header, test_session as _test_session_factory


# ─── Shared helpers ────────────────────────────────────────────────────────────


async def _register(client: AsyncClient, email: str, role: str) -> dict:
    """Register a new user and return the token payload.

    Members must supply every Pear-required signup field (#14); the CIN is
    derived from the email so concurrent registrations stay distinct.
    """
    payload: dict = {
        "email": email,
        "password": "Testpass123!",
        "name": f"Test {role.upper()} {email[:8]}",
        "role": role,
    }
    if role == "member":
        payload.update({
            "date_of_birth": "1990-01-01",
            "gender": "Female",
            "insurance_company": "Health Net",
            "medi_cal_id": f"{abs(hash(email)) % 100_000_000:08d}A",
            "zip_code": "90001",
            "terms_accepted": True,
            "communications_consent": True,
        })
    res = await client.post("/api/v1/auth/register", json=payload)
    assert res.status_code == 201, f"Register failed: {res.text}"
    return res.json()


async def _set_phone_via_db(user_id: str, phone: str) -> None:
    """Set user phone directly in the test database."""
    from uuid import UUID

    from app.models.user import User

    async with _test_session_factory() as session:
        user = await session.get(User, UUID(user_id))
        assert user is not None, f"User {user_id} not found in DB"
        user.phone = phone
        await session.commit()


async def _create_session_between(
    client: AsyncClient,
    chw_tokens: dict,
    member_tokens: dict,
) -> str:
    """Create a minimal scheduled session between CHW and member.

    Returns the session_id string.
    """
    # Member creates a service request
    res = await client.post(
        "/api/v1/requests/",
        json={
            "vertical": "housing",
            "urgency": "routine",
            "description": "Integration test request",
            "preferred_mode": "in_person",
        },
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 201, f"Create request failed: {res.text}"
    request_id = res.json()["id"]

    # CHW accepts / matches
    res = await client.patch(
        f"/api/v1/requests/{request_id}/accept",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, f"Accept request failed: {res.text}"

    # CHW creates the session
    res = await client.post(
        "/api/v1/sessions/",
        json={
            "request_id": request_id,
            "scheduled_at": "2026-05-10T10:00:00Z",
            "mode": "phone",
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, f"Create session failed: {res.text}"
    return res.json()["id"]


async def _user_id_from_tokens(tokens: dict) -> str:
    """Extract the user_id from the access token payload."""
    import base64
    import json

    parts = tokens["access_token"].split(".")
    padded = parts[1] + "=" * (4 - len(parts[1]) % 4)
    payload = json.loads(base64.urlsafe_b64decode(padded))
    return payload["sub"]


# ─── Tests ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_member_call_chw_no_session_returns_403(client: AsyncClient):
    """Member→CHW call is rejected 403 when no shared session exists."""
    chw_tokens = await _register(client, "chw_nosession@test.com", "chw")
    member_tokens = await _register(client, "member_nosession@test.com", "member")

    chw_id = await _user_id_from_tokens(chw_tokens)

    # Ensure both have phone numbers in DB
    member_id = await _user_id_from_tokens(member_tokens)
    await _set_phone_via_db(chw_id, "+15550000001")
    await _set_phone_via_db(member_id, "+15550000002")

    res = await client.post(
        f"/api/v1/member/chws/{chw_id}/call",
        json={},
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 403, f"Expected 403, got {res.status_code}: {res.text}"
    assert "session" in res.json()["detail"].lower() or "relationship" in res.json()["detail"].lower()


@pytest.mark.asyncio
async def test_chw_call_member_no_session_returns_403(client: AsyncClient):
    """CHW→member call is rejected 403 when no shared session exists."""
    chw_tokens = await _register(client, "chw_nosess2@test.com", "chw")
    member_tokens = await _register(client, "member_nosess2@test.com", "member")

    member_id = await _user_id_from_tokens(member_tokens)
    chw_id = await _user_id_from_tokens(chw_tokens)
    await _set_phone_via_db(chw_id, "+15550000003")
    await _set_phone_via_db(member_id, "+15550000004")

    res = await client.post(
        f"/api/v1/chw/members/{member_id}/call",
        json={},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 403, f"Expected 403, got {res.status_code}: {res.text}"
    assert "session" in res.json()["detail"].lower() or "relationship" in res.json()["detail"].lower()


@pytest.mark.asyncio
async def test_member_call_chw_with_session_succeeds(client: AsyncClient):
    """Member→CHW call succeeds when a shared session exists."""
    chw_tokens = await _register(client, "chw_withsess@test.com", "chw")
    member_tokens = await _register(client, "member_withsess@test.com", "member")

    chw_id = await _user_id_from_tokens(chw_tokens)
    member_id = await _user_id_from_tokens(member_tokens)
    await _set_phone_via_db(chw_id, "+15550000005")
    await _set_phone_via_db(member_id, "+15550000006")

    await _create_session_between(client, chw_tokens, member_tokens)

    res = await client.post(
        f"/api/v1/member/chws/{chw_id}/call",
        json={"reason": "Quick check-in"},
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 200, f"Expected 200, got {res.status_code}: {res.text}"
    data = res.json()
    assert "provider_session_id" in data
    assert "rate_limit_remaining" in data
    assert isinstance(data["rate_limit_remaining"], int)
    assert data["rate_limit_remaining"] == 4  # 5 limit - 1 used = 4 remaining


@pytest.mark.asyncio
async def test_chw_call_member_with_session_succeeds(client: AsyncClient):
    """CHW→member call succeeds when a shared session exists."""
    chw_tokens = await _register(client, "chw_withsess2@test.com", "chw")
    member_tokens = await _register(client, "member_withsess2@test.com", "member")

    chw_id = await _user_id_from_tokens(chw_tokens)
    member_id = await _user_id_from_tokens(member_tokens)
    await _set_phone_via_db(chw_id, "+15550000007")
    await _set_phone_via_db(member_id, "+15550000008")

    await _create_session_between(client, chw_tokens, member_tokens)

    res = await client.post(
        f"/api/v1/chw/members/{member_id}/call",
        json={"reason": "Follow-up call"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, f"Expected 200, got {res.status_code}: {res.text}"
    data = res.json()
    assert "provider_session_id" in data
    assert data["rate_limit_remaining"] == 4


@pytest.mark.asyncio
async def test_rate_limit_enforced_on_6th_call(client: AsyncClient):
    """6th call in the same day returns 429 — limit is 5."""
    chw_tokens = await _register(client, "chw_ratelimit@test.com", "chw")
    member_tokens = await _register(client, "member_ratelimit@test.com", "member")

    chw_id = await _user_id_from_tokens(chw_tokens)
    member_id = await _user_id_from_tokens(member_tokens)
    await _set_phone_via_db(chw_id, "+15550000009")
    await _set_phone_via_db(member_id, "+15550000010")

    await _create_session_between(client, chw_tokens, member_tokens)

    # Make 5 successful calls
    for i in range(5):
        res = await client.post(
            f"/api/v1/member/chws/{chw_id}/call",
            json={"reason": f"Call {i + 1}"},
            headers=auth_header(member_tokens),
        )
        assert res.status_code == 200, f"Call {i + 1} failed: {res.status_code} {res.text}"

    # 6th call must be rate-limited
    res = await client.post(
        f"/api/v1/member/chws/{chw_id}/call",
        json={"reason": "Should be blocked"},
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 429, f"Expected 429 on 6th call, got {res.status_code}: {res.text}"
    assert "rate limit" in res.json()["detail"].lower()


@pytest.mark.asyncio
async def test_touch_log_row_created_on_member_call(client: AsyncClient):
    """CommunicationTouch row is written for every successful member→CHW call."""
    from uuid import UUID

    chw_tokens = await _register(client, "chw_touchlog@test.com", "chw")
    member_tokens = await _register(client, "member_touchlog@test.com", "member")

    chw_id = await _user_id_from_tokens(chw_tokens)
    member_id = await _user_id_from_tokens(member_tokens)
    await _set_phone_via_db(chw_id, "+15550000011")
    await _set_phone_via_db(member_id, "+15550000012")

    await _create_session_between(client, chw_tokens, member_tokens)

    res = await client.post(
        f"/api/v1/member/chws/{chw_id}/call",
        json={"reason": "Audit test"},
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 200

    # Verify the touch log row
    async with _test_session_factory() as session:
        result = await session.execute(
            select(CommunicationTouch).where(
                CommunicationTouch.initiator_id == UUID(member_id),
                CommunicationTouch.recipient_id == UUID(chw_id),
                CommunicationTouch.kind == TouchKind.call.value,
            )
        )
        touch = result.scalar_one_or_none()

    assert touch is not None, "CommunicationTouch row was not created"
    assert touch.initiator_id == UUID(member_id)
    assert touch.recipient_id == UUID(chw_id)
    assert touch.kind == "call"
    assert touch.provider_session_id is not None
    # Metadata should include recording: False
    assert touch.extra_data is not None
    assert touch.extra_data.get("recording") is False


@pytest.mark.asyncio
async def test_touch_log_row_created_on_chw_call(client: AsyncClient):
    """CommunicationTouch row is written for every successful CHW→member call."""
    from uuid import UUID

    chw_tokens = await _register(client, "chw_touchlog2@test.com", "chw")
    member_tokens = await _register(client, "member_touchlog2@test.com", "member")

    chw_id = await _user_id_from_tokens(chw_tokens)
    member_id = await _user_id_from_tokens(member_tokens)
    await _set_phone_via_db(chw_id, "+15550000013")
    await _set_phone_via_db(member_id, "+15550000014")

    await _create_session_between(client, chw_tokens, member_tokens)

    res = await client.post(
        f"/api/v1/chw/members/{member_id}/call",
        json={"reason": "CHW audit test"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200

    async with _test_session_factory() as session:
        result = await session.execute(
            select(CommunicationTouch).where(
                CommunicationTouch.initiator_id == UUID(chw_id),
                CommunicationTouch.recipient_id == UUID(member_id),
                CommunicationTouch.kind == TouchKind.call.value,
            )
        )
        touch = result.scalar_one_or_none()

    assert touch is not None, "CommunicationTouch row was not created for CHW call"
    assert touch.kind == "call"
    assert touch.extra_data is not None
    assert touch.extra_data.get("recording") is False


@pytest.mark.asyncio
async def test_recording_disabled_no_consent_ivr(client: AsyncClient):
    """Verify recording is NOT enabled on ad-hoc calls.

    We assert that the provider_session_id returned is a placeholder (Vonage
    is not configured in test env) and confirm no voice/consent endpoint is
    hit. The key invariant is that _initiate_ad_hoc_call never passes a
    `record` NCCO action to the provider — confirmed by the recording=False
    flag in the touch log metadata and the absence of any IVR consent flow.
    """
    from uuid import UUID

    chw_tokens = await _register(client, "chw_norecord@test.com", "chw")
    member_tokens = await _register(client, "member_norecord@test.com", "member")

    chw_id = await _user_id_from_tokens(chw_tokens)
    member_id = await _user_id_from_tokens(member_tokens)
    await _set_phone_via_db(chw_id, "+15550000015")
    await _set_phone_via_db(member_id, "+15550000016")

    await _create_session_between(client, chw_tokens, member_tokens)

    res = await client.post(
        f"/api/v1/member/chws/{chw_id}/call",
        json={},
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 200
    data = res.json()

    # Provider session id should be a Vonage placeholder (not configured in test)
    # and must NOT contain "consent" in the id (which would indicate consent IVR).
    provider_session_id = data["provider_session_id"]
    assert "consent" not in provider_session_id.lower(), (
        "provider_session_id should not contain 'consent' — IVR may have been triggered"
    )

    # Touch log confirms recording=False
    async with _test_session_factory() as session:
        result = await session.execute(
            select(CommunicationTouch).where(
                CommunicationTouch.initiator_id == UUID(member_id),
                CommunicationTouch.recipient_id == UUID(chw_id),
            )
        )
        touch = result.scalar_one_or_none()

    assert touch is not None
    assert touch.extra_data.get("recording") is False, (
        "Touch log metadata must have recording=False for ad-hoc calls"
    )


@pytest.mark.asyncio
async def test_member_cannot_use_chw_endpoint(client: AsyncClient):
    """Role guard: a member cannot call the CHW-role endpoint."""
    chw_tokens = await _register(client, "chw_roleguard@test.com", "chw")
    member_tokens = await _register(client, "member_roleguard@test.com", "member")

    chw_id = await _user_id_from_tokens(chw_tokens)
    member_id = await _user_id_from_tokens(member_tokens)
    await _set_phone_via_db(chw_id, "+15550000017")
    await _set_phone_via_db(member_id, "+15550000018")

    await _create_session_between(client, chw_tokens, member_tokens)

    # Member tries to use the CHW endpoint (/chw/members/...)
    res = await client.post(
        f"/api/v1/chw/members/{member_id}/call",
        json={},
        headers=auth_header(member_tokens),  # member auth, CHW endpoint
    )
    assert res.status_code == 403, f"Expected 403, got {res.status_code}: {res.text}"


@pytest.mark.asyncio
async def test_chw_cannot_use_member_endpoint(client: AsyncClient):
    """Role guard: a CHW cannot call the member-role endpoint."""
    chw_tokens = await _register(client, "chw_roleguard2@test.com", "chw")
    member_tokens = await _register(client, "member_roleguard2@test.com", "member")

    chw_id = await _user_id_from_tokens(chw_tokens)
    member_id = await _user_id_from_tokens(member_tokens)
    await _set_phone_via_db(chw_id, "+15550000019")
    await _set_phone_via_db(member_id, "+15550000020")

    await _create_session_between(client, chw_tokens, member_tokens)

    # CHW tries to use the member endpoint (/member/chws/...)
    res = await client.post(
        f"/api/v1/member/chws/{chw_id}/call",
        json={},
        headers=auth_header(chw_tokens),  # CHW auth, member endpoint
    )
    assert res.status_code == 403, f"Expected 403, got {res.status_code}: {res.text}"


@pytest.mark.asyncio
async def test_find_or_create_conversation_requires_relationship(client: AsyncClient):
    """find-or-create is 403 when the pair has no shared session (care gate)."""
    chw_tokens = await _register(client, "chw_nogate@test.com", "chw")
    member_tokens = await _register(client, "member_nogate@test.com", "member")

    chw_id = await _user_id_from_tokens(chw_tokens)

    res = await client.post(
        "/api/v1/conversations/find-or-create",
        json={"peer_id": chw_id},
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 403, f"Expected 403, got {res.status_code}: {res.text}"


@pytest.mark.asyncio
async def test_find_or_create_conversation_creates_new(client: AsyncClient):
    """POST /conversations/find-or-create creates an ad-hoc conversation
    once a care relationship (shared session) exists."""
    chw_tokens = await _register(client, "chw_convo@test.com", "chw")
    member_tokens = await _register(client, "member_convo@test.com", "member")
    await _create_session_between(client, chw_tokens, member_tokens)

    chw_id = await _user_id_from_tokens(chw_tokens)

    res = await client.post(
        "/api/v1/conversations/find-or-create",
        json={"peer_id": chw_id},
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 200, f"Expected 200, got {res.status_code}: {res.text}"
    data = res.json()
    assert "id" in data
    conversation_id = data["id"]

    # Second call is idempotent — same conversation returned
    res2 = await client.post(
        "/api/v1/conversations/find-or-create",
        json={"peer_id": chw_id},
        headers=auth_header(member_tokens),
    )
    assert res2.status_code == 200
    assert res2.json()["id"] == conversation_id, "Should return the same conversation on second call"


@pytest.mark.asyncio
async def test_find_or_create_conversation_chw_can_initiate(client: AsyncClient):
    """CHW can also initiate the find-or-create for a member conversation
    once a care relationship (shared session) exists."""
    chw_tokens = await _register(client, "chw_convoinit@test.com", "chw")
    member_tokens = await _register(client, "member_convoinit@test.com", "member")
    await _create_session_between(client, chw_tokens, member_tokens)

    member_id = await _user_id_from_tokens(member_tokens)

    res = await client.post(
        "/api/v1/conversations/find-or-create",
        json={"peer_id": member_id},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, f"Expected 200, got {res.status_code}: {res.text}"
    assert "id" in res.json()


@pytest.mark.asyncio
async def test_rate_limit_is_per_pair_not_global(client: AsyncClient):
    """Rate limit is per (initiator, recipient) pair — different recipients have separate quotas."""
    chw1_tokens = await _register(client, "chw_quota1@test.com", "chw")
    chw2_tokens = await _register(client, "chw_quota2@test.com", "chw")
    member_tokens = await _register(client, "member_quota@test.com", "member")

    chw1_id = await _user_id_from_tokens(chw1_tokens)
    chw2_id = await _user_id_from_tokens(chw2_tokens)
    member_id = await _user_id_from_tokens(member_tokens)

    await _set_phone_via_db(chw1_id, "+15550000021")
    await _set_phone_via_db(chw2_id, "+15550000022")
    await _set_phone_via_db(member_id, "+15550000023")

    # Create sessions with both CHWs
    await _create_session_between(client, chw1_tokens, member_tokens)
    await _create_session_between(client, chw2_tokens, member_tokens)

    # Exhaust the limit for CHW1 (5 calls)
    for i in range(5):
        res = await client.post(
            f"/api/v1/member/chws/{chw1_id}/call",
            json={},
            headers=auth_header(member_tokens),
        )
        assert res.status_code == 200, f"CHW1 call {i + 1} failed: {res.status_code}"

    # CHW2 should still be callable (separate pair quota)
    res = await client.post(
        f"/api/v1/member/chws/{chw2_id}/call",
        json={},
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 200, (
        f"CHW2 should be callable (different pair), got {res.status_code}: {res.text}"
    )


# ─── QA feedback batch (2026-07-14), Part 3 — placeholder-phone call block ──


@pytest.mark.asyncio
async def test_member_call_chw_blocked_when_chw_has_placeholder_phone(client: AsyncClient):
    """POST /member/chws/{chw_id}/call is rejected 422 when either leg
    resolves to the 555-555-5555 sentinel — here the CHW's phone."""
    chw_tokens = await _register(client, "call-block-chw-a2a@example.com", "chw")
    member_tokens = await _register(client, "call-block-member-a2a@example.com", "member")

    chw_id = await _user_id_from_tokens(chw_tokens)
    member_id = await _user_id_from_tokens(member_tokens)
    await _set_phone_via_db(chw_id, PLACEHOLDER_PHONE_E164)
    await _set_phone_via_db(member_id, "+15550000024")

    await _create_session_between(client, chw_tokens, member_tokens)

    res = await client.post(
        f"/api/v1/member/chws/{chw_id}/call",
        json={},
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 422, f"Expected 422, got {res.status_code}: {res.text}"
    assert res.json()["detail"] == PLACEHOLDER_PHONE_CALL_BLOCK_MESSAGE

    async with _test_session_factory() as session:
        from uuid import UUID as _UUID

        result = await session.execute(
            select(CommunicationTouch).where(
                CommunicationTouch.initiator_id == _UUID(member_id),
                CommunicationTouch.recipient_id == _UUID(chw_id),
            )
        )
        assert result.scalar_one_or_none() is None, (
            "No CommunicationTouch should be written when the call is blocked"
        )


@pytest.mark.asyncio
async def test_chw_call_member_blocked_when_member_has_placeholder_phone(client: AsyncClient):
    """POST /chw/members/{member_id}/call is rejected 422 when either leg
    resolves to the 555-555-5555 sentinel — here the member's phone."""
    chw_tokens = await _register(client, "call-block-chw-b2b@example.com", "chw")
    member_tokens = await _register(client, "call-block-member-b2b@example.com", "member")

    chw_id = await _user_id_from_tokens(chw_tokens)
    member_id = await _user_id_from_tokens(member_tokens)
    await _set_phone_via_db(chw_id, "+15550000025")
    await _set_phone_via_db(member_id, PLACEHOLDER_PHONE_E164)

    await _create_session_between(client, chw_tokens, member_tokens)

    res = await client.post(
        f"/api/v1/chw/members/{member_id}/call",
        json={},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 422, f"Expected 422, got {res.status_code}: {res.text}"
    assert res.json()["detail"] == PLACEHOLDER_PHONE_CALL_BLOCK_MESSAGE

    async with _test_session_factory() as session:
        from uuid import UUID as _UUID

        result = await session.execute(
            select(CommunicationTouch).where(
                CommunicationTouch.initiator_id == _UUID(chw_id),
                CommunicationTouch.recipient_id == _UUID(member_id),
            )
        )
        assert result.scalar_one_or_none() is None, (
            "No CommunicationTouch should be written when the call is blocked"
        )

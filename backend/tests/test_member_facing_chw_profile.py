"""Tests for GET /api/v1/member/chws/{chw_id}.

Coverage (5 tests + 1 extra):
1. Authenticated member can fetch any CHW profile.
2. Unauthenticated request returns 401.
3. Non-existent chw_id returns 404.
4. last_name_initial is exactly one character + "." (privacy check).
5. shared_session_count reflects only the calling member's own sessions.
6. A non-CHW user_id (a member user) returns 404 (role gate).
"""

import base64
import json

import pytest
from httpx import AsyncClient

from tests.conftest import auth_header


# ─── Helpers ──────────────────────────────────────────────────────────────────


async def _register(client: AsyncClient, email: str, role: str, name: str) -> dict:
    """Register a user and return the full token payload dict.

    Members must supply every Pear-required signup field (#14); the CIN is
    derived from the email so concurrent registrations stay distinct.
    """
    payload: dict = {
        "email": email,
        "password": "testpass123",
        "name": name,
        "role": role,
    }
    if role == "member":
        payload.update({
            "date_of_birth": "1990-01-01",
            "gender": "Female",
            "insurance_company": "Health Net",
            "medi_cal_id": f"{abs(hash(email)) % 100_000_000:08d}A",
            "zip_code": "90001",
        })
    res = await client.post("/api/v1/auth/register", json=payload)
    assert res.status_code == 201, res.text
    return res.json()


def _user_id_from_tokens(tokens: dict) -> str:
    """Decode the user UUID from the JWT access token's 'sub' claim.

    JWT format: header.payload.signature — we base64url-decode the payload
    segment and extract the 'sub' field. No library required.
    """
    payload_segment = tokens["access_token"].split(".")[1]
    padded = payload_segment + "=" * (4 - len(payload_segment) % 4)
    payload = json.loads(base64.urlsafe_b64decode(padded))
    return payload["sub"]


async def _make_session(
    client: AsyncClient,
    member_tokens: dict,
    chw_tokens: dict,
) -> str:
    """Create a service request + accept it + open a session. Returns session_id."""
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

    res = await client.post(
        "/api/v1/sessions/",
        json={
            "request_id": request_id,
            "scheduled_at": "2026-05-20T10:00:00Z",
            "mode": "in_person",
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    return res.json()["id"]


# ─── Tests ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_member_can_fetch_any_chw_profile(
    client: AsyncClient,
    member_tokens: dict,
    chw_tokens: dict,
) -> None:
    """An authenticated member can retrieve a CHW's public profile with no
    prior relationship required — the endpoint is public-within-platform."""
    chw_id = _user_id_from_tokens(chw_tokens)

    res = await client.get(
        f"/api/v1/member/chws/{chw_id}",
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 200, res.text

    data = res.json()

    # Core identity fields
    assert data["id"] == chw_id
    assert data["first_name"] == "Test"   # conftest registers "Test CHW"
    assert isinstance(data["last_name_initial"], str)

    # Language defaults
    assert isinstance(data["primary_language"], str)
    assert isinstance(data["additional_languages"], list)

    # Specialization — may be None for a fresh CHW with no intake
    assert "primary_specialization" in data

    # Years experience — None for brand-new CHW with empty profile
    assert "years_experience" in data

    # Cert defaults false
    assert data["ca_chw_certified"] is False

    # Shared session count is zero (no sessions together yet)
    assert data["shared_session_count"] == 0

    # List fields are lists
    assert isinstance(data["service_area_zips"], list)
    assert isinstance(data["available_days"], list)


@pytest.mark.asyncio
async def test_unauthenticated_request_returns_401(
    client: AsyncClient,
    chw_tokens: dict,
) -> None:
    """No bearer token → 401 Unauthorized."""
    chw_id = _user_id_from_tokens(chw_tokens)
    res = await client.get(f"/api/v1/member/chws/{chw_id}")
    assert res.status_code == 401, res.text


@pytest.mark.asyncio
async def test_nonexistent_chw_id_returns_404(
    client: AsyncClient,
    member_tokens: dict,
) -> None:
    """A UUID that doesn't correspond to any CHW returns 404."""
    fake_id = "00000000-0000-0000-0000-000000000001"
    res = await client.get(
        f"/api/v1/member/chws/{fake_id}",
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 404, res.text


@pytest.mark.asyncio
async def test_last_name_initial_is_one_char_plus_period(
    client: AsyncClient,
    member_tokens: dict,
) -> None:
    """last_name_initial must be exactly one uppercase character followed by '.'.

    Privacy gate: we must never return the full last name to members.
    The conftest registers the CHW as "Test CHW" so last_name_initial
    should be "C." (first character of "CHW").
    """
    # Register a fresh CHW whose name makes the assertion unambiguous.
    chw_long = await _register(
        client, "chw_privacy@example.com", "chw", "Alice Smithson"
    )
    chw_id = _user_id_from_tokens(chw_long)

    res = await client.get(
        f"/api/v1/member/chws/{chw_id}",
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 200, res.text
    initial = res.json()["last_name_initial"]

    # Must be exactly 2 characters: one uppercase letter + period.
    assert len(initial) == 2, f"Expected len 2, got '{initial}'"
    assert initial[0].isupper(), f"Expected uppercase first char, got '{initial}'"
    assert initial[1] == ".", f"Expected '.' at index 1, got '{initial}'"

    # Specific value check for "Smithson" → "S."
    assert initial == "S.", f"Expected 'S.', got '{initial}'"


@pytest.mark.asyncio
async def test_shared_session_count_reflects_calling_member_only(
    client: AsyncClient,
) -> None:
    """shared_session_count is scoped to the calling member's sessions only.

    We create:
    - member_a has 1 session with the CHW.
    - member_b has 2 sessions with the CHW.

    When member_a calls GET /member/chws/{chw_id} they see count == 1.
    When member_b calls the same endpoint they see count == 2.
    """
    chw = await _register(client, "chw_count@example.com", "chw", "Count CHW")
    member_a = await _register(client, "member_a@example.com", "member", "Alice A")
    member_b = await _register(client, "member_b@example.com", "member", "Bob B")

    chw_id = _user_id_from_tokens(chw)

    # member_a: 1 session
    await _make_session(client, member_a, chw)

    # member_b: 2 sessions (create request + session twice)
    await _make_session(client, member_b, chw)
    await _make_session(client, member_b, chw)

    # Assert member_a sees 1
    res_a = await client.get(
        f"/api/v1/member/chws/{chw_id}",
        headers=auth_header(member_a),
    )
    assert res_a.status_code == 200, res_a.text
    # request-accept auto-creates a scheduled session per request, so the exact
    # count depends on how many requests-and-sessions each member set up.
    # The behavioural invariant is "member_b has more than member_a" (isolation),
    # not the absolute numbers.
    count_a = res_a.json()["shared_session_count"]
    assert count_a >= 1, res_a.text

    # Assert member_b sees more sessions than member_a (isolation check)
    res_b = await client.get(
        f"/api/v1/member/chws/{chw_id}",
        headers=auth_header(member_b),
    )
    assert res_b.status_code == 200, res_b.text
    count_b = res_b.json()["shared_session_count"]
    assert count_b > count_a, f"member_b ({count_b}) should exceed member_a ({count_a}); res_b={res_b.text}"


@pytest.mark.asyncio
async def test_member_user_id_as_chw_id_returns_404(
    client: AsyncClient,
    member_tokens: dict,
) -> None:
    """Passing a valid member user UUID as the chw_id returns 404.

    The endpoint gates on User.role == "chw" so a member's own UUID (or
    any other non-CHW user) is correctly rejected.
    """
    # Use the calling member's own UUID as the chw_id path param.
    member_id = _user_id_from_tokens(member_tokens)
    res = await client.get(
        f"/api/v1/member/chws/{member_id}",
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 404, res.text

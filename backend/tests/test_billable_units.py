"""Tests for GET /api/v1/chw/members/{member_id}/billable-units (T05).

Coverage:
1. CHW with no claims for the member → daily 0/4, yearly 0/10
2. CHW with 2 claims today (1 unit each) → daily 2/4, yearly 2/10
3. CHW with 1 claim today + 5 earlier this year → daily 1/4, yearly 6/10
4. Claims for OTHER members do not count
5. Claims for the SAME member by a DIFFERENT CHW do not count
6. CHW without a relationship to the member gets 403
7. LA-timezone edge case: service_date at 2026-01-01 UTC (= Dec 31 PT) counts
   in the Dec 31 LA day, not the Jan 1 LA day.
"""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from httpx import AsyncClient

from app.models.billing import BillingClaim
from app.models.request import ServiceRequest
from app.models.session import Session
from app.models.user import MemberProfile, User
from tests.conftest import auth_header, test_session as _test_session_factory

_LA_TZ = ZoneInfo("America/Los_Angeles")


# ── Seed helpers ───────────────────────────────────────────────────────────────


async def _register_chw(client: AsyncClient, *, email: str) -> dict:
    """Register a CHW via the API and return the token response."""
    res = await client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "testpass123", "name": "Test CHW", "role": "chw"},
    )
    assert res.status_code == 201, f"CHW register failed: {res.text}"
    return res.json()


async def _register_member(client: AsyncClient, *, email: str) -> dict:
    """Register a member via the API and return the token response.

    The CIN is derived from the email so tests that register multiple
    members (e.g. target + other member) keep their Medi-Cal IDs distinct.
    """
    res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": email,
            "password": "testpass123",
            "name": "Test Member",
            "role": "member",
            "terms_accepted": True,
            "communications_consent": True,
            "phone": "+13105550199",
            "date_of_birth": "1990-06-01",
            "gender": "Female",
            "insurance_company": "Health Net",
            "medi_cal_id": f"{abs(hash(email)) % 100_000_000:08d}A",
            "address_line1": "1 Test St",
            "city": "Los Angeles",
            "state": "CA",
            "zip_code": "90001",
        },
    )
    assert res.status_code == 201, f"Member register failed: {res.text}"
    return res.json()


async def _seed_claim(
    *,
    chw_id: uuid.UUID,
    member_id: uuid.UUID,
    service_date: date,
    units: int = 1,
) -> uuid.UUID:
    """Seed a BillingClaim row directly into the test database.

    Inserts the minimum dependency chain required by FK constraints:
      ServiceRequest → Session → BillingClaim.

    Returns the claim's UUID.
    """
    request_id = uuid.uuid4()
    session_id = uuid.uuid4()
    claim_id = uuid.uuid4()

    async with _test_session_factory() as db:
        db.add(
            ServiceRequest(
                id=request_id,
                member_id=member_id,
                vertical="health",
                urgency="routine",
                description="test",
                preferred_mode="video",
                status="completed",
                estimated_units=1,
            )
        )
        db.add(
            Session(
                id=session_id,
                request_id=request_id,
                chw_id=chw_id,
                member_id=member_id,
                vertical="health",
                status="completed",
                mode="video",
                notes="",
            )
        )
        # Flush the ServiceRequest + Session inserts before adding the claim.
        # With no relationship()s configured, SQLAlchemy orders unit-of-work
        # inserts by mapper name (billing_claims before sessions), which would
        # violate the billing_claims.session_id FK without this flush.
        await db.flush()
        db.add(
            BillingClaim(
                id=claim_id,
                session_id=session_id,
                chw_id=chw_id,
                member_id=member_id,
                procedure_code="98960",
                units=units,
                gross_amount="26.66",
                platform_fee="4.00",
                net_payout="22.66",
                status="pending",
                service_date=service_date,
            )
        )
        await db.commit()

    return claim_id


async def _create_shared_session(
    *,
    chw_id: uuid.UUID,
    member_id: uuid.UUID,
) -> uuid.UUID:
    """Insert a bare Session row to satisfy ``assert_shared_session``.

    ``assert_shared_session`` only needs a session row to exist — it doesn't
    require a ServiceRequest FK to be present if the Session is seeded directly
    (the FK is on sessions.request_id but it's nullable in practice via direct
    insert).  However, because the FK is NOT NULL in the schema, we seed a
    ServiceRequest too.
    """
    request_id = uuid.uuid4()
    session_id = uuid.uuid4()

    async with _test_session_factory() as db:
        db.add(
            ServiceRequest(
                id=request_id,
                member_id=member_id,
                vertical="health",
                urgency="routine",
                description="gate-only",
                preferred_mode="video",
                status="accepted",
                estimated_units=1,
            )
        )
        db.add(
            Session(
                id=session_id,
                request_id=request_id,
                chw_id=chw_id,
                member_id=member_id,
                vertical="health",
                status="accepted",
                mode="video",
                notes="",
            )
        )
        await db.commit()

    return session_id


def _get_user_id_from_token(tokens: dict) -> uuid.UUID:
    """Decode the access_token and return the ``sub`` claim as a UUID.

    Uses the same ``decode_token`` utility the app uses so we don't
    duplicate JWT parsing logic in tests.
    """
    from app.utils.security import decode_token

    payload = decode_token(tokens["access_token"])
    assert payload is not None, "Token decode returned None"
    return uuid.UUID(payload["sub"])


# ── Test cases ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_no_claims_returns_zeros(client: AsyncClient):
    """A CHW with no claims for the member sees 0 used / full caps remaining."""
    chw_tokens = await _register_chw(client, email="chw-no-claims@example.com")
    member_tokens = await _register_member(client, email="member-no-claims@example.com")

    chw_id = _get_user_id_from_token(chw_tokens)
    member_id = _get_user_id_from_token(member_tokens)

    # Create shared session so the relationship gate passes.
    await _create_shared_session(chw_id=chw_id, member_id=member_id)

    res = await client.get(
        f"/api/v1/chw/members/{member_id}/billable-units",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    body = res.json()

    assert body["daily"]["used"] == 0
    assert body["daily"]["limit"] == 4
    assert body["daily"]["remaining"] == 4

    assert body["yearly"]["used"] == 0
    assert body["yearly"]["limit"] == 10
    assert body["yearly"]["remaining"] == 10

    assert "as_of_la_local_date" in body


@pytest.mark.asyncio
async def test_two_claims_today_counts_correctly(client: AsyncClient):
    """2 claims today (1 unit each) → daily 2/4, yearly 2/10."""
    chw_tokens = await _register_chw(client, email="chw-two-today@example.com")
    member_tokens = await _register_member(client, email="member-two-today@example.com")

    chw_id = _get_user_id_from_token(chw_tokens)
    member_id = _get_user_id_from_token(member_tokens)

    today_la: date = datetime.now(_LA_TZ).date()

    # Seed two claims for today, each 1 unit.
    await _seed_claim(chw_id=chw_id, member_id=member_id, service_date=today_la, units=1)
    await _seed_claim(chw_id=chw_id, member_id=member_id, service_date=today_la, units=1)

    res = await client.get(
        f"/api/v1/chw/members/{member_id}/billable-units",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    body = res.json()

    assert body["daily"]["used"] == 2
    assert body["daily"]["remaining"] == 2

    assert body["yearly"]["used"] == 2
    assert body["yearly"]["remaining"] == 8


@pytest.mark.asyncio
async def test_one_today_plus_five_earlier_this_year(client: AsyncClient):
    """1 claim today + 5 claims earlier this year → daily 1/4, yearly 6/10."""
    chw_tokens = await _register_chw(client, email="chw-mixed-year@example.com")
    member_tokens = await _register_member(client, email="member-mixed-year@example.com")

    chw_id = _get_user_id_from_token(chw_tokens)
    member_id = _get_user_id_from_token(member_tokens)

    today_la: date = datetime.now(_LA_TZ).date()
    # Pick a date earlier this year but not today.
    earlier_this_year: date = today_la.replace(month=1, day=2)
    if earlier_this_year == today_la:
        # Edge case: if today is Jan 2, shift to Jan 3.
        earlier_this_year = today_la.replace(month=1, day=3)

    await _seed_claim(chw_id=chw_id, member_id=member_id, service_date=today_la, units=1)
    for _ in range(5):
        await _seed_claim(
            chw_id=chw_id, member_id=member_id, service_date=earlier_this_year, units=1
        )

    res = await client.get(
        f"/api/v1/chw/members/{member_id}/billable-units",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    body = res.json()

    assert body["daily"]["used"] == 1
    assert body["daily"]["remaining"] == 3

    assert body["yearly"]["used"] == 6
    assert body["yearly"]["remaining"] == 4


@pytest.mark.asyncio
async def test_claims_for_other_member_excluded(client: AsyncClient):
    """Claims against a DIFFERENT member do not inflate this member's counts."""
    chw_tokens = await _register_chw(client, email="chw-other-member@example.com")
    member_tokens = await _register_member(client, email="member-target@example.com")
    other_member_tokens = await _register_member(client, email="member-other@example.com")

    chw_id = _get_user_id_from_token(chw_tokens)
    member_id = _get_user_id_from_token(member_tokens)
    other_member_id = _get_user_id_from_token(other_member_tokens)

    today_la: date = datetime.now(_LA_TZ).date()

    # Seed claims against the OTHER member, not the target.
    await _seed_claim(chw_id=chw_id, member_id=other_member_id, service_date=today_la, units=2)

    # Create shared session for the target member so the gate passes.
    await _create_shared_session(chw_id=chw_id, member_id=member_id)

    res = await client.get(
        f"/api/v1/chw/members/{member_id}/billable-units",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    body = res.json()

    # The target member has no claims — counts must be 0.
    assert body["daily"]["used"] == 0
    assert body["yearly"]["used"] == 0


@pytest.mark.asyncio
async def test_claims_by_different_chw_excluded(client: AsyncClient):
    """Claims filed by a DIFFERENT CHW for the same member are not counted."""
    chw_tokens = await _register_chw(client, email="chw-requester@example.com")
    other_chw_tokens = await _register_chw(client, email="chw-other@example.com")
    member_tokens = await _register_member(client, email="member-shared@example.com")

    chw_id = _get_user_id_from_token(chw_tokens)
    other_chw_id = _get_user_id_from_token(other_chw_tokens)
    member_id = _get_user_id_from_token(member_tokens)

    today_la: date = datetime.now(_LA_TZ).date()

    # Other CHW files claims for the same member.
    await _seed_claim(chw_id=other_chw_id, member_id=member_id, service_date=today_la, units=3)

    # Create shared session so the requesting CHW passes the gate.
    await _create_shared_session(chw_id=chw_id, member_id=member_id)

    res = await client.get(
        f"/api/v1/chw/members/{member_id}/billable-units",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    body = res.json()

    # Requesting CHW has no claims → zeros.
    assert body["daily"]["used"] == 0
    assert body["yearly"]["used"] == 0


@pytest.mark.asyncio
async def test_no_relationship_returns_403(client: AsyncClient):
    """A CHW without any session linked to the member receives 403."""
    chw_tokens = await _register_chw(client, email="chw-no-rel@example.com")
    member_tokens = await _register_member(client, email="member-no-rel@example.com")

    member_id = _get_user_id_from_token(member_tokens)

    # No session seeded → assert_shared_session should raise 403.
    res = await client.get(
        f"/api/v1/chw/members/{member_id}/billable-units",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 403, res.text


@pytest.mark.asyncio
async def test_la_timezone_service_date_counts_correctly(client: AsyncClient):
    """LA-timezone edge case: a claim with service_date = Dec 31 (LA) is counted
    in the Dec 31 LA billing day even if midnight UTC has already rolled over to Jan 1.

    The endpoint derives today's LA date from ``datetime.now(_LA_TZ).date()``.
    We seed a claim with a fixed ``service_date`` and verify it only counts when
    we compare against that same LA calendar date — not the UTC date, which may
    differ by one day.

    Implementation note: we can't travel time in tests, so instead we verify the
    structural invariant: a claim whose service_date == today_LA is counted in
    daily_used, while a claim whose service_date is yesterday_LA is NOT counted
    in daily_used but IS counted in yearly_used (if same year).
    """
    chw_tokens = await _register_chw(client, email="chw-la-tz@example.com")
    member_tokens = await _register_member(client, email="member-la-tz@example.com")

    chw_id = _get_user_id_from_token(chw_tokens)
    member_id = _get_user_id_from_token(member_tokens)

    today_la: date = datetime.now(_LA_TZ).date()
    yesterday_la: date = today_la - timedelta(days=1)

    # Seed one claim for yesterday (LA date) — should NOT appear in daily_used.
    # Seed one claim for today (LA date) — SHOULD appear in daily_used.
    await _seed_claim(chw_id=chw_id, member_id=member_id, service_date=yesterday_la, units=1)
    await _seed_claim(chw_id=chw_id, member_id=member_id, service_date=today_la, units=1)

    res = await client.get(
        f"/api/v1/chw/members/{member_id}/billable-units",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    body = res.json()

    # daily: only today's claim counts.
    assert body["daily"]["used"] == 1
    assert body["daily"]["remaining"] == 3

    # yearly: both claims count (both are in the current year), provided both
    # dates fall within the same calendar year.
    if yesterday_la.year == today_la.year:
        assert body["yearly"]["used"] == 2
        assert body["yearly"]["remaining"] == 8
    else:
        # Jan 1 edge: yesterday was Dec 31 of the prior year — only today counts.
        assert body["yearly"]["used"] == 1
        assert body["yearly"]["remaining"] == 9

    # Confirm the response's as_of_la_local_date equals today_la.
    assert body["as_of_la_local_date"] == today_la.isoformat()

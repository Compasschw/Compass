"""Tests for the CHW Earnings page endpoints.

Coverage (empty-case happy path — exercises the queries, period selector, and
response schema so a malformed query/serialization can't ship a 500):
  - GET /chw/earnings?period=this_month|last_month → 200 with the new fields.
  - GET /chw/earnings/sessions → 200, list.
  - GET /chw/payouts → 200, list.
A member (wrong role) is rejected.
"""

from __future__ import annotations

import pytest
from httpx import AsyncClient

from tests.conftest import auth_header


@pytest.mark.asyncio
@pytest.mark.parametrize("period", ["this_month", "last_month"])
async def test_earnings_summary_shape(
    client: AsyncClient, chw_tokens: dict, period: str, setup_db
):
    res = await client.get(
        f"/api/v1/chw/earnings?period={period}", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200, res.text
    body = res.json()
    # New earnings-page fields present and well-typed.
    assert "earnings_this_period" in body
    assert "paid_this_period" in body
    assert "pending_payout" in body
    assert isinstance(body["pending_in_transit"], bool)
    # No claims for a fresh CHW → nothing pending → no next payout date.
    assert body["pending_payout"] == 0
    assert body["pending_in_transit"] is False
    assert body["next_payout_date"] is None


@pytest.mark.asyncio
async def test_earning_sessions_and_payouts_lists(
    client: AsyncClient, chw_tokens: dict, setup_db
):
    res = await client.get(
        "/api/v1/chw/earnings/sessions", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200, res.text
    assert isinstance(res.json(), list)

    res = await client.get("/api/v1/chw/payouts", headers=auth_header(chw_tokens))
    assert res.status_code == 200, res.text
    assert isinstance(res.json(), list)


@pytest.mark.asyncio
async def test_earning_session_row_includes_start_and_end_times(
    client: AsyncClient, chw_tokens: dict, setup_db
):
    """A completed session's earnings row surfaces the ACTUAL session
    start/end timestamps (Session.started_at / ended_at) so the Earnings
    "Session Detail" modal can show Session Start + Session End with time."""
    import uuid
    from datetime import UTC, datetime

    from sqlalchemy import select

    from app.models.billing import BillingClaim
    from app.models.request import ServiceRequest
    from app.models.session import Session
    from app.models.user import MemberProfile, User
    from tests.conftest import test_session as _tsf

    started = datetime(2026, 7, 11, 15, 0, tzinfo=UTC)
    ended = datetime(2026, 7, 11, 15, 45, tzinfo=UTC)
    now = datetime.now(UTC)

    session_id = uuid.uuid4()
    async with _tsf() as db:
        chw = (
            await db.execute(select(User).where(User.email == "testchw@example.com"))
        ).scalar_one()
        member_id = uuid.uuid4()
        request_id = uuid.uuid4()
        db.add(User(id=member_id, email=f"m-{member_id}@gmail.com",
                    password_hash="x", role="member", name="Ada Member"))
        await db.flush()
        db.add(MemberProfile(id=uuid.uuid4(), user_id=member_id, zip_code="90001"))
        db.add(ServiceRequest(
            id=request_id, member_id=member_id, vertical="health",
            urgency="routine", description="r", preferred_mode="phone",
            status="completed", estimated_units=1,
        ))
        db.add(Session(
            id=session_id, request_id=request_id, chw_id=chw.id,
            member_id=member_id, vertical="health", status="completed",
            mode="phone", notes="", started_at=started, ended_at=ended,
        ))
        await db.flush()
        db.add(BillingClaim(
            id=uuid.uuid4(), session_id=session_id, chw_id=chw.id,
            member_id=member_id, diagnosis_codes=["Z71.89"],
            procedure_code="98960", units=1,
            gross_amount="19.99", platform_fee="4.00", net_payout="15.99",
            status="pending", service_date=now.date(),
        ))
        await db.commit()

    res = await client.get(
        "/api/v1/chw/earnings/sessions", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200, res.text
    row = next(r for r in res.json() if r["session_id"] == str(session_id))
    assert row["started_at"] is not None and row["ended_at"] is not None
    assert row["started_at"].startswith("2026-07-11T15:00")
    assert row["ended_at"].startswith("2026-07-11T15:45")


@pytest.mark.asyncio
async def test_earnings_requires_chw_role(
    client: AsyncClient, member_tokens: dict, setup_db
):
    res = await client.get("/api/v1/chw/earnings", headers=auth_header(member_tokens))
    assert res.status_code == 403, res.text


@pytest.mark.asyncio
async def test_total_earned_all_time_sums_every_claim_regardless_of_period(
    client: AsyncClient, chw_tokens: dict, setup_db
):
    """QA-batch #14: total_earned_all_time is SUM(BillingClaim.gross_amount)
    across EVERY claim for the CHW — not paginated, not scoped to the
    ?period= selector (unlike this_month/earnings_this_period). Regression
    for the Dashboard "Earnings" tile, which previously computed a
    client-side weekly sum that silently fell back to `this_month` whenever
    the current ISO week had zero claims."""
    import uuid
    from datetime import UTC, datetime, timedelta

    from sqlalchemy import select

    from app.models.billing import BillingClaim
    from app.models.request import ServiceRequest
    from app.models.session import Session
    from app.models.user import MemberProfile, User
    from tests.conftest import test_session as _tsf

    # One claim created "now" (this month) and one created 3 months ago —
    # both must contribute to total_earned_all_time regardless of period.
    now = datetime.now(UTC)
    three_months_ago = now.replace(day=1) - timedelta(days=90)

    async with _tsf() as db:
        chw = (
            await db.execute(select(User).where(User.email == "testchw@example.com"))
        ).scalar_one()

        for i, (created_at, gross) in enumerate(
            [(now, "50.00"), (three_months_ago, "30.00")]
        ):
            member_id = uuid.uuid4()
            request_id = uuid.uuid4()
            session_id = uuid.uuid4()
            db.add(User(id=member_id, email=f"m-alltime-{i}@gmail.com",
                        password_hash="x", role="member", name=f"Member {i}"))
            await db.flush()
            db.add(MemberProfile(id=uuid.uuid4(), user_id=member_id, zip_code="90001"))
            db.add(ServiceRequest(
                id=request_id, member_id=member_id, vertical="health",
                urgency="routine", description="r", preferred_mode="phone",
                status="completed", estimated_units=1,
            ))
            db.add(Session(
                id=session_id, request_id=request_id, chw_id=chw.id,
                member_id=member_id, vertical="health", status="completed",
                mode="phone", notes="",
            ))
            await db.flush()
            claim = BillingClaim(
                id=uuid.uuid4(), session_id=session_id, chw_id=chw.id,
                member_id=member_id, diagnosis_codes=["Z71.89"],
                procedure_code="98960", units=1,
                gross_amount=gross, platform_fee="4.00", net_payout="15.99",
                status="pending", service_date=created_at.date(),
            )
            db.add(claim)
            await db.flush()
            claim.created_at = created_at
        await db.commit()

    res = await client.get("/api/v1/chw/earnings", headers=auth_header(chw_tokens))
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["total_earned_all_time"] == pytest.approx(80.00)

    # Same total regardless of ?period= — this field is deliberately not
    # period-scoped (all-time by definition).
    res_last_month = await client.get(
        "/api/v1/chw/earnings?period=last_month", headers=auth_header(chw_tokens)
    )
    assert res_last_month.status_code == 200, res_last_month.text
    assert res_last_month.json()["total_earned_all_time"] == pytest.approx(80.00)

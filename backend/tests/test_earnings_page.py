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
async def test_earnings_requires_chw_role(
    client: AsyncClient, member_tokens: dict, setup_db
):
    res = await client.get("/api/v1/chw/earnings", headers=auth_header(member_tokens))
    assert res.status_code == 403, res.text

"""Integration tests for the Rewards feature.

Test coverage:
  Catalog:
    - GET /rewards/catalog returns only active items
    - GET /rewards/catalog returns 401/403 when unauthenticated

  Balance:
    - GET /members/{id}/rewards/balance returns correct fields
    - Member cannot read another member's balance (403)

  Redemption — failure paths:
    - POST fails with 402 when member has insufficient points
    - POST fails with 409 when inventory is exhausted
    - POST fails with 403 when member tries to redeem on another member's behalf

  Redemption — success path:
    - POST succeeds, decrements inventory, creates ledger record
      (or 503 if Journeys WellnessPointsLedger not yet integrated)

  Fulfillment:
    - PATCH requires CHW or admin role; member gets 403
    - PATCH fulfills a pending redemption (CHW role)

All tests use the shared conftest fixtures (setup_db + client + auth helpers).
No external services are called; all DB interactions use the test Postgres
instance configured in conftest.py.
"""

from __future__ import annotations

import base64
import json
import pytest
from httpx import AsyncClient
from sqlalchemy import select
from uuid import UUID

from app.models.rewards import RewardCatalogItem, RewardRedemption
from app.models.user import MemberProfile
from tests.conftest import auth_header, test_session as _db_factory


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _user_id_from_tokens(tokens: dict) -> UUID:
    """Decode the JWT access token and extract the 'sub' claim as a UUID.

    Uses base64url decoding only — no signature verification needed in tests
    since the token is issued by the local test instance.
    """
    token = tokens["access_token"]
    payload_b64 = token.split(".")[1]
    padded = payload_b64 + "=" * (4 - len(payload_b64) % 4)
    payload = json.loads(base64.urlsafe_b64decode(padded).decode())
    return UUID(payload["sub"])


async def _register(client: AsyncClient, email: str, role: str) -> dict:
    """Register a user and return the auth response (includes access_token).

    Members must supply every Pear-required signup field (#14); the CIN is
    derived from the email so multiple members in one test stay distinct.
    """
    payload: dict = {
        "email": email,
        "password": "testpass123",
        "name": f"Test {role} {email[:8]}",
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


async def _seed_catalog_item(
    *,
    sku: str = "test_item",
    cost_points: int = 100,
    is_active: bool = True,
    inventory_remaining: int | None = None,
) -> RewardCatalogItem:
    """Insert a catalog item directly via ORM for test setup."""
    async with _db_factory() as db:
        item = RewardCatalogItem(
            sku=sku,
            name=f"Test Item {sku}",
            description="A test reward item.",
            image_emoji="🎁",
            cost_points=cost_points,
            fulfillment_type="digital_gift_card",
            inventory_remaining=inventory_remaining,
            is_active=is_active,
        )
        db.add(item)
        await db.commit()
        await db.refresh(item)
        return item


async def _set_member_balance(member_user_id: UUID, balance: int) -> None:
    """Directly set a member's rewards_balance for test setup."""
    async with _db_factory() as db:
        result = await db.execute(
            select(MemberProfile).where(MemberProfile.user_id == member_user_id)
        )
        profile = result.scalar_one_or_none()
        assert profile is not None, "MemberProfile not found — was the user registered?"
        profile.rewards_balance = balance
        await db.commit()


# ─── Catalog tests ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_catalog_returns_active_items_only(client: AsyncClient, setup_db):
    """GET /rewards/catalog excludes inactive items."""
    member = await _register(client, "catalog_member@example.com", "member")

    await _seed_catalog_item(sku="active_test", cost_points=100, is_active=True)
    await _seed_catalog_item(sku="inactive_test", cost_points=50, is_active=False)

    res = await client.get("/api/v1/rewards/catalog", headers=auth_header(member))
    assert res.status_code == 200, res.text
    skus = [item["sku"] for item in res.json()]
    assert "active_test" in skus
    assert "inactive_test" not in skus


@pytest.mark.asyncio
async def test_catalog_requires_authentication(client: AsyncClient, setup_db):
    """GET /rewards/catalog returns 401 or 403 without a token."""
    res = await client.get("/api/v1/rewards/catalog")
    assert res.status_code in (401, 403)


# ─── Balance tests ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_balance_returns_correct_fields(client: AsyncClient, setup_db):
    """GET /members/{id}/rewards/balance includes all expected fields."""
    member = await _register(client, "balance_member@example.com", "member")
    member_id = _user_id_from_tokens(member)

    await _set_member_balance(member_id, 250)

    res = await client.get(
        f"/api/v1/members/{member_id}/rewards/balance",
        headers=auth_header(member),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["member_id"] == str(member_id)
    assert body["current_balance"] == 250
    assert "earned_lifetime" in body
    assert "redeemed_lifetime" in body
    assert "next_unlock_item" in body
    assert "points_to_next" in body


@pytest.mark.asyncio
async def test_member_cannot_read_other_member_balance(client: AsyncClient, setup_db):
    """Member A cannot read Member B's balance — 403 expected."""
    member_a = await _register(client, "balance_a@example.com", "member")
    member_b = await _register(client, "balance_b@example.com", "member")
    member_b_id = _user_id_from_tokens(member_b)

    res = await client.get(
        f"/api/v1/members/{member_b_id}/rewards/balance",
        headers=auth_header(member_a),
    )
    assert res.status_code == 403, res.text


# ─── Redemption failure paths ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_redemption_fails_insufficient_points(client: AsyncClient, setup_db):
    """POST /redemptions returns 402 when balance < item cost."""
    member = await _register(client, "insuf_member@example.com", "member")
    member_id = _user_id_from_tokens(member)

    await _set_member_balance(member_id, 50)  # not enough for 500-point item
    item = await _seed_catalog_item(sku="pricey_item", cost_points=500)

    res = await client.post(
        f"/api/v1/members/{member_id}/rewards/redemptions",
        headers=auth_header(member),
        json={"catalog_item_id": str(item.id)},
    )
    assert res.status_code == 402, res.text


@pytest.mark.asyncio
async def test_redemption_fails_inventory_exhausted(client: AsyncClient, setup_db):
    """POST /redemptions returns 409 when inventory_remaining == 0."""
    member = await _register(client, "inv_member@example.com", "member")
    member_id = _user_id_from_tokens(member)

    await _set_member_balance(member_id, 1000)
    item = await _seed_catalog_item(sku="sold_out_item", cost_points=100, inventory_remaining=0)

    res = await client.post(
        f"/api/v1/members/{member_id}/rewards/redemptions",
        headers=auth_header(member),
        json={"catalog_item_id": str(item.id)},
    )
    assert res.status_code == 409, res.text


@pytest.mark.asyncio
async def test_redemption_fails_cross_member(client: AsyncClient, setup_db):
    """Member A cannot POST a redemption on behalf of Member B — 403 expected."""
    member_a = await _register(client, "cross_a@example.com", "member")
    member_b = await _register(client, "cross_b@example.com", "member")
    member_b_id = _user_id_from_tokens(member_b)

    await _set_member_balance(member_b_id, 1000)
    item = await _seed_catalog_item(sku="cross_item", cost_points=100)

    res = await client.post(
        f"/api/v1/members/{member_b_id}/rewards/redemptions",
        headers=auth_header(member_a),  # member_a acting as member_b
        json={"catalog_item_id": str(item.id)},
    )
    assert res.status_code == 403, res.text


# ─── Redemption success path ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_redemption_success_decrements_inventory(client: AsyncClient, setup_db):
    """POST /redemptions succeeds and decrements inventory.

    NOTE: If WellnessPointsLedger (Journeys agent model) is not yet available,
    the endpoint commits the redemption but returns 503. Both 201 and 503 are
    accepted here. The assertions below confirm the DB rows were written
    correctly regardless of the ledger integration status.

    # TODO(journeys-integration): once Journeys lands, assert 201 only and
    # verify the ledger row exists. Link: compass#TBD
    """
    member = await _register(client, "success_member@example.com", "member")
    member_id = _user_id_from_tokens(member)
    initial_inventory = 5

    await _set_member_balance(member_id, 1000)
    item = await _seed_catalog_item(
        sku="success_item",
        cost_points=200,
        inventory_remaining=initial_inventory,
    )

    res = await client.post(
        f"/api/v1/members/{member_id}/rewards/redemptions",
        headers=auth_header(member),
        json={"catalog_item_id": str(item.id)},
    )
    # Accept 201 (Journeys integrated) or 503 (Journeys not yet deployed).
    assert res.status_code in (201, 503), res.text

    # Verify the redemption row was committed and inventory was decremented.
    async with _db_factory() as db:
        result = await db.execute(
            select(RewardRedemption).where(RewardRedemption.member_id == member_id)
        )
        redemptions = result.scalars().all()
        assert len(redemptions) == 1, "Expected exactly one redemption row"
        assert redemptions[0].status == "pending"
        assert redemptions[0].cost_points_at_redemption == 200

        # Verify inventory was decremented.
        item_result = await db.execute(
            select(RewardCatalogItem).where(RewardCatalogItem.sku == "success_item")
        )
        updated_item = item_result.scalar_one()
        assert updated_item.inventory_remaining == initial_inventory - 1

        # Verify balance was deducted.
        profile_result = await db.execute(
            select(MemberProfile).where(MemberProfile.user_id == member_id)
        )
        profile = profile_result.scalar_one()
        assert profile.rewards_balance == 800  # 1000 - 200


# ─── Fulfillment role gate ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_fulfill_requires_chw_or_admin(client: AsyncClient, setup_db):
    """PATCH /rewards/redemptions/{id} is forbidden for members; allowed for CHW."""
    member = await _register(client, "fulfill_member@example.com", "member")
    member_id = _user_id_from_tokens(member)
    chw = await _register(client, "fulfill_chw@example.com", "chw")

    await _set_member_balance(member_id, 1000)
    item = await _seed_catalog_item(sku="fulfill_item", cost_points=100)

    # Seed a pending redemption directly via ORM.
    async with _db_factory() as db:
        redemption = RewardRedemption(
            member_id=member_id,
            catalog_item_id=item.id,
            cost_points_at_redemption=100,
            status="pending",
        )
        db.add(redemption)
        await db.commit()
        await db.refresh(redemption)
        redemption_id = str(redemption.id)

    # Member should get 403.
    res = await client.patch(
        f"/api/v1/rewards/redemptions/{redemption_id}",
        headers=auth_header(member),
        json={"fulfillment_reference": "GIFT123", "status": "fulfilled"},
    )
    assert res.status_code == 403, res.text

    # CHW should succeed.
    res = await client.patch(
        f"/api/v1/rewards/redemptions/{redemption_id}",
        headers=auth_header(chw),
        json={"fulfillment_reference": "GIFT123", "status": "fulfilled"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["status"] == "fulfilled"
    assert body["fulfillment_reference"] == "GIFT123"

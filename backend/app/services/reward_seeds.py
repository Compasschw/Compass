"""Idempotent seed function for the Rewards catalog.

Call ``seed_reward_catalog(db)`` from a startup hook or a one-off script.
It is safe to run multiple times — items are upserted by SKU so re-running
will not create duplicates.

Usage::

    from app.services.reward_seeds import seed_reward_catalog
    from app.database import async_session

    async with async_session() as db:
        await seed_reward_catalog(db)
        await db.commit()
"""

import logging
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.rewards import RewardCatalogItem

logger = logging.getLogger("compass.rewards")

# Canonical catalog seed items. Add or modify here; the function is idempotent.
_SEED_CATALOG: list[dict] = [
    {
        "sku": "grocery_25",
        "name": "$25 Grocery Gift Card",
        "description": (
            "Redeemable at any major grocery chain. "
            "Delivered digitally to your registered email within 1 business day."
        ),
        "image_emoji": "🛒",
        "cost_points": 500,
        "fulfillment_type": "digital_gift_card",
        "inventory_remaining": None,  # unlimited
        "is_active": True,
    },
    {
        "sku": "transit_pass_30d",
        "name": "Free 30-Day MTS Transit Pass",
        "description": (
            "A full month of unlimited rides on the Metropolitan Transit System. "
            "Physical pass mailed to your address on file within 3-5 business days."
        ),
        "image_emoji": "🚌",
        "cost_points": 300,
        "fulfillment_type": "physical_mail",
        "inventory_remaining": None,
        "is_active": True,
    },
    {
        "sku": "book_bundle",
        "name": "Children's Book Bundle (5 Books)",
        "description": (
            "A curated set of 5 age-appropriate children's books "
            "shipped directly to your home within 5-7 business days."
        ),
        "image_emoji": "📚",
        "cost_points": 200,
        "fulfillment_type": "physical_mail",
        "inventory_remaining": None,
        "is_active": True,
    },
    {
        "sku": "pharmacy_15",
        "name": "$15 Pharmacy Gift Card",
        "description": (
            "Redeemable at participating pharmacy locations for OTC medications, "
            "vitamins, and health supplies. Delivered digitally within 1 business day."
        ),
        "image_emoji": "💊",
        "cost_points": 350,
        "fulfillment_type": "digital_gift_card",
        "inventory_remaining": None,
        "is_active": True,
    },
]


async def seed_reward_catalog(db: AsyncSession) -> int:
    """Upsert the canonical catalog seed items.

    Existing items (matched by SKU) are left unchanged — this avoids
    overwriting admin edits made post-deploy. New items are inserted.

    Args:
        db: An active async SQLAlchemy session. The caller is responsible
            for committing after this function returns.

    Returns:
        The number of new items inserted (0 on a repeat run with no new SKUs).
    """
    inserted = 0
    for seed in _SEED_CATALOG:
        result = await db.execute(
            select(RewardCatalogItem).where(RewardCatalogItem.sku == seed["sku"])
        )
        existing = result.scalar_one_or_none()
        if existing is not None:
            logger.debug("reward_seeds: SKU %s already exists, skipping", seed["sku"])
            continue

        item = RewardCatalogItem(**seed)
        db.add(item)
        inserted += 1
        logger.info("reward_seeds: inserted catalog item sku=%s", seed["sku"])

    return inserted

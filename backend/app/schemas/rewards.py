"""Pydantic schemas for the Rewards feature.

Covers catalog browsing, balance inquiry, and redemption request / response
shapes used by the rewards router.
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class RewardCatalogItemResponse(BaseModel):
    """Public representation of a catalog item."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    sku: str
    name: str
    description: str
    image_emoji: str
    cost_points: int
    fulfillment_type: str
    # None = unlimited stock
    inventory_remaining: int | None
    is_active: bool
    created_at: datetime


class RewardRedemptionRequest(BaseModel):
    """Body payload for POST /members/{member_id}/rewards/redemptions."""

    catalog_item_id: UUID


class RewardRedemptionResponse(BaseModel):
    """Serialised redemption record returned after create or fetch."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    member_id: UUID
    catalog_item_id: UUID
    cost_points_at_redemption: int
    status: str
    fulfillment_reference: str | None
    requested_at: datetime
    fulfilled_at: datetime | None
    failure_reason: str | None
    created_at: datetime


class RewardRedemptionFulfillRequest(BaseModel):
    """Body for PATCH /rewards/redemptions/{id} — CHW/admin fulfill action."""

    fulfillment_reference: str = Field(
        ...,
        min_length=1,
        max_length=500,
        description="Gift card code, tracking number, or other fulfillment reference.",
    )
    status: str = Field(
        default="fulfilled",
        description="New status. Allowed values: 'fulfilled', 'cancelled', 'failed'.",
    )
    failure_reason: str | None = Field(
        default=None,
        max_length=1000,
        description="Required when status='failed'. Describes the failure cause.",
    )


class WellnessPointsBalanceResponse(BaseModel):
    """Computed balance summary for a member.

    ``next_unlock_item`` is the cheapest active catalog item the member
    cannot yet afford. ``points_to_next`` is how many more points they
    need to unlock it. Both are None when the member can afford everything
    or the catalog is empty.
    """

    member_id: UUID
    current_balance: int
    earned_lifetime: int
    redeemed_lifetime: int
    next_unlock_item: RewardCatalogItemResponse | None
    points_to_next: int

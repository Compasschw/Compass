"""Rewards catalog and redemption models.

RewardCatalogItem  — admin-managed catalog of redeemable wellness rewards.
RewardRedemption   — member redemption history; append-only audit trail.

The ``reward_redemptions`` table is protected at the DB level: the
application role is granted INSERT + SELECT only (REVOKE UPDATE, DELETE in
the migration). Updates to status / fulfillment_reference go through
admin-only PATCH /rewards/redemptions/{id} which executes under the
superuser during the migration phase (not the app role). Downstream
enforcement is belt-and-suspenders — the router still gates on role.
"""

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class RewardCatalogItem(Base):
    """Admin-managed catalog of wellness rewards available for redemption.

    ``inventory_remaining`` being NULL signals unlimited stock. When it is
    an integer >= 0, the redemption endpoint decrements it atomically inside
    the same transaction as the RewardRedemption insert.

    ``image_emoji`` is a short-term convenience for the mockup pattern
    (🛒 🚌 📚) — the column will be repurposed as an S3 key when the admin
    upload flow ships.
    """

    __tablename__ = "reward_catalog_items"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    sku: Mapped[str] = mapped_column(String(100), unique=True, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    # Short-term: emoji string ('🛒', '🚌', '📚'). Long-term: S3 object key.
    image_emoji: Mapped[str] = mapped_column(String(20), nullable=False, default="🎁")
    cost_points: Mapped[int] = mapped_column(Integer, nullable=False)
    # 'digital_gift_card' | 'physical_mail' | 'voucher_code'
    fulfillment_type: Mapped[str] = mapped_column(String(50), nullable=False)
    # NULL = unlimited stock
    inventory_remaining: Mapped[int | None] = mapped_column(Integer, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class RewardRedemption(Base):
    """Member redemption record — append-only audit trail.

    ``cost_points_at_redemption`` is a snapshot of the catalog item's cost
    at the time of the request. The catalog cost may change later; the
    ledger deduction must reflect what the member actually paid.

    ``status`` lifecycle: pending → fulfilled | failed | cancelled.

    DB-level protection: the migration REVOKEs UPDATE and DELETE from the
    application role so no code path (including bugs) can silently modify
    or erase redemption history.
    """

    __tablename__ = "reward_redemptions"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    member_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    catalog_item_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("reward_catalog_items.id", ondelete="RESTRICT"),
        nullable=False,
    )
    # Snapshot of cost at time of redemption — catalog price may change later.
    cost_points_at_redemption: Mapped[int] = mapped_column(Integer, nullable=False)
    # 'pending' | 'fulfilled' | 'cancelled' | 'failed'
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="pending", index=True
    )
    fulfillment_reference: Mapped[str | None] = mapped_column(String(500), nullable=True)
    requested_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    fulfilled_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    failure_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        # Hot path: member redemption history, newest first.
        Index(
            "ix_reward_redemptions_member_created",
            "member_id",
            "created_at",
        ),
    )

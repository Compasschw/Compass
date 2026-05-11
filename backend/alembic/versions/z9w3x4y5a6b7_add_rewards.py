"""add_rewards — RewardCatalogItem + RewardRedemption tables

Revision ID: z9w3x4y5a6b7
Revises:     y8v2w3x4z5a6
Create Date: 2026-05-09

Schema notes
------------
RewardCatalogItem
  - ``sku`` UNIQUE — human-readable slug used for idempotent seed inserts
    and deduplication in external integrations.
  - ``inventory_remaining`` is NULLABLE — NULL means unlimited stock.
  - ``image_emoji`` VARCHAR(20) — short-term mockup pattern; intended to
    be repurposed as an S3 key when the admin upload flow ships.
  - ``fulfillment_type`` plain VARCHAR with CHECK constraint over the
    three known values; avoids a Postgres ENUM so new types can be added
    without ALTER TYPE migrations.

RewardRedemption
  - ``cost_points_at_redemption`` — snapshot of catalog cost at request
    time. The catalog price may change; the ledger deduction is always
    the amount the member was shown.
  - ``status`` CHECK ('pending' | 'fulfilled' | 'cancelled' | 'failed').
  - Composite index on (member_id, created_at) — hot path for member
    redemption history queries (newest first).

Audit-trail integrity
---------------------
REVOKE UPDATE, DELETE ON reward_redemptions FROM compass_app;
The application role (compass_app) can INSERT and SELECT only.
PATCH /rewards/redemptions/{id} executes as the superuser during
the current pre-multi-role phase. This is belt-and-suspenders —
the router also enforces role gates, but a DB-level lock ensures
no bug can silently erase or alter the redemption history.

NOTE: If the application DB role is not named 'compass_app', the REVOKE
statements are harmless (Postgres raises an error if the role doesn't
exist only when the statements are not wrapped in a DO $$ block; here we
guard with a conditional check in the upgrade function body).
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "z9w3x4y5a6b7"
down_revision: str = "y8v2w3x4z5a6"
branch_labels = None
depends_on = None

_FULFILLMENT_TYPES = ("digital_gift_card", "physical_mail", "voucher_code")
_REDEMPTION_STATUSES = ("pending", "fulfilled", "cancelled", "failed")

# The Postgres role that the FastAPI application uses at runtime.
# Adjust if the project uses a different role name.
_APP_ROLE = "compass_app"


def upgrade() -> None:
    # ── reward_catalog_items ─────────────────────────────────────────────────
    op.create_table(
        "reward_catalog_items",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            nullable=False,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("sku", sa.String(length=100), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text, nullable=False),
        sa.Column(
            "image_emoji",
            sa.String(length=20),
            nullable=False,
            server_default="🎁",
        ),
        sa.Column("cost_points", sa.Integer, nullable=False),
        sa.Column("fulfillment_type", sa.String(length=50), nullable=False),
        # NULL = unlimited stock
        sa.Column("inventory_remaining", sa.Integer, nullable=True),
        sa.Column(
            "is_active",
            sa.Boolean,
            nullable=False,
            server_default=sa.text("true"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.UniqueConstraint("sku", name="uq_reward_catalog_items_sku"),
        sa.CheckConstraint(
            f"fulfillment_type IN ({', '.join(repr(t) for t in _FULFILLMENT_TYPES)})",
            name="ck_reward_catalog_items_fulfillment_type",
        ),
        sa.CheckConstraint(
            "cost_points > 0",
            name="ck_reward_catalog_items_cost_points_positive",
        ),
        sa.CheckConstraint(
            "inventory_remaining IS NULL OR inventory_remaining >= 0",
            name="ck_reward_catalog_items_inventory_nonneg",
        ),
    )
    # Index on SKU for idempotent seed lookups.
    op.create_index(
        "ix_reward_catalog_items_sku",
        "reward_catalog_items",
        ["sku"],
        unique=True,
    )
    # Index supporting active-catalog list endpoint.
    op.create_index(
        "ix_reward_catalog_items_is_active",
        "reward_catalog_items",
        ["is_active"],
    )

    # ── reward_redemptions ───────────────────────────────────────────────────
    op.create_table(
        "reward_redemptions",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            nullable=False,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "member_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "catalog_item_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("reward_catalog_items.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("cost_points_at_redemption", sa.Integer, nullable=False),
        sa.Column(
            "status",
            sa.String(length=20),
            nullable=False,
            server_default="pending",
        ),
        sa.Column("fulfillment_reference", sa.String(length=500), nullable=True),
        sa.Column(
            "requested_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("fulfilled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("failure_reason", sa.Text, nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint(
            f"status IN ({', '.join(repr(s) for s in _REDEMPTION_STATUSES)})",
            name="ck_reward_redemptions_status",
        ),
        sa.CheckConstraint(
            "cost_points_at_redemption > 0",
            name="ck_reward_redemptions_points_positive",
        ),
    )

    # Composite index: member redemption history — hot path for
    # GET /members/{id}/rewards/redemptions (ORDER BY created_at DESC).
    op.create_index(
        "ix_reward_redemptions_member_created",
        "reward_redemptions",
        ["member_id", "created_at"],
    )
    # Simple index on status for admin fulfillment queues.
    op.create_index(
        "ix_reward_redemptions_status",
        "reward_redemptions",
        ["status"],
    )

    # ── Audit-trail integrity: REVOKE UPDATE, DELETE from app role ───────────
    # Wrap in DO $$ to suppress the error when compass_app doesn't exist in the
    # target database (e.g. local dev that doesn't create a separate app role).
    op.execute(
        f"""
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM pg_roles WHERE rolname = '{_APP_ROLE}'
            ) THEN
                REVOKE UPDATE, DELETE
                ON reward_redemptions
                FROM {_APP_ROLE};
            END IF;
        END
        $$;
        """
    )


def downgrade() -> None:
    # Re-grant before drop in case the REVOKE succeeded on upgrade.
    op.execute(
        f"""
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM pg_roles WHERE rolname = '{_APP_ROLE}'
            ) THEN
                GRANT UPDATE, DELETE
                ON reward_redemptions
                TO {_APP_ROLE};
            END IF;
        END
        $$;
        """
    )

    op.drop_index("ix_reward_redemptions_status", table_name="reward_redemptions")
    op.drop_index("ix_reward_redemptions_member_created", table_name="reward_redemptions")
    op.drop_table("reward_redemptions")

    op.drop_index("ix_reward_catalog_items_is_active", table_name="reward_catalog_items")
    op.drop_index("ix_reward_catalog_items_sku", table_name="reward_catalog_items")
    op.drop_table("reward_catalog_items")

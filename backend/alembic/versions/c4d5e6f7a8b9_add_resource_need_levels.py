"""add_resource_need_levels — CHW-assigned Low/Medium/High priority per resource need

Revision ID: c4d5e6f7a8b9
Revises:     947a18b60652
Create Date: 2026-06-26

Schema notes
------------
member_profiles.resource_need_levels
  - JSONB column, NOT NULL, server_default '{}' (empty dict).
  - Keys are resource-need slugs (matching primary_need / additional_needs values).
  - Values are one of {"low", "medium", "high"}.
  - Written by the PATCH /chw/members/{id}/resource-needs endpoint on every update;
    the endpoint always sends the complete normalised map.

Backfill logic
--------------
For rows that already have primary_need / additional_needs populated we derive an
initial level map from the existing priority ordering:

    primary_need          → "high"
    additional_needs[0]   → "medium"  (first element, 1-indexed in PG = index 1)
    additional_needs[1:]  → "low"     (remainder, PG slice [2:length])

The SQL uses JSONB || merge with higher-priority sides on the right so that if a
need slug appears in both primary_need AND additional_needs, the "high" assignment
from primary_need wins. Members with no needs set receive '{}'.

Downgrade
---------
Simply drops the column — no data is lost that wasn't already in the existing
primary_need / additional_needs columns.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "c4d5e6f7a8b9"
down_revision: str = "947a18b60652"
branch_labels = None
depends_on = None


def _backfill_levels(
    primary_need: str | None,
    additional_needs: list[str] | None,
) -> dict[str, str]:
    """Pure-Python equivalent of the SQL backfill — exposed for unit testing.

    priority ordering:
      primary_need          → "high"
      additional_needs[0]   → "medium"
      additional_needs[1:]  → "low"

    Higher-priority assignments win if a slug appears in multiple positions.
    """
    result: dict[str, str] = {}
    # Build from lowest to highest priority so higher priority overwrites.
    for need in reversed((additional_needs or [])[1:]):
        if need:
            result[need] = "low"
    if additional_needs and len(additional_needs) >= 1 and additional_needs[0]:
        result[additional_needs[0]] = "medium"
    if primary_need:
        result[primary_need] = "high"
    return result


def upgrade() -> None:
    # ── 1. Add the column (NOT NULL, default empty dict) ────────────────────
    op.add_column(
        "member_profiles",
        sa.Column(
            "resource_need_levels",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'"),
        ),
    )

    # ── 2. Backfill existing rows ────────────────────────────────────────────
    # Build the level map purely in SQL using JSONB merge (||).
    # Merge order: low < medium < high (right-side wins on key conflicts),
    # so "high" from primary_need always takes precedence over additional_needs
    # if the same slug appears in both.
    #
    # Guard against NULL primary_need and NULL/empty additional_needs via CASE.
    # members with no needs set remain '{}'.
    op.execute(
        """
        UPDATE member_profiles
        SET resource_need_levels = (
            -- Low: additional_needs[2..N] (PG 1-indexed, so slice [2:len])
            CASE
                WHEN additional_needs IS NOT NULL
                     AND cardinality(additional_needs) >= 2
                THEN (
                    SELECT COALESCE(jsonb_object_agg(n, 'low'), '{}')
                    FROM unnest(
                        additional_needs[2:array_length(additional_needs, 1)]
                    ) AS n
                    WHERE n IS NOT NULL
                )
                ELSE '{}'::jsonb
            END
            ||
            -- Medium: additional_needs[1] (PG 1-indexed = Python [0])
            CASE
                WHEN additional_needs IS NOT NULL
                     AND cardinality(additional_needs) >= 1
                     AND additional_needs[1] IS NOT NULL
                THEN jsonb_build_object(additional_needs[1], 'medium')
                ELSE '{}'::jsonb
            END
            ||
            -- High: primary_need (rightmost → wins on conflict)
            CASE
                WHEN primary_need IS NOT NULL
                THEN jsonb_build_object(primary_need, 'high')
                ELSE '{}'::jsonb
            END
        )
        WHERE resource_need_levels = '{}'::jsonb
        """
    )


def downgrade() -> None:
    op.drop_column("member_profiles", "resource_need_levels")

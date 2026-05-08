"""add communication_touches table for bidirectional CHW↔member touch audit

Revision ID: x7u1v2w3y4z5
Revises: v5r8s9t0u1v2
Create Date: 2026-05-08

Append-only audit log for masked-call and in-app-message touches between
CHWs and members initiated outside the formal session flow. Recording is
explicitly OFF for these touches (no consent IVR, no AssemblyAI stream).

The composite index on (initiator_id, recipient_id, kind, created_at) is
the hot path for the per-pair-per-day rate limit query in the call
endpoints — it lets PG count today's touches between two specific users
without a full scan.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "x7u1v2w3y4z5"
down_revision: str = "v5r8s9t0u1v2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Postgres ENUM for the touch kind. Stored separately so we can ALTER TYPE
    # to add new kinds (e.g. 'video') without a column rewrite.
    touch_kind = postgresql.ENUM(
        "call",
        "sms",
        "in_app_message",
        name="touch_kind_enum",
        create_type=True,
    )
    touch_kind.create(op.get_bind(), checkfirst=True)

    op.create_table(
        "communication_touches",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column(
            "initiator_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "recipient_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "kind",
            postgresql.ENUM(
                "call",
                "sms",
                "in_app_message",
                name="touch_kind_enum",
                create_type=False,
            ),
            nullable=False,
        ),
        sa.Column("provider_session_id", sa.String(length=200), nullable=True),
        sa.Column(
            "extra_data",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )

    op.create_index(
        "ix_communication_touches_initiator",
        "communication_touches",
        ["initiator_id"],
    )
    op.create_index(
        "ix_communication_touches_recipient",
        "communication_touches",
        ["recipient_id"],
    )
    op.create_index(
        "ix_communication_touches_created_at",
        "communication_touches",
        ["created_at"],
    )
    # Composite index — the hot rate-limit query path:
    # SELECT COUNT(*) FROM communication_touches
    #   WHERE initiator_id=? AND recipient_id=? AND kind=? AND created_at >= today_utc
    op.create_index(
        "ix_communication_touches_pair_kind_time",
        "communication_touches",
        ["initiator_id", "recipient_id", "kind", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_communication_touches_pair_kind_time", table_name="communication_touches")
    op.drop_index("ix_communication_touches_created_at", table_name="communication_touches")
    op.drop_index("ix_communication_touches_recipient", table_name="communication_touches")
    op.drop_index("ix_communication_touches_initiator", table_name="communication_touches")
    op.drop_table("communication_touches")
    postgresql.ENUM(name="touch_kind_enum").drop(op.get_bind(), checkfirst=True)

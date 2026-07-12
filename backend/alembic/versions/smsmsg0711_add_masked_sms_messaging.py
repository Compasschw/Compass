"""add masked SMS messaging: messages.channel/provider_message_id, member_profiles sticky pointer + opt-out

Revision ID: smsmsg0711
Revises:     smute0708
Create Date: 2026-07-11

Adds the columns needed for shared-number masked SMS (CHW<->member) that
mirrors into the existing in-app conversation thread:

  messages.channel
      'in_app' (default; every pre-existing row backfills to this via the
      server_default — no explicit UPDATE loop needed) | 'sms'. A CHECK
      constraint enforces the enum-like value set as plain text rather than a
      Postgres ENUM type — mirrors the closure_status / services_consent
      pattern already used on member_profiles (plain String + app-layer
      validation), which is cheaper to extend later than an ENUM ALTER TYPE.

  messages.provider_message_id
      Vonage Messages API `message_uuid`. A partial UNIQUE index (WHERE NOT
      NULL) gives idempotent inbound-webhook processing (a re-delivered
      Vonage webhook for the same message_uuid cannot create a second
      Message row) without a separate dedup table. NULL for all pre-existing
      in_app rows and stays NULL for future in_app rows.

  member_profiles.last_sms_conversation_id
      Sticky routing pointer for inbound SMS replies (see Message docstring
      in app/models/conversation.py for the full rationale). Nullable FK,
      ON DELETE SET NULL — a deleted conversation degrades to "route by most
      recent conversation" rather than breaking inbound messaging.

  member_profiles.sms_opt_out
      STOP/UNSUBSCRIBE flag, default false.

All four columns are nullable or carry a server_default, so this migration
is a fast, lock-light set of ADD COLUMN statements — no backfill loop, no
table rewrite. Runs behind the pre-migration RDS snapshot gate (deploy.yml)
like every other migration. Existing message-creation paths are unaffected:
every INSERT that doesn't set `channel` explicitly gets 'in_app' from the
server_default, so in-app messaging, the call bridge, and existing
conversation/message tests keep working unchanged.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "smsmsg0711"
down_revision: str = "smute0708"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── messages.channel + provider_message_id ────────────────────────────
    op.add_column(
        "messages",
        sa.Column(
            "channel",
            sa.String(length=20),
            nullable=False,
            server_default="in_app",
        ),
    )
    op.create_check_constraint(
        "ck_messages_channel",
        "messages",
        "channel IN ('in_app', 'sms')",
    )
    op.add_column(
        "messages",
        sa.Column("provider_message_id", sa.String(length=255), nullable=True),
    )
    op.create_index(
        "ix_messages_provider_message_id_unique",
        "messages",
        ["provider_message_id"],
        unique=True,
        postgresql_where=sa.text("provider_message_id IS NOT NULL"),
    )

    # ── member_profiles: sticky routing pointer + opt-out flag ────────────
    op.add_column(
        "member_profiles",
        sa.Column(
            "last_sms_conversation_id",
            postgresql.UUID(as_uuid=True),
            nullable=True,
        ),
    )
    op.create_foreign_key(
        "fk_member_profiles_last_sms_conversation_id",
        "member_profiles",
        "conversations",
        ["last_sms_conversation_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.add_column(
        "member_profiles",
        sa.Column(
            "sms_opt_out",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )


def downgrade() -> None:
    op.drop_column("member_profiles", "sms_opt_out")
    op.drop_constraint(
        "fk_member_profiles_last_sms_conversation_id",
        "member_profiles",
        type_="foreignkey",
    )
    op.drop_column("member_profiles", "last_sms_conversation_id")

    op.drop_index("ix_messages_provider_message_id_unique", table_name="messages")
    op.drop_column("messages", "provider_message_id")
    op.drop_constraint("ck_messages_channel", "messages", type_="check")
    op.drop_column("messages", "channel")

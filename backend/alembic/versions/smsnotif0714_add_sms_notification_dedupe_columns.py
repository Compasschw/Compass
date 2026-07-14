"""add_sms_notification_dedupe_columns — Wave-2 Agent B3: SMS notifications.

Revision ID: smsnotif0714
Revises:     resneeds0713
Create Date: 2026-07-14

Adds the dedupe/throttle columns backing ``app.services.sms_notifications``:

  - ``sessions.reminder_24h_sent_at`` / ``sessions.reminder_1h_sent_at``
    (nullable, tz-aware) — stamped by the new scheduler job the first time
    each reminder SMS fires for a session, so a re-run of the ~5-minute
    cadence (or a process restart) never double-sends. Durable across
    restarts, unlike the existing push-reminder jobs' in-memory
    ``_reminded_sessions`` set (see app/services/scheduler.py) — SMS costs
    real money per send, so the dedupe must survive a deploy.

  - ``conversations.member_message_sms_alert_last_sent_at`` (nullable,
    tz-aware) — smallest-footprint throttle for the "member sent you a
    message" CHW alert: at most one SMS per conversation per 30 minutes.
    A single timestamp column on the existing Conversation row (mirroring
    the ``pinned_at`` / ``archived_at`` pattern already on this table) is
    sufficient because the throttle is scoped per-conversation, not
    per-message — no new table, no counter, just "was the last alert sent
    >= 30 minutes ago." Chosen over a dedicated throttle/audit table since
    we don't need history, just the single most-recent timestamp.

Nullable adds, no table rewrite, no backfill needed; passes the RDS
snapshot gate.
"""

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision = "smsnotif0714"
down_revision = "chwphone0713"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "sessions",
        sa.Column("reminder_24h_sent_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "sessions",
        sa.Column("reminder_1h_sent_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "conversations",
        sa.Column(
            "member_message_sms_alert_last_sent_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("conversations", "member_message_sms_alert_last_sent_at")
    op.drop_column("sessions", "reminder_1h_sent_at")
    op.drop_column("sessions", "reminder_24h_sent_at")

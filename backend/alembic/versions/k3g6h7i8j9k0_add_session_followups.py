"""add_session_followups

Adds:
  1. ``session_followups`` table — structured items extracted from session
     transcripts by the LLM extraction pass (action items, follow-up tasks,
     resource referrals, member goals).  Also carries ``show_on_roadmap`` flag
     so the member's roadmap screen can query directly without a separate table.

  2. ``session_documentation.followups_extracted_at`` column — nullable datetime
     stamped when the LLM extraction pass completes for a session.  Used as the
     primary idempotency gate so re-calling the endpoint returns cached rows.

Both additions are backwards-compatible (new table, nullable column).  Safe to
apply without downtime on PostgreSQL 12+.

Revision ID: k3g6h7i8j9k0
Revises: j2f5g6h7i8j9
Create Date: 2026-04-22 12:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "k3g6h7i8j9k0"
down_revision: Union[str, None] = "j2f5g6h7i8j9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── 1. session_followups ──────────────────────────────────────────────────
    op.create_table(
        "session_followups",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "session_id",
            UUID(as_uuid=True),
            sa.ForeignKey("sessions.id", ondelete="CASCADE", name="fk_session_followups_session_id"),
            nullable=False,
        ),
        sa.Column(
            "member_id",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", name="fk_session_followups_member_id"),
            nullable=False,
        ),
        sa.Column(
            "chw_id",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", name="fk_session_followups_chw_id"),
            nullable=False,
        ),
        # kind: action_item | follow_up_task | resource_referral | member_goal
        sa.Column("kind", sa.String(50), nullable=False),
        # description is PHI — encrypted at rest via application-level AES where
        # required.  The column itself is plaintext Text; app-layer encryption
        # should be applied in a follow-on task if column-level encryption is
        # required by the HIPAA implementation plan.
        sa.Column("description", sa.Text, nullable=False),
        # owner: chw | member | both
        sa.Column("owner", sa.String(20), nullable=True),
        # vertical mirrors sessions.vertical for fast roadmap filtering
        sa.Column("vertical", sa.String(50), nullable=True),
        # priority: low | medium | high
        sa.Column("priority", sa.String(20), nullable=True),
        sa.Column("due_date", sa.Date, nullable=True),
        # status: pending | confirmed | dismissed | completed
        sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("auto_created", sa.Boolean, nullable=False, server_default="true"),
        sa.Column(
            "confirmed_by_user_id",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", name="fk_session_followups_confirmed_by"),
            nullable=True,
        ),
        sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=True),
        # show_on_roadmap: surfaces this item on MemberRoadmapScreen when true.
        # Set by the service layer for owner = 'member' or 'both'.
        sa.Column("show_on_roadmap", sa.Boolean, nullable=False, server_default="false"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )

    # Indexes for the most common query patterns:
    #   - list all followups for a session (extraction result, CHW view)
    #   - list roadmap items for a member
    #   - filter by status for workflow views
    op.create_index(
        "ix_session_followups_session_id",
        "session_followups",
        ["session_id"],
    )
    op.create_index(
        "ix_session_followups_member_id",
        "session_followups",
        ["member_id"],
    )
    op.create_index(
        "ix_session_followups_member_roadmap",
        "session_followups",
        ["member_id", "show_on_roadmap"],
        postgresql_where=sa.text("show_on_roadmap = TRUE"),
    )
    op.create_index(
        "ix_session_followups_kind",
        "session_followups",
        ["kind"],
    )
    op.create_index(
        "ix_session_followups_status",
        "session_followups",
        ["status"],
    )

    # ── 2. session_documentation.followups_extracted_at ──────────────────────
    op.add_column(
        "session_documentation",
        sa.Column(
            "followups_extracted_at",
            sa.DateTime(timezone=True),
            nullable=True,
            comment=(
                "Stamped when the LLM follow-up extraction pass completes. "
                "NULL = not yet run. Used as idempotency gate in extract_session_followups()."
            ),
        ),
    )


def downgrade() -> None:
    # Remove the idempotency column first (no dependencies).
    op.drop_column("session_documentation", "followups_extracted_at")

    # Drop indexes before the table.
    op.drop_index("ix_session_followups_status", table_name="session_followups")
    op.drop_index("ix_session_followups_kind", table_name="session_followups")
    op.drop_index("ix_session_followups_member_roadmap", table_name="session_followups")
    op.drop_index("ix_session_followups_member_id", table_name="session_followups")
    op.drop_index("ix_session_followups_session_id", table_name="session_followups")
    op.drop_table("session_followups")

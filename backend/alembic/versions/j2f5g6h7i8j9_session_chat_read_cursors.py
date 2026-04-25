"""session_chat_read_cursors

Adds session-scoped messaging infrastructure to the conversations table:

  chw_read_up_to    – UUID of the last Message the CHW has read.  NULL means
                      no messages read yet.  Used by the polling endpoint to
                      compute unread counts without a separate read-receipt table.

  member_read_up_to – Same, for the member side.

  uq_conversations_session_id – Unique constraint on conversations.session_id
                      (NULL values excluded by Postgres semantics), enforcing
                      the 1-session → 1-conversation invariant assumed by the
                      session-scoped messaging endpoints.

  ix_conversations_session_id – Index on session_id for fast O(1) conversation
                      lookup from a session ID, used on every message list/send.

No existing data is changed.  The two new columns are nullable so the migration
is safe to run without downtime (no table rewrites on Postgres 12+).

Revision ID: j2f5g6h7i8j9
Revises: i1e4f5a6b7c8
Create Date: 2026-04-22 10:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "j2f5g6h7i8j9"
down_revision: Union[str, None] = "i1e4f5a6b7c8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Read-cursor columns — nullable FKs into messages.
    op.add_column(
        "conversations",
        sa.Column(
            "chw_read_up_to",
            UUID(as_uuid=True),
            sa.ForeignKey("messages.id", name="fk_conversations_chw_read_up_to_messages"),
            nullable=True,
        ),
    )
    op.add_column(
        "conversations",
        sa.Column(
            "member_read_up_to",
            UUID(as_uuid=True),
            sa.ForeignKey("messages.id", name="fk_conversations_member_read_up_to_messages"),
            nullable=True,
        ),
    )

    # Unique constraint: one session → one conversation thread.
    # Postgres excludes NULL values from unique constraints, so ad-hoc DMs
    # (session_id=NULL) are unaffected.
    op.create_unique_constraint(
        "uq_conversations_session_id",
        "conversations",
        ["session_id"],
    )

    # Index for the fast-path lookup in _get_or_create_session_conversation().
    # The unique constraint already creates an index in Postgres, but making it
    # explicit here keeps the intent clear and allows us to drop/recreate
    # independently if the constraint shape changes.
    op.create_index(
        "ix_conversations_session_id",
        "conversations",
        ["session_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_conversations_session_id", table_name="conversations")
    op.drop_constraint("uq_conversations_session_id", "conversations", type_="unique")
    op.drop_column("conversations", "member_read_up_to")
    op.drop_column("conversations", "chw_read_up_to")

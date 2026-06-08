"""add_flag_notes_table — FlagNote model for CHW-authored per-member notes

Revision ID: i9d0e1f2g3h4
Revises:     h8c9d0e1f2g3
Create Date: 2026-06-08

Schema notes
------------
flag_notes
  - ``member_id``       FK → users.id  — the member being described.
  - ``author_chw_id``   FK → users.id  — the CHW who created this note row.
  - ``body``            TEXT, NOT NULL — free-form note content (PHI).
  - ``is_active``       BOOLEAN, default TRUE — only one active note per member
                         at a time; older notes are soft-deleted (FALSE) when a
                         new note is written or an explicit DELETE is issued.
  - ``created_at``      server-default NOW() — immutable after insert.
  - ``updated_at``      server-default NOW(), onupdate NOW().

Indexes
-------
  - ix_flag_notes_member_id   (member_id)   — hot path: "active note for member"
  - ix_flag_notes_is_active   (is_active)   — supports the is_active filter

Authorization
-------------
Application-level only — Postgres REVOKE statements are not applied here so
that the migration runs cleanly in environments that use a single-role setup
(dev docker-compose).  Row-level CHW ↔ member relationship checks are enforced
in the API layer via assert_shared_session.

HIPAA note
----------
``body`` is PHI.  Never include it in structured log entries.  The table is
retained indefinitely for audit purposes — inactive rows must not be hard-deleted.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = "i9d0e1f2g3h4"
down_revision = "h8c9d0e1f2g3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "flag_notes",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            nullable=False,
        ),
        sa.Column(
            "member_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=False,
        ),
        sa.Column(
            "author_chw_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=False,
        ),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
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

    # Covering indexes for the two most common query predicates.
    op.create_index("ix_flag_notes_member_id", "flag_notes", ["member_id"])
    op.create_index("ix_flag_notes_is_active", "flag_notes", ["is_active"])


def downgrade() -> None:
    op.drop_index("ix_flag_notes_is_active", table_name="flag_notes")
    op.drop_index("ix_flag_notes_member_id", table_name="flag_notes")
    op.drop_table("flag_notes")

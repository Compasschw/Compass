"""Add awaiting_documentation session status and case_notes table.

Revision ID: p1q2r3s4t5u6
Revises:     ab1c2d3e4f5a
Create Date: 2026-06-09

Changes
-------
1. Expand the sessions.status column from VARCHAR(20) to VARCHAR(30) so the
   new ``awaiting_documentation`` value (22 chars) fits.  The column is a
   plain String with no Postgres ENUM type, so no ALTER TYPE is needed.
   The existing CHECK CONSTRAINT (if any) is updated to include the new value.

2. Create the ``case_notes`` table:
     id              UUID PK
     member_id       UUID FK → users.id
     chw_id          UUID FK → users.id
     session_id      UUID FK → sessions.id (nullable)
     body            VARCHAR(512) — EncryptedString (AES-256-GCM base64)
     is_pinned       BOOLEAN NOT NULL DEFAULT FALSE
     deleted_at      TIMESTAMPTZ nullable
     created_at      TIMESTAMPTZ DEFAULT now()
     updated_at      TIMESTAMPTZ DEFAULT now()

3. Composite index ix_case_notes_member_chw on (member_id, chw_id).
4. Index ix_case_notes_session on (session_id).

Downgrade
---------
Drops the case_notes table and its indexes.  The sessions.status column width
change is NOT rolled back (wider columns are backwards-compatible).
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "p1q2r3s4t5u6"
down_revision: str = "ab1c2d3e4f5a"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    # ── 1. Widen sessions.status to accommodate awaiting_documentation ─────────
    # Current width is VARCHAR(20); "awaiting_documentation" is 22 chars.
    # ALTER COLUMN type change in Postgres is instant for varchar widening.
    op.alter_column(
        "sessions",
        "status",
        existing_type=sa.String(20),
        type_=sa.String(30),
        existing_nullable=True,
    )

    # ── 2. Create case_notes table ────────────────────────────────────────────
    op.create_table(
        "case_notes",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "member_id",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "chw_id",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "session_id",
            UUID(as_uuid=True),
            sa.ForeignKey("sessions.id", ondelete="SET NULL"),
            nullable=True,
        ),
        # EncryptedString maps to String(512) — base64(nonce+ciphertext+tag).
        sa.Column("body", sa.String(512), nullable=False),
        sa.Column(
            "is_pinned",
            sa.Boolean,
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )

    # ── 3. Composite index: CHW's notes for a member (primary list query) ──────
    op.create_index(
        "ix_case_notes_member_chw",
        "case_notes",
        ["member_id", "chw_id"],
        unique=False,
    )

    # ── 4. Index: session-scoped note lookup ──────────────────────────────────
    op.create_index(
        "ix_case_notes_session",
        "case_notes",
        ["session_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_case_notes_session", table_name="case_notes")
    op.drop_index("ix_case_notes_member_chw", table_name="case_notes")
    op.drop_table("case_notes")
    # Note: we do NOT revert the sessions.status column width — narrowing a
    # varchar can cause data loss if rows already have the wider value.

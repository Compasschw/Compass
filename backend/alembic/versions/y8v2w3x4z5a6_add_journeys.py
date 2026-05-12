"""add_journeys — gamified care pathways

Revision ID: y8v2w3x4z5a6
Revises: x7u1v2w3y4z5
Create Date: 2026-05-09

Five new tables:
  - journey_templates
  - journey_template_steps
  - member_journeys
  - member_journey_step_states
  - wellness_points_ledger

Security:
  The wellness_points_ledger is append-only at the application layer.  This
  migration also REVOKEs UPDATE and DELETE on that table from the application
  role (``compass_app``) so the invariant is enforced at the database level.
  If your environment uses a different role name, update the REVOKE statements
  below.

Indexes:
  - member_journeys (member_id, status)     — member's active-journey lookup
  - member_journeys (chw_id, status)        — CHW caseload view
  - member_journey_step_states (member_journey_id, status)
  - wellness_points_ledger (member_id, created_at DESC) — member's points feed
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "y8v2w3x4z5a6"
down_revision: str = "x7u1v2w3y4z5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── journey_templates ──────────────────────────────────────────────────────
    op.create_table(
        "journey_templates",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("slug", sa.String(length=100), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("category", sa.String(length=100), nullable=False),
        sa.Column(
            "icon",
            sa.String(length=100),
            nullable=False,
            server_default="circle",
        ),
        sa.Column(
            "is_active",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_journey_templates_slug",
        "journey_templates",
        ["slug"],
        unique=True,
    )

    # ── journey_template_steps ─────────────────────────────────────────────────
    op.create_table(
        "journey_template_steps",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column(
            "template_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("journey_templates.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("order", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column(
            "description",
            sa.Text(),
            nullable=False,
            server_default="",
        ),
        sa.Column(
            "points_on_completion",
            sa.Integer(),
            nullable=False,
            server_default="10",
        ),
        sa.Column(
            "required_documents",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_journey_template_steps_template_id",
        "journey_template_steps",
        ["template_id"],
    )

    # ── member_journeys ────────────────────────────────────────────────────────
    op.create_table(
        "member_journeys",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column(
            "member_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "template_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("journey_templates.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "chw_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "status",
            sa.String(length=20),
            nullable=False,
            server_default="active",
        ),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "current_step_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("journey_template_steps.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    # CHW caseload view: filter by chw_id + status.
    op.create_index(
        "ix_member_journeys_chw_id_status",
        "member_journeys",
        ["chw_id", "status"],
    )
    # Member's active-journey lookup.
    op.create_index(
        "ix_member_journeys_member_id_status",
        "member_journeys",
        ["member_id", "status"],
    )

    # ── member_journey_step_states ─────────────────────────────────────────────
    op.create_table(
        "member_journey_step_states",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column(
            "member_journey_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("member_journeys.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "template_step_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("journey_template_steps.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "status",
            sa.String(length=20),
            nullable=False,
            server_default="upcoming",
        ),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("due_date", sa.DateTime(timezone=True), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column(
            "points_awarded",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_member_journey_step_states_journey_id_status",
        "member_journey_step_states",
        ["member_journey_id", "status"],
    )

    # ── wellness_points_ledger ─────────────────────────────────────────────────
    op.create_table(
        "wellness_points_ledger",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column(
            "member_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("points", sa.Integer(), nullable=False),
        sa.Column("reason", sa.String(length=100), nullable=False),
        # No FK constraint — related_id can reference any table depending on
        # the reason code (step state, appointment, etc.).
        sa.Column(
            "related_id",
            postgresql.UUID(as_uuid=True),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    # Hot path for the member's points feed — member_id + created_at DESC.
    op.create_index(
        "ix_wellness_points_ledger_member_id_created_at",
        "wellness_points_ledger",
        ["member_id", sa.text("created_at DESC")],
    )

    # ── Append-only enforcement via REVOKE ─────────────────────────────────────
    # The application role must NOT be able to UPDATE or DELETE ledger rows.
    # Adjust 'compass_app' to match your actual application DB role.
    # The DO block silently no-ops if the role does not exist in this
    # environment (local dev / test DBs often use a single superuser role).
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM pg_roles WHERE rolname = 'compass_app'
            ) THEN
                REVOKE UPDATE, DELETE
                ON TABLE wellness_points_ledger
                FROM compass_app;
            END IF;
        END
        $$;
        """
    )


def downgrade() -> None:
    # Re-grant before dropping so the role is clean if upgrade is re-run.
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM pg_roles WHERE rolname = 'compass_app'
            ) THEN
                GRANT UPDATE, DELETE
                ON TABLE wellness_points_ledger
                TO compass_app;
            END IF;
        END
        $$;
        """
    )

    op.drop_index(
        "ix_wellness_points_ledger_member_id_created_at",
        table_name="wellness_points_ledger",
    )
    op.drop_table("wellness_points_ledger")

    op.drop_index(
        "ix_member_journey_step_states_journey_id_status",
        table_name="member_journey_step_states",
    )
    op.drop_table("member_journey_step_states")

    op.drop_index("ix_member_journeys_member_id_status", table_name="member_journeys")
    op.drop_index("ix_member_journeys_chw_id_status", table_name="member_journeys")
    op.drop_table("member_journeys")

    op.drop_index(
        "ix_journey_template_steps_template_id",
        table_name="journey_template_steps",
    )
    op.drop_table("journey_template_steps")

    op.drop_index("ix_journey_templates_slug", table_name="journey_templates")
    op.drop_table("journey_templates")

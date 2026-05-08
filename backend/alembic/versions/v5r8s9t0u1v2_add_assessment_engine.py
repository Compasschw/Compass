"""add_assessment_engine

Flexible questionnaire engine tables: member_assessments and
member_assessment_responses.

Background
----------
The assessment engine supports structured health screenings conducted by CHWs.
Design goals:
- Per-answer timestamping: every response row records exactly when it was
  captured and by whom, giving a complete audit trail.
- Re-assessment support: multiple response rows for the same question_id are
  allowed — they create new rows, never updates. The "current" answer is the
  MAX(captured_at) row per question.
- Snapshot columns: question_text and answer_label are stored at capture time
  so template renames never corrupt historical data.
- JSONB tags: enables @> array containment queries for HEDIS / SDOH / Member
  needs filtering in AI summary and admin reporting without a join table.
- session_id nullable: assessments may occur outside a formal session.

New tables
----------
member_assessments
    id              UUID PK
    member_id       UUID FK users.id, indexed
    session_id      UUID FK sessions.id NULLABLE, indexed
    template_id     VARCHAR(100)  NOT NULL, indexed
    chw_id          UUID FK users.id, indexed
    status          VARCHAR(20)   NOT NULL DEFAULT 'in_progress', indexed
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    completed_at    TIMESTAMPTZ   NULLABLE

    Composite index (member_id, template_id, status): accelerates the
    idempotency check "any in_progress assessment for this member+template?"

member_assessment_responses
    id                  UUID PK
    assessment_id       UUID FK member_assessments.id ON DELETE CASCADE, indexed
    question_id         VARCHAR(100) NOT NULL
    question_text       VARCHAR(500) NOT NULL
    answer_value        VARCHAR(500) NOT NULL
    answer_label        VARCHAR(500) NOT NULL
    category            VARCHAR(40)  NOT NULL, indexed
    subcategory         VARCHAR(40)  NOT NULL, indexed
    tags                JSONB        NULLABLE
    captured_at         TIMESTAMPTZ  NOT NULL
    captured_by_chw_id  UUID FK users.id NOT NULL

    Composite indexes:
    - (assessment_id, captured_at): hot-path fetch for ordered response list
    - (assessment_id, question_id): supports "latest answer per question" query

Revision ID: v5r8s9t0u1v2
Revises: u4q7r8s9t0u1
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "v5r8s9t0u1v2"
down_revision: str | None = "u4q7r8s9t0u1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── member_assessments ───────────────────────────────────────────────────
    op.create_table(
        "member_assessments",
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
            "session_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("sessions.id"),
            nullable=True,
        ),
        sa.Column("template_id", sa.String(100), nullable=False),
        sa.Column(
            "chw_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=False,
        ),
        sa.Column(
            "status",
            sa.String(20),
            nullable=False,
            server_default="in_progress",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
        sa.Column(
            "completed_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )

    # Individual column indexes for member_assessments
    op.create_index("ix_member_assessments_member_id", "member_assessments", ["member_id"])
    op.create_index("ix_member_assessments_session_id", "member_assessments", ["session_id"])
    op.create_index("ix_member_assessments_template_id", "member_assessments", ["template_id"])
    op.create_index("ix_member_assessments_chw_id", "member_assessments", ["chw_id"])
    op.create_index("ix_member_assessments_status", "member_assessments", ["status"])

    # Composite index for idempotency check
    op.create_index(
        "ix_member_assessments_member_template_status",
        "member_assessments",
        ["member_id", "template_id", "status"],
    )

    # ── member_assessment_responses ──────────────────────────────────────────
    op.create_table(
        "member_assessment_responses",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            nullable=False,
        ),
        sa.Column(
            "assessment_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("member_assessments.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("question_id", sa.String(100), nullable=False),
        sa.Column("question_text", sa.String(500), nullable=False),
        sa.Column("answer_value", sa.String(500), nullable=False),
        sa.Column("answer_label", sa.String(500), nullable=False),
        sa.Column("category", sa.String(40), nullable=False),
        sa.Column("subcategory", sa.String(40), nullable=False),
        sa.Column("tags", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "captured_by_chw_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=False,
        ),
    )

    # Individual and composite indexes for responses
    op.create_index(
        "ix_assessment_responses_assessment_id",
        "member_assessment_responses",
        ["assessment_id"],
    )
    op.create_index(
        "ix_assessment_responses_category",
        "member_assessment_responses",
        ["category"],
    )
    op.create_index(
        "ix_assessment_responses_subcategory",
        "member_assessment_responses",
        ["subcategory"],
    )
    op.create_index(
        "ix_assessment_responses_assessment_captured",
        "member_assessment_responses",
        ["assessment_id", "captured_at"],
    )
    op.create_index(
        "ix_assessment_responses_assessment_question",
        "member_assessment_responses",
        ["assessment_id", "question_id"],
    )


def downgrade() -> None:
    # Responses first — FK dependency on member_assessments
    op.drop_index("ix_assessment_responses_assessment_question", table_name="member_assessment_responses")
    op.drop_index("ix_assessment_responses_assessment_captured", table_name="member_assessment_responses")
    op.drop_index("ix_assessment_responses_subcategory", table_name="member_assessment_responses")
    op.drop_index("ix_assessment_responses_category", table_name="member_assessment_responses")
    op.drop_index("ix_assessment_responses_assessment_id", table_name="member_assessment_responses")
    op.drop_table("member_assessment_responses")

    op.drop_index("ix_member_assessments_member_template_status", table_name="member_assessments")
    op.drop_index("ix_member_assessments_status", table_name="member_assessments")
    op.drop_index("ix_member_assessments_chw_id", table_name="member_assessments")
    op.drop_index("ix_member_assessments_template_id", table_name="member_assessments")
    op.drop_index("ix_member_assessments_session_id", table_name="member_assessments")
    op.drop_index("ix_member_assessments_member_id", table_name="member_assessments")
    op.drop_table("member_assessments")

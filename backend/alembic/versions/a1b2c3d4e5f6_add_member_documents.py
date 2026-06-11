"""add_member_documents — MemberDocument table for PHI file storage.

Revision ID: a1b2c3d4e5f6
Revises:     z9w3x4y5a6b7
Create Date: 2026-06-10

Schema notes
------------
member_documents
  - ``member_id`` FK → users.id, indexed — primary ownership
  - ``uploaded_by`` FK → users.id — may be the member themselves or a CHW
  - ``document_type`` VARCHAR(50) — enum enforced at the schema layer:
    'id' | 'income' | 'address' | 'medical' | 'other'
  - ``s3_url``  VARCHAR(1000) — full S3 object URL (PHI-adjacent, never logged)
  - ``s3_key``  VARCHAR(500)  — S3 key extracted at upload time for presigned-GET
  - ``size_bytes`` BIGINT     — needed for size display in the FE doc cards
  - ``deleted_at`` nullable   — soft-delete; rows never hard-deleted (HIPAA 6yr)

Indexes
  - ix_member_documents_member_active (member_id, deleted_at)
    → primary list query: active documents for a member
  - ix_member_documents_uploaded_by (uploaded_by)
    → CHW uploader-scoped queries

Bucket dependency
  The ``member_document`` upload purpose routes to
  ``settings.s3_member_documents_bucket`` (``compass-prod-member-documents``).
  The bucket must be created before document upload works in production —
  see docs/runbooks/create-phi-buckets.md → Step 3c.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = "a1b2c3d4e5f6"
down_revision = "z9w3x4y5a6b7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "member_documents",
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
        sa.Column("document_type", sa.String(50), nullable=False),
        sa.Column("filename", sa.String(255), nullable=False),
        sa.Column("s3_url", sa.String(1000), nullable=False),
        sa.Column("s3_key", sa.String(500), nullable=False),
        sa.Column("content_type", sa.String(100), nullable=False),
        sa.Column("size_bytes", sa.BigInteger, nullable=False),
        sa.Column(
            "uploaded_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=False,
        ),
        sa.Column(
            "uploaded_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )

    # Primary list query index: active documents for a member.
    op.create_index(
        "ix_member_documents_member_active",
        "member_documents",
        ["member_id", "deleted_at"],
    )

    # Uploader-scoped queries (CHW viewing their own uploads).
    op.create_index(
        "ix_member_documents_uploaded_by",
        "member_documents",
        ["uploaded_by"],
    )


def downgrade() -> None:
    op.drop_index("ix_member_documents_uploaded_by", table_name="member_documents")
    op.drop_index("ix_member_documents_member_active", table_name="member_documents")
    op.drop_table("member_documents")

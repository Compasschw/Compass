"""add_resource_tables

Creates two tables that power the CHW Resource Folder feature:

  - ``resources``             — admin-curated catalog of community resources
  - ``resource_suggestions``  — CHW-submitted proposals pending admin review

Design notes
------------
``resources.category`` is VARCHAR(50) rather than a Postgres enum type.
Using a CHECK constraint keeps the valid values enforced at the DB level
while allowing the application to add new categories without a separate
ALTER TYPE migration.

``resources.status`` uses a simple VARCHAR(20) with CHECK constraint:
  active | inactive
Inactive rows are preserved to keep @[Name](resource:uuid) tokens
resolvable in already-saved messages/notes.

``resource_suggestions.proposed_resource`` is JSONB (free-form) so CHWs
can submit partial data (e.g. just a name + phone). Admins fill in the
rest during review.

Indexes
-------
resources:
  - ix_resources_name           — prefix/contains search on name
  - ix_resources_category       — admin + CHW category filter
  - ix_resources_status         — CHW search filters to active only
  - ix_resources_zip_code       — proximity filter
  - ix_resources_created_at     — admin list ordering

resource_suggestions:
  - ix_resource_suggestions_chw_id       — CHW's own submissions view
  - ix_resource_suggestions_status       — admin pending queue hot path
  - ix_resource_suggestions_created_at   — queue ordering

Revision ID: v1a2b3c4d5e6
Revises:     u4q7r8s9t0u1
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "v1a2b3c4d5e6"
down_revision: str | None = "u4q7r8s9t0u1"
branch_labels = None
depends_on = None

# ─── Valid value sets (enforced via CHECK constraints) ─────────────────────────

_RESOURCE_CATEGORIES = (
    "housing",
    "food",
    "mental_health",
    "rehab",
    "healthcare",
    "legal",
    "transportation",
    "other",
)

_RESOURCE_STATUSES = ("active", "inactive")
_SUGGESTION_STATUSES = ("pending", "approved", "rejected")


def upgrade() -> None:
    # ── resources ──────────────────────────────────────────────────────────────
    op.create_table(
        "resources",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            nullable=False,
        ),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.Text, nullable=False),
        sa.Column(
            "category",
            sa.String(50),
            nullable=False,
            server_default="other",
        ),
        sa.Column("url", sa.String(500), nullable=True),
        sa.Column("phone", sa.String(20), nullable=True),
        sa.Column("address", sa.String(500), nullable=True),
        sa.Column("zip_code", sa.String(10), nullable=True),
        sa.Column("latitude", sa.Float, nullable=True),
        sa.Column("longitude", sa.Float, nullable=True),
        sa.Column("hours", sa.Text, nullable=True),
        sa.Column("eligibility", sa.Text, nullable=True),
        sa.Column(
            "languages",
            postgresql.ARRAY(sa.String),
            nullable=False,
            server_default="{}",
        ),
        sa.Column(
            "status",
            sa.String(20),
            nullable=False,
            server_default="active",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
        sa.Column(
            "created_by_admin_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=True,
        ),
        # Application-level category constraint
        sa.CheckConstraint(
            f"category IN ({', '.join(repr(c) for c in _RESOURCE_CATEGORIES)})",
            name="ck_resources_category",
        ),
        sa.CheckConstraint(
            f"status IN ({', '.join(repr(s) for s in _RESOURCE_STATUSES)})",
            name="ck_resources_status",
        ),
    )

    op.create_index("ix_resources_name", "resources", ["name"])
    op.create_index("ix_resources_category", "resources", ["category"])
    op.create_index("ix_resources_status", "resources", ["status"])
    op.create_index("ix_resources_zip_code", "resources", ["zip_code"])
    op.create_index("ix_resources_created_at", "resources", ["created_at"])

    # ── resource_suggestions ───────────────────────────────────────────────────
    op.create_table(
        "resource_suggestions",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            nullable=False,
        ),
        sa.Column(
            "chw_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=False,
        ),
        sa.Column(
            "proposed_resource",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
        sa.Column("notes", sa.Text, nullable=True),
        sa.Column(
            "status",
            sa.String(20),
            nullable=False,
            server_default="pending",
        ),
        sa.Column(
            "reviewed_by_admin_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("NOW()"),
        ),
        sa.Column(
            "reviewed_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        sa.CheckConstraint(
            f"status IN ({', '.join(repr(s) for s in _SUGGESTION_STATUSES)})",
            name="ck_resource_suggestions_status",
        ),
    )

    op.create_index(
        "ix_resource_suggestions_chw_id", "resource_suggestions", ["chw_id"]
    )
    op.create_index(
        "ix_resource_suggestions_status", "resource_suggestions", ["status"]
    )
    op.create_index(
        "ix_resource_suggestions_created_at",
        "resource_suggestions",
        ["created_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_resource_suggestions_created_at", table_name="resource_suggestions")
    op.drop_index("ix_resource_suggestions_status", table_name="resource_suggestions")
    op.drop_index("ix_resource_suggestions_chw_id", table_name="resource_suggestions")
    op.drop_table("resource_suggestions")

    op.drop_index("ix_resources_created_at", table_name="resources")
    op.drop_index("ix_resources_zip_code", table_name="resources")
    op.drop_index("ix_resources_status", table_name="resources")
    op.drop_index("ix_resources_category", table_name="resources")
    op.drop_index("ix_resources_name", table_name="resources")
    op.drop_table("resources")

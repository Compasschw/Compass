"""add target_chw_id + target_expires_at to service_requests

Revision ID: d4e5f6a7b8c9
Revises: c3d4e5f6a7b8
Create Date: 2026-05-18

Backs the "Schedule with Jemal" → CHW-exclusive 24h window product flow.
When a member submits the schedule-session questionnaire targeted at a
specific CHW, the resulting service_request is stamped with:

  - target_chw_id    → the CHW the member explicitly chose
  - target_expires_at → now() + 24h

While ``target_expires_at`` is in the future, the request is visible
ONLY to that CHW (their "Request" filter on the Members page).  After
the timestamp passes, OR if the target CHW explicitly declines via
PATCH /requests/{id}/pass, the request enters the open pool and any
CHW can claim it via PATCH /requests/{id}/accept.

Both columns are nullable so untargeted requests (e.g. the member-app
"general help request" flow) continue to land in the open pool as they
do today.

Index on (target_chw_id, status, target_expires_at) speeds up the CHW
inbox query "WHERE target_chw_id = me AND status='open' AND
target_expires_at > now()".
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d4e5f6a7b8c9"
down_revision: str | None = "c3d4e5f6a7b8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "service_requests",
        sa.Column(
            "target_chw_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=True,
        ),
    )
    op.add_column(
        "service_requests",
        sa.Column("target_expires_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_service_requests_chw_inbox",
        "service_requests",
        ["target_chw_id", "status", "target_expires_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_service_requests_chw_inbox", table_name="service_requests")
    op.drop_column("service_requests", "target_expires_at")
    op.drop_column("service_requests", "target_chw_id")

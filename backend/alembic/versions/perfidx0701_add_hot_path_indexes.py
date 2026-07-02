"""add hot-path indexes (auth gate + member lookups)

Adds four indexes that back frequent authorization / member-detail queries but
were missing. All are created CONCURRENTLY (non-locking) and IF NOT EXISTS
(idempotent / safe to re-run), so this migration neither locks a table nor
fails if an index was added out-of-band. No behavior change — pure performance.

  - service_requests(matched_chw_id, member_id): backs the CHW↔member
    relationship gate hit on nearly every CHW-facing request.
  - billing_claims(member_id, created_at DESC): admin member-detail claim lookup.
  - member_consents(member_id, consent_type): consent resolution on member detail.
  - journey_templates(name): canonical-template name lookup in the reconciler.

Revision ID: perfidx0701
Revises: memclose3006
Create Date: 2026-07-01

"""
from __future__ import annotations

from alembic import op

# revision identifiers, used by Alembic.
revision = "perfidx0701"
down_revision = "memclose3006"
branch_labels = None
depends_on = None


# CREATE/DROP INDEX CONCURRENTLY cannot run inside a transaction, so each
# statement runs in its own autocommit block.
_INDEXES: list[tuple[str, str]] = [
    (
        "ix_service_requests_matched_chw_id",
        "service_requests (matched_chw_id, member_id)",
    ),
    (
        "ix_billing_claims_member_id",
        "billing_claims (member_id, created_at DESC)",
    ),
    (
        "ix_member_consents_member_type",
        "member_consents (member_id, consent_type)",
    ),
    (
        "ix_journey_templates_name",
        "journey_templates (name)",
    ),
]


def upgrade() -> None:
    with op.get_context().autocommit_block():
        for name, target in _INDEXES:
            op.execute(f"CREATE INDEX CONCURRENTLY IF NOT EXISTS {name} ON {target}")


def downgrade() -> None:
    with op.get_context().autocommit_block():
        for name, _ in reversed(_INDEXES):
            op.execute(f"DROP INDEX CONCURRENTLY IF EXISTS {name}")

"""Revoke UPDATE / DELETE on append-only PHI tables.

Compass dev guardrail #5 (backend rule): the application DB role must not be
able to mutate or remove rows from append-only PHI / audit tables. Any UPDATE
or DELETE against these tables in production is, by definition, evidence of
either an integrity bug in the app or a compromise; both should fail at the
database tier rather than succeed silently.

Tables locked down here:
    - audit_logs                 (every PHI access is appended; never edited)
    - communication_touches      (CHW outreach attempts; auditable trail)
    - member_assessment_response (per-question answers from member assessments)

The REVOKE is applied to the role named in the ``DATABASE_URL`` (typically
``compass`` in compose, the RDS user in production). The migration looks up
``current_user`` at runtime so it works against any environment without a
hardcoded role name. Superuser sessions (alembic upgrades, manual psql) keep
full privileges and so are unaffected.

Idempotent: re-running on a database where the privileges are already gone is
a no-op. The down-migration restores the privileges so a rollback returns the
schema to the same shape it had before this migration ran.

Revision ID: a1b2c3d4e5f6
Revises: z9w3x4y5a6b7
Created: 2026-05-14
"""
from __future__ import annotations

from alembic import op


revision: str = "a1b2c3d4e5f6"
down_revision: str = "z9w3x4y5a6b7"
branch_labels: str | None = None
depends_on: str | None = None


_PHI_APPEND_ONLY_TABLES: tuple[str, ...] = (
    "audit_logs",
    "communication_touches",
    "member_assessment_response",
)


def upgrade() -> None:
    """REVOKE UPDATE, DELETE on append-only PHI tables from the app role."""
    bind = op.get_bind()
    # ``current_user`` returns the role used by the connection running this
    # migration. In our setup that's the same role the FastAPI app uses
    # (``compass`` locally, the RDS app user in production).
    role = bind.execute(_text("SELECT current_user")).scalar()
    for table in _PHI_APPEND_ONLY_TABLES:
        # ``IF EXISTS``-style guard: skip cleanly when a table hasn't been
        # created yet in a fresh dev DB (e.g. partial migration history).
        exists = bind.execute(
            _text(
                "SELECT 1 FROM information_schema.tables "
                "WHERE table_schema = 'public' AND table_name = :t"
            ),
            {"t": table},
        ).scalar()
        if not exists:
            continue
        op.execute(f'REVOKE UPDATE, DELETE ON TABLE "{table}" FROM "{role}"')


def downgrade() -> None:
    """Restore UPDATE, DELETE on the affected tables."""
    bind = op.get_bind()
    role = bind.execute(_text("SELECT current_user")).scalar()
    for table in _PHI_APPEND_ONLY_TABLES:
        exists = bind.execute(
            _text(
                "SELECT 1 FROM information_schema.tables "
                "WHERE table_schema = 'public' AND table_name = :t"
            ),
            {"t": table},
        ).scalar()
        if not exists:
            continue
        op.execute(f'GRANT UPDATE, DELETE ON TABLE "{table}" TO "{role}"')


def _text(sql: str):
    """Local import so this module is importable without sqlalchemy at parse time."""
    from sqlalchemy import text

    return text(sql)

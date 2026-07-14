"""add_users_phone_unique_index

QA-batch #1 — CHW phone uniqueness.

Schema changes:
  - Partial UNIQUE index on users.phone (WHERE phone IS NOT NULL) so no two
    accounts — of any role — can share a normalized phone number. NULL
    phones are excluded from the constraint (phone is optional at signup),
    so any number of accounts may still have no phone on file.

Application-layer enforcement (app/services/auth_service.register_user)
already rejects a duplicate phone with a clean 409 before this index would
ever be hit in the common (non-racing) case — this index is the race-safe
backstop for two concurrent requests that both pass the in-app pre-check
before either commits.

Defensive upgrade (fail-loud, no silent data loss): prod is expected to have
only a handful of users, but if any pre-existing duplicate normalized phones
already exist, blindly creating the unique index would either fail with an
opaque IntegrityError or (worse, if someone had NULLed one out ahead of time)
silently discard data. Instead, upgrade() explicitly SELECTs for existing
duplicates first and raises a clear, actionable error naming the offending
phone values so an operator can manually resolve them (deduping is a
product/support decision — which account keeps the number — not something
this migration should decide unilaterally). No backfill/de-dupe is performed
here.

Revision ID: chwphone0713
Revises: chwcompl0713
"""

from sqlalchemy import text

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "chwphone0713"
down_revision: str | None = "e076debdebe5"
branch_labels = None
depends_on = None

_INDEX_NAME = "uq_users_phone_not_null"


def upgrade() -> None:
    connection = op.get_bind()

    # Fail loud on pre-existing duplicates rather than let CREATE UNIQUE
    # INDEX CONCURRENTLY-equivalent surface an opaque IntegrityError, or
    # (worse) silently corrupt data via an implicit de-dupe. Phones are
    # already stored normalized (E.164) by every write path
    # (app.services.auth_service.register_user), so a raw column-value
    # comparison is sufficient here — no re-normalization needed.
    duplicates = connection.execute(
        text(
            """
            SELECT phone, COUNT(*) AS cnt
            FROM users
            WHERE phone IS NOT NULL
            GROUP BY phone
            HAVING COUNT(*) > 1
            """
        )
    ).fetchall()
    if duplicates:
        offending = ", ".join(f"{row.phone} (x{row.cnt})" for row in duplicates)
        raise RuntimeError(
            "Cannot add unique index on users.phone — duplicate phone "
            f"numbers already exist: {offending}. Resolve these manually "
            "(decide which account keeps the number, NULL out or "
            "re-collect the phone on the others) before re-running this "
            "migration."
        )

    op.create_index(
        _INDEX_NAME,
        "users",
        ["phone"],
        unique=True,
        postgresql_where=text("phone IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index(_INDEX_NAME, table_name="users")

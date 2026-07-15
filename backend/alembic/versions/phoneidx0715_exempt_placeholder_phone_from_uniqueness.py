"""exempt the 555-555-5555 placeholder phone from users.phone uniqueness

QA feedback batch (2026-07-14), Part 3 — phone uniqueness stays platform-wide
for every REAL phone number (QA-batch #1 / migration ``chwphone0713`` is
unchanged in spirit), but the 555-555-5555 placeholder sentinel (CHWs enter
it when a member has no phone of their own) may now be reused on any number
of accounts.

Schema changes:
  - Drop ``uq_users_phone_not_null``.
  - Recreate it with an additional WHERE clause excluding the sentinel value
    ``+15555555555``, so any number of accounts may share that one specific
    phone value while every other non-null phone remains globally unique.

Application-layer enforcement (``app.services.auth_service.register_user``)
already skips the duplicate-phone pre-check for the sentinel — this index
change is the DB-layer mirror (and race-safe backstop) of that behavior,
matching the same "app check first, index second" pattern
``chwphone0713``/``register_user`` established.

No fail-loud duplicate check is needed here (unlike ``chwphone0713``'s
original creation of this index): the EXISTING unique index already
guarantees at most one row currently holds any given phone value, including
the sentinel — so widening the WHERE clause to exempt one specific value can
never surface a pre-existing collision. This migration only ever makes the
constraint MORE permissive, never less.

Revision ID: phoneidx0715
Revises: smsnotif0714
"""

from sqlalchemy import text

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "phoneidx0715"
down_revision: str | None = "smsnotif0714"
branch_labels = None
depends_on = None

_INDEX_NAME = "uq_users_phone_not_null"
_PLACEHOLDER_PHONE = "+15555555555"


def upgrade() -> None:
    op.drop_index(_INDEX_NAME, table_name="users")
    op.create_index(
        _INDEX_NAME,
        "users",
        ["phone"],
        unique=True,
        postgresql_where=text(
            f"phone IS NOT NULL AND phone != '{_PLACEHOLDER_PHONE}'"
        ),
    )


def downgrade() -> None:
    # Downgrading re-tightens the constraint to the pre-Part-3 shape. If more
    # than one account currently holds the placeholder phone (expected —
    # that's the entire point of this migration), the CREATE UNIQUE INDEX
    # below will fail with an IntegrityError naming the offending rows,
    # exactly like chwphone0713's original fail-loud behavior. That's
    # intentional: a downgrade must never silently discard the multiple
    # placeholder-phone accounts this migration was designed to permit —
    # an operator must explicitly resolve them first (NULL out all but one,
    # or accept the downgrade is not safe to run).
    op.drop_index(_INDEX_NAME, table_name="users")
    op.create_index(
        _INDEX_NAME,
        "users",
        ["phone"],
        unique=True,
        postgresql_where=text("phone IS NOT NULL"),
    )

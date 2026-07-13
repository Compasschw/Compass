"""add first_login_at to users

Adds a nullable ``first_login_at`` timestamptz column to ``users``, capturing
the timestamp of the user's FIRST successful authentication (self-service
``/auth/register`` auto-login, ``/auth/login``, or an OAuth sign-in).

Why this is needed
-------------------
The CHW Members-page status rule (Epic G3) must show a CHW-created member as
'inactive' until that member has actually signed in themselves — a CHW
provisioning the account (``POST /chw/members``) and handing over a temp
password out-of-band does NOT count as the member having signed in. Prior to
this column there was no such signal on the ``User`` row at all, so status was
derived purely from session/service-request activity, which is why a
freshly-matched-but-never-logged-in member could still show 'active' (or,
depending on the surrounding activity window, get stuck 'inactive' forever
even after the member DID sign in — the exact bug this column fixes).

Backfill (existing rows)
-------------------------
NULLABLE + additive, so no backfill is strictly required for the column to be
usable. However, to avoid *regressing* every pre-existing member to
'inactive' the instant this migration deploys (most of them HAVE signed in
before — we just never recorded when), we backfill:

    first_login_at = last_active_at   WHERE first_login_at IS NULL
                                         AND last_active_at IS NOT NULL

``last_active_at`` is bumped (throttled) on every authenticated request in
``get_current_user`` (see ``perfidx0701``), so a non-null ``last_active_at``
is direct proof the user has, at minimum, made one authenticated call in the
past — i.e. they have signed in at least once. This is an approximation (the
backfilled timestamp is their most recent activity, not their literal first
login), but it's the only presence signal available pre-migration and it
correctly preserves 'active' status for the CHW's existing signed-in
caseload. Members who have NEVER been active (``last_active_at IS NULL`` —
this includes every CHW-created member still waiting on the member to log in
for the first time) are intentionally left NULL, which is exactly the
'inactive until first sign-in' state Epic G3 wants for them.

Revision ID: flogn0712
Revises: c0n5ent0701
Create Date: 2026-07-12 00:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "flogn0712"
down_revision: Union[str, None] = "c0n5ent0701"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("first_login_at", sa.DateTime(timezone=True), nullable=True),
    )
    # Backfill: treat "has been active before" as "has signed in before" so
    # existing members with recorded activity don't regress to 'inactive'.
    # See module docstring for the full rationale.
    op.execute(
        """
        UPDATE users
        SET first_login_at = last_active_at
        WHERE first_login_at IS NULL
          AND last_active_at IS NOT NULL
        """
    )


def downgrade() -> None:
    op.drop_column("users", "first_login_at")

"""add must_change_password to users

Adds a non-nullable ``must_change_password`` boolean column to ``users``,
defaulting to ``false``.

Why this is needed (Epic G2 — first-login password change)
-------------------------------------------------------------
When a CHW creates a member account (``POST /chw/members`` →
``create_chw_member`` in ``routers/chw.py``), the CHW supplies a temporary
password and shares it with the member out-of-band. On the member's first
sign-in they must be prompted to replace it with a password only they know.
Self-registered members (``/auth/register``, OAuth sign-up) chose their own
password (or have none, for OAuth) and must NOT be prompted.

This is intentionally a SEPARATE column from ``first_login_at`` (added in
``flogn0712`` for Epic G3): ``first_login_at`` records *whether* the user has
ever authenticated (drives the CHW roster's active/inactive status),
whereas ``must_change_password`` records whether the CURRENT password is
still the CHW-assigned temporary one. The two are correlated for
CHW-created members but are not the same signal — e.g. a member could sign
in once (stamping ``first_login_at``) via a flow that fails to change the
password, and should still be re-prompted.

Backfill
--------
NOT NULL with ``server_default='false'`` — every pre-existing row (which by
definition was created before this flag existed, i.e. before the mandatory
first-login prompt could ever have fired) is safely backfilled to ``false``:
no existing user should be retroactively forced into a password-change
prompt they were never warned about. The column is write-once-per-member
going forward — set ``true`` only at CHW-member-creation time.

Revision ID: mustchg0712
Revises: flogn0712
Create Date: 2026-07-12 00:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "mustchg0712"
down_revision: Union[str, None] = "flogn0712"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "must_change_password",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )


def downgrade() -> None:
    op.drop_column("users", "must_change_password")

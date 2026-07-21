"""google_calendar_credentials table + calendar_events google-sync columns

Google Calendar sync (server-side, one-way Compass → Google push).

Adds:
  * ``google_calendar_credentials`` — one row per user holding the encrypted
    Google OAuth **refresh token** (AES-256-GCM via ``EncryptedString``), the
    granted scopes, and the connected Google account email. UNIQUE ``user_id``
    (at most one connected calendar per user); FK cascade-deletes with the user.
  * ``calendar_events.google_event_id`` + ``calendar_events.google_synced_at`` —
    nullable columns that record which Google event mirrors each Compass
    calendar row and when it last synced. Both NULL for every existing row and
    for any user who hasn't connected a calendar — no backfill required.

Single head after this migration: ``gcalsync0721``.

Revision ID: gcalsync0721
Revises: chw2fa0715
"""

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "gcalsync0721"
down_revision = "chw2fa0715"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "google_calendar_credentials",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # EncryptedString stores base64(nonce||ciphertext||tag) in a VARCHAR(512).
        sa.Column("refresh_token", sa.String(512), nullable=False),
        sa.Column("scope", sa.String(255), nullable=True),
        sa.Column("google_email", sa.String(255), nullable=True),
        sa.Column(
            "connected_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.UniqueConstraint("user_id", name="uq_google_calendar_credentials_user_id"),
    )
    op.create_index(
        "ix_google_calendar_credentials_user_id",
        "google_calendar_credentials",
        ["user_id"],
    )

    op.add_column(
        "calendar_events",
        sa.Column("google_event_id", sa.String(255), nullable=True),
    )
    op.add_column(
        "calendar_events",
        sa.Column("google_synced_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("calendar_events", "google_synced_at")
    op.drop_column("calendar_events", "google_event_id")
    op.drop_index(
        "ix_google_calendar_credentials_user_id",
        table_name="google_calendar_credentials",
    )
    op.drop_table("google_calendar_credentials")

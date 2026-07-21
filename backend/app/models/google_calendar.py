"""Per-user Google Calendar OAuth credential storage.

Backs the server-side, one-way (Compass → Google) calendar-sync feature. When a
user connects their Google Calendar (POST /integrations/google-calendar/connect),
Compass exchanges the OAuth authorization code for a long-lived **refresh token**
and stores exactly one row here. The refresh token is the only durable secret we
keep; access tokens are minted on demand from it (see
``app.services.google_calendar``) and never persisted.

Security:
- ``refresh_token`` uses ``EncryptedString`` (AES-256-GCM at rest) — a database
  dump never exposes usable Google credentials.
- One row per user (UNIQUE ``user_id``), FK-cascade-deleted with the user via the
  account-deletion service / ``ondelete=CASCADE``.
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.utils.encryption import EncryptedString


class GoogleCalendarCredential(Base):
    """A single user's connected-Google-Calendar credential (refresh token)."""

    __tablename__ = "google_calendar_credentials"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # UNIQUE — at most one connected Google Calendar per Compass user. A
    # re-connect upserts this row rather than inserting a second.
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
        index=True,
    )
    # The long-lived Google OAuth refresh token, encrypted at rest. String(512)
    # matches EncryptedString.impl (base64(nonce||ciphertext||tag)).
    refresh_token: Mapped[str] = mapped_column(EncryptedString(512), nullable=False)
    # Space-delimited granted scopes returned by Google's token endpoint. Stored
    # for auditability / to detect a downgraded grant on re-connect.
    scope: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # The Google account email the calendar belongs to (from the id_token /
    # userinfo). Surfaced by GET /status so the UI can show "Connected as …".
    google_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    connected_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

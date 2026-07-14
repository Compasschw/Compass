"""Password reset token for the forgot-password flow.

Flow:
1. User requests a reset → POST /auth/password-reset/request
2. We generate a cryptographically-random token, hash it, store the hash
3. Email the raw token to the user as a link:
   https://joincompasschw.com/auth/reset-password?token=...
4. User taps the link → app's reset-password screen calls
   POST /auth/password-reset/confirm with the token + a new password
5. We look up the hash, check expiry + single-use, set the new password hash,
   and revoke every outstanding refresh token for the account (signs the
   user out of all devices — a password reset is a strong signal the old
   session material should not be trusted).

Design notes (deliberately mirrors ``app.models.magic_link.MagicLinkToken`` —
same threat model, same mitigations):
- We store only the SHA-256 hash of the token (same pattern as refresh
  tokens and magic-link tokens) — the raw token is a bearer credential and
  must never be persisted or logged.
- Single-use: ``consumed_at`` is set on a successful confirm; subsequent
  attempts fail with the same generic 401 used for unknown/expired tokens
  (no information leakage about *why* a token didn't work).
- Short TTL (30 min default) — tokens expire quickly to limit the window a
  stolen email (or an email sent to the wrong inbox) can be abused.
- Newest-link-only: requesting a new reset link consumes any prior
  outstanding token for the same user, so only the most recently requested
  link is ever valid.
- Rate limited at both the request and confirm endpoints to blunt spam and
  brute-force guessing.
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class PasswordResetToken(Base):
    __tablename__ = "password_reset_tokens"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)
    token_hash: Mapped[str] = mapped_column(String(128), nullable=False, unique=True, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ip_address: Mapped[str | None] = mapped_column(String(45))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

"""Magic link token for passwordless email login.

Flow:
1. User enters email → POST /auth/magic/request
2. We generate a cryptographically-random token, hash it, store the hash
3. Email the raw token to the user as a link: https://joincompasschw.com/auth/magic?token=...
4. User taps the link → mobile app deep-link handler calls POST /auth/magic/verify
5. We look up the hash, check expiry + single-use, and issue JWT tokens

Design notes:
- We store only the SHA-256 hash of the token (same pattern as refresh tokens)
- Single-use: `consumed_at` is set on first verify; subsequent attempts fail
- Short TTL (15 min default) — tokens expire quickly to limit stolen-email risk
- Rate limit at the request endpoint to prevent email spam + enumeration
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class MagicLinkToken(Base):
    __tablename__ = "magic_link_tokens"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)
    token_hash: Mapped[str] = mapped_column(String(128), nullable=False, unique=True, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ip_address: Mapped[str | None] = mapped_column(String(45))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

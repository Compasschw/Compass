"""SQLAlchemy model for admin TOTP secrets.

One row per named admin slot (slot "default" for the single operator set).
The TOTP shared secret is stored encrypted at rest using AES-256-GCM via
``app.utils.security.encrypt_field`` / ``decrypt_field`` — the same mechanism
used for field-level PHI encryption.

The slot-based design allows multiple named admin accounts in the future
without a schema change.
"""

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class AdminTotpSecret(Base):
    """Stores the encrypted TOTP shared secret for an admin slot."""

    __tablename__ = "admin_totp_secrets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)

    # Logical admin slot name — "default" for the single production admin.
    name: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)

    # AES-256-GCM encrypted TOTP secret (base64-encoded "<nonce>:<ciphertext>").
    # Plain-text value is a 20-byte TOTP secret (pyotp.random_base32() output).
    # Never log or expose this column directly.
    encrypted_secret: Mapped[str] = mapped_column(Text, nullable=False)

    # Becomes True after the operator has successfully verified their first code.
    # Unverified secrets can be regenerated; verified ones cannot (security invariant).
    is_verified: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

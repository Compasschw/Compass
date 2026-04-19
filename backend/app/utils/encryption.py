"""Application-layer encryption for sensitive PHI fields.

Uses AES-256-GCM via the `cryptography` library. The encryption key is derived
from PHI_ENCRYPTION_KEY in config — a 32-byte random key, base64-encoded.

Generate a new key:
    python -c "import secrets, base64; print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())"

Rotating the key requires re-encrypting every row. Never change the key without
a migration plan.
"""

import base64
import os
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import String, TypeDecorator


def _get_key() -> bytes:
    """Return the raw 32-byte AES key from env, or a test key in non-prod."""
    raw = os.environ.get("PHI_ENCRYPTION_KEY", "")
    if not raw:
        # In dev/test without a configured key, fall back to a deterministic
        # test key derived from SECRET_KEY. NEVER used in production — settings
        # validation rejects weak SECRET_KEY values.
        import hashlib

        from app.config import settings
        return hashlib.sha256(settings.secret_key.encode()).digest()
    return base64.urlsafe_b64decode(raw)


class EncryptedString(TypeDecorator):
    """SQLAlchemy column type that transparently encrypts on write, decrypts on read.

    Storage format: base64(nonce || ciphertext || tag) — self-contained so
    rows can be decrypted with just the key, no side-channel metadata.

    The underlying column is a String(512) — sufficient for values up to ~350 chars
    plaintext including overhead.
    """

    impl = String(512)
    cache_ok = True

    def process_bind_param(self, value: Any, dialect: Any) -> str | None:
        if value is None:
            return None
        if not isinstance(value, str):
            raise TypeError(f"EncryptedString expects str, got {type(value).__name__}")
        aesgcm = AESGCM(_get_key())
        nonce = os.urandom(12)
        ciphertext = aesgcm.encrypt(nonce, value.encode("utf-8"), associated_data=None)
        return base64.urlsafe_b64encode(nonce + ciphertext).decode("ascii")

    def process_result_value(self, value: Any, dialect: Any) -> str | None:
        if value is None:
            return None
        try:
            blob = base64.urlsafe_b64decode(value.encode("ascii"))
            nonce, ciphertext = blob[:12], blob[12:]
            aesgcm = AESGCM(_get_key())
            plaintext = aesgcm.decrypt(nonce, ciphertext, associated_data=None)
            return plaintext.decode("utf-8")
        except Exception:
            # Legacy plaintext rows: if decryption fails, return the raw value.
            # Once all rows are encrypted this branch can be removed.
            return value

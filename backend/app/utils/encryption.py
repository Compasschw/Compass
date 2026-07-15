"""Application-layer encryption for sensitive PHI fields.

Uses AES-256-GCM via the `cryptography` library. The encryption key is derived
from PHI_ENCRYPTION_KEY in config — a 32-byte random key, base64-encoded.

Generate a new key:
    python -c "import secrets, base64; print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())"

Rotating the key requires re-encrypting every row. Never change the key without
a migration plan.
"""

import base64
import hashlib
import hmac
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
        from app.config import settings
        return hashlib.sha256(settings.secret_key.encode()).digest()
    return base64.urlsafe_b64decode(raw)


def _get_cin_hmac_key() -> bytes:
    """Derive a key for the CIN uniqueness digest, distinct from the AES key.

    Domain-separated from ``_get_key()`` (via a fixed, versioned suffix
    hashed together with the encryption key) so a compromise of one digest
    scheme doesn't directly expose key material usable against the other.
    Deterministic — the same PHI_ENCRYPTION_KEY always derives the same HMAC
    key, which is required for ``hash_cin`` to be stable across processes
    and deploys (see ``member_profiles.medi_cal_id_hash``).
    """
    return hashlib.sha256(_get_key() + b"compass-cin-hash-v1").digest()


def hash_cin(normalized_cin: str) -> str:
    """Deterministic HMAC-SHA256 digest of an already-normalized CIN.

    Used for ``member_profiles.medi_cal_id_hash`` — a uniqueness digest for
    the CIN, which itself is stored via ``EncryptedString`` (AES-256-GCM with
    a random nonce per row, so identical plaintext CINs produce different
    ciphertext and can never be compared or indexed directly). HMAC (keyed,
    not a plain SHA-256) so a leaked database dump can't be brute-forced
    against the small CIN keyspace (CINs are ~10 alphanumeric characters —
    trivially rainbow-tableable with an unkeyed hash).

    Args:
        normalized_cin: The CIN AFTER ``app.schemas.cin_config.normalize_cin``
            has been applied (trimmed, uppercased, spaces/hyphens stripped,
            BIC-extracted). Callers MUST normalize first — this function does
            not normalize, so two callers passing differently-cased/formatted
            raw input for the "same" CIN would silently produce different,
            non-colliding digests, defeating the uniqueness check.

    Returns:
        A 64-character lowercase hex digest, stable for the lifetime of
        PHI_ENCRYPTION_KEY (rotating the key invalidates all previously
        stored digests — same operational caveat as the AES key itself, see
        the module docstring above).
    """
    mac = hmac.new(_get_cin_hmac_key(), normalized_cin.encode("utf-8"), hashlib.sha256)
    return mac.hexdigest()


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

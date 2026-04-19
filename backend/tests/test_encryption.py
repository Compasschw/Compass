"""Tests for the EncryptedString TypeDecorator used on PHI columns."""

import pytest

from app.utils.encryption import EncryptedString


class TestEncryptedString:
    def test_roundtrip(self):
        """A value written and read back should match the original."""
        ec = EncryptedString()
        plaintext = "123456789-MEDI-CAL-ID"
        encrypted = ec.process_bind_param(plaintext, None)
        decrypted = ec.process_result_value(encrypted, None)
        assert decrypted == plaintext

    def test_none_passthrough_on_write(self):
        ec = EncryptedString()
        assert ec.process_bind_param(None, None) is None

    def test_none_passthrough_on_read(self):
        ec = EncryptedString()
        assert ec.process_result_value(None, None) is None

    def test_non_string_raises(self):
        """Passing a non-string should raise — we don't silently coerce."""
        ec = EncryptedString()
        with pytest.raises(TypeError):
            ec.process_bind_param(123, None)

    def test_nondeterministic_ciphertext(self):
        """Encrypting the same value twice should produce different ciphertexts
        (because a new random nonce is generated each time). This prevents
        inference attacks on the DB."""
        ec = EncryptedString()
        plaintext = "same-value"
        c1 = ec.process_bind_param(plaintext, None)
        c2 = ec.process_bind_param(plaintext, None)
        assert c1 != c2
        assert ec.process_result_value(c1, None) == plaintext
        assert ec.process_result_value(c2, None) == plaintext

    def test_legacy_plaintext_fallback(self):
        """Rows written before encryption was enabled should still be readable.
        The fallback returns the raw value on decrypt failure."""
        ec = EncryptedString()
        legacy_value = "already-plaintext-from-old-row"
        assert ec.process_result_value(legacy_value, None) == legacy_value

    def test_empty_string_roundtrip(self):
        ec = EncryptedString()
        assert ec.process_result_value(ec.process_bind_param("", None), None) == ""

    def test_unicode_roundtrip(self):
        """PHI can include non-ASCII (names with accents, etc)."""
        ec = EncryptedString()
        plaintext = "José María O'Brien-Müller"
        encrypted = ec.process_bind_param(plaintext, None)
        assert ec.process_result_value(encrypted, None) == plaintext

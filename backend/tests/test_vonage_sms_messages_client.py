"""Unit tests for app.services.vonage_sms — the Messages API SMS send client.

Covers the client's internals directly (JWT minting, configured/unconfigured
branches, httpx success/failure handling) since the router-level integration
tests (tests/test_sms_messaging.py) exercise this client mostly in stub mode
(Vonage unconfigured in the test env, matching the existing call-bridge test
convention) plus one end-to-end failure case via a mocked send_text. These
tests fill in the client's own real-path branches: a configured client
minting a JWT and calling the Messages API via httpx.
"""

import time
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from app.services.vonage_sms import (
    VonageSmsMessagesClient,
    get_our_sms_numbers,
    get_sms_from_number,
)


# ─── get_sms_from_number / get_our_sms_numbers (pool-ready seam) ──────────────


def test_get_sms_from_number_prefers_sms_number_over_voice_number():
    import app.config as _app_cfg

    original = _app_cfg.settings
    _app_cfg.settings = type(
        "_S", (), {"vonage_sms_number": "18885551111", "vonage_from_number": "18005552222"}
    )()
    try:
        assert get_sms_from_number() == "18885551111"
    finally:
        _app_cfg.settings = original


def test_get_sms_from_number_falls_back_to_voice_number_when_sms_number_unset():
    import app.config as _app_cfg

    original = _app_cfg.settings
    _app_cfg.settings = type(
        "_S", (), {"vonage_sms_number": "", "vonage_from_number": "18005552222"}
    )()
    try:
        assert get_sms_from_number() == "18005552222"
    finally:
        _app_cfg.settings = original


def test_get_our_sms_numbers_returns_nonempty_configured_numbers():
    import app.config as _app_cfg

    original = _app_cfg.settings
    _app_cfg.settings = type(
        "_S", (), {"vonage_sms_number": "18885551111", "vonage_from_number": "18005552222"}
    )()
    try:
        assert get_our_sms_numbers() == frozenset({"18885551111", "18005552222"})
    finally:
        _app_cfg.settings = original


def test_get_our_sms_numbers_empty_when_unconfigured():
    import app.config as _app_cfg

    original = _app_cfg.settings
    _app_cfg.settings = type("_S", (), {"vonage_sms_number": "", "vonage_from_number": ""})()
    try:
        assert get_our_sms_numbers() == frozenset()
    finally:
        _app_cfg.settings = original


# ─── is_configured ──────────────────────────────────────────────────────────────


def test_is_configured_false_when_missing_application_id():
    import app.config as _app_cfg

    original = _app_cfg.settings
    _app_cfg.settings = type(
        "_S", (), {"vonage_sms_number": "18005551234", "vonage_from_number": ""}
    )()
    try:
        client = VonageSmsMessagesClient(application_id="", private_key_path="/tmp/key.pem")
        assert client.is_configured() is False
    finally:
        _app_cfg.settings = original


def test_is_configured_true_when_all_present(tmp_path):
    import app.config as _app_cfg

    key_path = tmp_path / "key.pem"
    key_path.write_bytes(b"fake-key-bytes")

    original = _app_cfg.settings
    _app_cfg.settings = type(
        "_S", (), {"vonage_sms_number": "18005551234", "vonage_from_number": ""}
    )()
    try:
        client = VonageSmsMessagesClient(application_id="app-id", private_key_path=str(key_path))
        assert client.is_configured() is True
    finally:
        _app_cfg.settings = original


# ─── send_text: stub mode (unconfigured) ───────────────────────────────────────


@pytest.mark.asyncio
async def test_send_text_stub_mode_when_unconfigured():
    import app.config as _app_cfg

    original = _app_cfg.settings
    _app_cfg.settings = type("_S", (), {"vonage_sms_number": "", "vonage_from_number": ""})()
    try:
        client = VonageSmsMessagesClient(application_id="", private_key_path="")
        result = await client.send_text("+13105551234", "hello")
    finally:
        _app_cfg.settings = original

    assert result.success is True
    assert result.provider_message_id is not None
    assert result.provider_message_id.startswith("vonage-sms-placeholder-")


# ─── _mint_jwt ──────────────────────────────────────────────────────────────────


def test_mint_jwt_returns_none_when_key_file_missing(tmp_path):
    client = VonageSmsMessagesClient(
        application_id="app-id", private_key_path=str(tmp_path / "does-not-exist.pem")
    )
    assert client._mint_jwt() is None


def test_mint_jwt_succeeds_with_valid_rsa_key(tmp_path):
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    key_path = tmp_path / "key.pem"
    key_path.write_bytes(pem)

    client = VonageSmsMessagesClient(application_id="app-id-123", private_key_path=str(key_path))
    token = client._mint_jwt()
    assert token is not None

    from jose import jwt as jose_jwt

    claims = jose_jwt.get_unverified_claims(token)
    assert claims["application_id"] == "app-id-123"
    assert claims["exp"] > int(time.time())


def test_mint_jwt_returns_none_on_signing_error(tmp_path):
    # A key file that exists but contains garbage — jose_jwt.encode raises.
    key_path = tmp_path / "bad-key.pem"
    key_path.write_bytes(b"not a real private key")

    client = VonageSmsMessagesClient(application_id="app-id", private_key_path=str(key_path))
    assert client._mint_jwt() is None


# ─── send_text: configured, mocked httpx transport ─────────────────────────────


def _configured_client(tmp_path) -> VonageSmsMessagesClient:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    key_path = tmp_path / "key.pem"
    key_path.write_bytes(pem)
    return VonageSmsMessagesClient(application_id="app-id-123", private_key_path=str(key_path))


@pytest.mark.asyncio
async def test_send_text_success_returns_provider_message_id(tmp_path):
    import app.config as _app_cfg

    original = _app_cfg.settings
    _app_cfg.settings = type(
        "_S", (), {"vonage_sms_number": "18005551234", "vonage_from_number": ""}
    )()
    client = _configured_client(tmp_path)

    mock_response = MagicMock()
    mock_response.status_code = 202
    mock_response.json.return_value = {"message_uuid": "abc-123-uuid"}
    mock_response.text = ""

    mock_async_client = AsyncMock()
    mock_async_client.post = AsyncMock(return_value=mock_response)
    mock_async_client.__aenter__ = AsyncMock(return_value=mock_async_client)
    mock_async_client.__aexit__ = AsyncMock(return_value=False)

    try:
        with patch("httpx.AsyncClient", return_value=mock_async_client):
            result = await client.send_text("+13105551234", "Hello member")
    finally:
        _app_cfg.settings = original

    assert result.success is True
    assert result.provider_message_id == "abc-123-uuid"
    assert result.status_code == 202

    # Verify the payload shape sent to Vonage (Messages API contract).
    call_kwargs = mock_async_client.post.call_args
    assert call_kwargs.args[0] == "https://api.nexmo.com/v1/messages"
    sent_payload = call_kwargs.kwargs["json"]
    assert sent_payload["message_type"] == "text"
    assert sent_payload["channel"] == "sms"
    assert sent_payload["to"] == "13105551234"  # digits only, no '+'
    assert sent_payload["text"] == "Hello member"


@pytest.mark.asyncio
async def test_send_text_non_2xx_status_returns_failure(tmp_path):
    import app.config as _app_cfg

    original = _app_cfg.settings
    _app_cfg.settings = type(
        "_S", (), {"vonage_sms_number": "18005551234", "vonage_from_number": ""}
    )()
    client = _configured_client(tmp_path)

    mock_response = MagicMock()
    mock_response.status_code = 429
    mock_response.text = "Too Many Requests"

    mock_async_client = AsyncMock()
    mock_async_client.post = AsyncMock(return_value=mock_response)
    mock_async_client.__aenter__ = AsyncMock(return_value=mock_async_client)
    mock_async_client.__aexit__ = AsyncMock(return_value=False)

    try:
        with patch("httpx.AsyncClient", return_value=mock_async_client):
            result = await client.send_text("+13105551234", "Hello member")
    finally:
        _app_cfg.settings = original

    assert result.success is False
    assert result.status_code == 429
    assert result.error == "vonage_status_429"


@pytest.mark.asyncio
async def test_send_text_network_error_returns_failure(tmp_path):
    import app.config as _app_cfg

    original = _app_cfg.settings
    _app_cfg.settings = type(
        "_S", (), {"vonage_sms_number": "18005551234", "vonage_from_number": ""}
    )()
    client = _configured_client(tmp_path)

    mock_async_client = AsyncMock()
    mock_async_client.post = AsyncMock(side_effect=httpx.ConnectTimeout("timed out"))
    mock_async_client.__aenter__ = AsyncMock(return_value=mock_async_client)
    mock_async_client.__aexit__ = AsyncMock(return_value=False)

    try:
        with patch("httpx.AsyncClient", return_value=mock_async_client):
            result = await client.send_text("+13105551234", "Hello member")
    finally:
        _app_cfg.settings = original

    assert result.success is False
    assert result.error is not None
    assert "network_error" in result.error


@pytest.mark.asyncio
async def test_send_text_jwt_mint_failure_returns_failure_without_network_call(tmp_path):
    import app.config as _app_cfg

    original = _app_cfg.settings
    _app_cfg.settings = type(
        "_S", (), {"vonage_sms_number": "18005551234", "vonage_from_number": ""}
    )()
    # Configured (paths present) but the key file contents are garbage, so
    # _mint_jwt() returns None and send_text must short-circuit before ever
    # constructing an httpx client.
    key_path = tmp_path / "bad-key.pem"
    key_path.write_bytes(b"not a real key")
    client = VonageSmsMessagesClient(application_id="app-id", private_key_path=str(key_path))

    try:
        with patch("httpx.AsyncClient") as mock_client_cls:
            result = await client.send_text("+13105551234", "Hello member")
            mock_client_cls.assert_not_called()
    finally:
        _app_cfg.settings = original

    assert result.success is False
    assert result.error == "jwt_mint_failed"

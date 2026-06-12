"""Tests for the Pear Suite webhook receiver security boundary.

Audit 2026-06-12 blocker #3: the receiver previously accepted any
unauthenticated POST and logged the raw body. These tests pin the hardened
contract:

- 401 for every request while no webhook secret is configured.
- 401 when the signature header is missing or wrong.
- 200 (received, not applied) only with a valid HMAC-SHA256 signature.
- The request body never appears in log output.
"""

import hashlib
import hmac
from unittest.mock import patch

import pytest
from httpx import AsyncClient

_WEBHOOK_URL = "/api/v1/webhooks/pear-suite"
_SECRET = "test-webhook-secret"
_BODY = b'{"type": "claim.paid", "data": {"claim": {"id": "claim-123"}}}'


def _sign(body: bytes, secret: str = _SECRET) -> str:
    return hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()


@pytest.mark.asyncio
async def test_rejects_when_no_secret_configured(client: AsyncClient):
    """With pear_suite_webhook_secret unset, every POST must 401."""
    with patch("app.routers.pear_webhook.settings.pear_suite_webhook_secret", ""):
        res = await client.post(_WEBHOOK_URL, content=_BODY)
    assert res.status_code == 401


@pytest.mark.asyncio
async def test_rejects_missing_signature(client: AsyncClient):
    with patch("app.routers.pear_webhook.settings.pear_suite_webhook_secret", _SECRET):
        res = await client.post(_WEBHOOK_URL, content=_BODY)
    assert res.status_code == 401


@pytest.mark.asyncio
async def test_rejects_bad_signature(client: AsyncClient):
    with patch("app.routers.pear_webhook.settings.pear_suite_webhook_secret", _SECRET):
        res = await client.post(
            _WEBHOOK_URL,
            content=_BODY,
            headers={"X-Pear-Signature": _sign(_BODY, secret="wrong-secret")},
        )
    assert res.status_code == 401


@pytest.mark.asyncio
async def test_accepts_valid_signature(client: AsyncClient):
    with patch("app.routers.pear_webhook.settings.pear_suite_webhook_secret", _SECRET):
        res = await client.post(
            _WEBHOOK_URL,
            content=_BODY,
            headers={"X-Pear-Signature": _sign(_BODY)},
        )
    assert res.status_code == 200
    body = res.json()
    assert body["received"] is True
    assert body["applied"] is False


@pytest.mark.asyncio
async def test_body_is_never_logged(client: AsyncClient, caplog: pytest.LogCaptureFixture):
    """Webhook payloads are PHI-adjacent — they must not reach log output,
    on either the accepted or the rejected path."""
    secret_body = b'{"member": "PHI-SENTINEL-VALUE"}'
    with patch("app.routers.pear_webhook.settings.pear_suite_webhook_secret", _SECRET):
        with caplog.at_level("DEBUG", logger="compass.pear_webhook"):
            await client.post(
                _WEBHOOK_URL,
                content=secret_body,
                headers={"X-Pear-Signature": _sign(secret_body)},
            )
            await client.post(_WEBHOOK_URL, content=secret_body)  # rejected path
    assert "PHI-SENTINEL-VALUE" not in caplog.text

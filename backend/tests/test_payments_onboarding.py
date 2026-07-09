"""Regression tests for the CHW Stripe Connect onboarding endpoint.

Covers the guard added after the "Set up payments → dashboard" incident: when
Stripe is unconfigured (blank STRIPE_SECRET_KEY) the endpoint must fail loudly
with a 503 instead of handing back a placeholder onboarding URL that dead-ends
in the app.
"""

import pytest
from httpx import AsyncClient

from app.config import settings
from tests.conftest import auth_header


@pytest.mark.asyncio
async def test_connect_onboarding_requires_chw_role(
    client: AsyncClient, member_tokens: dict
):
    """A member (non-CHW) must not reach the payout onboarding endpoint."""
    res = await client.post(
        "/api/v1/payments/connect-onboarding",
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_connect_onboarding_503_when_stripe_unconfigured(
    client: AsyncClient, chw_tokens: dict, monkeypatch: pytest.MonkeyPatch
):
    """Blank STRIPE_SECRET_KEY → 503 with a clear message, not a fake URL."""
    monkeypatch.setattr(settings, "stripe_secret_key", "")

    res = await client.post(
        "/api/v1/payments/connect-onboarding",
        headers=auth_header(chw_tokens),
    )

    assert res.status_code == 503
    body = res.json()
    assert "payouts" in body["detail"].lower()
    # Must not have leaked a placeholder onboarding URL into the response.
    assert "placeholder" not in res.text.lower()


@pytest.mark.asyncio
async def test_connect_onboarding_not_503_when_configured(
    client: AsyncClient, chw_tokens: dict, monkeypatch: pytest.MonkeyPatch
):
    """With a key set the guard is skipped and a real onboarding link returns.

    The provider is faked so the test is deterministic and never touches
    Stripe's network API.
    """
    from types import SimpleNamespace

    import app.routers.payments as payments_router

    monkeypatch.setattr(settings, "stripe_secret_key", "sk_test_dummy")

    class _FakeProvider:
        async def create_connected_account(self, *, user_id, email):
            return SimpleNamespace(provider_account_id="acct_test_123")

        async def create_onboarding_link(
            self, *, connected_account_id, return_url, refresh_url
        ):
            return SimpleNamespace(
                url="https://connect.stripe.com/setup/acct_test_123",
                expires_at_iso="2026-07-08T00:00:00Z",
            )

    monkeypatch.setattr(
        payments_router, "get_payments_provider", lambda: _FakeProvider()
    )

    res = await client.post(
        "/api/v1/payments/connect-onboarding",
        headers=auth_header(chw_tokens),
    )

    assert res.status_code == 200
    body = res.json()
    assert body["onboarding_url"] == "https://connect.stripe.com/setup/acct_test_123"
    assert body["account_id"] == "acct_test_123"

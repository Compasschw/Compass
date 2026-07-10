"""stripe>=15 returns StripeObjects that are NOT dict-compatible.

`obj.get(...)` and `dict(obj)` raise AttributeError. The provider must serialize
via `json.loads(str(obj))` before reading fields, or the account-status and
transfer money-paths break silently. These reproduce the real StripeObject
behavior with `construct_from`.
"""

import pytest
import stripe

from app.services.payments.base import TransferRequest
from app.services.payments.stripe_provider import StripeProvider


def _provider() -> StripeProvider:
    return StripeProvider(secret_key="sk_test_dummy", webhook_secret="whsec_x")


@pytest.mark.asyncio
async def test_get_account_status_parses_stripe15_account(monkeypatch):
    provider = _provider()
    account = stripe.Account.construct_from(
        {
            "id": "acct_1",
            "payouts_enabled": True,
            "charges_enabled": True,
            "details_submitted": True,
            "requirements": {"currently_due": ["identity_document"]},
        },
        "sk_test_dummy",
    )
    # sanity: the raw object reproduces the stripe-15 incompatibility
    with pytest.raises(AttributeError):
        account.get("requirements")

    monkeypatch.setattr(stripe.Account, "retrieve", lambda *a, **k: account)

    status = await provider.get_account_status("acct_1")

    assert status.payouts_enabled is True
    assert status.charges_enabled is True
    assert status.details_submitted is True
    assert status.requirements_currently_due == ["identity_document"]


@pytest.mark.asyncio
async def test_get_account_status_reports_disabled_with_requirements(monkeypatch):
    provider = _provider()
    account = stripe.Account.construct_from(
        {
            "id": "acct_2",
            "payouts_enabled": False,
            "requirements": {"currently_due": ["external_account", "tos_acceptance"]},
        },
        "sk_test_dummy",
    )
    monkeypatch.setattr(stripe.Account, "retrieve", lambda *a, **k: account)

    status = await provider.get_account_status("acct_2")

    assert status.payouts_enabled is False
    assert status.requirements_currently_due == ["external_account", "tos_acceptance"]


@pytest.mark.asyncio
async def test_transfer_reports_success_with_stripe15_transfer(monkeypatch):
    provider = _provider()
    transfer = stripe.Transfer.construct_from(
        {"id": "tr_1", "amount": 5000, "destination": "acct_1"},
        "sk_test_dummy",
    )
    with pytest.raises((KeyError, TypeError, AttributeError)):
        dict(transfer)  # stripe-15: this is what used to flip success→False

    monkeypatch.setattr(stripe.Transfer, "create", lambda **k: transfer)

    result = await provider.transfer(TransferRequest(
        connected_account_id="acct_1",
        amount_cents=5000,
        description="CompassCHW payout test",
    ))

    assert result.success is True
    assert result.provider_transfer_id == "tr_1"

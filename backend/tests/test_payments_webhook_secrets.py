"""Regression tests for multi-secret Stripe webhook verification.

Real payouts split Connect events across two Stripe webhook destinations, each
with its own signing secret, both delivered to the same endpoint:
  - connected-accounts destination → account.updated, payout.paid
  - platform destination           → transfer.paid, transfer.failed

`StripeProvider.verify_webhook` must accept an event signed by EITHER secret and
reject one signed by neither.
"""

import hashlib
import hmac
import json
import time

import pytest
import stripe

from app.services.payments.stripe_provider import StripeProvider

CONNECTED_SECRET = "whsec_connected_accounts_secret"
PLATFORM_SECRET = "whsec_platform_account_secret"


def _event_payload(event_type: str, obj: dict | None = None) -> bytes:
    """A realistic Stripe event envelope (always has id + object:'event')."""
    return json.dumps({
        "id": "evt_test_123",
        "object": "event",
        "type": event_type,
        "data": {"object": obj or {}},
    }).encode()


def _sign(payload: bytes, secret: str) -> str:
    """Build a Stripe-Signature header (t=..,v1=..) for the given secret."""
    timestamp = int(time.time())
    signed_payload = f"{timestamp}.{payload.decode()}".encode()
    signature = hmac.new(
        secret.encode(), signed_payload, hashlib.sha256
    ).hexdigest()
    return f"t={timestamp},v1={signature}"


def _provider(**overrides) -> StripeProvider:
    kwargs = {
        "secret_key": "sk_test_dummy",
        "webhook_secret": CONNECTED_SECRET,
        "platform_webhook_secret": PLATFORM_SECRET,
    }
    kwargs.update(overrides)
    return StripeProvider(**kwargs)


def test_verifies_event_signed_with_connected_accounts_secret():
    provider = _provider()
    payload = _event_payload("account.updated", {"payouts_enabled": True})
    header = _sign(payload, CONNECTED_SECRET)

    event = provider.verify_webhook(payload, header)

    assert event["type"] == "account.updated"
    # Returned dict must be fully plain so the router's nested .get() chain works
    # (regression: stripe>=15 StripeObject is not dict-compatible).
    assert event.get("data", {}).get("object", {}).get("payouts_enabled") is True


def test_verifies_event_signed_with_platform_secret():
    provider = _provider()
    payload = _event_payload("transfer.paid", {"id": "tr_1"})
    header = _sign(payload, PLATFORM_SECRET)

    event = provider.verify_webhook(payload, header)

    assert event["type"] == "transfer.paid"
    assert event.get("data", {}).get("object", {}).get("id") == "tr_1"


def test_rejects_event_signed_with_unknown_secret():
    provider = _provider()
    payload = _event_payload("transfer.paid")
    header = _sign(payload, "whsec_some_other_secret")

    with pytest.raises(stripe.error.SignatureVerificationError):
        provider.verify_webhook(payload, header)


def test_single_secret_still_works_when_platform_unset():
    """Current prod config (only the connected-accounts secret) is unaffected."""
    provider = _provider(platform_webhook_secret="")
    payload = _event_payload("payout.paid")
    header = _sign(payload, CONNECTED_SECRET)

    event = provider.verify_webhook(payload, header)

    assert event["type"] == "payout.paid"


def test_no_secrets_configured_raises_runtime_error():
    provider = _provider(webhook_secret="", platform_webhook_secret="")
    payload = _event_payload("account.updated")

    with pytest.raises(RuntimeError, match="STRIPE_WEBHOOK_SECRET"):
        provider.verify_webhook(payload, _sign(payload, CONNECTED_SECRET))

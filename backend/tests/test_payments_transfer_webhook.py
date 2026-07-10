"""The Stripe webhook endpoint must dispatch the REAL transfer event names.

Regression: the handler was wired to `transfer.paid` / `transfer.failed`, which
don't exist in the modern Stripe API. The platform destination emits
`transfer.created` (success) and `transfer.reversed` (clawback). This verifies
the dispatch maps those to the right handlers.
"""

import pytest
from httpx import AsyncClient

import app.routers.payments as payments_router


class _FakeProvider:
    """Returns a preset event dict; skips real signature verification."""

    def __init__(self, event: dict):
        self._event = event

    def verify_webhook(self, payload: bytes, signature_header: str) -> dict:
        return self._event


def _install_fake(monkeypatch, event: dict) -> None:
    monkeypatch.setattr(
        payments_router, "get_payments_provider", lambda: _FakeProvider(event)
    )


@pytest.mark.asyncio
async def test_transfer_created_routes_to_created_handler(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    event = {
        "type": "transfer.created",
        "data": {"object": {"id": "tr_1", "metadata": {"billing_claim_id": "x"}}},
    }
    _install_fake(monkeypatch, event)

    seen = {}

    async def _spy(db, obj):
        seen["obj"] = obj

    monkeypatch.setattr(payments_router, "_handle_transfer_created", _spy)

    res = await client.post(
        "/api/v1/payments/webhooks/stripe",
        content=b"{}",
        headers={"Stripe-Signature": "t=1,v1=x"},
    )

    assert res.status_code == 200
    assert seen["obj"]["id"] == "tr_1"


@pytest.mark.asyncio
async def test_transfer_reversed_routes_to_reversed_handler(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    event = {"type": "transfer.reversed", "data": {"object": {"id": "tr_2"}}}
    _install_fake(monkeypatch, event)

    seen = {}

    async def _spy(db, obj):
        seen["obj"] = obj

    monkeypatch.setattr(payments_router, "_handle_transfer_reversed", _spy)

    res = await client.post(
        "/api/v1/payments/webhooks/stripe",
        content=b"{}",
        headers={"Stripe-Signature": "t=1,v1=x"},
    )

    assert res.status_code == 200
    assert seen["obj"]["id"] == "tr_2"


@pytest.mark.asyncio
async def test_legacy_transfer_paid_is_not_handled(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    """A stray legacy transfer.paid must not touch the created handler."""
    event = {"type": "transfer.paid", "data": {"object": {"id": "tr_3"}}}
    _install_fake(monkeypatch, event)

    called = {"n": 0}

    async def _spy(db, obj):
        called["n"] += 1

    monkeypatch.setattr(payments_router, "_handle_transfer_created", _spy)

    res = await client.post(
        "/api/v1/payments/webhooks/stripe",
        content=b"{}",
        headers={"Stripe-Signature": "t=1,v1=x"},
    )

    # Endpoint still 200s (unknown events are ignored), but nothing is processed.
    assert res.status_code == 200
    assert called["n"] == 0

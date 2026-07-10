"""Stripe Connect Express adapter.

CHW onboarding flow:
  1. CHW taps "Set up payouts" → POST /payments/connect-onboarding
  2. Backend calls create_connected_account (if not exists) + create_onboarding_link
  3. App opens the hosted URL in an in-app browser
  4. CHW enters SSN/EIN, bank account, uploads ID — all handled by Stripe
  5. Stripe redirects to compasschw://payments/onboarding-complete
  6. Stripe fires account.updated webhook → we refresh our local status

Payout flow (triggered when a billing claim is marked paid by Pear Suite):
  1. Claim status flips to "paid" via Pear Suite webhook
  2. Backend computes net payout amount for the CHW
  3. transfer() moves funds from platform balance to CHW's connected account
  4. Stripe automatically batches to daily ACH out to CHW's bank

Webhook events handled:
  - account.updated — refresh local AccountStatus cache
  - transfer.created — mark billing claim as paid_to_chw (transfers settle
    synchronously; the modern API has no transfer.paid)
  - transfer.reversed — log + alert on a clawback
  - payout.paid — for visibility only; funds hit CHW's bank

All methods return typed results; never raise on provider-side business errors
(insufficient funds, account not ready). Raise only on programming errors
(missing config, bad request shape).
"""

import json
import logging
from datetime import UTC, datetime, timedelta
from uuid import UUID

from app.services.payments.base import (
    AccountStatus,
    ConnectedAccount,
    OnboardingLink,
    PaymentsProvider,
    TransferRequest,
    TransferResult,
)

logger = logging.getLogger("compass.payments.stripe")


class StripeProvider(PaymentsProvider):
    """Stripe Connect Express adapter.

    Requires `stripe` Python SDK:
        pip install stripe>=7.0.0

    Config (via app.config.settings):
        STRIPE_SECRET_KEY       — starts with sk_live_ or sk_test_
        STRIPE_WEBHOOK_SECRET   — starts with whsec_, from Stripe dashboard
        STRIPE_PLATFORM_NAME    — shown to CHWs during onboarding (e.g., "CompassCHW")
    """

    def __init__(
        self,
        secret_key: str,
        webhook_secret: str,
        platform_name: str = "CompassCHW",
        platform_webhook_secret: str = "",
    ) -> None:
        self._secret_key = secret_key
        self._webhook_secret = webhook_secret
        self._platform_webhook_secret = platform_webhook_secret
        self._platform_name = platform_name
        self._stripe = None

    @property
    def _webhook_secrets(self) -> list[str]:
        """All configured webhook signing secrets, in try-order.

        Stripe splits Connect events across two destinations — connected-account
        events (account.updated, payout.paid) and platform events (transfer.*) —
        each with its own signing secret, both delivered to the same endpoint.
        An incoming event is signed with exactly one of them, so verification
        tries each until one validates.
        """
        return [s for s in (self._webhook_secret, self._platform_webhook_secret) if s]

    def _get_stripe(self):
        """Lazy-load the Stripe SDK so we don't import it when unused."""
        if self._stripe is None:
            try:
                import stripe
                stripe.api_key = self._secret_key
                # Pin the API version — prevents surprise breaking changes when
                # Stripe releases new default versions
                stripe.api_version = "2024-06-20"
                self._stripe = stripe
            except ImportError:
                logger.warning("stripe SDK not installed — pip install stripe")
                return None
        return self._stripe

    async def create_connected_account(
        self,
        user_id: UUID,
        email: str,
        country: str = "US",
    ) -> ConnectedAccount:
        """Create a Stripe Express connected account for a CHW."""
        stripe = self._get_stripe()
        if stripe is None or not self._secret_key:
            logger.info("Stripe not configured — placeholder connected account for %s", user_id)
            return ConnectedAccount(
                provider_account_id=f"acct_placeholder_{user_id}",
                provider="stripe",
            )

        # Run the sync stripe call in a thread so we don't block the event loop
        import asyncio

        def _create_sync():
            return stripe.Account.create(
                type="express",
                country=country,
                email=email,
                capabilities={
                    "transfers": {"requested": True},
                },
                business_type="individual",
                metadata={
                    "compass_user_id": str(user_id),
                    "platform": self._platform_name,
                },
                settings={
                    "payouts": {
                        # CHWs get a weekly automatic payout on Fridays.
                        # Override with manual triggers via the transfer() method.
                        "schedule": {"interval": "weekly", "weekly_anchor": "friday"},
                    },
                },
            )

        account = await asyncio.to_thread(_create_sync)
        return ConnectedAccount(
            provider_account_id=account["id"],
            provider="stripe",
        )

    async def create_onboarding_link(
        self,
        connected_account_id: str,
        return_url: str,
        refresh_url: str,
    ) -> OnboardingLink:
        """Create a Stripe-hosted KYC + bank-collection URL."""
        stripe = self._get_stripe()
        if stripe is None or not self._secret_key or connected_account_id.startswith("acct_placeholder"):
            # Placeholder response lets the mobile flow be tested end-to-end
            # without real Stripe credentials
            return OnboardingLink(
                url="https://joincompasschw.com/payments/placeholder-onboarding",
                expires_at_iso=(datetime.now(UTC) + timedelta(minutes=10)).isoformat(),
            )

        import asyncio

        def _link_sync():
            return stripe.AccountLink.create(
                account=connected_account_id,
                refresh_url=refresh_url,
                return_url=return_url,
                type="account_onboarding",
            )

        link = await asyncio.to_thread(_link_sync)
        expires_dt = datetime.fromtimestamp(link["expires_at"], tz=UTC)
        return OnboardingLink(url=link["url"], expires_at_iso=expires_dt.isoformat())

    async def get_account_status(self, connected_account_id: str) -> AccountStatus:
        """Fetch readiness state from Stripe."""
        stripe = self._get_stripe()
        if stripe is None or not self._secret_key or connected_account_id.startswith("acct_placeholder"):
            return AccountStatus(
                charges_enabled=False,
                payouts_enabled=False,
                details_submitted=False,
                requirements_currently_due=["placeholder — stripe not configured"],
            )

        import asyncio

        def _get_sync():
            return stripe.Account.retrieve(connected_account_id)

        account = await asyncio.to_thread(_get_sync)
        requirements = account.get("requirements", {}) or {}
        return AccountStatus(
            charges_enabled=bool(account.get("charges_enabled", False)),
            payouts_enabled=bool(account.get("payouts_enabled", False)),
            details_submitted=bool(account.get("details_submitted", False)),
            requirements_currently_due=list(requirements.get("currently_due", []) or []),
            raw=dict(account),
        )

    async def transfer(self, req: TransferRequest) -> TransferResult:
        """Move funds from platform balance to a connected account.

        Uses billing_claim_id as the idempotency key so a double-triggered payout
        returns the original transfer instead of sending money twice.
        """
        stripe = self._get_stripe()
        if stripe is None or not self._secret_key or req.connected_account_id.startswith("acct_placeholder"):
            logger.info(
                "Stripe not configured — pretending to transfer %d cents to %s",
                req.amount_cents, req.connected_account_id,
            )
            return TransferResult(
                success=False,
                amount_cents=req.amount_cents,
                error="Stripe not configured",
            )

        if req.amount_cents <= 0:
            return TransferResult(success=False, error="amount_cents must be > 0")

        import asyncio

        idempotency_key = None
        if req.billing_claim_id is not None:
            idempotency_key = f"claim-{req.billing_claim_id}"
        elif req.session_id is not None:
            idempotency_key = f"session-{req.session_id}"

        metadata = {"description": req.description}
        if req.session_id:
            metadata["session_id"] = str(req.session_id)
        if req.billing_claim_id:
            metadata["billing_claim_id"] = str(req.billing_claim_id)
        if req.chw_id:
            metadata["chw_id"] = str(req.chw_id)
        if req.service_date_iso:
            metadata["service_date"] = req.service_date_iso

        def _transfer_sync():
            kwargs = dict(
                amount=req.amount_cents,
                currency="usd",
                destination=req.connected_account_id,
                description=req.description,
                metadata=metadata,
            )
            if idempotency_key:
                return stripe.Transfer.create(**kwargs, idempotency_key=idempotency_key)
            return stripe.Transfer.create(**kwargs)

        try:
            transfer = await asyncio.to_thread(_transfer_sync)
            return TransferResult(
                success=True,
                provider_transfer_id=transfer["id"],
                amount_cents=req.amount_cents,
                raw=dict(transfer),
            )
        except Exception as e:  # noqa: BLE001
            logger.error("Stripe transfer failed: %s", e)
            return TransferResult(
                success=False,
                amount_cents=req.amount_cents,
                error=str(e),
            )

    def verify_webhook(self, payload: bytes, signature_header: str) -> dict:
        """Verify Stripe webhook signature and return the event dict.

        Raises on invalid signature — never process unverified events.
        """
        stripe = self._get_stripe()
        if stripe is None:
            raise RuntimeError("stripe SDK not installed")

        secrets = self._webhook_secrets
        if not secrets:
            raise RuntimeError("STRIPE_WEBHOOK_SECRET not configured")

        # An event is signed with exactly one destination's secret. Try each;
        # return on the first that validates. Only if ALL fail do we reject —
        # re-raising the last SignatureVerificationError so the router returns
        # 400 and Stripe does not retry against a genuinely bad signature.
        last_error: Exception | None = None
        for secret in secrets:
            try:
                event = stripe.Webhook.construct_event(
                    payload=payload,
                    sig_header=signature_header,
                    secret=secret,
                )
                # stripe>=15 returns a StripeObject that is NOT dict-compatible:
                # `event.get("data", {}).get("object", {})` (how the router reads
                # it) raises AttributeError, so events would be received but never
                # processed. Serialize to a fully-plain, recursively-nested dict.
                return json.loads(str(event))
            except stripe.error.SignatureVerificationError as e:
                last_error = e
                continue

        # None of the configured secrets matched — reject.
        assert last_error is not None  # guaranteed: secrets is non-empty
        raise last_error

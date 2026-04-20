"""CHW payout endpoints.

Flow summary:
  1. CHW logs in → sees a "Set up payouts" banner on their earnings screen
  2. Taps it → POST /payments/connect-onboarding returns a Stripe-hosted URL
  3. App opens URL in an in-app browser (expo-web-browser or SFSafariViewController)
  4. CHW completes KYC + bank info on Stripe's side
  5. Stripe redirects to compasschw://payments/onboarding-complete
  6. Stripe fires account.updated webhook → we cache payouts_enabled=true
  7. When a BillingClaim flips to `paid` (Pear Suite webhook), we transfer
     the net amount to the CHW's connected account via Stripe.

Webhooks (all go through POST /payments/webhooks/stripe):
  - account.updated: refresh CHWProfile.stripe_payouts_enabled
  - transfer.paid: mark BillingClaim.paid_to_chw_at + stripe_transfer_id
  - transfer.failed: log + alert (bank rejection, frozen account)
  - payout.paid: informational; no DB writes
"""

import logging
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.dependencies import require_role
from app.services.payments import (
    TransferRequest,
    get_payments_provider,
)

logger = logging.getLogger("compass.payments")

router = APIRouter(prefix="/api/v1/payments", tags=["payments"])


# ─── Schemas ─────────────────────────────────────────────────────────────────

class ConnectOnboardingResponse(BaseModel):
    onboarding_url: str
    expires_at: str
    account_id: str


class AccountStatusResponse(BaseModel):
    account_id: str | None
    payouts_enabled: bool
    details_submitted: bool
    requirements_currently_due: list[str]


# ─── Onboarding ──────────────────────────────────────────────────────────────

@router.post("/connect-onboarding", response_model=ConnectOnboardingResponse)
async def connect_onboarding(
    current_user=Depends(require_role("chw")),
    db: AsyncSession = Depends(get_db),
):
    """Return a Stripe-hosted URL where the CHW completes KYC + bank info.

    Creates a Connect account on first call; reuses the existing account on
    subsequent calls (e.g., if the previous onboarding link expired).
    """
    from app.models.user import CHWProfile

    result = await db.execute(
        select(CHWProfile).where(CHWProfile.user_id == current_user.id)
    )
    profile = result.scalar_one_or_none()
    if profile is None:
        raise HTTPException(status_code=404, detail="CHW profile not found")

    provider = get_payments_provider()

    # Create the connected account if one doesn't exist yet
    account_id = profile.stripe_connected_account_id
    if not account_id:
        account = await provider.create_connected_account(
            user_id=current_user.id,
            email=current_user.email,
        )
        account_id = account.provider_account_id
        profile.stripe_connected_account_id = account_id
        await db.commit()

    # Deep-link back to the app once onboarding finishes / user abandons
    return_url = f"{settings.magic_link_base_url.rstrip('/').replace('/auth/magic', '')}/payments/onboarding-complete"
    refresh_url = f"{settings.magic_link_base_url.rstrip('/').replace('/auth/magic', '')}/payments/onboarding-refresh"

    link = await provider.create_onboarding_link(
        connected_account_id=account_id,
        return_url=return_url,
        refresh_url=refresh_url,
    )

    return ConnectOnboardingResponse(
        onboarding_url=link.url,
        expires_at=link.expires_at_iso,
        account_id=account_id,
    )


@router.get("/account-status", response_model=AccountStatusResponse)
async def account_status(
    current_user=Depends(require_role("chw")),
    db: AsyncSession = Depends(get_db),
):
    """Current readiness of the CHW's payout account.

    Uses the locally cached values (updated via webhook) as source of truth.
    Falls back to a live Stripe call if webhook caching hasn't populated yet.
    """
    from app.models.user import CHWProfile

    result = await db.execute(
        select(CHWProfile).where(CHWProfile.user_id == current_user.id)
    )
    profile = result.scalar_one_or_none()
    if profile is None:
        raise HTTPException(status_code=404, detail="CHW profile not found")

    if not profile.stripe_connected_account_id:
        return AccountStatusResponse(
            account_id=None,
            payouts_enabled=False,
            details_submitted=False,
            requirements_currently_due=["onboarding not started"],
        )

    # Cached fields are authoritative once webhooks have fired
    if profile.stripe_payouts_enabled:
        return AccountStatusResponse(
            account_id=profile.stripe_connected_account_id,
            payouts_enabled=True,
            details_submitted=True,
            requirements_currently_due=[],
        )

    # Not yet enabled — ask Stripe directly for the current requirements list
    try:
        provider = get_payments_provider()
        status = await provider.get_account_status(profile.stripe_connected_account_id)
        return AccountStatusResponse(
            account_id=profile.stripe_connected_account_id,
            payouts_enabled=status.payouts_enabled,
            details_submitted=status.details_submitted,
            requirements_currently_due=status.requirements_currently_due,
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("Stripe account fetch failed: %s", e)
        return AccountStatusResponse(
            account_id=profile.stripe_connected_account_id,
            payouts_enabled=profile.stripe_payouts_enabled,
            details_submitted=profile.stripe_details_submitted,
            requirements_currently_due=["status unavailable"],
        )


# ─── Webhooks ────────────────────────────────────────────────────────────────

@router.post("/webhooks/stripe", status_code=status.HTTP_200_OK)
async def stripe_webhook(
    request: Request,
    stripe_signature: str = Header(default="", alias="Stripe-Signature"),
    db: AsyncSession = Depends(get_db),
):
    """Receive Stripe webhook events.

    Stripe's server retries webhooks on 500/503 — we return 200 as soon as
    the signature is verified and the event is queued, even if downstream
    processing has issues. Reprocessing is driven by Stripe's retry logic.
    """
    body = await request.body()
    provider = get_payments_provider()

    try:
        event = provider.verify_webhook(body, stripe_signature)
    except Exception as e:  # noqa: BLE001
        logger.warning("Stripe webhook signature verification failed: %s", e)
        raise HTTPException(status_code=400, detail="Invalid signature") from e

    event_type = event.get("type", "")
    obj = event.get("data", {}).get("object", {}) or {}

    try:
        if event_type == "account.updated":
            await _handle_account_updated(db, obj)
        elif event_type == "transfer.paid":
            await _handle_transfer_paid(db, obj)
        elif event_type == "transfer.failed":
            await _handle_transfer_failed(db, obj)
        elif event_type == "payout.paid":
            # CHW's bank received the money; informational only
            logger.info("Payout paid to account %s: $%s", obj.get("destination"), (obj.get("amount", 0) / 100))
        else:
            logger.debug("Unhandled Stripe event: %s", event_type)
    except Exception as e:  # noqa: BLE001
        # Log but don't 500 — Stripe will retry if we fail here, but we want
        # to limit retries to signature/auth failures only
        logger.error("Stripe webhook processing error (%s): %s", event_type, e)

    return {"received": True}


async def _handle_account_updated(db: AsyncSession, account_obj: dict) -> None:
    """Cache the updated connected-account state locally."""
    from app.models.user import CHWProfile

    account_id = account_obj.get("id")
    if not account_id:
        return

    result = await db.execute(
        select(CHWProfile).where(CHWProfile.stripe_connected_account_id == account_id)
    )
    profile = result.scalar_one_or_none()
    if profile is None:
        logger.warning("account.updated for unknown account %s", account_id)
        return

    profile.stripe_payouts_enabled = bool(account_obj.get("payouts_enabled", False))
    profile.stripe_details_submitted = bool(account_obj.get("details_submitted", False))
    await db.commit()
    logger.info(
        "Account %s updated: payouts_enabled=%s",
        account_id, profile.stripe_payouts_enabled,
    )


async def _handle_transfer_paid(db: AsyncSession, transfer_obj: dict) -> None:
    """Mark the billing claim tied to this transfer as paid-to-CHW."""
    from app.models.billing import BillingClaim

    transfer_id = transfer_obj.get("id")
    metadata = transfer_obj.get("metadata", {}) or {}
    billing_claim_id = metadata.get("billing_claim_id")

    if not billing_claim_id:
        logger.warning("transfer.paid without billing_claim_id metadata: %s", transfer_id)
        return

    from uuid import UUID
    try:
        claim_uuid = UUID(billing_claim_id)
    except ValueError:
        logger.warning("transfer.paid with malformed claim id: %s", billing_claim_id)
        return

    claim = await db.get(BillingClaim, claim_uuid)
    if claim is None:
        logger.warning("transfer.paid for unknown claim %s", billing_claim_id)
        return

    claim.stripe_transfer_id = transfer_id
    claim.paid_to_chw_at = datetime.now(UTC)
    await db.commit()


async def _handle_transfer_failed(db: AsyncSession, transfer_obj: dict) -> None:
    """Log a transfer failure so we can alert + retry."""
    transfer_id = transfer_obj.get("id")
    destination = transfer_obj.get("destination")
    failure_message = transfer_obj.get("failure_message") or transfer_obj.get("failure_code")
    logger.error(
        "Stripe transfer failed: id=%s, destination=%s, reason=%s",
        transfer_id, destination, failure_message,
    )
    # TODO: when we have an admin alert channel, send a notification here.


# ─── Internal helpers (for other modules) ────────────────────────────────────

async def trigger_chw_payout(
    db: AsyncSession,
    billing_claim_id: "UUID",  # noqa: F821
) -> bool:
    """Transfer a CHW's net share from platform balance to their connected account.

    Called by the claim-retry scheduler once Pear Suite marks a claim as `paid`.
    Idempotent via Stripe's idempotency key on billing_claim_id — safe to retry.

    Returns True on success, False if the CHW hasn't completed onboarding or
    the transfer couldn't be initiated.
    """
    from decimal import Decimal

    from app.models.billing import BillingClaim
    from app.models.user import CHWProfile

    claim = await db.get(BillingClaim, billing_claim_id)
    if claim is None:
        return False
    if claim.stripe_transfer_id:
        # Already paid out — idempotent no-op
        return True

    profile_result = await db.execute(
        select(CHWProfile).where(CHWProfile.user_id == claim.chw_id)
    )
    profile = profile_result.scalar_one_or_none()
    if profile is None or not profile.stripe_connected_account_id or not profile.stripe_payouts_enabled:
        logger.warning(
            "CHW %s not onboarded for payouts; claim %s awaiting setup",
            claim.chw_id, billing_claim_id,
        )
        return False

    # Compute net payout in cents
    net_payout = Decimal(str(claim.net_payout or 0))
    amount_cents = int((net_payout * 100).to_integral_value())
    if amount_cents <= 0:
        return False

    provider = get_payments_provider()
    result = await provider.transfer(TransferRequest(
        connected_account_id=profile.stripe_connected_account_id,
        amount_cents=amount_cents,
        description=f"CompassCHW session payout — claim {billing_claim_id}",
        session_id=claim.session_id,
        billing_claim_id=claim.id,
        chw_id=claim.chw_id,
        service_date_iso=claim.service_date.isoformat() if claim.service_date else None,
    ))

    if result.success and result.provider_transfer_id:
        claim.stripe_transfer_id = result.provider_transfer_id
        # Actual `paid_to_chw_at` timestamp is set by the transfer.paid webhook
        await db.commit()
        return True
    return False

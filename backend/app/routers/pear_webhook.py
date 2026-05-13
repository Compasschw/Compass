"""Pear Suite webhook receiver — claim status updates.

STUB: Pear has not yet shared their webhook contract or signature scheme
as of 2026-05-12. This endpoint accepts any POST body, returns 200 quickly
(so Pear's retry logic doesn't pile up), logs the raw payload, and short-
circuits before doing any work. Replace `TODO(pear-webhook)` blocks once
Pear publishes:

  1. Signature header name + algorithm (HMAC-SHA256? Stripe-style timestamp+sig?)
  2. Payload schema (event_type, claim_id, new_status, paid_at, etc.)
  3. Idempotency / event-id header so we can dedupe retries

In the meantime, the `poll_pear_claim_status` scheduler job covers status
transitions by pulling every 30 minutes — so we're not blind on the demo,
just less timely than a push would be.

Route is registered under /api/v1/webhooks/pear-suite. Public (no auth);
Pear's signature header is the only authentication once the contract lands.
"""

import logging
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Header, Request, status
from fastapi.responses import JSONResponse

from app.config import settings

logger = logging.getLogger("compass.pear_webhook")

router = APIRouter(prefix="/api/v1/webhooks", tags=["pear-webhook"])


@router.post(
    "/pear-suite",
    status_code=status.HTTP_200_OK,
    summary="Pear Suite webhook receiver — STUB until contract lands",
)
async def receive_pear_webhook(
    request: Request,
    # TODO(pear-webhook): replace `x_pear_signature` with the actual header
    # name once Pear publishes it. Common patterns: 'X-Pear-Signature',
    # 'X-Pear-Hub-Signature', 'X-Webhook-Signature'.
    x_pear_signature: str | None = Header(default=None, alias="X-Pear-Signature"),
) -> JSONResponse:
    """Accept a webhook from Pear Suite and (eventually) update claim status.

    Current behaviour: log the raw body + headers, return 200. This keeps
    Pear's webhook retry queue clean while we wait on their contract.

    Future behaviour (once Pear publishes the contract):
      1. Verify signature using `settings.pear_suite_webhook_secret` (HMAC).
         Reject with 401 on mismatch.
      2. Parse JSON body into a typed model (see `PearWebhookEvent` below).
      3. Dispatch on event_type — claim.paid → flip BillingClaim.status +
         set paid_at + let the existing payout scheduler fire the transfer.
      4. Return 200 with the event id to ACK.

    Returns:
        JSONResponse 200 with a minimal `{ "received": true }` body so
        Pear's retry logic doesn't trigger. Pear-side dashboard will show
        the webhook as delivered.
    """
    # Read raw body for logging (defensive — request.json() can blow up if
    # Pear sends a non-JSON content-type during early integration tests).
    try:
        raw_body = await request.body()
        body_preview = raw_body[:2000].decode("utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        body_preview = "<unreadable>"

    logger.info(
        "pear_webhook.received: signature_present=%s body_preview=%r received_at=%s",
        x_pear_signature is not None,
        body_preview,
        datetime.now(UTC).isoformat(),
    )

    # TODO(pear-webhook): once Pear publishes the contract:
    #
    # 1. Verify signature:
    #     secret = settings.pear_suite_webhook_secret
    #     expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    #     if not hmac.compare_digest(expected, x_pear_signature or ""):
    #         logger.warning("pear_webhook.bad_signature")
    #         return JSONResponse(status_code=401, content={"error": "bad signature"})
    #
    # 2. Parse body:
    #     event = json.loads(raw_body)
    #     event_type = event.get("type")
    #     claim_id = event.get("data", {}).get("claim", {}).get("id")
    #     new_status = event.get("data", {}).get("claim", {}).get("status")
    #
    # 3. Update BillingClaim:
    #     async with async_session() as db:
    #         result = await db.execute(
    #             select(BillingClaim).where(BillingClaim.pear_suite_claim_id == claim_id)
    #         )
    #         claim = result.scalar_one_or_none()
    #         if claim and claim.status != new_status:
    #             claim.status = new_status
    #             if new_status == "paid" and claim.paid_at is None:
    #                 claim.paid_at = datetime.now(UTC)
    #             await db.commit()
    #             logger.info("pear_webhook.applied: claim=%s status=%s", claim.id, new_status)
    #
    # The trigger_pending_payouts scheduler job (every 10 min) will then
    # pick up the now-paid claim and fire the Stripe Connect transfer.

    _ = settings  # silence linter — settings will be used once contract lands

    return JSONResponse(
        status_code=status.HTTP_200_OK,
        content={"received": True, "applied": False, "reason": "webhook contract pending"},
    )

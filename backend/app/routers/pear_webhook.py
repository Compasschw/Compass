"""Pear Suite webhook receiver — claim status updates.

STUB (processing-wise): Pear has not yet shared their webhook contract as
of 2026-06-12, so no payload is parsed or applied. The
`poll_pear_claim_status` scheduler job covers status transitions by pulling
every 30 minutes, so we are not blind — just less timely than a push.

Security posture (audit 2026-06-12 blocker #3):
- The endpoint REJECTS every request with 401 until
  `settings.pear_suite_webhook_secret` is configured.
- Once a secret is set, requests must carry an HMAC-SHA256 hex digest of
  the raw body in `X-Pear-Signature` (constant-time compared). Adjust the
  header name/scheme when Pear publishes their actual contract.
- The request body is NEVER logged — webhook payloads will carry claim /
  member identifiers (PHI-adjacent), and CloudWatch log groups are
  long-retention storage. Only metadata (body length, signature presence)
  is logged.

Remaining TODO(pear-webhook) once Pear publishes the contract:
  1. Confirm signature header name + algorithm (adjust below).
  2. Parse payload schema (event_type, claim_id, new_status, paid_at).
  3. Dedupe retries via their idempotency / event-id header.
  4. Apply claim status transitions (see git history of this file for the
     sketched BillingClaim update flow).

Route is registered under /api/v1/webhooks/pear-suite.
"""

import hashlib
import hmac
import logging
from typing import Annotated

from fastapi import APIRouter, Header, Request, status
from fastapi.responses import JSONResponse

from app.config import settings

logger = logging.getLogger("compass.pear_webhook")

router = APIRouter(prefix="/api/v1/webhooks", tags=["pear-webhook"])


def _signature_is_valid(raw_body: bytes, supplied_signature: str | None) -> bool:
    """Validate the HMAC-SHA256 signature on an inbound Pear webhook.

    Returns False when no secret is configured (endpoint disabled), when the
    signature header is missing, or when the digest does not match. Uses
    `hmac.compare_digest` to avoid timing side-channels.
    """
    secret = settings.pear_suite_webhook_secret
    if not secret or not supplied_signature:
        return False
    expected = hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, supplied_signature)


@router.post(
    "/pear-suite",
    status_code=status.HTTP_200_OK,
    summary="Pear Suite webhook receiver — signature-gated, processing stubbed",
)
async def receive_pear_webhook(
    request: Request,
    # TODO(pear-webhook): confirm the real header name once Pear publishes
    # their contract. Common patterns: 'X-Pear-Signature',
    # 'X-Pear-Hub-Signature', 'X-Webhook-Signature'.
    x_pear_signature: Annotated[str | None, Header(alias="X-Pear-Signature")] = None,
) -> JSONResponse:
    """Accept a signed webhook from Pear Suite and (eventually) update claim status.

    Behaviour:
    - 401 for every request until `pear_suite_webhook_secret` is configured.
    - 401 when the HMAC-SHA256 signature is missing or does not match.
    - 200 `{"received": true, "applied": false}` on a valid signature —
      payload processing remains stubbed until Pear publishes the contract.

    The body is intentionally never logged (PHI-adjacent payloads must not
    land in CloudWatch).
    """
    raw_body = await request.body()

    if not _signature_is_valid(raw_body, x_pear_signature):
        logger.warning(
            "pear_webhook.rejected: secret_configured=%s signature_present=%s body_bytes=%d",
            bool(settings.pear_suite_webhook_secret),
            x_pear_signature is not None,
            len(raw_body),
        )
        return JSONResponse(
            status_code=status.HTTP_401_UNAUTHORIZED,
            content={"error": "invalid or missing signature"},
        )

    logger.info(
        "pear_webhook.received: signature_valid=True body_bytes=%d", len(raw_body)
    )

    # TODO(pear-webhook): parse + apply the event once the contract lands.
    # The trigger_pending_payouts scheduler job (every 10 min) will then
    # pick up newly-paid claims and fire the Stripe Connect transfer.

    return JSONResponse(
        status_code=status.HTTP_200_OK,
        content={"received": True, "applied": False, "reason": "webhook contract pending"},
    )

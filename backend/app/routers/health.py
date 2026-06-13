"""Health and readiness endpoints.

GET /api/v1/health  -- deep health check: verifies DB connectivity and that
                       required third-party credentials are configured.
                       Always returns HTTP 200; the JSON ``status`` field
                       reports "ok" or "degraded" so monitoring tools can
                       distinguish a healthy deploy from a misconfigured one
                       without treating a non-200 as a routing failure.

GET /api/v1/ready   -- lightweight readiness probe: DB connectivity only.
                       Returns 200 {"status": "ready"} or raises 503.
                       Intended for load-balancer health checks that need a
                       non-200 on failure.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db

logger = logging.getLogger("compass.health")

router = APIRouter(tags=["health"])

# Each deep dependency ping is hard-bounded so a slow/hung vendor can never
# stall the health endpoint. Kept short because these are reachability checks,
# not data operations.
_DEEP_PING_TIMEOUT_S = 3.0


# ─── Deep dependency pings (only run when ?deep=true) ─────────────────────────
#
# These make real authenticated calls to confirm a credential actually works,
# not merely that it is present. They are OPT-IN: the default /health stays
# outbound-call-free so frequent/automated probes don't hammer vendor APIs or
# flip to "degraded" on a transient third-party blip. Point synthetic
# monitoring at /health?deep=true when you want connectivity surfaced.
#
# Every helper returns a short status string and NEVER logs a key or response
# body (vendor payloads can echo account identifiers).


async def _ping_stripe() -> str:
    """Lightweight authenticated Stripe call (Balance.retrieve) — validates the key."""
    if not settings.stripe_secret_key:
        return "missing: STRIPE_SECRET_KEY not set"

    def _retrieve() -> None:
        import stripe

        # Per-call api_key avoids mutating the global stripe.api_key used by
        # the payments provider.
        stripe.Balance.retrieve(api_key=settings.stripe_secret_key)

    try:
        await asyncio.wait_for(asyncio.to_thread(_retrieve), timeout=_DEEP_PING_TIMEOUT_S)
        return "ok"
    except TimeoutError:
        return "error: timeout"
    except Exception as exc:  # noqa: BLE001
        logger.warning("health deep ping: stripe failed: %s", type(exc).__name__)
        return f"error: {type(exc).__name__}"


async def _ping_vonage() -> str:
    """Lightweight authenticated Vonage call (account balance) — validates key+secret."""
    if not (settings.vonage_api_key and settings.vonage_api_secret):
        return "missing: VONAGE_API_KEY/SECRET not set"

    import httpx

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(_DEEP_PING_TIMEOUT_S)) as client:
            resp = await client.get(
                "https://rest.nexmo.com/account/get-balance",
                params={
                    "api_key": settings.vonage_api_key,
                    "api_secret": settings.vonage_api_secret,
                },
            )
        if resp.status_code == 200:
            return "ok"
        return f"error: HTTP {resp.status_code}"
    except httpx.TimeoutException:
        return "error: timeout"
    except Exception as exc:  # noqa: BLE001
        logger.warning("health deep ping: vonage failed: %s", type(exc).__name__)
        return f"error: {type(exc).__name__}"


async def _ping_assemblyai() -> str:
    """Lightweight authenticated AssemblyAI call (list 1 transcript) — validates the key."""
    if settings.transcription_provider != "assemblyai":
        return f"skipped (provider={settings.transcription_provider})"
    if not settings.assemblyai_api_key:
        return "missing: ASSEMBLYAI_API_KEY not set"

    import httpx

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(_DEEP_PING_TIMEOUT_S)) as client:
            resp = await client.get(
                "https://api.assemblyai.com/v2/transcript",
                params={"limit": 1},
                headers={"Authorization": settings.assemblyai_api_key},
            )
        if resp.status_code == 200:
            return "ok"
        return f"error: HTTP {resp.status_code}"
    except httpx.TimeoutException:
        return "error: timeout"
    except Exception as exc:  # noqa: BLE001
        logger.warning("health deep ping: assemblyai failed: %s", type(exc).__name__)
        return f"error: {type(exc).__name__}"


# ─── Response schemas ─────────────────────────────────────────────────────────


class HealthChecks(BaseModel):
    """Individual check results.  Each value is "ok" or a short error string."""

    database: str
    vonage: str
    assemblyai: str
    stripe: str
    scheduler: str


class HealthResponse(BaseModel):
    """Top-level health response body."""

    status: Literal["ok", "degraded"]
    checks: HealthChecks


# ─── Endpoints ────────────────────────────────────────────────────────────────


@router.get(
    "/api/v1/health",
    response_model=HealthResponse,
    summary="Deep health check",
)
async def health(
    db: AsyncSession = Depends(get_db),
    deep: bool = Query(
        default=False,
        description=(
            "When true, make real authenticated calls to Vonage/AssemblyAI/Stripe "
            "to verify the credentials actually work (not just that they are set). "
            "Each ping is bounded to 3s. Use for on-demand diagnostics or synthetic "
            "monitoring; leave false for frequent/automated probes."
        ),
    ),
) -> HealthResponse:
    """Verify database connectivity and dependency health.

    Always returns HTTP 200 so that monitoring tools can read the body even
    on a degraded deploy.  Callers should inspect the ``status`` field:
    - "ok"       -- all checks passed
    - "degraded" -- at least one check failed; see ``checks`` for detail

    Checks performed:
    - database:   executes ``SELECT 1`` against the configured DATABASE_URL
    - scheduler:  APScheduler running with jobs registered
    - vonage / assemblyai / stripe:
        * default (deep=false): credential PRESENCE only — no outbound calls
        * deep=true: a real lightweight authenticated call per vendor,
          bounded to 3s each, confirming the credential works
    """
    checks: dict[str, str] = {}

    # ── Database ──────────────────────────────────────────────────────────────
    try:
        await db.execute(text("SELECT 1"))
        checks["database"] = "ok"
    except Exception as exc:  # noqa: BLE001
        logger.error("health check: database connectivity failed: %s", exc)
        checks["database"] = f"error: {type(exc).__name__}"

    # ── External dependencies (Vonage / AssemblyAI / Stripe) ───────────────────
    if deep:
        # Real authenticated pings, run concurrently and bounded per-vendor.
        checks["vonage"], checks["assemblyai"], checks["stripe"] = await asyncio.gather(
            _ping_vonage(),
            _ping_assemblyai(),
            _ping_stripe(),
        )
    else:
        # Presence-only — required key/secret are set.
        checks["vonage"] = (
            "ok" if settings.vonage_api_key else "missing: VONAGE_API_KEY not set"
        )
        if settings.transcription_provider == "assemblyai":
            checks["assemblyai"] = (
                "ok" if settings.assemblyai_api_key else "missing: ASSEMBLYAI_API_KEY not set"
            )
        else:
            checks["assemblyai"] = f"skipped (provider={settings.transcription_provider})"
        if settings.payments_provider == "stripe":
            checks["stripe"] = (
                "ok" if settings.stripe_secret_key else "missing: STRIPE_SECRET_KEY not set"
            )
        else:
            checks["stripe"] = f"skipped (provider={settings.payments_provider})"

    # ── Scheduler heartbeat ────────────────────────────────────────────────────
    # APScheduler runs session reminders, claim retries, payout triggers, and
    # daily HIPAA jobs. If it crashes silently, those jobs stop firing without
    # any 5xx surface — so we surface its state here.
    try:
        from app.services.scheduler import scheduler_status

        sched = scheduler_status()
        if sched["running"] and (sched["job_count"] or 0) > 0:
            # Match the rest of the checks dict — the aggregate degraded test
            # uses an exact "ok" comparison, so the job-count detail goes in
            # the log line rather than the response value.
            checks["scheduler"] = "ok"
            logger.debug("scheduler heartbeat: %d jobs", sched["job_count"])
        elif sched["running"]:
            checks["scheduler"] = "degraded: running with 0 jobs"
        else:
            checks["scheduler"] = "stopped"
    except Exception as exc:  # noqa: BLE001
        logger.error("health check: scheduler status read failed: %s", exc)
        checks["scheduler"] = f"error: {type(exc).__name__}"

    # ── Aggregate status ──────────────────────────────────────────────────────
    degraded = any(
        v not in {"ok"} and not v.startswith("skipped")
        for v in checks.values()
    )
    overall_status: Literal["ok", "degraded"] = "degraded" if degraded else "ok"

    if degraded:
        failing = [k for k, v in checks.items() if v not in {"ok"} and not v.startswith("skipped")]
        logger.warning("health check degraded: %s", failing)

    return HealthResponse(
        status=overall_status,
        checks=HealthChecks(
            database=checks["database"],
            vonage=checks["vonage"],
            assemblyai=checks["assemblyai"],
            stripe=checks["stripe"],
            scheduler=checks["scheduler"],
        ),
    )


@router.get("/api/v1/ready", summary="Readiness probe (load-balancer / k8s)")
async def ready(db: AsyncSession = Depends(get_db)) -> dict[str, str]:
    """Lightweight readiness probe for load-balancer health checks.

    Raises HTTP 503 if the database is unreachable so the load balancer can
    pull this instance from rotation.  Use ``/api/v1/health`` for richer
    diagnostic information.
    """
    from fastapi import HTTPException
    from fastapi import status as http_status

    try:
        await db.execute(text("SELECT 1"))
    except Exception as exc:  # noqa: BLE001
        logger.error("readiness probe: database connectivity failed: %s", exc)
        raise HTTPException(
            status_code=http_status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database unavailable",
        ) from exc
    return {"status": "ready"}

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

import logging
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db

logger = logging.getLogger("compass.health")

router = APIRouter(tags=["health"])


# ─── Response schemas ─────────────────────────────────────────────────────────


class HealthChecks(BaseModel):
    """Individual check results.  Each value is "ok" or a short error string."""

    database: str
    vonage: str
    assemblyai: str
    stripe: str


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
async def health(db: AsyncSession = Depends(get_db)) -> HealthResponse:
    """Verify database connectivity and required credential configuration.

    Always returns HTTP 200 so that monitoring tools can read the body even
    on a degraded deploy.  Callers should inspect the ``status`` field:
    - "ok"       -- all checks passed
    - "degraded" -- at least one check failed; see ``checks`` for detail

    Checks performed:
    - database:   executes ``SELECT 1`` against the configured DATABASE_URL
    - vonage:     ``VONAGE_API_KEY`` env var is non-empty
    - assemblyai: ``ASSEMBLYAI_API_KEY`` env var is non-empty when
                  ``TRANSCRIPTION_PROVIDER == "assemblyai"``
    - stripe:     ``STRIPE_SECRET_KEY`` env var is non-empty when
                  ``PAYMENTS_PROVIDER == "stripe"``

    No outbound HTTP calls are made during this check — credentials are
    validated for presence only, not correctness.
    """
    checks: dict[str, str] = {}

    # ── Database ──────────────────────────────────────────────────────────────
    try:
        await db.execute(text("SELECT 1"))
        checks["database"] = "ok"
    except Exception as exc:  # noqa: BLE001
        logger.error("health check: database connectivity failed: %s", exc)
        checks["database"] = f"error: {type(exc).__name__}"

    # ── Vonage ────────────────────────────────────────────────────────────────
    # Required for masked calling regardless of which communication_provider is
    # active — the key must be present for the Vonage SDK to initialise.
    if settings.vonage_api_key:
        checks["vonage"] = "ok"
    else:
        checks["vonage"] = "missing: VONAGE_API_KEY not set"

    # ── AssemblyAI ────────────────────────────────────────────────────────────
    # Only required when transcription_provider == "assemblyai".
    if settings.transcription_provider == "assemblyai":
        if settings.assemblyai_api_key:
            checks["assemblyai"] = "ok"
        else:
            checks["assemblyai"] = "missing: ASSEMBLYAI_API_KEY not set"
    else:
        checks["assemblyai"] = f"skipped (provider={settings.transcription_provider})"

    # ── Stripe ────────────────────────────────────────────────────────────────
    # Only required when payments_provider == "stripe".
    if settings.payments_provider == "stripe":
        if settings.stripe_secret_key:
            checks["stripe"] = "ok"
        else:
            checks["stripe"] = "missing: STRIPE_SECRET_KEY not set"
    else:
        checks["stripe"] = f"skipped (provider={settings.payments_provider})"

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
        ),
    )


@router.get("/api/v1/ready", summary="Readiness probe (load-balancer / k8s)")
async def ready(db: AsyncSession = Depends(get_db)) -> dict[str, str]:
    """Lightweight readiness probe for load-balancer health checks.

    Raises HTTP 503 if the database is unreachable so the load balancer can
    pull this instance from rotation.  Use ``/api/v1/health`` for richer
    diagnostic information.
    """
    from fastapi import HTTPException, status as http_status

    try:
        await db.execute(text("SELECT 1"))
    except Exception as exc:  # noqa: BLE001
        logger.error("readiness probe: database connectivity failed: %s", exc)
        raise HTTPException(
            status_code=http_status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database unavailable",
        ) from exc
    return {"status": "ready"}

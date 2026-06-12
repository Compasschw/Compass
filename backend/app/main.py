import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from sqlalchemy import text

from app.config import settings
from app.database import engine
from app.limiter import limiter
from app.middleware.audit import AuditMiddleware

logger = logging.getLogger("compass")

# Configure a StreamHandler on root at INFO level so compass.* INFO logs
# (e.g. "transcript WS connected", "assemblyai streaming session opened")
# actually reach stdout instead of being silently dropped by Python's
# lastResort handler (which only fires at WARNING+). ``force=True`` makes
# this win even if uvicorn or another import set up basicConfig first.
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    force=True,
)
logging.getLogger("compass").setLevel(logging.INFO)

# ─── Sentry initialization ─────────────────────────────────────────────────────
# Must happen before the FastAPI app is instantiated so the integration can
# patch it cleanly. No-ops silently if SENTRY_DSN isn't set.
if settings.sentry_dsn:
    try:
        import sentry_sdk
        from sentry_sdk.integrations.asyncio import AsyncioIntegration
        from sentry_sdk.integrations.fastapi import FastApiIntegration
        from sentry_sdk.integrations.sqlalchemy import SqlalchemyIntegration

        sentry_sdk.init(
            dsn=settings.sentry_dsn,
            environment=settings.environment,
            # 10% traces in prod for cost; 100% in dev/staging
            traces_sample_rate=0.1 if settings.environment == "production" else 1.0,
            profiles_sample_rate=0.1 if settings.environment == "production" else 1.0,
            # HIPAA: never send request bodies or user data to Sentry
            send_default_pii=False,
            # Suppress common noisy errors (rate limits, 404s) to keep the
            # signal-to-noise ratio useful for real engineering incidents
            ignore_errors=["RateLimitExceeded"],
            integrations=[
                FastApiIntegration(transaction_style="endpoint"),
                SqlalchemyIntegration(),
                AsyncioIntegration(),
            ],
        )
        logger.info("Sentry initialized (environment=%s)", settings.environment)
    except Exception as e:  # noqa: BLE001
        logger.warning("Sentry init failed: %s", e)


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with engine.connect() as conn:
        await conn.execute(text("SELECT 1"))
    logger.info("Database connection verified")

    # Start background scheduler for session reminders + claim retries.
    # Failure to start is non-fatal — log and proceed so API traffic still serves.
    try:
        from app.services.scheduler import start_scheduler
        start_scheduler()
    except Exception as e:  # noqa: BLE001
        logger.warning("Scheduler startup failed: %s", e)

    yield

    try:
        from app.services.scheduler import stop_scheduler
        stop_scheduler()
    except Exception as e:  # noqa: BLE001
        logger.warning("Scheduler shutdown error: %s", e)

    await engine.dispose()


app = FastAPI(
    title="CompassCHW API",
    version="0.1.0",
    description="Backend API for CompassCHW",
    lifespan=lifespan,
)

app.state.limiter = limiter
# slowapi types its handler as (Request, RateLimitExceeded) -> Response, which is
# narrower than Starlette's (Request, Exception) signature — known upstream gap.
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)  # type: ignore[arg-type]

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    # X-Admin-2FA-Token is required by every /admin JSON API call from the
    # React admin SPA. Browsers send a preflight OPTIONS for any non-CORS-
    # safelisted request header, so omitting it here blocks the entire admin
    # dashboard at the preflight stage with a "Disallowed CORS headers" 400.
    allow_headers=["Authorization", "Content-Type", "X-Admin-2FA-Token"],
)
app.add_middleware(AuditMiddleware)

from app.routers.admin import router as admin_router
from app.routers.admin_demo import router as admin_demo_router
from app.routers.assessments import router as assessments_router
from app.routers.auth import router as auth_router
from app.routers.case_notes import router as case_notes_router
from app.routers.chw import router as chw_router
from app.routers.chw_intake import router as chw_intake_router
from app.routers.communication import (
    chw_call_router,
    member_call_router,
)
from app.routers.communication import (
    router as communication_router,
)
from app.routers.conversations import router as conversations_router
from app.routers.credentials import router as credentials_router
from app.routers.devices import router as devices_router
from app.routers.health import router as health_router
from app.routers.journeys import router as journeys_router
from app.routers.matching import router as matching_router
from app.routers.member import members_router as members_flag_note_router
from app.routers.member import router as member_router
from app.routers.member_documents import (
    documents_router as member_documents_documents_router,
)
from app.routers.member_documents import (
    members_router as member_documents_members_router,
)
from app.routers.payments import router as payments_router
from app.routers.pear_webhook import router as pear_webhook_router
from app.routers.phone_verification import router as phone_verification_router
from app.routers.requests import router as requests_router
from app.routers.resources import (
    _suggestions_router as resource_suggestions_router,
)
from app.routers.resources import (
    admin_router as resources_admin_router,
)
from app.routers.resources import (
    chw_router as resources_chw_router,
)
from app.routers.resources import (
    public_router as resources_public_router,
)
from app.routers.rewards import router as rewards_router
from app.routers.sessions import _consent_request_router as consent_request_router
from app.routers.sessions import router as sessions_router
from app.routers.testimonials import (
    admin_router as testimonials_admin_router,
)
from app.routers.testimonials import (
    member_router as testimonials_member_router,
)
from app.routers.testimonials import (
    public_router as testimonials_public_router,
)
from app.routers.transcript import router as transcript_router
from app.routers.upload import router as upload_router
from app.routers.vonage_audio import router as vonage_audio_router
from app.routers.waitlist import router as waitlist_router

app.include_router(auth_router)
app.include_router(phone_verification_router)
app.include_router(chw_router)
app.include_router(chw_intake_router)
app.include_router(member_router)
app.include_router(members_flag_note_router)
app.include_router(sessions_router)
app.include_router(consent_request_router)
app.include_router(case_notes_router)
app.include_router(member_documents_members_router)
app.include_router(member_documents_documents_router)
app.include_router(transcript_router)
app.include_router(requests_router)
app.include_router(matching_router)
app.include_router(conversations_router)
app.include_router(credentials_router)
app.include_router(upload_router)
app.include_router(health_router)
app.include_router(waitlist_router)
app.include_router(admin_router)
app.include_router(admin_demo_router)
app.include_router(pear_webhook_router)
app.include_router(devices_router)
app.include_router(payments_router)
app.include_router(journeys_router)
app.include_router(rewards_router)
app.include_router(communication_router)
app.include_router(member_call_router)
app.include_router(chw_call_router)
app.include_router(vonage_audio_router)
app.include_router(assessments_router)

# ─── Testimonials routes ──────────────────────────────────────────────────────
# Registration order: summary (/testimonials/summary) must come BEFORE the
# generic list (/testimonials) to prevent FastAPI capturing "summary" as an
# offset/limit query param. The public_router registers both under /chws/{id};
# FastAPI resolves them correctly because /summary is a literal path segment
# after {chw_id}, but explicit ordering here makes intent clear.
app.include_router(testimonials_admin_router)   # /api/v1/admin/testimonials/...
app.include_router(testimonials_member_router)  # /api/v1/sessions/{id}/testimonials
app.include_router(testimonials_public_router)  # /api/v1/chws/{id}/testimonials[/summary]

# ─── Resource Folder routes ────────────────────────────────────────────────────
# Registration order matters: the static suggestion queue routes must be
# registered BEFORE the parameterised admin resource routes to prevent
# FastAPI from trying to parse "suggestions" as a UUID in /admin/resources/{id}.
app.include_router(resource_suggestions_router)  # /api/v1/admin/resources/suggestions/...
app.include_router(resources_admin_router)        # /api/v1/admin/resources/...
app.include_router(resources_chw_router)          # /api/v1/chw/resources/...
app.include_router(resources_public_router)       # /api/v1/resources/...

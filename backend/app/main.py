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
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)
app.add_middleware(AuditMiddleware)

from app.routers.admin import router as admin_router
from app.routers.auth import router as auth_router
from app.routers.chw import router as chw_router
from app.routers.chw_intake import router as chw_intake_router
from app.routers.communication import router as communication_router
from app.routers.conversations import router as conversations_router
from app.routers.credentials import router as credentials_router
from app.routers.devices import router as devices_router
from app.routers.health import router as health_router
from app.routers.matching import router as matching_router
from app.routers.member import router as member_router
from app.routers.payments import router as payments_router
from app.routers.requests import router as requests_router
from app.routers.sessions import router as sessions_router
from app.routers.upload import router as upload_router
from app.routers.waitlist import router as waitlist_router

app.include_router(auth_router)
app.include_router(chw_router)
app.include_router(chw_intake_router)
app.include_router(member_router)
app.include_router(sessions_router)
app.include_router(requests_router)
app.include_router(matching_router)
app.include_router(conversations_router)
app.include_router(credentials_router)
app.include_router(upload_router)
app.include_router(health_router)
app.include_router(waitlist_router)
app.include_router(admin_router)
app.include_router(devices_router)
app.include_router(payments_router)
app.include_router(communication_router)

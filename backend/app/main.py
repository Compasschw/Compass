import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from app.config import settings
from app.database import engine
from app.middleware.audit import AuditMiddleware

logger = logging.getLogger("compass")


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with engine.connect() as conn:
        await conn.execute(text("SELECT 1"))
    logger.info("Database connection verified")
    yield
    await engine.dispose()


app = FastAPI(
    title="CompassCHW API",
    version="0.1.0",
    description="Backend API for CompassCHW",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)
app.add_middleware(AuditMiddleware)

from app.routers.auth import router as auth_router
from app.routers.chw import router as chw_router
from app.routers.member import router as member_router
from app.routers.sessions import router as sessions_router
from app.routers.requests import router as requests_router
from app.routers.matching import router as matching_router
from app.routers.conversations import router as conversations_router
from app.routers.credentials import router as credentials_router
from app.routers.upload import router as upload_router
from app.routers.health import router as health_router
from app.routers.waitlist import router as waitlist_router

app.include_router(auth_router)
app.include_router(chw_router)
app.include_router(member_router)
app.include_router(sessions_router)
app.include_router(requests_router)
app.include_router(matching_router)
app.include_router(conversations_router)
app.include_router(credentials_router)
app.include_router(upload_router)
app.include_router(health_router)
app.include_router(waitlist_router)

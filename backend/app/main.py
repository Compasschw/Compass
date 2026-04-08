from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.config import settings
from app.middleware.audit import AuditMiddleware

@asynccontextmanager
async def lifespan(app: FastAPI):
    yield

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
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(AuditMiddleware)

# Routers
from app.routers.auth import router as auth_router
app.include_router(auth_router)

@app.get("/api/v1/health")
async def health():
    return {"status": "ok"}

@app.get("/api/v1/ready")
async def ready():
    return {"status": "ready"}

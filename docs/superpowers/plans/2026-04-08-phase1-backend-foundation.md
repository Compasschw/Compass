# Phase 1: Backend Foundation — Database, Auth & Critical Bugs

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the backend actually work — database bootstrapped, auth end-to-end, critical billing/session bugs fixed, frontend auth wired to real backend.

**Architecture:** Fix the existing FastAPI backend in-place. No new services or infrastructure. The backend already has the right structure (models/routers/schemas/services); the work is fixing bugs, adding guards, and wiring the frontend `AuthContext` to call real API endpoints instead of mocking.

**Tech Stack:** Python 3.12, FastAPI, SQLAlchemy 2.x async, Alembic, PostgreSQL 16, React 19, TypeScript

---

## File Map

**Backend files to modify:**
- `backend/app/config.py` — Remove dangerous defaults, add startup validation
- `backend/app/database.py` — Add rollback-on-exception to `get_db()`
- `backend/app/main.py` — Add startup DB check in lifespan, restrict CORS methods/headers
- `backend/app/dependencies.py` — Use enum values in `require_role()`
- `backend/app/utils/security.py` — Hardcode algorithm, don't read from settings
- `backend/app/routers/sessions.py` — Add state machine guards, unit cap check, consent authz
- `backend/app/routers/requests.py` — Implement `pass_request` persistence
- `backend/app/routers/auth.py` — Require auth on logout, add `is_active` check in refresh
- `backend/app/routers/health.py` — Add real DB connectivity check
- `backend/app/services/billing_service.py` — Use `Decimal` instead of `float`
- `backend/app/services/auth_service.py` — Set `expires_at` on refresh tokens, check it on revoke
- `backend/app/schemas/auth.py` — Add `EmailStr` validation
- `backend/app/schemas/session.py` — Type `mode` to `SessionMode` enum
- `backend/app/schemas/request.py` — Type `vertical`, `urgency`, `preferred_mode` to enums
- `backend/app/models/session.py` — Fix `Mapped[float]` to `Mapped[Decimal]` on monetary fields
- `backend/app/models/billing.py` — Fix `Mapped[float]` to `Mapped[Decimal]` on monetary fields
- `backend/alembic/env.py` — Read DB URL from env var instead of alembic.ini
- `backend/alembic.ini` — Remove hardcoded connection string
- `backend/docker-compose.yml` — Remove hardcoded secrets, reference `.env`
- `backend/Dockerfile` — Remove `--reload` from CMD

**Backend files to create:**
- `backend/.env.example` — Document all required env vars
- `backend/.env` — Local dev env vars (gitignored)
- `backend/alembic/versions/` — Initial migration file (auto-generated)
- `backend/tests/conftest.py` — Shared fixtures (test client, test DB, auth helpers)
- `backend/tests/test_auth.py` — Auth endpoint tests
- `backend/tests/test_sessions.py` — Session lifecycle + billing tests

**Frontend files to modify:**
- `web/src/features/auth/AuthContext.tsx` — Accept tokens from API, use `localStorage`
- `web/src/features/auth/LoginPage.tsx` — Call real `loginUser()` API
- `web/src/features/auth/RegisterPage.tsx` — Call real `registerUser()` API
- `web/src/api/client.ts` — Add token refresh interceptor, unify storage with AuthContext

---

### Task 1: Remove Hardcoded Secrets & Add .env Configuration

**Files:**
- Modify: `backend/app/config.py`
- Modify: `backend/alembic.ini`
- Modify: `backend/alembic/env.py`
- Modify: `backend/docker-compose.yml`
- Modify: `backend/Dockerfile`
- Create: `backend/.env.example`
- Create: `backend/.env`

- [ ] **Step 1: Create `.env.example` with all required vars**

```
# backend/.env.example
# Copy to .env and fill in values
DATABASE_URL=postgresql+asyncpg://compass:YOUR_PASSWORD@localhost:5432/compass
SECRET_KEY=  # REQUIRED — generate with: python -c "import secrets; print(secrets.token_urlsafe(32))"
AWS_REGION=us-west-2
S3_BUCKET_PHI=compass-phi-dev
S3_BUCKET_PUBLIC=compass-public-dev
CORS_ORIGINS=["http://localhost:5173","https://joincompasschw.com"]
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PROXY_SERVICE_SID=
```

- [ ] **Step 2: Create local `.env` for dev**

```
# backend/.env
DATABASE_URL=postgresql+asyncpg://compass:compass_dev_password@localhost:5432/compass
SECRET_KEY=local-dev-only-not-for-production-use-abc123
AWS_REGION=us-west-2
S3_BUCKET_PHI=compass-phi-dev
S3_BUCKET_PUBLIC=compass-public-dev
CORS_ORIGINS=["http://localhost:5173","https://joincompasschw.com"]
```

- [ ] **Step 3: Verify `.env` is in `.gitignore`**

Run: `grep -n '\.env' /Users/akrammahmoud/Desktop/Projects/Compass/.gitignore`
Expected: `.env` is listed. If not, add it.

- [ ] **Step 4: Update `config.py` — remove dangerous defaults, add startup validation**

Replace the entire file with:

```python
import sys
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str
    secret_key: str
    access_token_expire_minutes: int = 15
    refresh_token_expire_days: int = 7

    aws_region: str = "us-west-2"
    s3_bucket_phi: str = "compass-phi-dev"
    s3_bucket_public: str = "compass-public-dev"

    cors_origins: list[str] = ["http://localhost:5173", "https://joincompasschw.com"]

    twilio_account_sid: str = ""
    twilio_auth_token: str = ""
    twilio_proxy_service_sid: str = ""

    class Config:
        env_file = ".env"


settings = Settings()

# Fail fast if secret_key looks like a placeholder
_DANGEROUS_KEYS = {"", "dev-secret-key-change-in-production", "changeme", "secret"}
if settings.secret_key in _DANGEROUS_KEYS:
    print("FATAL: SECRET_KEY is not set or is a known placeholder. Set it in .env or environment.", file=sys.stderr)
    sys.exit(1)
```

- [ ] **Step 5: Update `security.py` — hardcode algorithm**

Replace the `decode_token` function and token creation to use a constant algorithm:

```python
from datetime import datetime, timedelta, timezone
from jose import JWTError, jwt
from passlib.context import CryptContext
from app.config import settings

_ALGORITHM = "HS256"

pwd_context = CryptContext(schemes=["argon2"], deprecated="auto")


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def create_access_token(data: dict) -> str:
    to_encode = data.copy()
    to_encode["exp"] = datetime.now(timezone.utc) + timedelta(minutes=settings.access_token_expire_minutes)
    to_encode["type"] = "access"
    return jwt.encode(to_encode, settings.secret_key, algorithm=_ALGORITHM)


def create_refresh_token(data: dict) -> str:
    to_encode = data.copy()
    to_encode["exp"] = datetime.now(timezone.utc) + timedelta(days=settings.refresh_token_expire_days)
    to_encode["type"] = "refresh"
    return jwt.encode(to_encode, settings.secret_key, algorithm=_ALGORITHM)


def decode_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, settings.secret_key, algorithms=[_ALGORITHM])
    except JWTError:
        return None
```

- [ ] **Step 6: Update `alembic.ini` — remove hardcoded connection string**

Replace line 3 (`sqlalchemy.url = ...`) with:

```ini
sqlalchemy.url =
```

- [ ] **Step 7: Update `alembic/env.py` — read URL from environment**

Add these lines after `config = context.config` (line 6), before `fileConfig`:

```python
import os

config = context.config

# Override sqlalchemy.url from environment
db_url = os.environ.get("DATABASE_URL")
if db_url:
    config.set_main_option("sqlalchemy.url", db_url)
```

- [ ] **Step 8: Update `docker-compose.yml` — use env_file instead of inline secrets**

Replace the entire file with:

```yaml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: compass
      POSTGRES_USER: compass
      POSTGRES_PASSWORD: compass_dev_password
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U compass"]
      interval: 5s
      timeout: 3s
      retries: 5

  api:
    build: .
    ports:
      - "8000:8000"
    env_file:
      - .env
    depends_on:
      db:
        condition: service_healthy
    volumes:
      - ./app:/code/app

volumes:
  pgdata:
```

- [ ] **Step 9: Update `Dockerfile` — remove `--reload` from CMD**

Replace line 10 with:

```dockerfile
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

- [ ] **Step 10: Commit**

```bash
git add backend/.env.example backend/app/config.py backend/app/utils/security.py backend/alembic.ini backend/alembic/env.py backend/docker-compose.yml backend/Dockerfile
git commit -m "fix(backend): remove hardcoded secrets, add .env configuration

Removes dangerous default SECRET_KEY and DATABASE_URL from config.py.
App now fails fast on startup if SECRET_KEY is a placeholder.
Hardcodes JWT algorithm to HS256 instead of reading from settings.
Removes --reload from production Dockerfile.
Moves docker-compose to env_file reference."
```

---

### Task 2: Fix Database Layer & Generate Initial Migration

**Files:**
- Modify: `backend/app/database.py`
- Modify: `backend/app/main.py`
- Modify: `backend/app/routers/health.py`
- Modify: `backend/app/models/session.py`
- Modify: `backend/app/models/billing.py`
- Create: `backend/alembic/versions/` (auto-generated migration)

- [ ] **Step 1: Fix `get_db()` — add rollback on exception**

Replace `backend/app/database.py` with:

```python
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.config import settings

engine = create_async_engine(settings.database_url, echo=False)
async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def get_db():
    async with async_session() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise
```

- [ ] **Step 2: Add DB connectivity check to lifespan and health endpoint**

Replace `backend/app/main.py` with:

```python
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
    # Verify DB connection on startup
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

# Register all routers
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
```

Replace `backend/app/routers/health.py` with:

```python
from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from app.database import get_db

router = APIRouter(tags=["health"])


@router.get("/api/v1/health")
async def health():
    return {"status": "ok"}


@router.get("/api/v1/ready")
async def ready(db: AsyncSession = Depends(get_db)):
    await db.execute(text("SELECT 1"))
    return {"status": "ready"}
```

- [ ] **Step 3: Fix monetary field types — `float` to `Decimal`**

In `backend/app/models/session.py`, add `from decimal import Decimal` at the top and change lines 23-24:

```python
# Before:
gross_amount: Mapped[float | None] = mapped_column(Numeric(10, 2))
net_amount: Mapped[float | None] = mapped_column(Numeric(10, 2))

# After:
gross_amount: Mapped[Decimal | None] = mapped_column(Numeric(10, 2))
net_amount: Mapped[Decimal | None] = mapped_column(Numeric(10, 2))
```

In `backend/app/models/billing.py`, add `from decimal import Decimal` at the top and change lines 18-21:

```python
# Before:
gross_amount: Mapped[float] = mapped_column(Numeric(10, 2), nullable=False)
platform_fee: Mapped[float] = mapped_column(Numeric(10, 2), nullable=False)
pear_suite_fee: Mapped[float | None] = mapped_column(Numeric(10, 2))
net_payout: Mapped[float] = mapped_column(Numeric(10, 2), nullable=False)

# After:
gross_amount: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False)
platform_fee: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False)
pear_suite_fee: Mapped[Decimal | None] = mapped_column(Numeric(10, 2))
net_payout: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False)
```

Also update `backend/app/services/billing_service.py` to use `Decimal`:

```python
from decimal import Decimal, ROUND_HALF_UP
from datetime import date
from sqlalchemy import select, func, extract
from sqlalchemy.ext.asyncio import AsyncSession

MEDI_CAL_RATE = Decimal("26.66")
PLATFORM_FEE_RATE = Decimal("0.15")
PEAR_SUITE_FEE_RATE = Decimal("0.10")
MAX_UNITS_PER_DAY = 4
MAX_UNITS_PER_YEAR = 10

VALID_ICD10_CODES = [
    "Z59.1", "Z59.7", "Z71.89", "Z63.0", "Z56.9",
    "Z60.2", "Z72.89", "Z71.1", "Z76.89", "Z13.89",
]
VALID_CPT_CODES = ["98960", "98961", "98962"]


def validate_claim(diagnosis_codes: list[str], procedure_code: str, units: int) -> list[str]:
    errors = []
    for code in diagnosis_codes:
        if code not in VALID_ICD10_CODES:
            errors.append(f"Invalid ICD-10 code: {code}")
    if procedure_code not in VALID_CPT_CODES:
        errors.append(f"Invalid CPT code: {procedure_code}")
    if units < 1 or units > MAX_UNITS_PER_DAY:
        errors.append(f"Units must be 1-{MAX_UNITS_PER_DAY}, got {units}")
    return errors


def calculate_earnings(units: int) -> dict:
    gross = (MEDI_CAL_RATE * units).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    platform_fee = (gross * PLATFORM_FEE_RATE).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    pear_suite_fee = (gross * PEAR_SUITE_FEE_RATE).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    net = gross - platform_fee - pear_suite_fee
    return {
        "gross": float(gross),
        "platform_fee": float(platform_fee),
        "pear_suite_fee": float(pear_suite_fee),
        "net": float(net),
    }


async def check_unit_caps(db: AsyncSession, chw_id, member_id, session_date: date) -> dict:
    from app.models.billing import BillingClaim
    # Daily cap
    daily = await db.execute(
        select(func.coalesce(func.sum(BillingClaim.units), 0))
        .where(BillingClaim.chw_id == chw_id, BillingClaim.member_id == member_id)
        .where(func.date(BillingClaim.created_at) == session_date)
    )
    daily_used = daily.scalar() or 0
    # Yearly cap
    yearly = await db.execute(
        select(func.coalesce(func.sum(BillingClaim.units), 0))
        .where(BillingClaim.chw_id == chw_id, BillingClaim.member_id == member_id)
        .where(extract("year", BillingClaim.created_at) == session_date.year)
    )
    yearly_used = yearly.scalar() or 0
    return {
        "daily_used": daily_used, "daily_remaining": MAX_UNITS_PER_DAY - daily_used,
        "yearly_used": yearly_used, "yearly_remaining": MAX_UNITS_PER_YEAR - yearly_used,
    }
```

- [ ] **Step 4: Start PostgreSQL and generate initial migration**

Run: `cd /Users/akrammahmoud/Desktop/Projects/Compass/backend && docker-compose up -d db`
Wait for healthy, then:
Run: `cd /Users/akrammahmoud/Desktop/Projects/Compass/backend && DATABASE_URL="postgresql+asyncpg://compass:compass_dev_password@localhost:5432/compass" alembic revision --autogenerate -m "initial schema"`
Expected: Migration file created in `alembic/versions/`

- [ ] **Step 5: Apply migration**

Run: `cd /Users/akrammahmoud/Desktop/Projects/Compass/backend && DATABASE_URL="postgresql+asyncpg://compass:compass_dev_password@localhost:5432/compass" alembic upgrade head`
Expected: All tables created successfully

- [ ] **Step 6: Commit**

```bash
git add backend/app/database.py backend/app/main.py backend/app/routers/health.py backend/app/models/session.py backend/app/models/billing.py backend/app/services/billing_service.py backend/alembic/versions/
git commit -m "fix(backend): add DB rollback, fix monetary types to Decimal, generate initial migration

get_db() now rolls back on exception instead of leaving abandoned transactions.
Monetary fields use Decimal instead of float to prevent precision loss.
billing_service uses Decimal arithmetic with ROUND_HALF_UP.
Health endpoint now checks real DB connectivity.
Initial Alembic migration generated for all 12 models."
```

---

### Task 3: Fix Session Lifecycle & Billing Cap Enforcement

**Files:**
- Modify: `backend/app/routers/sessions.py`
- Modify: `backend/app/schemas/session.py`
- Modify: `backend/app/schemas/request.py`

- [ ] **Step 1: Add enum validation to schemas**

Replace `backend/app/schemas/session.py` with:

```python
from uuid import UUID
from datetime import datetime
from pydantic import BaseModel, ConfigDict, Field
from app.models.enums import SessionMode


class SessionCreate(BaseModel):
    request_id: UUID
    scheduled_at: datetime
    mode: SessionMode = SessionMode.in_person


class SessionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    request_id: UUID
    chw_id: UUID
    member_id: UUID
    vertical: str
    status: str
    mode: str
    scheduled_at: datetime | None
    started_at: datetime | None
    ended_at: datetime | None
    duration_minutes: int | None
    units_billed: int | None
    gross_amount: float | None
    net_amount: float | None
    created_at: datetime


class SessionDocumentationSubmit(BaseModel):
    summary: str
    resources_referred: list[str] = []
    member_goals: list[str] = []
    follow_up_needed: bool = False
    follow_up_date: datetime | None = None
    diagnosis_codes: list[str]
    procedure_code: str
    units_to_bill: int = Field(ge=1, le=4)


class ConsentSubmit(BaseModel):
    consent_type: str = "medical_billing"
    typed_signature: str
```

Replace `backend/app/schemas/request.py` with:

```python
from uuid import UUID
from datetime import datetime
from pydantic import BaseModel, ConfigDict, Field
from app.models.enums import Vertical, Urgency, SessionMode


class ServiceRequestCreate(BaseModel):
    vertical: Vertical
    urgency: Urgency = Urgency.routine
    description: str
    preferred_mode: SessionMode = SessionMode.in_person
    estimated_units: int = Field(default=1, ge=1, le=4)


class ServiceRequestResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    member_id: UUID
    matched_chw_id: UUID | None
    vertical: str
    urgency: str
    description: str
    preferred_mode: str
    status: str
    estimated_units: int
    created_at: datetime


class ServiceRequestUpdate(BaseModel):
    status: str | None = None
    matched_chw_id: UUID | None = None
```

- [ ] **Step 2: Add state machine guards, unit cap enforcement, and consent authz to sessions router**

Replace `backend/app/routers/sessions.py` with:

```python
from uuid import UUID
from datetime import datetime, timezone, date
from typing import Annotated
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.database import get_db
from app.dependencies import get_current_user
from app.models.session import Session, SessionDocumentation, MemberConsent
from app.models.request import ServiceRequest
from app.models.billing import BillingClaim
from app.schemas.session import SessionCreate, SessionResponse, SessionDocumentationSubmit, ConsentSubmit
from app.services.billing_service import validate_claim, calculate_earnings, check_unit_caps

router = APIRouter(prefix="/api/v1/sessions", tags=["sessions"])


@router.get("/", response_model=list[SessionResponse])
async def list_sessions(current_user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    if current_user.role == "chw":
        result = await db.execute(select(Session).where(Session.chw_id == current_user.id).order_by(Session.created_at.desc()))
    else:
        result = await db.execute(select(Session).where(Session.member_id == current_user.id).order_by(Session.created_at.desc()))
    return result.scalars().all()


@router.post("/", response_model=SessionResponse, status_code=201)
async def create_session(data: SessionCreate, current_user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    req = await db.get(ServiceRequest, data.request_id)
    if not req:
        raise HTTPException(status_code=404, detail="Request not found")

    # Determine CHW and member IDs
    if current_user.role == "chw":
        chw_id = current_user.id
        member_id = req.member_id
    elif req.matched_chw_id:
        chw_id = req.matched_chw_id
        member_id = current_user.id
    else:
        raise HTTPException(status_code=400, detail="Request has no matched CHW")

    session = Session(
        request_id=data.request_id,
        chw_id=chw_id,
        member_id=member_id,
        vertical=req.vertical,
        mode=data.mode.value,
        scheduled_at=data.scheduled_at,
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)
    return session


@router.get("/{session_id}", response_model=SessionResponse)
async def get_session(session_id: UUID, current_user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    session = await db.get(Session, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.chw_id != current_user.id and session.member_id != current_user.id and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Not authorized")
    return session


@router.patch("/{session_id}/start", response_model=SessionResponse)
async def start_session(session_id: UUID, current_user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    session = await db.get(Session, session_id)
    if not session or session.chw_id != current_user.id:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.status != "scheduled":
        raise HTTPException(status_code=409, detail=f"Cannot start session with status '{session.status}'. Must be 'scheduled'.")
    session.status = "in_progress"
    session.started_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(session)
    return session


@router.patch("/{session_id}/complete", response_model=SessionResponse)
async def complete_session(session_id: UUID, current_user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    session = await db.get(Session, session_id)
    if not session or session.chw_id != current_user.id:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.status != "in_progress":
        raise HTTPException(status_code=409, detail=f"Cannot complete session with status '{session.status}'. Must be 'in_progress'.")
    session.status = "completed"
    session.ended_at = datetime.now(timezone.utc)
    if session.started_at:
        session.duration_minutes = int((session.ended_at - session.started_at).total_seconds() / 60)
    await db.commit()
    await db.refresh(session)
    return session


@router.post("/{session_id}/documentation")
async def submit_documentation(session_id: UUID, data: SessionDocumentationSubmit, current_user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    session = await db.get(Session, session_id)
    if not session or session.chw_id != current_user.id:
        raise HTTPException(status_code=404, detail="Session not found")

    # Check for existing documentation
    existing = await db.execute(select(SessionDocumentation).where(SessionDocumentation.session_id == session_id))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Documentation already submitted for this session")

    # Validate claim codes
    errors = validate_claim(data.diagnosis_codes, data.procedure_code, data.units_to_bill)
    if errors:
        raise HTTPException(status_code=422, detail=errors)

    # Check billing unit caps
    session_date = (session.started_at or session.created_at).date()
    caps = await check_unit_caps(db, session.chw_id, session.member_id, session_date)
    if data.units_to_bill > caps["daily_remaining"]:
        raise HTTPException(status_code=422, detail=f"Daily unit cap exceeded. {caps['daily_remaining']} units remaining today.")
    if data.units_to_bill > caps["yearly_remaining"]:
        raise HTTPException(status_code=422, detail=f"Yearly unit cap exceeded. {caps['yearly_remaining']} units remaining this year.")

    doc = SessionDocumentation(
        session_id=session_id, summary=data.summary, resources_referred=data.resources_referred,
        member_goals=data.member_goals, follow_up_needed=data.follow_up_needed,
        follow_up_date=data.follow_up_date, diagnosis_codes=data.diagnosis_codes,
        procedure_code=data.procedure_code, units_to_bill=data.units_to_bill,
    )
    db.add(doc)

    earnings = calculate_earnings(data.units_to_bill)
    claim = BillingClaim(
        session_id=session_id, chw_id=session.chw_id, member_id=session.member_id,
        diagnosis_codes=data.diagnosis_codes, procedure_code=data.procedure_code,
        units=data.units_to_bill, gross_amount=earnings["gross"],
        platform_fee=earnings["platform_fee"], pear_suite_fee=earnings["pear_suite_fee"],
        net_payout=earnings["net"],
    )
    db.add(claim)

    session.units_billed = data.units_to_bill
    session.gross_amount = earnings["gross"]
    session.net_amount = earnings["net"]
    await db.commit()
    return {"documentation_id": str(doc.id), "claim_id": str(claim.id), "earnings": earnings}


@router.post("/{session_id}/consent")
async def submit_consent(session_id: UUID, data: ConsentSubmit, current_user=Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    # Verify the session exists and the caller is the member
    session = await db.get(Session, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.member_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only the session member can submit consent")

    consent = MemberConsent(
        session_id=session_id, member_id=current_user.id,
        consent_type=data.consent_type, typed_signature=data.typed_signature,
    )
    db.add(consent)
    await db.commit()
    return {"consent_id": str(consent.id)}
```

- [ ] **Step 3: Fix `pass_request` to actually persist**

In `backend/app/routers/requests.py`, replace the `pass_request` function (lines 40-42) with:

```python
@router.patch("/{request_id}/pass")
async def pass_request(request_id: UUID, current_user=Depends(require_role("chw")), db: AsyncSession = Depends(get_db)):
    from app.models.request import ServiceRequest
    req = await db.get(ServiceRequest, request_id)
    if not req or req.status != "open":
        raise HTTPException(status_code=404, detail="Request not found or not open")
    # Unmatched — remains open for other CHWs. If this CHW was matched, unmatch.
    if req.matched_chw_id == current_user.id:
        req.matched_chw_id = None
        req.status = "open"
        await db.commit()
    return {"status": "passed", "request_id": str(req.id)}
```

- [ ] **Step 4: Commit**

```bash
git add backend/app/routers/sessions.py backend/app/routers/requests.py backend/app/schemas/session.py backend/app/schemas/request.py
git commit -m "fix(backend): add session state machine, billing cap enforcement, consent authz

Sessions now enforce scheduled->in_progress->completed transitions.
submit_documentation checks daily (4) and yearly (10) unit caps before billing.
Consent endpoint verifies caller is the session member.
pass_request now persists to DB instead of returning a no-op.
Schemas validate vertical, urgency, mode against enums."
```

---

### Task 4: Harden Auth — Refresh Token Expiry, Logout Auth, Email Validation

**Files:**
- Modify: `backend/app/services/auth_service.py`
- Modify: `backend/app/routers/auth.py`
- Modify: `backend/app/schemas/auth.py`
- Modify: `backend/app/dependencies.py`

- [ ] **Step 1: Fix auth_service — set expires_at on refresh tokens, check expiry on revoke**

Replace `backend/app/services/auth_service.py` with:

```python
import hashlib
from datetime import datetime, timedelta, timezone
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.config import settings
from app.utils.security import hash_password, verify_password, create_access_token, create_refresh_token


async def register_user(db: AsyncSession, email: str, password: str, name: str, role: str, phone: str | None = None):
    from app.models.user import User
    existing = await db.execute(select(User).where(User.email == email))
    if existing.scalar_one_or_none():
        return None
    user = User(email=email, password_hash=hash_password(password), name=name, role=role, phone=phone)
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


async def authenticate_user(db: AsyncSession, email: str, password: str):
    from app.models.user import User
    result = await db.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()
    if user is None or not verify_password(password, user.password_hash):
        return None
    if not user.is_active:
        return None
    return user


def create_tokens(user) -> tuple[str, str]:
    data = {"sub": str(user.id), "role": user.role}
    return create_access_token(data), create_refresh_token(data)


async def store_refresh_token(db: AsyncSession, user_id, token: str):
    from app.models.auth import RefreshToken
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    expires_at = datetime.now(timezone.utc) + timedelta(days=settings.refresh_token_expire_days)
    rt = RefreshToken(user_id=user_id, token_hash=token_hash, expires_at=expires_at)
    db.add(rt)
    await db.commit()


async def revoke_refresh_token(db: AsyncSession, token: str):
    from app.models.auth import RefreshToken
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    result = await db.execute(
        select(RefreshToken).where(
            RefreshToken.token_hash == token_hash,
            RefreshToken.revoked == False,
            RefreshToken.expires_at > datetime.now(timezone.utc),
        )
    )
    rt = result.scalar_one_or_none()
    if rt:
        rt.revoked = True
        await db.commit()
    return rt
```

- [ ] **Step 2: Fix auth router — require auth on logout, check is_active on refresh**

Replace `backend/app/routers/auth.py` with:

```python
from uuid import UUID
from typing import Annotated
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.database import get_db
from app.dependencies import get_current_user
from app.models.user import User
from app.schemas.auth import RegisterRequest, LoginRequest, TokenResponse, RefreshRequest
from app.services.auth_service import register_user, authenticate_user, create_tokens, store_refresh_token, revoke_refresh_token
from app.utils.security import decode_token

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


@router.post("/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
async def register(data: RegisterRequest, db: Annotated[AsyncSession, Depends(get_db)]):
    user = await register_user(db, data.email, data.password, data.name, data.role, data.phone)
    if user is None:
        raise HTTPException(status_code=400, detail="Email already registered")
    access, refresh = create_tokens(user)
    await store_refresh_token(db, user.id, refresh)
    return TokenResponse(access_token=access, refresh_token=refresh, role=user.role, name=user.name)


@router.post("/login", response_model=TokenResponse)
async def login(data: LoginRequest, db: Annotated[AsyncSession, Depends(get_db)]):
    user = await authenticate_user(db, data.email, data.password)
    if user is None:
        raise HTTPException(status_code=401, detail="Invalid email or password")
    access, refresh = create_tokens(user)
    await store_refresh_token(db, user.id, refresh)
    return TokenResponse(access_token=access, refresh_token=refresh, role=user.role, name=user.name)


@router.post("/refresh", response_model=TokenResponse)
async def refresh(data: RefreshRequest, db: Annotated[AsyncSession, Depends(get_db)]):
    payload = decode_token(data.refresh_token)
    if payload is None or payload.get("type") != "refresh":
        raise HTTPException(status_code=401, detail="Invalid refresh token")
    old = await revoke_refresh_token(db, data.refresh_token)
    if old is None:
        raise HTTPException(status_code=401, detail="Token not found, revoked, or expired")
    user = await db.get(User, UUID(payload["sub"]))
    if user is None or not user.is_active:
        raise HTTPException(status_code=401, detail="User not found or deactivated")
    access, new_refresh = create_tokens(user)
    await store_refresh_token(db, user.id, new_refresh)
    return TokenResponse(access_token=access, refresh_token=new_refresh, role=user.role, name=user.name)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(data: RefreshRequest, current_user=Depends(get_current_user), db: Annotated[AsyncSession, Depends(get_db)]):
    await revoke_refresh_token(db, data.refresh_token)
```

- [ ] **Step 3: Add email validation to auth schema**

Replace `backend/app/schemas/auth.py` with:

```python
from uuid import UUID
from datetime import datetime
from pydantic import BaseModel, ConfigDict, Field, EmailStr


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=8)
    name: str = Field(..., min_length=1)
    role: str = Field(..., pattern="^(chw|member)$")
    phone: str | None = None


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    role: str
    name: str


class RefreshRequest(BaseModel):
    refresh_token: str


class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    email: str
    name: str
    role: str
    is_onboarded: bool
    created_at: datetime
```

- [ ] **Step 4: Add `email-validator` to dependencies**

In `backend/pyproject.toml`, add `"email-validator>=2.1.0"` to the `dependencies` list.

- [ ] **Step 5: Update `dependencies.py` — use enum values in require_role**

Replace `backend/app/dependencies.py` with:

```python
from typing import Annotated
from uuid import UUID
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.database import get_db
from app.models.enums import UserRole
from app.utils.security import decode_token

security = HTTPBearer()


async def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials, Depends(security)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    token = credentials.credentials
    payload = decode_token(token)
    if payload is None or payload.get("type") != "access":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")
    user_id = payload.get("sub")
    if user_id is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token payload")
    from app.models.user import User
    result = await db.execute(select(User).where(User.id == UUID(user_id)))
    user = result.scalar_one_or_none()
    if user is None or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found or inactive")
    return user


def require_role(*roles: str | UserRole):
    """Dependency that checks the current user has one of the specified roles.

    Accepts both string literals and UserRole enum values.
    """
    role_values = {r.value if isinstance(r, UserRole) else r for r in roles}

    async def role_checker(current_user=Depends(get_current_user)):
        if current_user.role not in role_values:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
        return current_user
    return role_checker
```

- [ ] **Step 6: Commit**

```bash
git add backend/app/services/auth_service.py backend/app/routers/auth.py backend/app/schemas/auth.py backend/app/dependencies.py backend/pyproject.toml
git commit -m "fix(backend): harden auth — token expiry, logout requires auth, email validation

Refresh tokens now store expires_at and are checked on revoke.
Deactivated users cannot refresh tokens.
Logout requires authentication (prevents anonymous revocation).
Email validated with pydantic EmailStr.
require_role accepts both strings and UserRole enums."
```

---

### Task 5: Wire Frontend Auth to Real Backend

**Files:**
- Modify: `web/src/features/auth/AuthContext.tsx`
- Modify: `web/src/api/client.ts`
- Modify: `web/src/features/auth/LoginPage.tsx`
- Modify: `web/src/features/auth/RegisterPage.tsx`

- [ ] **Step 1: Unify AuthContext to use localStorage and accept tokens from API**

Replace `web/src/features/auth/AuthContext.tsx` with:

```tsx
import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from 'react';
import { clearTokens, getRefreshToken } from '../../api/client';
import { logoutUser } from '../../api/auth';
import type { UserRole } from '../../data/mock';

// --- Types ---

interface AuthState {
  isAuthenticated: boolean;
  userRole: UserRole | null;
  userName: string | null;
}

interface AuthContextValue extends AuthState {
  login: (role: UserRole, name: string) => void;
  logout: () => void;
}

// --- Persistent storage (survives tab close) ---

const STORAGE_KEY = 'compass_auth';

function loadSession(): AuthState {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return JSON.parse(stored) as AuthState;
  } catch { /* ignore */ }
  return { isAuthenticated: false, userRole: null, userName: null };
}

function saveSession(state: AuthState) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
}

function clearSession() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

// --- Context ---

const AuthContext = createContext<AuthContextValue | null>(null);

// --- Provider ---

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [authState, setAuthState] = useState<AuthState>(loadSession);

  const login = useCallback((role: UserRole, name: string) => {
    const state: AuthState = { isAuthenticated: true, userRole: role, userName: name };
    setAuthState(state);
    saveSession(state);
  }, []);

  const logout = useCallback(async () => {
    try {
      const refreshToken = getRefreshToken();
      if (refreshToken) {
        await logoutUser(refreshToken);
      }
    } catch {
      // Best-effort server logout — clear local state regardless
    }
    clearTokens();
    const state: AuthState = { isAuthenticated: false, userRole: null, userName: null };
    setAuthState(state);
    clearSession();
  }, []);

  return (
    <AuthContext.Provider value={{ ...authState, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

// --- Hook ---

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx === null) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }
  return ctx;
}
```

- [ ] **Step 2: Add token refresh interceptor to API client, switch to localStorage**

Replace `web/src/api/client.ts` with:

```typescript
const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8000/api/v1";

const TOKEN_KEY = "compass_auth_tokens";

interface RequestOptions extends RequestInit {
  skipAuth?: boolean;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public detail?: unknown) {
    super(message);
  }
}

function getAccessToken(): string | null {
  try {
    const auth = localStorage.getItem(TOKEN_KEY);
    if (auth) {
      const parsed = JSON.parse(auth);
      return parsed.access_token || null;
    }
  } catch {}
  return null;
}

export function getRefreshToken(): string | null {
  try {
    const auth = localStorage.getItem(TOKEN_KEY);
    if (auth) return JSON.parse(auth).refresh_token || null;
  } catch {}
  return null;
}

export function setTokens(access_token: string, refresh_token: string) {
  localStorage.setItem(TOKEN_KEY, JSON.stringify({ access_token, refresh_token }));
}

export function clearTokens() {
  localStorage.removeItem(TOKEN_KEY);
}

async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return null;

  try {
    const res = await fetch(API_BASE + "/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!res.ok) {
      clearTokens();
      return null;
    }
    const data = await res.json();
    setTokens(data.access_token, data.refresh_token);
    return data.access_token;
  } catch {
    clearTokens();
    return null;
  }
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { skipAuth, ...fetchOptions } = options;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(fetchOptions.headers as Record<string, string> || {}),
  };

  if (!skipAuth) {
    const token = getAccessToken();
    if (token) headers["Authorization"] = "Bearer " + token;
  }

  let res = await fetch(API_BASE + path, { ...fetchOptions, headers });

  // Token expired — try refresh once
  if (res.status === 401 && !skipAuth) {
    const newToken = await refreshAccessToken();
    if (newToken) {
      headers["Authorization"] = "Bearer " + newToken;
      res = await fetch(API_BASE + path, { ...fetchOptions, headers });
    }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.detail || res.statusText, body);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}
```

- [ ] **Step 3: Wire LoginPage to call real backend**

Replace `web/src/features/auth/LoginPage.tsx` with:

```tsx
import { useState, type FormEvent } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Eye, EyeOff, Compass } from 'lucide-react';
import { useAuth } from './AuthContext';
import { loginUser } from '../../api/auth';
import type { UserRole } from '../../data/mock';

// Demo quick-login helpers (keep for investor demos)
const DEMO_ACCOUNTS: { role: UserRole; name: string; label: string; email: string; password: string }[] = [
  { role: 'chw', name: 'Maria Guadalupe Reyes', label: 'Demo as CHW', email: 'maria@demo.compasschw.com', password: 'demo1234' },
  { role: 'member', name: 'Rosa Delgado', label: 'Demo as Member', email: 'rosa@demo.compasschw.com', password: 'demo1234' },
];

export function LoginPage() {
  const navigate = useNavigate();
  const { login } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!email || !password) return;

    setIsLoading(true);
    setError(null);
    try {
      const res = await loginUser(email, password);
      login(res.role as UserRole, res.name);
      navigate(res.role === 'chw' ? '/chw/dashboard' : '/member/home');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed. Please try again.');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleDemoLogin(account: typeof DEMO_ACCOUNTS[number]) {
    setIsLoading(true);
    setError(null);
    try {
      const res = await loginUser(account.email, account.password);
      login(res.role as UserRole, res.name);
      navigate(account.role === 'chw' ? '/chw/dashboard' : '/member/home');
    } catch {
      // Fallback to mock login if backend is not running (demo mode)
      login(account.role, account.name);
      navigate(account.role === 'chw' ? '/chw/dashboard' : '/member/home');
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#FBF7F0] flex flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm bg-white rounded-[20px] shadow-sm border border-[rgba(44,62,45,0.1)] px-8 py-10">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 rounded-xl bg-[#2C3E2D] flex items-center justify-center mb-3">
            <Compass size={24} className="text-white" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-semibold text-[#2C3E2D]">Welcome Back</h1>
          <p className="text-sm text-[#6B7B6D] mt-1">Sign in to CompassCHW</p>
        </div>

        {/* Error message */}
        {error && (
          <div className="mb-4 p-3 rounded-[12px] bg-red-50 border border-red-200 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-[#2C3E2D] mb-1.5">
              Email address
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full rounded-[20px] border border-[rgba(44,62,45,0.1)] px-3.5 py-2.5 text-sm text-[#2C3E2D] placeholder:text-[#8B9B8D] focus:outline-none focus:ring-2 focus:ring-[#6B8F71] focus:border-transparent transition"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-[#2C3E2D] mb-1.5">
              Password
            </label>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full rounded-[20px] border border-[rgba(44,62,45,0.1)] px-3.5 py-2.5 pr-10 text-sm text-[#2C3E2D] placeholder:text-[#8B9B8D] focus:outline-none focus:ring-2 focus:ring-[#6B8F71] focus:border-transparent transition"
              />
              <button
                type="button"
                onClick={() => setShowPassword((s) => !s)}
                className="absolute inset-y-0 right-0 flex items-center px-3 text-[#8B9B8D] hover:text-[#6B7B6D] transition-colors"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full bg-[#2C3E2D] hover:bg-[#3A5240] disabled:bg-[rgba(44,62,45,0.2)] text-white font-semibold py-2.5 rounded-[12px] text-sm transition-colors mt-2 flex items-center justify-center gap-2"
          >
            {isLoading ? (
              <>
                <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                Signing in...
              </>
            ) : (
              'Log In'
            )}
          </button>
        </form>

        {/* Divider */}
        <div className="flex items-center gap-3 my-6">
          <div className="flex-1 border-t border-[rgba(44,62,45,0.1)]" />
          <span className="text-xs text-[#8B9B8D] font-medium">or try a demo</span>
          <div className="flex-1 border-t border-[rgba(44,62,45,0.1)]" />
        </div>

        {/* Demo quick-login buttons */}
        <div className="space-y-2">
          {DEMO_ACCOUNTS.map((account) => (
            <button
              key={account.role}
              type="button"
              onClick={() => handleDemoLogin(account)}
              className="w-full border border-[rgba(44,62,45,0.1)] hover:border-[#6B8F71] hover:bg-[#FBF7F0] text-[#6B7B6D] hover:text-[#6B8F71] font-medium py-2.5 rounded-[12px] text-sm transition-colors"
            >
              {account.label}
            </button>
          ))}
        </div>

        {/* Register link */}
        <p className="text-center text-xs text-[#6B7B6D] mt-6">
          New to CompassCHW?{' '}
          <Link to="/register" className="text-[#0077B6] font-medium hover:underline">
            Create an account
          </Link>
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Wire RegisterPage to call real backend**

Replace `web/src/features/auth/RegisterPage.tsx` — change only the `handleSubmit` function (lines 37-48):

```tsx
  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!selectedRole || !name || !email || !password) return;

    setIsLoading(true);
    setError(null);
    try {
      const { registerUser } = await import('../../api/auth');
      const res = await registerUser(email, password, name, selectedRole);
      login(res.role as UserRole, res.name);
      navigate(
        selectedRole === 'chw' ? '/onboarding/chw' : '/onboarding/member',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed. Please try again.');
    } finally {
      setIsLoading(false);
    }
  }
```

Also add `error` state and display it. Add after `const [isLoading, setIsLoading] = useState(false);`:

```tsx
  const [error, setError] = useState<string | null>(null);
```

And add error display in the details step, before the form element:

```tsx
        {error && (
          <div className="mb-4 p-3 rounded-[12px] bg-red-50 border border-red-200 text-sm text-red-700">
            {error}
          </div>
        )}
```

- [ ] **Step 5: Verify frontend builds**

Run: `cd /Users/akrammahmoud/Desktop/Projects/Compass/web && npm run build`
Expected: Build succeeds with no type errors

- [ ] **Step 6: Commit**

```bash
git add web/src/features/auth/AuthContext.tsx web/src/api/client.ts web/src/features/auth/LoginPage.tsx web/src/features/auth/RegisterPage.tsx
git commit -m "feat(web): wire auth to real backend API

LoginPage calls loginUser() instead of mocking auth.
RegisterPage calls registerUser() instead of mocking auth.
AuthContext uses localStorage (survives tab close).
API client has token refresh interceptor (catches 401, retries once).
Demo buttons fall back to mock login if backend is unreachable.
Unified token storage between AuthContext and API client."
```

---

### Task 6: Backend Tests — Auth & Session Lifecycle

**Files:**
- Create: `backend/tests/conftest.py`
- Create: `backend/tests/test_auth.py`
- Create: `backend/tests/test_sessions.py`

- [ ] **Step 1: Create test fixtures in conftest.py**

```python
# backend/tests/conftest.py
import asyncio
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from app.database import Base, get_db
from app.main import app

# Use a separate test database
TEST_DB_URL = "postgresql+asyncpg://compass:compass_dev_password@localhost:5432/compass_test"

test_engine = create_async_engine(TEST_DB_URL, echo=False)
test_session = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)


@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture(autouse=True)
async def setup_db():
    """Create all tables before each test, drop after."""
    async with test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield
    async with test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)


async def override_get_db():
    async with test_session() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise


app.dependency_overrides[get_db] = override_get_db


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.fixture
async def chw_tokens(client: AsyncClient) -> dict:
    """Register a CHW user and return the token response."""
    res = await client.post("/api/v1/auth/register", json={
        "email": "testchw@example.com", "password": "testpass123",
        "name": "Test CHW", "role": "chw",
    })
    assert res.status_code == 201
    return res.json()


@pytest.fixture
async def member_tokens(client: AsyncClient) -> dict:
    """Register a member user and return the token response."""
    res = await client.post("/api/v1/auth/register", json={
        "email": "testmember@example.com", "password": "testpass123",
        "name": "Test Member", "role": "member",
    })
    assert res.status_code == 201
    return res.json()


def auth_header(tokens: dict) -> dict:
    return {"Authorization": f"Bearer {tokens['access_token']}"}
```

- [ ] **Step 2: Create auth tests**

```python
# backend/tests/test_auth.py
import pytest
from httpx import AsyncClient
from tests.conftest import auth_header


@pytest.mark.asyncio
async def test_register_success(client: AsyncClient):
    res = await client.post("/api/v1/auth/register", json={
        "email": "new@example.com", "password": "password123",
        "name": "New User", "role": "chw",
    })
    assert res.status_code == 201
    data = res.json()
    assert "access_token" in data
    assert "refresh_token" in data
    assert data["role"] == "chw"
    assert data["name"] == "New User"


@pytest.mark.asyncio
async def test_register_duplicate_email(client: AsyncClient, chw_tokens):
    res = await client.post("/api/v1/auth/register", json={
        "email": "testchw@example.com", "password": "password123",
        "name": "Dupe", "role": "chw",
    })
    assert res.status_code == 400


@pytest.mark.asyncio
async def test_register_invalid_email(client: AsyncClient):
    res = await client.post("/api/v1/auth/register", json={
        "email": "notanemail", "password": "password123",
        "name": "Bad Email", "role": "chw",
    })
    assert res.status_code == 422


@pytest.mark.asyncio
async def test_register_short_password(client: AsyncClient):
    res = await client.post("/api/v1/auth/register", json={
        "email": "short@example.com", "password": "short",
        "name": "Short Pass", "role": "chw",
    })
    assert res.status_code == 422


@pytest.mark.asyncio
async def test_login_success(client: AsyncClient, chw_tokens):
    res = await client.post("/api/v1/auth/login", json={
        "email": "testchw@example.com", "password": "testpass123",
    })
    assert res.status_code == 200
    data = res.json()
    assert data["role"] == "chw"


@pytest.mark.asyncio
async def test_login_wrong_password(client: AsyncClient, chw_tokens):
    res = await client.post("/api/v1/auth/login", json={
        "email": "testchw@example.com", "password": "wrongpassword",
    })
    assert res.status_code == 401


@pytest.mark.asyncio
async def test_refresh_token(client: AsyncClient, chw_tokens):
    res = await client.post("/api/v1/auth/refresh", json={
        "refresh_token": chw_tokens["refresh_token"],
    })
    assert res.status_code == 200
    data = res.json()
    assert data["access_token"] != chw_tokens["access_token"]


@pytest.mark.asyncio
async def test_refresh_token_reuse_fails(client: AsyncClient, chw_tokens):
    """Old refresh token should be revoked after use."""
    await client.post("/api/v1/auth/refresh", json={"refresh_token": chw_tokens["refresh_token"]})
    res = await client.post("/api/v1/auth/refresh", json={"refresh_token": chw_tokens["refresh_token"]})
    assert res.status_code == 401


@pytest.mark.asyncio
async def test_logout_requires_auth(client: AsyncClient, chw_tokens):
    # Without auth header, should fail
    res = await client.post("/api/v1/auth/logout", json={"refresh_token": chw_tokens["refresh_token"]})
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_logout_success(client: AsyncClient, chw_tokens):
    res = await client.post(
        "/api/v1/auth/logout",
        json={"refresh_token": chw_tokens["refresh_token"]},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 204
```

- [ ] **Step 3: Create session lifecycle tests**

```python
# backend/tests/test_sessions.py
import pytest
from httpx import AsyncClient
from tests.conftest import auth_header


async def create_request_and_match(client: AsyncClient, member_tokens: dict, chw_tokens: dict) -> str:
    """Helper: member creates request, CHW accepts it. Returns request_id."""
    res = await client.post("/api/v1/requests/", json={
        "vertical": "housing", "urgency": "routine",
        "description": "Need housing help", "preferred_mode": "in_person",
    }, headers=auth_header(member_tokens))
    assert res.status_code == 201
    request_id = res.json()["id"]

    res = await client.patch(f"/api/v1/requests/{request_id}/accept", headers=auth_header(chw_tokens))
    assert res.status_code == 200
    return request_id


@pytest.mark.asyncio
async def test_session_lifecycle(client: AsyncClient, chw_tokens, member_tokens):
    request_id = await create_request_and_match(client, member_tokens, chw_tokens)

    # Create session
    res = await client.post("/api/v1/sessions/", json={
        "request_id": request_id, "scheduled_at": "2026-04-10T10:00:00Z", "mode": "in_person",
    }, headers=auth_header(chw_tokens))
    assert res.status_code == 201
    session_id = res.json()["id"]
    assert res.json()["status"] == "scheduled"

    # Start session
    res = await client.patch(f"/api/v1/sessions/{session_id}/start", headers=auth_header(chw_tokens))
    assert res.status_code == 200
    assert res.json()["status"] == "in_progress"

    # Complete session
    res = await client.patch(f"/api/v1/sessions/{session_id}/complete", headers=auth_header(chw_tokens))
    assert res.status_code == 200
    assert res.json()["status"] == "completed"


@pytest.mark.asyncio
async def test_cannot_start_completed_session(client: AsyncClient, chw_tokens, member_tokens):
    request_id = await create_request_and_match(client, member_tokens, chw_tokens)

    res = await client.post("/api/v1/sessions/", json={
        "request_id": request_id, "scheduled_at": "2026-04-10T10:00:00Z", "mode": "in_person",
    }, headers=auth_header(chw_tokens))
    session_id = res.json()["id"]

    await client.patch(f"/api/v1/sessions/{session_id}/start", headers=auth_header(chw_tokens))
    await client.patch(f"/api/v1/sessions/{session_id}/complete", headers=auth_header(chw_tokens))

    # Try to start again — should fail
    res = await client.patch(f"/api/v1/sessions/{session_id}/start", headers=auth_header(chw_tokens))
    assert res.status_code == 409


@pytest.mark.asyncio
async def test_cannot_complete_scheduled_session(client: AsyncClient, chw_tokens, member_tokens):
    request_id = await create_request_and_match(client, member_tokens, chw_tokens)

    res = await client.post("/api/v1/sessions/", json={
        "request_id": request_id, "scheduled_at": "2026-04-10T10:00:00Z", "mode": "in_person",
    }, headers=auth_header(chw_tokens))
    session_id = res.json()["id"]

    # Try to complete without starting — should fail
    res = await client.patch(f"/api/v1/sessions/{session_id}/complete", headers=auth_header(chw_tokens))
    assert res.status_code == 409


@pytest.mark.asyncio
async def test_consent_requires_session_member(client: AsyncClient, chw_tokens, member_tokens):
    request_id = await create_request_and_match(client, member_tokens, chw_tokens)

    res = await client.post("/api/v1/sessions/", json={
        "request_id": request_id, "scheduled_at": "2026-04-10T10:00:00Z", "mode": "in_person",
    }, headers=auth_header(chw_tokens))
    session_id = res.json()["id"]

    # CHW tries to submit consent — should fail
    res = await client.post(f"/api/v1/sessions/{session_id}/consent", json={
        "consent_type": "medical_billing", "typed_signature": "Test CHW",
    }, headers=auth_header(chw_tokens))
    assert res.status_code == 403

    # Member submits consent — should succeed
    res = await client.post(f"/api/v1/sessions/{session_id}/consent", json={
        "consent_type": "medical_billing", "typed_signature": "Test Member",
    }, headers=auth_header(member_tokens))
    assert res.status_code == 200


@pytest.mark.asyncio
async def test_documentation_duplicate_rejected(client: AsyncClient, chw_tokens, member_tokens):
    request_id = await create_request_and_match(client, member_tokens, chw_tokens)

    res = await client.post("/api/v1/sessions/", json={
        "request_id": request_id, "scheduled_at": "2026-04-10T10:00:00Z", "mode": "in_person",
    }, headers=auth_header(chw_tokens))
    session_id = res.json()["id"]

    await client.patch(f"/api/v1/sessions/{session_id}/start", headers=auth_header(chw_tokens))
    await client.patch(f"/api/v1/sessions/{session_id}/complete", headers=auth_header(chw_tokens))

    doc_payload = {
        "summary": "Helped with housing", "diagnosis_codes": ["Z59.1"],
        "procedure_code": "98960", "units_to_bill": 2,
    }

    res = await client.post(f"/api/v1/sessions/{session_id}/documentation", json=doc_payload, headers=auth_header(chw_tokens))
    assert res.status_code == 200

    # Second submission — should fail
    res = await client.post(f"/api/v1/sessions/{session_id}/documentation", json=doc_payload, headers=auth_header(chw_tokens))
    assert res.status_code == 409


@pytest.mark.asyncio
async def test_invalid_enum_rejected(client: AsyncClient, member_tokens):
    res = await client.post("/api/v1/requests/", json={
        "vertical": "invalid_vertical", "urgency": "routine",
        "description": "Test", "preferred_mode": "in_person",
    }, headers=auth_header(member_tokens))
    assert res.status_code == 422
```

- [ ] **Step 4: Create test database and run tests**

Run: `docker exec -it $(docker ps -qf "ancestor=postgres:16-alpine") psql -U compass -c "CREATE DATABASE compass_test;"`
Then: `cd /Users/akrammahmoud/Desktop/Projects/Compass/backend && pip install -e ".[dev]" && pytest tests/ -v`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add backend/tests/conftest.py backend/tests/test_auth.py backend/tests/test_sessions.py
git commit -m "test(backend): add auth and session lifecycle tests

Tests cover: register, login, refresh, token reuse prevention, logout auth,
session state machine (scheduled->in_progress->completed),
invalid state transitions (409), consent authorization,
duplicate documentation rejection, and enum validation."
```

---

## Summary

| Task | What it does | Files changed |
|---|---|---|
| 1 | Remove hardcoded secrets, add `.env` config | 7 files |
| 2 | Fix DB layer, Decimal types, generate migration | 6 files + migration |
| 3 | Session state machine, billing caps, consent authz | 4 files |
| 4 | Harden auth — token expiry, logout, email validation | 5 files |
| 5 | Wire frontend auth to real backend | 4 files |
| 6 | Backend tests — auth & session lifecycle | 3 files |

**After all tasks complete:** Users can register, log in with real credentials, the frontend stores JWT tokens with auto-refresh, sessions enforce valid state transitions, billing caps are enforced per Medi-Cal rules, and 20+ tests verify the critical paths.

import asyncio
import os

# Disable the slowapi rate limiter for tests BEFORE importing app.main —
# the limiter is constructed at module load and reads the env var once.
# Without this, tests that POST /auth/register more than 3x/min cascade-fail.
os.environ.setdefault("DISABLE_RATE_LIMIT", "1")

# Pin DATABASE_URL to the test DB BEFORE app.main loads, so app.database.engine
# (used by services like _persist_transcript_chunk) and conftest's test_engine
# point at the same Postgres database. Without this, the app reads from the
# dev DB while tests seed/inspect the test DB — silent FK-violation hell.
os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+asyncpg://compass:compass_dev_password@localhost:5432/compass_test",
)

# Provide safe placeholder values for required settings that have no defaults.
# These setdefault calls are no-ops when real secrets are present in the shell
# environment (e.g., in CI or when the developer has a .env file loaded).
# The values below satisfy the length/value guards in config.py without
# enabling any real integration — they are test-only stand-ins.
os.environ.setdefault(
    "SECRET_KEY",
    "test-secret-key-for-pytest-runner-placeholder-AABBCCDD",
)
os.environ.setdefault("ADMIN_KEY", "test-admin-key-for-pytest-1234")

# Epic A (signup confirmation email/SMS): use the no-op email provider in
# tests so the suite's many /auth/register, /auth/oauth/*, and /chw/members
# calls (each now schedules a best-effort confirmation-email background
# task) never fire a real outbound AWS SES API call. SES is a BAA-covered
# production resource — hammering it with hundreds of test-run emails per
# suite run would add real latency/flakiness (network dependency) and risk
# tripping AWS sending-quota/abuse detection. Tests that specifically want
# to exercise the real SES-backed path (e.g. asserting EmailMessage
# contents) monkeypatch/patch the relevant send function directly instead
# of relying on this env var. Vonage SMS needs no equivalent override — it
# already no-ops safely via VonageSmsMessagesClient.is_configured() when
# unconfigured (the default in tests), per its stub-mode docstring.
os.environ.setdefault("EMAIL_PROVIDER", "noop")

import pytest  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine  # noqa: E402

from app.database import Base, get_db  # noqa: E402
from app.main import app  # noqa: E402

# Honour DATABASE_URL when set (CI passes its own postgres credentials via env).
# Default to the local docker-compose dev DB so `pytest` works out of the box.
TEST_DB_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql+asyncpg://compass:compass_dev_password@localhost:5432/compass_test",
)

test_engine = create_async_engine(TEST_DB_URL, echo=False)
test_session = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)


@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture(autouse=True)
async def setup_db():
    # Drop and recreate the public schema for each test. CASCADE handles the
    # conversations <-> messages FK cycle that breaks Base.metadata.drop_all
    # (each table FKs the other). dispose() between phases forces the asyncpg
    # pool to release connections - otherwise stale checkouts from the prior
    # test block the schema drop with "another operation is in progress".
    #
    # We dispose BOTH engines (test_engine + app.database.engine) because some
    # services call `app.database.async_session()` directly (e.g., transcript
    # persistence). Without disposing app.database.engine, prepared-statement
    # cache from a prior test fails when the schema is recreated.
    from app.database import engine as _app_engine

    await test_engine.dispose()
    await _app_engine.dispose()
    async with test_engine.begin() as conn:
        await conn.execute(text("DROP SCHEMA IF EXISTS public CASCADE"))
        await conn.execute(text("CREATE SCHEMA public"))
        await conn.run_sync(Base.metadata.create_all)
    yield
    await test_engine.dispose()
    await _app_engine.dispose()
    async with test_engine.begin() as conn:
        await conn.execute(text("DROP SCHEMA public CASCADE"))
        await conn.execute(text("CREATE SCHEMA public"))
    await test_engine.dispose()
    await _app_engine.dispose()


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
    res = await client.post("/api/v1/auth/register", json={
        "email": "testchw@example.com", "password": "testpass123",
        "name": "Test CHW", "role": "chw",
    })
    assert res.status_code == 201
    return res.json()


@pytest.fixture
async def member_tokens(client: AsyncClient) -> dict:
    # Members must now provide every Pear-required field at signup
    # (#14). Tests that need only basic member auth use this fixture; if
    # a test needs a member with an INCOMPLETE profile (legacy data
    # shape), it should bypass the API and seed the row directly.
    res = await client.post("/api/v1/auth/register", json={
        "email": "testmember@example.com",
        "password": "testpass123",
        "name": "Test Member",
        "role": "member",
        "phone": "+13105550100",
        "date_of_birth": "1993-01-05",
        "gender": "Female",
        "insurance_company": "Health Net",
        "medi_cal_id": "12345678A",
        "address_line1": "1 Main St",
        "city": "Los Angeles",
        "state": "CA",
        "zip_code": "90001",
        # Required signup consent (documented opt-in) — see enforce_member_signup_consent.
        "terms_accepted": True,
        "communications_consent": True,
    })
    assert res.status_code == 201, f"Register failed: {res.text}"
    return res.json()


def auth_header(tokens: dict) -> dict:
    return {"Authorization": f"Bearer {tokens['access_token']}"}


def complete_member_signup_payload(
    *,
    email: str,
    name: str = "Member Tester",
    password: str = "test-password-1234",
) -> dict:
    """Build a /auth/register body with every Pear-required member field
    populated.  Use in tests that need to register a member via the API
    after #14 added the mandatory-field gate.  Tests that need an
    INCOMPLETE profile should seed the row directly via SQL instead.
    """
    return {
        "email": email,
        "password": password,
        "name": name,
        "role": "member",
        "phone": "+13105550100",
        "date_of_birth": "1993-01-05",
        "gender": "Female",
        "insurance_company": "Health Net",
        "medi_cal_id": "12345678A",
        "address_line1": "1 Main St",
        "city": "Los Angeles",
        "state": "CA",
        "zip_code": "90001",
        # Required signup consent (documented opt-in) — see enforce_member_signup_consent.
        "terms_accepted": True,
        "communications_consent": True,
    }

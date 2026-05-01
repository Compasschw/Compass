import asyncio
import os

# Disable the slowapi rate limiter for tests BEFORE importing app.main —
# the limiter is constructed at module load and reads the env var once.
# Without this, tests that POST /auth/register more than 3x/min cascade-fail.
os.environ.setdefault("DISABLE_RATE_LIMIT", "1")

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
    await test_engine.dispose()
    async with test_engine.begin() as conn:
        await conn.execute(text("DROP SCHEMA IF EXISTS public CASCADE"))
        await conn.execute(text("CREATE SCHEMA public"))
        await conn.run_sync(Base.metadata.create_all)
    yield
    await test_engine.dispose()
    async with test_engine.begin() as conn:
        await conn.execute(text("DROP SCHEMA public CASCADE"))
        await conn.execute(text("CREATE SCHEMA public"))
    await test_engine.dispose()


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
    res = await client.post("/api/v1/auth/register", json={
        "email": "testmember@example.com", "password": "testpass123",
        "name": "Test Member", "role": "member",
    })
    assert res.status_code == 201
    return res.json()


def auth_header(tokens: dict) -> dict:
    return {"Authorization": f"Bearer {tokens['access_token']}"}

import asyncio

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.database import Base, get_db
from app.main import app

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

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
    await client.post("/api/v1/auth/refresh", json={"refresh_token": chw_tokens["refresh_token"]})
    res = await client.post("/api/v1/auth/refresh", json={"refresh_token": chw_tokens["refresh_token"]})
    assert res.status_code == 401


@pytest.mark.asyncio
async def test_logout_requires_auth(client: AsyncClient, chw_tokens):
    res = await client.post("/api/v1/auth/logout", json={"refresh_token": chw_tokens["refresh_token"]})
    # FastAPI's HTTPBearer(auto_error=True) returns 401 on missing header in
    # current versions (was 403 in older releases). Either is a hard reject.
    assert res.status_code in (401, 403)


@pytest.mark.asyncio
async def test_logout_success(client: AsyncClient, chw_tokens):
    res = await client.post(
        "/api/v1/auth/logout",
        json={"refresh_token": chw_tokens["refresh_token"]},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 204

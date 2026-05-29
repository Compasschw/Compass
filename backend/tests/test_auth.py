import uuid

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


# ─── Signup-time profile provisioning (Phase 1A) ─────────────────────────────


@pytest.mark.asyncio
async def test_register_member_auto_creates_member_profile(client: AsyncClient):
    """A fresh member registration must seed an empty MemberProfile row so
    GET/PUT /member/profile work immediately without a 404 round-trip.
    """
    email = f"profile-test-member-{uuid.uuid4()}@example.com"
    register_res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": email,
            "password": "test-password-1234",
            "name": "Test Member",
            "role": "member",
        },
    )
    assert register_res.status_code == 201
    token = register_res.json()["access_token"]

    profile_res = await client.get(
        "/api/v1/member/profile",
        headers={"Authorization": f"Bearer {token}"},
    )
    # Must NOT 404 — profile row was created at signup.
    assert profile_res.status_code == 200
    body = profile_res.json()
    assert body["primary_language"] == "English"  # default
    assert body["zip_code"] is None
    # medi_cal_id is not surfaced in the response schema (PHI minimization)
    # but the underlying column exists and starts NULL — covered by the PUT
    # test below.


@pytest.mark.asyncio
async def test_register_chw_auto_creates_chw_profile(client: AsyncClient):
    """A fresh CHW registration must seed an empty CHWProfile row."""
    email = f"profile-test-chw-{uuid.uuid4()}@example.com"
    register_res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": email,
            "password": "test-password-1234",
            "name": "Test CHW",
            "role": "chw",
        },
    )
    assert register_res.status_code == 201
    token = register_res.json()["access_token"]

    profile_res = await client.get(
        "/api/v1/chw/profile",
        headers={"Authorization": f"Bearer {token}"},
    )
    # Must NOT 404 — profile row was created at signup.
    assert profile_res.status_code == 200


@pytest.mark.asyncio
async def test_register_member_rejects_single_token_name(client: AsyncClient):
    """Members must provide both first and last name — Pear Suite rejects
    members without lastName and we want the error surfaced at signup, not
    later via a silent background-sync failure. (#191)
    """
    res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": f"single-name-{uuid.uuid4()}@example.com",
            "password": "test-password-1234",
            "name": "Madonna",
            "role": "member",
        },
    )
    assert res.status_code == 422
    body = res.json()
    # Pydantic surfaces the validator error inside the standard 422 envelope.
    assert any(
        "first and last name" in str(err).lower()
        for err in body.get("detail", [])
    ), body


@pytest.mark.asyncio
async def test_register_member_rejects_whitespace_only_lastname(client: AsyncClient):
    """Trailing whitespace doesn't satisfy the two-token requirement. (#191)"""
    res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": f"trailing-space-{uuid.uuid4()}@example.com",
            "password": "test-password-1234",
            "name": "John   ",
            "role": "member",
        },
    )
    assert res.status_code == 422


@pytest.mark.asyncio
async def test_register_chw_allows_single_token_name(client: AsyncClient):
    """CHWs are not pushed to Pear, so the last-name gate doesn't apply. (#191)

    Keeps the door open for CHWs who go by a single mononym while still
    enforcing the rule for members.
    """
    res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": f"chw-mono-{uuid.uuid4()}@example.com",
            "password": "test-password-1234",
            "name": "Cher",
            "role": "chw",
        },
    )
    assert res.status_code == 201


@pytest.mark.asyncio
async def test_member_profile_put_creates_row_if_missing(client: AsyncClient, member_tokens):
    """Defensive cover for legacy accounts that registered before the
    signup-time profile provisioning landed: the PUT must upsert.
    """
    res = await client.put(
        "/api/v1/member/profile",
        headers=auth_header(member_tokens),
        json={"zip_code": "90210", "medi_cal_id": "9TEST12345"},
    )
    assert res.status_code == 200
    assert res.json()["zip_code"] == "90210"

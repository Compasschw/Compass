"""Tests for the magic-link passwordless auth flow.

Security invariants under test:
- Token issuance never leaks whether an email is registered (no enumeration).
- Tokens are single-use: a second verify on the same token is rejected.
- Expired tokens are rejected regardless of consumed state.
- Tampered / unknown tokens are rejected.
- Successful verify marks consumed_at and returns valid JWT credentials.
- Rate limiting is disabled for the test suite via DISABLE_RATE_LIMIT=1.
"""

import hashlib
import secrets
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.models.magic_link import MagicLinkToken
from app.models.user import User
from tests.conftest import test_session

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

MAGIC_REQUEST_URL = "/api/v1/auth/magic/request"
MAGIC_VERIFY_URL = "/api/v1/auth/magic/verify"

_CHW_EMAIL = "magiclinkchw@example.com"
_CHW_PASSWORD = "testpass123"


async def _register_chw(client: AsyncClient) -> dict:
    """Register a fresh CHW user and return its token payload."""
    res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": _CHW_EMAIL,
            "password": _CHW_PASSWORD,
            "name": "Magic CHW",
            "role": "chw",
        },
    )
    assert res.status_code == 201, res.text
    return res.json()


async def _insert_token(
    *,
    user_id,
    raw_token: str,
    expires_at: datetime,
    consumed_at: datetime | None = None,
) -> None:
    """Directly insert a MagicLinkToken row for white-box test scenarios."""
    token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
    async with test_session() as session:
        session.add(
            MagicLinkToken(
                user_id=user_id,
                token_hash=token_hash,
                expires_at=expires_at,
                consumed_at=consumed_at,
            )
        )
        await session.commit()


async def _get_user_id_by_email(email: str):
    """Fetch a user's UUID from the test DB."""
    async with test_session() as session:
        result = await session.execute(select(User).where(User.email == email))
        user = result.scalar_one_or_none()
        assert user is not None, f"User {email} not found in DB"
        return user.id


async def _fetch_token_row(raw_token: str) -> MagicLinkToken | None:
    """Retrieve a MagicLinkToken row by its raw (unhashed) value."""
    token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
    async with test_session() as session:
        result = await session.execute(
            select(MagicLinkToken).where(MagicLinkToken.token_hash == token_hash)
        )
        return result.scalar_one_or_none()


# ---------------------------------------------------------------------------
# Token issuance — POST /auth/magic/request
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_magic_request_existing_email_returns_202_and_creates_token_row(
    client: AsyncClient,
):
    """Requesting a magic link for a registered email returns 202 and persists a token."""
    await _register_chw(client)

    res = await client.post(MAGIC_REQUEST_URL, json={"email": _CHW_EMAIL})

    assert res.status_code == 202
    assert res.json().get("status") == "accepted"

    # A token row must exist for this user in the DB.
    user_id = await _get_user_id_by_email(_CHW_EMAIL)
    async with test_session() as session:
        result = await session.execute(
            select(MagicLinkToken).where(MagicLinkToken.user_id == user_id)
        )
        rows = result.scalars().all()

    assert len(rows) == 1, "Expected exactly one MagicLinkToken row after request"
    assert rows[0].consumed_at is None, "Newly issued token must not be pre-consumed"
    assert rows[0].expires_at > datetime.now(UTC), "Token must not already be expired"


@pytest.mark.asyncio
async def test_magic_request_unknown_email_returns_202_no_enumeration(
    client: AsyncClient,
):
    """Requesting a magic link for an unregistered email must still return 202.

    This prevents an attacker from probing which email addresses are registered.
    """
    # `.invalid` is a reserved TLD that pydantic's EmailStr rejects at the
    # validation layer (would 422). Use a normal-looking but unregistered
    # email so we exercise the "user does not exist" branch instead.
    res = await client.post(
        MAGIC_REQUEST_URL, json={"email": "nobody@example.com"}
    )

    assert res.status_code == 202
    assert res.json().get("status") == "accepted"


@pytest.mark.asyncio
async def test_magic_request_invalid_email_format_returns_422(client: AsyncClient):
    """Malformed email addresses must be rejected at the validation layer."""
    res = await client.post(MAGIC_REQUEST_URL, json={"email": "not-an-email"})

    assert res.status_code == 422


# ---------------------------------------------------------------------------
# Token verification — POST /auth/magic/verify
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_magic_verify_valid_token_returns_jwt_credentials(client: AsyncClient):
    """A fresh, unexpired, unconsumed token exchanges for access + refresh tokens."""
    await _register_chw(client)
    user_id = await _get_user_id_by_email(_CHW_EMAIL)

    raw_token = secrets.token_urlsafe(32)
    await _insert_token(
        user_id=user_id,
        raw_token=raw_token,
        expires_at=datetime.now(UTC) + timedelta(minutes=15),
    )

    res = await client.post(MAGIC_VERIFY_URL, json={"token": raw_token})

    assert res.status_code == 200
    data = res.json()
    assert "access_token" in data
    assert "refresh_token" in data
    assert data["role"] == "chw"
    assert data["name"] == "Magic CHW"


@pytest.mark.asyncio
async def test_magic_verify_sets_consumed_at_on_success(client: AsyncClient):
    """After a successful verify the token row must have consumed_at populated."""
    await _register_chw(client)
    user_id = await _get_user_id_by_email(_CHW_EMAIL)

    raw_token = secrets.token_urlsafe(32)
    await _insert_token(
        user_id=user_id,
        raw_token=raw_token,
        expires_at=datetime.now(UTC) + timedelta(minutes=15),
    )

    res = await client.post(MAGIC_VERIFY_URL, json={"token": raw_token})
    assert res.status_code == 200

    row = await _fetch_token_row(raw_token)
    assert row is not None
    assert row.consumed_at is not None, "consumed_at must be set after successful verify"


@pytest.mark.asyncio
async def test_magic_verify_already_consumed_token_returns_401(client: AsyncClient):
    """A token that has already been used must be rejected — single-use enforcement."""
    await _register_chw(client)
    user_id = await _get_user_id_by_email(_CHW_EMAIL)

    raw_token = secrets.token_urlsafe(32)
    # Insert with consumed_at already set, simulating a previously used token.
    await _insert_token(
        user_id=user_id,
        raw_token=raw_token,
        expires_at=datetime.now(UTC) + timedelta(minutes=15),
        consumed_at=datetime.now(UTC) - timedelta(seconds=30),
    )

    res = await client.post(MAGIC_VERIFY_URL, json={"token": raw_token})

    assert res.status_code == 401
    assert "already" in res.json()["detail"].lower()


@pytest.mark.asyncio
async def test_magic_verify_replaying_used_token_after_first_success_returns_401(
    client: AsyncClient,
):
    """Verifying the same token twice must fail on the second attempt."""
    await _register_chw(client)
    user_id = await _get_user_id_by_email(_CHW_EMAIL)

    raw_token = secrets.token_urlsafe(32)
    await _insert_token(
        user_id=user_id,
        raw_token=raw_token,
        expires_at=datetime.now(UTC) + timedelta(minutes=15),
    )

    first = await client.post(MAGIC_VERIFY_URL, json={"token": raw_token})
    assert first.status_code == 200, "First verify must succeed"

    second = await client.post(MAGIC_VERIFY_URL, json={"token": raw_token})
    assert second.status_code == 401, "Replay of a consumed token must be rejected"


@pytest.mark.asyncio
async def test_magic_verify_expired_token_returns_401(client: AsyncClient):
    """A token whose expires_at is in the past must be rejected."""
    await _register_chw(client)
    user_id = await _get_user_id_by_email(_CHW_EMAIL)

    raw_token = secrets.token_urlsafe(32)
    await _insert_token(
        user_id=user_id,
        raw_token=raw_token,
        expires_at=datetime.now(UTC) - timedelta(minutes=1),  # already expired
    )

    res = await client.post(MAGIC_VERIFY_URL, json={"token": raw_token})

    assert res.status_code == 401
    assert "expir" in res.json()["detail"].lower()


@pytest.mark.asyncio
async def test_magic_verify_tampered_token_returns_401(client: AsyncClient):
    """A token that was never issued (random bytes) must be rejected."""
    tampered = secrets.token_urlsafe(32)

    res = await client.post(MAGIC_VERIFY_URL, json={"token": tampered})

    assert res.status_code == 401


@pytest.mark.asyncio
async def test_magic_verify_empty_token_returns_422(client: AsyncClient):
    """An empty token string must fail schema validation before hitting business logic."""
    res = await client.post(MAGIC_VERIFY_URL, json={"token": ""})

    # FastAPI/Pydantic rejects empty strings on min_length constraints if
    # enforced; if not, the endpoint will return 401 (hash won't match any row).
    # Either is acceptable — the key requirement is it must NOT return 200.
    assert res.status_code in (401, 422)


# ---------------------------------------------------------------------------
# Rate limiting — disabled in tests via DISABLE_RATE_LIMIT=1
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_magic_request_rate_limit_disabled_in_tests(client: AsyncClient):
    """DISABLE_RATE_LIMIT=1 (set by conftest) must allow more than 3 rapid requests.

    The real limiter caps at 3/minute per IP. This test fires 5 requests and
    asserts none are throttled (all return 202), confirming the test-mode
    bypass is active. In production the 4th request would return 429.
    """
    await _register_chw(client)

    for i in range(5):
        res = await client.post(MAGIC_REQUEST_URL, json={"email": _CHW_EMAIL})
        assert res.status_code == 202, (
            f"Request {i + 1} returned {res.status_code}; "
            "rate limiter may not be disabled — check DISABLE_RATE_LIMIT env var"
        )

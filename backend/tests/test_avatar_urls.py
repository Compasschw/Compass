"""Tests for app.services.storage.avatar_urls.presigned_avatar_url.

Unit coverage (no DB, no network):
  U1. None → None.
  U2. Empty string → None.
  U3. Already-presigned URL (contains X-Amz-Signature) → returned unchanged.
  U4. External / non-S3 URL → returned unchanged.
  U5. Public-bucket URL (region form) → presigned URL with key and signature.
  U6. Public-bucket URL (global / no-region form) → presigned URL.
  U7. URL-encoded key characters are decoded before signing.
  U8. Signer error is swallowed; original stored value is returned.

Integration coverage (HTTP, DB):
  I1. GET /api/v1/member/profile — None stored → profile_picture_url is None.
  I2. GET /api/v1/member/profile — public-bucket URL stored → presigned GET URL
      returned (key present, X-Amz-Signature present).
  I3. GET /api/v1/member/profile — already-presigned URL stored → returned
      unchanged (no double-sign).
  I4. GET /api/v1/chw/profile — public-bucket URL stored → presigned GET URL.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from httpx import AsyncClient

from tests.conftest import auth_header

# ─── constants ────────────────────────────────────────────────────────────────

_BUCKET = "compass-public-dev"
_KEY = "avatars/abc.jpg"
_REGION = "us-west-2"

# The two virtual-hosted-style URL forms that should trigger signing.
_REGION_URL = f"https://{_BUCKET}.s3.{_REGION}.amazonaws.com/{_KEY}"
_GLOBAL_URL = f"https://{_BUCKET}.s3.amazonaws.com/{_KEY}"

# An already-presigned URL — must pass through unchanged.
_PRESIGNED_URL = (
    f"https://{_BUCKET}.s3.{_REGION}.amazonaws.com/{_KEY}"
    "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKID&X-Amz-Date=20260101T000000Z"
    "&X-Amz-Expires=604800&X-Amz-Signature=abc123"
)

_EXTERNAL_URL = "https://example.com/photo.png"

_FAKE_PRESIGNED = (
    f"https://{_BUCKET}.s3.{_REGION}.amazonaws.com/{_KEY}"
    "?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=FAKE&X-Amz-Date=20260101T000000Z"
    "&X-Amz-Expires=604800&X-Amz-Signature=fakesignature"
)


def _mock_s3_client(presigned_return: str = _FAKE_PRESIGNED) -> MagicMock:
    """Return a mock boto3 S3 client whose generate_presigned_url returns the given URL."""
    mock_client = MagicMock()
    mock_client.generate_presigned_url.return_value = presigned_return
    return mock_client


# ─── Unit tests ───────────────────────────────────────────────────────────────


def test_u1_none_returns_none() -> None:
    """U1 — None input → None output."""
    from app.services.storage.avatar_urls import presigned_avatar_url

    assert presigned_avatar_url(None) is None


def test_u2_empty_string_returns_none() -> None:
    """U2 — Empty string input → None output."""
    from app.services.storage.avatar_urls import presigned_avatar_url

    assert presigned_avatar_url("") is None


def test_u3_already_presigned_passthrough() -> None:
    """U3 — URL containing X-Amz-Signature is returned unchanged (no double-sign)."""
    from app.services.storage.avatar_urls import presigned_avatar_url

    result = presigned_avatar_url(_PRESIGNED_URL)
    assert result == _PRESIGNED_URL


def test_u4_external_url_passthrough() -> None:
    """U4 — External (non-S3) URL is returned unchanged."""
    from app.services.storage.avatar_urls import presigned_avatar_url

    result = presigned_avatar_url(_EXTERNAL_URL)
    assert result == _EXTERNAL_URL


def test_u5_public_bucket_region_url_is_presigned() -> None:
    """U5 — Region-form public-bucket URL → presigned URL with key and signature."""
    from app.services.storage.avatar_urls import presigned_avatar_url

    mock_client = _mock_s3_client()
    with patch("app.services.storage.avatar_urls.get_s3_client", return_value=mock_client):
        result = presigned_avatar_url(_REGION_URL)

    assert result is not None
    assert _KEY in result
    assert "X-Amz-Signature" in result

    # Verify the signer was called with correct bucket + key.
    mock_client.generate_presigned_url.assert_called_once_with(
        "get_object",
        Params={"Bucket": _BUCKET, "Key": _KEY},
        ExpiresIn=604_800,
    )


def test_u6_public_bucket_global_url_is_presigned() -> None:
    """U6 — Global-form public-bucket URL (no region segment) → presigned URL."""
    from app.services.storage.avatar_urls import presigned_avatar_url

    mock_client = _mock_s3_client()
    with patch("app.services.storage.avatar_urls.get_s3_client", return_value=mock_client):
        result = presigned_avatar_url(_GLOBAL_URL)

    assert result is not None
    assert "X-Amz-Signature" in result
    mock_client.generate_presigned_url.assert_called_once()


def test_u7_url_encoded_key_is_decoded() -> None:
    """U7 — Percent-encoded key characters are decoded before signing."""
    from app.services.storage.avatar_urls import presigned_avatar_url

    encoded_url = (
        f"https://{_BUCKET}.s3.{_REGION}.amazonaws.com/profiles/user%20id/avatar%2Bx.jpg"
    )
    expected_key = "profiles/user id/avatar+x.jpg"

    mock_client = _mock_s3_client()
    with patch("app.services.storage.avatar_urls.get_s3_client", return_value=mock_client):
        presigned_avatar_url(encoded_url)

    call_params = mock_client.generate_presigned_url.call_args
    assert call_params is not None
    assert call_params.kwargs["Params"]["Key"] == expected_key


def test_u8_signer_error_returns_stored_value() -> None:
    """U8 — If generate_presigned_url raises, the original stored URL is returned."""
    from app.services.storage.avatar_urls import presigned_avatar_url

    mock_client = MagicMock()
    mock_client.generate_presigned_url.side_effect = RuntimeError("signing failure")

    with patch("app.services.storage.avatar_urls.get_s3_client", return_value=mock_client):
        result = presigned_avatar_url(_REGION_URL)

    assert result == _REGION_URL


# ─── Integration tests ────────────────────────────────────────────────────────


async def _register_member(client: AsyncClient, email: str) -> dict:
    """Register a member with complete Pear-required fields."""
    res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": email,
            "password": "testpass123",
            "name": "Avatar Test Member",
            "role": "member",
            "phone": "+13105550101",
            "date_of_birth": "1990-06-15",
            "gender": "Female",
            "insurance_company": "Health Net",
            "medi_cal_id": "87654321A",
            "address_line1": "5 Main St",
            "city": "Los Angeles",
            "state": "CA",
            "zip_code": "90001",
        },
    )
    assert res.status_code == 201, res.text
    return res.json()


async def _set_profile_picture(
    client: AsyncClient, tokens: dict, url: str | None
) -> None:
    """PUT member profile with the given profile_picture_url."""
    res = await client.put(
        "/api/v1/member/profile",
        json={"profile_picture_url": url},
        headers=auth_header(tokens),
    )
    assert res.status_code == 200, res.text


@pytest.mark.asyncio
async def test_i1_none_stored_returns_none_in_response(
    client: AsyncClient,
) -> None:
    """I1 — None stored → profile_picture_url is None in GET /member/profile."""
    tokens = await _register_member(client, "avatar_i1@example.com")

    res = await client.get(
        "/api/v1/member/profile",
        headers=auth_header(tokens),
    )
    assert res.status_code == 200, res.text
    assert res.json()["profile_picture_url"] is None


@pytest.mark.asyncio
async def test_i2_public_bucket_url_is_presigned_in_response(
    client: AsyncClient,
) -> None:
    """I2 — Public-bucket URL stored → presigned GET URL returned (key + signature present)."""
    tokens = await _register_member(client, "avatar_i2@example.com")

    # Store the raw public-bucket URL.
    with patch(
        "app.services.storage.avatar_urls.get_s3_client",
        return_value=_mock_s3_client(_FAKE_PRESIGNED),
    ):
        await _set_profile_picture(client, tokens, _REGION_URL)

    # GET /member/profile — signer wraps the stored URL on read.
    with patch(
        "app.services.storage.avatar_urls.get_s3_client",
        return_value=_mock_s3_client(_FAKE_PRESIGNED),
    ):
        res = await client.get(
            "/api/v1/member/profile",
            headers=auth_header(tokens),
        )

    assert res.status_code == 200, res.text
    returned_url: str | None = res.json()["profile_picture_url"]
    assert returned_url is not None
    assert _KEY in returned_url, f"Key not found in: {returned_url}"
    assert "X-Amz-Signature" in returned_url, f"Signature not found in: {returned_url}"


@pytest.mark.asyncio
async def test_i3_already_presigned_url_is_not_double_signed(
    client: AsyncClient,
) -> None:
    """I3 — Already-presigned URL stored → returned unchanged, no second signing call."""
    tokens = await _register_member(client, "avatar_i3@example.com")

    # Store an already-presigned URL directly via PUT.
    mock_client = _mock_s3_client()
    with patch("app.services.storage.avatar_urls.get_s3_client", return_value=mock_client):
        await _set_profile_picture(client, tokens, _PRESIGNED_URL)

    mock_client.reset_mock()

    # GET /member/profile — should pass through without calling generate_presigned_url.
    with patch("app.services.storage.avatar_urls.get_s3_client", return_value=mock_client):
        res = await client.get(
            "/api/v1/member/profile",
            headers=auth_header(tokens),
        )

    assert res.status_code == 200, res.text
    returned_url: str | None = res.json()["profile_picture_url"]
    assert returned_url == _PRESIGNED_URL
    # generate_presigned_url must NOT have been called (passthrough, not double-signed).
    mock_client.generate_presigned_url.assert_not_called()


@pytest.mark.asyncio
async def test_i4_chw_profile_picture_is_presigned(
    client: AsyncClient,
) -> None:
    """I4 — CHW GET /chw/profile with public-bucket URL stored → presigned GET URL."""
    res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "avatar_chw_i4@example.com",
            "password": "testpass123",
            "name": "CHW Avatar Tester",
            "role": "chw",
        },
    )
    assert res.status_code == 201, res.text
    tokens = res.json()

    # PUT /chw/profile to store the raw public-bucket URL.
    mock_client = _mock_s3_client(_FAKE_PRESIGNED)
    with patch("app.services.storage.avatar_urls.get_s3_client", return_value=mock_client):
        put_res = await client.put(
            "/api/v1/chw/profile",
            json={"profile_picture_url": _REGION_URL},
            headers=auth_header(tokens),
        )
    assert put_res.status_code == 200, put_res.text

    # GET /chw/profile — presigned URL must be returned.
    with patch(
        "app.services.storage.avatar_urls.get_s3_client",
        return_value=_mock_s3_client(_FAKE_PRESIGNED),
    ):
        get_res = await client.get(
            "/api/v1/chw/profile",
            headers=auth_header(tokens),
        )

    assert get_res.status_code == 200, get_res.text
    returned_url: str | None = get_res.json()["profile_picture_url"]
    assert returned_url is not None
    assert _KEY in returned_url
    assert "X-Amz-Signature" in returned_url

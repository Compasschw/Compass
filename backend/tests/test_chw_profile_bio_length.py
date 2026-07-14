"""Tests for Epic C3 — CHW profile Bio field capped at 120 characters.

The cap is enforced in two places and both are covered here:

Unit coverage (no DB, no network — pure pydantic validation):
  U1. `CHWProfileUpdate(bio=<121 chars>)` raises `ValidationError`.
  U2. `CHWProfileUpdate(bio=<120 chars>)` is accepted (bio round-trips unchanged).
  U3. `CHWProfileUpdate(bio=None)` is accepted (bio remains optional).

Integration coverage (HTTP, DB):
  I1. `PUT /api/v1/chw/profile` with a 121-char bio → 422, and the bio is NOT
      persisted (a follow-up GET still shows the prior value).
  I2. `PUT /api/v1/chw/profile` with an exactly-120-char bio → 200 and persists.
"""

from __future__ import annotations

import pytest
from httpx import AsyncClient
from pydantic import ValidationError

from app.schemas.user import CHWProfileUpdate
from tests.conftest import auth_header

# ─── Unit tests ─────────────────────────────────────────────────────────────

_BIO_121 = "x" * 121
_BIO_120 = "y" * 120


def test_u1_bio_over_120_chars_is_rejected() -> None:
    """U1 — 121-char bio raises ValidationError (max_length=120)."""
    with pytest.raises(ValidationError) as exc_info:
        CHWProfileUpdate(bio=_BIO_121)

    errors = exc_info.value.errors()
    assert any(e["loc"] == ("bio",) for e in errors), errors


def test_u2_bio_exactly_120_chars_is_accepted() -> None:
    """U2 — 120-char bio (the boundary) is accepted and round-trips unchanged."""
    update = CHWProfileUpdate(bio=_BIO_120)
    assert update.bio == _BIO_120
    assert len(update.bio) == 120


def test_u3_bio_none_is_still_accepted() -> None:
    """U3 — bio remains optional; None is a valid value (unset semantics)."""
    update = CHWProfileUpdate(bio=None)
    assert update.bio is None


# ─── Integration tests ──────────────────────────────────────────────────────


async def _register_chw(client: AsyncClient, email: str) -> dict:
    res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": email,
            "password": "Testpass123!",
            "name": "Bio Length Tester",
            "role": "chw",
        },
    )
    assert res.status_code == 201, res.text
    return res.json()


@pytest.mark.asyncio
async def test_i1_over_long_bio_rejected_by_api_and_not_persisted(
    client: AsyncClient,
) -> None:
    """I1 — PUT /chw/profile with a 121-char bio → 422; prior bio unchanged."""
    tokens = await _register_chw(client, "bio_i1@example.com")
    headers = auth_header(tokens)

    # Seed a known-good bio first so we can assert it wasn't clobbered.
    seed_res = await client.put(
        "/api/v1/chw/profile",
        json={"bio": "Original short bio."},
        headers=headers,
    )
    assert seed_res.status_code == 200, seed_res.text

    over_long_res = await client.put(
        "/api/v1/chw/profile",
        json={"bio": _BIO_121},
        headers=headers,
    )
    assert over_long_res.status_code == 422, over_long_res.text

    get_res = await client.get("/api/v1/chw/profile", headers=headers)
    assert get_res.status_code == 200, get_res.text
    assert get_res.json()["bio"] == "Original short bio."


@pytest.mark.asyncio
async def test_i2_exactly_120_char_bio_is_accepted_and_persisted(
    client: AsyncClient,
) -> None:
    """I2 — PUT /chw/profile with an exactly-120-char bio → 200 and persists."""
    tokens = await _register_chw(client, "bio_i2@example.com")
    headers = auth_header(tokens)

    put_res = await client.put(
        "/api/v1/chw/profile",
        json={"bio": _BIO_120},
        headers=headers,
    )
    assert put_res.status_code == 200, put_res.text

    get_res = await client.get("/api/v1/chw/profile", headers=headers)
    assert get_res.status_code == 200, get_res.text
    assert get_res.json()["bio"] == _BIO_120

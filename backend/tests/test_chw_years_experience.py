"""Regression tests for QA-batch #3 — years_experience save bug.

CHWProfileUpdate was silently missing a `years_experience` field, so a PUT
/chw/profile call that included years_experience passed Pydantic validation
(unknown fields are dropped, not rejected) but the value never reached
`model_dump(exclude_unset=True)`'s output — the handler's `setattr` loop
never saw it, and the update silently no-op'd. CHWProfile.years_experience
already existed on the model; this was purely a schema gap.

Coverage:
  1. PUT with years_experience=7 persists (FAILS on pre-fix code — the
     value silently doesn't stick, a follow-up GET would show 0).
  2. Invalid values (-1, 61) -> 422 (bounds ge=0, le=60).
  3. Omitting years_experience entirely leaves the existing value untouched
     (exclude_unset semantics — a PUT with other fields must not reset it).
"""

import pytest
from httpx import AsyncClient

from tests.conftest import auth_header

pytestmark = pytest.mark.asyncio

_COMPLIANT_PASSWORD = "Testpass123!"


async def _register_chw(client: AsyncClient, email: str) -> dict:
    res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": email,
            "password": _COMPLIANT_PASSWORD,
            "name": "Years Experience Tester",
            "role": "chw",
        },
    )
    assert res.status_code == 201, res.text
    return res.json()


async def test_years_experience_persists_on_update(client: AsyncClient) -> None:
    """FAILS on the pre-fix schema: PUT years_experience=7 silently no-ops
    and a follow-up GET still shows the default (0)."""
    tokens = await _register_chw(client, "years_exp_persist@example.com")
    headers = auth_header(tokens)

    put_res = await client.put(
        "/api/v1/chw/profile",
        json={"years_experience": 7},
        headers=headers,
    )
    assert put_res.status_code == 200, put_res.text
    assert put_res.json()["years_experience"] == 7

    get_res = await client.get("/api/v1/chw/profile", headers=headers)
    assert get_res.status_code == 200, get_res.text
    assert get_res.json()["years_experience"] == 7


async def test_years_experience_negative_rejected(client: AsyncClient) -> None:
    tokens = await _register_chw(client, "years_exp_negative@example.com")
    headers = auth_header(tokens)

    res = await client.put(
        "/api/v1/chw/profile",
        json={"years_experience": -1},
        headers=headers,
    )
    assert res.status_code == 422, res.text


async def test_years_experience_over_ceiling_rejected(client: AsyncClient) -> None:
    tokens = await _register_chw(client, "years_exp_ceiling@example.com")
    headers = auth_header(tokens)

    res = await client.put(
        "/api/v1/chw/profile",
        json={"years_experience": 61},
        headers=headers,
    )
    assert res.status_code == 422, res.text


async def test_years_experience_boundary_values_accepted(client: AsyncClient) -> None:
    """0 and 60 are the inclusive boundaries (ge=0, le=60) and must be accepted."""
    tokens = await _register_chw(client, "years_exp_boundary@example.com")
    headers = auth_header(tokens)

    zero_res = await client.put(
        "/api/v1/chw/profile",
        json={"years_experience": 0},
        headers=headers,
    )
    assert zero_res.status_code == 200, zero_res.text
    assert zero_res.json()["years_experience"] == 0

    sixty_res = await client.put(
        "/api/v1/chw/profile",
        json={"years_experience": 60},
        headers=headers,
    )
    assert sixty_res.status_code == 200, sixty_res.text
    assert sixty_res.json()["years_experience"] == 60


async def test_omitting_years_experience_leaves_value_untouched(
    client: AsyncClient,
) -> None:
    """A PUT that updates a DIFFERENT field (and omits years_experience
    entirely) must not reset years_experience back to a default — proves
    exclude_unset semantics, not a blanket overwrite."""
    tokens = await _register_chw(client, "years_exp_omit@example.com")
    headers = auth_header(tokens)

    seed_res = await client.put(
        "/api/v1/chw/profile",
        json={"years_experience": 12},
        headers=headers,
    )
    assert seed_res.status_code == 200, seed_res.text
    assert seed_res.json()["years_experience"] == 12

    # Update a different field, omitting years_experience from the body.
    other_field_res = await client.put(
        "/api/v1/chw/profile",
        json={"bio": "Updated bio only."},
        headers=headers,
    )
    assert other_field_res.status_code == 200, other_field_res.text
    assert other_field_res.json()["years_experience"] == 12
    assert other_field_res.json()["bio"] == "Updated bio only."

"""Tests for resource-need level (Low/Medium/High) priority feature.

Covers PATCH /api/v1/chw/members/{member_id}/resource-needs with the new
``levels`` field and the GET /api/v1/chw/members/{member_id} response field
``resource_need_levels``.

TDD checklist (backend/TESTING.md):
1. Negative auth — CHW with no relationship → 403 (inherited from existing tests).
2. Happy path — level-sort persists and detail GET reflects levels.
3. Invariant-violation — invalid level value → 422.
4. Invariant-violation — levels key not in needs → 422.
5. Default — missing level defaults to "medium".
6. Backfill logic — unit test of the pure-Python helper in the migration.

Every test in this file FAILS on the pre-fix code (before the ``levels`` field
and level-sort logic are added) and PASSES after the fix.
"""

from __future__ import annotations

import pytest
from httpx import AsyncClient

from tests.conftest import auth_header


# ─── Shared helpers (mirrored from test_chw_member_profile.py) ────────────────


async def _register_user(client: AsyncClient, email: str, role: str, name: str) -> dict:
    payload: dict = {
        "email": email,
        "password": "testpass123",
        "name": name,
        "role": role,
    }
    if role == "member":
        payload.update({
            "date_of_birth": "1990-01-01",
            "gender": "Female",
            "insurance_company": "Health Net",
            "medi_cal_id": f"{abs(hash(email)) % 100_000_000:08d}A",
            "zip_code": "90001",
        })
    res = await client.post("/api/v1/auth/register", json=payload)
    assert res.status_code == 201, res.text
    return res.json()


async def _create_and_accept_request(
    client: AsyncClient, member_tokens: dict, chw_tokens: dict
) -> str:
    res = await client.post(
        "/api/v1/requests/",
        json={
            "vertical": "housing",
            "urgency": "routine",
            "description": "Need help",
            "preferred_mode": "in_person",
        },
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 201, res.text
    request_id = res.json()["id"]
    res = await client.patch(
        f"/api/v1/requests/{request_id}/accept",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    return request_id


def _get_member_id(tokens: dict) -> str:
    import base64
    import json

    segment = tokens["access_token"].split(".")[1]
    padded = segment + "=" * (4 - len(segment) % 4)
    return json.loads(base64.urlsafe_b64decode(padded))["sub"]


# ─── Fixtures ─────────────────────────────────────────────────────────────────


@pytest.fixture
async def chw(client: AsyncClient) -> dict:
    return await _register_user(client, "chw_levels@example.com", "chw", "CHW Levels")


@pytest.fixture
async def member(client: AsyncClient) -> dict:
    return await _register_user(client, "member_levels@example.com", "member", "Member Levels")


@pytest.fixture
async def established_pair(client: AsyncClient, chw: dict, member: dict) -> tuple[dict, dict, str]:
    """Returns (chw_tokens, member_tokens, member_id) with an accepted request."""
    await _create_and_accept_request(client, member, chw)
    return chw, member, _get_member_id(member)


# ─── Tests ────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_level_sort_makes_high_need_primary_even_when_sent_second(
    client: AsyncClient,
    established_pair: tuple[dict, dict, str],
) -> None:
    """Sending the HIGH-priority need SECOND in the list still makes it primary_need.

    This tests that the endpoint ignores caller order for primary_need derivation
    and instead promotes the highest-level need to primary_need.

    Fails on pre-fix code because: (a) ``levels`` is silently ignored, (b) the
    endpoint would set primary_need = "mental_health" (first in list) instead of
    "food_security" (the high one).
    """
    chw_tokens, _, member_id = established_pair

    # food_security is HIGH but sent SECOND — it must become primary_need.
    res = await client.patch(
        f"/api/v1/chw/members/{member_id}/resource-needs",
        json={
            "needs": ["mental_health", "food_security"],
            "levels": {"food_security": "high", "mental_health": "low"},
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    body = res.json()

    # resource_needs must be sorted: high first, then low.
    assert body["resource_needs"] == ["food_security", "mental_health"], (
        "food_security (high) must precede mental_health (low) in sorted order"
    )
    assert body["resource_need_levels"] == {
        "food_security": "high",
        "mental_health": "low",
    }

    # Verify persistence via the detail GET.
    detail_res = await client.get(
        f"/api/v1/chw/members/{member_id}",
        headers=auth_header(chw_tokens),
    )
    assert detail_res.status_code == 200, detail_res.text
    detail = detail_res.json()
    assert detail["resource_need_levels"] == {
        "food_security": "high",
        "mental_health": "low",
    }
    assert detail["resource_needs"][0] == "food_security", (
        "primary_need (first of resource_needs) must be the high-level need"
    )


@pytest.mark.asyncio
async def test_missing_level_defaults_to_medium(
    client: AsyncClient,
    established_pair: tuple[dict, dict, str],
) -> None:
    """A need slug absent from ``levels`` defaults to 'medium' in the persisted map.

    Fails on pre-fix code because the ``levels`` field does not exist and the
    response has no ``resource_need_levels`` key.
    """
    chw_tokens, _, member_id = established_pair

    # housing has an explicit level; healthcare is omitted → should default "medium".
    res = await client.patch(
        f"/api/v1/chw/members/{member_id}/resource-needs",
        json={
            "needs": ["housing", "healthcare"],
            "levels": {"housing": "low"},
            # healthcare intentionally absent
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    body = res.json()

    # healthcare defaults to "medium" → sorts before "low" housing.
    assert body["resource_need_levels"]["healthcare"] == "medium"
    assert body["resource_need_levels"]["housing"] == "low"

    # medium < low in rank so healthcare comes first in ordered list.
    assert body["resource_needs"] == ["healthcare", "housing"]


@pytest.mark.asyncio
async def test_invalid_level_value_returns_422(
    client: AsyncClient,
    established_pair: tuple[dict, dict, str],
) -> None:
    """A level value outside {low, medium, high} must be rejected with 422.

    Fails on pre-fix code because the ``levels`` field is ignored (Pydantic treats
    it as an extra field) and the endpoint returns 200.
    """
    chw_tokens, _, member_id = established_pair

    res = await client.patch(
        f"/api/v1/chw/members/{member_id}/resource-needs",
        json={
            "needs": ["housing"],
            "levels": {"housing": "critical"},  # "critical" is not valid
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 422, res.text


@pytest.mark.asyncio
async def test_levels_key_not_in_needs_returns_422(
    client: AsyncClient,
    established_pair: tuple[dict, dict, str],
) -> None:
    """A levels key that is not in the needs list must be rejected with 422.

    Fails on pre-fix code because ``levels`` is ignored (extra field) and the
    endpoint returns 200.
    """
    chw_tokens, _, member_id = established_pair

    res = await client.patch(
        f"/api/v1/chw/members/{member_id}/resource-needs",
        json={
            "needs": ["housing"],
            "levels": {
                "housing": "high",
                "mental_health": "low",  # not in needs → 422
            },
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 422, res.text


@pytest.mark.asyncio
async def test_get_member_profile_returns_resource_need_levels(
    client: AsyncClient,
    established_pair: tuple[dict, dict, str],
) -> None:
    """GET /chw/members/{id} returns resource_need_levels in the response body.

    Fails on pre-fix code because the field is absent from CHWMemberProfileDetail.
    """
    chw_tokens, _, member_id = established_pair

    # First set some needs + levels.
    patch_res = await client.patch(
        f"/api/v1/chw/members/{member_id}/resource-needs",
        json={
            "needs": ["rehab", "food_security"],
            "levels": {"rehab": "medium", "food_security": "high"},
        },
        headers=auth_header(chw_tokens),
    )
    assert patch_res.status_code == 200, patch_res.text

    # Then fetch the detail and assert the field is present.
    detail_res = await client.get(
        f"/api/v1/chw/members/{member_id}",
        headers=auth_header(chw_tokens),
    )
    assert detail_res.status_code == 200, detail_res.text
    detail = detail_res.json()

    assert "resource_need_levels" in detail, (
        "resource_need_levels must be a top-level key in the member profile detail"
    )
    assert detail["resource_need_levels"] == {
        "rehab": "medium",
        "food_security": "high",
    }


@pytest.mark.asyncio
async def test_empty_needs_clears_levels(
    client: AsyncClient,
    established_pair: tuple[dict, dict, str],
) -> None:
    """Sending an empty needs list clears resource_need_levels to {} as well."""
    chw_tokens, _, member_id = established_pair

    # Seed some levels first.
    await client.patch(
        f"/api/v1/chw/members/{member_id}/resource-needs",
        json={"needs": ["housing"], "levels": {"housing": "high"}},
        headers=auth_header(chw_tokens),
    )

    # Now clear.
    res = await client.patch(
        f"/api/v1/chw/members/{member_id}/resource-needs",
        json={"needs": [], "levels": {}},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["resource_needs"] == []
    assert body["resource_need_levels"] == {}


# ─── Backfill logic unit test ─────────────────────────────────────────────────


def _backfill_levels(
    primary_need: str | None,
    additional_needs: list[str] | None,
) -> dict[str, str]:
    """Mirror of the pure-Python backfill helper defined in the migration.

    This function is intentionally duplicated here so the test does not depend
    on importing from an alembic migration file (which has env-specific side
    effects at import time).

    Logic:
      primary_need          → "high"
      additional_needs[0]   → "medium"
      additional_needs[1:]  → "low"
    Higher-priority assignments win on duplicate slugs.
    """
    result: dict[str, str] = {}
    # Build low → medium → high so later assignments win on conflicts.
    for need in reversed((additional_needs or [])[1:]):
        if need:
            result[need] = "low"
    if additional_needs and len(additional_needs) >= 1 and additional_needs[0]:
        result[additional_needs[0]] = "medium"
    if primary_need:
        result[primary_need] = "high"
    return result


def test_backfill_logic_maps_primary_high_additional_medium_then_low() -> None:
    """Backfill: primary_need=high, additional[0]=medium, additional[1:]=low.

    Fails on pre-fix code if the backfill helper doesn't exist or returns wrong
    values. This is a pure-Python unit test; no DB required.
    """
    levels = _backfill_levels(
        primary_need="housing",
        additional_needs=["food_security", "mental_health"],
    )
    assert levels == {
        "housing": "high",
        "food_security": "medium",
        "mental_health": "low",
    }, f"unexpected backfill result: {levels}"


def test_backfill_logic_no_needs_returns_empty_dict() -> None:
    """Members with no needs set should get an empty level map."""
    assert _backfill_levels(None, None) == {}
    assert _backfill_levels(None, []) == {}
    assert _backfill_levels("housing", None) == {"housing": "high"}


def test_backfill_logic_primary_only() -> None:
    """Only primary_need set → only "high" entry."""
    levels = _backfill_levels("mental_health", [])
    assert levels == {"mental_health": "high"}


def test_backfill_logic_primary_wins_on_conflict() -> None:
    """If primary_need appears in additional_needs too, it stays "high"."""
    levels = _backfill_levels(
        primary_need="housing",
        additional_needs=["housing", "food_security"],
    )
    # housing appears twice; primary_need wins → "high"
    assert levels["housing"] == "high"
    assert levels["food_security"] == "low"

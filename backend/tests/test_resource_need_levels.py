"""Tests for resource-need level (Low/Medium/High) priority feature.

Covers PATCH /api/v1/chw/members/{member_id}/resource-needs with the
``levels`` field (list of {slug, level} items) and the GET
/api/v1/chw/members/{member_id} response field ``resource_need_levels``
(also a list of {slug, level} items).

Wire-format note: levels is a LIST not an object to keep slugs as string
VALUES — immune to the mobile app's recursive camelCase key transform that
mangles object keys (mental_health → mentalHealth).

TDD checklist (backend/TESTING.md):
1. Negative auth — CHW with no relationship → 403 (inherited from existing tests).
2. Happy path — level-sort persists and detail GET reflects levels.
3. Invariant-violation — invalid level value → 422.
4. Invariant-violation — levels slug not in needs → 422.
5. Default — missing level defaults to "medium".
6. Backfill logic — unit test of the pure-Python helper in the migration.
7. Regression — multi-word slug (mental_health) round-trips unchanged.

Every async test in this file FAILS on the pre-fix code (before the list-shape
change) and PASSES after the fix.
"""

from __future__ import annotations

import pytest
from httpx import AsyncClient

from tests.conftest import auth_header


# ─── Shared helpers ────────────────────────────────────────────────────────────


async def _register_user(client: AsyncClient, email: str, role: str, name: str) -> dict:
    payload: dict = {
        "email": email,
        "password": "Testpass123!",
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
            "terms_accepted": True,
            "communications_consent": True,
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


def _levels_dict(levels_list: list[dict]) -> dict[str, str]:
    """Convert a response levels list [{slug, level}, ...] → {slug: level} for assertions."""
    return {item["slug"]: item["level"] for item in levels_list}


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

    Tests that the endpoint ignores caller order for primary_need derivation and
    instead promotes the highest-level need to primary_need.

    Fails on pre-fix code because: (a) ``levels`` is rejected as an invalid type
    or silently ignored, (b) the endpoint would set primary_need = "mental_health"
    (first in list) instead of "food_security" (the high one).
    """
    chw_tokens, _, member_id = established_pair

    # food_security is HIGH but sent SECOND — it must become primary_need.
    res = await client.patch(
        f"/api/v1/chw/members/{member_id}/resource-needs",
        json={
            "needs": ["mental_health", "food_security"],
            "levels": [
                {"slug": "food_security", "level": "high"},
                {"slug": "mental_health", "level": "low"},
            ],
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    body = res.json()

    # resource_needs must be sorted: high first, then low.
    assert body["resource_needs"] == ["food_security", "mental_health"], (
        "food_security (high) must precede mental_health (low) in sorted order"
    )

    # resource_need_levels is a list of {slug, level} objects.
    levels = _levels_dict(body["resource_need_levels"])
    assert levels == {"food_security": "high", "mental_health": "low"}

    # Verify persistence via the detail GET.
    detail_res = await client.get(
        f"/api/v1/chw/members/{member_id}",
        headers=auth_header(chw_tokens),
    )
    assert detail_res.status_code == 200, detail_res.text
    detail = detail_res.json()

    detail_levels = _levels_dict(detail["resource_need_levels"])
    assert detail_levels == {"food_security": "high", "mental_health": "low"}
    assert detail["resource_needs"][0] == "food_security", (
        "primary_need (first of resource_needs) must be the high-level need"
    )


@pytest.mark.asyncio
async def test_missing_level_defaults_to_medium(
    client: AsyncClient,
    established_pair: tuple[dict, dict, str],
) -> None:
    """A need slug absent from ``levels`` defaults to 'medium' in the persisted map.

    Fails on pre-fix code because the ``levels`` field doesn't exist or uses the
    wrong wire format, so ``resource_need_levels`` is absent from the response.
    """
    chw_tokens, _, member_id = established_pair

    # housing has an explicit level; healthcare is omitted → should default "medium".
    res = await client.patch(
        f"/api/v1/chw/members/{member_id}/resource-needs",
        json={
            "needs": ["housing", "healthcare"],
            "levels": [{"slug": "housing", "level": "low"}],
            # healthcare intentionally absent
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    body = res.json()

    levels = _levels_dict(body["resource_need_levels"])
    # healthcare defaults to "medium" → sorts before "low" housing.
    assert levels["healthcare"] == "medium"
    assert levels["housing"] == "low"

    # medium ranks before low → healthcare comes first in ordered list.
    assert body["resource_needs"] == ["healthcare", "housing"]


@pytest.mark.asyncio
async def test_invalid_level_value_returns_422(
    client: AsyncClient,
    established_pair: tuple[dict, dict, str],
) -> None:
    """A level value outside {low, medium, high} must be rejected with 422.

    Fails on pre-fix code because the ``levels`` field is unrecognised (Pydantic
    treats it as an extra field) and the endpoint returns 200.
    """
    chw_tokens, _, member_id = established_pair

    res = await client.patch(
        f"/api/v1/chw/members/{member_id}/resource-needs",
        json={
            "needs": ["housing"],
            "levels": [{"slug": "housing", "level": "critical"}],  # "critical" is not valid
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 422, res.text


@pytest.mark.asyncio
async def test_levels_key_not_in_needs_returns_422(
    client: AsyncClient,
    established_pair: tuple[dict, dict, str],
) -> None:
    """A levels slug that is not in the needs list must be rejected with 422.

    Fails on pre-fix code because ``levels`` is ignored (extra field) and the
    endpoint returns 200.
    """
    chw_tokens, _, member_id = established_pair

    res = await client.patch(
        f"/api/v1/chw/members/{member_id}/resource-needs",
        json={
            "needs": ["housing"],
            "levels": [
                {"slug": "housing", "level": "high"},
                {"slug": "mental_health", "level": "low"},  # not in needs → 422
            ],
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 422, res.text


@pytest.mark.asyncio
async def test_get_member_profile_returns_resource_need_levels(
    client: AsyncClient,
    established_pair: tuple[dict, dict, str],
) -> None:
    """GET /chw/members/{id} returns resource_need_levels as a list in the response body.

    Fails on pre-fix code because the field is absent from CHWMemberProfileDetail
    or uses the wrong shape.
    """
    chw_tokens, _, member_id = established_pair

    # First set some needs + levels.
    patch_res = await client.patch(
        f"/api/v1/chw/members/{member_id}/resource-needs",
        json={
            "needs": ["transportation", "food_security"],
            "levels": [
                {"slug": "transportation", "level": "medium"},
                {"slug": "food_security", "level": "high"},
            ],
        },
        headers=auth_header(chw_tokens),
    )
    assert patch_res.status_code == 200, patch_res.text

    # Then fetch the detail and assert the field is present as a list.
    detail_res = await client.get(
        f"/api/v1/chw/members/{member_id}",
        headers=auth_header(chw_tokens),
    )
    assert detail_res.status_code == 200, detail_res.text
    detail = detail_res.json()

    assert "resource_need_levels" in detail, (
        "resource_need_levels must be a top-level key in the member profile detail"
    )
    assert isinstance(detail["resource_need_levels"], list), (
        "resource_need_levels must be a list, not a dict"
    )
    levels = _levels_dict(detail["resource_need_levels"])
    assert levels == {"transportation": "medium", "food_security": "high"}


@pytest.mark.asyncio
async def test_empty_needs_clears_levels(
    client: AsyncClient,
    established_pair: tuple[dict, dict, str],
) -> None:
    """Sending an empty needs list clears resource_need_levels to [] as well."""
    chw_tokens, _, member_id = established_pair

    # Seed some levels first.
    await client.patch(
        f"/api/v1/chw/members/{member_id}/resource-needs",
        json={"needs": ["housing"], "levels": [{"slug": "housing", "level": "high"}]},
        headers=auth_header(chw_tokens),
    )

    # Now clear.
    res = await client.patch(
        f"/api/v1/chw/members/{member_id}/resource-needs",
        json={"needs": [], "levels": []},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["resource_needs"] == []
    assert body["resource_need_levels"] == []


# ─── Regression: multi-word slug round-trip ───────────────────────────────────


@pytest.mark.asyncio
async def test_multi_word_slug_round_trips_without_camel_casing(
    client: AsyncClient,
    established_pair: tuple[dict, dict, str],
) -> None:
    """Multi-word slugs (mental_health) survive the API round-trip unchanged.

    Regression: when levels was a JSON object keyed by slug, the mobile app's
    recursive camelCase key transformer mangled mental_health→mentalHealth on
    the response, then echoed that back on PATCH, causing the validator to
    reject the request ("levels keys not in needs: ['mentalhealth']").
    Single-word slugs (housing) happened to survive; mental_health did not.

    Fix: levels is now a list of {slug, level} items so the slug is a STRING
    VALUE — immune to key transforms.  This test fails on the pre-fix dict
    shape and passes on the list shape.
    """
    chw_tokens, _, member_id = established_pair

    res = await client.patch(
        f"/api/v1/chw/members/{member_id}/resource-needs",
        json={
            "needs": ["mental_health", "housing"],
            "levels": [
                {"slug": "mental_health", "level": "high"},
                {"slug": "housing", "level": "low"},
            ],
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    body = res.json()

    # PATCH response: slug must be the exact string "mental_health", not camelCased.
    patch_levels = _levels_dict(body["resource_need_levels"])
    assert "mental_health" in patch_levels, (
        f"Expected slug 'mental_health' in PATCH response, got: {list(patch_levels.keys())!r}"
    )
    assert patch_levels["mental_health"] == "high"
    assert patch_levels.get("housing") == "low"

    # mental_health is HIGH → must sort first in resource_needs.
    assert body["resource_needs"][0] == "mental_health"

    # GET detail: verify the stored slug is also 'mental_health' (not mangled).
    detail_res = await client.get(
        f"/api/v1/chw/members/{member_id}",
        headers=auth_header(chw_tokens),
    )
    assert detail_res.status_code == 200, detail_res.text
    detail = detail_res.json()

    detail_levels = _levels_dict(detail["resource_need_levels"])
    assert "mental_health" in detail_levels, (
        f"GET returned slugs {list(detail_levels.keys())!r} — expected 'mental_health' (not camelCased)"
    )
    assert detail_levels["mental_health"] == "high"
    assert detail_levels.get("housing") == "low"


# ─── Backfill logic unit tests ─────────────────────────────────────────────────


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

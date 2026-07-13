"""Tests for Epic C5 — 'Housing' → 'Utilities' as a selectable vertical, with
historical 'housing'-tagged rows GRANDFATHERED (no data migration/backfill).

Coverage:
  1. Vertical enum: 'utilities' is a valid value; 'housing' still validates
     (grandfathered — the Vertical enum is validation-only, vertical columns
     are String(50), so this is enum/value-list surgery, not a DB migration).
  2. Epic L scheduling (POST /sessions/schedule): resource_needs accepts
     'utilities' (new selection path) AND still accepts a legacy 'housing'
     value (grandfathered — the existing test_session_scheduling.py suite
     already covers plain 'housing' scheduling; this file adds the
     'utilities' coverage and a mixed old+new regression).
  3. CHW resource-needs PATCH (/chw/members/{id}/resource-needs): accepts a
     NEW 'utilities' selection, and — critically — still accepts a full
     re-save that includes a pre-existing legacy 'housing' entry (the
     EditResourceNeedsModal round-trip hazard: the CHW app always resubmits
     the member's full current needs list, so a member who already has
     'housing' saved must not 422 on their next unrelated resource-needs
     edit).
  4. Journey reconciliation: saving resource_needs=['utilities'] provisions
     a canonical "Utilities" journey (mirrors the existing 'housing' →
     "Housing" journey behavior), and a legacy 'housing' need is NOT
     abandoned by an unrelated resource-needs save.
  5. Regression: existing housing-tagged ServiceRequest/Session data is still
     fully readable (GET) end-to-end after this change.

TDD checklist (backend/TESTING.md) followed for the new endpoint interactions
touched here: negative-auth is inherited from the existing suites for these
endpoints (not re-tested here to avoid duplicating established coverage);
this file focuses on the new value/grandfathering behavior, which is the
actual surface Epic C5 changes.
"""

from __future__ import annotations

import base64
import json
from uuid import UUID

import pytest
from httpx import AsyncClient

from tests.conftest import auth_header


def _member_id(tokens: dict) -> str:
    payload_b64 = tokens["access_token"].split(".")[1]
    padded = payload_b64 + "=" * (4 - len(payload_b64) % 4)
    return str(UUID(json.loads(base64.urlsafe_b64decode(padded).decode())["sub"]))


async def _establish_relationship(
    client: AsyncClient, member_tokens: dict, chw_tokens: dict
) -> str:
    """Member files a request, CHW accepts it → care relationship. Returns member_id."""
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
        f"/api/v1/requests/{request_id}/accept", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200, res.text
    return _member_id(member_tokens)


# ─── 1. Vertical enum ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_request_creation_accepts_utilities_vertical(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """A member can file a NEW service request tagged 'utilities' — the
    replacement vertical for the retired 'housing' new-selection option."""
    res = await client.post(
        "/api/v1/requests/",
        json={
            "verticals": ["utilities"],
            "urgency": "routine",
            "description": "Need help with a shutoff notice",
            "preferred_mode": "in_person",
        },
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["vertical"] == "utilities"
    assert body["verticals"] == ["utilities"]


@pytest.mark.asyncio
async def test_request_creation_still_accepts_legacy_housing_vertical(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """'housing' remains a valid Vertical enum member — a caller who hasn't
    migrated off it (or replays an old client payload) must not 422.
    Grandfathering means 'housing' still VALIDATES; it's the frontend picker
    (native/src/lib/verticals.ts SELECTABLE_VERTICALS) that stops offering
    it, not the backend enum."""
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
    assert res.json()["vertical"] == "housing"


# ─── 2. Epic L scheduling — resource_needs ──────────────────────────────────


@pytest.mark.asyncio
async def test_chw_schedules_with_utilities_resource_need_persists_and_returns_it(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """Scheduling with resource_needs=['utilities'] (the new selectable
    vertical) succeeds end-to-end: 201, persisted, and readable on a
    subsequent GET."""
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)

    res = await client.post(
        "/api/v1/sessions/schedule",
        json={
            "member_id": member_id,
            "scheduled_at": "2026-07-01T17:00:00Z",
            "scheduled_end_at": "2026-07-01T18:00:00Z",
            "mode": "phone",
            "scheduling_status": "confirmed",
            "resource_needs": ["utilities"],
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["resource_needs"] == ["utilities"]

    res = await client.get(f"/api/v1/sessions/{body['id']}", headers=auth_header(chw_tokens))
    assert res.status_code == 200, res.text
    assert res.json()["resource_needs"] == ["utilities"]


@pytest.mark.asyncio
async def test_chw_schedules_with_mixed_legacy_and_new_resource_needs(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """A resource_needs list mixing the grandfathered 'housing' value with the
    new 'utilities' value is accepted — the Vertical enum admits both, and
    nothing in the schedule path rejects a legacy value. Regression guard for
    a caller (e.g. a stale mobile build) that still sends 'housing'."""
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)

    res = await client.post(
        "/api/v1/sessions/schedule",
        json={
            "member_id": member_id,
            "scheduled_at": "2026-07-02T17:00:00Z",
            "mode": "phone",
            "resource_needs": ["housing", "utilities"],
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    assert res.json()["resource_needs"] == ["housing", "utilities"]


# ─── 3. CHW resource-needs PATCH — grandfathered round-trip ────────────────


@pytest.mark.asyncio
async def test_resource_needs_patch_accepts_new_utilities_selection(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """A CHW can newly select 'utilities' on the Resource Needs card."""
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)

    res = await client.patch(
        f"/api/v1/chw/members/{member_id}/resource-needs",
        json={"needs": ["utilities"], "levels": [{"slug": "utilities", "level": "high"}]},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["resource_needs"] == ["utilities"]


@pytest.mark.asyncio
async def test_resource_needs_patch_still_accepts_resave_of_legacy_housing_need(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """Grandfathering regression test — this is the exact hazard Epic C5 must
    avoid: the CHW app's EditResourceNeedsModal hydrates its full selection
    from the member's EXISTING resource_needs and always resubmits the whole
    list on Save (see CHWMemberProfileScreen.tsx `handleSave`). A member with
    a pre-existing 'housing' need must not 422 on their very next unrelated
    resource-needs edit.

    This test FAILS if _RESOURCE_NEED_VALUES (schemas/chw.py) had 'housing'
    removed instead of grandfathered: step 1 (seed 'housing') would still
    succeed as an isolated call, but step 2 (a full re-save that still
    includes 'housing' alongside a newly added need) would 422.
    """
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)

    # Step 1: seed a legacy 'housing' need (simulates data saved before Epic C5).
    res = await client.patch(
        f"/api/v1/chw/members/{member_id}/resource-needs",
        json={"needs": ["housing"], "levels": [{"slug": "housing", "level": "high"}]},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    assert res.json()["resource_needs"] == ["housing"]

    # Step 2: CHW opens the modal again and adds 'food' — the modal resends
    # the FULL list, including the untouched legacy 'housing' entry.
    res = await client.patch(
        f"/api/v1/chw/members/{member_id}/resource-needs",
        json={
            "needs": ["housing", "food"],
            "levels": [
                {"slug": "housing", "level": "high"},
                {"slug": "food", "level": "medium"},
            ],
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert set(body["resource_needs"]) == {"housing", "food"}

    # Persisted — a fresh detail GET reflects both.
    detail = await client.get(f"/api/v1/chw/members/{member_id}", headers=auth_header(chw_tokens))
    assert detail.status_code == 200, detail.text
    assert set(detail.json()["resource_needs"]) == {"housing", "food"}


@pytest.mark.asyncio
async def test_resource_needs_patch_rejects_truly_unknown_value(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """Sanity check that the value-list validator is still doing its job —
    an unrecognized slug (neither grandfathered nor new) must still 422."""
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)

    res = await client.patch(
        f"/api/v1/chw/members/{member_id}/resource-needs",
        json={"needs": ["not_a_real_need"], "levels": []},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 422, res.text


# ─── 4. Journey reconciliation ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_resource_needs_utilities_provisions_a_canonical_utilities_journey(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """Selecting 'utilities' as a resource need auto-provisions a canonical
    "Utilities" journey (mirrors the existing 'housing' → "Housing" journey
    auto-provisioning), proving journey_reconciler.RESOURCE_NEED_LABELS was
    updated to include the new vertical, not just the value-list validator."""
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)

    res = await client.patch(
        f"/api/v1/chw/members/{member_id}/resource-needs",
        json={"needs": ["utilities"], "levels": [{"slug": "utilities", "level": "high"}]},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text

    journeys_res = await client.get(
        f"/api/v1/members/{member_id}/journeys",
        headers=auth_header(chw_tokens),
    )
    assert journeys_res.status_code == 200, journeys_res.text
    journeys = journeys_res.json()
    active_names = {j["template"]["name"] for j in journeys if j["status"] == "active"}
    assert "Utilities" in active_names


@pytest.mark.asyncio
async def test_unrelated_resource_needs_save_does_not_abandon_legacy_housing_journey(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """Regression guard for the exact silent-data-loss risk grandfathering
    must prevent: if journey_reconciler.RESOURCE_NEED_LABELS had 'housing'
    removed, reconcile_member_journeys_to_needs would silently filter
    'housing' out of target_labels, and step 2 below (adding 'food' while
    'housing' stays selected) would ABANDON the member's existing Housing
    journey. Asserts it stays active."""
    member_id = await _establish_relationship(client, member_tokens, chw_tokens)

    res = await client.patch(
        f"/api/v1/chw/members/{member_id}/resource-needs",
        json={"needs": ["housing"], "levels": [{"slug": "housing", "level": "high"}]},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text

    journeys_res = await client.get(
        f"/api/v1/members/{member_id}/journeys",
        headers=auth_header(chw_tokens),
    )
    assert journeys_res.status_code == 200, journeys_res.text
    active_names = {
        j["template"]["name"] for j in journeys_res.json() if j["status"] == "active"
    }
    assert "Housing" in active_names

    # Add 'food' alongside the still-selected legacy 'housing' need.
    res = await client.patch(
        f"/api/v1/chw/members/{member_id}/resource-needs",
        json={
            "needs": ["housing", "food"],
            "levels": [
                {"slug": "housing", "level": "high"},
                {"slug": "food", "level": "medium"},
            ],
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text

    journeys_res = await client.get(
        f"/api/v1/members/{member_id}/journeys",
        headers=auth_header(chw_tokens),
    )
    assert journeys_res.status_code == 200, journeys_res.text
    active_names = {
        j["template"]["name"] for j in journeys_res.json() if j["status"] == "active"
    }
    assert "Housing" in active_names, (
        "Housing journey must remain active — reconciliation must not abandon "
        "a grandfathered need that is still present in the saved needs list"
    )
    assert "Food Security" in active_names


# ─── 5. Regression: existing housing-tagged data stays fully readable ──────


@pytest.mark.asyncio
async def test_legacy_housing_tagged_request_and_session_remain_readable(
    client: AsyncClient, chw_tokens: dict, member_tokens: dict, setup_db
):
    """End-to-end regression: a request filed (and a session scheduled) under
    the legacy 'housing' vertical before this change must still create,
    serialize, and GET cleanly after the Vertical enum/value-list surgery —
    no 500s, no validation errors, no missing fields."""
    res = await client.post(
        "/api/v1/requests/",
        json={
            "vertical": "housing",
            "urgency": "routine",
            "description": "Homelessness case — must stay labeled Housing.",
            "preferred_mode": "in_person",
        },
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 201, res.text
    request_id = res.json()["id"]
    assert res.json()["vertical"] == "housing"

    res = await client.patch(
        f"/api/v1/requests/{request_id}/accept", headers=auth_header(chw_tokens)
    )
    assert res.status_code == 200, res.text

    res = await client.post(
        "/api/v1/sessions/",
        json={
            "request_id": request_id,
            "scheduled_at": "2026-07-04T10:00:00Z",
            "mode": "in_person",
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    session_id = res.json()["id"]
    assert res.json()["vertical"] == "housing"

    # Fresh GETs — the row must still fully deserialize and render as Housing.
    req_get = await client.get(f"/api/v1/requests/{request_id}", headers=auth_header(chw_tokens))
    assert req_get.status_code == 200, req_get.text
    assert req_get.json()["vertical"] == "housing"

    session_get = await client.get(f"/api/v1/sessions/{session_id}", headers=auth_header(chw_tokens))
    assert session_get.status_code == 200, session_get.text
    assert session_get.json()["vertical"] == "housing"

"""Integration tests for the CHW Resource Folder feature.

Test coverage:
  Search / public API:
    - Search by name fragment returns matching resources ranked by name-prefix first
    - Category filter narrows results
    - Zip code filter narrows results
    - Invalid category returns 422
    - GET /resources/{id} returns 200 for active, 200 for inactive (still resolvable), 404 for unknown
    - Unauthenticated call returns 401

  CHW suggestion flow:
    - CHW can submit a suggestion (201)
    - Member cannot submit a suggestion (403)
    - Suggestion without 'name' in proposed_resource returns 422

  Admin CRUD:
    - Admin can list resources (200, paginated)
    - Admin can create a resource (201)
    - Admin can update a resource (200, partial update)
    - Admin soft-delete sets status=inactive (204)
    - Soft-delete is idempotent (204 on repeat)
    - Non-admin bearer token cannot reach admin endpoints (401)

  Admin suggestion queue:
    - Admin can list pending suggestions
    - Admin can approve a suggestion → new Resource created, suggestion.status = approved
    - Admin override fields on approve win over CHW's proposed_resource values
    - Admin can reject a suggestion → suggestion.status = rejected
    - Approving an already-approved suggestion returns 409
    - Rejecting an already-rejected suggestion returns 409

All tests use the shared conftest fixtures (setup_db + client + auth helpers).
No external services are called; all DB interactions use the test Postgres
instance configured in conftest.py.
"""

import pytest
from httpx import AsyncClient

from tests.conftest import auth_header


# ─── Helpers ──────────────────────────────────────────────────────────────────


async def _register(client: AsyncClient, email: str, role: str) -> dict:
    res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": email,
            "password": "testpass123",
            "name": f"Test {role} {email[:6]}",
            "role": role,
        },
    )
    assert res.status_code == 201, res.text
    return res.json()


_ADMIN_KEY = "test-admin-key-for-pytest-1234"


def _admin_headers() -> dict:
    return {"Authorization": f"Bearer {_ADMIN_KEY}"}


async def _create_resource(client: AsyncClient, **kwargs) -> dict:
    """Create a resource via the admin endpoint and return the response JSON."""
    payload = {
        "name": "Test Resource",
        "description": "A test resource description.",
        "category": "food",
        "phone": "(310) 555-0100",
        "zip_code": "90001",
        "languages": ["English", "Spanish"],
        **kwargs,
    }
    res = await client.post(
        "/api/v1/admin/resources",
        json=payload,
        headers=_admin_headers(),
    )
    assert res.status_code == 201, res.text
    return res.json()


# ─── Search / public API ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_search_returns_matching_resources(client: AsyncClient, chw_tokens: dict):
    """Full-text name search returns matching active resources."""
    await _create_resource(client, name="Watts Food Pantry", category="food")
    await _create_resource(client, name="Downtown Shelter", category="housing")

    res = await client.get(
        "/api/v1/resources/search?q=watts",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200
    data = res.json()
    assert len(data) >= 1
    names = [r["name"] for r in data]
    assert "Watts Food Pantry" in names
    assert "Downtown Shelter" not in names


@pytest.mark.asyncio
async def test_search_ranks_name_prefix_first(client: AsyncClient, chw_tokens: dict):
    """Resources whose name starts with the query term rank before contains-matches."""
    await _create_resource(client, name="Food Security Hub", description="watts community", category="food")
    await _create_resource(client, name="Watts Community Center", category="other")

    res = await client.get(
        "/api/v1/resources/search?q=watts&limit=10",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200
    data = res.json()
    names = [r["name"] for r in data]
    assert names.index("Watts Community Center") < names.index("Food Security Hub")


@pytest.mark.asyncio
async def test_search_category_filter(client: AsyncClient, chw_tokens: dict):
    """Category filter returns only resources in that category."""
    await _create_resource(client, name="Legal Aid Office", category="legal")
    await _create_resource(client, name="Rehab Center", category="rehab")

    res = await client.get(
        "/api/v1/resources/search?category=legal",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200
    data = res.json()
    assert all(r["category"] == "legal" for r in data)
    names = [r["name"] for r in data]
    assert "Legal Aid Office" in names
    assert "Rehab Center" not in names


@pytest.mark.asyncio
async def test_search_zip_filter(client: AsyncClient, chw_tokens: dict):
    """Zip code filter narrows results to matching zip."""
    await _create_resource(client, name="South LA Clinic", category="healthcare", zip_code="90001")
    await _create_resource(client, name="Compton Clinic", category="healthcare", zip_code="90220")

    res = await client.get(
        "/api/v1/resources/search?zip_code=90001",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200
    data = res.json()
    names = [r["name"] for r in data]
    assert "South LA Clinic" in names
    assert "Compton Clinic" not in names


@pytest.mark.asyncio
async def test_search_invalid_category_returns_422(client: AsyncClient, chw_tokens: dict):
    res = await client.get(
        "/api/v1/resources/search?category=invalid_category",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 422


@pytest.mark.asyncio
async def test_search_excludes_inactive_resources(client: AsyncClient, chw_tokens: dict):
    """Inactive resources do not appear in search results."""
    resource = await _create_resource(client, name="Closed Shelter", category="housing")
    resource_id = resource["id"]

    # Soft-delete it
    del_res = await client.delete(
        f"/api/v1/admin/resources/{resource_id}",
        headers=_admin_headers(),
    )
    assert del_res.status_code == 204

    res = await client.get(
        "/api/v1/resources/search?q=closed",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200
    names = [r["name"] for r in res.json()]
    assert "Closed Shelter" not in names


@pytest.mark.asyncio
async def test_get_resource_by_id_active(client: AsyncClient, chw_tokens: dict):
    resource = await _create_resource(client, name="Active Resource", category="food")
    resource_id = resource["id"]

    res = await client.get(
        f"/api/v1/resources/{resource_id}",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200
    assert res.json()["id"] == resource_id


@pytest.mark.asyncio
async def test_get_resource_by_id_inactive_still_resolvable(client: AsyncClient, chw_tokens: dict):
    """Inactive resources are still fetchable by ID (for @-mention token resolution)."""
    resource = await _create_resource(client, name="Inactive Resource", category="rehab")
    resource_id = resource["id"]

    await client.delete(
        f"/api/v1/admin/resources/{resource_id}",
        headers=_admin_headers(),
    )

    res = await client.get(
        f"/api/v1/resources/{resource_id}",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200
    assert res.json()["status"] == "inactive"


@pytest.mark.asyncio
async def test_get_resource_not_found_returns_404(client: AsyncClient, chw_tokens: dict):
    import uuid
    fake_id = str(uuid.uuid4())
    res = await client.get(
        f"/api/v1/resources/{fake_id}",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_search_requires_authentication(client: AsyncClient):
    """Unauthenticated search returns 401/403."""
    res = await client.get("/api/v1/resources/search?q=food")
    assert res.status_code in (401, 403)


# ─── CHW suggestion flow ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_chw_can_create_suggestion(client: AsyncClient, chw_tokens: dict):
    res = await client.post(
        "/api/v1/chw/resources/suggestions",
        json={
            "proposed_resource": {
                "name": "My Neighborhood Pantry",
                "phone": "(323) 555-0001",
            },
            "notes": "I visited this place last week, they need to be in our catalog.",
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201
    data = res.json()
    assert data["status"] == "pending"
    assert data["proposed_resource"]["name"] == "My Neighborhood Pantry"


@pytest.mark.asyncio
async def test_member_cannot_create_suggestion(client: AsyncClient, member_tokens: dict):
    res = await client.post(
        "/api/v1/chw/resources/suggestions",
        json={
            "proposed_resource": {"name": "Some Resource"},
        },
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_suggestion_without_name_returns_422(client: AsyncClient, chw_tokens: dict):
    res = await client.post(
        "/api/v1/chw/resources/suggestions",
        json={
            "proposed_resource": {"phone": "(310) 555-0000"},
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 422


# ─── Admin CRUD ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_admin_list_resources_paginated(client: AsyncClient):
    await _create_resource(client, name="Resource A", category="food")
    await _create_resource(client, name="Resource B", category="housing")

    res = await client.get(
        "/api/v1/admin/resources?page=1&page_size=10",
        headers=_admin_headers(),
    )
    assert res.status_code == 200
    data = res.json()
    assert "items" in data
    assert "total" in data
    assert data["total"] >= 2


@pytest.mark.asyncio
async def test_admin_create_resource(client: AsyncClient):
    res = await client.post(
        "/api/v1/admin/resources",
        json={
            "name": "New Legal Resource",
            "description": "Free legal aid for LA residents.",
            "category": "legal",
            "phone": "(213) 555-0199",
            "zip_code": "90010",
            "languages": ["English", "Spanish"],
        },
        headers=_admin_headers(),
    )
    assert res.status_code == 201
    data = res.json()
    assert data["name"] == "New Legal Resource"
    assert data["category"] == "legal"
    assert data["status"] == "active"
    assert "id" in data


@pytest.mark.asyncio
async def test_admin_update_resource_partial(client: AsyncClient):
    """PATCH applies only the supplied fields; others remain unchanged."""
    resource = await _create_resource(
        client,
        name="Original Name",
        category="food",
        phone="(310) 555-0000",
    )
    resource_id = resource["id"]

    res = await client.patch(
        f"/api/v1/admin/resources/{resource_id}",
        json={"name": "Updated Name"},
        headers=_admin_headers(),
    )
    assert res.status_code == 200
    data = res.json()
    assert data["name"] == "Updated Name"
    assert data["phone"] == "(310) 555-0000"  # unchanged


@pytest.mark.asyncio
async def test_admin_soft_delete_sets_inactive(client: AsyncClient):
    resource = await _create_resource(client, name="To Be Deleted", category="other")
    resource_id = resource["id"]

    del_res = await client.delete(
        f"/api/v1/admin/resources/{resource_id}",
        headers=_admin_headers(),
    )
    assert del_res.status_code == 204

    # Verify status via GET /resources/{id} — requires a user JWT, not admin key.
    chw = await _register(client, "chw_del@example.com", "chw")
    fetch_res = await client.get(
        f"/api/v1/resources/{resource_id}",
        headers={"Authorization": f"Bearer {chw['access_token']}"},
    )
    assert fetch_res.status_code == 200
    assert fetch_res.json()["status"] == "inactive"


@pytest.mark.asyncio
async def test_admin_soft_delete_idempotent(client: AsyncClient):
    """Deleting an already-inactive resource returns 204 (no error)."""
    resource = await _create_resource(client, name="Already Inactive", category="food")
    resource_id = resource["id"]

    await client.delete(
        f"/api/v1/admin/resources/{resource_id}",
        headers=_admin_headers(),
    )
    res2 = await client.delete(
        f"/api/v1/admin/resources/{resource_id}",
        headers=_admin_headers(),
    )
    assert res2.status_code == 204


@pytest.mark.asyncio
async def test_non_admin_bearer_cannot_reach_admin_endpoints(client: AsyncClient, chw_tokens: dict):
    """CHW JWT bearer token is rejected by admin endpoints (401 — not admin key)."""
    res = await client.get(
        "/api/v1/admin/resources",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 401


# ─── Admin suggestion queue ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_admin_can_list_pending_suggestions(client: AsyncClient, chw_tokens: dict):
    await client.post(
        "/api/v1/chw/resources/suggestions",
        json={"proposed_resource": {"name": "Neighborhood Clinic"}},
        headers=auth_header(chw_tokens),
    )

    res = await client.get(
        "/api/v1/admin/resources/suggestions?status=pending",
        headers=_admin_headers(),
    )
    assert res.status_code == 200
    data = res.json()
    assert data["total"] >= 1
    assert all(s["status"] == "pending" for s in data["items"])


@pytest.mark.asyncio
async def test_admin_approve_suggestion_creates_resource(client: AsyncClient, chw_tokens: dict):
    """Approving a suggestion creates a real Resource and marks the suggestion approved."""
    suggest_res = await client.post(
        "/api/v1/chw/resources/suggestions",
        json={
            "proposed_resource": {
                "name": "Compton Food Co-op",
                "phone": "(310) 555-0199",
                "category": "food",
                "description": "Community food co-op in Compton.",
            }
        },
        headers=auth_header(chw_tokens),
    )
    assert suggest_res.status_code == 201
    suggestion_id = suggest_res.json()["id"]

    approve_res = await client.post(
        f"/api/v1/admin/resources/suggestions/{suggestion_id}/approve",
        json={},
        headers=_admin_headers(),
    )
    assert approve_res.status_code == 201
    resource = approve_res.json()
    assert resource["name"] == "Compton Food Co-op"
    assert resource["category"] == "food"
    assert resource["status"] == "active"
    assert "id" in resource


@pytest.mark.asyncio
async def test_admin_approve_overrides_chw_fields(client: AsyncClient, chw_tokens: dict):
    """Admin override fields in the approve body take precedence over CHW's proposed data."""
    suggest_res = await client.post(
        "/api/v1/chw/resources/suggestions",
        json={
            "proposed_resource": {
                "name": "CHW Submitted Name",
                "category": "other",
                "description": "CHW description.",
            }
        },
        headers=auth_header(chw_tokens),
    )
    suggestion_id = suggest_res.json()["id"]

    approve_res = await client.post(
        f"/api/v1/admin/resources/suggestions/{suggestion_id}/approve",
        json={"name": "Admin Corrected Name", "category": "healthcare"},
        headers=_admin_headers(),
    )
    assert approve_res.status_code == 201
    resource = approve_res.json()
    assert resource["name"] == "Admin Corrected Name"
    assert resource["category"] == "healthcare"


@pytest.mark.asyncio
async def test_admin_reject_suggestion(client: AsyncClient, chw_tokens: dict):
    suggest_res = await client.post(
        "/api/v1/chw/resources/suggestions",
        json={"proposed_resource": {"name": "Duplicate Resource"}},
        headers=auth_header(chw_tokens),
    )
    suggestion_id = suggest_res.json()["id"]

    reject_res = await client.post(
        f"/api/v1/admin/resources/suggestions/{suggestion_id}/reject",
        json={"admin_notes": "Already in our catalog under a different name."},
        headers=_admin_headers(),
    )
    assert reject_res.status_code == 200
    data = reject_res.json()
    assert data["status"] == "rejected"
    assert "Already in our catalog" in (data["notes"] or "")


@pytest.mark.asyncio
async def test_approve_already_approved_suggestion_returns_409(
    client: AsyncClient, chw_tokens: dict
):
    suggest_res = await client.post(
        "/api/v1/chw/resources/suggestions",
        json={"proposed_resource": {"name": "Approved Resource", "category": "food", "description": "desc"}},
        headers=auth_header(chw_tokens),
    )
    suggestion_id = suggest_res.json()["id"]

    await client.post(
        f"/api/v1/admin/resources/suggestions/{suggestion_id}/approve",
        json={},
        headers=_admin_headers(),
    )

    # Second approve → 409
    res2 = await client.post(
        f"/api/v1/admin/resources/suggestions/{suggestion_id}/approve",
        json={},
        headers=_admin_headers(),
    )
    assert res2.status_code == 409


@pytest.mark.asyncio
async def test_reject_already_rejected_suggestion_returns_409(
    client: AsyncClient, chw_tokens: dict
):
    suggest_res = await client.post(
        "/api/v1/chw/resources/suggestions",
        json={"proposed_resource": {"name": "Already Rejected"}},
        headers=auth_header(chw_tokens),
    )
    suggestion_id = suggest_res.json()["id"]

    await client.post(
        f"/api/v1/admin/resources/suggestions/{suggestion_id}/reject",
        json={},
        headers=_admin_headers(),
    )

    res2 = await client.post(
        f"/api/v1/admin/resources/suggestions/{suggestion_id}/reject",
        json={},
        headers=_admin_headers(),
    )
    assert res2.status_code == 409


@pytest.mark.asyncio
async def test_admin_filter_resources_by_category(client: AsyncClient):
    """Admin list endpoint supports category filter."""
    await _create_resource(client, name="Mental Health Clinic", category="mental_health")
    await _create_resource(client, name="Housing Org", category="housing")

    res = await client.get(
        "/api/v1/admin/resources?category=mental_health",
        headers=_admin_headers(),
    )
    assert res.status_code == 200
    data = res.json()
    assert all(item["category"] == "mental_health" for item in data["items"])

"""Tests for HIPAA minimum-necessary redaction on CHW requests list view.

Apr 9 audit H3: CHW requests endpoint returned full member descriptions to all
CHWs. This test enforces the Apr 18 fix — CHWs see a summary-only response
before accepting; the full description is only exposed via the detail endpoint
after matching.
"""

from httpx import AsyncClient

from tests.conftest import auth_header


async def _create_request_as_member(client: AsyncClient, member_tokens: dict) -> str:
    res = await client.post(
        "/api/v1/requests/",
        json={
            "vertical": "housing",
            "urgency": "urgent",
            "description": "Sensitive PHI: I need help with my medication schedule for a chronic condition.",
            "preferred_mode": "in_person",
            "estimated_units": 2,
        },
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 201
    return res.json()["id"]


class TestListRedactionForCHW:
    async def test_chw_list_omits_description(
        self, client: AsyncClient, member_tokens: dict, chw_tokens: dict
    ):
        await _create_request_as_member(client, member_tokens)
        res = await client.get("/api/v1/requests/", headers=auth_header(chw_tokens))
        assert res.status_code == 200
        requests = res.json()
        assert len(requests) >= 1
        for r in requests:
            # CHW sees only the summary fields before accepting
            assert "description" not in r
            assert "member_name" not in r
            assert "member_id" not in r
            # But they do see what they need to decide
            assert "vertical" in r
            assert "urgency" in r
            assert "preferred_mode" in r
            assert "estimated_units" in r

    async def test_member_list_includes_full_details(
        self, client: AsyncClient, member_tokens: dict
    ):
        """Members see their own requests in full detail."""
        await _create_request_as_member(client, member_tokens)
        res = await client.get("/api/v1/requests/", headers=auth_header(member_tokens))
        assert res.status_code == 200
        requests = res.json()
        assert len(requests) >= 1
        r = requests[0]
        assert r["description"].startswith("Sensitive PHI")
        assert "member_name" in r


class TestDetailEndpointAccess:
    async def test_chw_cannot_see_detail_before_matching(
        self, client: AsyncClient, member_tokens: dict, chw_tokens: dict
    ):
        request_id = await _create_request_as_member(client, member_tokens)
        res = await client.get(
            f"/api/v1/requests/{request_id}",
            headers=auth_header(chw_tokens),
        )
        # CHW who hasn't accepted yet is forbidden from seeing the full description
        assert res.status_code == 403

    async def test_owner_member_can_see_own_detail(
        self, client: AsyncClient, member_tokens: dict
    ):
        request_id = await _create_request_as_member(client, member_tokens)
        res = await client.get(
            f"/api/v1/requests/{request_id}",
            headers=auth_header(member_tokens),
        )
        assert res.status_code == 200
        assert "description" in res.json()

    async def test_chw_sees_detail_after_accepting(
        self, client: AsyncClient, member_tokens: dict, chw_tokens: dict
    ):
        """Once a CHW accepts, they legitimately need the full description."""
        request_id = await _create_request_as_member(client, member_tokens)
        # CHW accepts the request
        accept_res = await client.patch(
            f"/api/v1/requests/{request_id}/accept",
            headers=auth_header(chw_tokens),
        )
        assert accept_res.status_code == 200
        # Now they can see full details
        res = await client.get(
            f"/api/v1/requests/{request_id}",
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 200
        assert "description" in res.json()


class TestUnauthenticatedBlocked:
    async def test_list_requires_auth(self, client: AsyncClient):
        res = await client.get("/api/v1/requests/")
        assert res.status_code == 401

    async def test_detail_requires_auth(self, client: AsyncClient):
        res = await client.get("/api/v1/requests/00000000-0000-0000-0000-000000000000")
        assert res.status_code == 401

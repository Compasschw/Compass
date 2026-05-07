"""Tests for PATCH /api/v1/requests/{id}/cancel.

Covers the member-cancel flow added to fix Bug 2 (member can't cancel their
own pending unmatched requests). Key invariants:

1. Only the member who owns the request may cancel it.
2. Only open requests may be cancelled (not matched/completed/cancelled).
3. Cancellation sets status to "cancelled" and returns 200.
4. CHW cannot cancel a member's request.
5. A second cancel on an already-cancelled request returns 409.
"""

import pytest
from httpx import AsyncClient

from tests.conftest import auth_header


async def _create_open_request(client: AsyncClient, member_tokens: dict) -> str:
    """Helper: create an open service request as the test member and return its ID."""
    res = await client.post(
        "/api/v1/requests/",
        json={
            "vertical": "housing",
            "urgency": "routine",
            "description": "Need help finding rental assistance programs.",
            "preferred_mode": "phone",
            "estimated_units": 1,
        },
        headers=auth_header(member_tokens),
    )
    assert res.status_code == 201, res.text
    return res.json()["id"]


class TestCancelRequest:
    async def test_member_can_cancel_own_open_request(
        self, client: AsyncClient, member_tokens: dict
    ):
        """Happy path: member cancels their own open request."""
        request_id = await _create_open_request(client, member_tokens)

        res = await client.patch(
            f"/api/v1/requests/{request_id}/cancel",
            headers=auth_header(member_tokens),
        )
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["status"] == "cancelled"
        assert body["request_id"] == request_id

    async def test_cancelled_request_appears_cancelled_in_member_list(
        self, client: AsyncClient, member_tokens: dict
    ):
        """After cancel, the request status is 'cancelled' in the member's list."""
        request_id = await _create_open_request(client, member_tokens)

        cancel_res = await client.patch(
            f"/api/v1/requests/{request_id}/cancel",
            headers=auth_header(member_tokens),
        )
        assert cancel_res.status_code == 200

        list_res = await client.get(
            "/api/v1/requests/", headers=auth_header(member_tokens)
        )
        assert list_res.status_code == 200
        requests = list_res.json()
        matching = [r for r in requests if r["id"] == request_id]
        assert len(matching) == 1
        assert matching[0]["status"] == "cancelled"

    async def test_chw_cannot_cancel_member_request(
        self, client: AsyncClient, member_tokens: dict, chw_tokens: dict
    ):
        """CHW is forbidden from cancelling a member's request — only the owner may."""
        request_id = await _create_open_request(client, member_tokens)

        res = await client.patch(
            f"/api/v1/requests/{request_id}/cancel",
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 403, res.text

    async def test_cannot_cancel_already_cancelled_request(
        self, client: AsyncClient, member_tokens: dict
    ):
        """Cancelling an already-cancelled request returns 409 Conflict."""
        request_id = await _create_open_request(client, member_tokens)

        first = await client.patch(
            f"/api/v1/requests/{request_id}/cancel",
            headers=auth_header(member_tokens),
        )
        assert first.status_code == 200

        second = await client.patch(
            f"/api/v1/requests/{request_id}/cancel",
            headers=auth_header(member_tokens),
        )
        assert second.status_code == 409, second.text

    async def test_cannot_cancel_matched_request(
        self, client: AsyncClient, member_tokens: dict, chw_tokens: dict
    ):
        """Member cannot cancel a request that has already been accepted by a CHW."""
        request_id = await _create_open_request(client, member_tokens)

        # CHW accepts — request becomes matched
        accept_res = await client.patch(
            f"/api/v1/requests/{request_id}/accept",
            headers=auth_header(chw_tokens),
        )
        assert accept_res.status_code == 200, accept_res.text

        cancel_res = await client.patch(
            f"/api/v1/requests/{request_id}/cancel",
            headers=auth_header(member_tokens),
        )
        assert cancel_res.status_code == 409, cancel_res.text

    async def test_cancel_nonexistent_request_returns_404(
        self, client: AsyncClient, member_tokens: dict
    ):
        """Cancelling a request that doesn't exist returns 404."""
        import uuid
        fake_id = str(uuid.uuid4())
        res = await client.patch(
            f"/api/v1/requests/{fake_id}/cancel",
            headers=auth_header(member_tokens),
        )
        assert res.status_code == 404, res.text

    async def test_unauthenticated_cancel_returns_401(
        self, client: AsyncClient, member_tokens: dict
    ):
        """Unauthenticated callers cannot cancel requests."""
        request_id = await _create_open_request(client, member_tokens)
        res = await client.patch(f"/api/v1/requests/{request_id}/cancel")
        assert res.status_code == 401, res.text

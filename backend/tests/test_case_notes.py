"""Integration tests for POST /case-notes, GET /members/{id}/case-notes,
PATCH /case-notes/{id}, and DELETE /case-notes/{id}.

Test plan
---------
Happy path:
  - Create a note → 201 with correct fields.
  - List notes for the member → appears in list, paginated correctly.
  - Update body + is_pinned → 200 with updated fields.
  - Soft-delete → 204, no longer visible in list.

Relationship gate:
  - A CHW with no shared session cannot create or read a member's notes (403).

Author-only enforcement:
  - A second CHW cannot edit or delete another CHW's note (404).

Validation:
  - Empty body is rejected (422).
  - Unknown note UUID returns 404.
"""

import pytest
from httpx import AsyncClient

from tests.conftest import auth_header


# ── Helpers ───────────────────────────────────────────────────────────────────


async def _register_and_create_request_match(
    client: AsyncClient,
    member_tokens: dict,
    chw_tokens: dict,
) -> tuple[str, str]:
    """Create a service request and accept it so CHW+member share a session.

    Returns (request_id, member_id).
    """
    # Get the member's ID from the profile.
    profile_res = await client.get(
        "/api/v1/member/profile", headers=auth_header(member_tokens)
    )
    assert profile_res.status_code == 200
    member_id = profile_res.json()["user_id"]

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
    assert res.status_code == 201
    request_id = res.json()["id"]

    res = await client.patch(
        f"/api/v1/requests/{request_id}/accept",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200

    # Create a session so the relationship is established.
    res = await client.post(
        "/api/v1/sessions/",
        json={
            "request_id": request_id,
            "scheduled_at": "2026-06-10T10:00:00Z",
            "mode": "in_person",
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201

    return request_id, member_id


# ── Create ────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_create_case_note_happy_path(
    client: AsyncClient, chw_tokens, member_tokens
):
    """CHW can create a standalone case note for a member they have a session with."""
    _, member_id = await _register_and_create_request_match(
        client, member_tokens, chw_tokens
    )

    res = await client.post(
        "/api/v1/case-notes",
        json={"member_id": member_id, "body": "Member is doing well."},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201
    data = res.json()
    assert data["member_id"] == member_id
    assert data["body"] == "Member is doing well."
    assert data["is_pinned"] is False
    assert "id" in data
    assert "created_at" in data


@pytest.mark.asyncio
async def test_create_case_note_with_pin(
    client: AsyncClient, chw_tokens, member_tokens
):
    """A note created with is_pinned=True is returned correctly."""
    _, member_id = await _register_and_create_request_match(
        client, member_tokens, chw_tokens
    )

    res = await client.post(
        "/api/v1/case-notes",
        json={
            "member_id": member_id,
            "body": "Pinned note.",
            "is_pinned": True,
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201
    assert res.json()["is_pinned"] is True


@pytest.mark.asyncio
async def test_create_case_note_empty_body_rejected(
    client: AsyncClient, chw_tokens, member_tokens
):
    """An empty body should be rejected with 422."""
    _, member_id = await _register_and_create_request_match(
        client, member_tokens, chw_tokens
    )

    res = await client.post(
        "/api/v1/case-notes",
        json={"member_id": member_id, "body": ""},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 422


# ── Relationship gate ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_create_case_note_no_relationship_blocked(
    client: AsyncClient, member_tokens
):
    """A CHW with no shared session cannot create a note for that member."""
    # Register a fresh CHW with no sessions with this member.
    res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "stranger_chw@example.com",
            "password": "testpass123",
            "name": "Stranger CHW",
            "role": "chw",
        },
    )
    assert res.status_code == 201
    stranger_tokens = res.json()

    # Get the member's ID.
    profile_res = await client.get(
        "/api/v1/member/profile", headers=auth_header(member_tokens)
    )
    member_id = profile_res.json()["user_id"]

    res = await client.post(
        "/api/v1/case-notes",
        json={"member_id": member_id, "body": "Attempting to access."},
        headers=auth_header(stranger_tokens),
    )
    assert res.status_code == 403


# ── List ──────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_list_case_notes_returns_own_notes_only(
    client: AsyncClient, chw_tokens, member_tokens
):
    """GET /members/{id}/case-notes returns the CHW's own notes for that member."""
    _, member_id = await _register_and_create_request_match(
        client, member_tokens, chw_tokens
    )

    # Create two notes.
    for body in ("First note.", "Second note."):
        res = await client.post(
            "/api/v1/case-notes",
            json={"member_id": member_id, "body": body},
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 201

    res = await client.get(
        f"/api/v1/members/{member_id}/case-notes",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200
    data = res.json()
    assert data["total"] == 2
    assert len(data["items"]) == 2
    # Most recent first.
    assert data["items"][0]["body"] == "Second note."
    assert data["items"][1]["body"] == "First note."


@pytest.mark.asyncio
async def test_list_case_notes_pagination(
    client: AsyncClient, chw_tokens, member_tokens
):
    """Limit/offset pagination works correctly."""
    _, member_id = await _register_and_create_request_match(
        client, member_tokens, chw_tokens
    )

    for i in range(5):
        res = await client.post(
            "/api/v1/case-notes",
            json={"member_id": member_id, "body": f"Note {i}"},
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 201

    # First page: 3 items.
    res = await client.get(
        f"/api/v1/members/{member_id}/case-notes?limit=3&offset=0",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200
    data = res.json()
    assert data["total"] == 5
    assert len(data["items"]) == 3
    assert data["limit"] == 3
    assert data["offset"] == 0

    # Second page: 2 items.
    res = await client.get(
        f"/api/v1/members/{member_id}/case-notes?limit=3&offset=3",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200
    assert len(res.json()["items"]) == 2


# ── Update ────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_update_case_note_body(
    client: AsyncClient, chw_tokens, member_tokens
):
    """PATCH /case-notes/{id} updates the body correctly."""
    _, member_id = await _register_and_create_request_match(
        client, member_tokens, chw_tokens
    )

    create_res = await client.post(
        "/api/v1/case-notes",
        json={"member_id": member_id, "body": "Original body."},
        headers=auth_header(chw_tokens),
    )
    assert create_res.status_code == 201
    note_id = create_res.json()["id"]

    res = await client.patch(
        f"/api/v1/case-notes/{note_id}",
        json={"body": "Updated body."},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200
    assert res.json()["body"] == "Updated body."


@pytest.mark.asyncio
async def test_update_case_note_pin(
    client: AsyncClient, chw_tokens, member_tokens
):
    """PATCH /case-notes/{id} with is_pinned toggles the pin state."""
    _, member_id = await _register_and_create_request_match(
        client, member_tokens, chw_tokens
    )

    create_res = await client.post(
        "/api/v1/case-notes",
        json={"member_id": member_id, "body": "Note."},
        headers=auth_header(chw_tokens),
    )
    note_id = create_res.json()["id"]
    assert create_res.json()["is_pinned"] is False

    res = await client.patch(
        f"/api/v1/case-notes/{note_id}",
        json={"is_pinned": True},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200
    assert res.json()["is_pinned"] is True


@pytest.mark.asyncio
async def test_update_case_note_author_only(
    client: AsyncClient, chw_tokens, member_tokens
):
    """A second CHW cannot edit another CHW's note — returns 404."""
    _, member_id = await _register_and_create_request_match(
        client, member_tokens, chw_tokens
    )

    create_res = await client.post(
        "/api/v1/case-notes",
        json={"member_id": member_id, "body": "CHW 1 note."},
        headers=auth_header(chw_tokens),
    )
    note_id = create_res.json()["id"]

    # Register a second CHW (no relationship needed for this test — just needs a JWT).
    res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "chw_two@example.com",
            "password": "testpass123",
            "name": "CHW Two",
            "role": "chw",
        },
    )
    chw2_tokens = res.json()

    res = await client.patch(
        f"/api/v1/case-notes/{note_id}",
        json={"body": "Hijacked body."},
        headers=auth_header(chw2_tokens),
    )
    # 404 not 403 so existence is not leaked.
    assert res.status_code == 404


# ── Delete ────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_delete_case_note_soft_deletes(
    client: AsyncClient, chw_tokens, member_tokens
):
    """DELETE /case-notes/{id} soft-deletes the note (no longer visible in list)."""
    _, member_id = await _register_and_create_request_match(
        client, member_tokens, chw_tokens
    )

    create_res = await client.post(
        "/api/v1/case-notes",
        json={"member_id": member_id, "body": "Note to delete."},
        headers=auth_header(chw_tokens),
    )
    note_id = create_res.json()["id"]

    res = await client.delete(
        f"/api/v1/case-notes/{note_id}",
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 204

    # Confirm the note is no longer in the list.
    list_res = await client.get(
        f"/api/v1/members/{member_id}/case-notes",
        headers=auth_header(chw_tokens),
    )
    assert list_res.status_code == 200
    assert list_res.json()["total"] == 0


@pytest.mark.asyncio
async def test_delete_case_note_idempotent(
    client: AsyncClient, chw_tokens, member_tokens
):
    """Calling DELETE twice returns 204 both times (idempotent)."""
    _, member_id = await _register_and_create_request_match(
        client, member_tokens, chw_tokens
    )

    create_res = await client.post(
        "/api/v1/case-notes",
        json={"member_id": member_id, "body": "To delete twice."},
        headers=auth_header(chw_tokens),
    )
    note_id = create_res.json()["id"]

    res1 = await client.delete(
        f"/api/v1/case-notes/{note_id}", headers=auth_header(chw_tokens)
    )
    assert res1.status_code == 204

    res2 = await client.delete(
        f"/api/v1/case-notes/{note_id}", headers=auth_header(chw_tokens)
    )
    assert res2.status_code == 204


@pytest.mark.asyncio
async def test_delete_case_note_author_only(
    client: AsyncClient, chw_tokens, member_tokens
):
    """A second CHW cannot delete another CHW's note — returns 404."""
    _, member_id = await _register_and_create_request_match(
        client, member_tokens, chw_tokens
    )

    create_res = await client.post(
        "/api/v1/case-notes",
        json={"member_id": member_id, "body": "CHW 1 note."},
        headers=auth_header(chw_tokens),
    )
    note_id = create_res.json()["id"]

    res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "chw_three@example.com",
            "password": "testpass123",
            "name": "CHW Three",
            "role": "chw",
        },
    )
    chw3_tokens = res.json()

    res = await client.delete(
        f"/api/v1/case-notes/{note_id}",
        headers=auth_header(chw3_tokens),
    )
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_get_unknown_note_returns_404(
    client: AsyncClient, chw_tokens
):
    """A PATCH on a random UUID that doesn't exist returns 404."""
    import uuid
    fake_id = str(uuid.uuid4())
    res = await client.patch(
        f"/api/v1/case-notes/{fake_id}",
        json={"body": "whatever"},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 404

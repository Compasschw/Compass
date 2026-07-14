"""Integration tests for CHW-only flag note endpoints (T04).

Endpoint coverage:
  GET    /api/v1/members/{member_id}/flag-note
  POST   /api/v1/members/{member_id}/flag-note
  DELETE /api/v1/members/{member_id}/flag-note

Test inventory:
  1. CHW with relationship can POST a flag note (201)
  2. CHW with relationship can GET the active flag note (200)
  3. CHW without relationship gets 403 on GET
  4. POSTing a new note deactivates the old one (only one active at a time)
  5. DELETE marks active = False; subsequent GET returns null (204 + 200)

Authorization rules verified:
  - require_role("chw") gates all three endpoints.
  - assert_shared_session gates CHW access — no relationship → 403.
"""

import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.models.flag_note import FlagNote
from tests.conftest import auth_header, complete_member_signup_payload
from tests.conftest import test_session as _test_session_factory


# ─── Shared test helpers ───────────────────────────────────────────────────────


async def _register_chw(client: AsyncClient, suffix: str = "") -> dict:
    """Register and return tokens for a CHW account."""
    res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": f"chw-flagnote{suffix}@example.com",
            "password": "Testpass123!",
            "name": f"CHW FlagNote{suffix}",
            "role": "chw",
        },
    )
    assert res.status_code == 201, f"CHW register failed: {res.text}"
    return res.json()


async def _register_member(client: AsyncClient, suffix: str = "") -> dict:
    """Register and return tokens for a member account."""
    email = f"member-flagnote{suffix}@example.com"
    payload = complete_member_signup_payload(email=email, name=f"Member FlagNote{suffix}")
    res = await client.post("/api/v1/auth/register", json=payload)
    assert res.status_code == 201, f"Member register failed: {res.text}"
    return res.json()


async def _establish_relationship(
    client: AsyncClient,
    member_tokens: dict,
    chw_tokens: dict,
) -> None:
    """Submit a service request as the member and accept it as the CHW.

    Creates the minimal relationship row (Session via accept) that satisfies
    assert_shared_session, which is required before any flag-note endpoint will
    return data instead of a 403.
    """
    create_res = await client.post(
        "/api/v1/requests/",
        headers=auth_header(member_tokens),
        json={
            "vertical": "food",
            "urgency": "routine",
            "description": "Flag note test relationship seed",
            "preferred_mode": "phone",
        },
    )
    assert create_res.status_code == 201, create_res.text
    request_id = create_res.json()["id"]

    accept_res = await client.patch(
        f"/api/v1/requests/{request_id}/accept",
        headers=auth_header(chw_tokens),
    )
    assert accept_res.status_code == 200, accept_res.text


async def _get_member_id(tokens: dict) -> str:
    """Extract the user_id UUID string from a set of login tokens."""
    import base64
    import json

    payload_b64 = tokens["access_token"].split(".")[1]
    # JWT base64 may be unpadded; pad it before decoding.
    padded = payload_b64 + "=" * (-len(payload_b64) % 4)
    payload = json.loads(base64.b64decode(padded))
    return payload["sub"]


# ─── Tests ────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_chw_can_post_flag_note(client: AsyncClient) -> None:
    """CHW with an active relationship can create a flag note (201)."""
    chw_tokens = await _register_chw(client, "-post")
    member_tokens = await _register_member(client, "-post")
    await _establish_relationship(client, member_tokens, chw_tokens)
    member_id = await _get_member_id(member_tokens)

    res = await client.post(
        f"/api/v1/members/{member_id}/flag-note",
        json={"body": "Prefers evening appointments. Transportation assistance needed."},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["body"] == "Prefers evening appointments. Transportation assistance needed."
    assert body["member_id"] == member_id
    assert "id" in body
    assert "created_at" in body


@pytest.mark.asyncio
async def test_chw_can_get_active_flag_note(client: AsyncClient) -> None:
    """CHW with a relationship can read back the active flag note (200)."""
    chw_tokens = await _register_chw(client, "-get")
    member_tokens = await _register_member(client, "-get")
    await _establish_relationship(client, member_tokens, chw_tokens)
    member_id = await _get_member_id(member_tokens)

    # Create the note first.
    post_res = await client.post(
        f"/api/v1/members/{member_id}/flag-note",
        json={"body": "Needs interpreter (Spanish)."},
        headers=auth_header(chw_tokens),
    )
    assert post_res.status_code == 201, post_res.text
    created_id = post_res.json()["id"]

    # Then fetch it.
    get_res = await client.get(
        f"/api/v1/members/{member_id}/flag-note",
        headers=auth_header(chw_tokens),
    )
    assert get_res.status_code == 200, get_res.text
    fetched = get_res.json()
    assert fetched is not None, "Expected an active flag note, got null"
    assert fetched["id"] == created_id
    assert fetched["body"] == "Needs interpreter (Spanish)."


@pytest.mark.asyncio
async def test_chw_without_relationship_gets_403(client: AsyncClient) -> None:
    """A CHW with no shared session with the member receives HTTP 403."""
    chw_tokens = await _register_chw(client, "-403")
    member_tokens = await _register_member(client, "-403")
    # Intentionally NOT calling _establish_relationship.
    member_id = await _get_member_id(member_tokens)

    get_res = await client.get(
        f"/api/v1/members/{member_id}/flag-note",
        headers=auth_header(chw_tokens),
    )
    assert get_res.status_code == 403, get_res.text

    post_res = await client.post(
        f"/api/v1/members/{member_id}/flag-note",
        json={"body": "Should not be stored."},
        headers=auth_header(chw_tokens),
    )
    assert post_res.status_code == 403, post_res.text


@pytest.mark.asyncio
async def test_post_replaces_existing_note(client: AsyncClient) -> None:
    """POSTing a second note deactivates the first — only one active at a time."""
    chw_tokens = await _register_chw(client, "-replace")
    member_tokens = await _register_member(client, "-replace")
    await _establish_relationship(client, member_tokens, chw_tokens)
    member_id = await _get_member_id(member_tokens)

    # First note.
    res1 = await client.post(
        f"/api/v1/members/{member_id}/flag-note",
        json={"body": "Original note."},
        headers=auth_header(chw_tokens),
    )
    assert res1.status_code == 201, res1.text
    first_note_id = res1.json()["id"]

    # Second note replaces the first.
    res2 = await client.post(
        f"/api/v1/members/{member_id}/flag-note",
        json={"body": "Updated note — replaces original."},
        headers=auth_header(chw_tokens),
    )
    assert res2.status_code == 201, res2.text
    second_note_id = res2.json()["id"]
    assert second_note_id != first_note_id, "Second POST should create a new note row"

    # GET must return only the new note.
    get_res = await client.get(
        f"/api/v1/members/{member_id}/flag-note",
        headers=auth_header(chw_tokens),
    )
    assert get_res.status_code == 200, get_res.text
    active = get_res.json()
    assert active is not None
    assert active["id"] == second_note_id
    assert active["body"] == "Updated note — replaces original."

    # Verify at the DB level: first note must be inactive.
    async with _test_session_factory() as db:
        result = await db.execute(
            select(FlagNote).where(FlagNote.id == uuid.UUID(first_note_id))
        )
        first_row = result.scalar_one_or_none()

    assert first_row is not None, "First note row should still exist (soft delete)"
    assert first_row.is_active is False, "First note must be deactivated after replacement"


@pytest.mark.asyncio
async def test_delete_deactivates_note_and_get_returns_null(client: AsyncClient) -> None:
    """DELETE marks the active note inactive; subsequent GET returns null."""
    chw_tokens = await _register_chw(client, "-delete")
    member_tokens = await _register_member(client, "-delete")
    await _establish_relationship(client, member_tokens, chw_tokens)
    member_id = await _get_member_id(member_tokens)

    # Create a note.
    post_res = await client.post(
        f"/api/v1/members/{member_id}/flag-note",
        json={"body": "Note to be deleted."},
        headers=auth_header(chw_tokens),
    )
    assert post_res.status_code == 201, post_res.text
    note_id = post_res.json()["id"]

    # Delete it.
    del_res = await client.delete(
        f"/api/v1/members/{member_id}/flag-note",
        headers=auth_header(chw_tokens),
    )
    assert del_res.status_code == 204, del_res.text

    # Subsequent GET must return null.
    get_res = await client.get(
        f"/api/v1/members/{member_id}/flag-note",
        headers=auth_header(chw_tokens),
    )
    assert get_res.status_code == 200, get_res.text
    assert get_res.json() is None, "Expected null after DELETE, got a note"

    # Verify at the DB level: the row still exists but is_active = False.
    async with _test_session_factory() as db:
        result = await db.execute(
            select(FlagNote).where(FlagNote.id == uuid.UUID(note_id))
        )
        row = result.scalar_one_or_none()

    assert row is not None, "Flag note row must not be hard-deleted"
    assert row.is_active is False, "Flag note must be soft-deleted (is_active=False)"

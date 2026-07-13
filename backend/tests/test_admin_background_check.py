"""Tests for PATCH /api/v1/admin/chws/{id}/background-check (Epic D2).

Covers:
- Happy path: admin (key + 2FA) sets status to "clear".
- Negative auth: no key, wrong key, key-but-no-2FA, and a CHW's own valid
  user JWT are all rejected — none may reach 200 (backend/TESTING.md rule 1).
- Validation: unknown status value -> 422; unknown/non-CHW chw_id -> 404.
- DB durability: the write actually persists (re-fetch via ORM).
"""

import os
import uuid

import pyotp
import pytest
from httpx import AsyncClient

from app.models.user import CHWProfile, User
from tests.conftest import test_session as _test_session_factory

ADMIN_KEY = os.environ.get("ADMIN_KEY", "test-admin-key-16-chars-min")


def _admin_header() -> dict[str, str]:
    return {"Authorization": f"Bearer {ADMIN_KEY}"}


def _full_admin_headers(two_fa_token: str) -> dict[str, str]:
    return {**_admin_header(), "X-Admin-2FA-Token": two_fa_token}


async def _setup_and_verify_2fa(client: AsyncClient) -> str:
    setup_res = await client.post("/api/v1/admin/2fa/setup", headers=_admin_header())
    assert setup_res.status_code == 200, setup_res.text
    secret = setup_res.json()["secret"]

    code = pyotp.TOTP(secret).now()
    verify_res = await client.post(
        "/api/v1/admin/2fa/verify",
        headers=_admin_header(),
        json={"token": code},
    )
    assert verify_res.status_code == 200, verify_res.text
    return verify_res.json()["two_fa_token"]


async def _create_chw(name: str = "BG Check CHW") -> uuid.UUID:
    user_id = uuid.uuid4()
    async with _test_session_factory() as db:
        user = User(
            id=user_id,
            email=f"{user_id}@example.com",
            password_hash="hashed",
            role="chw",
            name=name,
        )
        db.add(user)
        await db.flush()
        db.add(CHWProfile(user_id=user_id, background_check_status="pending"))
        await db.commit()
    return user_id


async def _fetch_background_status(user_id: uuid.UUID) -> str:
    async with _test_session_factory() as db:
        from sqlalchemy import select

        result = await db.execute(
            select(CHWProfile.background_check_status).where(CHWProfile.user_id == user_id)
        )
        return result.scalar_one()


class TestHappyPath:
    async def test_admin_can_set_clear(self, client: AsyncClient):
        chw_id = await _create_chw()
        two_fa = await _setup_and_verify_2fa(client)

        res = await client.patch(
            f"/api/v1/admin/chws/{chw_id}/background-check",
            headers=_full_admin_headers(two_fa),
            json={"status": "clear"},
        )
        assert res.status_code == 200, res.text
        data = res.json()
        assert data["background_check_status"] == "clear"
        assert data["chw_id"] == str(chw_id)

        # Durable.
        assert await _fetch_background_status(chw_id) == "clear"

    async def test_admin_can_set_consider(self, client: AsyncClient):
        chw_id = await _create_chw()
        two_fa = await _setup_and_verify_2fa(client)

        res = await client.patch(
            f"/api/v1/admin/chws/{chw_id}/background-check",
            headers=_full_admin_headers(two_fa),
            json={"status": "consider"},
        )
        assert res.status_code == 200
        assert await _fetch_background_status(chw_id) == "consider"

    @pytest.mark.parametrize("status", ["not_started", "pending", "clear", "consider"])
    async def test_all_valid_statuses_accepted(self, client: AsyncClient, status: str):
        chw_id = await _create_chw()
        two_fa = await _setup_and_verify_2fa(client)

        res = await client.patch(
            f"/api/v1/admin/chws/{chw_id}/background-check",
            headers=_full_admin_headers(two_fa),
            json={"status": status},
        )
        assert res.status_code == 200
        assert res.json()["background_check_status"] == status


class TestValidation:
    async def test_invalid_status_returns_422(self, client: AsyncClient):
        chw_id = await _create_chw()
        two_fa = await _setup_and_verify_2fa(client)

        res = await client.patch(
            f"/api/v1/admin/chws/{chw_id}/background-check",
            headers=_full_admin_headers(two_fa),
            json={"status": "approved"},
        )
        assert res.status_code == 422

    async def test_nonexistent_chw_returns_404(self, client: AsyncClient):
        two_fa = await _setup_and_verify_2fa(client)
        phantom_id = uuid.uuid4()

        res = await client.patch(
            f"/api/v1/admin/chws/{phantom_id}/background-check",
            headers=_full_admin_headers(two_fa),
            json={"status": "clear"},
        )
        assert res.status_code == 404

    async def test_member_id_used_as_chw_id_returns_404(self, client: AsyncClient, member_tokens: dict):
        """A valid User id that is NOT role=chw must 404, not silently succeed."""
        from app.utils.security import decode_token

        payload = decode_token(member_tokens["access_token"])
        member_id = payload["sub"]
        two_fa = await _setup_and_verify_2fa(client)

        res = await client.patch(
            f"/api/v1/admin/chws/{member_id}/background-check",
            headers=_full_admin_headers(two_fa),
            json={"status": "clear"},
        )
        assert res.status_code == 404


class TestNegativeAuth:
    """backend/TESTING.md rule 1 — every rejection path must actually 401/403,
    never fall through to 200."""

    async def test_no_credentials_rejected(self, client: AsyncClient):
        chw_id = await _create_chw()
        res = await client.patch(
            f"/api/v1/admin/chws/{chw_id}/background-check",
            json={"status": "clear"},
        )
        assert res.status_code in (401, 403)
        assert await _fetch_background_status(chw_id) == "pending"

    async def test_wrong_admin_key_rejected(self, client: AsyncClient):
        chw_id = await _create_chw()
        res = await client.patch(
            f"/api/v1/admin/chws/{chw_id}/background-check",
            headers={"Authorization": "Bearer wrong-key-entirely-00000000"},
            json={"status": "clear"},
        )
        assert res.status_code == 401
        assert await _fetch_background_status(chw_id) == "pending"

    async def test_admin_key_without_2fa_rejected(self, client: AsyncClient):
        """Admin key alone (no X-Admin-2FA-Token) must not be sufficient."""
        chw_id = await _create_chw()
        res = await client.patch(
            f"/api/v1/admin/chws/{chw_id}/background-check",
            headers=_admin_header(),
            json={"status": "clear"},
        )
        assert res.status_code in (401, 403)
        assert await _fetch_background_status(chw_id) == "pending"

    async def test_chw_own_valid_jwt_rejected(self, client: AsyncClient, chw_tokens: dict):
        """Critical: a CHW's own valid access-token JWT must NOT satisfy the
        admin-key + 2FA dependency chain — there is no header shape that lets
        a CHW's user JWT pass as an admin credential."""
        from app.utils.security import decode_token

        payload = decode_token(chw_tokens["access_token"])
        chw_id = payload["sub"]

        res = await client.patch(
            f"/api/v1/admin/chws/{chw_id}/background-check",
            headers={"Authorization": f"Bearer {chw_tokens['access_token']}"},
            json={"status": "clear"},
        )
        assert res.status_code == 401
        assert await _fetch_background_status(uuid.UUID(chw_id)) == "pending"

    async def test_member_jwt_rejected(self, client: AsyncClient, member_tokens: dict):
        chw_id = await _create_chw()
        res = await client.patch(
            f"/api/v1/admin/chws/{chw_id}/background-check",
            headers={"Authorization": f"Bearer {member_tokens['access_token']}"},
            json={"status": "clear"},
        )
        assert res.status_code == 401
        assert await _fetch_background_status(chw_id) == "pending"

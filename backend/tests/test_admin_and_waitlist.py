"""Tests for admin key auth + waitlist endpoint protection.

These tests verify the fix for Apr 9 audit findings C1 (waitlist leak) and
the Apr 18 finding (hardcoded admin key → env-configured), plus the May 2026
move of the admin-facing list endpoint behind the 2FA gate at
``GET /api/v1/admin/waitlist/entries``.
"""

import os

import pyotp
from httpx import AsyncClient

ADMIN_KEY = os.environ.get("ADMIN_KEY", "test-admin-key-16-chars-min")
WAITLIST_ADMIN_PATH = "/api/v1/admin/waitlist/entries"


def _admin_header() -> dict[str, str]:
    return {"Authorization": f"Bearer {ADMIN_KEY}"}


def _full_admin_headers(two_fa_token: str) -> dict[str, str]:
    return {**_admin_header(), "X-Admin-2FA-Token": two_fa_token}


async def _setup_and_verify_2fa(client: AsyncClient) -> str:
    """Walk TOTP setup → verify and return the short-lived 2FA JWT."""
    setup_res = await client.post(
        "/api/v1/admin/2fa/setup", headers=_admin_header()
    )
    assert setup_res.status_code == 200, setup_res.text
    secret = setup_res.json()["secret"]
    assert secret, "Expected plain secret on first setup"

    code = pyotp.TOTP(secret).now()
    verify_res = await client.post(
        "/api/v1/admin/2fa/verify",
        headers=_admin_header(),
        json={"token": code},
    )
    assert verify_res.status_code == 200, verify_res.text
    return verify_res.json()["two_fa_token"]


class TestWaitlistAuth:
    async def test_post_waitlist_is_public(self, client: AsyncClient):
        """Anyone can sign up for the waitlist — that's the whole point."""
        res = await client.post("/api/v1/waitlist/", json={
            "first_name": "Test", "last_name": "User",
            "email": "wl-public@example.com", "role": "chw",
        })
        assert res.status_code == 201

    async def test_admin_waitlist_requires_admin_key(self, client: AsyncClient):
        """GET /api/v1/admin/waitlist/entries must reject anonymous callers."""
        res = await client.get(WAITLIST_ADMIN_PATH)
        assert res.status_code in (401, 403)

    async def test_admin_waitlist_rejects_wrong_key(self, client: AsyncClient):
        res = await client.get(
            WAITLIST_ADMIN_PATH,
            headers={"Authorization": "Bearer wrong-key"},
        )
        assert res.status_code == 401

    async def test_admin_waitlist_rejects_user_jwt(
        self, client: AsyncClient, chw_tokens: dict
    ):
        """A valid CHW/member JWT is NOT sufficient for admin endpoints.
        Defense-in-depth — an authenticated marketplace user must not see
        waitlist PII.
        """
        res = await client.get(
            WAITLIST_ADMIN_PATH,
            headers={"Authorization": f"Bearer {chw_tokens['access_token']}"},
        )
        assert res.status_code == 401

    async def test_admin_waitlist_rejects_admin_key_without_2fa(
        self, client: AsyncClient
    ):
        """Admin key alone is insufficient — 2FA token is required.

        Locks the door against the historical backdoor where the legacy
        ``GET /api/v1/waitlist/`` accepted admin_key only.
        """
        res = await client.get(WAITLIST_ADMIN_PATH, headers=_admin_header())
        assert res.status_code == 401

    async def test_admin_waitlist_accepts_admin_key_plus_2fa(
        self, client: AsyncClient
    ):
        token = await _setup_and_verify_2fa(client)
        res = await client.get(
            WAITLIST_ADMIN_PATH, headers=_full_admin_headers(token)
        )
        assert res.status_code == 200
        body = res.json()
        assert "items" in body and "total" in body
        assert isinstance(body["items"], list)

    async def test_legacy_get_waitlist_is_gone(self, client: AsyncClient):
        """The pre-2FA legacy admin list endpoint must no longer exist.

        Returns 405 (not 404) because the path still hosts POST for public
        signup — only the admin-key-only GET handler was removed.
        """
        res = await client.get(
            "/api/v1/waitlist/", headers=_admin_header()
        )
        assert res.status_code == 405

    async def test_waitlist_count_does_not_require_admin(self, client: AsyncClient):
        """The count endpoint is public — it's used by the landing page."""
        res = await client.get("/api/v1/waitlist/count")
        assert res.status_code == 200
        assert "count" in res.json()


class TestAdminPage:
    async def test_admin_page_without_cookie_shows_login(self, client: AsyncClient):
        """Unauthenticated access returns the login HTML page (not a 401).
        This is a deliberate UX choice — serves the form so a human can log in."""
        res = await client.get("/api/v1/admin/waitlist")
        assert res.status_code == 200
        assert "password" in res.text.lower()

    async def test_admin_login_rejects_wrong_key(self, client: AsyncClient):
        """Wrong admin key on POST /api/v1/admin/waitlist/login returns 401."""
        res = await client.post(
            "/api/v1/admin/waitlist/login",
            data={"key": "wrong-key-definitely-not-admin"},
        )
        assert res.status_code == 401

    async def test_admin_login_sets_cookie_on_success(self, client: AsyncClient):
        """Correct admin key returns a redirect with Set-Cookie header."""
        res = await client.post(
            "/api/v1/admin/waitlist/login",
            data={"key": ADMIN_KEY},
            follow_redirects=False,
        )
        assert res.status_code == 303
        # Cookie must be HttpOnly + Secure + SameSite=Strict
        cookie_header = res.headers.get("set-cookie", "")
        assert "compass_admin=" in cookie_header
        assert "httponly" in cookie_header.lower()
        assert "samesite=strict" in cookie_header.lower()

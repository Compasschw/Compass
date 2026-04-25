"""Tests for admin key auth + waitlist endpoint protection.

These tests verify the fix for Apr 9 audit findings C1 (waitlist leak) and
the Apr 18 finding (hardcoded admin key → env-configured).
"""

import os

from httpx import AsyncClient

ADMIN_KEY = os.environ.get("ADMIN_KEY", "test-admin-key-16-chars-min")


class TestWaitlistAuth:
    async def test_post_waitlist_is_public(self, client: AsyncClient):
        """Anyone can sign up for the waitlist — that's the whole point."""
        res = await client.post("/api/v1/waitlist/", json={
            "first_name": "Test", "last_name": "User",
            "email": "wl-public@example.com", "role": "chw",
        })
        assert res.status_code == 201

    async def test_get_waitlist_requires_admin_key(self, client: AsyncClient):
        """GET /waitlist/ must NOT be readable without the admin key."""
        res = await client.get("/api/v1/waitlist/")
        # 401 because no Authorization header, 403 if key is wrong — either is fine,
        # as long as the list doesn't leak
        assert res.status_code in (401, 403)

    async def test_get_waitlist_rejects_wrong_key(self, client: AsyncClient):
        res = await client.get(
            "/api/v1/waitlist/",
            headers={"Authorization": "Bearer wrong-key"},
        )
        assert res.status_code == 401

    async def test_get_waitlist_rejects_user_jwt(
        self, client: AsyncClient, chw_tokens: dict
    ):
        """A valid CHW/member JWT is NOT sufficient for admin endpoints.
        This is a defense-in-depth check — an authenticated user should
        not see other users' waitlist PII.
        """
        res = await client.get(
            "/api/v1/waitlist/",
            headers={"Authorization": f"Bearer {chw_tokens['access_token']}"},
        )
        # JWT !== admin key; must be rejected
        assert res.status_code == 401

    async def test_get_waitlist_accepts_admin_key(self, client: AsyncClient):
        res = await client.get(
            "/api/v1/waitlist/",
            headers={"Authorization": f"Bearer {ADMIN_KEY}"},
        )
        assert res.status_code == 200
        data = res.json()
        assert isinstance(data, list)

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
            "/admin/waitlist/login",
            data={"key": "wrong-key-definitely-not-admin"},
        )
        assert res.status_code == 401

    async def test_admin_login_sets_cookie_on_success(self, client: AsyncClient):
        """Correct admin key returns a redirect with Set-Cookie header."""
        res = await client.post(
            "/admin/waitlist/login",
            data={"key": ADMIN_KEY},
            follow_redirects=False,
        )
        assert res.status_code == 303
        # Cookie must be HttpOnly + Secure + SameSite=Strict
        cookie_header = res.headers.get("set-cookie", "")
        assert "compass_admin=" in cookie_header
        assert "httponly" in cookie_header.lower()
        assert "samesite=strict" in cookie_header.lower()

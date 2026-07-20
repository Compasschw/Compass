"""CORS preflight regression tests.

Guardrail against the class of bug that broke ALL logins on 2026-07-20: the
CHW SMS 2FA frontend (Spec 2) sends an ``X-Device-Token`` header on
``POST /auth/login``, but that header was not in the CORS ``allow_headers``
list. Browsers preflight any non-safelisted request header, so the missing
entry made the preflight 400 and the browser reported a bare "Failed to fetch"
— no login could complete.

Every custom request header the frontend sends MUST be allowed here. These
tests assert the preflight succeeds for each one, so dropping a header from the
CORS config fails CI instead of production.
"""
from httpx import AsyncClient

ORIGIN = "https://joincompasschw.com"


async def _preflight(client: AsyncClient, path: str, request_headers: str):
    return await client.options(
        path,
        headers={
            "Origin": ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": request_headers,
        },
    )


async def test_login_preflight_allows_x_device_token(client: AsyncClient):
    """The exact request the 2FA login flow makes must pass preflight."""
    res = await _preflight(client, "/api/v1/auth/login", "content-type,x-device-token")
    assert res.status_code == 200, res.text
    allowed = res.headers.get("access-control-allow-headers", "").lower()
    assert "x-device-token" in allowed
    assert res.headers.get("access-control-allow-origin") == ORIGIN


async def test_admin_2fa_header_still_allowed(client: AsyncClient):
    res = await _preflight(client, "/api/v1/admin/members", "content-type,x-admin-2fa-token")
    assert res.status_code == 200, res.text
    assert "x-admin-2fa-token" in res.headers.get("access-control-allow-headers", "").lower()


async def test_core_headers_allowed(client: AsyncClient):
    res = await _preflight(client, "/api/v1/auth/login", "authorization,content-type")
    assert res.status_code == 200, res.text
    allowed = res.headers.get("access-control-allow-headers", "").lower()
    assert "authorization" in allowed and "content-type" in allowed


async def test_unknown_custom_header_is_rejected(client: AsyncClient):
    """Sanity check the preflight actually gates headers (not allow-*)."""
    res = await _preflight(client, "/api/v1/auth/login", "x-not-a-real-header")
    # Starlette CORS returns 400 when a requested header isn't allowed.
    assert res.status_code == 400

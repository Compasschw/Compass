"""Tests for the admin TOTP 2FA flow.

Covers:
- POST /api/v1/admin/2fa/setup
    * unauthenticated -> 401/403
    * first call: returns plain secret + provisioning URI, persists row
    * second call (still unverified): regenerates secret in place
    * after verification: returns blank secret + already_verified=True
- POST /api/v1/admin/2fa/verify
    * unauthenticated -> 401/403
    * before setup -> 428 setup_required
    * bad code -> 401
    * good code -> 200, returns 2fa_token JWT, sets is_verified=True
- require_2fa_token dependency on /api/v1/admin/stats
    * no admin key -> 401/403
    * admin key but no 2FA token -> 401
    * admin key + valid 2FA token -> 200
    * admin key + wrong-type JWT in 2FA header -> 401
    * admin key + tampered/expired 2FA token -> 401

These guard the read-only JSON API that exposes member/CHW PII to operators.
A regression here would be a confidentiality boundary failure.
"""

import os
from datetime import UTC, datetime, timedelta

import pyotp
from httpx import AsyncClient
from jose import jwt
from sqlalchemy import select

from app.config import settings
from tests.conftest import test_session as _test_session_factory

ADMIN_KEY = os.environ.get("ADMIN_KEY", "test-admin-key-16-chars-min")


def _admin_auth_header() -> dict[str, str]:
    """Bearer header with the configured admin key."""
    return {"Authorization": f"Bearer {ADMIN_KEY}"}


async def _setup_and_verify_2fa(client: AsyncClient) -> str:
    """Helper: walk through full setup -> verify -> return 2fa_token.

    Used by tests that need the JSON API protected by require_2fa_token.
    """
    setup_res = await client.post("/api/v1/admin/2fa/setup", headers=_admin_auth_header())
    assert setup_res.status_code == 200, setup_res.text
    secret = setup_res.json()["secret"]
    assert secret, "Plain secret should be returned on first setup"

    code = pyotp.TOTP(secret).now()
    verify_res = await client.post(
        "/api/v1/admin/2fa/verify",
        headers=_admin_auth_header(),
        json={"token": code},
    )
    assert verify_res.status_code == 200, verify_res.text
    return verify_res.json()["two_fa_token"]


# --- /2fa/setup ---------------------------------------------------------------


class TestTotpSetup:
    async def test_setup_requires_admin_key(self, client: AsyncClient):
        res = await client.post("/api/v1/admin/2fa/setup")
        # FastAPI's HTTPBearer scheme returns 403 when no header is present
        # (vs 401 for an invalid key). Either is acceptable as a hard reject.
        assert res.status_code in (401, 403)

    async def test_setup_rejects_wrong_admin_key(self, client: AsyncClient):
        res = await client.post(
            "/api/v1/admin/2fa/setup",
            headers={"Authorization": "Bearer wrong-key-not-admin"},
        )
        assert res.status_code == 401

    async def test_setup_first_call_returns_secret_and_uri(self, client: AsyncClient):
        """First setup call returns a non-empty plain secret + scannable URI."""
        res = await client.post(
            "/api/v1/admin/2fa/setup", headers=_admin_auth_header()
        )
        assert res.status_code == 200
        data = res.json()
        assert data["secret"], "Plain secret must be returned for manual entry"
        assert data["otpauth_uri"].startswith("otpauth://totp/")
        assert data["issuer"] == "CompassCHW Admin"
        assert data["already_verified"] is False
        # The plain secret must be a valid base32 TOTP key
        assert pyotp.TOTP(data["secret"]).now()  # would raise on malformed input

    async def test_setup_persists_row(self, client: AsyncClient):
        """A row in admin_totp_secrets is created with is_verified=False."""
        from app.models.admin_totp import AdminTotpSecret

        await client.post("/api/v1/admin/2fa/setup", headers=_admin_auth_header())

        async with _test_session_factory() as db:
            result = await db.execute(
                select(AdminTotpSecret).where(AdminTotpSecret.name == "default")
            )
            row = result.scalar_one_or_none()
            assert row is not None
            assert row.is_verified is False
            assert row.encrypted_secret  # AES-GCM ciphertext, not plaintext

    async def test_setup_regenerates_when_unverified(self, client: AsyncClient):
        """Calling setup again before verification rotates the secret.

        This is intentional - the operator might have lost the QR before
        scanning. We don't want a stale, unscanned secret blocking re-setup.
        """
        first = await client.post(
            "/api/v1/admin/2fa/setup", headers=_admin_auth_header()
        )
        second = await client.post(
            "/api/v1/admin/2fa/setup", headers=_admin_auth_header()
        )
        assert first.json()["secret"] != second.json()["secret"]
        assert second.json()["already_verified"] is False

    async def test_setup_after_verification_does_not_leak_secret(
        self, client: AsyncClient
    ):
        """Once verified, /setup must return blank `secret` (URI only).

        This prevents an attacker with the admin key from silently rotating
        the TOTP shared secret without proving knowledge of a TOTP code.
        """
        await _setup_and_verify_2fa(client)
        res = await client.post(
            "/api/v1/admin/2fa/setup", headers=_admin_auth_header()
        )
        assert res.status_code == 200
        data = res.json()
        assert data["secret"] == ""
        assert data["already_verified"] is True
        assert data["otpauth_uri"].startswith("otpauth://totp/")


# --- /2fa/verify --------------------------------------------------------------


class TestTotpVerify:
    async def test_verify_requires_admin_key(self, client: AsyncClient):
        res = await client.post(
            "/api/v1/admin/2fa/verify", json={"token": "123456"}
        )
        assert res.status_code in (401, 403)

    async def test_verify_before_setup_returns_428(self, client: AsyncClient):
        """No row in admin_totp_secrets -> 428 with detail 'setup_required'.

        The frontend probes with `verifyTotpCode('000000')` to decide whether
        to render the setup flow vs the code-entry flow. The 428 status code
        is load-bearing - changing it breaks the probe.
        """
        res = await client.post(
            "/api/v1/admin/2fa/verify",
            headers=_admin_auth_header(),
            json={"token": "000000"},
        )
        assert res.status_code == 428
        assert res.json()["detail"] == "setup_required"

    async def test_verify_bad_code_returns_401(self, client: AsyncClient):
        await client.post("/api/v1/admin/2fa/setup", headers=_admin_auth_header())
        res = await client.post(
            "/api/v1/admin/2fa/verify",
            headers=_admin_auth_header(),
            json={"token": "000000"},  # not the right code
        )
        assert res.status_code == 401

    async def test_verify_good_code_returns_token(self, client: AsyncClient):
        setup = await client.post(
            "/api/v1/admin/2fa/setup", headers=_admin_auth_header()
        )
        secret = setup.json()["secret"]
        code = pyotp.TOTP(secret).now()

        res = await client.post(
            "/api/v1/admin/2fa/verify",
            headers=_admin_auth_header(),
            json={"token": code},
        )
        assert res.status_code == 200
        token = res.json()["two_fa_token"]
        # Decode without verifying expiry to inspect the payload shape
        payload = jwt.decode(token, settings.secret_key, algorithms=["HS256"])
        assert payload["type"] == "admin_2fa"
        assert payload["sub"] == "admin"
        assert "exp" in payload and "iat" in payload

    async def test_verify_marks_secret_as_verified(self, client: AsyncClient):
        from app.models.admin_totp import AdminTotpSecret

        setup = await client.post(
            "/api/v1/admin/2fa/setup", headers=_admin_auth_header()
        )
        secret = setup.json()["secret"]
        code = pyotp.TOTP(secret).now()

        await client.post(
            "/api/v1/admin/2fa/verify",
            headers=_admin_auth_header(),
            json={"token": code},
        )

        async with _test_session_factory() as db:
            result = await db.execute(
                select(AdminTotpSecret).where(AdminTotpSecret.name == "default")
            )
            row = result.scalar_one_or_none()
            assert row is not None
            assert row.is_verified is True


# --- require_2fa_token on JSON API -------------------------------------------


class TestJsonApiRequires2fa:
    """The /admin/stats endpoint is the canary - it requires both
    require_admin_key AND require_2fa_token. If 2FA gating regresses,
    this test catches it before member/CHW PII leaks via /admin/chws etc.
    """

    async def test_stats_without_admin_key(self, client: AsyncClient):
        res = await client.get("/api/v1/admin/stats")
        assert res.status_code in (401, 403)

    async def test_stats_with_admin_key_but_no_2fa_token(self, client: AsyncClient):
        res = await client.get("/api/v1/admin/stats", headers=_admin_auth_header())
        assert res.status_code == 401
        assert "2fa" in res.json()["detail"].lower()

    async def test_stats_with_valid_2fa_token(self, client: AsyncClient):
        token = await _setup_and_verify_2fa(client)
        res = await client.get(
            "/api/v1/admin/stats",
            headers={**_admin_auth_header(), "X-Admin-2FA-Token": token},
        )
        assert res.status_code == 200
        # AdminStats schema sanity - non-PHI counts only
        data = res.json()
        assert "total_chws" in data
        assert "total_members" in data
        assert "open_requests" in data

    async def test_stats_rejects_wrong_token_type(self, client: AsyncClient):
        """A stolen user JWT must not satisfy require_2fa_token.

        The dependency checks payload['type'] == 'admin_2fa' explicitly.
        """
        # Forge a JWT with a non-admin_2fa type but otherwise valid signature
        forged = jwt.encode(
            {
                "type": "access",  # wrong type
                "sub": "user-123",
                "exp": datetime.now(UTC) + timedelta(minutes=15),
            },
            settings.secret_key,
            algorithm="HS256",
        )
        res = await client.get(
            "/api/v1/admin/stats",
            headers={**_admin_auth_header(), "X-Admin-2FA-Token": forged},
        )
        assert res.status_code == 401

    async def test_stats_rejects_tampered_token(self, client: AsyncClient):
        """A token signed with a different secret must be rejected."""
        forged = jwt.encode(
            {
                "type": "admin_2fa",
                "sub": "admin",
                "exp": datetime.now(UTC) + timedelta(minutes=15),
            },
            "wrong-signing-key",
            algorithm="HS256",
        )
        res = await client.get(
            "/api/v1/admin/stats",
            headers={**_admin_auth_header(), "X-Admin-2FA-Token": forged},
        )
        assert res.status_code == 401

    async def test_stats_rejects_expired_token(self, client: AsyncClient):
        expired = jwt.encode(
            {
                "type": "admin_2fa",
                "sub": "admin",
                "exp": datetime.now(UTC) - timedelta(minutes=1),  # already expired
                "iat": datetime.now(UTC) - timedelta(minutes=20),
            },
            settings.secret_key,
            algorithm="HS256",
        )
        res = await client.get(
            "/api/v1/admin/stats",
            headers={**_admin_auth_header(), "X-Admin-2FA-Token": expired},
        )
        assert res.status_code == 401

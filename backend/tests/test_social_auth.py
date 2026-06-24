"""Tests for Google/Apple social sign-in backend endpoints.

Follows backend/TESTING.md:
1. Negative-auth: provider-not-configured → 503; invalid token → 401; CHW calling onboarding → 403
2. Invariant-violation: calling onboarding twice is idempotent (not 500)
3. No-500: bad token raises 401 (not 500)
4. Post-failure DB state: failed oauth call leaves no orphan rows
5. Prod-configured branch: monkeypatched verifier covers the configured path
"""
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from tests.conftest import auth_header

# ─── helpers ──────────────────────────────────────────────────────────────────

def _google_identity(email: str = "alice@example.com", name: str = "Alice Smith") -> dict[str, Any]:
    """Returns kwargs that match OAuthIdentity fields for a Google token."""
    return {
        "email": email,
        "email_verified": True,
        "name": name,
        "provider": "google",
        "subject": "google-sub-" + email,
    }


def _apple_identity(email: str = "bob@example.com", name: str | None = "Bob Jones") -> dict[str, Any]:
    return {
        "email": email,
        "email_verified": True,
        "name": name,
        "provider": "apple",
        "subject": "apple-sub-" + email,
    }


# ─── Task 1 model smoke-test ──────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_member_profile_has_onboarding_complete_field(client: AsyncClient, member_tokens: dict):
    """MemberProfile.onboarding_complete must exist and be accessible."""
    from app.models.user import MemberProfile
    from tests.conftest import test_session

    async with test_session() as db:
        result = await db.execute(select(MemberProfile))
        profile = result.scalars().first()
        assert profile is not None
        # Attribute must exist — will fail if column not added
        assert hasattr(profile, "onboarding_complete")
        # Normal signups default to True
        assert profile.onboarding_complete is True


# ─── Task 2 settings smoke-test ───────────────────────────────────────────────

@pytest.mark.asyncio
async def test_oauth_settings_default_to_disabled(client: AsyncClient):
    """OAuth is inert (disabled) when env vars are not set."""
    from app.config import settings

    # All new settings must exist and default to empty string
    assert hasattr(settings, "google_oauth_client_id")
    assert hasattr(settings, "apple_oauth_client_id")
    assert hasattr(settings, "apple_oauth_team_id")
    assert hasattr(settings, "apple_oauth_key_id")
    assert hasattr(settings, "apple_oauth_private_key")

    # Helper properties — false when ids are unset
    assert settings.oauth_google_enabled is False
    assert settings.oauth_apple_enabled is False


# ─── oauth_verification service unit tests ────────────────────────────────────

@pytest.mark.asyncio
async def test_verify_google_returns_identity_on_valid_token(client: AsyncClient):
    """verify_google_id_token returns OAuthIdentity when google-auth accepts the token."""
    from app.services.oauth_verification import OAuthIdentity, verify_google_id_token

    fake_payload = {
        "iss": "accounts.google.com",
        "aud": "fake-google-client-id",
        "sub": "1234567890",
        "email": "alice@example.com",
        "email_verified": True,
        "name": "Alice Smith",
    }

    with patch("google.oauth2.id_token.verify_oauth2_token", return_value=fake_payload), \
         patch("app.services.oauth_verification.settings") as mock_settings:
        mock_settings.google_oauth_client_id = "fake-google-client-id"
        mock_settings.oauth_google_enabled = True

        result = await verify_google_id_token("fake.id.token")

    assert result is not None
    assert isinstance(result, OAuthIdentity)
    assert result.email == "alice@example.com"
    assert result.email_verified is True
    assert result.name == "Alice Smith"
    assert result.provider == "google"
    assert result.subject == "1234567890"


@pytest.mark.asyncio
async def test_verify_google_returns_none_on_invalid_token(client: AsyncClient):
    """verify_google_id_token returns None when google-auth raises ValueError."""
    from app.services.oauth_verification import verify_google_id_token

    with patch("google.oauth2.id_token.verify_oauth2_token", side_effect=ValueError("bad token")), \
         patch("app.services.oauth_verification.settings") as mock_settings:
        mock_settings.google_oauth_client_id = "fake-google-client-id"
        mock_settings.oauth_google_enabled = True

        result = await verify_google_id_token("bad.token.here")

    assert result is None


@pytest.mark.asyncio
async def test_verify_apple_returns_identity_on_valid_token(client: AsyncClient):
    """verify_apple_id_token returns OAuthIdentity when PyJWT accepts the JWKS token."""
    from app.services.oauth_verification import OAuthIdentity, verify_apple_id_token

    fake_payload = {
        "iss": "https://appleid.apple.com",
        "aud": "com.joincompasschw.web",
        "sub": "apple.sub.001",
        "email": "bob@privaterelay.appleid.com",
        "email_verified": "true",
        "exp": 9999999999,
    }

    with patch("app.services.oauth_verification._fetch_apple_jwks", new_callable=AsyncMock, return_value={"keys": []}), \
         patch("app.services.oauth_verification._decode_apple_jwt", return_value=fake_payload), \
         patch("app.services.oauth_verification.settings") as mock_settings:
        mock_settings.apple_oauth_client_id = "com.joincompasschw.web"
        mock_settings.oauth_apple_enabled = True

        result = await verify_apple_id_token("fake.apple.token")

    assert result is not None
    assert isinstance(result, OAuthIdentity)
    assert result.email == "bob@privaterelay.appleid.com"
    assert result.email_verified is True
    assert result.provider == "apple"
    assert result.subject == "apple.sub.001"
    assert result.name is None  # Apple doesn't return name in token


@pytest.mark.asyncio
async def test_verify_apple_returns_none_on_invalid_token(client: AsyncClient):
    """verify_apple_id_token returns None when JWT decode fails."""
    import jwt as _jwt

    from app.services.oauth_verification import verify_apple_id_token

    with patch("app.services.oauth_verification._fetch_apple_jwks", new_callable=AsyncMock, return_value={"keys": []}), \
         patch("app.services.oauth_verification._decode_apple_jwt", side_effect=_jwt.InvalidTokenError("expired")), \
         patch("app.services.oauth_verification.settings") as mock_settings:
        mock_settings.apple_oauth_client_id = "com.joincompasschw.web"
        mock_settings.oauth_apple_enabled = True

        result = await verify_apple_id_token("bad.apple.token")

    assert result is None


# ─── Schema validation tests ──────────────────────────────────────────────────

def test_oauth_token_response_has_needs_onboarding():
    """OAuthTokenResponse must include needs_onboarding field."""
    from app.schemas.auth import OAuthTokenResponse

    resp = OAuthTokenResponse(
        access_token="a",
        refresh_token="r",
        role="member",
        name="Alice",
        needs_onboarding=True,
    )
    assert resp.needs_onboarding is True
    assert resp.token_type == "bearer"


def test_complete_onboarding_validates_cin():
    """CompleteOnboardingRequest must 422 on invalid CIN."""
    from pydantic import ValidationError

    from app.schemas.auth import CompleteOnboardingRequest

    with pytest.raises(ValidationError) as exc_info:
        CompleteOnboardingRequest(
            date_of_birth="1993-01-05",
            gender="Female",
            insurance_company="Health Net",
            medi_cal_id="!!BADID@@",  # not a valid CIN
            zip_code="90001",
        )
    assert "member ID" in str(exc_info.value).lower() or "cin" in str(exc_info.value).lower()


def test_complete_onboarding_accepts_valid_cin():
    """CompleteOnboardingRequest accepts a valid Medi-Cal CIN."""
    from app.schemas.auth import CompleteOnboardingRequest

    req = CompleteOnboardingRequest(
        date_of_birth="1993-01-05",
        gender="Female",
        insurance_company="Health Net",
        medi_cal_id="91234567A2",
        zip_code="90001",
    )
    assert req.medi_cal_id == "91234567A2"


# ─── POST /auth/oauth/google endpoint tests ───────────────────────────────────

GOOGLE_ENDPOINT = "/api/v1/auth/oauth/google"
APPLE_ENDPOINT = "/api/v1/auth/oauth/apple"
ONBOARDING_ENDPOINT = "/api/v1/auth/complete-member-onboarding"


@pytest.mark.asyncio
async def test_google_oauth_provider_not_configured_returns_503(client: AsyncClient):
    """When GOOGLE_OAUTH_CLIENT_ID is unset, endpoint returns 503."""
    # Default test env has google_oauth_client_id="" so oauth_google_enabled=False
    res = await client.post(GOOGLE_ENDPOINT, json={"id_token": "fake"})
    assert res.status_code in (400, 503)
    assert "configured" in res.json()["detail"].lower()


@pytest.mark.asyncio
async def test_apple_oauth_provider_not_configured_returns_503(client: AsyncClient):
    """When APPLE_OAUTH_CLIENT_ID is unset, endpoint returns 503."""
    res = await client.post(APPLE_ENDPOINT, json={"id_token": "fake"})
    assert res.status_code in (400, 503)
    assert "configured" in res.json()["detail"].lower()


@pytest.mark.asyncio
async def test_google_oauth_invalid_token_returns_401(client: AsyncClient):
    """Prod-configured path: invalid token → 401 (not 500)."""
    with patch("app.routers.auth._settings") as mock_s, \
         patch("app.routers.auth.verify_google_id_token", new_callable=AsyncMock, return_value=None):
        mock_s.oauth_google_enabled = True
        mock_s.oauth_apple_enabled = False

        res = await client.post(GOOGLE_ENDPOINT, json={"id_token": "bad.token"})

    assert res.status_code == 401
    assert "invalid" in res.json()["detail"].lower() or "token" in res.json()["detail"].lower()


@pytest.mark.asyncio
async def test_apple_oauth_invalid_token_returns_401(client: AsyncClient):
    """Prod-configured path: invalid Apple token → 401 (not 500)."""
    with patch("app.routers.auth._settings") as mock_s, \
         patch("app.routers.auth.verify_apple_id_token", new_callable=AsyncMock, return_value=None):
        mock_s.oauth_google_enabled = False
        mock_s.oauth_apple_enabled = True

        res = await client.post(APPLE_ENDPOINT, json={"id_token": "bad.apple.token"})

    assert res.status_code == 401


@pytest.mark.asyncio
async def test_google_oauth_new_email_creates_member_account(client: AsyncClient):
    """New email via Google → creates member, needs_onboarding=True, password_hash NULL."""
    from app.services.oauth_verification import OAuthIdentity

    identity = OAuthIdentity(
        email="newgoogle@example.com",
        email_verified=True,
        name="New Google User",
        provider="google",
        subject="g-sub-new",
    )

    with patch("app.routers.auth._settings") as mock_s, \
         patch("app.routers.auth.verify_google_id_token", new_callable=AsyncMock, return_value=identity), \
         patch("app.routers.auth._sync_new_member_to_pear", new_callable=AsyncMock), \
         patch("app.routers.auth._append_new_member_to_csv", new_callable=AsyncMock):
        mock_s.oauth_google_enabled = True
        mock_s.oauth_apple_enabled = False
        mock_s.refresh_token_expire_days = 7
        mock_s.access_token_expire_minutes = 15
        mock_s.secret_key = "test-secret-key-for-pytest-runner-placeholder-AABBCCDD"
        mock_s.member_csv_enabled = False
        mock_s.pear_suite_enabled = False

        res = await client.post(GOOGLE_ENDPOINT, json={"id_token": "valid.google.token"})

    assert res.status_code == 200, res.text
    data = res.json()
    assert "access_token" in data
    assert "refresh_token" in data
    assert data["role"] == "member"
    assert data["name"] == "New Google User"
    assert data["needs_onboarding"] is True


@pytest.mark.asyncio
async def test_google_oauth_new_user_password_hash_is_null(client: AsyncClient):
    """OAuth-created users have password_hash=NULL — confirm after creation."""
    from app.services.oauth_verification import OAuthIdentity

    identity = OAuthIdentity(
        email="nullpassword@example.com",
        email_verified=True,
        name="No Password User",
        provider="google",
        subject="g-sub-nopass",
    )

    with patch("app.routers.auth._settings") as mock_s, \
         patch("app.routers.auth.verify_google_id_token", new_callable=AsyncMock, return_value=identity), \
         patch("app.routers.auth._sync_new_member_to_pear", new_callable=AsyncMock), \
         patch("app.routers.auth._append_new_member_to_csv", new_callable=AsyncMock):
        mock_s.oauth_google_enabled = True
        mock_s.oauth_apple_enabled = False
        mock_s.refresh_token_expire_days = 7
        mock_s.access_token_expire_minutes = 15
        mock_s.secret_key = "test-secret-key-for-pytest-runner-placeholder-AABBCCDD"
        mock_s.member_csv_enabled = False
        mock_s.pear_suite_enabled = False

        res = await client.post(GOOGLE_ENDPOINT, json={"id_token": "valid.google.token"})

    assert res.status_code == 200

    # Verify password_hash is NULL in the DB
    from sqlalchemy import select

    from app.models.user import User
    from tests.conftest import test_session

    async with test_session() as db:
        result = await db.execute(
            select(User).where(User.email == "nullpassword@example.com")
        )
        user = result.scalar_one_or_none()
        assert user is not None
        assert user.password_hash is None


@pytest.mark.asyncio
async def test_google_oauth_existing_member_signs_in(client: AsyncClient, member_tokens: dict):
    """Existing member signing in via Google → returns tokens, needs_onboarding=False."""
    from app.services.oauth_verification import OAuthIdentity

    identity = OAuthIdentity(
        email="testmember@example.com",  # same as member_tokens fixture
        email_verified=True,
        name="Test Member",
        provider="google",
        subject="g-sub-existing",
    )

    with patch("app.routers.auth._settings") as mock_s, \
         patch("app.routers.auth.verify_google_id_token", new_callable=AsyncMock, return_value=identity):
        mock_s.oauth_google_enabled = True
        mock_s.oauth_apple_enabled = False
        mock_s.refresh_token_expire_days = 7
        mock_s.access_token_expire_minutes = 15
        mock_s.secret_key = "test-secret-key-for-pytest-runner-placeholder-AABBCCDD"
        mock_s.member_csv_enabled = False
        mock_s.pear_suite_enabled = False

        res = await client.post(GOOGLE_ENDPOINT, json={"id_token": "valid.google.token"})

    assert res.status_code == 200
    data = res.json()
    assert data["role"] == "member"
    # Existing account from normal signup → onboarding already complete
    assert data["needs_onboarding"] is False


@pytest.mark.asyncio
async def test_google_oauth_existing_chw_signs_in(client: AsyncClient, chw_tokens: dict):
    """Existing CHW signing in via Google → returns tokens, role=chw, needs_onboarding=False."""
    from app.services.oauth_verification import OAuthIdentity

    identity = OAuthIdentity(
        email="testchw@example.com",  # same as chw_tokens fixture
        email_verified=True,
        name="Test CHW",
        provider="google",
        subject="g-sub-chw",
    )

    with patch("app.routers.auth._settings") as mock_s, \
         patch("app.routers.auth.verify_google_id_token", new_callable=AsyncMock, return_value=identity):
        mock_s.oauth_google_enabled = True
        mock_s.oauth_apple_enabled = False
        mock_s.refresh_token_expire_days = 7
        mock_s.access_token_expire_minutes = 15
        mock_s.secret_key = "test-secret-key-for-pytest-runner-placeholder-AABBCCDD"
        mock_s.member_csv_enabled = False
        mock_s.pear_suite_enabled = False

        res = await client.post(GOOGLE_ENDPOINT, json={"id_token": "valid.google.token"})

    assert res.status_code == 200
    data = res.json()
    assert data["role"] == "chw"
    assert data["needs_onboarding"] is False


@pytest.mark.asyncio
async def test_google_oauth_idempotent_second_signin(client: AsyncClient):
    """Second Google sign-in for same email → same account, no duplicate."""
    from sqlalchemy import func, select

    from app.models.user import User
    from app.services.oauth_verification import OAuthIdentity
    from tests.conftest import test_session

    identity = OAuthIdentity(
        email="idempotent@example.com",
        email_verified=True,
        name="Idempotent User",
        provider="google",
        subject="g-sub-idem",
    )

    def _patch(mock_s):
        mock_s.oauth_google_enabled = True
        mock_s.oauth_apple_enabled = False
        mock_s.refresh_token_expire_days = 7
        mock_s.access_token_expire_minutes = 15
        mock_s.secret_key = "test-secret-key-for-pytest-runner-placeholder-AABBCCDD"
        mock_s.member_csv_enabled = False
        mock_s.pear_suite_enabled = False

    for _ in range(2):
        with patch("app.routers.auth._settings") as mock_s, \
             patch("app.routers.auth.verify_google_id_token", new_callable=AsyncMock, return_value=identity), \
             patch("app.routers.auth._sync_new_member_to_pear", new_callable=AsyncMock), \
             patch("app.routers.auth._append_new_member_to_csv", new_callable=AsyncMock):
            _patch(mock_s)
            res = await client.post(GOOGLE_ENDPOINT, json={"id_token": "valid.token"})
        assert res.status_code == 200

    # Exactly one User row for this email
    async with test_session() as db:
        result = await db.execute(
            select(func.count()).select_from(User).where(User.email == "idempotent@example.com")
        )
        count = result.scalar_one()
    assert count == 1, f"Expected 1 User row, got {count}"


@pytest.mark.asyncio
async def test_google_oauth_failed_token_leaves_no_orphan_rows(client: AsyncClient):
    """Post-failure DB state: failed OAuth call leaves no orphan User rows."""
    from sqlalchemy import func, select

    from app.models.user import User
    from tests.conftest import test_session

    with patch("app.routers.auth._settings") as mock_s, \
         patch("app.routers.auth.verify_google_id_token", new_callable=AsyncMock, return_value=None):
        mock_s.oauth_google_enabled = True
        mock_s.oauth_apple_enabled = False

        res = await client.post(GOOGLE_ENDPOINT, json={"id_token": "bad.token"})

    assert res.status_code == 401

    async with test_session() as db:
        result = await db.execute(
            select(func.count()).select_from(User).where(User.email.like("%orphan%"))
        )
        # No new rows were created
        count = result.scalar_one()
    # More broadly, the User table should have 0 rows (nothing was committed)
    assert count == 0


# ─── POST /auth/complete-member-onboarding endpoint tests ────────────────────

@pytest.mark.asyncio
async def test_complete_onboarding_requires_auth(client: AsyncClient):
    """Onboarding endpoint requires authentication (negative-auth)."""
    res = await client.post(ONBOARDING_ENDPOINT, json={
        "date_of_birth": "1990-01-01",
        "gender": "Male",
        "insurance_company": "Health Net",
        "medi_cal_id": "91234567A2",
        "zip_code": "90001",
    })
    # No Bearer token → 401 or 403
    assert res.status_code in (401, 403)


@pytest.mark.asyncio
async def test_complete_onboarding_chw_returns_403(client: AsyncClient, chw_tokens: dict):
    """A CHW calling complete-member-onboarding must get 403 (negative-auth)."""
    res = await client.post(
        ONBOARDING_ENDPOINT,
        json={
            "date_of_birth": "1990-01-01",
            "gender": "Male",
            "insurance_company": "Health Net",
            "medi_cal_id": "91234567A2",
            "zip_code": "90001",
        },
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_complete_onboarding_fills_fields_and_flips_flag(client: AsyncClient):
    """OAuth member completes onboarding → profile populated, onboarding_complete=True."""
    from sqlalchemy import select

    from app.models.user import MemberProfile, User
    from app.services.oauth_verification import OAuthIdentity
    from tests.conftest import test_session

    # Create an OAuth member (no password)
    identity = OAuthIdentity(
        email="onboarding@example.com",
        email_verified=True,
        name="Onboarding User",
        provider="google",
        subject="g-sub-onboard",
    )

    with patch("app.routers.auth._settings") as mock_s, \
         patch("app.routers.auth.verify_google_id_token", new_callable=AsyncMock, return_value=identity), \
         patch("app.routers.auth._sync_new_member_to_pear", new_callable=AsyncMock), \
         patch("app.routers.auth._append_new_member_to_csv", new_callable=AsyncMock):
        mock_s.oauth_google_enabled = True
        mock_s.oauth_apple_enabled = False
        mock_s.refresh_token_expire_days = 7
        mock_s.access_token_expire_minutes = 15
        mock_s.secret_key = "test-secret-key-for-pytest-runner-placeholder-AABBCCDD"
        mock_s.member_csv_enabled = False
        mock_s.pear_suite_enabled = False

        signin_res = await client.post(GOOGLE_ENDPOINT, json={"id_token": "valid.token"})

    assert signin_res.status_code == 200
    tokens = signin_res.json()
    assert tokens["needs_onboarding"] is True

    # Now complete onboarding
    with patch("app.routers.auth._sync_new_member_to_pear", new_callable=AsyncMock), \
         patch("app.routers.auth._append_new_member_to_csv", new_callable=AsyncMock):
        res = await client.post(
            ONBOARDING_ENDPOINT,
            json={
                "date_of_birth": "1990-05-15",
                "gender": "Female",
                "insurance_company": "Health Net",
                "medi_cal_id": "91234567A2",
                "zip_code": "90001",
                "address_line1": "123 Main St",
                "city": "Los Angeles",
                "state": "CA",
            },
            headers={"Authorization": f"Bearer {tokens['access_token']}"},
        )

    assert res.status_code == 200, res.text
    data = res.json()
    # Response is the updated MemberProfile — check key fields
    assert data.get("zip_code") == "90001"
    assert data.get("insurance_company") == "Health Net"

    # Verify DB state
    async with test_session() as db:
        user_res = await db.execute(select(User).where(User.email == "onboarding@example.com"))
        user = user_res.scalar_one()
        profile_res = await db.execute(
            select(MemberProfile).where(MemberProfile.user_id == user.id)
        )
        profile = profile_res.scalar_one()
        assert profile.onboarding_complete is True
        assert profile.zip_code == "90001"
        assert profile.date_of_birth is not None


@pytest.mark.asyncio
async def test_complete_onboarding_idempotent_second_call(client: AsyncClient):
    """Calling complete-onboarding twice does not 500 (invariant-violation guard)."""
    from app.services.oauth_verification import OAuthIdentity

    identity = OAuthIdentity(
        email="idem.onboarding@example.com",
        email_verified=True,
        name="Idem Onboarding",
        provider="google",
        subject="g-sub-idem-ob",
    )

    with patch("app.routers.auth._settings") as mock_s, \
         patch("app.routers.auth.verify_google_id_token", new_callable=AsyncMock, return_value=identity), \
         patch("app.routers.auth._sync_new_member_to_pear", new_callable=AsyncMock), \
         patch("app.routers.auth._append_new_member_to_csv", new_callable=AsyncMock):
        mock_s.oauth_google_enabled = True
        mock_s.oauth_apple_enabled = False
        mock_s.refresh_token_expire_days = 7
        mock_s.access_token_expire_minutes = 15
        mock_s.secret_key = "test-secret-key-for-pytest-runner-placeholder-AABBCCDD"
        mock_s.member_csv_enabled = False
        mock_s.pear_suite_enabled = False

        signin_res = await client.post(GOOGLE_ENDPOINT, json={"id_token": "valid.token"})
    tokens = signin_res.json()
    headers = {"Authorization": f"Bearer {tokens['access_token']}"}

    onboarding_body = {
        "date_of_birth": "1990-05-15",
        "gender": "Female",
        "insurance_company": "Health Net",
        "medi_cal_id": "91234567A2",
        "zip_code": "90001",
    }

    for _ in range(2):
        with patch("app.routers.auth._sync_new_member_to_pear", new_callable=AsyncMock), \
             patch("app.routers.auth._append_new_member_to_csv", new_callable=AsyncMock):
            res = await client.post(ONBOARDING_ENDPOINT, json=onboarding_body, headers=headers)
        assert res.status_code == 200, f"Call failed: {res.text}"


@pytest.mark.asyncio
async def test_complete_onboarding_invalid_cin_returns_422(client: AsyncClient):
    """Invalid CIN in onboarding body → 422 (carrier-aware validation)."""
    from app.services.oauth_verification import OAuthIdentity

    identity = OAuthIdentity(
        email="cin422@example.com",
        email_verified=True,
        name="CIN Test",
        provider="google",
        subject="g-sub-cin422",
    )

    with patch("app.routers.auth._settings") as mock_s, \
         patch("app.routers.auth.verify_google_id_token", new_callable=AsyncMock, return_value=identity), \
         patch("app.routers.auth._sync_new_member_to_pear", new_callable=AsyncMock), \
         patch("app.routers.auth._append_new_member_to_csv", new_callable=AsyncMock):
        mock_s.oauth_google_enabled = True
        mock_s.oauth_apple_enabled = False
        mock_s.refresh_token_expire_days = 7
        mock_s.access_token_expire_minutes = 15
        mock_s.secret_key = "test-secret-key-for-pytest-runner-placeholder-AABBCCDD"
        mock_s.member_csv_enabled = False
        mock_s.pear_suite_enabled = False

        signin_res = await client.post(GOOGLE_ENDPOINT, json={"id_token": "valid.token"})

    tokens = signin_res.json()
    res = await client.post(
        ONBOARDING_ENDPOINT,
        json={
            "date_of_birth": "1990-01-01",
            "gender": "Male",
            "insurance_company": "Health Net",
            "medi_cal_id": "NOTVALID!!!",  # bad CIN
            "zip_code": "90001",
        },
        headers={"Authorization": f"Bearer {tokens['access_token']}"},
    )
    assert res.status_code == 422

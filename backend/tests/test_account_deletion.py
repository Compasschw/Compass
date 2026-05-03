"""Tests for the HIPAA-critical member account deletion flow.

Covers DELETE /api/v1/member/account (implemented inline in member.py router).

Policy under test: soft-delete + PHI pseudonymisation
- User row is kept for Medi-Cal 7-year retention (22 CCR §51476); PII is
  overwritten with deterministic sentinel values so remaining foreign-key
  references in SessionRequest / BillingClaim / AuditLog remain valid but
  non-identifying.
- MemberProfile PHI fields (medi_cal_id, insurance_provider, zip_code,
  latitude, longitude) are nulled out.
- All RefreshTokens for the user are revoked, not hard-deleted, so
  subsequent /auth/refresh calls fail cleanly with 401.
- is_active=False + empty password_hash prevents any further login.

A regression in this flow is a HIPAA confidentiality boundary failure.
These tests must remain green before any refactor touches member.py,
account_deletion.py, or the User / MemberProfile / RefreshToken models.
"""

import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.models.auth import RefreshToken
from app.models.user import MemberProfile, User
from tests.conftest import auth_header, test_session as _test_session_factory

_DELETE_URL = "/api/v1/member/account"
_MEMBER_EMAIL = "testmember@example.com"
_MEMBER_PASSWORD = "testpass123"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _login(client: AsyncClient, email: str, password: str) -> dict:
    """Return a fresh token dict from /auth/login."""
    res = await client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": password},
    )
    return res


async def _delete_account(client: AsyncClient, tokens: dict) -> object:
    """Issue DELETE /api/v1/member/account with the given bearer token."""
    return await client.delete(_DELETE_URL, headers=auth_header(tokens))


async def _fetch_user(user_id: uuid.UUID) -> User | None:
    """Read the User row directly from the test DB (bypasses the app layer)."""
    async with _test_session_factory() as db:
        return await db.get(User, user_id)


async def _fetch_member_profile(user_id: uuid.UUID) -> MemberProfile | None:
    """Read the MemberProfile row directly from the test DB."""
    async with _test_session_factory() as db:
        result = await db.execute(
            select(MemberProfile).where(MemberProfile.user_id == user_id)
        )
        return result.scalar_one_or_none()


async def _fetch_refresh_tokens(user_id: uuid.UUID) -> list[RefreshToken]:
    """Return all RefreshToken rows for a user (revoked or not)."""
    async with _test_session_factory() as db:
        result = await db.execute(
            select(RefreshToken).where(RefreshToken.user_id == user_id)
        )
        return list(result.scalars().all())


def _extract_user_id(tokens: dict) -> uuid.UUID:
    """Decode the user UUID from the access_token payload without verifying expiry."""
    import base64
    import json

    # JWT is header.payload.sig — we only need the payload part.
    payload_b64 = tokens["access_token"].split(".")[1]
    # Pad to a multiple of 4 for urlsafe_b64decode.
    payload_b64 += "=" * (-len(payload_b64) % 4)
    payload = json.loads(base64.urlsafe_b64decode(payload_b64))
    return uuid.UUID(payload["sub"])


# ---------------------------------------------------------------------------
# Authentication / authorisation guards
# ---------------------------------------------------------------------------


class TestDeleteAccountAuthGuards:
    """Verify the endpoint rejects unauthenticated and wrong-role callers.

    These are hard security boundaries — the endpoint must never be reachable
    without a valid member JWT.
    """

    async def test_delete_without_auth_header_is_rejected(self, client: AsyncClient):
        """No Authorization header -> 401 or 403.

        FastAPI's HTTPBearer scheme returns 403 when the header is absent
        and 401 when a token is present but invalid.  Both are hard rejects.
        """
        res = await client.delete(_DELETE_URL)
        assert res.status_code in (401, 403), (
            f"Expected 401/403 for unauthenticated DELETE, got {res.status_code}"
        )

    async def test_delete_with_invalid_token_is_rejected(self, client: AsyncClient):
        """A garbage Bearer token must not reach the handler."""
        res = await client.delete(
            _DELETE_URL,
            headers={"Authorization": "Bearer this.is.not.a.valid.jwt"},
        )
        assert res.status_code in (401, 403)

    async def test_delete_as_chw_role_is_rejected(
        self, client: AsyncClient, chw_tokens: dict
    ):
        """A CHW JWT must not satisfy require_role('member').

        The deletion endpoint is gated on role='member'.  Allowing a CHW to
        hit it would either delete the wrong account or expose an IDOR vector.
        """
        res = await _delete_account(client, chw_tokens)
        assert res.status_code == 403, (
            f"CHW role must be rejected with 403, got {res.status_code}"
        )


# ---------------------------------------------------------------------------
# Successful deletion — HTTP response
# ---------------------------------------------------------------------------


class TestDeleteAccountResponse:
    """Verify the HTTP contract of a successful deletion."""

    async def test_successful_delete_returns_204(
        self, client: AsyncClient, member_tokens: dict
    ):
        """DELETE /account must return 204 No Content on success.

        204 signals to the client that the request succeeded and there is no
        response body to parse — important for mobile clients that check
        status codes to drive post-deletion navigation.
        """
        res = await _delete_account(client, member_tokens)
        assert res.status_code == 204, (
            f"Expected 204 No Content, got {res.status_code}: {res.text}"
        )

    async def test_successful_delete_has_empty_body(
        self, client: AsyncClient, member_tokens: dict
    ):
        """204 response must carry no body — not even an empty JSON object."""
        res = await _delete_account(client, member_tokens)
        assert res.content == b"", (
            f"204 response body must be empty, got: {res.content!r}"
        )


# ---------------------------------------------------------------------------
# PHI scrubbing — User model fields
# ---------------------------------------------------------------------------


class TestDeleteAccountUserPhi:
    """Verify every PII field on the User row is overwritten after deletion.

    Each assertion below maps directly to a HIPAA-covered identifier as
    defined in 45 CFR §164.514(b)(2). A regression on any of these is a
    potential PHI disclosure.
    """

    async def test_user_is_marked_inactive(
        self, client: AsyncClient, member_tokens: dict
    ):
        """is_active must be False so the account cannot be used for anything."""
        user_id = _extract_user_id(member_tokens)
        await _delete_account(client, member_tokens)

        user = await _fetch_user(user_id)
        assert user is not None
        assert user.is_active is False, "is_active must be False after deletion"

    async def test_user_name_is_pseudonymised(
        self, client: AsyncClient, member_tokens: dict
    ):
        """name must be replaced with the deterministic 'deleted-user-<id>' sentinel."""
        user_id = _extract_user_id(member_tokens)
        await _delete_account(client, member_tokens)

        user = await _fetch_user(user_id)
        assert user is not None
        assert user.name == f"deleted-user-{user_id}", (
            f"name must be pseudonymised, got: {user.name!r}"
        )

    async def test_user_email_is_pseudonymised(
        self, client: AsyncClient, member_tokens: dict
    ):
        """email must be replaced with a non-routable sentinel that encodes the user id.

        The email column has a UNIQUE constraint, so the pseudonym must be
        deterministic (based on user.id) to allow deletion of multiple accounts
        without collisions.
        """
        user_id = _extract_user_id(member_tokens)
        await _delete_account(client, member_tokens)

        user = await _fetch_user(user_id)
        assert user is not None
        # The router uses f"deleted-user-{user.id}@deleted.invalid"
        assert user.email == f"deleted-user-{user_id}@deleted.invalid", (
            f"email must be pseudonymised, got: {user.email!r}"
        )
        assert _MEMBER_EMAIL not in user.email, (
            "Original email must not appear anywhere in the pseudonymised value"
        )

    async def test_user_phone_is_nulled(
        self, client: AsyncClient, member_tokens: dict
    ):
        """phone (a HIPAA direct identifier) must be set to NULL."""
        user_id = _extract_user_id(member_tokens)
        await _delete_account(client, member_tokens)

        user = await _fetch_user(user_id)
        assert user is not None
        assert user.phone is None, f"phone must be None after deletion, got: {user.phone!r}"

    async def test_user_password_hash_is_cleared(
        self, client: AsyncClient, member_tokens: dict
    ):
        """password_hash must be set to an empty string to prevent future logins.

        An empty string is intentional — bcrypt will never produce an empty
        hash, so any verify() call against it returns False without a timing
        side-channel.
        """
        user_id = _extract_user_id(member_tokens)
        await _delete_account(client, member_tokens)

        user = await _fetch_user(user_id)
        assert user is not None
        assert user.password_hash == "", (
            f"password_hash must be empty string, got: {user.password_hash!r}"
        )


# ---------------------------------------------------------------------------
# PHI scrubbing — MemberProfile fields
# ---------------------------------------------------------------------------


class TestDeleteAccountMemberProfilePhi:
    """Verify every PHI field on MemberProfile is nulled after deletion.

    medi_cal_id is AES-256-GCM encrypted at rest (EncryptedString column) and
    is a HIPAA-covered unique identifier.  The remaining fields (zip_code,
    lat/lon, insurance_provider) are quasi-identifiers that can re-identify
    the member when combined.
    """

    async def _register_member_with_profile(
        self, client: AsyncClient
    ) -> tuple[dict, uuid.UUID]:
        """Register a fresh member, seed a MemberProfile with PHI, return (tokens, user_id).

        Registration via /auth/register creates only the User row. The
        MemberProfile row is normally seeded by the onboarding flow, which we
        bypass here by inserting the row directly via the ORM with sentinel
        PHI values that we can later assert have been nulled out.
        """
        reg_res = await client.post(
            "/api/v1/auth/register",
            json={
                "email": "phi-member@example.com",
                "password": "testpass123",
                "name": "PHI Test Member",
                "role": "member",
            },
        )
        assert reg_res.status_code == 201, reg_res.text
        tokens = reg_res.json()
        user_id = _extract_user_id(tokens)

        # Populate the auto-created MemberProfile (signup-time provisioning
        # added in Phase 1A) with PHI directly via the ORM so we have
        # something to assert against after the deletion scrubs it.
        from sqlalchemy import select as _select
        async with _test_session_factory() as db:
            existing = await db.execute(
                _select(MemberProfile).where(MemberProfile.user_id == user_id)
            )
            profile = existing.scalar_one()
            profile.zip_code = "90210"
            profile.insurance_provider = "Blue Shield"
            profile.medi_cal_id = "MCAL-12345678"
            profile.latitude = 34.0901
            profile.longitude = -118.4065
            await db.commit()
        return tokens, user_id

    async def test_member_profile_phi_fields_are_nulled(self, client: AsyncClient):
        """medi_cal_id, insurance_provider, zip_code, latitude, longitude -> None.

        All five are PHI or quasi-identifiers.  None of them should survive
        the deletion scrub.
        """
        tokens, user_id = await self._register_member_with_profile(client)
        await _delete_account(client, tokens)

        profile = await _fetch_member_profile(user_id)
        assert profile is not None, (
            "MemberProfile row must be retained (FK anchor for session history)"
        )
        assert profile.medi_cal_id is None, "medi_cal_id must be None after deletion"
        assert profile.insurance_provider is None, (
            "insurance_provider must be None after deletion"
        )
        assert profile.zip_code is None, "zip_code must be None after deletion"
        assert profile.latitude is None, "latitude must be None after deletion"
        assert profile.longitude is None, "longitude must be None after deletion"


# ---------------------------------------------------------------------------
# Token revocation
# ---------------------------------------------------------------------------


class TestDeleteAccountTokenRevocation:
    """Verify all refresh tokens are revoked (not hard-deleted) by the router.

    The router sets revoked=True on active RefreshToken rows.  Rows must be
    retained so that /auth/refresh calls with old tokens return 401 (not 404),
    giving the client a clean, unambiguous error instead of a confusing
    'token not found' path.
    """

    async def test_all_refresh_tokens_are_revoked(
        self, client: AsyncClient, member_tokens: dict
    ):
        """Every RefreshToken for the user must have revoked=True after deletion."""
        user_id = _extract_user_id(member_tokens)

        # Issue a second refresh so the user has more than one token in flight.
        await client.post(
            "/api/v1/auth/refresh",
            json={"refresh_token": member_tokens["refresh_token"]},
        )

        await _delete_account(client, member_tokens)

        tokens = await _fetch_refresh_tokens(user_id)
        assert len(tokens) > 0, (
            "RefreshToken rows must be retained (soft-revoke, not hard-delete) "
            "so subsequent /auth/refresh returns 401 rather than 404"
        )
        non_revoked = [t for t in tokens if not t.revoked]
        assert non_revoked == [], (
            f"Found {len(non_revoked)} non-revoked token(s) after deletion — "
            "all must be revoked to prevent session continuation"
        )


# ---------------------------------------------------------------------------
# Post-deletion credential verification
# ---------------------------------------------------------------------------


class TestDeleteAccountPostDeletionCredentials:
    """Verify that deleted account credentials cannot be used after deletion.

    These are the attacker-path tests: if PHI scrubbing works but the auth
    endpoints still accept the old credentials, the access-control boundary
    has failed.
    """

    async def test_login_with_original_credentials_fails_after_delete(
        self, client: AsyncClient, member_tokens: dict
    ):
        """Login with the pre-deletion email+password must return 401.

        Two reasons this must fail:
        1. password_hash is set to '' — bcrypt verify returns False.
        2. is_active=False — even a correct hash would be rejected.

        Either guard alone is sufficient; both together are belt-and-suspenders.
        """
        await _delete_account(client, member_tokens)

        login_res = await _login(client, _MEMBER_EMAIL, _MEMBER_PASSWORD)
        assert login_res.status_code == 401, (
            f"Login after deletion must return 401, got {login_res.status_code}: "
            f"{login_res.text}"
        )

    async def test_refresh_with_revoked_token_fails_after_delete(
        self, client: AsyncClient, member_tokens: dict
    ):
        """Using the pre-deletion refresh token after account deletion must return 401.

        The revoked=True flag on the RefreshToken row is the guard.  A
        regression here means a deleted user can silently maintain a session.
        """
        original_refresh_token = member_tokens["refresh_token"]
        await _delete_account(client, member_tokens)

        refresh_res = await client.post(
            "/api/v1/auth/refresh",
            json={"refresh_token": original_refresh_token},
        )
        assert refresh_res.status_code == 401, (
            f"Refresh with revoked token must return 401, got {refresh_res.status_code}: "
            f"{refresh_res.text}"
        )

    async def test_access_profile_with_original_token_fails_after_delete(
        self, client: AsyncClient, member_tokens: dict
    ):
        """The original access token must not grant access to /member/profile.

        The access token is a short-lived JWT.  Once is_active=False, the
        require_role dependency must reject it.  This verifies that the
        dependency checks is_active on every request, not just at login.
        """
        await _delete_account(client, member_tokens)

        profile_res = await client.get(
            "/api/v1/member/profile",
            headers=auth_header(member_tokens),
        )
        assert profile_res.status_code in (401, 403), (
            f"Profile access with deleted account token must be rejected, "
            f"got {profile_res.status_code}"
        )


# ---------------------------------------------------------------------------
# Idempotency — double deletion
# ---------------------------------------------------------------------------


class TestDeleteAccountIdempotency:
    """Verify that attempting to delete an already-deleted account is handled safely.

    The first DELETE deactivates the account and revokes the bearer token's
    session.  The second DELETE arrives with the same (now-invalidated) access
    token.  The system must not crash — it must return a clean auth error.

    Note: the router does not implement a separate idempotency guard (unlike
    account_deletion.py which checks deleted_at).  The second call fails at
    the require_role dependency because is_active=False, so the handler body
    is never reached.  This is acceptable — the net result (no state mutation,
    clean HTTP error) is what matters.
    """

    async def test_second_delete_does_not_crash(
        self, client: AsyncClient, member_tokens: dict
    ):
        """A second DELETE with the same token must return 401/403, not 500.

        After the first delete, is_active=False, so require_role('member')
        will reject the stale access token before the handler executes.
        The important invariant: no unhandled exception, no 5xx.
        """
        first_res = await _delete_account(client, member_tokens)
        assert first_res.status_code == 204, (
            f"First delete must succeed with 204, got {first_res.status_code}"
        )

        second_res = await _delete_account(client, member_tokens)
        assert second_res.status_code in (401, 403), (
            f"Second delete must return 401/403 (inactive account), "
            f"got {second_res.status_code}: {second_res.text}"
        )
        assert second_res.status_code != 500, (
            "Second delete must never return 500 — idempotent failure path must be clean"
        )

    async def test_user_row_not_duplicated_after_double_delete(
        self, client: AsyncClient, member_tokens: dict
    ):
        """The User row must exist exactly once after two delete attempts."""
        user_id = _extract_user_id(member_tokens)

        await _delete_account(client, member_tokens)
        await _delete_account(client, member_tokens)

        async with _test_session_factory() as db:
            result = await db.execute(
                select(User).where(User.id == user_id)
            )
            rows = list(result.scalars().all())

        assert len(rows) == 1, (
            f"User row must exist exactly once after double delete, found {len(rows)}"
        )
        assert rows[0].is_active is False

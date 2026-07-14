"""Tests for the HIPAA-critical member account HARD-deletion flow.

Covers DELETE /api/v1/auth/users/me (implemented in app/services/account_deletion.py,
called from app/routers/auth.py::delete_account). This is the SOLE surviving
account-deletion endpoint — the previous parallel implementation at
DELETE /api/v1/member/account has been deleted outright (Epic E4, 2026-07
founder decision: hard-delete supersedes the prior soft-delete/anonymize design).

Policy under test: TRUE hard delete, users row scrubbed in place
- The `users` row is KEPT (never a literal `DELETE FROM users`) only because
  wellness_points_ledger / reward_redemptions carry an ondelete=RESTRICT FK
  AND have UPDATE/DELETE fully REVOKEd from the app DB role — see
  account_deletion.py's module docstring for the full explanation. Every
  PII-identifying column on that row is scrubbed to a random, non-identifying
  sentinel.
- MemberProfile and every other member-owned PHI table (case notes, flag
  notes, documents, sessions, messages, conversations, assessments,
  journeys, service requests, reward transactions, testimonials, twilio
  proxy sessions, etc.) are HARD-DELETED — rows are gone, not soft-deleted.
- RefreshTokens are HARD-DELETED (not merely revoked) — the parent row has
  no PII left, so keeping revoked tokens around serves no purpose.
- The original email is freed immediately for re-registration (fresh
  uuid4-based sentinel, never deterministic from user id).
- is_active=False + role="deleted" + empty password_hash prevents any
  further login or role-gated access.

A regression in this flow is a HIPAA confidentiality boundary failure OR a
silent-data-retention failure (the founder's product decision requires data
to actually be gone, not merely hidden). These tests must remain green
before any refactor touches auth.py's delete_account handler,
account_deletion.py, or the User / MemberProfile / RefreshToken models.
"""

import uuid
from unittest.mock import patch

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.models.auth import RefreshToken
from app.models.user import MemberProfile, User
from app.services.s3_phi_cleanup import PhiCleanupResult
from tests.conftest import auth_header, complete_member_signup_payload
from tests.conftest import test_session as _test_session_factory

_DELETE_URL = "/api/v1/auth/users/me"
_MEMBER_EMAIL = "testmember@example.com"
_MEMBER_PASSWORD = "Testpass123!"


@pytest.fixture(autouse=True)
def _stub_s3_phi_cleanup():
    """Keep deletion tests off real AWS: stub the per-bucket S3 worker.

    Patches the innermost sync function so the async wiring
    (delete_member_phi_objects → asyncio.to_thread) still executes.
    Dedicated S3 behaviour tests live in test_s3_phi_cleanup.py.
    """
    with patch(
        "app.services.s3_phi_cleanup._cleanup_sync",
        return_value=PhiCleanupResult(),
    ):
        yield


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _login(client: AsyncClient, email: str, password: str):
    """Return a fresh token dict from /auth/login."""
    return await client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": password},
    )


async def _delete_account(client: AsyncClient, tokens: dict):
    """Issue DELETE /api/v1/auth/users/me with the given bearer token.

    The endpoint's request body (_DeleteAccountBody) has one optional field
    (`password`), so httpx needs `request()` to send a JSON body on DELETE —
    a plain `client.delete()` call cannot carry a body.
    """
    return await client.request(
        "DELETE",
        _DELETE_URL,
        json={},
        headers=auth_header(tokens),
    )


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
    without a valid JWT belonging to the account owner.
    """

    async def test_delete_without_auth_header_is_rejected(self, client: AsyncClient):
        """No Authorization header -> 401 or 403."""
        res = await client.request("DELETE", _DELETE_URL, json={})
        assert res.status_code in (401, 403), (
            f"Expected 401/403 for unauthenticated DELETE, got {res.status_code}"
        )

    async def test_delete_with_invalid_token_is_rejected(self, client: AsyncClient):
        """A garbage Bearer token must not reach the handler."""
        res = await client.request(
            "DELETE",
            _DELETE_URL,
            json={},
            headers={"Authorization": "Bearer this.is.not.a.valid.jwt"},
        )
        assert res.status_code in (401, 403)

    async def test_delete_as_chw_role_is_permitted_for_the_chws_own_account(
        self, client: AsyncClient, chw_tokens: dict
    ):
        """DELETE /auth/users/me is role-agnostic (any authenticated user may
        delete their OWN account) — unlike the removed member-only
        /member/account endpoint. A CHW hitting this URL deletes the CHW's
        own account, not a member's; this is not a privilege-escalation path
        because current_user is always resolved from the caller's own JWT.
        """
        res = await _delete_account(client, chw_tokens)
        assert res.status_code == 204, (
            f"A CHW deleting their own account must succeed, got {res.status_code}: {res.text}"
        )


# ---------------------------------------------------------------------------
# Successful deletion — HTTP response
# ---------------------------------------------------------------------------


class TestDeleteAccountResponse:
    """Verify the HTTP contract of a successful deletion."""

    async def test_successful_delete_returns_204(
        self, client: AsyncClient, member_tokens: dict
    ):
        res = await _delete_account(client, member_tokens)
        assert res.status_code == 204, (
            f"Expected 204 No Content, got {res.status_code}: {res.text}"
        )

    async def test_successful_delete_has_empty_body(
        self, client: AsyncClient, member_tokens: dict
    ):
        res = await _delete_account(client, member_tokens)
        assert res.content == b"", (
            f"204 response body must be empty, got: {res.content!r}"
        )


# ---------------------------------------------------------------------------
# users row — scrubbed-in-place tombstone
# ---------------------------------------------------------------------------


class TestDeleteAccountUserRowTombstone:
    """Verify the users row is kept (never a literal DELETE FROM users) but
    every PII-identifying column is scrubbed to a non-identifying sentinel.
    """

    async def test_user_row_still_exists_with_same_id(
        self, client: AsyncClient, member_tokens: dict
    ):
        """The row must survive deletion — see account_deletion.py module
        docstring for why (wellness_points_ledger / reward_redemptions RESTRICT)."""
        user_id = _extract_user_id(member_tokens)
        await _delete_account(client, member_tokens)

        user = await _fetch_user(user_id)
        assert user is not None, "users row must be kept (scrub-in-place, not literal DELETE)"
        assert user.id == user_id

    async def test_user_role_is_set_to_deleted_sentinel(
        self, client: AsyncClient, member_tokens: dict
    ):
        user_id = _extract_user_id(member_tokens)
        await _delete_account(client, member_tokens)

        user = await _fetch_user(user_id)
        assert user is not None
        assert user.role == "deleted", f"role must be 'deleted', got: {user.role!r}"

    async def test_user_is_marked_inactive(
        self, client: AsyncClient, member_tokens: dict
    ):
        user_id = _extract_user_id(member_tokens)
        await _delete_account(client, member_tokens)

        user = await _fetch_user(user_id)
        assert user is not None
        assert user.is_active is False, "is_active must be False after deletion"

    async def test_user_name_is_generic_sentinel(
        self, client: AsyncClient, member_tokens: dict
    ):
        user_id = _extract_user_id(member_tokens)
        await _delete_account(client, member_tokens)

        user = await _fetch_user(user_id)
        assert user is not None
        assert user.name == "Deleted User", f"name must be generic sentinel, got: {user.name!r}"

    async def test_user_email_is_randomised_not_deterministic(
        self, client: AsyncClient, member_tokens: dict
    ):
        """email must be a FRESH random uuid4-based sentinel — NOT the old
        deterministic f"deleted-{user_id}@..." pattern, and must not contain
        any substring of the original email. Determinism was the pre-fix bug:
        it made the scrubbed row still linkable back to the account, and (per
        the new policy) it also matters that colliding values are essentially
        impossible even across many deletions.
        """
        user_id = _extract_user_id(member_tokens)
        await _delete_account(client, member_tokens)

        user = await _fetch_user(user_id)
        assert user is not None
        assert user.email != f"deleted-{user_id}@deleted.compasschw.local", (
            "email must NOT be the old deterministic-from-user-id pattern"
        )
        assert str(user_id) not in user.email, (
            "email must not encode the user id — must be a fresh random uuid4"
        )
        assert "@example.com" not in user.email, (
            "Original email domain must not appear in the scrubbed value"
        )
        assert user.email.endswith("@deleted.compasschw.local")

    async def test_user_phone_and_phone_verified_at_are_nulled(
        self, client: AsyncClient, member_tokens: dict
    ):
        user_id = _extract_user_id(member_tokens)
        await _delete_account(client, member_tokens)

        user = await _fetch_user(user_id)
        assert user is not None
        assert user.phone is None
        assert user.phone_verified_at is None

    async def test_user_password_hash_is_cleared(
        self, client: AsyncClient, member_tokens: dict
    ):
        user_id = _extract_user_id(member_tokens)
        await _delete_account(client, member_tokens)

        user = await _fetch_user(user_id)
        assert user is not None
        assert user.password_hash == "", (
            f"password_hash must be empty string, got: {user.password_hash!r}"
        )

    async def test_user_profile_picture_url_is_nulled(
        self, client: AsyncClient, member_tokens: dict
    ):
        user_id = _extract_user_id(member_tokens)
        await _delete_account(client, member_tokens)

        user = await _fetch_user(user_id)
        assert user is not None
        assert user.profile_picture_url is None


# ---------------------------------------------------------------------------
# Original email freed for immediate re-registration
# ---------------------------------------------------------------------------


class TestDeleteAccountEmailFreedForReRegistration:
    """The original email must be immediately re-registerable — this is the
    direct product consequence of the email sentinel being randomised
    instead of left/derived from the original address.
    """

    async def test_original_email_immediately_reregisterable(
        self, client: AsyncClient, member_tokens: dict
    ):
        await _delete_account(client, member_tokens)

        payload = complete_member_signup_payload(email=_MEMBER_EMAIL, name="Re Registered")
        res = await client.post("/api/v1/auth/register", json=payload)
        assert res.status_code == 201, (
            f"Original email must be re-registerable immediately after hard "
            f"delete, got {res.status_code}: {res.text}"
        )


# ---------------------------------------------------------------------------
# MemberProfile — hard deleted (behavior change from the old soft-delete test)
# ---------------------------------------------------------------------------


class TestDeleteAccountMemberProfileHardDeleted:
    """MemberProfile is now HARD-DELETED, not scrubbed-in-place.

    Prior contract (soft-delete era): the row was retained with PHI fields
    nulled out. New contract (hard-delete, Epic E4): the row is gone
    entirely — member-owned PHI has no retention requirement once the
    parent users row is already tombstoned, so there is no reason to keep
    an empty profile shell around.
    """

    async def test_member_profile_row_is_gone(
        self, client: AsyncClient, member_tokens: dict
    ):
        user_id = _extract_user_id(member_tokens)
        await _delete_account(client, member_tokens)

        profile = await _fetch_member_profile(user_id)
        assert profile is None, (
            "MemberProfile row must be HARD-DELETED after account deletion "
            "(behavior change from the old soft-delete/scrub contract)"
        )


# ---------------------------------------------------------------------------
# Token revocation — HARD DELETED (behavior change from the old test)
# ---------------------------------------------------------------------------


class TestDeleteAccountTokensHardDeleted:
    """RefreshTokens are now HARD-DELETED, not merely revoked.

    Prior contract: rows were retained with revoked=True so /auth/refresh
    could return a clean 401 for a "found but revoked" token. New contract:
    since the parent users row carries no PII anymore, there is no
    confidentiality reason to keep old token rows around at all — and the
    founder's hard-delete decision applies to every member-owned row, not
    just PHI-labeled ones. /auth/refresh must still return 401 for a
    pre-deletion token, just via a "not found" lookup instead of a
    "found but revoked" one.
    """

    async def test_all_refresh_tokens_are_hard_deleted(
        self, client: AsyncClient, member_tokens: dict
    ):
        user_id = _extract_user_id(member_tokens)

        # Issue a second refresh so the user has more than one token in flight.
        await client.post(
            "/api/v1/auth/refresh",
            json={"refresh_token": member_tokens["refresh_token"]},
        )

        await _delete_account(client, member_tokens)

        tokens = await _fetch_refresh_tokens(user_id)
        assert tokens == [], (
            f"RefreshToken rows must be HARD-DELETED after account deletion, "
            f"found {len(tokens)} remaining"
        )


# ---------------------------------------------------------------------------
# Post-deletion credential verification
# ---------------------------------------------------------------------------


class TestDeleteAccountPostDeletionCredentials:
    """Verify that deleted account credentials cannot be used after deletion.

    These are the attacker-path tests: if the row-scrub works but the auth
    endpoints still accept the old credentials, the access-control boundary
    has failed.
    """

    async def test_login_with_original_credentials_fails_after_delete(
        self, client: AsyncClient, member_tokens: dict
    ):
        """Login with the pre-deletion email+password must return 401.

        Multiple independent guards: password_hash == '' (bcrypt never
        matches), is_active=False, AND the email itself no longer resolves
        to any row (it was overwritten) — any one alone is sufficient.
        """
        await _delete_account(client, member_tokens)

        login_res = await _login(client, _MEMBER_EMAIL, _MEMBER_PASSWORD)
        assert login_res.status_code == 401, (
            f"Login after deletion must return 401, got {login_res.status_code}: "
            f"{login_res.text}"
        )

    async def test_refresh_with_pre_deletion_token_fails_cleanly_after_delete(
        self, client: AsyncClient, member_tokens: dict
    ):
        """Using the pre-deletion refresh token after account deletion must
        return 401 — via a clean 'not found' lookup (the row is hard-deleted,
        not merely revoked), never a crash.
        """
        original_refresh_token = member_tokens["refresh_token"]
        await _delete_account(client, member_tokens)

        refresh_res = await client.post(
            "/api/v1/auth/refresh",
            json={"refresh_token": original_refresh_token},
        )
        assert refresh_res.status_code == 401, (
            f"Refresh with a hard-deleted token must return 401 cleanly, "
            f"got {refresh_res.status_code}: {refresh_res.text}"
        )

    async def test_access_profile_with_original_token_fails_after_delete(
        self, client: AsyncClient, member_tokens: dict
    ):
        """The original access token must not grant access to /member/profile."""
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

    The first DELETE deactivates + hard-deletes PHI and hard-deletes the
    bearer token's session. The second DELETE arrives with the same
    (now-nonexistent) access token. The system must not crash — it must
    return a clean auth error, because is_active=False blocks
    get_current_user before the handler body ever runs.
    """

    async def test_second_delete_does_not_crash(
        self, client: AsyncClient, member_tokens: dict
    ):
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
            result = await db.execute(select(User).where(User.id == user_id))
            rows = list(result.scalars().all())

        assert len(rows) == 1, (
            f"User row must exist exactly once after double delete, found {len(rows)}"
        )
        assert rows[0].is_active is False

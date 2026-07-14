"""Tests for member account deactivation (E3) and the transactionality
guarantee of the hard-delete flow (both live in account_deletion.py).

Deactivation (POST /api/v1/member/account/deactivate) is intentionally
distinct from hard delete (DELETE /api/v1/auth/users/me): it is reversible
and data-preserving — is_active flips to False and RefreshTokens are
revoked (NOT deleted), but every PHI/PII row is left completely intact.
There is no reactivation endpoint yet (owner: JT, TBD) — this module only
proves the one-directional deactivation behavior.

Transactionality: the hard-delete service must never partially commit. A
mid-operation failure (simulated here by monkeypatching one deletion step to
raise) must leave the account FULLY INTACT — proven by a fresh DB query
after the failing request, not just "the response looked like an error".
"""

import uuid
from unittest.mock import patch

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.models.auth import RefreshToken
from app.models.followup import SessionFollowup
from app.models.user import MemberProfile, User
from app.services.s3_phi_cleanup import PhiCleanupResult
from tests.conftest import auth_header
from tests.conftest import test_session as _test_session_factory

_DELETE_URL = "/api/v1/auth/users/me"
_DEACTIVATE_URL = "/api/v1/member/account/deactivate"


@pytest.fixture(autouse=True)
def _stub_s3_phi_cleanup():
    with patch(
        "app.services.s3_phi_cleanup._cleanup_sync",
        return_value=PhiCleanupResult(),
    ):
        yield


def _extract_user_id(tokens: dict) -> uuid.UUID:
    import base64
    import json

    payload_b64 = tokens["access_token"].split(".")[1]
    payload_b64 += "=" * (-len(payload_b64) % 4)
    payload = json.loads(base64.urlsafe_b64decode(payload_b64))
    return uuid.UUID(payload["sub"])


async def _fetch_user(user_id: uuid.UUID) -> User | None:
    async with _test_session_factory() as db:
        return await db.get(User, user_id)


async def _fetch_member_profile(user_id: uuid.UUID) -> MemberProfile | None:
    async with _test_session_factory() as db:
        result = await db.execute(
            select(MemberProfile).where(MemberProfile.user_id == user_id)
        )
        return result.scalar_one_or_none()


async def _fetch_refresh_tokens(user_id: uuid.UUID) -> list[RefreshToken]:
    async with _test_session_factory() as db:
        result = await db.execute(
            select(RefreshToken).where(RefreshToken.user_id == user_id)
        )
        return list(result.scalars().all())


# ---------------------------------------------------------------------------
# Deactivation — negative auth
# ---------------------------------------------------------------------------


class TestDeactivateAccountAuthGuards:
    async def test_deactivate_without_auth_is_rejected(self, client: AsyncClient):
        res = await client.post(_DEACTIVATE_URL)
        assert res.status_code in (401, 403)

    async def test_deactivate_as_chw_role_is_rejected(
        self, client: AsyncClient, chw_tokens: dict
    ):
        """Deactivation is member-only (require_role('member')) — a CHW JWT
        must not satisfy it."""
        res = await client.post(_DEACTIVATE_URL, headers=auth_header(chw_tokens))
        assert res.status_code == 403


# ---------------------------------------------------------------------------
# Deactivation — behavior
# ---------------------------------------------------------------------------


class TestDeactivateAccountBehavior:
    async def test_deactivate_returns_204(self, client: AsyncClient, member_tokens: dict):
        res = await client.post(_DEACTIVATE_URL, headers=auth_header(member_tokens))
        assert res.status_code == 204, res.text

    async def test_deactivate_sets_is_active_false(
        self, client: AsyncClient, member_tokens: dict
    ):
        user_id = _extract_user_id(member_tokens)
        await client.post(_DEACTIVATE_URL, headers=auth_header(member_tokens))

        user = await _fetch_user(user_id)
        assert user is not None
        assert user.is_active is False

    async def test_deactivate_revokes_but_does_not_delete_refresh_tokens(
        self, client: AsyncClient, member_tokens: dict
    ):
        """Distinct from hard-delete: tokens must be REVOKED (rows retained),
        never deleted — deactivation is reversible."""
        user_id = _extract_user_id(member_tokens)

        await client.post(
            "/api/v1/auth/refresh",
            json={"refresh_token": member_tokens["refresh_token"]},
        )

        await client.post(_DEACTIVATE_URL, headers=auth_header(member_tokens))

        tokens = await _fetch_refresh_tokens(user_id)
        assert len(tokens) > 0, (
            "RefreshToken rows must be RETAINED (revoked, not deleted) after deactivation"
        )
        assert all(t.revoked for t in tokens), "every RefreshToken must be revoked"

    async def test_deactivate_preserves_member_profile_and_phi_fully_intact(
        self, client: AsyncClient, member_tokens: dict
    ):
        """The whole point of deactivation vs. hard-delete: nothing is lost."""
        user_id = _extract_user_id(member_tokens)

        pre_profile = await _fetch_member_profile(user_id)
        assert pre_profile is not None
        pre_zip = pre_profile.zip_code
        pre_medi_cal_id = pre_profile.medi_cal_id

        pre_user = await _fetch_user(user_id)
        assert pre_user is not None
        pre_name = pre_user.name
        pre_email = pre_user.email
        pre_phone = pre_user.phone

        await client.post(_DEACTIVATE_URL, headers=auth_header(member_tokens))

        post_profile = await _fetch_member_profile(user_id)
        assert post_profile is not None, "MemberProfile must still exist after deactivation"
        assert post_profile.zip_code == pre_zip
        assert post_profile.medi_cal_id == pre_medi_cal_id

        post_user = await _fetch_user(user_id)
        assert post_user is not None
        assert post_user.name == pre_name, "name must be unchanged by deactivation"
        assert post_user.email == pre_email, "email must be unchanged by deactivation"
        assert post_user.phone == pre_phone, "phone must be unchanged by deactivation"
        assert post_user.role == "member", "role must NOT be flipped to 'deleted'"
        assert post_user.deleted_at is None, "deleted_at must remain NULL"


# ---------------------------------------------------------------------------
# Deactivation — login is blocked with a clean error
# ---------------------------------------------------------------------------


class TestDeactivatedUserLoginBlocked:
    async def test_login_after_deactivation_returns_clean_error(
        self, client: AsyncClient, member_tokens: dict
    ):
        """authenticate_user() in app.services.auth_service already gates on
        `if not user.is_active: return None` (~line 273) which the login
        route turns into a 401. This test confirms that gate actually fires
        for a deactivated (not hard-deleted) account and returns a clean
        4xx, never a 500."""
        login_email = "testmember@example.com"
        login_password = "Testpass123!"

        await client.post(_DEACTIVATE_URL, headers=auth_header(member_tokens))

        res = await client.post(
            "/api/v1/auth/login",
            json={"email": login_email, "password": login_password},
        )
        assert res.status_code == 401, (
            f"Login for a deactivated user must return a clean 401, "
            f"got {res.status_code}: {res.text}"
        )
        assert res.status_code != 500


# ---------------------------------------------------------------------------
# Transactionality — mid-operation failure must roll back fully
# ---------------------------------------------------------------------------


class TestHardDeleteTransactionality:
    """A raised exception anywhere inside execute_account_deletion must leave
    the account fully intact — no row-scrub, no partial deletes, nothing
    committed. This is the single most important invariant of the hard-delete
    flow: a half-completed deletion would be a worse HIPAA outcome than no
    deletion at all (PHI partially gone, partially exposed with no
    provenance).
    """

    async def test_mid_operation_failure_leaves_account_fully_intact(
        self, client: AsyncClient, member_tokens: dict
    ):
        user_id = _extract_user_id(member_tokens)

        pre_user = await _fetch_user(user_id)
        assert pre_user is not None
        pre_email = pre_user.email
        pre_name = pre_user.name
        pre_role = pre_user.role

        pre_profile = await _fetch_member_profile(user_id)
        assert pre_profile is not None

        # Seed one PHI row (SessionFollowup, member-self-set roadmap goal —
        # no session/chw required) so we can assert it survives untouched.
        async with _test_session_factory() as db:
            followup = SessionFollowup(
                id=uuid.uuid4(),
                member_id=user_id,
                kind="member_goal",
                description="Transactionality test goal",
                owner="member",
                show_on_roadmap=True,
            )
            db.add(followup)
            await db.commit()
            followup_id = followup.id

        # Monkeypatch a deletion step deep in the middle of the operation to
        # raise, simulating a mid-transaction failure.
        with patch(
            "app.services.account_deletion._delete_member_journeys",
            side_effect=RuntimeError("simulated mid-operation failure"),
        ):
            res = await client.request(
                "DELETE",
                _DELETE_URL,
                json={},
                headers=auth_header(member_tokens),
            )

        # The endpoint must surface a clean error, never let the ASGI app
        # crash uncaught (rule 3, TESTING.md) — FastAPI's default exception
        # handling for an unhandled exception in a route still yields a 500
        # response (not a hung connection or a stack trace leak to the
        # client), which is what we assert here.
        assert res.status_code >= 400, (
            f"A mid-operation failure must not report success, got {res.status_code}"
        )

        # ── Assert via a FRESH DB query that nothing was partially committed ──
        post_user = await _fetch_user(user_id)
        assert post_user is not None
        assert post_user.email == pre_email, "email must be unchanged — rollback must have occurred"
        assert post_user.name == pre_name, "name must be unchanged — rollback must have occurred"
        assert post_user.role == pre_role, "role must be unchanged — rollback must have occurred"
        assert post_user.deleted_at is None, "deleted_at must remain NULL after a rolled-back attempt"
        assert post_user.is_active is True, "is_active must remain True after a rolled-back attempt"

        post_profile = await _fetch_member_profile(user_id)
        assert post_profile is not None, (
            "MemberProfile must still exist — a partial commit would have deleted it "
            "before the simulated failure point"
        )

        async with _test_session_factory() as db:
            surviving_followup = await db.get(SessionFollowup, followup_id)
        assert surviving_followup is not None, (
            "SessionFollowup (PHI row deleted earlier in the operation than the "
            "simulated failure point) must still exist — proves the whole "
            "operation rolled back, not just the failing step"
        )

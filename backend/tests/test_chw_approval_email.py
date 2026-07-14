"""Tests for the Epic D3 "you're approved" email/push on a can_work
false -> true transition.

Two write paths can trigger the transition:
  - PATCH /credentials/{credential_id}/review     (credentials.py)
  - PATCH /admin/chws/{chw_id}/background-check   (admin.py)

Both funnel through app.services.chw_compliance.notify_chw_if_newly_approved,
which re-derives the "after" state itself rather than trusting a caller-
supplied value, so testing through either endpoint exercises the same
transition logic. Coverage:
  1. Approving the LAST outstanding requirement (with everything else
     already satisfied) fires exactly one email.
  2. Approving a requirement when other requirements are still outstanding
     does NOT fire.
  3. Re-approving/re-setting when the CHW was already fully compliant does
     NOT fire again (no duplicate emails on idempotent re-review).
  4. A rejection (approved=False) never fires, even from a previously-
     compliant state transitioning to non-compliant.
"""

from __future__ import annotations

import os
import uuid
from unittest.mock import AsyncMock, patch
from uuid import UUID

import pyotp
from httpx import AsyncClient
from sqlalchemy import select

from app.models.credential import Credential
from app.models.user import CHWProfile, User
from tests.conftest import auth_header
from tests.conftest import test_session as _test_session_factory

DOCUMENT_TYPES = (
    "hipaa_training",
    "professional_service_agreement",
    "liability_insurance",
    "chw_certification",
)

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


def _user_id(tokens: dict) -> str:
    import base64
    import json

    payload_b64 = tokens["access_token"].split(".")[1]
    padded = payload_b64 + "=" * (4 - len(payload_b64) % 4)
    return str(UUID(json.loads(base64.urlsafe_b64decode(padded).decode())["sub"]))


async def _seed_profile_shape_compliant(chw_id: str) -> None:
    """Seed the profile-shape + bio requirements (NOT credentials or
    background check) so only those two axes remain to make can_work True."""
    async with _test_session_factory() as db:
        result = await db.execute(select(CHWProfile).where(CHWProfile.user_id == UUID(chw_id)))
        profile = result.scalar_one()
        profile.zip_code = "90001"
        profile.bio = "Community health worker with 5 years of experience."
        await db.commit()

    async with _test_session_factory() as db:
        user = await db.get(User, UUID(chw_id))
        user.phone = "+13105550100"
        await db.commit()


async def _verify_all_credentials_except(chw_id: str, exclude: str | None = None) -> dict[str, UUID]:
    """Insert verified Credential rows for all DOCUMENT_TYPES except
    ``exclude`` (left absent). Returns {type: credential_id}."""
    ids: dict[str, UUID] = {}
    async with _test_session_factory() as db:
        for cred_type in DOCUMENT_TYPES:
            if cred_type == exclude:
                continue
            row = Credential(
                chw_id=UUID(chw_id),
                type=cred_type,
                label=cred_type,
                s3_key=f"credentials/{chw_id}/{cred_type}.pdf",
                file_name=f"{cred_type}.pdf",
                status="verified",
            )
            db.add(row)
            await db.flush()
            ids[cred_type] = row.id
        await db.commit()
    return ids


async def _insert_pending_credential(chw_id: str, cred_type: str) -> UUID:
    async with _test_session_factory() as db:
        row = Credential(
            chw_id=UUID(chw_id),
            type=cred_type,
            label=cred_type,
            s3_key=f"credentials/{chw_id}/{cred_type}.pdf",
            file_name=f"{cred_type}.pdf",
            status="pending",
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return row.id


async def _set_background_check(chw_id: str, status: str) -> None:
    async with _test_session_factory() as db:
        result = await db.execute(select(CHWProfile).where(CHWProfile.user_id == UUID(chw_id)))
        profile = result.scalar_one()
        profile.background_check_status = status
        await db.commit()


# ---------------------------------------------------------------------------
# PATCH /credentials/{id}/review — the LAST credential
# ---------------------------------------------------------------------------


class TestApprovalEmailViaCredentialReview:
    async def test_approving_last_credential_with_background_clear_fires_once(
        self, client: AsyncClient, chw_tokens: dict
    ):
        chw_id = _user_id(chw_tokens)
        await _seed_profile_shape_compliant(chw_id)
        await _set_background_check(chw_id, "clear")
        # 3 of 4 verified; the 4th ("chw_certification") is the one we'll
        # approve via the endpoint under test — this is the transition.
        await _verify_all_credentials_except(chw_id, exclude="chw_certification")
        last_cred_id = await _insert_pending_credential(chw_id, "chw_certification")

        admin_tokens = await _setup_admin(client)

        with patch(
            "app.services.email.send_chw_approved_email", new_callable=AsyncMock
        ) as mock_email:
            res = await client.patch(
                f"/api/v1/credentials/{last_cred_id}/review",
                json={"approved": True},
                headers=admin_tokens,
            )
        assert res.status_code == 200, res.text
        assert mock_email.await_count == 1

    async def test_approving_middle_credential_does_not_fire(
        self, client: AsyncClient, chw_tokens: dict
    ):
        chw_id = _user_id(chw_tokens)
        await _seed_profile_shape_compliant(chw_id)
        await _set_background_check(chw_id, "clear")
        # Only 2 of 4 verified; background is clear but 2 credentials still
        # missing after this approval — can_work stays False throughout.
        async with _test_session_factory() as db:
            for cred_type in ("hipaa_training", "professional_service_agreement"):
                db.add(
                    Credential(
                        chw_id=UUID(chw_id),
                        type=cred_type,
                        label=cred_type,
                        status="verified",
                    )
                )
            await db.commit()
        middle_cred_id = await _insert_pending_credential(chw_id, "liability_insurance")
        # chw_certification is left entirely absent -> still missing after.

        admin_tokens = await _setup_admin(client)

        with patch(
            "app.services.email.send_chw_approved_email", new_callable=AsyncMock
        ) as mock_email:
            res = await client.patch(
                f"/api/v1/credentials/{middle_cred_id}/review",
                json={"approved": True},
                headers=admin_tokens,
            )
        assert res.status_code == 200, res.text
        assert mock_email.await_count == 0

    async def test_reapproving_already_compliant_chw_does_not_refire(
        self, client: AsyncClient, chw_tokens: dict
    ):
        chw_id = _user_id(chw_tokens)
        await _seed_profile_shape_compliant(chw_id)
        await _set_background_check(chw_id, "clear")
        await _verify_all_credentials_except(chw_id, exclude=None)

        # Now the CHW is already fully compliant. Re-review one of the
        # already-verified credentials (idempotent re-approve).
        async with _test_session_factory() as db:
            result = await db.execute(
                select(Credential).where(
                    Credential.chw_id == UUID(chw_id),
                    Credential.type == "hipaa_training",
                )
            )
            existing_cred_id = result.scalar_one().id

        admin_tokens = await _setup_admin(client)

        with patch(
            "app.services.email.send_chw_approved_email", new_callable=AsyncMock
        ) as mock_email:
            res = await client.patch(
                f"/api/v1/credentials/{existing_cred_id}/review",
                json={"approved": True},
                headers=admin_tokens,
            )
        assert res.status_code == 200, res.text
        assert mock_email.await_count == 0

    async def test_rejection_never_fires(self, client: AsyncClient, chw_tokens: dict):
        chw_id = _user_id(chw_tokens)
        await _seed_profile_shape_compliant(chw_id)
        await _set_background_check(chw_id, "clear")
        await _verify_all_credentials_except(chw_id, exclude="chw_certification")
        last_cred_id = await _insert_pending_credential(chw_id, "chw_certification")

        admin_tokens = await _setup_admin(client)

        with patch(
            "app.services.email.send_chw_approved_email", new_callable=AsyncMock
        ) as mock_email:
            res = await client.patch(
                f"/api/v1/credentials/{last_cred_id}/review",
                json={"approved": False},
                headers=admin_tokens,
            )
        assert res.status_code == 200, res.text
        assert mock_email.await_count == 0


async def _setup_admin(client: AsyncClient) -> dict[str, str]:
    """Admin credential review uses require_role("admin") (a normal user
    JWT), not the admin-key+2FA chain used by /admin/*. Register + promote a
    user to admin directly via ORM (mirrors test_credentials.py convention).
    """
    async with _test_session_factory() as db:
        admin_id = uuid.uuid4()
        from app.utils.security import hash_password

        admin_user = User(
            id=admin_id,
            email=f"admin-{admin_id}@example.com",
            password_hash=hash_password("Testpass123!"),
            role="admin",
            name="Test Admin",
        )
        db.add(admin_user)
        await db.commit()

    res = await client.post(
        "/api/v1/auth/login",
        json={"email": f"admin-{admin_id}@example.com", "password": "Testpass123!"},
    )
    assert res.status_code == 200, res.text
    return auth_header(res.json())


# ---------------------------------------------------------------------------
# PATCH /admin/chws/{id}/background-check — the last remaining requirement
# ---------------------------------------------------------------------------


class TestApprovalEmailViaBackgroundCheck:
    async def test_clearing_background_check_last_fires_once(
        self, client: AsyncClient, chw_tokens: dict
    ):
        chw_id = _user_id(chw_tokens)
        await _seed_profile_shape_compliant(chw_id)
        await _verify_all_credentials_except(chw_id, exclude=None)
        # background_check_status defaults to "pending" — clearing it now is
        # the final transition.

        two_fa = await _setup_and_verify_2fa(client)

        with patch(
            "app.services.email.send_chw_approved_email", new_callable=AsyncMock
        ) as mock_email:
            res = await client.patch(
                f"/api/v1/admin/chws/{chw_id}/background-check",
                headers=_full_admin_headers(two_fa),
                json={"status": "clear"},
            )
        assert res.status_code == 200, res.text
        assert mock_email.await_count == 1

    async def test_clearing_background_check_with_missing_credentials_does_not_fire(
        self, client: AsyncClient, chw_tokens: dict
    ):
        chw_id = _user_id(chw_tokens)
        await _seed_profile_shape_compliant(chw_id)
        # Credentials intentionally left unverified — can_work stays False
        # even after background_check_status flips to "clear".

        two_fa = await _setup_and_verify_2fa(client)

        with patch(
            "app.services.email.send_chw_approved_email", new_callable=AsyncMock
        ) as mock_email:
            res = await client.patch(
                f"/api/v1/admin/chws/{chw_id}/background-check",
                headers=_full_admin_headers(two_fa),
                json={"status": "clear"},
            )
        assert res.status_code == 200, res.text
        assert mock_email.await_count == 0

    async def test_resetting_clear_on_already_compliant_chw_does_not_refire(
        self, client: AsyncClient, chw_tokens: dict
    ):
        chw_id = _user_id(chw_tokens)
        await _seed_profile_shape_compliant(chw_id)
        await _verify_all_credentials_except(chw_id, exclude=None)
        await _set_background_check(chw_id, "clear")
        # CHW is already fully compliant. Setting "clear" again (no-op
        # write) must not re-fire.

        two_fa = await _setup_and_verify_2fa(client)

        with patch(
            "app.services.email.send_chw_approved_email", new_callable=AsyncMock
        ) as mock_email:
            res = await client.patch(
                f"/api/v1/admin/chws/{chw_id}/background-check",
                headers=_full_admin_headers(two_fa),
                json={"status": "clear"},
            )
        assert res.status_code == 200, res.text
        assert mock_email.await_count == 0

    async def test_setting_non_clear_status_never_fires(
        self, client: AsyncClient, chw_tokens: dict
    ):
        chw_id = _user_id(chw_tokens)
        await _seed_profile_shape_compliant(chw_id)
        await _verify_all_credentials_except(chw_id, exclude=None)

        two_fa = await _setup_and_verify_2fa(client)

        with patch(
            "app.services.email.send_chw_approved_email", new_callable=AsyncMock
        ) as mock_email:
            res = await client.patch(
                f"/api/v1/admin/chws/{chw_id}/background-check",
                headers=_full_admin_headers(two_fa),
                json={"status": "consider"},
            )
        assert res.status_code == 200, res.text
        assert mock_email.await_count == 0

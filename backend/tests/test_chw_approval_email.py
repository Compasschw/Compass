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


# ─── Unit tests: template render + provider send ─────────────────────────────
#
# The integration tests above intentionally mock send_chw_approved_email at
# the transition-detection boundary, so the template and provider plumbing
# below are exercised directly here.


class TestChwApprovedEmailRender:
    def test_render_has_name_subject_and_support_contact(self):
        from app.services.email import render_chw_approved_email

        subject, html, text = render_chw_approved_email("Jamie")
        assert subject.strip()
        assert "approved" in subject.lower()
        assert "Jamie" in html
        assert "Jamie" in text
        assert "support@joincompasschw.com" in html
        assert "support@joincompasschw.com" in text

    def test_render_contains_no_phi(self):
        """First name only — same minimum-necessary standard as every other
        templated email (no health terms, no member references)."""
        from app.services.email import render_chw_approved_email

        _, html, text = render_chw_approved_email("Jamie")
        lowered = (html + text).lower()
        for phi_term in ("diagnosis", "medication", "health condition", "medi-cal id"):
            assert phi_term not in lowered


class TestSendChwApprovedEmail:
    async def test_success_sends_tagged_message_via_provider(self):
        from app.services.email import EmailResult, send_chw_approved_email

        provider = AsyncMock()
        provider.send.return_value = EmailResult(
            success=True, provider_message_id="msg-123"
        )
        with patch("app.services.email.get_email_provider", return_value=provider):
            result = await send_chw_approved_email(
                to="chw@example.com", chw_first_name="Jamie"
            )

        assert result.success is True
        (message,) = provider.send.call_args.args
        assert message.to == "chw@example.com"
        assert "Jamie" in message.text
        assert message.tags == {"category": "chw_approved"}

    async def test_provider_error_returns_failure_never_raises(self):
        from app.services.email import send_chw_approved_email

        with patch(
            "app.services.email.get_email_provider",
            side_effect=RuntimeError("SES outage simulated"),
        ):
            result = await send_chw_approved_email(
                to="chw@example.com", chw_first_name="Jamie"
            )

        assert result.success is False
        assert "SES outage simulated" in (result.error or "")


# ─── Unit tests: notify_chw_if_newly_approved branch coverage ────────────────
#
# db is only ever handed to chw_can_work / notify_user, both patched here, so
# the transition logic can be exercised without a database round trip.


def _detached_chw(email: str | None = "jamie@example.com", name: str | None = "Jamie Rivera") -> User:
    return User(id=uuid.uuid4(), email=email, name=name, role="chw")


class TestNotifyChwIfNewlyApprovedBranches:
    async def test_noop_when_already_compliant_before(self):
        """No transition (was already compliant) — must return before even
        re-evaluating can_work, and fire nothing."""
        from app.services.chw_compliance import notify_chw_if_newly_approved

        with (
            patch(
                "app.services.chw_compliance.chw_can_work", new_callable=AsyncMock
            ) as mock_can_work,
            patch(
                "app.services.email.send_chw_approved_email", new_callable=AsyncMock
            ) as mock_email,
            patch(
                "app.services.notifications.notify_user", new_callable=AsyncMock
            ) as mock_push,
        ):
            await notify_chw_if_newly_approved(
                None, _detached_chw(), was_compliant_before=True
            )

        assert mock_can_work.await_count == 0
        assert mock_email.await_count == 0
        assert mock_push.await_count == 0

    async def test_noop_when_still_not_compliant_after(self):
        from app.services.chw_compliance import notify_chw_if_newly_approved

        with (
            patch(
                "app.services.chw_compliance.chw_can_work",
                new_callable=AsyncMock,
                return_value=(False, ["background_check"]),
            ),
            patch(
                "app.services.email.send_chw_approved_email", new_callable=AsyncMock
            ) as mock_email,
            patch(
                "app.services.notifications.notify_user", new_callable=AsyncMock
            ) as mock_push,
        ):
            await notify_chw_if_newly_approved(
                None, _detached_chw(), was_compliant_before=False
            )

        assert mock_email.await_count == 0
        assert mock_push.await_count == 0

    async def test_transition_sends_email_with_first_name_and_push(self):
        from app.services.chw_compliance import notify_chw_if_newly_approved

        chw = _detached_chw(name="Jamie Rivera")
        with (
            patch(
                "app.services.chw_compliance.chw_can_work",
                new_callable=AsyncMock,
                return_value=(True, []),
            ),
            patch(
                "app.services.email.send_chw_approved_email", new_callable=AsyncMock
            ) as mock_email,
            patch(
                "app.services.notifications.notify_user", new_callable=AsyncMock
            ) as mock_push,
        ):
            await notify_chw_if_newly_approved(None, chw, was_compliant_before=False)

        assert mock_email.await_count == 1
        assert mock_email.await_args.kwargs["to"] == chw.email
        assert mock_email.await_args.kwargs["chw_first_name"] == "Jamie"
        assert mock_push.await_count == 1
        payload = mock_push.await_args.args[2]
        assert payload.category == "chw.approved"

    async def test_missing_name_falls_back_to_there(self):
        from app.services.chw_compliance import notify_chw_if_newly_approved

        with (
            patch(
                "app.services.chw_compliance.chw_can_work",
                new_callable=AsyncMock,
                return_value=(True, []),
            ),
            patch(
                "app.services.email.send_chw_approved_email", new_callable=AsyncMock
            ) as mock_email,
            patch("app.services.notifications.notify_user", new_callable=AsyncMock),
        ):
            await notify_chw_if_newly_approved(
                None, _detached_chw(name=None), was_compliant_before=False
            )

        assert mock_email.await_args.kwargs["chw_first_name"] == "there"

    async def test_no_email_address_skips_email_still_pushes(self):
        from app.services.chw_compliance import notify_chw_if_newly_approved

        with (
            patch(
                "app.services.chw_compliance.chw_can_work",
                new_callable=AsyncMock,
                return_value=(True, []),
            ),
            patch(
                "app.services.email.send_chw_approved_email", new_callable=AsyncMock
            ) as mock_email,
            patch(
                "app.services.notifications.notify_user", new_callable=AsyncMock
            ) as mock_push,
        ):
            await notify_chw_if_newly_approved(
                None, _detached_chw(email=None), was_compliant_before=False
            )

        assert mock_email.await_count == 0
        assert mock_push.await_count == 1

    async def test_email_failure_is_swallowed_and_push_still_fires(self):
        from app.services.chw_compliance import notify_chw_if_newly_approved

        with (
            patch(
                "app.services.chw_compliance.chw_can_work",
                new_callable=AsyncMock,
                return_value=(True, []),
            ),
            patch(
                "app.services.email.send_chw_approved_email",
                new_callable=AsyncMock,
                side_effect=RuntimeError("SES outage simulated"),
            ),
            patch(
                "app.services.notifications.notify_user", new_callable=AsyncMock
            ) as mock_push,
        ):
            await notify_chw_if_newly_approved(
                None, _detached_chw(), was_compliant_before=False
            )

        assert mock_push.await_count == 1

    async def test_push_failure_is_swallowed(self):
        from app.services.chw_compliance import notify_chw_if_newly_approved

        with (
            patch(
                "app.services.chw_compliance.chw_can_work",
                new_callable=AsyncMock,
                return_value=(True, []),
            ),
            patch(
                "app.services.email.send_chw_approved_email", new_callable=AsyncMock
            ) as mock_email,
            patch(
                "app.services.notifications.notify_user",
                new_callable=AsyncMock,
                side_effect=RuntimeError("push provider down"),
            ),
        ):
            await notify_chw_if_newly_approved(
                None, _detached_chw(), was_compliant_before=False
            )

        assert mock_email.await_count == 1


# ─── Unit test: review_credential orphaned-CHW guard ─────────────────────────


class TestReviewCredentialOrphanedChw:
    async def test_credential_pointing_at_missing_user_returns_404(self):
        """db.get(User, ...) coming back None (orphaned credential row) must
        surface a clean 404, never an AttributeError-driven 500."""
        import pytest
        from fastapi import HTTPException

        from app.routers.credentials import review_credential
        from app.schemas.credential import CredentialReviewRequest

        credential_id = uuid.uuid4()
        row = Credential(
            id=credential_id,
            chw_id=uuid.uuid4(),
            type="hipaa_training",
            status="pending_review",
        )

        class _StubSession:
            async def get(self, model, pk):
                if model is Credential:
                    return row
                return None

        admin = User(id=uuid.uuid4(), email="admin@example.com", role="admin")
        with pytest.raises(HTTPException) as exc_info:
            await review_credential(
                credential_id,
                CredentialReviewRequest(approved=True),
                current_user=admin,
                db=_StubSession(),
            )
        assert exc_info.value.status_code == 404
        assert "CHW not found" in exc_info.value.detail

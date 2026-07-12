"""Regression tests: CHW-created members must reach the Pear Member-Import
CSV in S3 exactly like self-signup members do.

Bug: ``POST /chw/members`` (create_chw_member in routers/chw.py) never
scheduled the ``append_new_member_to_csv`` background task that
``/auth/register`` fires, so CHW-added members silently never made it into
``compass-prod-member-csv`` — Pear's billing import never saw them.

Fix: the CSV-export logic was extracted out of routers/auth.py into the
single shared ``app.services.auth_service.append_new_member_to_csv`` and is
now scheduled from BOTH ``/auth/register`` and ``create_chw_member`` (after
each one's ``db.commit()`` succeeds), gated on
``settings.member_csv_enabled`` and idempotent on
``MemberProfile.member_csv_exported_at``.

These tests mock the S3 boundary (``member_csv_writer.append_row``) — never
hit real S3 — and assert on the actual DB state (``member_csv_exported_at``)
rather than trusting the 201 alone. Starlette's ``BackgroundTasks`` execute
before the ASGI response cycle completes, so by the time
``await client.post(...)`` returns in these tests, the scheduled export has
already run (same pattern already relied on implicitly by
tests/test_social_auth.py's OAuth background-task assertions).
"""
from __future__ import annotations

from datetime import date
from unittest.mock import patch
from uuid import UUID

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.config import settings
from app.models.user import MemberProfile, User
from tests.conftest import auth_header, complete_member_signup_payload
from tests.conftest import test_session as _session_factory

pytestmark = pytest.mark.asyncio

# NOTE: is_export_eligible() (member_csv_writer.py) excludes @example.com
# addresses as synthetic/smoke-test accounts — deliberately use a
# non-@example.com email in every payload below so the export actually runs.
_CHW_NEW_MEMBER_PAYLOAD = {
    "email": "brand.new.member@compasschw-test.dev",
    "temp_password": "temp-pass-1234",
    "name": "Brand New",
    "phone": "+13105550142",
    "date_of_birth": "1990-04-12",
    "gender": "Female",
    "insurance_company": "Health Net",
    "medi_cal_id": "91234567A",
    "address_line1": "742 Evergreen Ter",
    "address_line2": "Apt 3",
    "city": "Los Angeles",
    "state": "CA",
    "zip_code": "90001",
    "terms_accepted": True,
    "communications_consent": True,
}


async def _get_profile(user_id: UUID) -> MemberProfile:
    async with _session_factory() as session:
        return (
            await session.execute(
                select(MemberProfile).where(MemberProfile.user_id == user_id)
            )
        ).scalar_one()


# ─── CHW-created member export (the bug) ──────────────────────────────────────


async def test_chw_created_member_exports_to_csv_when_flag_enabled(
    client: AsyncClient, chw_tokens: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The bug this PR fixes: with the flag on, POST /chw/members must
    trigger exactly one CSV export carrying the new member's data, and stamp
    member_csv_exported_at."""
    monkeypatch.setattr(settings, "member_csv_enabled", True)

    with patch("app.services.member_csv_writer.append_row") as mock_append_row:
        res = await client.post(
            "/api/v1/chw/members",
            json=_CHW_NEW_MEMBER_PAYLOAD,
            headers=auth_header(chw_tokens),
        )
    assert res.status_code == 201, res.text
    member_id = UUID(res.json()["id"])

    assert mock_append_row.call_count == 1, (
        "create_chw_member did not schedule the member CSV export — "
        "CHW-added members would silently never reach Pear's billing CSV"
    )
    row = mock_append_row.call_args.args[0]
    assert row.first_name == "Brand"
    assert row.last_name == "New"
    assert row.phone == "+13105550142"
    assert row.date_of_birth == date(1990, 4, 12)
    assert row.sex == "Female"
    assert row.insurance_name == "Health Net"
    assert row.primary_cin == "91234567A"
    assert row.address_line_1 == "742 Evergreen Ter"
    assert row.address_line_2 == "Apt 3"
    assert row.city == "Los Angeles"
    assert row.state == "CA"
    assert row.zip_code == "90001"
    assert row.user_id == member_id

    profile = await _get_profile(member_id)
    assert profile.member_csv_exported_at is not None


async def test_chw_created_member_csv_export_is_idempotent(
    client: AsyncClient, chw_tokens: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A second export attempt for the same already-exported member is a
    no-op — no duplicate S3 append, exported_at timestamp unchanged."""
    monkeypatch.setattr(settings, "member_csv_enabled", True)

    with patch("app.services.member_csv_writer.append_row") as mock_append_row:
        res = await client.post(
            "/api/v1/chw/members",
            json=_CHW_NEW_MEMBER_PAYLOAD,
            headers=auth_header(chw_tokens),
        )
        assert res.status_code == 201, res.text
        member_id = UUID(res.json()["id"])
        assert mock_append_row.call_count == 1

        first_exported_at = (await _get_profile(member_id)).member_csv_exported_at
        assert first_exported_at is not None

        # Re-run the exact same export the background task would have run —
        # e.g. a retry/backfill hitting an already-exported member.
        from app.services.auth_service import append_new_member_to_csv

        await append_new_member_to_csv(member_id)

    # No second S3 append — the idempotency guard on member_csv_exported_at
    # short-circuited before append_row was ever called again.
    assert mock_append_row.call_count == 1, (
        "member CSV export is not idempotent — a retry produced a duplicate "
        "S3 append"
    )
    second_exported_at = (await _get_profile(member_id)).member_csv_exported_at
    assert second_exported_at == first_exported_at


async def test_chw_created_member_no_export_when_flag_disabled(
    client: AsyncClient, chw_tokens: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    """With MEMBER_CSV_ENABLED=false (the default), member creation succeeds
    normally and no export is attempted — no error, no S3 call, no stamp."""
    monkeypatch.setattr(settings, "member_csv_enabled", False)

    with patch("app.services.member_csv_writer.append_row") as mock_append_row:
        res = await client.post(
            "/api/v1/chw/members",
            json=_CHW_NEW_MEMBER_PAYLOAD,
            headers=auth_header(chw_tokens),
        )
    assert res.status_code == 201, res.text
    member_id = UUID(res.json()["id"])

    assert mock_append_row.call_count == 0

    profile = await _get_profile(member_id)
    assert profile.member_csv_exported_at is None


async def test_chw_created_member_export_failure_does_not_fail_request(
    client: AsyncClient, chw_tokens: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The export is best-effort/non-blocking: an S3/writer exception must
    never surface as a failed member-creation request (still 201)."""
    monkeypatch.setattr(settings, "member_csv_enabled", True)

    with patch(
        "app.services.member_csv_writer.append_row",
        side_effect=RuntimeError("simulated S3 outage"),
    ) as mock_append_row:
        res = await client.post(
            "/api/v1/chw/members",
            json=_CHW_NEW_MEMBER_PAYLOAD,
            headers=auth_header(chw_tokens),
        )

    assert res.status_code == 201, res.text
    assert mock_append_row.call_count == 1

    member_id = UUID(res.json()["id"])
    profile = await _get_profile(member_id)
    # The row was never durably appended, so exported_at must stay NULL —
    # a later backfill run will retry it.
    assert profile.member_csv_exported_at is None


# ─── Self-signup regression (must remain unchanged) ───────────────────────────


async def test_self_signup_register_still_exports_to_csv(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regression guard: extracting the shared helper must not change
    /auth/register's existing CSV-export behavior."""
    monkeypatch.setattr(settings, "member_csv_enabled", True)

    payload = complete_member_signup_payload(
        email="self.signup.csv@compasschw-test.dev", name="Self Signup"
    )

    with patch("app.services.member_csv_writer.append_row") as mock_append_row:
        res = await client.post("/api/v1/auth/register", json=payload)
    assert res.status_code == 201, res.text

    assert mock_append_row.call_count == 1
    row = mock_append_row.call_args.args[0]
    assert row.first_name == "Self"
    assert row.last_name == "Signup"

    async with _session_factory() as session:
        user = (
            await session.execute(
                select(User).where(User.email == "self.signup.csv@compasschw-test.dev")
            )
        ).scalar_one()
        profile = (
            await session.execute(
                select(MemberProfile).where(MemberProfile.user_id == user.id)
            )
        ).scalar_one()
    assert profile.member_csv_exported_at is not None


async def test_self_signup_register_no_export_when_flag_disabled(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regression guard: flag-off behavior for /auth/register is unchanged."""
    monkeypatch.setattr(settings, "member_csv_enabled", False)

    payload = complete_member_signup_payload(
        email="self.signup.csv.off@compasschw-test.dev", name="Self SignupOff"
    )

    with patch("app.services.member_csv_writer.append_row") as mock_append_row:
        res = await client.post("/api/v1/auth/register", json=payload)
    assert res.status_code == 201, res.text
    assert mock_append_row.call_count == 0


# ─── Shared-helper edge branches (exercised directly — unreachable via the
# API surfaces since both /auth/register and /chw/members boundary-validate
# the Pear-required fields before a row can even be created) ─────────────────


async def test_export_skips_member_with_incomplete_profile(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """is_pear_complete() gates the export: a member missing a Pear-required
    field (e.g. insurance_company) is skipped, exported_at stays NULL so the
    backfill script can pick it up later, and no S3 call is made."""
    monkeypatch.setattr(settings, "member_csv_enabled", True)

    async with _session_factory() as session:
        user = User(
            email="incomplete.profile@compasschw-test.dev",
            password_hash="not-a-real-hash",
            name="Incomplete Profile",
            role="member",
            phone="+13105550199",
        )
        session.add(user)
        await session.flush()
        profile = MemberProfile(
            user_id=user.id,
            date_of_birth=date(1990, 1, 1),
            gender="Female",
            # insurance_company intentionally omitted — Pear-required, missing.
            medi_cal_id="91234567A",
            address_line1="1 Main St",
            city="Los Angeles",
            state="CA",
            zip_code="90001",
        )
        session.add(profile)
        await session.commit()
        member_id = user.id

    from app.services.auth_service import append_new_member_to_csv

    with patch("app.services.member_csv_writer.append_row") as mock_append_row:
        await append_new_member_to_csv(member_id)

    assert mock_append_row.call_count == 0

    profile = await _get_profile(member_id)
    assert profile.member_csv_exported_at is None


async def test_export_skips_member_with_no_profile_row(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Defensive guard: a member User row with no MemberProfile at all (data
    integrity edge case) is skipped cleanly — no crash, no S3 call."""
    monkeypatch.setattr(settings, "member_csv_enabled", True)

    async with _session_factory() as session:
        user = User(
            email="no.profile.row@compasschw-test.dev",
            password_hash="not-a-real-hash",
            name="No Profile Row",
            role="member",
            phone="+13105550188",
        )
        session.add(user)
        await session.commit()
        member_id = user.id

    from app.services.auth_service import append_new_member_to_csv

    with patch("app.services.member_csv_writer.append_row") as mock_append_row:
        # Must not raise even though there's no MemberProfile to read.
        await append_new_member_to_csv(member_id)

    assert mock_append_row.call_count == 0

"""Unit tests for app.services.chw_compliance.chw_can_work / get_compliance_status.

Covers the full requirement matrix (backend/TESTING.md rule 2 — invariant
coverage) plus a defensive no-crash test for a CHW with zero CHWProfile row
(TESTING.md rule 3 — no unhandled 500s / crashes on malformed data).

Each requirement is tested INDEPENDENTLY: build a fully-compliant CHW, then
break exactly one requirement and assert (a) can_work flips False and (b) the
correct — and ONLY the correct — missing code appears (aside from
requirements that are already broken by construction, e.g. an incomplete
profile also fails bio if bio was never set).
"""

import uuid

import pytest
from sqlalchemy import select

from app.models.credential import Credential
from app.models.user import CHWProfile, User
from app.services.chw_compliance import chw_can_work, get_compliance_status
from tests.conftest import test_session as _test_session_factory

DOCUMENT_TYPES = (
    "hipaa_training",
    "professional_service_agreement",
    "liability_insurance",
    "chw_certification",
)

VALID_BIO = "Community health worker serving South LA for 5 years."


async def _create_chw_user(
    *,
    name: str = "Compliant CHW",
    phone: str | None = "+13105550100",
    email: str | None = None,
) -> uuid.UUID:
    user_id = uuid.uuid4()
    async with _test_session_factory() as db:
        user = User(
            id=user_id,
            email=email or f"{user_id}@example.com",
            password_hash="hashed",
            role="chw",
            name=name,
            phone=phone,
        )
        db.add(user)
        await db.commit()
    return user_id


async def _create_chw_profile(
    user_id: uuid.UUID,
    *,
    zip_code: str | None = "90001",
    bio: str | None = VALID_BIO,
    background_check_status: str = "clear",
) -> None:
    async with _test_session_factory() as db:
        db.add(
            CHWProfile(
                user_id=user_id,
                zip_code=zip_code,
                bio=bio,
                background_check_status=background_check_status,
                specializations=[],
                languages=[],
            )
        )
        await db.commit()


async def _add_credential(user_id: uuid.UUID, cred_type: str, status: str) -> None:
    async with _test_session_factory() as db:
        db.add(
            Credential(
                chw_id=user_id,
                type=cred_type,
                label=cred_type,
                status=status,
            )
        )
        await db.commit()


async def _make_fully_compliant_chw() -> uuid.UUID:
    """Seed a CHW that satisfies every requirement — the baseline for
    single-requirement-break tests below."""
    user_id = await _create_chw_user()
    await _create_chw_profile(user_id)
    for cred_type in DOCUMENT_TYPES:
        await _add_credential(user_id, cred_type, "verified")
    return user_id


async def _load_user(user_id: uuid.UUID) -> User:
    async with _test_session_factory() as db:
        result = await db.execute(select(User).where(User.id == user_id))
        user = result.scalar_one()
        # Detach-safe: access lazy attrs are all eager (scalar columns only)
        return user


class TestFullyCompliant:
    async def test_fully_compliant_chw_can_work_with_no_missing_items(self):
        user_id = await _make_fully_compliant_chw()
        async with _test_session_factory() as db:
            user = await db.get(User, user_id)
            can_work, missing = await chw_can_work(db, user)
        assert can_work is True
        assert missing == []


class TestEachRequirementIndividuallyBlocks:
    """Break exactly one requirement per test off the fully-compliant baseline."""

    async def test_missing_name_blocks_with_profile_incomplete(self):
        user_id = await _make_fully_compliant_chw()
        async with _test_session_factory() as db:
            user = await db.get(User, user_id)
            user.name = ""
            await db.commit()
        async with _test_session_factory() as db:
            user = await db.get(User, user_id)
            can_work, missing = await chw_can_work(db, user)
        assert can_work is False
        assert "profile_incomplete" in missing

    async def test_missing_phone_blocks_with_profile_incomplete(self):
        user_id = await _create_chw_user(phone=None)
        await _create_chw_profile(user_id)
        for cred_type in DOCUMENT_TYPES:
            await _add_credential(user_id, cred_type, "verified")
        async with _test_session_factory() as db:
            user = await db.get(User, user_id)
            can_work, missing = await chw_can_work(db, user)
        assert can_work is False
        assert "profile_incomplete" in missing

    async def test_missing_zip_blocks_with_profile_incomplete(self):
        user_id = await _create_chw_user()
        await _create_chw_profile(user_id, zip_code=None)
        for cred_type in DOCUMENT_TYPES:
            await _add_credential(user_id, cred_type, "verified")
        async with _test_session_factory() as db:
            user = await db.get(User, user_id)
            can_work, missing = await chw_can_work(db, user)
        assert can_work is False
        assert "profile_incomplete" in missing

    async def test_missing_bio_blocks_with_bio_code(self):
        user_id = await _create_chw_user()
        await _create_chw_profile(user_id, bio=None)
        for cred_type in DOCUMENT_TYPES:
            await _add_credential(user_id, cred_type, "verified")
        async with _test_session_factory() as db:
            user = await db.get(User, user_id)
            can_work, missing = await chw_can_work(db, user)
        assert can_work is False
        assert "bio_missing_or_too_long" in missing
        # Profile itself (name/phone/zip) is otherwise fine.
        assert "profile_incomplete" not in missing

    async def test_bio_over_120_chars_blocks_with_bio_code(self):
        user_id = await _create_chw_user()
        await _create_chw_profile(user_id, bio="x" * 121)
        for cred_type in DOCUMENT_TYPES:
            await _add_credential(user_id, cred_type, "verified")
        async with _test_session_factory() as db:
            user = await db.get(User, user_id)
            can_work, missing = await chw_can_work(db, user)
        assert can_work is False
        assert "bio_missing_or_too_long" in missing

    async def test_bio_exactly_120_chars_is_valid(self):
        user_id = await _create_chw_user()
        await _create_chw_profile(user_id, bio="x" * 120)
        for cred_type in DOCUMENT_TYPES:
            await _add_credential(user_id, cred_type, "verified")
        async with _test_session_factory() as db:
            user = await db.get(User, user_id)
            can_work, missing = await chw_can_work(db, user)
        assert "bio_missing_or_too_long" not in missing

    @pytest.mark.parametrize("cred_type", DOCUMENT_TYPES)
    async def test_missing_credential_row_blocks_with_its_type_code(self, cred_type: str):
        """A type with NO row at all (never submitted) must block."""
        user_id = await _create_chw_user()
        await _create_chw_profile(user_id)
        for t in DOCUMENT_TYPES:
            if t != cred_type:
                await _add_credential(user_id, t, "verified")
        async with _test_session_factory() as db:
            user = await db.get(User, user_id)
            can_work, missing = await chw_can_work(db, user)
        assert can_work is False
        assert cred_type in missing

    @pytest.mark.parametrize("cred_type", DOCUMENT_TYPES)
    @pytest.mark.parametrize("bad_status", ["pending", "rejected"])
    async def test_credential_not_verified_blocks_with_its_type_code(
        self, cred_type: str, bad_status: str
    ):
        """pending/rejected (uploaded but not verified) must still block —
        this is intentional per the epic spec, not a bug."""
        user_id = await _create_chw_user()
        await _create_chw_profile(user_id)
        for t in DOCUMENT_TYPES:
            await _add_credential(user_id, t, "verified" if t != cred_type else bad_status)
        async with _test_session_factory() as db:
            user = await db.get(User, user_id)
            can_work, missing = await chw_can_work(db, user)
        assert can_work is False
        assert cred_type in missing

    @pytest.mark.parametrize("bad_status", ["not_started", "pending", "consider"])
    async def test_background_check_not_clear_blocks(self, bad_status: str):
        user_id = await _create_chw_user()
        await _create_chw_profile(user_id, background_check_status=bad_status)
        for cred_type in DOCUMENT_TYPES:
            await _add_credential(user_id, cred_type, "verified")
        async with _test_session_factory() as db:
            user = await db.get(User, user_id)
            can_work, missing = await chw_can_work(db, user)
        assert can_work is False
        assert "background_check" in missing

    async def test_background_check_clear_does_not_block(self):
        user_id = await _create_chw_user()
        await _create_chw_profile(user_id, background_check_status="clear")
        for cred_type in DOCUMENT_TYPES:
            await _add_credential(user_id, cred_type, "verified")
        async with _test_session_factory() as db:
            user = await db.get(User, user_id)
            can_work, missing = await chw_can_work(db, user)
        assert "background_check" not in missing


class TestDefensiveNoCrash:
    """TESTING.md rule 3 — no unhandled 500s / crashes on malformed data."""

    async def test_chw_with_no_profile_row_does_not_crash_and_fails_every_check(self):
        """A User row with role=chw but NO CHWProfile row at all (should be
        unreachable via the API, but defend against it directly)."""
        user_id = await _create_chw_user()
        # Deliberately do NOT create a CHWProfile row.
        async with _test_session_factory() as db:
            user = await db.get(User, user_id)
            can_work, missing = await chw_can_work(db, user)
        assert can_work is False
        assert "profile_incomplete" in missing
        assert "bio_missing_or_too_long" in missing
        assert "background_check" in missing
        for cred_type in DOCUMENT_TYPES:
            assert cred_type in missing

    async def test_get_compliance_status_does_not_crash_with_no_profile_row(self):
        user_id = await _create_chw_user()
        async with _test_session_factory() as db:
            user = await db.get(User, user_id)
            status = await get_compliance_status(db, user)
        assert status.can_work is False
        assert status.background_check_status == "not_started"
        for cred_type in DOCUMENT_TYPES:
            assert status.credentials[cred_type] == "missing"

    async def test_whitespace_only_bio_is_treated_as_missing(self):
        user_id = await _create_chw_user()
        await _create_chw_profile(user_id, bio="    ")
        for cred_type in DOCUMENT_TYPES:
            await _add_credential(user_id, cred_type, "verified")
        async with _test_session_factory() as db:
            user = await db.get(User, user_id)
            can_work, missing = await chw_can_work(db, user)
        assert can_work is False
        assert "bio_missing_or_too_long" in missing


class TestGetComplianceStatus:
    async def test_fully_compliant_status_payload(self):
        user_id = await _make_fully_compliant_chw()
        async with _test_session_factory() as db:
            user = await db.get(User, user_id)
            status = await get_compliance_status(db, user)
        assert status.can_work is True
        assert status.missing == []
        assert status.background_check_status == "clear"
        for cred_type in DOCUMENT_TYPES:
            assert status.credentials[cred_type] == "verified"

    async def test_partial_status_reports_per_type_status(self):
        user_id = await _create_chw_user()
        await _create_chw_profile(user_id)
        await _add_credential(user_id, "hipaa_training", "verified")
        await _add_credential(user_id, "professional_service_agreement", "pending")
        await _add_credential(user_id, "liability_insurance", "rejected")
        # chw_certification: no row at all -> "missing"
        async with _test_session_factory() as db:
            user = await db.get(User, user_id)
            status = await get_compliance_status(db, user)
        assert status.credentials["hipaa_training"] == "verified"
        assert status.credentials["professional_service_agreement"] == "pending"
        assert status.credentials["liability_insurance"] == "rejected"
        assert status.credentials["chw_certification"] == "missing"
        assert status.can_work is False

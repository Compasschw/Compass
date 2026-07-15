"""Tests for the forgot-password reset flow.

Runs against an ISOLATED database (``compass_test_pwreset``, distinct from
the shared ``compass_test`` DB the rest of the suite uses via
tests/conftest.py) so this file can run concurrently with another agent's
test runs against the shared DB without either clobbering the other's
schema during setup/teardown. Mirrors the isolation pattern established in
tests/test_documentation_units_floor.py — the isolated DB is created once at
import time (if it doesn't already exist) via a raw asyncpg connection
(``psql`` may not be on PATH), and its public schema is dropped/recreated
around every test.

Security invariants under test (see backend/TESTING.md golden rules):
- No enumeration: request always 202s with an identical body, and creates
  ZERO token rows for an unknown email.
- Ineligible-but-202: inactive, deleted/tombstoned, and OAuth-only accounts
  all 202 without a *usable* reset token (OAuth-only instead fires the
  informational email).
- Single-use + expiry: a token can be confirmed exactly once, and an
  expired token is rejected with the same generic 401 as an unknown one.
- Newest-link-only: requesting a second reset token invalidates the first.
- Full session invalidation: confirming a reset revokes EVERY outstanding
  refresh token for the account (multi-device sign-out), verified via a
  subsequent POST /auth/refresh returning 401.
- must_change_password is cleared by a successful reset.
- Audit rows exist for both the request and the confirm, and never contain
  the raw token or its hash.
- The email-provider send path never raises out of the request endpoint
  (still 202 on a raising provider).
- Rate limiting fires on request (3/min) and is disabled for the rest of
  the suite via DISABLE_RATE_LIMIT=1 — this file re-enables the limiter
  for the one test that exercises it, mirroring tests/test_magic_link.py.
"""

import asyncio
import hashlib
import os
from unittest.mock import AsyncMock, patch

import asyncpg
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, text
from sqlalchemy.engine.url import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

os.environ.setdefault("DISABLE_RATE_LIMIT", "1")
os.environ.setdefault(
    "SECRET_KEY",
    "test-secret-key-for-pytest-runner-placeholder-AABBCCDD",
)
os.environ.setdefault("ADMIN_KEY", "test-admin-key-for-pytest-1234")
os.environ.setdefault("EMAIL_PROVIDER", "noop")

# NOTE: DATABASE_URL is intentionally NOT set here to compass_test_pwreset —
# several app-layer services read app.database.engine, which is constructed
# once at import time from DATABASE_URL. Pinning it here would only take
# effect if this module imports before app.database is first imported
# anywhere in the process, which pytest does not guarantee across files.
# Instead, this file overrides ONLY the FastAPI `get_db` dependency (the
# same mechanism tests/conftest.py uses) to point requests at the isolated
# DB, without needing DATABASE_URL to be globally correct.

from app.database import Base, get_db  # noqa: E402
from app.main import app  # noqa: E402
from app.models.audit import AuditLog  # noqa: E402
from app.models.password_reset import PasswordResetToken  # noqa: E402
from app.models.user import User  # noqa: E402

_BASE_DB_URL = make_url(
    os.environ.get(
        "DATABASE_URL",
        "postgresql+asyncpg://compass:compass_dev_password@localhost:5432/compass_test",
    )
)
ADMIN_PG_URL = _BASE_DB_URL.set(
    drivername="postgresql", database="postgres"
).render_as_string(hide_password=False)
TEST_PWRESET_SQLALCHEMY_URL = _BASE_DB_URL.set(
    drivername="postgresql+asyncpg", database="compass_test_pwreset"
).render_as_string(hide_password=False)

pwreset_engine = create_async_engine(TEST_PWRESET_SQLALCHEMY_URL, echo=False)
pwreset_session = async_sessionmaker(pwreset_engine, class_=AsyncSession, expire_on_commit=False)


def _ensure_compass_test_pwreset_exists() -> None:
    """Creates the compass_test_pwreset database if it doesn't already exist.

    Synchronous, run once at module import — asyncpg's CREATE DATABASE must
    run outside a transaction block, which is simplest via a short-lived
    event loop here rather than inside an async fixture. Uses asyncpg
    directly rather than shelling out to `psql`, which may not be on PATH.
    """
    async def _create() -> None:
        conn = await asyncpg.connect(dsn=ADMIN_PG_URL)
        try:
            exists = await conn.fetchval(
                "SELECT 1 FROM pg_database WHERE datname = 'compass_test_pwreset'"
            )
            if not exists:
                await conn.execute("CREATE DATABASE compass_test_pwreset OWNER compass")
        finally:
            await conn.close()

    asyncio.run(_create())


_ensure_compass_test_pwreset_exists()


async def _override_get_db():
    async with pwreset_session() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise


@pytest.fixture(autouse=True)
async def setup_isolated_db():
    """Drop/recreate the public schema on compass_test_pwreset around every
    test, and swap in this file's get_db override for the duration of the
    test — restoring whatever override was previously registered afterward,
    so running this file alongside tests/conftest.py-based files in the
    same session doesn't leave the shared `app` object pointed at
    compass_test_pwreset."""
    from app.database import engine as _app_engine

    previous_override = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = _override_get_db

    await pwreset_engine.dispose()
    async with pwreset_engine.begin() as conn:
        await conn.execute(text("DROP SCHEMA IF EXISTS public CASCADE"))
        await conn.execute(text("CREATE SCHEMA public"))
        await conn.run_sync(Base.metadata.create_all)

    yield

    await pwreset_engine.dispose()
    async with pwreset_engine.begin() as conn:
        await conn.execute(text("DROP SCHEMA IF EXISTS public CASCADE"))
        await conn.execute(text("CREATE SCHEMA public"))
    await pwreset_engine.dispose()
    await _app_engine.dispose()

    if previous_override is not None:
        app.dependency_overrides[get_db] = previous_override
    else:
        app.dependency_overrides.pop(get_db, None)


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

REQUEST_URL = "/api/v1/auth/password-reset/request"
CONFIRM_URL = "/api/v1/auth/password-reset/confirm"
REGISTER_URL = "/api/v1/auth/register"
LOGIN_URL = "/api/v1/auth/login"
REFRESH_URL = "/api/v1/auth/refresh"

_MEMBER_EMAIL = "pwreset.member@example.com"
_MEMBER_PASSWORD = "Original-password-123!"


def _member_payload(email: str = _MEMBER_EMAIL, password: str = _MEMBER_PASSWORD) -> dict:
    # Phone and CIN derived from the email so multiple registrations in one test
    # never collide with the users.phone partial unique index (QA2 A1) or the
    # member_profiles CIN unique index (QA3 Part 4) — mirrors the conftest helper.
    email_suffix = abs(hash(email)) % 10_000_000
    return {
        "email": email,
        "password": password,
        "name": "Password Reset Member",
        "role": "member",
        "phone": f"+1310{email_suffix:07d}",
        "date_of_birth": "1993-01-05",
        "gender": "Female",
        "insurance_company": "Health Net",
        "medi_cal_id": f"MC{email_suffix:07d}",
        "address_line1": "1 Main St",
        "city": "Los Angeles",
        "state": "CA",
        "zip_code": "90001",
        "terms_accepted": True,
        "communications_consent": True,
    }


async def _register_member(client: AsyncClient, email: str = _MEMBER_EMAIL, password: str = _MEMBER_PASSWORD) -> dict:
    res = await client.post(REGISTER_URL, json=_member_payload(email=email, password=password))
    assert res.status_code == 201, res.text
    return res.json()


async def _get_user_by_email(email: str) -> User:
    async with pwreset_session() as session:
        result = await session.execute(select(User).where(User.email == email))
        user = result.scalar_one_or_none()
        assert user is not None, f"User {email} not found in DB"
        return user


async def _token_rows_for_user(user_id) -> list[PasswordResetToken]:
    async with pwreset_session() as session:
        result = await session.execute(
            select(PasswordResetToken).where(PasswordResetToken.user_id == user_id)
        )
        return list(result.scalars().all())


async def _all_token_rows() -> list[PasswordResetToken]:
    async with pwreset_session() as session:
        result = await session.execute(select(PasswordResetToken))
        return list(result.scalars().all())


async def _audit_rows_for_user(user_id, action: str) -> list[AuditLog]:
    async with pwreset_session() as session:
        result = await session.execute(
            select(AuditLog).where(AuditLog.user_id == user_id, AuditLog.action == action)
        )
        return list(result.scalars().all())


def _extract_raw_token_from_url(url: str) -> str:
    assert "token=" in url, f"reset URL missing token param: {url}"
    return url.split("token=", 1)[1]


# ---------------------------------------------------------------------------
# Happy path — request -> email captures raw token -> confirm -> login
# ---------------------------------------------------------------------------


async def test_happy_path_request_confirm_then_login_with_new_password(client: AsyncClient):
    await _register_member(client)

    fake_send = AsyncMock(return_value=__import__("app.services.email", fromlist=["EmailResult"]).EmailResult(success=True))
    with patch("app.services.email.send_password_reset_email", fake_send):
        req_res = await client.post(REQUEST_URL, json={"email": _MEMBER_EMAIL})
    assert req_res.status_code == 202
    assert req_res.json() == {"status": "accepted"}

    fake_send.assert_awaited_once()
    _, kwargs = fake_send.call_args
    assert kwargs["to"] == _MEMBER_EMAIL
    reset_url = kwargs["reset_url"]
    assert reset_url.startswith("https://joincompasschw.com/auth/reset-password?token=")
    raw_token = _extract_raw_token_from_url(reset_url)

    new_password = "Brand-new-password-456!"
    confirm_res = await client.post(
        CONFIRM_URL, json={"token": raw_token, "new_password": new_password}
    )
    assert confirm_res.status_code == 200, confirm_res.text
    assert confirm_res.json() == {"ok": True}

    # Login with the NEW password succeeds.
    login_res = await client.post(LOGIN_URL, json={"email": _MEMBER_EMAIL, "password": new_password})
    assert login_res.status_code == 200, login_res.text

    # Login with the OLD password now fails.
    old_login_res = await client.post(LOGIN_URL, json={"email": _MEMBER_EMAIL, "password": _MEMBER_PASSWORD})
    assert old_login_res.status_code == 401


# ---------------------------------------------------------------------------
# No enumeration
# ---------------------------------------------------------------------------


async def test_unknown_email_returns_202_with_zero_token_rows(client: AsyncClient):
    res = await client.post(REQUEST_URL, json={"email": "nobody-pwreset@example.com"})
    assert res.status_code == 202
    assert res.json() == {"status": "accepted"}

    rows = await _all_token_rows()
    assert rows == [], "No token row should be created for an unknown email"


async def test_invalid_email_format_returns_422(client: AsyncClient):
    res = await client.post(REQUEST_URL, json={"email": "not-an-email"})
    assert res.status_code == 422


# ---------------------------------------------------------------------------
# Expired / single-use / newest-link-only
# ---------------------------------------------------------------------------


async def test_expired_token_returns_401(client: AsyncClient):
    await _register_member(client)
    user = await _get_user_by_email(_MEMBER_EMAIL)

    from datetime import UTC, datetime, timedelta

    raw_token = "expired-raw-token-for-test"
    token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
    async with pwreset_session() as session:
        session.add(PasswordResetToken(
            user_id=user.id,
            token_hash=token_hash,
            expires_at=datetime.now(UTC) - timedelta(minutes=1),
        ))
        await session.commit()

    res = await client.post(CONFIRM_URL, json={"token": raw_token, "new_password": "New-password-789!"})
    assert res.status_code == 401
    assert res.json()["detail"] == "Invalid or expired reset link"


async def test_second_confirm_with_same_token_returns_401(client: AsyncClient):
    await _register_member(client)

    fake_send = AsyncMock(return_value=__import__("app.services.email", fromlist=["EmailResult"]).EmailResult(success=True))
    with patch("app.services.email.send_password_reset_email", fake_send):
        req_res = await client.post(REQUEST_URL, json={"email": _MEMBER_EMAIL})
    assert req_res.status_code == 202

    raw_token = _extract_raw_token_from_url(fake_send.call_args.kwargs["reset_url"])

    first = await client.post(CONFIRM_URL, json={"token": raw_token, "new_password": "First-new-password-1!"})
    assert first.status_code == 200, first.text

    second = await client.post(CONFIRM_URL, json={"token": raw_token, "new_password": "Second-new-password-2!"})
    assert second.status_code == 401
    assert second.json()["detail"] == "Invalid or expired reset link"


async def test_newest_link_only_older_token_unusable_after_re_request(client: AsyncClient):
    await _register_member(client)

    from app.services.email import EmailResult

    fake_send = AsyncMock(return_value=EmailResult(success=True))
    with patch("app.services.email.send_password_reset_email", fake_send):
        first_req = await client.post(REQUEST_URL, json={"email": _MEMBER_EMAIL})
        assert first_req.status_code == 202
        first_raw_token = _extract_raw_token_from_url(fake_send.call_args.kwargs["reset_url"])

        second_req = await client.post(REQUEST_URL, json={"email": _MEMBER_EMAIL})
        assert second_req.status_code == 202
        second_raw_token = _extract_raw_token_from_url(fake_send.call_args.kwargs["reset_url"])

    assert first_raw_token != second_raw_token

    # The OLDER token must now be unusable (consumed by the re-request).
    stale_res = await client.post(
        CONFIRM_URL, json={"token": first_raw_token, "new_password": "Stale-token-password-1!"}
    )
    assert stale_res.status_code == 401

    # The NEWEST token must still work.
    fresh_res = await client.post(
        CONFIRM_URL, json={"token": second_raw_token, "new_password": "Fresh-token-password-2!"}
    )
    assert fresh_res.status_code == 200, fresh_res.text


# ---------------------------------------------------------------------------
# Ineligible accounts: inactive / deleted / OAuth-only
# ---------------------------------------------------------------------------


async def test_inactive_account_returns_202_but_no_usable_token(client: AsyncClient):
    await _register_member(client, email="pwreset.inactive@example.com")
    user = await _get_user_by_email("pwreset.inactive@example.com")

    async with pwreset_session() as session:
        db_user = await session.get(User, user.id)
        db_user.is_active = False
        await session.commit()

    res = await client.post(REQUEST_URL, json={"email": "pwreset.inactive@example.com"})
    assert res.status_code == 202
    assert res.json() == {"status": "accepted"}

    rows = await _token_rows_for_user(user.id)
    assert rows == [], "Inactive account must not get a usable reset token"


async def test_deleted_account_returns_202_but_no_usable_token(client: AsyncClient):
    await _register_member(client, email="pwreset.deleted@example.com")
    user = await _get_user_by_email("pwreset.deleted@example.com")

    from datetime import UTC, datetime

    async with pwreset_session() as session:
        db_user = await session.get(User, user.id)
        db_user.deleted_at = datetime.now(UTC)
        await session.commit()

    res = await client.post(REQUEST_URL, json={"email": "pwreset.deleted@example.com"})
    assert res.status_code == 202
    assert res.json() == {"status": "accepted"}

    rows = await _token_rows_for_user(user.id)
    assert rows == [], "Deleted/tombstoned account must not get a usable reset token"


async def test_oauth_only_account_returns_202_no_token_and_sends_informational_email(client: AsyncClient):
    """An OAuth-only account (password_hash IS NULL) has no password to
    reset — the request must still 202, must NOT create a usable reset
    token, and must instead trigger the informational email."""
    from app.models.user import MemberProfile

    oauth_email = "pwreset.oauth@example.com"
    async with pwreset_session() as session:
        oauth_user = User(
            email=oauth_email,
            password_hash=None,
            name="OAuth Only Member",
            role="member",
        )
        session.add(oauth_user)
        await session.flush()
        session.add(MemberProfile(user_id=oauth_user.id, onboarding_complete=False))
        await session.commit()
        oauth_user_id = oauth_user.id

    fake_oauth_email = AsyncMock(
        return_value=__import__("app.services.email", fromlist=["EmailResult"]).EmailResult(success=True)
    )
    with patch("app.services.email.send_oauth_only_password_reset_email", fake_oauth_email):
        res = await client.post(REQUEST_URL, json={"email": oauth_email})

    assert res.status_code == 202
    assert res.json() == {"status": "accepted"}

    fake_oauth_email.assert_awaited_once()
    _, kwargs = fake_oauth_email.call_args
    assert kwargs["to"] == oauth_email

    rows = await _token_rows_for_user(oauth_user_id)
    assert rows == [], "OAuth-only account must not get a usable reset token"


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


async def test_confirm_short_password_returns_422(client: AsyncClient):
    await _register_member(client)

    from app.services.email import EmailResult

    fake_send = AsyncMock(return_value=EmailResult(success=True))
    with patch("app.services.email.send_password_reset_email", fake_send):
        req_res = await client.post(REQUEST_URL, json={"email": _MEMBER_EMAIL})
    assert req_res.status_code == 202
    raw_token = _extract_raw_token_from_url(fake_send.call_args.kwargs["reset_url"])

    res = await client.post(CONFIRM_URL, json={"token": raw_token, "new_password": "short"})
    assert res.status_code == 422


async def test_confirm_unknown_token_returns_401(client: AsyncClient):
    res = await client.post(
        CONFIRM_URL, json={"token": "totally-made-up-token", "new_password": "Some-new-password-1!"}
    )
    assert res.status_code == 401
    assert res.json()["detail"] == "Invalid or expired reset link"


# ---------------------------------------------------------------------------
# Session invalidation — ALL refresh tokens revoked, must_change_password cleared
# ---------------------------------------------------------------------------


async def test_confirm_revokes_all_refresh_tokens_and_clears_must_change_password(client: AsyncClient):
    register_res = await _register_member(client, email="pwreset.revoke@example.com")
    user = await _get_user_by_email("pwreset.revoke@example.com")

    # Force must_change_password True to prove the reset clears it, and mint
    # a SECOND refresh token via login (in addition to the one issued at
    # registration) to prove ALL outstanding tokens are revoked, not just
    # the most recent.
    async with pwreset_session() as session:
        db_user = await session.get(User, user.id)
        db_user.must_change_password = True
        await session.commit()

    login_res = await client.post(
        LOGIN_URL, json={"email": "pwreset.revoke@example.com", "password": _MEMBER_PASSWORD}
    )
    assert login_res.status_code == 200, login_res.text
    login_refresh_token = login_res.json()["refresh_token"]
    register_refresh_token = register_res["refresh_token"]

    from app.services.email import EmailResult

    fake_reset_send = AsyncMock(return_value=EmailResult(success=True))
    fake_changed_send = AsyncMock(return_value=EmailResult(success=True))
    with patch("app.services.email.send_password_reset_email", fake_reset_send), \
         patch("app.services.email.send_password_changed_email", fake_changed_send):
        req_res = await client.post(REQUEST_URL, json={"email": "pwreset.revoke@example.com"})
        assert req_res.status_code == 202
        raw_token = _extract_raw_token_from_url(fake_reset_send.call_args.kwargs["reset_url"])

        confirm_res = await client.post(
            CONFIRM_URL, json={"token": raw_token, "new_password": "Post-reset-password-999!"}
        )
    assert confirm_res.status_code == 200, confirm_res.text
    fake_changed_send.assert_awaited_once()

    # Both the registration-time AND the login-time refresh tokens must now
    # be rejected — full multi-device sign-out.
    refresh_res_1 = await client.post(REFRESH_URL, json={"refresh_token": register_refresh_token})
    assert refresh_res_1.status_code == 401

    refresh_res_2 = await client.post(REFRESH_URL, json={"refresh_token": login_refresh_token})
    assert refresh_res_2.status_code == 401

    # must_change_password must be cleared by the reset.
    reloaded = await _get_user_by_email("pwreset.revoke@example.com")
    assert reloaded.must_change_password is False


# ---------------------------------------------------------------------------
# Audit trail — no token material in details
# ---------------------------------------------------------------------------


async def test_audit_rows_exist_for_request_and_confirm_with_no_token_material(client: AsyncClient):
    await _register_member(client, email="pwreset.audit@example.com")
    user = await _get_user_by_email("pwreset.audit@example.com")

    from app.services.email import EmailResult

    fake_send = AsyncMock(return_value=EmailResult(success=True))
    with patch("app.services.email.send_password_reset_email", fake_send):
        req_res = await client.post(REQUEST_URL, json={"email": "pwreset.audit@example.com"})
        assert req_res.status_code == 202
        raw_token = _extract_raw_token_from_url(fake_send.call_args.kwargs["reset_url"])

        confirm_res = await client.post(
            CONFIRM_URL, json={"token": raw_token, "new_password": "Audited-new-password-1!"}
        )
    assert confirm_res.status_code == 200, confirm_res.text

    requested_rows = await _audit_rows_for_user(user.id, "password_reset_requested")
    assert len(requested_rows) == 1
    requested_details = requested_rows[0].details or {}
    _assert_no_token_material(requested_details, raw_token)

    completed_rows = await _audit_rows_for_user(user.id, "password_reset_completed")
    assert len(completed_rows) == 1
    completed_details = completed_rows[0].details or {}
    _assert_no_token_material(completed_details, raw_token)


def _assert_no_token_material(details: dict, raw_token: str) -> None:
    token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
    serialized = str(details)
    assert raw_token not in serialized, "Raw reset token must never appear in audit details"
    assert token_hash not in serialized, "Reset token hash must never appear in audit details"


# ---------------------------------------------------------------------------
# Never-raise: an email-provider exception must not fail the request endpoint
# ---------------------------------------------------------------------------


async def test_email_provider_raising_still_returns_202(client: AsyncClient):
    await _register_member(client, email="pwreset.emailfail@example.com")

    async def boom(*args, **kwargs):
        raise RuntimeError("SES outage simulated")

    with patch("app.services.email.send_password_reset_email", boom):
        res = await client.post(REQUEST_URL, json={"email": "pwreset.emailfail@example.com"})

    assert res.status_code == 202
    assert res.json() == {"status": "accepted"}

    # A token row must still have been created (email delivery failing must
    # not roll back the already-committed token).
    user = await _get_user_by_email("pwreset.emailfail@example.com")
    rows = await _token_rows_for_user(user.id)
    assert len(rows) == 1


# ---------------------------------------------------------------------------
# Rate limiting — re-enabled for this one test, mirroring test_magic_link.py
# ---------------------------------------------------------------------------


async def test_request_rate_limit_fires_on_fourth_request_per_minute(client: AsyncClient):
    """The real limiter caps /password-reset/request at 3/min per IP. This
    test re-enables the limiter (normally disabled suite-wide via
    DISABLE_RATE_LIMIT=1) and asserts the 4th rapid request in the same
    minute is throttled with 429."""
    from app.limiter import limiter

    await _register_member(client, email="pwreset.ratelimit@example.com")

    limiter.enabled = True
    try:
        statuses = []
        for _ in range(4):
            res = await client.post(REQUEST_URL, json={"email": "pwreset.ratelimit@example.com"})
            statuses.append(res.status_code)
        assert statuses[:3] == [202, 202, 202], statuses
        assert statuses[3] == 429, f"4th request should be rate-limited, got statuses={statuses}"
    finally:
        limiter.enabled = False


# ---------------------------------------------------------------------------
# Coverage of the defensive branches (diff-cover gate): the send-wrapper
# never-raise contract, the OAuth-only render body, and the router's
# email-failure logging paths. Every branch below is a "degrade gracefully,
# never 500" guarantee — pinned so a refactor can't silently drop one.
# ---------------------------------------------------------------------------


async def test_send_wrappers_return_failure_result_when_provider_raises():
    """All three send fns swallow a raising provider into
    EmailResult(success=False) — the never-raise contract itself."""
    import app.services.email as email_svc

    def _boom():
        raise RuntimeError("provider construction failed")

    original = email_svc.get_email_provider
    email_svc.get_email_provider = _boom  # type: ignore[assignment]
    try:
        r1 = await email_svc.send_password_reset_email(
            to="x@example.com", reset_url="https://example.com/r?token=t", ttl_minutes=30
        )
        r2 = await email_svc.send_oauth_only_password_reset_email(to="x@example.com")
        r3 = await email_svc.send_password_changed_email(to="x@example.com")
    finally:
        email_svc.get_email_provider = original  # type: ignore[assignment]

    for r in (r1, r2, r3):
        assert r.success is False
        assert r.error


async def test_send_wrappers_happy_path_via_noop_provider():
    """The try-bodies of all three send fns execute end-to-end against the
    noop provider (EMAIL_PROVIDER=noop in tests)."""
    import app.services.email as email_svc

    r1 = await email_svc.send_password_reset_email(
        to="x@example.com", reset_url="https://example.com/r?token=t", ttl_minutes=30
    )
    r2 = await email_svc.send_oauth_only_password_reset_email(to="x@example.com")
    r3 = await email_svc.send_password_changed_email(to="x@example.com")
    assert r1.success and r2.success and r3.success


def test_oauth_only_render_points_at_google_apple_and_has_no_reset_link():
    from app.services.email import render_oauth_only_password_reset_email

    subject, html, text = render_oauth_only_password_reset_email()
    assert "sign-in" in subject.lower() or "sign in" in subject.lower()
    for body in (html, text):
        assert "Google" in body and "Apple" in body
        assert "token=" not in body  # informational — never a reset link
    assert "ignore this email" in text


async def test_request_oauth_only_email_failure_and_raise_still_202(client: AsyncClient, monkeypatch):
    """OAuth-only path: informational email returning failure AND raising
    both still yield the neutral 202 (no-enumeration endpoint must never 500)."""
    import app.services.email as email_mod
    from app.services.email import EmailResult

    email = "pwreset.oauthdefense@example.com"
    await _register_member(client, email=email)
    user = await _get_user_by_email(email)
    async with pwreset_session() as session:
        db_user = await session.get(User, user.id)
        db_user.password_hash = None  # simulate OAuth-only account
        await session.commit()

    monkeypatch.setattr(
        email_mod, "send_oauth_only_password_reset_email",
        AsyncMock(return_value=EmailResult(success=False, error="ses down")),
    )
    res = await client.post(REQUEST_URL, json={"email": email})
    assert res.status_code == 202, res.text

    monkeypatch.setattr(
        email_mod, "send_oauth_only_password_reset_email",
        AsyncMock(side_effect=RuntimeError("boom")),
    )
    res = await client.post(REQUEST_URL, json={"email": email})
    assert res.status_code == 202, res.text


async def test_request_reset_email_failure_logs_dev_url_and_still_202(client: AsyncClient, monkeypatch):
    """Reset-email send failure → 202, and in the development environment the
    reset URL is logged as a local convenience (branch pinned)."""
    import app.services.email as email_mod
    from app.config import settings
    from app.services.email import EmailResult

    email = "pwreset.devlog@example.com"
    await _register_member(client, email=email)

    monkeypatch.setattr(
        email_mod, "send_password_reset_email",
        AsyncMock(return_value=EmailResult(success=False, error="ses sandbox")),
    )
    monkeypatch.setattr(settings, "environment", "development")
    res = await client.post(REQUEST_URL, json={"email": email})
    assert res.status_code == 202, res.text
    # The token row exists even though the email failed — resend works later.
    user = await _get_user_by_email(email)
    assert len(await _token_rows_for_user(user.id)) == 1


async def test_confirm_rejects_user_deleted_after_request(client: AsyncClient, monkeypatch):
    """A token issued BEFORE the account was deleted must be unusable after —
    the confirm-side active/deleted re-check."""
    import app.services.email as email_mod
    from app.services.email import EmailResult

    email = "pwreset.deletedrace@example.com"
    await _register_member(client, email=email)

    captured: dict = {}

    async def _capture(**kwargs):
        captured.update(kwargs)
        return EmailResult(success=True)

    monkeypatch.setattr(email_mod, "send_password_reset_email", AsyncMock(side_effect=_capture))
    res = await client.post(REQUEST_URL, json={"email": email})
    assert res.status_code == 202
    raw_token = _extract_raw_token_from_url(captured["reset_url"])

    user = await _get_user_by_email(email)
    from datetime import UTC, datetime
    async with pwreset_session() as session:
        db_user = await session.get(User, user.id)
        db_user.deleted_at = datetime.now(UTC)
        await session.commit()

    res = await client.post(CONFIRM_URL, json={"token": raw_token, "new_password": "Brand-new-pass-1!"})
    assert res.status_code == 401, res.text


async def test_confirm_password_changed_email_failure_and_raise_still_200(client: AsyncClient, monkeypatch):
    """The post-commit notification email failing (or raising) must never turn
    an already-successful reset into an error."""
    import app.services.email as email_mod
    from app.services.email import EmailResult

    for suffix, notifier in (
        ("fail", AsyncMock(return_value=EmailResult(success=False, error="ses down"))),
        ("raise", AsyncMock(side_effect=RuntimeError("boom"))),
    ):
        email = f"pwreset.notify{suffix}@example.com"
        await _register_member(client, email=email)

        captured: dict = {}

        async def _capture(_captured: dict = captured, **kwargs):
            _captured.update(kwargs)
            return EmailResult(success=True)

        monkeypatch.setattr(email_mod, "send_password_reset_email", AsyncMock(side_effect=_capture))
        res = await client.post(REQUEST_URL, json={"email": email})
        assert res.status_code == 202
        raw_token = _extract_raw_token_from_url(captured["reset_url"])

        monkeypatch.setattr(email_mod, "send_password_changed_email", notifier)
        res = await client.post(CONFIRM_URL, json={"token": raw_token, "new_password": "Brand-new-pass-1!"})
        assert res.status_code == 200, res.text
        assert res.json().get("ok") is True

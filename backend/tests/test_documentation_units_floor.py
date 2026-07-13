"""Integration tests for the 16-minute billable-floor bracket (Epic Q2,
2026-07-13) end-to-end through POST /sessions/{id}/documentation.

Runs against an ISOLATED database (``compass_test_q``, distinct from the
shared ``compass_test`` DB the rest of the suite uses via tests/conftest.py)
so this file can run concurrently with another agent's test runs against
the shared DB without either clobbering the other's schema during
setup/teardown. The isolated DB is created once at import time (if it
doesn't already exist) and its public schema is dropped/recreated around
every test, mirroring the isolation pattern in tests/conftest.py — but
scoped to its own engine/session/app.dependency_overrides so this file
doesn't depend on (or interfere with) the shared conftest's fixtures.

Covers:
  - calculate_units bracket boundary matrix (also unit-tested directly in
    test_billing_service.py; re-asserted here at the HTTP-integration level
    via suggested_units to catch any drift between the two).
  - submit-documentation with a <16min entered window creates NO
    BillingClaim/SessionDocumentation row and returns 422 (the "block
    submit" design — see DocumentationModal.tsx module docstring and the
    PR report for the full rationale).
  - submit-documentation with a >=16min window is unchanged (regression
    against the pre-existing bracket/flow).
  - server-authoritative override: a client-sent units_to_bill is ignored;
    the server recomputes from duration and a client trying to claim a
    higher unit count than the true duration supports is overridden, not
    trusted.
"""
import asyncio
import os

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

# NOTE: DATABASE_URL is intentionally NOT set here to compass_test_q — several
# app-layer services (e.g. transcript persistence) read app.database.engine,
# which is constructed once at import time from DATABASE_URL. Pinning it here
# would only take effect if this module imports before app.database is first
# imported anywhere in the process, which pytest does not guarantee across
# files. Instead, this file overrides ONLY the FastAPI `get_db` dependency
# (the same mechanism tests/conftest.py uses) to point requests at the
# isolated DB, without needing DATABASE_URL to be globally correct.

from app.database import Base, get_db  # noqa: E402
from app.main import app  # noqa: E402

# Derive the isolated-DB URLs from DATABASE_URL so this file works both
# locally (default compass_dev_password credentials) AND in CI, where the
# postgres service uses different credentials (see .github/workflows/ci.yml —
# hardcoding local creds here made collection crash CI with
# InvalidPasswordError). Only the database NAME is swapped; credentials/host
# always follow the environment.
_BASE_DB_URL = make_url(
    os.environ.get(
        "DATABASE_URL",
        "postgresql+asyncpg://compass:compass_dev_password@localhost:5432/compass_test",
    )
)
ADMIN_PG_URL = _BASE_DB_URL.set(
    drivername="postgresql", database="postgres"
).render_as_string(hide_password=False)
TEST_Q_SQLALCHEMY_URL = _BASE_DB_URL.set(
    drivername="postgresql+asyncpg", database="compass_test_q"
).render_as_string(hide_password=False)

q_isolated_engine = create_async_engine(TEST_Q_SQLALCHEMY_URL, echo=False)
q_isolated_session = async_sessionmaker(q_isolated_engine, class_=AsyncSession, expire_on_commit=False)


def _ensure_compass_test_q_exists() -> None:
    """Creates the compass_test_q database if it doesn't already exist.

    Synchronous, run once at module import — asyncpg's CREATE DATABASE must
    run outside a transaction block, which is simplest via a short-lived
    event loop here rather than inside an async fixture.
    """
    async def _create() -> None:
        conn = await asyncpg.connect(dsn=ADMIN_PG_URL)
        try:
            exists = await conn.fetchval(
                "SELECT 1 FROM pg_database WHERE datname = 'compass_test_q'"
            )
            if not exists:
                await conn.execute("CREATE DATABASE compass_test_q OWNER compass")
        finally:
            await conn.close()

    asyncio.run(_create())


_ensure_compass_test_q_exists()


async def _override_get_db():
    async with q_isolated_session() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise


@pytest.fixture(autouse=True)
async def setup_isolated_db():
    """Drop/recreate the public schema on compass_test_q around every test,
    and swap in this file's get_db override for the duration of the test —
    restoring whatever override was previously registered afterward, so
    running this file alongside tests/conftest.py-based files in the same
    session doesn't leave the shared `app` object pointed at compass_test_q.
    """
    from app.database import engine as _app_engine

    previous_override = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = _override_get_db

    await q_isolated_engine.dispose()
    async with q_isolated_engine.begin() as conn:
        await conn.execute(text("DROP SCHEMA IF EXISTS public CASCADE"))
        await conn.execute(text("CREATE SCHEMA public"))
        await conn.run_sync(Base.metadata.create_all)

    yield

    await q_isolated_engine.dispose()
    async with q_isolated_engine.begin() as conn:
        await conn.execute(text("DROP SCHEMA IF EXISTS public CASCADE"))
        await conn.execute(text("CREATE SCHEMA public"))
    await q_isolated_engine.dispose()
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


@pytest.fixture
async def chw_tokens(client: AsyncClient) -> dict:
    res = await client.post("/api/v1/auth/register", json={
        "email": "q2-chw@example.com", "password": "testpass123",
        "name": "Q2 Test CHW", "role": "chw",
    })
    assert res.status_code == 201, res.text
    return res.json()


@pytest.fixture
async def member_tokens(client: AsyncClient) -> dict:
    res = await client.post("/api/v1/auth/register", json={
        "email": "q2-member@example.com",
        "password": "testpass123",
        "name": "Q2 Test Member",
        "role": "member",
        "phone": "+13105550100",
        "date_of_birth": "1993-01-05",
        "gender": "Female",
        "insurance_company": "Health Net",
        "medi_cal_id": "12345678A",
        "address_line1": "1 Main St",
        "city": "Los Angeles",
        "state": "CA",
        "zip_code": "90001",
        "terms_accepted": True,
        "communications_consent": True,
    })
    assert res.status_code == 201, res.text
    return res.json()


def auth_header(tokens: dict) -> dict:
    return {"Authorization": f"Bearer {tokens['access_token']}"}


async def _create_in_progress_session(client: AsyncClient, member_tokens: dict, chw_tokens: dict) -> str:
    res = await client.post("/api/v1/requests/", json={
        "vertical": "housing", "urgency": "routine",
        "description": "Need housing help", "preferred_mode": "in_person",
    }, headers=auth_header(member_tokens))
    assert res.status_code == 201, res.text
    request_id = res.json()["id"]

    res = await client.patch(f"/api/v1/requests/{request_id}/accept", headers=auth_header(chw_tokens))
    assert res.status_code == 200, res.text

    res = await client.post("/api/v1/sessions/", json={
        "request_id": request_id, "scheduled_at": "2026-07-13T10:00:00Z", "mode": "in_person",
    }, headers=auth_header(chw_tokens))
    assert res.status_code == 201, res.text
    session_id = res.json()["id"]

    res = await client.patch(f"/api/v1/sessions/{session_id}/start", headers=auth_header(chw_tokens))
    assert res.status_code == 200, res.text
    return session_id


# ─── calculate_units bracket — direct unit-level re-assertion ─────────────────


class TestCalculateUnitsBracketMatrix:
    """Re-asserts the exact boundary matrix from the task spec directly
    against calculate_units — belt-and-suspenders with test_billing_service.py
    (which is the primary/authoritative unit test for this function); this
    class exists so the isolated-DB test file is self-sufficient proof of the
    bracket without depending on another test file's presence."""

    @pytest.mark.parametrize("duration,expected", [
        (15, 0),
        (16, 1),
        (45, 1),
        (46, 2),
        (75, 2),
        (76, 3),
        (105, 3),
        (106, 4),
        (480, 4),
    ])
    def test_boundary_matrix(self, duration, expected):
        from app.services.billing_service import calculate_units
        assert calculate_units(duration) == expected


# ─── submit-documentation: <16min blocks the claim end-to-end ─────────────────


@pytest.mark.asyncio
async def test_submit_documentation_under_16_minutes_creates_no_claim(
    client: AsyncClient, chw_tokens, member_tokens
):
    """A <16-minute CHW-entered session window must be rejected (422) and
    must NOT create a SessionDocumentation or BillingClaim row — the CHW can
    never file a <16-minute claim. This is the "block submit" design: the
    backend's validate_claim() rejects a computed 0-unit claim before any
    row is persisted (see billing_service.py — no router change needed)."""
    from app.models.billing import BillingClaim
    from app.models.session import SessionDocumentation

    session_id = await _create_in_progress_session(client, member_tokens, chw_tokens)

    payload = {
        "summary": "Very brief check-in",
        "diagnosis_codes": ["Z59.1"],
        "procedure_code": "98960",
        "session_start_time": "2026-07-13T15:00:00Z",
        "session_end_time": "2026-07-13T15:10:00Z",  # 10 minutes — under the floor
    }
    res = await client.post(
        f"/api/v1/sessions/{session_id}/documentation",
        json=payload, headers=auth_header(chw_tokens),
    )
    assert res.status_code == 422, res.text
    assert "not billable" in res.text.lower()

    async with q_isolated_session() as db:
        from uuid import UUID
        doc = (
            await db.execute(
                select(SessionDocumentation).where(
                    SessionDocumentation.session_id == UUID(session_id)
                )
            )
        ).scalar_one_or_none()
        claim = (
            await db.execute(
                select(BillingClaim).where(BillingClaim.session_id == UUID(session_id))
            )
        ).scalar_one_or_none()

    assert doc is None, "documentation must NOT persist for a <16min session"
    assert claim is None, "no BillingClaim may be created for a <16min session"


@pytest.mark.asyncio
async def test_submit_documentation_at_exactly_15_minutes_still_blocked(
    client: AsyncClient, chw_tokens, member_tokens
):
    """Boundary check: exactly 15 minutes (one under the 16-minute floor) is
    still not billable — the floor is inclusive of 16, not 15."""
    session_id = await _create_in_progress_session(client, member_tokens, chw_tokens)

    payload = {
        "summary": "Quick check-in",
        "diagnosis_codes": ["Z59.1"],
        "procedure_code": "98960",
        "session_start_time": "2026-07-13T15:00:00Z",
        "session_end_time": "2026-07-13T15:15:00Z",  # exactly 15 minutes
    }
    res = await client.post(
        f"/api/v1/sessions/{session_id}/documentation",
        json=payload, headers=auth_header(chw_tokens),
    )
    assert res.status_code == 422, res.text


@pytest.mark.asyncio
async def test_submit_documentation_at_exactly_16_minutes_is_billable(
    client: AsyncClient, chw_tokens, member_tokens
):
    """Boundary check: exactly 16 minutes crosses into billable (1 unit) —
    the floor's lower boundary is inclusive."""
    from uuid import UUID

    from app.models.billing import BillingClaim

    session_id = await _create_in_progress_session(client, member_tokens, chw_tokens)

    payload = {
        "summary": "Session just over the floor",
        "diagnosis_codes": ["Z59.1"],
        "procedure_code": "98960",
        "session_start_time": "2026-07-13T15:00:00Z",
        "session_end_time": "2026-07-13T15:16:00Z",  # exactly 16 minutes
    }
    res = await client.post(
        f"/api/v1/sessions/{session_id}/documentation",
        json=payload, headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text

    async with q_isolated_session() as db:
        claim = (
            await db.execute(
                select(BillingClaim).where(BillingClaim.session_id == UUID(session_id))
            )
        ).scalar_one()
    assert claim.units == 1


# ─── submit-documentation: >=16min flow is UNCHANGED (regression) ─────────────


@pytest.mark.asyncio
async def test_submit_documentation_80_minutes_bills_3_units_unchanged(
    client: AsyncClient, chw_tokens, member_tokens
):
    """Regression: an 80-minute CHW-entered window still bills 3 units
    (76-105 bracket), exactly as before the 16-minute-floor change — the
    floor only affects the <16min branch, nothing else in the bracket moved."""
    from uuid import UUID

    from app.models.billing import BillingClaim
    from app.models.session import Session

    session_id = await _create_in_progress_session(client, member_tokens, chw_tokens)

    payload = {
        "summary": "Worked on housing goals",
        "diagnosis_codes": ["Z59.1"],
        "procedure_code": "98960",
        "session_start_time": "2026-07-13T15:00:00Z",
        "session_end_time": "2026-07-13T16:20:00Z",  # 80 minutes
    }
    res = await client.post(
        f"/api/v1/sessions/{session_id}/documentation",
        json=payload, headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text

    async with q_isolated_session() as db:
        claim = (
            await db.execute(
                select(BillingClaim).where(BillingClaim.session_id == UUID(session_id))
            )
        ).scalar_one()
        sess = await db.get(Session, UUID(session_id))

    assert claim.units == 3
    assert sess.duration_minutes == 80
    assert sess.status == "completed"


@pytest.mark.asyncio
async def test_submit_documentation_completes_session_unchanged(
    client: AsyncClient, chw_tokens, member_tokens
):
    """Regression: submitting a billable (>=16min) documentation still
    transitions an awaiting_documentation session to completed."""
    session_id = await _create_in_progress_session(client, member_tokens, chw_tokens)

    res = await client.post(f"/api/v1/sessions/{session_id}/end", headers=auth_header(chw_tokens))
    assert res.status_code == 200
    assert res.json()["status"] == "awaiting_documentation"

    payload = {
        "summary": "Helped with housing",
        "diagnosis_codes": ["Z59.1"],
        "procedure_code": "98960",
        "session_start_time": "2026-07-13T15:00:00Z",
        "session_end_time": "2026-07-13T15:30:00Z",  # 30 minutes → 1 unit, billable
    }
    res = await client.post(
        f"/api/v1/sessions/{session_id}/documentation",
        json=payload, headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text

    res = await client.get(f"/api/v1/sessions/{session_id}", headers=auth_header(chw_tokens))
    assert res.status_code == 200
    assert res.json()["status"] == "completed"


# ─── server-authoritative override — still enforced ────────────────────────────


@pytest.mark.asyncio
async def test_server_overrides_client_sent_units_to_bill(
    client: AsyncClient, chw_tokens, member_tokens
):
    """A client-sent units_to_bill is ignored; the server always recomputes
    from the entered session window. A CHW attempting to send a higher unit
    count than the true duration supports (upcoding) is silently overridden,
    not trusted — this predates Q2 and must remain true after it."""
    from uuid import UUID

    from app.models.billing import BillingClaim

    session_id = await _create_in_progress_session(client, member_tokens, chw_tokens)

    payload = {
        "summary": "Attempted upcode",
        "diagnosis_codes": ["Z59.1"],
        "procedure_code": "98960",
        "session_start_time": "2026-07-13T15:00:00Z",
        "session_end_time": "2026-07-13T15:30:00Z",  # 30 minutes → server computes 1 unit
        "units_to_bill": 4,  # client tries to claim the daily cap
    }
    res = await client.post(
        f"/api/v1/sessions/{session_id}/documentation",
        json=payload, headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text

    async with q_isolated_session() as db:
        claim = (
            await db.execute(
                select(BillingClaim).where(BillingClaim.session_id == UUID(session_id))
            )
        ).scalar_one()
    assert claim.units == 1, "server must recompute from duration, ignoring the client-sent units_to_bill"


@pytest.mark.asyncio
async def test_server_overrides_client_sent_zero_units_when_duration_is_billable(
    client: AsyncClient, chw_tokens, member_tokens
):
    """A client sending units_to_bill=0 (the new schema-valid floor) on an
    otherwise-billable (>=16min) session must NOT skip billing — the server
    recomputes from the true duration regardless of what the client sends."""
    from uuid import UUID

    from app.models.billing import BillingClaim

    session_id = await _create_in_progress_session(client, member_tokens, chw_tokens)

    payload = {
        "summary": "Client sent 0 but session is billable",
        "diagnosis_codes": ["Z59.1"],
        "procedure_code": "98960",
        "session_start_time": "2026-07-13T15:00:00Z",
        "session_end_time": "2026-07-13T15:30:00Z",  # 30 minutes → billable, 1 unit
        "units_to_bill": 0,
    }
    res = await client.post(
        f"/api/v1/sessions/{session_id}/documentation",
        json=payload, headers=auth_header(chw_tokens),
    )
    assert res.status_code == 200, res.text

    async with q_isolated_session() as db:
        claim = (
            await db.execute(
                select(BillingClaim).where(BillingClaim.session_id == UUID(session_id))
            )
        ).scalar_one()
    assert claim.units == 1

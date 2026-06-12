"""Tests for GET /api/v1/admin/billing-export (date-range Pear CSV).

The endpoint streams a Pear-shaped bulk-upload CSV containing every
``BillingClaim`` whose ``created_at`` falls within ``[from, to]`` (UTC
date bounds, inclusive).  Default range is today.

Coverage:

- Auth gating (admin key + 2FA both required)
- Default-to-today behavior when no params given
- Single-day filter returns only that day's claims
- Cross-month-boundary range works
- ``from > to`` returns 400
- Filename header reflects the requested range
- Each row carries the ``[compass-session:<uuid>]`` idempotency marker
- Empty range returns just the Pear header row (no rows)
"""

from __future__ import annotations

import io
import os
import uuid
from datetime import UTC, date, datetime, timedelta

import pyotp
import pytest
from httpx import AsyncClient

from app.models.billing import BillingClaim
from app.models.session import Session, SessionDocumentation
from app.models.user import MemberProfile, User
from app.services.billing_csv_writer import _PEAR_CSV_HEADER
from tests.conftest import test_session as _test_session_factory

ADMIN_KEY = os.environ.get("ADMIN_KEY", "test-admin-key-16-chars-min")


# ── Header / token helpers (mirror test_admin_json_api.py) ───────────────────


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


# ── DB seed helpers (lighter-weight than the JSON-API tests; we only need
#    the rows the CSV writer reads) ─────────────────────────────────────────


async def _seed_claim_at(
    *,
    when_utc: datetime,
    member_email: str,
    member_name: str = "Jane Doe",
    procedure_code: str = "98960",
    diagnosis_codes: list[str] | None = None,
) -> uuid.UUID:
    """Insert one User(member) + MemberProfile + User(chw) + Session +
    SessionDocumentation + BillingClaim, with BillingClaim.created_at
    explicitly set to ``when_utc`` so tests can verify range filtering.
    Returns the session_id (used for the idempotency-marker assertion).
    """
    member_id = uuid.uuid4()
    chw_id = uuid.uuid4()
    request_id = uuid.uuid4()
    session_id = uuid.uuid4()
    claim_id = uuid.uuid4()
    async with _test_session_factory() as db:
        from app.models.request import ServiceRequest

        db.add(User(id=member_id, email=member_email, password_hash="x",
                    role="member", name=member_name))
        db.add(User(id=chw_id, email=f"chw-{chw_id}@example.com",
                    password_hash="x", role="chw", name="CHW Tester"))
        # With no relationship()s configured, SQLAlchemy orders unit-of-work
        # inserts by mapper name, not FK dependency. Flush in dependency tiers
        # so each tier's rows exist before their dependents are inserted.
        await db.flush()
        db.add(MemberProfile(
            id=uuid.uuid4(), user_id=member_id,
            zip_code="90210", primary_language="English",
            medi_cal_id="MEDI-CAL-XYZ",
        ))
        db.add(ServiceRequest(
            id=request_id, member_id=member_id, vertical="health",
            urgency="routine", description="r", preferred_mode="video",
            status="completed", estimated_units=1,
        ))
        db.add(Session(
            id=session_id, request_id=request_id, chw_id=chw_id,
            member_id=member_id, vertical="health",
            status="completed", mode="video", notes="",
        ))
        # Session must exist before SessionDocumentation (session_id FK).
        await db.flush()
        db.add(SessionDocumentation(
            id=uuid.uuid4(), session_id=session_id,
            summary="visit summary",
            diagnosis_codes=(diagnosis_codes or ["Z71.89"]),
        ))
        await db.flush()
        claim = BillingClaim(
            id=claim_id, session_id=session_id, chw_id=chw_id,
            member_id=member_id, diagnosis_codes=(diagnosis_codes or ["Z71.89"]),
            procedure_code=procedure_code, units=1,
            gross_amount="26.66", platform_fee="4.00", net_payout="22.66",
            status="pending", service_date=when_utc.date(),
        )
        db.add(claim)
        await db.commit()
        # Force created_at after insert (server_default=now()) so we can
        # test backdated ranges without sleeping or freezing time.
        from sqlalchemy import update
        await db.execute(
            update(BillingClaim)
            .where(BillingClaim.id == claim_id)
            .values(created_at=when_utc)
        )
        await db.commit()
    return session_id


def _parse_csv(body: bytes) -> tuple[list[str], list[list[str]]]:
    """Parse CSV body into (header, rows). Handles the trailing-space
    headers Pear requires (``Consent `` and ``Phone ``)."""
    import csv as _csv

    reader = _csv.reader(io.StringIO(body.decode("utf-8")))
    rows = list(reader)
    assert rows, "CSV must always include at least the header row"
    return rows[0], rows[1:]


# ── Auth gating ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_no_credentials_returns_401(client: AsyncClient):
    res = await client.get("/api/v1/admin/billing-export")
    assert res.status_code in (401, 403), res.text


@pytest.mark.asyncio
async def test_missing_2fa_returns_401(client: AsyncClient):
    res = await client.get("/api/v1/admin/billing-export", headers=_admin_header())
    assert res.status_code in (401, 403), res.text


@pytest.mark.asyncio
async def test_valid_credentials_empty_db_returns_header_only(client: AsyncClient):
    token = await _setup_and_verify_2fa(client)
    res = await client.get(
        "/api/v1/admin/billing-export", headers=_full_admin_headers(token),
    )
    assert res.status_code == 200, res.text
    assert res.headers["content-type"].startswith("text/csv")
    header, rows = _parse_csv(res.content)
    assert tuple(header) == _PEAR_CSV_HEADER
    assert rows == []


# ── Date-range behavior ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_default_range_is_today_only(client: AsyncClient):
    """No params → only today's claims are returned (yesterday's are excluded)."""
    today = datetime.now(UTC).replace(hour=10, minute=0, second=0, microsecond=0)
    yesterday = today - timedelta(days=1)

    await _seed_claim_at(when_utc=yesterday, member_email="m-yesterday@example.com",
                         member_name="Yester Day")
    await _seed_claim_at(when_utc=today, member_email="m-today@example.com",
                         member_name="To Day")

    token = await _setup_and_verify_2fa(client)
    res = await client.get(
        "/api/v1/admin/billing-export", headers=_full_admin_headers(token),
    )
    assert res.status_code == 200, res.text
    _, rows = _parse_csv(res.content)
    first_names = [r[0] for r in rows]
    assert "To" in first_names
    assert "Yester" not in first_names


@pytest.mark.asyncio
async def test_explicit_single_day_range(client: AsyncClient):
    """?from=YYYY-MM-DD with no `to` → that single day only."""
    target = datetime.now(UTC).replace(hour=12, minute=0, second=0, microsecond=0) - timedelta(days=3)
    other = target - timedelta(days=2)

    await _seed_claim_at(when_utc=target, member_email="m-target@example.com",
                         member_name="Target One")
    await _seed_claim_at(when_utc=other, member_email="m-other@example.com",
                         member_name="Other Person")

    token = await _setup_and_verify_2fa(client)
    res = await client.get(
        f"/api/v1/admin/billing-export?from={target.date().isoformat()}",
        headers=_full_admin_headers(token),
    )
    assert res.status_code == 200, res.text
    _, rows = _parse_csv(res.content)
    names = [r[0] for r in rows]
    assert "Target" in names
    assert "Other" not in names


@pytest.mark.asyncio
async def test_multi_day_range_inclusive_boundaries(client: AsyncClient):
    """Both `from` and `to` are inclusive. Three days, three claims, all returned."""
    base = datetime.now(UTC).replace(hour=8, minute=0, second=0, microsecond=0) - timedelta(days=10)

    await _seed_claim_at(when_utc=base, member_email="m1@example.com", member_name="Day One")
    await _seed_claim_at(when_utc=base + timedelta(days=1), member_email="m2@example.com",
                         member_name="Day Two")
    await _seed_claim_at(when_utc=base + timedelta(days=2), member_email="m3@example.com",
                         member_name="Day Three")
    # Outside the range — must not appear.
    await _seed_claim_at(when_utc=base + timedelta(days=3), member_email="m4@example.com",
                         member_name="Day Four")

    token = await _setup_and_verify_2fa(client)
    start = base.date().isoformat()
    end = (base + timedelta(days=2)).date().isoformat()
    res = await client.get(
        f"/api/v1/admin/billing-export?from={start}&to={end}",
        headers=_full_admin_headers(token),
    )
    assert res.status_code == 200, res.text
    _, rows = _parse_csv(res.content)
    names = [r[0] for r in rows]
    assert names == ["Day", "Day", "Day"]  # three "Day X" rows (first name = "Day")
    # Day Four should be excluded.
    assert len(rows) == 3


@pytest.mark.asyncio
async def test_cross_month_boundary_range(client: AsyncClient):
    """Range that straddles a month boundary picks up both sides."""
    # Anchor near end of a month: use 30 days ago to keep tests timezone-stable.
    a = datetime.now(UTC) - timedelta(days=30)
    b = a + timedelta(days=10)

    await _seed_claim_at(when_utc=a, member_email="ma@example.com", member_name="A Side")
    await _seed_claim_at(when_utc=b, member_email="mb@example.com", member_name="B Side")

    token = await _setup_and_verify_2fa(client)
    res = await client.get(
        f"/api/v1/admin/billing-export?from={a.date().isoformat()}&to={b.date().isoformat()}",
        headers=_full_admin_headers(token),
    )
    assert res.status_code == 200, res.text
    _, rows = _parse_csv(res.content)
    assert len(rows) == 2


@pytest.mark.asyncio
async def test_from_after_to_returns_400(client: AsyncClient):
    token = await _setup_and_verify_2fa(client)
    res = await client.get(
        "/api/v1/admin/billing-export?from=2026-05-22&to=2026-05-20",
        headers=_full_admin_headers(token),
    )
    assert res.status_code == 400, res.text


@pytest.mark.asyncio
async def test_invalid_date_format_returns_422(client: AsyncClient):
    token = await _setup_and_verify_2fa(client)
    res = await client.get(
        "/api/v1/admin/billing-export?from=05-22-2026",
        headers=_full_admin_headers(token),
    )
    assert res.status_code == 422, res.text


# ── Filename + idempotency marker ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_filename_reflects_range(client: AsyncClient):
    """Single-day download → filename uses one date; multi-day → range."""
    token = await _setup_and_verify_2fa(client)

    res_one = await client.get(
        "/api/v1/admin/billing-export?from=2026-05-22",
        headers=_full_admin_headers(token),
    )
    assert 'filename="compass-billing_2026-05-22.csv"' in res_one.headers.get(
        "content-disposition", ""
    )

    res_range = await client.get(
        "/api/v1/admin/billing-export?from=2026-05-20&to=2026-05-22",
        headers=_full_admin_headers(token),
    )
    assert (
        'filename="compass-billing_2026-05-20_to_2026-05-22.csv"'
        in res_range.headers.get("content-disposition", "")
    )


@pytest.mark.asyncio
async def test_row_carries_session_idempotency_marker(client: AsyncClient):
    """Member Notes column must contain ``[compass-session:<uuid>]`` so ops
    can reconcile Pear rows back to Compass sessions on the rare double-upload.
    """
    today = datetime.now(UTC).replace(hour=10, minute=0, second=0, microsecond=0)
    session_id = await _seed_claim_at(
        when_utc=today, member_email="marker-test@example.com",
        member_name="Marker Test",
    )

    token = await _setup_and_verify_2fa(client)
    res = await client.get(
        "/api/v1/admin/billing-export", headers=_full_admin_headers(token),
    )
    assert res.status_code == 200, res.text
    body = res.content.decode("utf-8")
    assert f"[compass-session:{session_id}]" in body

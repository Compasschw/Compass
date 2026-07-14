"""CHW weekly availability: service unit tests + GET/PUT endpoint round-trip."""

from datetime import date

import pytest
from httpx import AsyncClient

from app.services.availability import (
    AvailabilityError,
    generate_day_slots,
    parse_window,
    validate_and_normalize,
    window_for_day,
)
from tests.conftest import auth_header


# ─── Service unit tests ──────────────────────────────────────────────────────


def test_parse_window_hh_mm() -> None:
    start, end = parse_window("09:00-17:30")
    assert (start.hour, start.minute) == (9, 0)
    assert (end.hour, end.minute) == (17, 30)


def test_parse_window_legacy_hour_only() -> None:
    start, end = parse_window("9-17")
    assert (start.hour, end.hour) == (9, 17)


@pytest.mark.parametrize("bad", ["", "09:00", "17:00-09:00", "9-9", "25:00-26:00", "abc"])
def test_parse_window_rejects_bad_values(bad: str) -> None:
    with pytest.raises(AvailabilityError):
        parse_window(bad)


def test_validate_and_normalize() -> None:
    out = validate_and_normalize({"mon": "9-17", "WED": "10:00-14:00", "fri": ""})
    # Legacy normalized, uppercase key lowercased, empty day dropped.
    assert out == {"mon": "09:00-17:00", "wed": "10:00-14:00"}


def test_validate_rejects_bad_weekday() -> None:
    with pytest.raises(AvailabilityError):
        validate_and_normalize({"funday": "09:00-17:00"})


def test_generate_day_slots_30min() -> None:
    slots = generate_day_slots(date(2026, 7, 8), "09:00-11:00")
    labels = [s.strftime("%H:%M") for s in slots]
    # 09:00-11:00 → four 30-min slots (last full slot starts 10:30).
    assert labels == ["09:00", "09:30", "10:00", "10:30"]


def test_window_for_day_maps_weekday() -> None:
    windows = {"wed": "09:00-17:00"}
    assert window_for_day(windows, date(2026, 7, 8)) == "09:00-17:00"  # a Wednesday
    assert window_for_day(windows, date(2026, 7, 9)) is None  # Thursday, unset


# ─── Endpoint round-trip ─────────────────────────────────────────────────────


async def _register_chw(client: AsyncClient) -> dict:
    res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": f"avail-{date.today().isoformat()}-{id(client)}@example.com",
            "password": "Testpass123!",
            "name": "Avail CHW",
            "role": "chw",
        },
    )
    assert res.status_code == 201, res.text
    return res.json()


@pytest.mark.asyncio
async def test_availability_put_get_roundtrip(client: AsyncClient) -> None:
    tokens = await _register_chw(client)
    headers = auth_header(tokens)

    # Empty by default.
    got = await client.get("/api/v1/chw/availability", headers=headers)
    assert got.status_code == 200
    assert got.json()["availability_windows"] == {}

    # Set hours (legacy form normalized on the way in).
    put = await client.put(
        "/api/v1/chw/availability",
        json={"availability_windows": {"mon": "9-17", "wed": "10:00-14:00"}},
        headers=headers,
    )
    assert put.status_code == 200, put.text
    assert put.json()["availability_windows"] == {
        "mon": "09:00-17:00",
        "wed": "10:00-14:00",
    }

    # Read back persists.
    got2 = await client.get("/api/v1/chw/availability", headers=headers)
    assert got2.json()["availability_windows"]["mon"] == "09:00-17:00"


@pytest.mark.asyncio
async def test_availability_put_rejects_bad_window(client: AsyncClient) -> None:
    tokens = await _register_chw(client)
    res = await client.put(
        "/api/v1/chw/availability",
        json={"availability_windows": {"mon": "17:00-09:00"}},
        headers=auth_header(tokens),
    )
    assert res.status_code == 422, res.text


@pytest.mark.asyncio
async def test_availability_requires_chw_role(client: AsyncClient, member_tokens) -> None:
    res = await client.get("/api/v1/chw/availability", headers=auth_header(member_tokens))
    assert res.status_code == 403

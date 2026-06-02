"""Tests for the Pear Member-Import CSV writer.

Mirrors the structure of test_billing_csv_writer.py: format helpers as
pure units, header preserved verbatim (including "Adress 2" typo),
build_row_from_models maps User + MemberProfile correctly, append_row
S3 contract verified with mocks.
"""

from __future__ import annotations

import io
from datetime import UTC, date, datetime
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import UUID, uuid4

import pytest

from app.services.member_csv_writer import (
    _PEAR_MEMBER_CSV_HEADER,
    _fmt_birthdate,
    _fmt_phone,
    _row_to_csv_cells,
    _s3_key_for_month,
    MemberCsvRow,
    build_csv_bytes,
    build_row_from_models,
)


# ─── Format helpers ───────────────────────────────────────────────────────────


def test_fmt_birthdate_uses_leading_zeros_mmddyyyy() -> None:
    """Pear's Member Import samples are '09/20/1991' and '11/07/1985' —
    leading zeros on month + day."""
    assert _fmt_birthdate(date(1991, 9, 20)) == "09/20/1991"
    assert _fmt_birthdate(date(1985, 11, 7)) == "11/07/1985"
    assert _fmt_birthdate(date(2024, 12, 31)) == "12/31/2024"


def test_fmt_birthdate_accepts_iso_string() -> None:
    assert _fmt_birthdate("1993-01-05") == "01/05/1993"


def test_fmt_birthdate_blank_for_missing() -> None:
    assert _fmt_birthdate(None) == ""
    assert _fmt_birthdate("not a date") == ""


def test_fmt_phone_strips_to_10_digits() -> None:
    """Variants of the same number all collapse to 10 digits."""
    assert _fmt_phone("(310) 210-3402") == "3102103402"
    assert _fmt_phone("+1 310-210-3402") == "3102103402"
    assert _fmt_phone("13102103402") == "3102103402"


def test_fmt_phone_blank_for_missing() -> None:
    assert _fmt_phone(None) == ""
    assert _fmt_phone("") == ""


# ─── Header ──────────────────────────────────────────────────────────────────


def test_member_header_has_exactly_12_columns() -> None:
    """Locks the column count to Pear's Member Import template; a
    13- or 11-col change would silently mis-align every row."""
    assert len(_PEAR_MEMBER_CSV_HEADER) == 12


def test_member_header_preserves_adress_2_typo() -> None:
    """Pear's Member Import template ships 'Adress 2' (typo) — preserve
    verbatim. Correcting it to 'Address 2' silently drops the column on
    every uploaded row."""
    assert "Adress 2" in _PEAR_MEMBER_CSV_HEADER
    assert "Address 2" not in _PEAR_MEMBER_CSV_HEADER


def test_member_header_matches_pear_template_order() -> None:
    """Full header sequence locked to Pear's official spec."""
    expected = (
        "First Name", "Last Name", "Phone", "Birthdate", "Sex",
        "Insurance", "CIN", "Address 1", "Adress 2", "City", "State",
        "Zipcode",
    )
    assert _PEAR_MEMBER_CSV_HEADER == expected


# ─── Row builder ─────────────────────────────────────────────────────────────


def _sample_row(**overrides: object) -> MemberCsvRow:
    """Sample row mirroring Pear's Member Import sample row 1 (Adam Tester)."""
    defaults: dict[str, object] = {
        "first_name": "Adam",
        "last_name": "Tester",
        "phone": "1234577890",
        "date_of_birth": date(1991, 9, 20),
        "sex": "Male",
        "insurance_name": "Health Net",
        "primary_cin": "11111111111",
        "address_line_1": "1, Golden Gate Avenue",
        "address_line_2": None,
        "city": "San Francisco",
        "state": "CA",
        "zip_code": "94103-0000",
        "user_id": UUID("12345678-1234-5678-1234-567812345678"),
        "created_at_utc": datetime(2026, 5, 15, 17, 0, 0, tzinfo=UTC),
    }
    defaults.update(overrides)
    return MemberCsvRow(**defaults)  # type: ignore[arg-type]


def test_row_to_csv_cells_matches_pear_sample_row() -> None:
    """Round-trip the row Pear shipped as sample 1 of the Member Import
    template (Adam Tester)."""
    row = _sample_row()
    cells = _row_to_csv_cells(row)

    assert len(cells) == 12
    assert cells[0] == "Adam"
    assert cells[1] == "Tester"
    assert cells[2] == "1234577890"
    assert cells[3] == "09/20/1991"            # MM/DD/YYYY leading zeros
    assert cells[4] == "Male"
    assert cells[5] == "Health Net"
    assert cells[6] == "11111111111"
    assert cells[7] == "1, Golden Gate Avenue"
    assert cells[8] == ""                       # Adress 2 (typo) blank
    assert cells[9] == "San Francisco"
    assert cells[10] == "CA"
    assert cells[11] == "94103-0000"


def test_row_to_csv_cells_blank_for_missing_optional_fields() -> None:
    """Optional fields that are None render as blank cells, not 'None'."""
    row = _sample_row(
        phone=None, date_of_birth=None, sex=None, insurance_name=None,
        primary_cin=None, address_line_1=None, address_line_2=None,
        city=None, state=None, zip_code=None,
    )
    cells = _row_to_csv_cells(row)
    assert len(cells) == 12
    assert "None" not in cells
    # First + Last Name are required; the rest blank.
    for i in range(2, 12):
        assert cells[i] == ""


def test_build_row_from_models_maps_user_and_profile() -> None:
    """Split user.name on first whitespace, pull demographics from profile."""
    user = SimpleNamespace(
        id=uuid4(),
        email="m@example.com",
        name="Jane Q. Doe",  # space-separated → "Jane" + "Q. Doe"
        phone="+13105551234",
        created_at=datetime(2026, 5, 15, 12, 0, 0, tzinfo=UTC),
    )
    profile = SimpleNamespace(
        date_of_birth=date(1990, 3, 15),
        gender="Female",
        medi_cal_id="MEDI12345",
        insurance_company="Health Net",
        address_line1="123 Main St",
        address_line2="Apt 4B",
        city="Los Angeles",
        state="CA",
        zip_code="90001",
    )
    row = build_row_from_models(user=user, member_profile=profile)
    assert row.first_name == "Jane"
    assert row.last_name == "Q. Doe"
    assert row.phone == "+13105551234"
    assert row.date_of_birth == date(1990, 3, 15)
    assert row.sex == "Female"
    assert row.insurance_name == "Health Net"
    assert row.primary_cin == "MEDI12345"
    assert row.address_line_1 == "123 Main St"
    assert row.address_line_2 == "Apt 4B"
    assert row.user_id == user.id
    assert row.created_at_utc == user.created_at


# ─── S3 key bucketing ────────────────────────────────────────────────────────


def test_s3_key_uses_v1_prefix() -> None:
    """Layout segment so a future format change doesn't corrupt existing files."""
    when = datetime(2026, 6, 15, 17, 0, 0, tzinfo=UTC)
    assert _s3_key_for_month(when, environment="prod") == "prod/v1/2026-06.csv"
    assert _s3_key_for_month(when, environment="sandbox") == "sandbox/v1/2026-06.csv"


def test_s3_key_buckets_by_la_local_not_utc() -> None:
    """Sign-up at 5pm PT on May 31 = 00:04 UTC June 1. Bucket must follow
    the LA-local month so members signed up in May land in May.csv."""
    when = datetime(2026, 6, 1, 0, 4, 0, tzinfo=UTC)
    assert _s3_key_for_month(when, environment="prod") == "prod/v1/2026-05.csv"


# ─── append_row with mocked S3 ───────────────────────────────────────────────


@patch("app.services.member_csv_writer.get_s3_client")
@patch("app.services.member_csv_writer.settings")
def test_append_row_initializes_csv_with_header_when_empty(
    mock_settings: MagicMock, mock_s3_factory: MagicMock,
) -> None:
    """First write of a new month creates the file with header + 1 row."""
    mock_settings.member_csv_enabled = True
    mock_settings.s3_bucket_member_csv = "compass-sandbox-member-csv"

    mock_s3 = MagicMock()
    mock_s3_factory.return_value = mock_s3

    class _FakeNoSuchKey(Exception):
        pass
    mock_s3.exceptions.NoSuchKey = _FakeNoSuchKey
    mock_s3.get_object.side_effect = _FakeNoSuchKey()

    from app.services.member_csv_writer import append_row
    append_row(_sample_row(), environment="sandbox")

    assert mock_s3.put_object.call_count == 1
    put_kwargs = mock_s3.put_object.call_args.kwargs
    body = put_kwargs["Body"].decode("utf-8")
    assert put_kwargs["Key"].startswith("sandbox/v1/")
    assert put_kwargs["ServerSideEncryption"] == "AES256"

    rows = list(csv_reader_rows(body))
    assert len(rows) == 2   # header + 1 data row
    assert "Adress 2" in rows[0]
    assert "Adam" in rows[1]
    assert "09/20/1991" in rows[1]


@patch("app.services.member_csv_writer.get_s3_client")
@patch("app.services.member_csv_writer.settings")
def test_append_row_skips_when_flag_disabled(
    mock_settings: MagicMock, mock_s3_factory: MagicMock,
) -> None:
    """Production-by-default safety: with the flag off, no S3 calls fire."""
    mock_settings.member_csv_enabled = False
    mock_settings.s3_bucket_member_csv = "compass-sandbox-member-csv"

    from app.services.member_csv_writer import append_row
    append_row(_sample_row())
    assert mock_s3_factory.call_count == 0


def test_build_csv_bytes_two_rows_matches_pear_sample() -> None:
    """build_csv_bytes is byte-deterministic for ad-hoc exports."""
    r1 = _sample_row()
    r2 = _sample_row(
        first_name="Lauren", phone="1234567890",
        date_of_birth=date(1985, 11, 7), sex="Female",
        primary_cin="123456789", address_line_1=" 845 Folsom",
        address_line_2="4", zip_code="94107",
        user_id=uuid4(),
    )
    body = build_csv_bytes([r1, r2]).decode()
    lines = body.splitlines()
    assert lines[0].startswith("First Name,Last Name,Phone")
    assert "Adam" in lines[1]
    assert "09/20/1991" in lines[1]
    assert "Lauren" in lines[2]
    assert "11/07/1985" in lines[2]


# ─── Helpers ─────────────────────────────────────────────────────────────────


def csv_reader_rows(body: str) -> list[list[str]]:
    import csv as _csv
    return list(_csv.reader(io.StringIO(body)))


# ─── is_export_eligible ──────────────────────────────────────────────────────


def _user(role: str = "member", email: str = "real@example.com") -> SimpleNamespace:
    return SimpleNamespace(role=role, email=email)


def test_export_eligible_real_member() -> None:
    from app.services.member_csv_writer import is_export_eligible
    assert is_export_eligible(_user(role="member", email="akram@gmail.com")) is True
    assert is_export_eligible(_user(role="member", email="jt@joincompasschw.com")) is True


def test_export_eligible_excludes_non_members() -> None:
    from app.services.member_csv_writer import is_export_eligible
    assert is_export_eligible(_user(role="chw", email="chw@example.org")) is False
    assert is_export_eligible(_user(role="admin", email="admin@example.org")) is False


def test_export_eligible_excludes_soft_deleted() -> None:
    """Account-deletion flow rewrites email to @deleted.compasschw.local.
    Uploading PHI residue to Pear would be a compliance issue."""
    from app.services.member_csv_writer import is_export_eligible
    deleted_email = "deleted-abc-123@deleted.compasschw.local"
    assert is_export_eligible(_user(role="member", email=deleted_email)) is False


def test_export_eligible_excludes_example_com() -> None:
    """Smoke-test domain — never billable."""
    from app.services.member_csv_writer import is_export_eligible
    assert is_export_eligible(_user(role="member", email="smoke-test-123@example.com")) is False


def test_export_eligible_excludes_you_sim_prefix() -> None:
    """Dev sim accounts use you+sim- prefix; never billable."""
    from app.services.member_csv_writer import is_export_eligible
    assert is_export_eligible(_user(role="member", email="you+sim-2026-05-05@gmail.com")) is False
    assert is_export_eligible(_user(role="member", email="you+sim-3@gmail.com")) is False


def test_export_eligible_case_insensitive() -> None:
    """Email matching is case-insensitive (DB sometimes stores mixed case)."""
    from app.services.member_csv_writer import is_export_eligible
    assert is_export_eligible(_user(role="member", email="Test@EXAMPLE.com")) is False
    assert is_export_eligible(_user(role="member", email="deleted-x@DELETED.compasschw.local")) is False

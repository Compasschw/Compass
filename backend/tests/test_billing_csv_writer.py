"""Tests for the Pear bulk-upload CSV writer — v2 22-column Member-Activity
template.

Critical correctness paths covered:

- Format quirks: Birthdate M/D/YYYY (no leading zeros), Activity Start/End
  MM/DD/YYYY h:MM AM/PM (leading zero on month+day, none on hour) in LA
  local time, phone 10 digits, Place of Service raw 2-digit code, Service
  column keyed off procedure code, Billable rendered as "Yes"/"No".
- Header preservation: 22 columns including the intentional "Adress 2"
  typo Pear's parser keys on.
- Idempotency: appending the same session_id twice writes only one row.
- Concurrency note: documented in code rather than tested (S3
  read-modify-write race is acknowledged; high-volume callers will need
  S3 If-Match conditional writes).
- Graceful degradation: missing optional fields render as empty strings
  rather than literal "None".
- S3 key versioning: writes now land at ``{env}/v2/<YYYY-MM>.csv`` so
  legacy 17-col files don't get glued onto the new layout.
"""

from __future__ import annotations

import io
from datetime import UTC, date, datetime
from unittest.mock import MagicMock, patch
from uuid import UUID, uuid4

import pytest

from app.services.billing_csv_writer import (
    _PEAR_CSV_HEADER,
    _s3_key_for_month,
    BillingCsvRow,
    _fmt_birthdate,
    _fmt_la_datetime,
    _fmt_phone,
    _fmt_pos,
    _fmt_service_name,
    _fmt_yes_no,
    _row_to_csv_cells,
    _session_id_already_present,
)


# ─── Format helpers (pure unit, no IO) ───────────────────────────────────────


def test_fmt_birthdate_renders_m_d_yyyy_with_no_leading_zeros() -> None:
    """Pear's samples are '9/20/1991' and '11/7/1985' — no leading zeros."""
    assert _fmt_birthdate(date(1991, 9, 20)) == "9/20/1991"
    assert _fmt_birthdate(date(1985, 11, 7)) == "11/7/1985"
    assert _fmt_birthdate(date(2024, 12, 31)) == "12/31/2024"


def test_fmt_birthdate_handles_iso_string_input() -> None:
    """Some callsites pass an ISO string instead of a date object."""
    assert _fmt_birthdate("1993-01-05") == "1/5/1993"


def test_fmt_birthdate_empty_for_none() -> None:
    """Missing DOB renders as blank, not 'None'."""
    assert _fmt_birthdate(None) == ""


def test_fmt_birthdate_empty_for_unparseable_string() -> None:
    """Garbage input is silently dropped rather than raising."""
    assert _fmt_birthdate("not a date") == ""


def test_fmt_la_datetime_converts_utc_to_la_local_with_slashes() -> None:
    """7am UTC on Aug 19 2026 is midnight (12:00 AM) in Los Angeles (PDT)."""
    utc_dt = datetime(2026, 8, 19, 7, 0, 0, tzinfo=UTC)
    assert _fmt_la_datetime(utc_dt) == "08/19/2026 12:00 AM"


def test_fmt_la_datetime_midday_and_pm_no_leading_zero_on_hour() -> None:
    """6:15 PM PDT = 1:15 AM UTC the next day; rendered without hour padding."""
    utc_dt = datetime(2026, 8, 20, 1, 15, 0, tzinfo=UTC)
    assert _fmt_la_datetime(utc_dt) == "08/19/2026 6:15 PM"


def test_fmt_la_datetime_single_digit_hour_has_no_leading_zero() -> None:
    """Matches Pear's sample: '05/21/2025 1:30 PM' (no '01:30 PM')."""
    # 8:30 PM UTC = 1:30 PM PDT
    utc_dt = datetime(2025, 5, 21, 20, 30, 0, tzinfo=UTC)
    assert _fmt_la_datetime(utc_dt) == "05/21/2025 1:30 PM"


def test_fmt_la_datetime_assumes_utc_when_naive() -> None:
    """Legacy rows without tzinfo are treated as UTC rather than crashing."""
    naive = datetime(2026, 8, 19, 7, 0, 0)
    assert _fmt_la_datetime(naive) == "08/19/2026 12:00 AM"


def test_fmt_la_datetime_empty_for_none() -> None:
    assert _fmt_la_datetime(None) == ""


def test_fmt_yes_no_renders_title_case() -> None:
    """Pear's v2 template wants 'Yes'/'No' (title case), not v1's TRUE/FALSE."""
    assert _fmt_yes_no(True) == "Yes"
    assert _fmt_yes_no(False) == "No"


def test_fmt_phone_strips_formatting_keeps_10_digits() -> None:
    """Variations of the same number all collapse to 10 digits."""
    assert _fmt_phone("(310) 210-3402") == "3102103402"
    assert _fmt_phone("310-210-3402") == "3102103402"
    assert _fmt_phone("+1 310-210-3402") == "3102103402"
    assert _fmt_phone("13102103402") == "3102103402"
    assert _fmt_phone("3102103402") == "3102103402"


def test_fmt_phone_empty_for_none_or_blank() -> None:
    assert _fmt_phone(None) == ""
    assert _fmt_phone("") == ""


def test_fmt_pos_renders_raw_two_digit_code() -> None:
    """v2 template wants just the digits — '11', not '11 - Office'."""
    assert _fmt_pos("02") == "02"
    assert _fmt_pos("11") == "11"
    assert _fmt_pos("12") == "12"
    assert _fmt_pos("99") == "99"


def test_fmt_pos_defaults_to_telehealth_when_blank() -> None:
    """Most CHW sessions are remote — blank POS falls back to '02'."""
    assert _fmt_pos(None) == "02"
    assert _fmt_pos("") == "02"


def test_fmt_service_name_maps_98960_to_one_person() -> None:
    """98960 is the CHW-1-person procedure code Compass bills today."""
    assert _fmt_service_name("98960") == "CHW Service 1 Person"


def test_fmt_service_name_maps_group_codes() -> None:
    """98961/98962 are placeholders for future group-session billing."""
    assert _fmt_service_name("98961") == "CHW Service 2-4 Persons"
    assert _fmt_service_name("98962") == "CHW Service 5-8 Persons"


def test_fmt_service_name_unknown_code_falls_back_to_one_person() -> None:
    """Unknown codes still produce a valid Service string rather than blank."""
    assert _fmt_service_name("ZZZZZ") == "CHW Service 1 Person"
    assert _fmt_service_name(None) == "CHW Service 1 Person"
    assert _fmt_service_name("") == "CHW Service 1 Person"


# ─── Header preservation (the trailing-space / typo gotchas) ────────────────


def test_pear_header_has_exactly_22_columns() -> None:
    """Locks the column count to Pear's v2 template; a 21-or-23-col change
    would silently mis-align every row."""
    assert len(_PEAR_CSV_HEADER) == 22


def test_pear_header_preserves_adress_2_typo() -> None:
    """Pear's official template ships 'Adress 2' (typo) — preserve verbatim.
    Their parser keys on the exact header text; correcting it to 'Address 2'
    silently drops the column on every uploaded row."""
    assert "Adress 2" in _PEAR_CSV_HEADER
    assert "Address 2" not in _PEAR_CSV_HEADER


def test_pear_header_matches_pear_template_order() -> None:
    """Full header sequence locked to Pear's official spec."""
    expected = (
        "First Name", "Last Name", "Phone", "Birthdate", "Sex",
        "Insurance", "CIN", "Address 1", "Adress 2", "City", "State",
        "Zipcode", "Procedure Code", "Modifiers", "Diagnosis",
        "Place of Service", "Service", "Activity Start", "Activity End",
        "Responsible User Email", "Billable", "Notes",
    )
    assert _PEAR_CSV_HEADER == expected


# ─── Row builder ────────────────────────────────────────────────────────────


def _example_row(**overrides: object) -> BillingCsvRow:
    """Build a complete row mirroring the example in Pear's v2 template."""
    defaults: dict[str, object] = {
        "first_name": "Adam",
        "last_name": "Tester",
        "phone": "1234567890",
        "date_of_birth": date(1991, 9, 20),
        "sex": "Male",
        "insurance_name": "Health Net",
        "primary_cin": "11111111111",
        "address_line_1": "1, Golden Gate Avenue",
        "address_line_2": None,
        "city": "San Francisco",
        "state": "CA",
        "zip_code": "94103-0000",
        "procedure_code": "98960",
        "modifier": "U2",
        "diagnosis_code": "Z59.9",
        "place_of_service_code": "11",
        # 8:30 PM UTC on 2025-05-21 = 1:30 PM PDT
        "activity_start_utc": datetime(2025, 5, 21, 20, 30, 0, tzinfo=UTC),
        # 9:30 PM UTC on 2025-05-21 = 2:30 PM PDT
        "activity_end_utc": datetime(2025, 5, 21, 21, 30, 0, tzinfo=UTC),
        "responsible_user_email": "chw@example.com",
        "billable": True,
        "member_notes": "Testing member",
        "session_id": UUID("12345678-1234-5678-1234-567812345678"),
    }
    defaults.update(overrides)
    return BillingCsvRow(**defaults)  # type: ignore[arg-type]


def test_row_to_csv_cells_matches_pear_v2_sample_row() -> None:
    """Round-trip the row Pear shipped as sample 1 of the v2 template."""
    row = _example_row()
    cells = _row_to_csv_cells(row)

    assert len(cells) == 22
    assert cells[0] == "Adam"
    assert cells[1] == "Tester"
    assert cells[2] == "1234567890"
    assert cells[3] == "9/20/1991"                  # M/D/YYYY no leading zeros
    assert cells[4] == "Male"
    assert cells[5] == "Health Net"
    assert cells[6] == "11111111111"
    assert cells[7] == "1, Golden Gate Avenue"
    assert cells[8] == ""                            # Adress 2 (typo) blank
    assert cells[9] == "San Francisco"
    assert cells[10] == "CA"
    assert cells[11] == "94103-0000"
    assert cells[12] == "98960"
    assert cells[13] == "U2"
    assert cells[14] == "Z59.9"
    assert cells[15] == "11"                         # POS raw digits
    assert cells[16] == "CHW Service 1 Person"       # Service from proc code
    assert cells[17] == "05/21/2025 1:30 PM"         # MM/DD/YYYY h:MM AM/PM
    assert cells[18] == "05/21/2025 2:30 PM"
    assert cells[19] == "chw@example.com"
    assert cells[20] == "Yes"                        # Billable
    assert cells[21] == "Testing member"             # Notes


def test_row_to_csv_cells_missing_optionals_render_empty_string() -> None:
    """Optional fields that are None must produce blank cells, not 'None'."""
    row = _example_row(
        phone=None,
        primary_cin=None,
        insurance_name=None,
        diagnosis_code=None,
        member_notes=None,
        address_line_1=None,
        address_line_2=None,
        city=None,
        state=None,
        zip_code=None,
        modifier=None,
        responsible_user_email=None,
        date_of_birth=None,
        sex=None,
    )
    cells = _row_to_csv_cells(row)
    # All the now-blank cells must literally be "":
    assert cells[2] == ""    # Phone
    assert cells[3] == ""    # Birthdate
    assert cells[4] == ""    # Sex
    assert cells[5] == ""    # Insurance
    assert cells[6] == ""    # CIN
    assert cells[7] == ""    # Address 1
    assert cells[8] == ""    # Adress 2
    assert cells[9] == ""    # City
    assert cells[10] == ""   # State
    assert cells[11] == ""   # Zipcode
    assert cells[13] == ""   # Modifiers
    assert cells[14] == ""   # Diagnosis
    assert cells[19] == ""   # Responsible User Email
    assert cells[21] == ""   # Notes
    # And nothing renders the literal string "None":
    assert "None" not in cells


# ─── Idempotency ─────────────────────────────────────────────────────────────


def test_session_id_already_present_finds_marker() -> None:
    """The idempotency check matches the marker we embed in member notes."""
    session_id = UUID("11111111-1111-1111-1111-111111111111")
    csv_body = (
        "First Name,Last Name,Phone,...,Billable,Notes\n"
        'Adam,Tester,1234567890,...,Yes,"Earlier note\n'
        '[compass-session:11111111-1111-1111-1111-111111111111]"\n'
    )
    assert _session_id_already_present(csv_body, session_id) is True


def test_session_id_already_present_returns_false_when_marker_absent() -> None:
    session_id = UUID("99999999-9999-9999-9999-999999999999")
    csv_body = (
        "First Name,Last Name,Phone,...,Billable,Notes\n"
        "Adam,Tester,1234567890,...,Yes,Notes only\n"
    )
    assert _session_id_already_present(csv_body, session_id) is False


def test_session_id_already_present_handles_empty_csv() -> None:
    """First write of the month — empty body — must not match anything."""
    assert _session_id_already_present("", UUID("00000000-0000-0000-0000-000000000000")) is False


# ─── S3 key versioning ──────────────────────────────────────────────────────


def test_s3_key_includes_v2_prefix_to_isolate_from_legacy_files() -> None:
    """Layout flip from 17→22 cols would corrupt the v1 files if appended;
    the v2 segment forces a fresh path."""
    now = datetime(2026, 6, 15, 17, 0, 0, tzinfo=UTC)
    assert _s3_key_for_month(now, environment="prod") == "prod/v2/2026-06.csv"
    assert _s3_key_for_month(now, environment="sandbox") == "sandbox/v2/2026-06.csv"


# ─── append_row with mocked S3 ───────────────────────────────────────────────


@patch("app.services.billing_csv_writer.get_s3_client")
@patch("app.services.billing_csv_writer.settings")
def test_append_row_initializes_csv_with_header_when_empty(
    mock_settings: MagicMock, mock_s3_factory: MagicMock,
) -> None:
    """First write of a new month creates the file with header + 1 row."""
    mock_settings.billing_csv_enabled = True
    mock_settings.s3_bucket_billing_csv = "compass-sandbox-billing-csv"

    mock_s3 = MagicMock()
    mock_s3_factory.return_value = mock_s3

    # Simulate NoSuchKey from S3 by raising the exception class our writer
    # catches.
    class _FakeNoSuchKey(Exception):
        pass
    mock_s3.exceptions.NoSuchKey = _FakeNoSuchKey
    mock_s3.get_object.side_effect = _FakeNoSuchKey()

    from app.services.billing_csv_writer import append_row
    append_row(_example_row(), environment="sandbox")

    # put_object should fire exactly once
    assert mock_s3.put_object.call_count == 1
    put_kwargs = mock_s3.put_object.call_args.kwargs
    body = put_kwargs["Body"].decode("utf-8")
    # And the new file lands under the v2/ prefix
    assert put_kwargs["Key"].startswith("sandbox/v2/")

    # Header row + one data row
    lines = body.strip().split("\n")
    assert len(lines) == 2
    # Header matches Pear's v2 spec including the typo
    assert "Adress 2" in lines[0]
    assert "Responsible User Email" in lines[0]
    # Data row has the Pear sample values
    assert "Adam" in lines[1]
    assert "9/20/1991" in lines[1]


@patch("app.services.billing_csv_writer.get_s3_client")
@patch("app.services.billing_csv_writer.settings")
def test_append_row_skips_when_billing_csv_disabled(
    mock_settings: MagicMock, mock_s3_factory: MagicMock,
) -> None:
    """Production-by-default safety: with the flag off, no S3 calls fire."""
    mock_settings.billing_csv_enabled = False
    mock_settings.s3_bucket_billing_csv = "compass-sandbox-billing-csv"

    from app.services.billing_csv_writer import append_row
    append_row(_example_row())

    assert mock_s3_factory.call_count == 0  # never even gets to S3


@patch("app.services.billing_csv_writer.get_s3_client")
@patch("app.services.billing_csv_writer.settings")
def test_append_row_idempotent_on_duplicate_session_id(
    mock_settings: MagicMock, mock_s3_factory: MagicMock,
) -> None:
    """Re-submitting the same session_id is a no-op (no second put_object)."""
    mock_settings.billing_csv_enabled = True
    mock_settings.s3_bucket_billing_csv = "compass-sandbox-billing-csv"

    session_id = UUID("22222222-2222-2222-2222-222222222222")
    existing_body = (
        ",".join(_PEAR_CSV_HEADER) + "\n"
        'Adam,Tester,1234567890,9/20/1991,Male,Health Net,11111111111,'
        '"1, Golden Gate Avenue",,San Francisco,CA,94103-0000,98960,U2,'
        'Z59.9,11,CHW Service 1 Person,05/21/2025 1:30 PM,05/21/2025 2:30 PM,'
        'chw@example.com,Yes,'
        '"Earlier note\n[compass-session:22222222-2222-2222-2222-222222222222]"\n'
    )

    mock_s3 = MagicMock()
    mock_s3_factory.return_value = mock_s3
    mock_s3.get_object.return_value = {
        "Body": io.BytesIO(existing_body.encode("utf-8")),
    }

    from app.services.billing_csv_writer import append_row
    append_row(_example_row(session_id=session_id))

    # put_object must NOT be called — the row already existed
    assert mock_s3.put_object.call_count == 0

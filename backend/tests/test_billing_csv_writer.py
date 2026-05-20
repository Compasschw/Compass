"""Tests for the Pear bulk-upload CSV writer.

Critical correctness paths covered:

- Format quirks: DOB MMDDYYYY, datetime US-localized LA timezone,
  uppercase TRUE/FALSE, phone digits-only, POS "NN - Label" form,
  trailing-space headers preserved verbatim.
- Idempotency: appending the same session_id twice writes only one row.
- Concurrency note: documented in code rather than tested (S3
  read-modify-write race is acknowledged; high-volume callers will need
  S3 If-Match conditional writes).
- Graceful degradation: missing optional fields render as empty strings
  rather than literal "None".
"""

from __future__ import annotations

import io
from datetime import UTC, date, datetime
from unittest.mock import MagicMock, patch
from uuid import UUID, uuid4

import pytest

from app.services.billing_csv_writer import (
    _PEAR_CSV_HEADER,
    BillingCsvRow,
    _fmt_bool,
    _fmt_dob,
    _fmt_la_datetime,
    _fmt_phone,
    _fmt_pos,
    _row_to_csv_cells,
    _session_id_already_present,
)


# ─── Format helpers (pure unit, no IO) ───────────────────────────────────────


def test_fmt_dob_renders_mmddyyyy_with_no_separators() -> None:
    """Pear's parser expects 8-digit dates with no slashes / dashes."""
    assert _fmt_dob(date(1993, 1, 5)) == "01051993"
    assert _fmt_dob(date(2024, 12, 31)) == "12312024"


def test_fmt_dob_handles_iso_string_input() -> None:
    """Some callsites pass an ISO string instead of a date object."""
    assert _fmt_dob("1993-01-05") == "01051993"


def test_fmt_dob_empty_for_none() -> None:
    """Missing DOB renders as blank, not 'None'."""
    assert _fmt_dob(None) == ""


def test_fmt_dob_empty_for_unparseable_string() -> None:
    """Garbage input is silently dropped rather than raising."""
    assert _fmt_dob("not a date") == ""


def test_fmt_la_datetime_converts_utc_to_la_local() -> None:
    """7am UTC on Aug 19 2026 is midnight (12:00 AM) in Los Angeles (PDT, UTC-7)."""
    utc_dt = datetime(2026, 8, 19, 7, 0, 0, tzinfo=UTC)
    assert _fmt_la_datetime(utc_dt) == "08192026 12:00 AM"


def test_fmt_la_datetime_midday_and_pm() -> None:
    """6:15 PM PDT = 1:15 AM UTC the next day."""
    utc_dt = datetime(2026, 8, 20, 1, 15, 0, tzinfo=UTC)
    # PDT is UTC-7 in August
    assert _fmt_la_datetime(utc_dt) == "08192026 06:15 PM"


def test_fmt_la_datetime_assumes_utc_when_naive() -> None:
    """Legacy rows without tzinfo are treated as UTC rather than crashing."""
    naive = datetime(2026, 8, 19, 7, 0, 0)
    assert _fmt_la_datetime(naive) == "08192026 12:00 AM"


def test_fmt_la_datetime_empty_for_none() -> None:
    assert _fmt_la_datetime(None) == ""


def test_fmt_bool_uppercases_python_booleans() -> None:
    """Pear's parser keys on the exact strings TRUE / FALSE."""
    assert _fmt_bool(True) == "TRUE"
    assert _fmt_bool(False) == "FALSE"


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


def test_fmt_pos_renders_nn_label_form() -> None:
    """POS '02' must come out as '02 - Telehealth' not just '02'."""
    assert _fmt_pos("02") == "02 - Telehealth"
    assert _fmt_pos("11") == "11 - Office"
    assert _fmt_pos("12") == "12 - Home"


def test_fmt_pos_unknown_code_falls_back_to_other() -> None:
    """Codes we don't have a label for still produce a valid 'NN - …' string."""
    assert _fmt_pos("99") == "99 - Other Place of Service"
    assert _fmt_pos("77") == "77 - Other"


def test_fmt_pos_defaults_to_telehealth_when_blank() -> None:
    assert _fmt_pos(None) == "02 - Telehealth"
    assert _fmt_pos("") == "02 - Telehealth"


# ─── Header preservation (the trailing-space gotcha) ────────────────────────


def test_pear_header_preserves_trailing_spaces_on_consent_and_phone() -> None:
    """The Consent and Phone columns MUST have trailing spaces in the header.

    Pear's bulk-upload parser keys on the exact header text; stripping
    the trailing space would cause Pear to silently drop the column,
    losing recording consent + the member's phone on every uploaded row.
    """
    assert "Consent " in _PEAR_CSV_HEADER
    assert "Consent" not in _PEAR_CSV_HEADER
    assert "Phone " in _PEAR_CSV_HEADER
    assert "Phone" not in _PEAR_CSV_HEADER


def test_pear_header_has_exactly_17_columns() -> None:
    """Locks the column count to Pear's template; a 16-or-18-col change
    would silently mis-align every row."""
    assert len(_PEAR_CSV_HEADER) == 17


# ─── Row builder ────────────────────────────────────────────────────────────


def _example_row(**overrides: object) -> BillingCsvRow:
    """Build a complete row mirroring the example in Pear's template."""
    defaults: dict[str, object] = {
        "first_name": "Akram",
        "last_name": "Mahmoud",
        "date_of_birth": date(1993, 1, 5),
        "sex": "Male",
        "primary_cin": "12345678A",
        "insurance_name": "Blue Shield of California - Promise Plan",
        "activity_start_utc": datetime(2026, 8, 20, 1, 15, 0, tzinfo=UTC),  # 6:15 PM PDT
        "activity_end_utc": datetime(2026, 8, 20, 1, 45, 0, tzinfo=UTC),    # 6:45 PM PDT
        "billable": True,
        "procedure_code": "98960",
        "place_of_service_code": "11",
        "diagnosis_code": "Z59.00",
        "member_notes": "Testing member",
        "consent_given": True,
        "address": "3615 Veteran Ave Los Angeles, CA 90034",
        "phone": "3102103402",
        "droq1": True,
        "session_id": UUID("12345678-1234-5678-1234-567812345678"),
    }
    defaults.update(overrides)
    return BillingCsvRow(**defaults)  # type: ignore[arg-type]


def test_row_to_csv_cells_matches_pear_example_row() -> None:
    """Round-trip the row Pear shipped as a template example."""
    row = _example_row()
    cells = _row_to_csv_cells(row)

    assert len(cells) == 17
    assert cells[0] == "Akram"
    assert cells[1] == "Mahmoud"
    assert cells[2] == "01051993"               # MMDDYYYY
    assert cells[3] == "Male"
    assert cells[4] == "12345678A"
    assert cells[5] == "08192026 06:15 PM"      # LA local time, US-localized format
    assert cells[6] == "08192026 06:45 PM"
    assert cells[7] == "TRUE"                   # billable
    assert cells[8] == "Blue Shield of California - Promise Plan"
    assert cells[9] == "98960"
    assert cells[10] == "11 - Office"           # NN - Label form
    assert cells[11] == "TRUE"                  # consent
    assert cells[12] == "Testing member"
    assert cells[13] == "Z59.00"
    assert cells[14] == "3615 Veteran Ave Los Angeles, CA 90034"
    assert cells[15] == "3102103402"            # 10 digits, no formatting
    assert cells[16] == "TRUE"                  # DROQ1


def test_row_to_csv_cells_missing_optionals_render_empty_string() -> None:
    """Optional fields that are None must produce blank cells, not 'None'."""
    row = _example_row(
        primary_cin=None,
        insurance_name=None,
        diagnosis_code=None,
        member_notes=None,
        address=None,
        phone=None,
        date_of_birth=None,
        sex=None,
    )
    cells = _row_to_csv_cells(row)
    # All the now-blank cells must literally be "":
    assert cells[2] == ""    # DOB
    assert cells[3] == ""    # Sex
    assert cells[4] == ""    # CIN
    assert cells[8] == ""    # Insurance
    assert cells[12] == ""   # Notes
    assert cells[13] == ""   # Diagnosis
    assert cells[14] == ""   # Address
    assert cells[15] == ""   # Phone
    # And nothing renders the literal string "None":
    assert "None" not in cells


# ─── Idempotency ─────────────────────────────────────────────────────────────


def test_session_id_already_present_finds_marker() -> None:
    """The idempotency check matches the marker we embed in member notes."""
    session_id = UUID("11111111-1111-1111-1111-111111111111")
    csv_body = (
        "First Name,Last Name,Date of Birth,...,DROQ1\n"
        'Akram,Mahmoud,01051993,...,"Notes\n[compass-session:11111111-1111-1111-1111-111111111111]",TRUE\n'
    )
    assert _session_id_already_present(csv_body, session_id) is True


def test_session_id_already_present_returns_false_when_marker_absent() -> None:
    session_id = UUID("99999999-9999-9999-9999-999999999999")
    csv_body = (
        "First Name,Last Name,Date of Birth,...,DROQ1\n"
        "Akram,Mahmoud,01051993,...,Notes only,TRUE\n"
    )
    assert _session_id_already_present(csv_body, session_id) is False


def test_session_id_already_present_handles_empty_csv() -> None:
    """First write of the month — empty body — must not match anything."""
    assert _session_id_already_present("", UUID("00000000-0000-0000-0000-000000000000")) is False


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

    # Simulate NoSuchKey from S3 by raising the exception class our
    # writer catches.
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

    # Header row + one data row
    lines = body.strip().split("\n")
    assert len(lines) == 2
    # Header preserves trailing spaces
    assert "Consent " in lines[0]
    assert "Phone " in lines[0]
    # Data row has the Pear example values
    assert "Akram" in lines[1]
    assert "01051993" in lines[1]


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
        "First Name,Last Name,Date of Birth,Sex,Primary CIN,Activity Start Time,"
        "Activity end time,Billable,Insurance name,Procedure code,"
        "Place of service code,Consent ,Member Notes,Diagnosis Code,Address,Phone ,DROQ1\n"
        'Akram,Mahmoud,01051993,Male,12345678A,08192026 06:15 PM,08192026 06:45 PM,'
        'TRUE,Blue Shield of California - Promise Plan,98960,11 - Office,TRUE,'
        '"Earlier note\n[compass-session:22222222-2222-2222-2222-222222222222]",'
        'Z59.00,"3615 Veteran Ave",3102103402,TRUE\n'
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

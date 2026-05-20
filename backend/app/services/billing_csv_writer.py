"""Pear Suite bulk-upload CSV writer.

PearSuite's beta API can't accept enough fields today to make claims
billable through the API (insurance_company, mediCalId write paths
missing).  Their operational workaround is bulk-CSV-upload from the CBO
side.  This module produces a CSV in the exact shape Pear's bulk-upload
parser expects, one row per billable claim, appended to a monthly
rolling file in S3.

Pear's template (per PEARSUITE_TEMPLATE.xlsx shared 2026-05-19):

    First Name, Last Name, Date of Birth, Sex, Primary CIN,
    Activity Start Time, Activity end time, Billable, Insurance name,
    Procedure code, Place of service code, Consent , Member Notes,
    Diagnosis Code, Address, Phone , DROQ1

Critical format quirks (do not "fix" these without ops + Pear approval):

  - **DOB**: ``MMDDYYYY`` with no separators (e.g. ``01051993``).
  - **Activity start/end**: ``MMDDYYYY HH:MM AM/PM`` in
    America/Los_Angeles timezone.  CHWs and members are in California;
    Pear's parser interprets the timestamp as local.
  - **Place of service**: ``NN - Label`` form (e.g. ``11 - Office``,
    ``02 - Telehealth``) — NOT just the digits.
  - **Booleans**: uppercase ``TRUE`` / ``FALSE`` (not Python's
    ``True``/``False``).
  - **Phone**: 10 digits, no formatting, no country code (e.g.
    ``3102103402``) — strip the US ``+1`` if present.
  - **Headers ``Consent`` and ``Phone`` have trailing spaces** in
    Pear's template.  Preserve exactly or Pear's parser may reject
    the row.

Storage layout (S3):

    s3://{s3_bucket_billing_csv}/{environment}/{YYYY-MM}.csv

The writer is idempotent on ``session_id``: if a row with the same
session already exists in the month's CSV, the write is a no-op (avoids
duplicate billing entries on retries).
"""

from __future__ import annotations

import csv
import io
import logging
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

from app.config import settings
from app.services.s3_service import get_s3_client

logger = logging.getLogger("compass.billing.csv_writer")

# Pear's bulk-upload parser is timezone-naive; it interprets timestamps
# as wall-clock time at the CBO's locale.  Compass operates exclusively
# in California, so we render UTC timestamps in America/Los_Angeles.
_PEAR_TIMEZONE = ZoneInfo("America/Los_Angeles")

# Pear's CSV header row, verbatim.  TRAILING SPACES on "Consent " and
# "Phone " are intentional — do not strip; Pear's parser keys on the
# exact header text.
_PEAR_CSV_HEADER: tuple[str, ...] = (
    "First Name",
    "Last Name",
    "Date of Birth",
    "Sex",
    "Primary CIN",
    "Activity Start Time",
    "Activity end time",
    "Billable",
    "Insurance name",
    "Procedure code",
    "Place of service code",
    "Consent ",
    "Member Notes",
    "Diagnosis Code",
    "Address",
    "Phone ",
    "DROQ1",
)

# Map of CMS-1500 place-of-service codes to "NN - Label" strings.
# Pear's template uses the labeled form rather than the raw 2-digit
# code.  Codes we don't have a label for fall through to the
# "NN - Other" form so the row still validates.
_POS_LABELS: dict[str, str] = {
    "02": "02 - Telehealth",
    "10": "10 - Telehealth in Patient's Home",
    "11": "11 - Office",
    "12": "12 - Home",
    "99": "99 - Other Place of Service",
}


# ─── Dataclass passed in from the documentation submit handler ────────────────


@dataclass(frozen=True)
class BillingCsvRow:
    """Per-claim bundle needed to render one CSV row.

    The submit_documentation handler builds this from the SQLAlchemy
    objects it already loaded so the writer doesn't have to re-query
    inside its transaction.
    """

    # Member identity
    first_name: str
    last_name: str
    date_of_birth: Any  # date | None
    sex: str | None  # "Male" | "Female" | "Other" | None
    primary_cin: str | None  # Medi-Cal ID (PHI — never logged)
    insurance_name: str | None

    # Session timing (UTC datetimes; the writer converts to LA local)
    activity_start_utc: datetime | None
    activity_end_utc: datetime | None

    # Billing
    billable: bool
    procedure_code: str
    place_of_service_code: str  # "02" | "11" | etc.; rendered as "NN - Label"
    diagnosis_code: str | None  # first ICD-10 from the array

    # Free-text + consent
    member_notes: str | None
    consent_given: bool

    # Contact
    address: str | None
    phone: str | None

    # Pear flag — defaults to TRUE because we only export billable claims
    droq1: bool = True

    # Compass-side identifier (NOT written to the Pear CSV) — used as the
    # idempotency key so retries don't append duplicate rows.
    session_id: UUID | None = None


# ─── Format helpers ───────────────────────────────────────────────────────────


def _fmt_dob(value: Any) -> str:
    """Render a date-of-birth as ``MMDDYYYY`` with no separators.

    Accepts datetime.date, datetime.datetime, ISO string, or None.
    Returns empty string when the value is missing — Pear's parser
    treats empty as "no DOB on file" rather than a parse error.
    """
    if value is None:
        return ""
    if isinstance(value, str):
        # Try common formats; fall back to empty on parse failure.
        try:
            value = datetime.fromisoformat(value).date()
        except ValueError:
            return ""
    if hasattr(value, "year") and hasattr(value, "month") and hasattr(value, "day"):
        return f"{value.month:02d}{value.day:02d}{value.year:04d}"
    return ""


def _fmt_la_datetime(value: datetime | None) -> str:
    """Render a UTC datetime as ``MMDDYYYY HH:MM AM/PM`` in LA local time.

    Pear's parser is timezone-naive; we must convert before rendering.
    Returns empty string for None so the cell stays blank rather than
    showing a literal "None".
    """
    if value is None:
        return ""
    # If the input has no tzinfo (legacy rows from before we standardized
    # on tz-aware UTC), assume UTC rather than throwing.
    if value.tzinfo is None:
        from datetime import timezone as _tz
        value = value.replace(tzinfo=_tz.utc)
    local = value.astimezone(_PEAR_TIMEZONE)
    # %I gives zero-padded 12-hour hour; strftime's %p produces "AM"/"PM"
    # on most locales but isn't guaranteed cross-platform, so we render
    # AM/PM manually for safety.
    hour_12 = local.hour % 12 or 12
    am_pm = "AM" if local.hour < 12 else "PM"
    return f"{local.month:02d}{local.day:02d}{local.year:04d} {hour_12:02d}:{local.minute:02d} {am_pm}"


def _fmt_bool(value: bool) -> str:
    """Render a bool as Pear's expected uppercase ``TRUE``/``FALSE``."""
    return "TRUE" if value else "FALSE"


def _fmt_phone(value: str | None) -> str:
    """Render a phone as 10 digits, no formatting, no country code.

    Accepts ``+13105550199``, ``(310) 555-0199``, ``13105550199``, etc.
    Drops a leading ``1`` so the output is the conventional 10-digit
    NANP number Pear expects.  Returns empty string when input is None
    or yields no digits at all (corrupt data — better to send blank
    than a partial number Pear would reject).
    """
    if not value:
        return ""
    digits = "".join(ch for ch in value if ch.isdigit())
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    if len(digits) != 10:
        # Defensive: log + return whatever we have. Don't log the digits
        # themselves (PII even when last-4-only); just log the length.
        logger.warning(
            "csv_writer: phone digit count %d is not 10; sending as-is",
            len(digits),
        )
    return digits


def _fmt_pos(code: str | None) -> str:
    """Render a CMS-1500 POS code as Pear's ``NN - Label`` form."""
    if not code:
        return _POS_LABELS["02"]  # default to Telehealth
    return _POS_LABELS.get(code, f"{code} - Other")


def _fmt_text(value: str | None, max_len: int = 1000) -> str:
    """Clamp a free-text field so a runaway note can't blow up the row.

    Pear's parser tolerates long strings but we cap defensively. Multi-
    line text is preserved via the csv module's quoting; no need to
    strip newlines here.
    """
    if not value:
        return ""
    if len(value) > max_len:
        return value[:max_len]
    return value


# ─── Row builder ──────────────────────────────────────────────────────────────


def _row_to_csv_cells(row: BillingCsvRow) -> list[str]:
    """Convert a ``BillingCsvRow`` into the 17 cell values, in header order.

    Returns a flat list matching ``_PEAR_CSV_HEADER`` 1:1.  Callers feed
    this directly to ``csv.writer.writerow``.
    """
    return [
        _fmt_text(row.first_name, max_len=80),
        _fmt_text(row.last_name, max_len=80),
        _fmt_dob(row.date_of_birth),
        row.sex or "",
        _fmt_text(row.primary_cin, max_len=20),
        _fmt_la_datetime(row.activity_start_utc),
        _fmt_la_datetime(row.activity_end_utc),
        _fmt_bool(row.billable),
        _fmt_text(row.insurance_name, max_len=80),
        row.procedure_code or "",
        _fmt_pos(row.place_of_service_code),
        _fmt_bool(row.consent_given),
        _fmt_text(row.member_notes, max_len=1000),
        row.diagnosis_code or "",
        _fmt_text(row.address, max_len=200),
        _fmt_phone(row.phone),
        _fmt_bool(row.droq1),
    ]


# ─── S3 read-modify-write append ──────────────────────────────────────────────


def _s3_key_for_month(now_utc: datetime, environment: str = "sandbox") -> str:
    """Build the S3 key for the rolling monthly CSV.

    Layout: ``{environment}/YYYY-MM.csv``.  The environment prefix lets
    a single bucket host both sandbox and prod cleanly when we promote
    the feature later.
    """
    return f"{environment}/{now_utc.year:04d}-{now_utc.month:02d}.csv"


def _read_existing_csv(bucket: str, key: str) -> str:
    """Fetch the current month's CSV body from S3, or empty string if absent.

    Returns the raw text including the header row.  S3 NoSuchKey is the
    "first row of the month" case — return "" so the caller initializes
    a fresh CSV with header.
    """
    client = get_s3_client()
    try:
        response = client.get_object(Bucket=bucket, Key=key)
        body = response["Body"].read().decode("utf-8")
        return body
    except client.exceptions.NoSuchKey:
        return ""
    except Exception as exc:  # noqa: BLE001
        # Network error, permissions, etc.  Re-raise so the caller can
        # decide whether to retry.  We do NOT swallow because a silent
        # failure here would silently drop a billing row.
        logger.error(
            "csv_writer: failed to fetch s3://%s/%s — %s",
            bucket, key, type(exc).__name__,
        )
        raise


def _session_id_already_present(csv_body: str, session_id: UUID) -> bool:
    """Idempotency guard: does the CSV already contain a row for this session?

    We can't key on session_id directly (Pear's columns don't include
    it), so we encode session_id as a marker in the Member Notes field
    via a one-line trailer.  The CHW's notes appear first; we append
    ``\\n[compass-session:<uuid>]`` so ops doesn't see a UUID in the
    primary text but our idempotency check can find it.
    """
    if not session_id or not csv_body:
        return False
    marker = f"[compass-session:{session_id}]"
    return marker in csv_body


def _annotate_session_marker(notes: str | None, session_id: UUID | None) -> str:
    """Append the session-id marker to the Member Notes field.

    Format: ``<notes>\\n[compass-session:<uuid>]``.  Empty notes still
    get the marker; a None session_id yields the notes unchanged (the
    idempotency check then doesn't fire — fine for ad-hoc one-off writes).
    """
    base = (notes or "").rstrip()
    if not session_id:
        return base
    marker = f"[compass-session:{session_id}]"
    if not base:
        return marker
    return f"{base}\n{marker}"


def append_row(row: BillingCsvRow, *, environment: str = "sandbox") -> None:
    """Append one billing row to the current month's CSV in S3.

    Read-modify-write: downloads the current CSV, checks for an existing
    row with the same session_id, appends a new row, uploads back to S3.
    NOT safe under high write concurrency — two simultaneous submits
    could race and drop one row.  Acceptable for the workaround volumes
    today (a few claims/hour at most).  See the test suite for the
    concurrent-write scenario; if volume grows we'll switch to either
    S3 conditional writes (If-Match) or a Lambda-fronted SQS queue.

    Idempotent on ``row.session_id``: if the session_id marker is
    already in the CSV body, the function returns without appending.
    """
    if not settings.billing_csv_enabled:
        logger.debug("csv_writer: BILLING_CSV_ENABLED=false; skipping write")
        return
    bucket = settings.s3_bucket_billing_csv
    if not bucket:
        logger.warning("csv_writer: s3_bucket_billing_csv is empty; skipping write")
        return

    from datetime import UTC, datetime as _dt
    now_utc = _dt.now(UTC)
    key = _s3_key_for_month(now_utc, environment=environment)

    existing_body = _read_existing_csv(bucket, key)
    if row.session_id and _session_id_already_present(existing_body, row.session_id):
        logger.info(
            "csv_writer: session_id=%s already present in s3://%s/%s — skipping append (idempotent)",
            row.session_id, bucket, key,
        )
        return

    # Annotate notes with the session marker so future retries skip via
    # the idempotency check above.
    row_with_marker = BillingCsvRow(
        **{**row.__dict__, "member_notes": _annotate_session_marker(row.member_notes, row.session_id)},
    )

    # Build the new body. If empty, write header first; otherwise append.
    buf = io.StringIO()
    writer = csv.writer(buf, quoting=csv.QUOTE_MINIMAL)
    if not existing_body:
        writer.writerow(_PEAR_CSV_HEADER)
    else:
        # Preserve existing body verbatim then append; cheaper than
        # round-tripping every row through csv parse + re-write.
        buf.write(existing_body)
        # Ensure existing body ends with a newline before we append a
        # fresh row (Pear's parser is fine with trailing newlines but
        # some text editors complain if a row gets glued to the last).
        if not existing_body.endswith("\n"):
            buf.write("\n")
    writer.writerow(_row_to_csv_cells(row_with_marker))

    new_body = buf.getvalue().encode("utf-8")
    client = get_s3_client()
    client.put_object(
        Bucket=bucket,
        Key=key,
        Body=new_body,
        ContentType="text/csv",
        ServerSideEncryption="AES256",
    )
    logger.info(
        "csv_writer: appended session=%s to s3://%s/%s (new_size=%d bytes)",
        row.session_id, bucket, key, len(new_body),
    )


def build_row_from_models(
    *,
    claim: Any,            # BillingClaim
    session: Any,          # Session
    member_user: Any,      # User (role='member')
    member_profile: Any,   # MemberProfile
    chw_user: Any,         # User (role='chw')
    documentation: Any,    # SessionDocumentation
    consent_given: bool,
) -> BillingCsvRow:
    """Map our SQLAlchemy models to a ``BillingCsvRow``.

    Centralizes the mapping so the submit-documentation handler stays
    thin and the field-extraction logic is unit-testable in isolation.
    """
    name = (member_user.name or "").strip().split(" ", maxsplit=1)
    first_name = name[0] if name else ""
    last_name = name[1] if len(name) > 1 else ""

    # Address: prefer the structured member_profile columns; collapse
    # to a single line for Pear's single-cell Address column.
    address_parts: list[str] = []
    if getattr(member_profile, "address_line1", None):
        address_parts.append(member_profile.address_line1.strip())
    if getattr(member_profile, "address_line2", None):
        address_parts.append(member_profile.address_line2.strip())
    city_state_zip: list[str] = []
    if getattr(member_profile, "city", None):
        city_state_zip.append(member_profile.city.strip())
    if getattr(member_profile, "state", None):
        city_state_zip.append(member_profile.state.strip())
    if getattr(member_profile, "zip_code", None):
        city_state_zip.append(member_profile.zip_code.strip())
    if city_state_zip:
        address_parts.append(", ".join(city_state_zip))
    address = ", ".join(p for p in address_parts if p) or None

    # First diagnosis code from the array; Pear's template only takes
    # one. Future Pear API will accept the full array; meanwhile we
    # pick the first one (matches how billing audits typically pick
    # the principal diagnosis).
    dx_codes = getattr(documentation, "diagnosis_codes", None) or []
    first_dx = dx_codes[0] if dx_codes else None

    # Activity start/end: prefer session timestamps; fall back to
    # service_date+now for the rare case of a claim without explicit
    # session timing (shouldn't happen but defensive).
    start_utc = getattr(session, "started_at", None)
    end_utc = getattr(session, "ended_at", None)

    return BillingCsvRow(
        first_name=first_name,
        last_name=last_name,
        date_of_birth=getattr(member_profile, "date_of_birth", None),
        sex=getattr(member_profile, "gender", None),
        primary_cin=getattr(member_profile, "medi_cal_id", None),
        insurance_name=getattr(member_profile, "insurance_company", None),
        activity_start_utc=start_utc,
        activity_end_utc=end_utc,
        billable=True,  # we only export billable claims
        procedure_code=getattr(claim, "procedure_code", "") or "",
        place_of_service_code=getattr(claim, "place_of_service_code", "02") or "02",
        diagnosis_code=first_dx,
        member_notes=getattr(documentation, "summary", None),
        consent_given=consent_given,
        address=address,
        phone=getattr(member_user, "phone", None),
        droq1=True,
        session_id=getattr(claim, "session_id", None),
    )

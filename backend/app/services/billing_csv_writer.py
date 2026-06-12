"""Pear Suite bulk-upload CSV writer (22-column Member-Activity template).

PearSuite's beta API can't accept enough fields to make CHW claims billable
through code today, so the operational workaround is bulk-CSV-upload from the
CBO side.  This module produces a CSV in the exact shape Pear's bulk-upload
parser expects, one row per billable claim, appended to a rolling monthly
file in S3.

Layout — Pear's "Member_Activity Import Template - Compass CHW.csv"
(shared 2026-05-26).  22 columns, in order:

    First Name, Last Name, Phone, Birthdate, Sex, Insurance, CIN,
    Address 1, Adress 2, City, State, Zipcode, Procedure Code,
    Modifiers, Diagnosis, Place of Service, Service,
    Activity Start, Activity End, Responsible User Email,
    Billable, Notes

Critical format quirks — verified against Pear's two sample rows.  Do not
"fix" these without ops + Pear approval:

  - **Phone**: 10 digits, no formatting, no country code (strip leading "1").
  - **Birthdate**: ``M/D/YYYY`` (no leading zeros — Pear's samples are
    "9/20/1991" and "11/7/1985").
  - **Sex**: Title-case "Male"/"Female"/"Other".
  - **State**: 2-letter uppercase USPS code.
  - **Place of Service**: raw 2-digit CMS-1500 POS code (e.g. ``"11"``).
    No ``" - Label"`` suffix in this template — that was the v1 layout.
  - **Service**: human-readable activity name keyed on procedure code
    (``98960 → "CHW Service 1 Person"``).
  - **Activity Start/End**: ``MM/DD/YYYY h:MM AM/PM`` in
    America/Los_Angeles wall-clock (leading zero on month and day,
    no leading zero on hour).  Pear's parser is timezone-naive; it
    treats the timestamp as local for the CBO's locale, and Compass
    operates exclusively in California.
  - **Billable**: ``"Yes"``/``"No"`` (replaces the v1 ``TRUE``/``FALSE``).
  - **Adress 2 (sic)**: Pear's header has the typo "Adress 2".  It is
    preserved verbatim — Pear's parser keys on the exact header text.

Storage layout (S3):

    s3://{s3_bucket_billing_csv}/{environment}/v2/{YYYY-MM}.csv

The ``v2/`` prefix was introduced 2026-05-28 when the writer flipped from
the legacy 17-column layout to this 22-column template.  Legacy files at
``{environment}/{YYYY-MM}.csv`` (no v2 segment) remain in the bucket as
read-only archives; ops can regenerate any historical month in the new
format by calling ``GET /api/v1/admin/billing-export?from=&to=``, which
always renders from the DB using whatever layout this module currently
exports.

The writer is idempotent on ``session_id``: if a row with the same
session already exists in the month's CSV, the write is a no-op (avoids
duplicate billing entries on retries).
"""

from __future__ import annotations

import csv
import io
import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

from app.config import settings
from app.services.s3_service import get_s3_client

logger = logging.getLogger("compass.billing.csv_writer")

# Pear's bulk-upload parser is timezone-naive; it interprets timestamps as
# wall-clock time at the CBO's locale.  Compass operates exclusively in
# California, so we render UTC timestamps in America/Los_Angeles.
_PEAR_TIMEZONE = ZoneInfo("America/Los_Angeles")

# Pear's 22-column CSV header row, verbatim.  "Adress 2" is intentionally
# misspelled — Pear's parser keys on the exact header text and the typo is
# present in the template they ship.  Do not "fix" it.
_PEAR_CSV_HEADER: tuple[str, ...] = (
    "First Name",
    "Last Name",
    "Phone",
    "Birthdate",
    "Sex",
    "Insurance",
    "CIN",
    "Address 1",
    "Adress 2",
    "City",
    "State",
    "Zipcode",
    "Procedure Code",
    "Modifiers",
    "Diagnosis",
    "Place of Service",
    "Service",
    "Activity Start",
    "Activity End",
    "Responsible User Email",
    "Billable",
    "Notes",
)

# Procedure code → Service column label (Pear's "what was delivered" string).
# Compass only bills 98960 today; the 2-4 / 5-8 entries are placeholders for
# future group-session billing under 98961/98962.  Unknown codes fall back
# to "CHW Service 1 Person" so the row still validates rather than failing
# Pear's parser on a missing required cell.
_PROCEDURE_SERVICE_NAMES: dict[str, str] = {
    "98960": "CHW Service 1 Person",
    "98961": "CHW Service 2-4 Persons",
    "98962": "CHW Service 5-8 Persons",
}


# ─── Dataclass passed in from the documentation submit handler ────────────────


@dataclass(frozen=True)
class BillingCsvRow:
    """Per-claim bundle needed to render one CSV row.

    The submit_documentation handler builds this from the SQLAlchemy objects
    it already loaded so the writer doesn't have to re-query inside its
    transaction.  Field order roughly follows Pear's column order to make
    the mapping obvious at the call site.
    """

    # Member identity
    first_name: str
    last_name: str
    phone: str | None  # 10 digits expected; helper strips formatting
    date_of_birth: Any  # date | datetime | ISO str | None
    sex: str | None  # "Male" | "Female" | "Other" | None
    insurance_name: str | None
    primary_cin: str | None  # Medi-Cal ID (PHI — never logged)

    # Address — split into 5 cells in the v2 layout.  Pear's old single-cell
    # "Address" column is gone; the new template keeps each piece separate.
    address_line_1: str | None
    address_line_2: str | None
    city: str | None
    state: str | None  # 2-letter USPS code
    zip_code: str | None  # e.g. "94103" or "94103-0000"

    # Billing
    procedure_code: str  # CPT/HCPCS, e.g. "98960"
    modifier: str | None  # Single modifier code, e.g. "U2" for CHW services
    diagnosis_code: str | None  # First ICD-10 from the doc array
    place_of_service_code: str  # CMS-1500 POS, e.g. "11", "02"; rendered as-is

    # Activity (UTC datetimes; the writer converts to LA local)
    activity_start_utc: datetime | None
    activity_end_utc: datetime | None
    responsible_user_email: str | None  # The CHW's email; may be blank
    billable: bool

    # Free-text — also carries the [compass-session:<uuid>] idempotency marker.
    member_notes: str | None

    # Compass-side identifier (NOT written to the Pear CSV directly — it
    # rides along inside the Notes marker) — used as the idempotency key so
    # retries don't append duplicate rows.
    session_id: UUID | None = None


# ─── Format helpers ───────────────────────────────────────────────────────────


def _fmt_birthdate(value: Any) -> str:
    """Render a date-of-birth as ``M/D/YYYY`` with no leading zeros.

    Matches Pear's samples ("9/20/1991", "11/7/1985").  Accepts a
    ``datetime.date``, ``datetime.datetime``, ISO 8601 string, or None.
    Returns an empty string when the value is missing — Pear's parser
    treats empty as "no DOB on file" rather than a parse error.
    """
    if value is None:
        return ""
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value).date()
        except ValueError:
            return ""
    if hasattr(value, "year") and hasattr(value, "month") and hasattr(value, "day"):
        return f"{value.month}/{value.day}/{value.year:04d}"
    return ""


def _fmt_la_datetime(value: datetime | None) -> str:
    """Render a UTC datetime as ``MM/DD/YYYY h:MM AM/PM`` in LA local time.

    Leading zero on month and day (matches Pear's sample "05/21/2025"); no
    leading zero on the 12-hour clock hour ("1:30 PM", not "01:30 PM").
    Returns empty string for None so a missing timestamp renders blank
    rather than as the literal "None".
    """
    if value is None:
        return ""
    # If the input has no tzinfo (legacy rows from before we standardized on
    # tz-aware UTC), assume UTC rather than throwing.
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    local = value.astimezone(_PEAR_TIMEZONE)
    hour_12 = local.hour % 12 or 12
    am_pm = "AM" if local.hour < 12 else "PM"
    return f"{local.month:02d}/{local.day:02d}/{local.year:04d} {hour_12}:{local.minute:02d} {am_pm}"


def _fmt_yes_no(value: bool) -> str:
    """Render a bool as Pear's expected ``Yes`` / ``No`` (title case)."""
    return "Yes" if value else "No"


def _fmt_phone(value: str | None) -> str:
    """Render a phone as 10 digits, no formatting, no country code.

    Accepts ``+13105550199``, ``(310) 555-0199``, ``13105550199``, etc.
    Drops a leading ``1`` so the output is the conventional 10-digit NANP
    number Pear expects.  Returns empty string when input is None or yields
    no digits at all (corrupt data — better to send blank than a partial
    number Pear would reject).
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
    """Render a CMS-1500 POS code as the raw 2-digit form Pear's v2 wants.

    The v1 template wanted ``"NN - Label"`` (e.g. "11 - Office"); the v2
    template wants just the digits (e.g. "11").  Blank defaults to "02"
    (Telehealth) since most CHW sessions are remote.
    """
    if not code:
        return "02"
    return code


def _fmt_service_name(procedure_code: str | None) -> str:
    """Map procedure code → Pear's "Service" column label.

    98960 is the only code Compass bills today.  Group codes 98961/98962
    are pre-mapped for when CHW group sessions ship.  Unknown codes fall
    back to the 1-person string rather than blank, since Pear rejects rows
    with a missing Service value.
    """
    if not procedure_code:
        return "CHW Service 1 Person"
    return _PROCEDURE_SERVICE_NAMES.get(procedure_code, "CHW Service 1 Person")


def _fmt_text(value: str | None, max_len: int = 1000) -> str:
    """Clamp a free-text field so a runaway note can't blow up the row.

    Pear's parser tolerates long strings but we cap defensively.  Multi-
    line text is preserved via the csv module's quoting; no need to strip
    newlines here.
    """
    if not value:
        return ""
    if len(value) > max_len:
        return value[:max_len]
    return value


# ─── Row builder ──────────────────────────────────────────────────────────────


def _row_to_csv_cells(row: BillingCsvRow) -> list[str]:
    """Convert a ``BillingCsvRow`` into the 22 cell values, in header order.

    Returns a flat list matching ``_PEAR_CSV_HEADER`` 1:1.  Callers feed
    this directly to ``csv.writer.writerow``.
    """
    return [
        _fmt_text(row.first_name, max_len=80),        # 1.  First Name
        _fmt_text(row.last_name, max_len=80),         # 2.  Last Name
        _fmt_phone(row.phone),                        # 3.  Phone
        _fmt_birthdate(row.date_of_birth),            # 4.  Birthdate
        row.sex or "",                                # 5.  Sex
        _fmt_text(row.insurance_name, max_len=80),    # 6.  Insurance
        _fmt_text(row.primary_cin, max_len=20),       # 7.  CIN
        _fmt_text(row.address_line_1, max_len=200),   # 8.  Address 1
        _fmt_text(row.address_line_2, max_len=200),   # 9.  Adress 2 (sic)
        _fmt_text(row.city, max_len=80),              # 10. City
        _fmt_text(row.state, max_len=2),              # 11. State
        _fmt_text(row.zip_code, max_len=10),          # 12. Zipcode
        row.procedure_code or "",                     # 13. Procedure Code
        row.modifier or "",                           # 14. Modifiers
        row.diagnosis_code or "",                     # 15. Diagnosis
        _fmt_pos(row.place_of_service_code),          # 16. Place of Service
        _fmt_service_name(row.procedure_code),        # 17. Service
        _fmt_la_datetime(row.activity_start_utc),     # 18. Activity Start
        _fmt_la_datetime(row.activity_end_utc),       # 19. Activity End
        _fmt_text(row.responsible_user_email, max_len=120),  # 20. Responsible User Email
        _fmt_yes_no(row.billable),                    # 21. Billable
        _fmt_text(row.member_notes, max_len=1000),    # 22. Notes
    ]


# ─── S3 read-modify-write append ──────────────────────────────────────────────


def _s3_key_for_month(
    when_utc: datetime, environment: str = "sandbox"
) -> str:
    """Build the S3 key for the rolling monthly CSV.

    Layout: ``{environment}/v2/{YYYY-MM}.csv``.  The ``v2/`` segment
    isolates the new 22-column layout from any legacy 17-column files at
    ``{environment}/{YYYY-MM}.csv``, so a redeploy doesn't try to glue
    new-format rows onto an old-format header (Pear's parser would reject
    the whole file on column-count mismatch).

    Bucket the file by ``when_utc`` converted to **LA local time** — billing
    month for Pear and US-based ops is determined by when the activity
    happened locally, not by UTC. Without the conversion, a session
    submitted at 5pm PT on May 31 lands in ``2026-06.csv`` because UTC has
    already rolled to June 1. Callers should pass the row's
    ``activity_start_utc`` (the "when the call connected" moment) so the
    file groups by service month rather than write moment.
    """
    when_la = when_utc.astimezone(_PEAR_TIMEZONE)
    return f"{environment}/v2/{when_la.year:04d}-{when_la.month:02d}.csv"


def _read_existing_csv(bucket: str, key: str) -> str:
    """Fetch the current month's CSV body from S3, or empty string if absent.

    Returns the raw text including the header row.  S3 NoSuchKey is the
    "first row of the month" case — return "" so the caller initializes a
    fresh CSV with header.
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

    We can't key on session_id directly (Pear's columns don't include it),
    so we encode session_id as a marker in the Notes field via a one-line
    trailer.  The CHW's notes appear first; we append
    ``\\n[compass-session:<uuid>]`` so ops doesn't see a UUID in the
    primary text but our idempotency check can find it.
    """
    if not session_id or not csv_body:
        return False
    marker = f"[compass-session:{session_id}]"
    return marker in csv_body


def _annotate_session_marker(notes: str | None, session_id: UUID | None) -> str:
    """Append the session-id marker to the Notes field.

    Format: ``<notes>\\n[compass-session:<uuid>]``.  Empty notes still get
    the marker; a None session_id yields the notes unchanged (the
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
    NOT safe under high write concurrency — two simultaneous submits could
    race and drop one row.  Acceptable for the workaround volumes today
    (a few claims/hour at most).  See the test suite for the
    concurrent-write scenario; if volume grows we'll switch to either S3
    conditional writes (If-Match) or a Lambda-fronted SQS queue.

    Idempotent on ``row.session_id``: if the session_id marker is already
    in the CSV body, the function returns without appending.
    """
    if not settings.billing_csv_enabled:
        logger.debug("csv_writer: BILLING_CSV_ENABLED=false; skipping write")
        return
    bucket = settings.s3_bucket_billing_csv
    if not bucket:
        logger.warning("csv_writer: s3_bucket_billing_csv is empty; skipping write")
        return

    from datetime import UTC
    from datetime import datetime as _dt
    # Bucket the row by its Activity Start (LA local) — see _s3_key_for_month
    # docstring for why this matters. Fall back to "now" when the row is
    # missing activity_start_utc (rare: in-person visit with no call leg and
    # no doc-submit timestamp), which keeps the writer functional even on
    # degraded data.
    when_for_bucket = row.activity_start_utc or _dt.now(UTC)
    key = _s3_key_for_month(when_for_bucket, environment=environment)

    existing_body = _read_existing_csv(bucket, key)
    if row.session_id and _session_id_already_present(existing_body, row.session_id):
        logger.info(
            "csv_writer: session_id=%s already present in s3://%s/%s — skipping append (idempotent)",
            row.session_id, bucket, key,
        )
        return

    # Annotate notes with the session marker so future retries skip via the
    # idempotency check above.
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
        # Ensure existing body ends with a newline before we append a fresh
        # row (Pear's parser is fine with trailing newlines but some text
        # editors complain if a row gets glued to the last).
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


def build_csv_bytes(rows: list[BillingCsvRow]) -> bytes:
    """Render a Pear-shaped CSV (header + rows) for the date-range export.

    Unlike ``append_row``, this does not touch S3 — it produces the CSV
    bytes in-memory so the admin endpoint can stream them directly in the
    HTTP response.  Each row is annotated with the session-id marker so
    ops downloading a date-range slice can still correlate Pear rows back
    to Compass sessions.
    """
    buf = io.StringIO()
    writer = csv.writer(buf, quoting=csv.QUOTE_MINIMAL)
    writer.writerow(_PEAR_CSV_HEADER)
    for row in rows:
        annotated = BillingCsvRow(
            **{
                **row.__dict__,
                "member_notes": _annotate_session_marker(
                    row.member_notes, row.session_id
                ),
            },
        )
        writer.writerow(_row_to_csv_cells(annotated))
    return buf.getvalue().encode("utf-8")


def build_row_from_models(
    *,
    claim: Any,                       # BillingClaim
    session: Any,                     # Session
    member_user: Any,                 # User (role='member')
    member_profile: Any,              # MemberProfile
    chw_user: Any,                    # User (role='chw')
    documentation: Any,               # SessionDocumentation
    consent_given: bool,              # Kept for caller compat; not emitted in v2
    communication_session: Any = None,  # CommunicationSession (most recent)
) -> BillingCsvRow:
    """Map our SQLAlchemy models to a ``BillingCsvRow``.

    Centralizes the mapping so the submit-documentation handler stays thin
    and the field-extraction logic is unit-testable in isolation.

    ``consent_given`` is accepted for backward compatibility with existing
    callers but the v2 template no longer surfaces consent in the CSV —
    consent remains tracked in the DB and on Pear's per-member record.

    ``communication_session`` (the most recent CommunicationSession for
    this Session) provides the actual call timing.  Activity Start Time is
    the call's started_at (when the bridged call connected); Activity End
    Time is the documentation's submitted_at (the moment the CHW clicked
    Submit on the DocumentationModal) — that's when the billable activity
    is considered closed for Pear's purposes.  Both fall back to
    Session.started_at / Session.ended_at when no CommunicationSession
    exists (in-person sessions with no call leg).
    """
    del consent_given  # v2 layout drops the Consent column; kept in signature.

    name = (member_user.name or "").strip().split(" ", maxsplit=1)
    first_name = name[0] if name else ""
    last_name = name[1] if len(name) > 1 else ""

    # First diagnosis code from the array; Pear's template only takes one.
    # Future Pear API will accept the full array; meanwhile we pick the
    # first one (matches how billing audits typically pick the principal
    # diagnosis).
    dx_codes = getattr(documentation, "diagnosis_codes", None) or []
    first_dx = dx_codes[0] if dx_codes else None

    # Activity start = when the bridged call connected (the actual billable
    # encounter), pulled from the most recent CommunicationSession.
    # Activity end = when the CHW submitted the documentation (the moment
    # the claim is considered closed for billing purposes).  When no
    # CommunicationSession exists (in-person session, no call leg), fall
    # back to Session.started_at / Session.ended_at so the row still
    # renders something.
    if communication_session is not None:
        # CommunicationSession.created_at = when the call was initiated by
        # the backend (closest available timestamp to "call begins").
        start_utc = getattr(communication_session, "created_at", None)
    else:
        start_utc = getattr(session, "started_at", None)

    # SessionDocumentation uses ``submitted_at`` (not created_at) as the
    # canonical doc-submission timestamp.  Fall back to session.ended_at
    # for the rare case where documentation is somehow absent.
    end_utc = getattr(documentation, "submitted_at", None) or getattr(
        session, "ended_at", None
    )

    return BillingCsvRow(
        first_name=first_name,
        last_name=last_name,
        phone=getattr(member_user, "phone", None),
        date_of_birth=getattr(member_profile, "date_of_birth", None),
        sex=getattr(member_profile, "gender", None),
        insurance_name=getattr(member_profile, "insurance_company", None),
        primary_cin=getattr(member_profile, "medi_cal_id", None),
        address_line_1=getattr(member_profile, "address_line1", None),
        address_line_2=getattr(member_profile, "address_line2", None),
        city=getattr(member_profile, "city", None),
        state=getattr(member_profile, "state", None),
        zip_code=getattr(member_profile, "zip_code", None),
        procedure_code=getattr(claim, "procedure_code", "") or "",
        modifier=getattr(claim, "modifier", None),
        diagnosis_code=first_dx,
        place_of_service_code=getattr(claim, "place_of_service_code", "02") or "02",
        activity_start_utc=start_utc,
        activity_end_utc=end_utc,
        responsible_user_email=getattr(chw_user, "email", None),
        billable=True,  # we only export billable claims
        member_notes=getattr(documentation, "summary", None),
        session_id=getattr(claim, "session_id", None),
    )

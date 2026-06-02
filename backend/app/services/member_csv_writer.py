"""Pear Suite bulk-upload CSV writer for the Member Import template.

PearSuite's beta API doesn't expose a write path for member demographics
that Pear's billing pipeline depends on (insurance, CIN, etc.), so the
ops-side workaround is bulk-CSV-upload from the CBO portal.  This module
produces a CSV in the exact shape Pear's Member Import parser expects,
one row per Compass member, appended to a rolling monthly file in S3.

Layout — Pear's "Member Import Template - Compass CHW.xlsx" (shared
2026-05-31).  12 columns, in order:

    First Name, Last Name, Phone, Birthdate, Sex, Insurance, CIN,
    Address 1, Adress 2, City, State, Zipcode

Critical format quirks — verified against Pear's two sample rows.  Do
not "fix" these without ops + Pear approval:

  - **Phone**: 10 digits, no formatting, no country code (strip leading
    "1").  Pear's parser rejects rows with non-numeric phone values.
  - **Birthdate**: ``MM/DD/YYYY`` with leading zeros — Pear's samples
    are "09/20/1991" and "11/07/1985".
  - **Sex**: Title-case "Male"/"Female"/"Other".  Case-sensitive.
  - **State**: 2-letter uppercase USPS code.
  - **Insurance**: must match an entry in Pear's "Subcontractor
    Insurances" tab (Health Net, CalViva Health, Community Health Plan
    of Imperial Valley, Molina Healthcare California, Contra Costa
    Health Plan, plus the carriers in app.services.billing.pear_cost_ids).
  - **Adress 2 (sic)**: Pear's header has the typo "Adress 2".  It is
    preserved verbatim — Pear's parser keys on the exact header text.

Storage layout (S3):

    s3://{s3_bucket_member_csv}/{environment}/v1/{YYYY-MM}.csv

The ``v1/`` segment exists so we can flip the layout later without
breaking existing files (mirrors the ``v2/`` pattern used by
billing_csv_writer.py).  The month is the LA-local month of the
member's ``created_at`` — Pear treats billing months in CBO local time,
and US-based ops think the same way.

Idempotency is enforced at the caller layer via
``MemberProfile.member_csv_exported_at``: the auth/register hook only
appends a row when the column is ``NULL``, and stamps it ``NOW()`` after
a successful S3 write.  The writer itself does NOT dedup, so callers
MUST gate on the column or they'll produce duplicate rows.  This is
different from billing_csv_writer.py — the Member template has no
"Notes" column to embed a session-id marker in.
"""

from __future__ import annotations

import csv
import io
import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

from app.config import settings
from app.services.s3_service import get_s3_client

logger = logging.getLogger("compass.member.csv_writer")

# Pear's bulk-upload parser is timezone-naive; it interprets timestamps as
# wall-clock time at the CBO's locale.  Compass operates exclusively in
# California, so we render UTC timestamps in America/Los_Angeles.
_PEAR_TIMEZONE = ZoneInfo("America/Los_Angeles")

# Pear's 12-column Member Import header, verbatim.  "Adress 2" is
# intentionally misspelled — Pear's parser keys on the exact header text
# and the typo is present in the template they ship.  Do not "fix" it.
_PEAR_MEMBER_CSV_HEADER: tuple[str, ...] = (
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
)


@dataclass(frozen=True)
class MemberCsvRow:
    """Per-member bundle needed to render one CSV row.

    Caller builds this from the SQLAlchemy ``User`` + ``MemberProfile``
    objects (see ``build_row_from_models``).  ``user_id`` and
    ``created_at_utc`` are NOT written to the CSV — they're used by
    ``append_row`` for the S3 monthly-key calculation and by callers
    for the idempotency stamp on ``MemberProfile.member_csv_exported_at``.
    """

    # 12 Pear columns
    first_name: str
    last_name: str
    phone: str | None
    date_of_birth: Any  # date | datetime | ISO str | None
    sex: str | None  # "Male" | "Female" | "Other" | None
    insurance_name: str | None
    primary_cin: str | None  # Medi-Cal ID (PHI — never logged)
    address_line_1: str | None
    address_line_2: str | None
    city: str | None
    state: str | None  # 2-letter USPS code
    zip_code: str | None  # e.g. "94103" or "94103-0000"

    # Not written to CSV — used for S3 path + idempotency.
    user_id: UUID | None = None
    created_at_utc: datetime | None = None


# ─── Format helpers ───────────────────────────────────────────────────────────


def _fmt_birthdate(value: Any) -> str:
    """Render a date-of-birth as ``MM/DD/YYYY`` with leading zeros.

    Matches Pear's Member Import samples ("09/20/1991", "11/07/1985").
    Accepts a ``datetime.date``, ``datetime.datetime``, ISO 8601 string,
    or None.  Returns an empty string when the value is missing — Pear's
    parser will reject the row at upload time (Birthdate is required for
    Member Imports), but the writer doesn't enforce that; the auth-side
    Pydantic schema does, so by the time a row reaches here a missing
    DOB indicates a legacy row that was created before the requirement
    was added.
    """
    if value is None:
        return ""
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value).date()
        except ValueError:
            return ""
    if hasattr(value, "year") and hasattr(value, "month") and hasattr(value, "day"):
        return f"{value.month:02d}/{value.day:02d}/{value.year:04d}"
    return ""


def _fmt_phone(value: str | None) -> str:
    """Render a phone as 10 digits, no formatting, no country code.

    Mirrors billing_csv_writer._fmt_phone.  Accepts ``+13105550199``,
    ``(310) 555-0199``, ``13105550199``, etc.  Drops a leading ``1`` so
    the output is the conventional 10-digit NANP number Pear expects.
    """
    if not value:
        return ""
    digits = "".join(ch for ch in value if ch.isdigit())
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    if len(digits) != 10:
        logger.warning(
            "member_csv_writer: phone digit count %d is not 10; sending as-is",
            len(digits),
        )
    return digits


def _fmt_text(value: str | None, max_len: int = 200) -> str:
    """Clamp a free-text field so a runaway value can't blow up the row.

    Pear's parser tolerates long strings up to ~1000 chars; we cap
    defensively per-field.  Empty / None renders blank.
    """
    if not value:
        return ""
    if len(value) > max_len:
        return value[:max_len]
    return value


# ─── Row builder ──────────────────────────────────────────────────────────────


def _row_to_csv_cells(row: MemberCsvRow) -> list[str]:
    """Convert a ``MemberCsvRow`` into the 12 cell values, in header order."""
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
    ]


# ─── S3 read-modify-write append ──────────────────────────────────────────────


def _s3_key_for_month(when_utc: datetime, environment: str = "sandbox") -> str:
    """Build the S3 key for the rolling monthly Member Import CSV.

    Bucket by ``when_utc`` converted to LA local time — Pear treats the
    billing month in CBO local time, and US-based ops think the same
    way.  Use ``user.created_at`` for ``when_utc`` so the file groups
    members by the month they actually signed up rather than by the
    moment ops triggered the export.

    Layout: ``{environment}/v1/{YYYY-MM}.csv``.  The ``v1/`` segment is
    in place so we can flip the layout later without losing the
    existing files.
    """
    when_la = when_utc.astimezone(_PEAR_TIMEZONE)
    return f"{environment}/v1/{when_la.year:04d}-{when_la.month:02d}.csv"


def _read_existing_csv(bucket: str, key: str) -> str:
    """Fetch the current month's CSV body from S3, or empty string if absent.

    Returns the raw text including the header row.  S3 NoSuchKey is the
    "first row of the month" case — return "" so the caller initializes
    a fresh CSV with header.
    """
    client = get_s3_client()
    try:
        response = client.get_object(Bucket=bucket, Key=key)
        return response["Body"].read().decode("utf-8")
    except client.exceptions.NoSuchKey:
        return ""
    except Exception as exc:  # noqa: BLE001
        # Network error, permissions, etc.  Re-raise so the caller can
        # decide whether to retry.  We do NOT swallow because a silent
        # failure here would silently drop a member row.
        logger.error(
            "member_csv_writer: failed to fetch s3://%s/%s — %s",
            bucket, key, type(exc).__name__,
        )
        raise


def append_row(row: MemberCsvRow, *, environment: str = "sandbox") -> None:
    """Append one member row to the LA-local month's CSV in S3.

    Read-modify-write: downloads the current CSV, appends the row,
    uploads back to S3.  NOT safe under high write concurrency — two
    simultaneous registrations could race and drop one row.  Acceptable
    for the workaround volumes today (a few signups/day at most).  If
    volume grows we'll switch to S3 conditional writes (If-Match) or a
    Lambda-fronted SQS queue.

    **No internal dedup** — the Member template has no notes column to
    embed an idempotency marker in.  Callers MUST gate on
    ``MemberProfile.member_csv_exported_at`` (set to NOW after a
    successful append) so retries don't produce duplicate rows.
    """
    if not getattr(settings, "member_csv_enabled", False):
        logger.debug("member_csv_writer: MEMBER_CSV_ENABLED=false; skipping write")
        return
    bucket = getattr(settings, "s3_bucket_member_csv", "") or ""
    if not bucket:
        logger.warning("member_csv_writer: s3_bucket_member_csv is empty; skipping write")
        return

    from datetime import UTC, datetime as _dt
    when_for_bucket = row.created_at_utc or _dt.now(UTC)
    key = _s3_key_for_month(when_for_bucket, environment=environment)

    existing_body = _read_existing_csv(bucket, key)

    # Build the new body. If empty, write header first; otherwise append.
    buf = io.StringIO()
    writer = csv.writer(buf, quoting=csv.QUOTE_MINIMAL)
    if not existing_body:
        writer.writerow(_PEAR_MEMBER_CSV_HEADER)
    else:
        # Preserve existing body verbatim then append; cheaper than
        # round-tripping every row through csv parse + re-write.
        buf.write(existing_body)
        if not existing_body.endswith("\n"):
            buf.write("\n")
    writer.writerow(_row_to_csv_cells(row))

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
        "member_csv_writer: appended user=%s to s3://%s/%s (new_size=%d bytes)",
        row.user_id, bucket, key, len(new_body),
    )


def build_csv_bytes(rows: list[MemberCsvRow]) -> bytes:
    """Render a Pear-shaped member CSV (header + rows) in-memory.

    Used by ad-hoc export endpoints (e.g. an admin "regenerate this
    month" tool) that produce a CSV without round-tripping through S3.
    """
    buf = io.StringIO()
    writer = csv.writer(buf, quoting=csv.QUOTE_MINIMAL)
    writer.writerow(_PEAR_MEMBER_CSV_HEADER)
    for row in rows:
        writer.writerow(_row_to_csv_cells(row))
    return buf.getvalue().encode("utf-8")


def is_export_eligible(user: Any) -> bool:
    """Return True iff this user should be included in the Pear member CSV.

    Excludes:
      - Non-members (role != "member") — only members go to Pear's Member Import.
      - Soft-deleted accounts (email ends with @deleted.compasschw.local).
        The account-deletion flow nulls the name + rewrites the email to that
        sentinel; uploading the PHI residue to Pear would be a privacy +
        compliance issue.
      - Smoke-test + synthetic accounts (@example.com, you+sim- prefix).
        Standard patterns used by load tests and dev sims; never billable.

    Centralized here so the live auth-hook AND the backfill script apply
    the same eligibility rule. Both call this before
    ``build_row_from_models`` / ``append_row``.
    """
    if getattr(user, "role", None) != "member":
        return False
    email = (getattr(user, "email", "") or "").lower()
    if email.endswith("@deleted.compasschw.local"):
        return False
    if email.endswith("@example.com"):
        return False
    if email.startswith("you+sim-"):
        return False
    return True


def build_row_from_models(*, user: Any, member_profile: Any) -> MemberCsvRow:
    """Map ``User`` + ``MemberProfile`` SQLAlchemy rows to a ``MemberCsvRow``.

    Splits ``user.name`` on the first whitespace to separate first/last
    (post-#191 the signup validator enforces both, so the split is
    deterministic for new members; legacy single-token names render
    with an empty Last Name and Pear will reject the row at upload —
    use ``scripts/audit_member_names.py`` to find them ahead of time).
    """
    name_parts = (user.name or "").strip().split(" ", maxsplit=1)
    first_name = name_parts[0] if name_parts else ""
    last_name = name_parts[1] if len(name_parts) > 1 else ""

    return MemberCsvRow(
        first_name=first_name,
        last_name=last_name,
        phone=getattr(user, "phone", None),
        date_of_birth=getattr(member_profile, "date_of_birth", None),
        sex=getattr(member_profile, "gender", None),
        insurance_name=getattr(member_profile, "insurance_company", None),
        primary_cin=getattr(member_profile, "medi_cal_id", None),
        address_line_1=getattr(member_profile, "address_line1", None),
        address_line_2=getattr(member_profile, "address_line2", None),
        city=getattr(member_profile, "city", None),
        state=getattr(member_profile, "state", None),
        zip_code=getattr(member_profile, "zip_code", None),
        user_id=getattr(user, "id", None),
        created_at_utc=getattr(user, "created_at", None),
    )

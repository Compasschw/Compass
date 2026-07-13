from datetime import date
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy import extract, func, select
from sqlalchemy.ext.asyncio import AsyncSession

MEDI_CAL_RATE = Decimal("26.66")
PLATFORM_FEE_RATE = Decimal("0.15")
# Member rewards pool — funds the redemption catalog members can spend their
# engagement points against. Was previously labelled `PEAR_SUITE_FEE_RATE` at
# 0.10 (a billing-partner fee); per Jemal's Earnings Figma feedback the split
# is now 15% platform / 25% member rewards / 60% CHW net. The DB column on
# BillingClaim is still named `pear_suite_fee` to avoid a migration — treat
# it as the rewards-pool field semantically. Rename the column when we next
# touch the billing schema.
PEAR_SUITE_FEE_RATE = Decimal("0.25")
MAX_UNITS_PER_DAY = 4
MAX_UNITS_PER_YEAR = 10

# Allowed ICD-10-CM (SDOH Z-code) diagnoses for CHW service claims.
#
# MUST be a superset of the codes the CHW can actually pick in the app —
# `native/src/data/mock.ts` `diagnosisCodes`. The two lists had drifted to almost
# no overlap, so nearly every real pick (e.g. Z59.12 "Utility Insecurity",
# Z72.3 "Lack of physical exercise") was rejected at documentation submit with a
# 422 "Invalid ICD-10 code". If you add a code to the frontend picker, add it
# here too (see tests/test_billing_service.py::test_frontend_picker_codes_all_valid,
# which guards the sync). Ideally this list is served from one source later.
VALID_ICD10_CODES = [
    # ── Frontend picker catalog (native/src/data/mock.ts `diagnosisCodes`) ──
    # Updated 2026-07-12 to the founder-provided SDOH Z-code set.
    "Z59.10",  # Inadequate housing, unspecified
    "Z59.4",   # Lack of adequate food and safe drinking water
    "Z59.6",   # Low income / lack of financial resources
    "Z59.71",  # Insufficient health insurance coverage
    "Z59.72",  # Insufficient welfare support
    "Z55.6",   # Problems related to health literacy
    "Z55.9",   # Problems related to education and literacy
    "Z56.9",   # Problems related to employment, unspecified
    "Z59.00",  # Homelessness, unspecified
    "Z59.01",  # Sheltered homelessness
    "Z59.89",  # Other problems related to housing and economic circumstances
    "Z59.9",   # Problem related to housing/economic circumstances, unspecified
    "Z65.3",   # Problems related to other legal circumstances
    "Z71.89",  # Other specified counseling  (also the default)
    "Z72.3",   # Lack of physical exercise
    "Z59.82",  # Transportation insecurity
    "Z59.861", # Financial insecurity, difficulty paying for utilities
    "Z59.868", # Other specified financial insecurity
    "Z59.869", # Financial insecurity, unspecified
    "Z59.87",  # Material hardship, unable to obtain adequate childcare
    "Z74.8",   # Other problems related to care provider dependency
    "Z75.3",   # Unavailability/inaccessibility of health-care facilities
    # ── Legacy / prior-picker codes (kept valid for existing claims, demo,
    #    tests, and any historical documentation already filed) ──
    "Z59.12", "Z59.86",
    "Z59.1", "Z59.7", "Z63.0", "Z60.2",
    "Z72.89", "Z71.1", "Z76.89", "Z13.89",
]
VALID_CPT_CODES = ["98960", "98961", "98962"]


def calculate_units(duration_minutes: int | None) -> int:
    """Return the number of billable Medi-Cal units for a given session duration.

    Per the founder-set 16-minute-floor bracket (2026-07-13, supersedes the
    2026-05-07 bracket): sessions under 16 minutes are NOT billable at all
    (0 units — no claim may be filed), then units step up every 30 minutes,
    capped at 4 (the daily Medi-Cal cap):

      - < 16 min   → 0 units  (NOT billable — no claim)
      - 16–45 min  → 1 unit
      - 46–75 min  → 2 units
      - 76–105 min → 3 units
      - ≥ 106 min  → 4 units  (capped at MAX_UNITS_PER_DAY)

    A missing duration (None — should not happen for a documented session, but
    defends against bad data) returns 0, matching the "not billable" branch:
    an unknown duration must never be assumed billable. A negative duration
    (bad clock data) is likewise treated as 0/not-billable rather than
    silently floored to 1 unit — see ``test_negative_duration_returns_zero``.

    ``validate_claim`` rejects a computed 0-unit count (``units < 1``) before
    any ``BillingClaim`` row is created, so the anti-upcoding /
    anti-under-16-minute-billing guarantee is enforced at the single call
    site in ``routers.sessions.submit_documentation`` without any router
    changes: a <16min submission always 422s there.
    """
    if duration_minutes is None or duration_minutes < 16:
        return 0
    if duration_minutes <= 45:
        return 1
    if duration_minutes <= 75:
        return 2
    if duration_minutes <= 105:
        return 3
    return MAX_UNITS_PER_DAY


def validate_claim(diagnosis_codes: list[str], procedure_code: str, units: int) -> list[str]:
    """Validate a claim's codes and computed units before persisting it.

    ``units == 0`` is the 16-minute-floor "not billable" outcome from
    ``calculate_units`` — reject with a purpose-specific message (distinct
    from the generic out-of-range message) so the 422 the CHW sees at
    ``routers.sessions.submit_documentation`` clearly explains *why*: the
    session was too short to bill, not that they picked an invalid number.
    This is the sole enforcement point that a <16-minute session can never
    result in a ``BillingClaim`` row — no router change needed.
    """
    errors = []
    for code in diagnosis_codes:
        if code not in VALID_ICD10_CODES:
            errors.append(f"Invalid ICD-10 code: {code}")
    if procedure_code not in VALID_CPT_CODES:
        errors.append(f"Invalid CPT code: {procedure_code}")
    if units == 0:
        errors.append(
            "Session is under 16 minutes and is not billable under Medi-Cal "
            "rules — no claim can be filed for this duration."
        )
    elif units < 1 or units > MAX_UNITS_PER_DAY:
        errors.append(f"Units must be 1-{MAX_UNITS_PER_DAY}, got {units}")
    return errors


def calculate_earnings(units: int) -> dict:
    gross = (MEDI_CAL_RATE * units).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    platform_fee = (gross * PLATFORM_FEE_RATE).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    pear_suite_fee = (gross * PEAR_SUITE_FEE_RATE).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    net = gross - platform_fee - pear_suite_fee
    return {
        "gross": float(gross),
        "platform_fee": float(platform_fee),
        "pear_suite_fee": float(pear_suite_fee),
        "net": float(net),
    }


async def check_unit_caps(db: AsyncSession, chw_id, member_id, session_date: date) -> dict:
    """Check daily/yearly Medi-Cal unit caps for this CHW↔member pair.

    Uses `service_date` (the date the service was delivered), not `created_at`
    (the claim submission timestamp). A session that starts at 11:55 PM and
    documents at 12:05 AM still counts toward the start day per Medi-Cal rules.

    Falls back to `created_at` date for legacy rows where service_date is NULL.
    """
    from app.models.billing import BillingClaim

    # Effective service date: prefer the service_date column, fall back to created_at's date
    effective_date = func.coalesce(BillingClaim.service_date, func.date(BillingClaim.created_at))

    daily = await db.execute(
        select(func.coalesce(func.sum(BillingClaim.units), 0))
        .where(BillingClaim.chw_id == chw_id, BillingClaim.member_id == member_id)
        .where(effective_date == session_date)
    )
    daily_used = daily.scalar() or 0

    yearly = await db.execute(
        select(func.coalesce(func.sum(BillingClaim.units), 0))
        .where(BillingClaim.chw_id == chw_id, BillingClaim.member_id == member_id)
        .where(extract("year", effective_date) == session_date.year)
    )
    yearly_used = yearly.scalar() or 0
    return {
        "daily_used": daily_used, "daily_remaining": MAX_UNITS_PER_DAY - daily_used,
        "yearly_used": yearly_used, "yearly_remaining": MAX_UNITS_PER_YEAR - yearly_used,
    }

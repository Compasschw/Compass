import math
from datetime import datetime, timezone, date
from sqlalchemy import select, func, extract
from sqlalchemy.ext.asyncio import AsyncSession

MEDI_CAL_RATE = 26.66
PLATFORM_FEE_RATE = 0.15
PEAR_SUITE_FEE_RATE = 0.10
MAX_UNITS_PER_DAY = 4
MAX_UNITS_PER_YEAR = 10

VALID_ICD10_CODES = [
    "Z59.1", "Z59.7", "Z71.89", "Z63.0", "Z56.9",
    "Z60.2", "Z72.89", "Z71.1", "Z76.89", "Z13.89",
]
VALID_CPT_CODES = ["98960", "98961", "98962"]


def validate_claim(diagnosis_codes: list[str], procedure_code: str, units: int) -> list[str]:
    errors = []
    for code in diagnosis_codes:
        if code not in VALID_ICD10_CODES:
            errors.append(f"Invalid ICD-10 code: {code}")
    if procedure_code not in VALID_CPT_CODES:
        errors.append(f"Invalid CPT code: {procedure_code}")
    if units < 1 or units > MAX_UNITS_PER_DAY:
        errors.append(f"Units must be 1-{MAX_UNITS_PER_DAY}, got {units}")
    return errors


def calculate_earnings(units: int) -> dict:
    gross = round(MEDI_CAL_RATE * units, 2)
    platform_fee = round(gross * PLATFORM_FEE_RATE, 2)
    pear_suite_fee = round(gross * PEAR_SUITE_FEE_RATE, 2)
    net = round(gross - platform_fee - pear_suite_fee, 2)
    return {"gross": gross, "platform_fee": platform_fee, "pear_suite_fee": pear_suite_fee, "net": net}


async def check_unit_caps(db: AsyncSession, chw_id, member_id, session_date: date) -> dict:
    from app.models.billing import BillingClaim
    # Daily cap
    daily = await db.execute(
        select(func.coalesce(func.sum(BillingClaim.units), 0))
        .where(BillingClaim.chw_id == chw_id, BillingClaim.member_id == member_id)
        .where(func.date(BillingClaim.created_at) == session_date)
    )
    daily_used = daily.scalar() or 0
    # Yearly cap
    yearly = await db.execute(
        select(func.coalesce(func.sum(BillingClaim.units), 0))
        .where(BillingClaim.chw_id == chw_id, BillingClaim.member_id == member_id)
        .where(extract("year", BillingClaim.created_at) == session_date.year)
    )
    yearly_used = yearly.scalar() or 0
    return {
        "daily_used": daily_used, "daily_remaining": MAX_UNITS_PER_DAY - daily_used,
        "yearly_used": yearly_used, "yearly_remaining": MAX_UNITS_PER_YEAR - yearly_used,
    }

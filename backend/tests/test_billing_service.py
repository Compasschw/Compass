"""Tests for billing_service unit calculations and earnings math."""

from decimal import Decimal

import pytest

from app.services.billing_service import (
    MAX_UNITS_PER_DAY,
    MEDI_CAL_RATE,
    calculate_earnings,
    calculate_units,
    validate_claim,
)


class TestCalculateUnits:
    """Medi-Cal CHW billing uses 15-min unit brackets, 4-unit daily cap."""

    @pytest.mark.parametrize("duration,expected", [
        (0, 0),
        (14, 0),     # under 15 min — not billable
        (15, 1),     # 15-29 min
        (29, 1),
        (30, 2),     # 30-44 min
        (44, 2),
        (45, 3),     # 45-59 min
        (59, 3),
        (60, 4),     # 60+ min hits daily cap
        (120, 4),    # still cap at 4
        (480, 4),    # 8 hours still caps at 4
    ])
    def test_unit_brackets(self, duration, expected):
        assert calculate_units(duration) == expected

    def test_negative_duration_returns_zero(self):
        """Defensive: negative durations shouldn't be billable."""
        assert calculate_units(-5) == 0


class TestCalculateEarnings:
    def test_one_unit_gross(self):
        result = calculate_earnings(1)
        assert result["gross"] == 26.66

    def test_four_units_gross(self):
        result = calculate_earnings(4)
        # 4 × $26.66 = $106.64
        assert result["gross"] == 106.64

    def test_fee_split_rounds_to_cents(self):
        """Fees must be rounded to 2 decimals — never emit sub-cent values.

        Split: 15% platform / 25% member rewards / 60% CHW net (per Jemal's
        Earnings Figma feedback). The DB column is named `pear_suite_fee` for
        backward-compat but is now the rewards-pool field. See billing_service.py.
        """
        result = calculate_earnings(1)
        # Platform: 15% of $26.66 = $4.00 (rounded half-up from 3.999)
        assert result["platform_fee"] == 4.0
        # Rewards pool: 25% of $26.66 = $6.67 (rounded half-up from 6.665)
        assert result["pear_suite_fee"] == 6.67

    def test_net_is_gross_minus_fees(self):
        result = calculate_earnings(2)
        gross = result["gross"]
        total_fees = result["platform_fee"] + result["pear_suite_fee"]
        assert abs(result["net"] - (gross - total_fees)) < 0.01


class TestValidateClaim:
    def test_valid_claim_passes(self):
        errors = validate_claim(["Z59.1"], "98960", 1)
        assert errors == []

    def test_invalid_icd10_code_fails(self):
        errors = validate_claim(["X99.9"], "98960", 1)
        assert any("ICD-10" in e for e in errors)

    def test_invalid_cpt_code_fails(self):
        errors = validate_claim(["Z59.1"], "99999", 1)
        assert any("CPT" in e for e in errors)

    def test_units_over_daily_cap_fails(self):
        errors = validate_claim(["Z59.1"], "98960", MAX_UNITS_PER_DAY + 1)
        assert any("Units" in e for e in errors)

    def test_zero_units_fails(self):
        errors = validate_claim(["Z59.1"], "98960", 0)
        assert any("Units" in e for e in errors)


class TestConstants:
    def test_medi_cal_rate_matches_state_schedule(self):
        """The $26.66/unit rate is set by California DHCS.
        If this test fails, the rate schedule has changed and billing needs review.
        """
        assert MEDI_CAL_RATE == Decimal("26.66")

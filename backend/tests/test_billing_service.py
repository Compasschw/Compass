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
    """Founder-set unit bracket (2026-05-07): the first unit covers up to 45
    minutes, then every additional 30 minutes earns one more, capped at the
    Medi-Cal daily maximum of 4 units."""

    @pytest.mark.parametrize("duration,expected", [
        (0, 1),      # very short session still earns the minimum 1 unit
        (15, 1),
        (30, 1),
        (45, 1),     # boundary — 45 exact stays at 1
        (46, 2),     # > 45 → 2
        (60, 2),
        (75, 2),     # boundary — 75 exact stays at 2
        (76, 3),     # > 75 → 3
        (90, 3),
        (105, 3),    # boundary — 105 exact stays at 3
        (106, 4),    # > 105 → 4 (cap)
        (120, 4),
        (480, 4),    # 8 hours still capped at 4
    ])
    def test_unit_brackets(self, duration, expected):
        assert calculate_units(duration) == expected

    def test_none_duration_defaults_to_one(self):
        """Missing duration defaults to 1 unit so the schema's ge=1 holds."""
        assert calculate_units(None) == 1

    def test_negative_duration_returns_one(self):
        """Defensive: negative durations are treated as the minimum 1 unit
        rather than 0 — the documented session still happened, and the
        SessionDocumentationSubmit schema requires units_to_bill >= 1."""
        assert calculate_units(-5) == 1


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

    def test_frontend_picker_codes_all_valid(self):
        """Every ICD-10 code the CHW can pick in the app must pass validation.

        Guards against the drift that 422'd documentation submit: the frontend
        picker (native/src/data/mock.ts `diagnosisCodes`) offered SDOH Z-codes the
        backend allow-list didn't recognise. Keep this list in sync with the
        frontend catalog; if a picker code is removed here the submit will 422.
        """
        frontend_picker_codes = [
            "Z71.89", "Z59.12", "Z72.3", "Z75.3", "Z59.00",
            "Z59.89", "Z55.6", "Z59.9", "Z59.86", "Z65.3",
        ]
        errors = validate_claim(frontend_picker_codes, "98960", 1)
        assert errors == [], f"Frontend picker codes rejected by backend: {errors}"


class TestConstants:
    def test_medi_cal_rate_matches_state_schedule(self):
        """The $26.66/unit rate is set by California DHCS.
        If this test fails, the rate schedule has changed and billing needs review.
        """
        assert MEDI_CAL_RATE == Decimal("26.66")

"""Smoke tests for scripts.test_pear_suite harness.

Covers the pure-Python logic (synthetic fixture shape, subcommand dispatch)
without hitting the real Pear Suite API. The HTTP layer is tested separately
via the provider's own unit tests.
"""

from __future__ import annotations

import asyncio
from decimal import Decimal
from unittest.mock import AsyncMock

from app.services.billing import ClaimResult, EligibilityResult
from scripts.test_pear_suite import (
    _synthetic_claim,
    cmd_eligibility,
    cmd_golden_path,
    cmd_status,
    cmd_submit,
    cmd_void,
)


class TestSyntheticClaim:
    def test_shape_matches_medi_cal_chw_billing(self):
        """Synthetic claim should be a valid 1-unit CHW service submission."""
        c = _synthetic_claim()
        assert c.procedure_code == "98960"
        assert c.modifier == "U2"
        assert c.units == 1
        assert c.gross_amount == Decimal("26.66")
        assert "Z59.41" in c.diagnosis_codes  # food insecurity
        assert c.extra.get("_test") is True

    def test_ids_are_unique_across_calls(self):
        """Two synthetic claims should not collide on UUIDs."""
        a = _synthetic_claim()
        b = _synthetic_claim()
        assert a.session_id != b.session_id


class TestCmdEligibility:
    def test_eligible_member(self):
        provider = AsyncMock()
        provider.verify_eligibility = AsyncMock(
            return_value=EligibilityResult(is_eligible=True, plan_name="Health Net")
        )
        result = asyncio.run(cmd_eligibility(provider, "CIN123"))
        assert result is True
        provider.verify_eligibility.assert_awaited_once_with("CIN123")

    def test_ineligible_still_succeeds(self):
        """Ineligibility is a valid answer, not a test failure."""
        provider = AsyncMock()
        provider.verify_eligibility = AsyncMock(
            return_value=EligibilityResult(is_eligible=False, message="Not enrolled")
        )
        result = asyncio.run(cmd_eligibility(provider, "CIN999"))
        assert result is True

    def test_exception_returns_false(self):
        provider = AsyncMock()
        provider.verify_eligibility = AsyncMock(side_effect=RuntimeError("timeout"))
        result = asyncio.run(cmd_eligibility(provider, "CIN123"))
        assert result is False


class TestCmdSubmit:
    def test_success_returns_claim_id(self):
        provider = AsyncMock()
        provider.submit_claim = AsyncMock(
            return_value=ClaimResult(success=True, provider_claim_id="ps_abc123", status="submitted")
        )
        ok, claim_id = asyncio.run(cmd_submit(provider))
        assert ok is True
        assert claim_id == "ps_abc123"

    def test_failure_returns_no_id(self):
        provider = AsyncMock()
        provider.submit_claim = AsyncMock(
            return_value=ClaimResult(success=False, message="auth failed")
        )
        ok, claim_id = asyncio.run(cmd_submit(provider))
        assert ok is False
        assert claim_id is None


class TestCmdStatus:
    def test_ok_path(self):
        provider = AsyncMock()
        provider.get_claim_status = AsyncMock(
            return_value=ClaimResult(success=True, provider_claim_id="ps_x", status="accepted")
        )
        assert asyncio.run(cmd_status(provider, "ps_x")) is True

    def test_failure(self):
        provider = AsyncMock()
        provider.get_claim_status = AsyncMock(
            return_value=ClaimResult(success=False, message="not found")
        )
        assert asyncio.run(cmd_status(provider, "missing")) is False


class TestCmdVoid:
    def test_ok_path(self):
        provider = AsyncMock()
        provider.void_claim = AsyncMock(
            return_value=ClaimResult(success=True, provider_claim_id="ps_x", status="voided")
        )
        assert asyncio.run(cmd_void(provider, "ps_x")) is True


class TestGoldenPath:
    def test_end_to_end_success(self):
        provider = AsyncMock()
        provider.verify_eligibility = AsyncMock(
            return_value=EligibilityResult(is_eligible=True, plan_name="Health Net")
        )
        provider.submit_claim = AsyncMock(
            return_value=ClaimResult(success=True, provider_claim_id="ps_abc", status="submitted")
        )
        provider.get_claim_status = AsyncMock(
            return_value=ClaimResult(success=True, provider_claim_id="ps_abc", status="accepted")
        )
        result = asyncio.run(cmd_golden_path(provider, "CIN123"))
        assert result is True
        provider.verify_eligibility.assert_awaited_once_with("CIN123")
        provider.submit_claim.assert_awaited_once()
        provider.get_claim_status.assert_awaited_once_with("ps_abc")

    def test_skips_eligibility_when_no_id(self):
        provider = AsyncMock()
        provider.verify_eligibility = AsyncMock()
        provider.submit_claim = AsyncMock(
            return_value=ClaimResult(success=True, provider_claim_id="ps_abc", status="submitted")
        )
        provider.get_claim_status = AsyncMock(
            return_value=ClaimResult(success=True, provider_claim_id="ps_abc", status="submitted")
        )
        result = asyncio.run(cmd_golden_path(provider, None))
        assert result is True
        provider.verify_eligibility.assert_not_awaited()

    def test_submit_failure_aborts_pipeline(self):
        """If submit fails, status poll should not run."""
        provider = AsyncMock()
        provider.verify_eligibility = AsyncMock(
            return_value=EligibilityResult(is_eligible=True)
        )
        provider.submit_claim = AsyncMock(
            return_value=ClaimResult(success=False, message="validation failed")
        )
        provider.get_claim_status = AsyncMock()
        result = asyncio.run(cmd_golden_path(provider, "CIN123"))
        assert result is False
        provider.get_claim_status.assert_not_awaited()

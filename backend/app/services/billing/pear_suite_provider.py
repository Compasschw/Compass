"""Pear Suite implementation of the BillingProvider interface.

API docs: https://api-docs-dot-pearsuite-prod.uc.r.appspot.com/docs/getting-started

Authentication: `api-key` HTTP header.
Rate limiting: X-Rate-Limit-Limit / X-Rate-Limit-Remaining / X-Rate-Limit-Reset.
On 429: provider returns rate-limit-exceeded; we surface a typed error.

The endpoint paths and request schemas below are placeholders until the detailed
docs are accessible (requires an API key). The interface is defined so that
filling in the HTTP calls is a mechanical, single-file change.
"""

import logging
from typing import Any

import httpx

from app.services.billing.base import (
    BillingProvider,
    ClaimResult,
    ClaimSubmission,
    EligibilityResult,
)

logger = logging.getLogger("compass.billing.pearsuite")


class PearSuiteProvider(BillingProvider):
    """Pear Suite adapter for Medi-Cal claims submission + eligibility.

    Sends claims via Pear Suite's REST API. Pear Suite handles the EDI 837
    conversion, clearinghouse submission, and adjudication tracking. Fees
    (15% of gross) are billed directly by Pear Suite to the CBO/organization.
    """

    def __init__(self, api_key: str, base_url: str = "https://api.pearsuite.com") -> None:
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")

    def _headers(self) -> dict[str, str]:
        return {
            "api-key": self._api_key,
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    async def _request(
        self,
        method: str,
        path: str,
        json: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Shared HTTP wrapper — handles auth, rate-limit headers, and error shapes."""
        if not self._api_key:
            logger.warning("Pear Suite API key not configured — returning placeholder response")
            return {"_placeholder": True}

        url = f"{self._base_url}{path}"
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.request(method, url, json=json, headers=self._headers())

            # Surface rate limit state in logs so we can see pressure early
            remaining = resp.headers.get("X-Rate-Limit-Remaining")
            if remaining is not None:
                logger.debug("Pear Suite rate limit remaining: %s", remaining)

            if resp.status_code == 429:
                reset = resp.headers.get("X-Rate-Limit-Reset")
                raise PearSuiteRateLimitError(f"Rate limit exceeded. Resets at {reset}.")

            resp.raise_for_status()
            return resp.json()
        except httpx.HTTPStatusError as e:
            logger.error("Pear Suite HTTP %d on %s: %s", e.response.status_code, path, e.response.text[:500])
            raise

    async def verify_eligibility(self, member_medi_cal_id: str) -> EligibilityResult:
        """Verify Medi-Cal eligibility via Pear Suite.

        TODO: Replace with actual endpoint once API docs confirm the path.
        Likely `GET /v1/members/{medi_cal_id}/eligibility` or similar.
        """
        try:
            data = await self._request(
                "GET",
                f"/v1/members/{member_medi_cal_id}/eligibility",
            )
            if data.get("_placeholder"):
                return EligibilityResult(
                    is_eligible=False,
                    message="Pear Suite not configured",
                )
            return EligibilityResult(
                is_eligible=bool(data.get("eligible", False)),
                plan_name=data.get("plan_name"),
                cin=data.get("cin"),
            )
        except Exception as e:  # noqa: BLE001
            logger.error("Eligibility check failed: %s", e)
            return EligibilityResult(is_eligible=False, message=str(e))

    async def submit_claim(self, claim: ClaimSubmission) -> ClaimResult:
        """Submit a CHW service claim to Pear Suite for processing.

        TODO: Confirm exact payload shape from Pear Suite API docs.
        The payload below is a reasonable first pass based on standard
        EDI 837 fields and the Medi-Cal CHW billing guide.
        """
        payload = {
            "session_id": str(claim.session_id),
            "chw_id": str(claim.chw_id),
            "member_id": str(claim.member_id),
            "service_date": claim.service_date.isoformat(),
            "procedure_code": claim.procedure_code,
            "modifier": claim.modifier,
            "diagnosis_codes": claim.diagnosis_codes,
            "units": claim.units,
            "gross_amount": str(claim.gross_amount),
            "chw_npi": claim.chw_npi,
            "notes": claim.notes,
            **claim.extra,
        }
        try:
            data = await self._request("POST", "/v1/claims", json=payload)
            if data.get("_placeholder"):
                return ClaimResult(
                    success=False,
                    status="pending",
                    message="Pear Suite not configured — claim queued locally",
                )
            return ClaimResult(
                success=True,
                provider_claim_id=data.get("claim_id"),
                status=data.get("status", "submitted"),
                message=data.get("message"),
                raw_response=data,
            )
        except Exception as e:  # noqa: BLE001
            logger.error("Claim submission failed: %s", e)
            return ClaimResult(success=False, status="error", message=str(e))

    async def get_claim_status(self, provider_claim_id: str) -> ClaimResult:
        """Poll claim status from Pear Suite."""
        try:
            data = await self._request("GET", f"/v1/claims/{provider_claim_id}")
            if data.get("_placeholder"):
                return ClaimResult(success=False, status="unknown", message="Pear Suite not configured")
            return ClaimResult(
                success=True,
                provider_claim_id=provider_claim_id,
                status=data.get("status", "unknown"),
                raw_response=data,
            )
        except Exception as e:  # noqa: BLE001
            logger.error("Claim status fetch failed: %s", e)
            return ClaimResult(success=False, status="error", message=str(e))

    async def void_claim(self, provider_claim_id: str) -> ClaimResult:
        """Void/delete a claim (Beta endpoint per Pear Suite docs)."""
        try:
            data = await self._request("DELETE", f"/v1/claims/{provider_claim_id}")
            if data.get("_placeholder"):
                return ClaimResult(success=False, status="unknown", message="Pear Suite not configured")
            return ClaimResult(
                success=True,
                provider_claim_id=provider_claim_id,
                status="voided",
                raw_response=data,
            )
        except Exception as e:  # noqa: BLE001
            logger.error("Claim void failed: %s", e)
            return ClaimResult(success=False, status="error", message=str(e))


class PearSuiteRateLimitError(Exception):
    """Raised when Pear Suite returns 429 Too Many Requests."""

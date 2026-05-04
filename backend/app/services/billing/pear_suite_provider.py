"""Pear Suite implementation of the BillingProvider interface.

API docs: https://api-docs-dot-pearsuite-prod.uc.r.appspot.com/docs/getting-started

Authentication: `api-key` HTTP header.
Rate limiting: X-Rate-Limit-Limit / X-Rate-Limit-Remaining / X-Rate-Limit-Reset.
On 429: provider returns rate-limit-exceeded; we surface a typed error.

CURRENT STATE: STUB
─────────────────────────────────────────────────────────────────────────────
The real Pear Suite Beta API is much more model-driven than our internal
billing schema. Submitting a claim requires that the following already exist
inside Pear Suite:

  1. The member  → POST /api/beta/members (CreateMember)
  2. A PearSuite user account for the CHW  → no Create User API exists,
     accounts must be provisioned via Pear Suite's dashboard
  3. An activity template per procedure code (T1016, G0511, etc.) → also
     dashboard-only, returns an activityTemplateId we must store
  4. A scheduled activity for the session  → POST /api/beta/activities
     (Schedule Activities) referencing the template, member, and CHW user

Then, and only then, can we call:

  POST /api/beta/claims  with  { memberId, billId? }

…which generates a claim from the unbilled activities Pear Suite already
knows about. See `submit_claim` for the full TODO checklist.

In the meantime, this provider operates in STUB MODE: `submit_claim`
returns a deterministic local mock claim ID so the rest of the workflow
(claim row marked `submitted`, Stripe payout pipeline, CHW earnings UI,
admin status advance) works end-to-end. To switch to real submission once
the dependencies above exist, set PEAR_SUITE_STUB_MODE=false in the env
and finish the TODOs in `submit_claim`.
"""

import logging
import os
from typing import Any

import httpx

from app.services.billing.base import (
    BillingProvider,
    ClaimResult,
    ClaimSubmission,
    EligibilityResult,
)

logger = logging.getLogger("compass.billing.pearsuite")


def _stub_mode_enabled() -> bool:
    """Stub mode is the safe default until member/activity sync is built.

    Flip PEAR_SUITE_STUB_MODE=false in the env once the prerequisites in the
    module docstring are satisfied (member sync, CHW user provisioning,
    activity template mapping, schedule-activity-on-session-complete).
    """
    return os.getenv("PEAR_SUITE_STUB_MODE", "true").strip().lower() != "false"


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

        STUB: Pear Suite's Beta API surface does not expose a public eligibility
        endpoint. Real eligibility verification will live in a separate Medi-Cal
        clearinghouse integration. For now we return optimistic eligibility so
        the demo flow does not block on this.
        """
        if _stub_mode_enabled():
            logger.info(
                "[STUB] Pear Suite eligibility check for medi_cal_id=%s — returning optimistic eligible",
                member_medi_cal_id,
            )
            return EligibilityResult(
                is_eligible=True,
                plan_name="Medi-Cal (stubbed)",
                cin=member_medi_cal_id,
                message="Pear Suite eligibility is stubbed pending real clearinghouse integration",
            )
        try:
            data = await self._request(
                "GET",
                f"/api/beta/members/{member_medi_cal_id}/eligibility",
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
        """Submit a CHW service claim to Pear Suite.

        STUB MODE (current default):
        Returns a deterministic mock provider claim ID derived from the local
        session_id so the rest of the pipeline (claim row marked `submitted`,
        Stripe payout flow, CHW earnings UI, admin status advance) works
        end-to-end. The mock ID is prefixed with `pearsuite-stub-` so it is
        trivially distinguishable from real Pear Suite claim IDs in the DB
        and in admin tooling.

        REAL MODE (PEAR_SUITE_STUB_MODE=false):
        Pear Suite's Beta API generates claims from existing activities, not
        from raw payloads. To switch on real submission we need to first:

          1. Sync the member to Pear Suite      → POST /api/beta/members
             Store returned id on members.pear_suite_member_id.
          2. Provision the CHW as a Pear Suite user (manual, dashboard-only)
             Store id on chw_profiles.pear_suite_user_id.
          3. Create activity template per procedure_code in Pear Suite
             dashboard. Store mapping in pear_suite_template_map table.
          4. On session completion, schedule the activity:
             POST /api/beta/activities { activityTemplateId, memberIds,
             userId, date, scheduledEndAt }. Store activity id on
             sessions.pear_suite_activity_id.

        Once those exist, this method becomes:

          data = await self._request(
              "POST",
              "/api/beta/claims",
              json={"memberId": claim.pear_suite_member_id},
          )
          return ClaimResult(
              success=data.get("success", False),
              provider_claim_id=data["data"]["id"],
              status="submitted",
              raw_response=data,
          )
        """
        if _stub_mode_enabled():
            stub_id = f"pearsuite-stub-{claim.session_id}"
            logger.info(
                "[STUB] Pear Suite submit_claim session=%s chw=%s member=%s "
                "procedure=%s units=%d gross=$%s → returning mock id %s",
                claim.session_id,
                claim.chw_id,
                claim.member_id,
                claim.procedure_code,
                claim.units,
                claim.gross_amount,
                stub_id,
            )
            return ClaimResult(
                success=True,
                provider_claim_id=stub_id,
                status="submitted",
                message="Pear Suite stub: claim recorded locally, awaiting real integration",
            )

        # Real submission path — currently unreachable until prerequisites
        # above are satisfied. Left in place so future flip is one env change
        # plus filling in the memberId lookup.
        member_pear_suite_id = claim.extra.get("pear_suite_member_id")
        if not member_pear_suite_id:
            logger.error(
                "Cannot submit real Pear Suite claim — no pear_suite_member_id "
                "on session=%s. Run member sync first.",
                claim.session_id,
            )
            return ClaimResult(
                success=False,
                status="error",
                message="Member not synced to Pear Suite — run member sync first",
            )
        try:
            data = await self._request(
                "POST",
                "/api/beta/claims",
                json={"memberId": member_pear_suite_id},
            )
            if data.get("_placeholder"):
                return ClaimResult(
                    success=False,
                    status="pending",
                    message="Pear Suite not configured — claim queued locally",
                )
            claim_data = data.get("data", {}) if isinstance(data.get("data"), dict) else {}
            return ClaimResult(
                success=bool(data.get("success", True)),
                provider_claim_id=claim_data.get("id") or claim_data.get("claimId"),
                status=claim_data.get("status", "submitted"),
                message=data.get("message"),
                raw_response=data,
            )
        except Exception as e:  # noqa: BLE001
            logger.error("Claim submission failed: %s", e)
            return ClaimResult(success=False, status="error", message=str(e))

    async def get_claim_status(self, provider_claim_id: str) -> ClaimResult:
        """Poll claim status from Pear Suite.

        STUB: Mock-prefixed IDs always report `submitted` so the UI doesn't
        churn when polling local claims that never made it to Pear Suite.
        """
        if _stub_mode_enabled() or provider_claim_id.startswith("pearsuite-stub-"):
            return ClaimResult(
                success=True,
                provider_claim_id=provider_claim_id,
                status="submitted",
                message="Pear Suite stub status",
            )
        try:
            data = await self._request("GET", f"/api/beta/claims/{provider_claim_id}")
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
        if _stub_mode_enabled() or provider_claim_id.startswith("pearsuite-stub-"):
            logger.info("[STUB] Pear Suite void_claim %s — no-op", provider_claim_id)
            return ClaimResult(
                success=True,
                provider_claim_id=provider_claim_id,
                status="voided",
                message="Pear Suite stub void",
            )
        try:
            data = await self._request("DELETE", f"/api/beta/claims/{provider_claim_id}")
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

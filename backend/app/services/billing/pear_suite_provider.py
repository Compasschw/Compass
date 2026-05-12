"""Pear Suite implementation of the BillingProvider interface.

API docs: https://api-docs-dot-pearsuite-prod.uc.r.appspot.com/docs/getting-started

Authentication: `api-key` HTTP header.
Rate limiting: X-Rate-Limit-Limit / X-Rate-Limit-Remaining / X-Rate-Limit-Reset.
On 429: provider returns rate-limit-exceeded; we surface a typed error.

CLAIM ORCHESTRATION FLOW
─────────────────────────────────────────────────────────────────────────────
Submitting a claim through Pear Suite's Beta API is NOT a single POST call.
It requires the following objects to exist in Pear Suite's system first:

  1. Member           → POST /api/beta/members (synced via ensure_member_synced)
  2. CHW user account → provisioned via Pear Suite dashboard only (no API)
  3. Activity template per CPT code → Pear Suite dashboard; stored in pear_suite_template_map
  4. Scheduled activity → POST /api/beta/activities
  5. Complete the activity → PUT /api/beta/activities/:id (status=Complete + billingDetails)
  6. Generate claim → POST /api/beta/claims { memberId, billId? }

This module implements steps 4-6 in submit_claim(), assuming steps 1-3 are
already satisfied. The demo-claim admin endpoint orchestrates the full chain.

BILL ID AMBIGUITY
─────────────────────────────────────────────────────────────────────────────
The Pear rep has not confirmed whether marking an activity Complete auto-
creates a Bill that can be referenced as `billId` in POST /api/beta/claims.
The code is defensive: it first tries POST /claims with just { memberId }.
If that 4xx-errors, it logs clearly and retries with { memberId, billId: <activityId> }.
If both fail, it logs the activityId so a human can resolve manually.

IDEMPOTENCY
─────────────────────────────────────────────────────────────────────────────
Every _request call includes an X-Idempotency-Key header derived from the
local claim/session ID. Pear's docs don't confirm server-side idempotency
enforcement — the key is logged regardless so retries are traceable.
"""

import logging
import uuid
from datetime import date, datetime, timezone
from typing import Any

import httpx

from app.services.billing.base import (
    BillingProvider,
    ClaimResult,
    ClaimSubmission,
    EligibilityResult,
)

logger = logging.getLogger("compass.billing.pearsuite")

# Place of service code 12 = Home/Community (used for CHW in-home visits).
# Pear Suite expects a numeric string in billingDetails.
_PLACE_OF_SERVICE_COMMUNITY = "12"

# Pear Suite activity status enum values (as of Beta API, 2026-05).
_ACTIVITY_STATUS_SCHEDULED = "Scheduled"
_ACTIVITY_STATUS_COMPLETE = "Complete"

# Pear Suite claim status → our internal status mapping.
# Pear's enum values are not fully documented; defensive fallback to "submitted".
_PEAR_STATUS_MAP: dict[str, str] = {
    "Submitted": "submitted",
    "Pending": "submitted",
    "Paid": "paid",
    "Approved": "paid",
    "Denied": "denied",
    "Rejected": "denied",
    "NeedsCorrection": "needs_correction",
    "NeedsCorrectionManual": "needs_correction",
}


class PearSuiteRateLimitError(Exception):
    """Raised when Pear Suite returns 429 Too Many Requests."""


class PearSuiteProvider(BillingProvider):
    """Pear Suite adapter for Medi-Cal claims submission + eligibility.

    Sends claims via Pear Suite's REST API. Pear Suite handles the EDI 837
    conversion, clearinghouse submission, and adjudication tracking. Fees
    (15% of gross) are billed directly by Pear Suite to the CBO/organization.
    """

    def __init__(self, api_key: str, base_url: str = "https://api.pearsuite.com") -> None:
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")

    def _headers(self, idempotency_key: str | None = None) -> dict[str, str]:
        headers = {
            "api-key": self._api_key,
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        if idempotency_key:
            # Pear Suite docs don't confirm server-side idempotency enforcement,
            # but we send the key on every mutating call so retries are traceable
            # in our structured logs and potentially honored by Pear's infra.
            headers["X-Idempotency-Key"] = idempotency_key
        return headers

    async def _request(
        self,
        method: str,
        path: str,
        json: dict[str, Any] | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        """Shared HTTP wrapper — handles auth, rate-limit headers, and error shapes.

        Args:
            method: HTTP verb (GET, POST, PUT, DELETE).
            path: URL path relative to base_url, e.g. "/api/beta/members".
            json: Request body for POST/PUT; None for GET/DELETE.
            idempotency_key: Optional idempotency key included as X-Idempotency-Key header.

        Returns:
            Parsed JSON response body as a dict.

        Raises:
            PearSuiteRateLimitError: when Pear Suite returns 429.
            httpx.HTTPStatusError: for all other 4xx/5xx responses.
        """
        if not self._api_key:
            logger.warning(
                "pear_suite._request: API key not configured — "
                "returning placeholder response for %s %s",
                method,
                path,
            )
            return {"_placeholder": True}

        url = f"{self._base_url}{path}"
        logger.info(
            "pear_suite.request: method=%s path=%s idempotency_key=%s body_keys=%s",
            method,
            path,
            idempotency_key,
            list(json.keys()) if json else None,
        )

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.request(
                    method,
                    url,
                    json=json,
                    headers=self._headers(idempotency_key=idempotency_key),
                )

            # Surface rate limit state in logs so we can see pressure early
            remaining = resp.headers.get("X-Rate-Limit-Remaining")
            limit = resp.headers.get("X-Rate-Limit-Limit")
            if remaining is not None:
                logger.info(
                    "pear_suite.rate_limit: path=%s remaining=%s limit=%s",
                    path,
                    remaining,
                    limit,
                )

            if resp.status_code == 429:
                reset = resp.headers.get("X-Rate-Limit-Reset")
                logger.error(
                    "pear_suite.rate_limit_exceeded: path=%s resets_at=%s",
                    path,
                    reset,
                )
                raise PearSuiteRateLimitError(f"Rate limit exceeded. Resets at {reset}.")

            logger.info(
                "pear_suite.response: method=%s path=%s status=%d",
                method,
                path,
                resp.status_code,
            )

            resp.raise_for_status()
            return resp.json()

        except httpx.HTTPStatusError as exc:
            logger.error(
                "pear_suite.http_error: method=%s path=%s status=%d body=%s",
                method,
                path,
                exc.response.status_code,
                exc.response.text[:500],
            )
            raise

    # ─────────────────────────────────────────────────────────────────────────
    # BillingProvider interface implementation
    # ─────────────────────────────────────────────────────────────────────────

    async def verify_eligibility(self, member_medi_cal_id: str) -> EligibilityResult:
        """Return eligibility for a Medi-Cal member.

        Pear Suite's Beta API does not expose a public eligibility endpoint —
        eligibility verification happens server-side within Pear Suite when a
        claim is generated. We return an optimistic stub so the claim flow is
        not blocked on this pre-check. Real eligibility verification will be
        added as a separate Medi-Cal clearinghouse integration.

        Args:
            member_medi_cal_id: The member's Medi-Cal CIN (Client Index Number).

        Returns:
            EligibilityResult with is_eligible=True and plan_name="Medi-Cal".
        """
        logger.info(
            "pear_suite.verify_eligibility: medi_cal_id=[REDACTED] "
            "(stub — Pear Beta has no public eligibility endpoint)",
        )
        return EligibilityResult(
            is_eligible=True,
            plan_name="Medi-Cal",
            cin=member_medi_cal_id,
            coverage_status="active",
            message=(
                "Eligibility check is stubbed — Pear Suite Beta API has no public "
                "eligibility endpoint. Real verification occurs server-side at Pear "
                "during claim generation."
            ),
        )

    async def create_member(self, member_payload: dict[str, Any]) -> dict[str, Any]:
        """Create a member in Pear Suite via POST /api/beta/members.

        Called by ensure_member_synced. This method is not part of the
        BillingProvider abstract interface — it is a Pear-specific helper.

        Args:
            member_payload: Dict with keys: firstName, lastName, dateOfBirth,
                gender (optional), language (optional), address (optional),
                phone (optional), email (optional), mediCalId (optional).

        Returns:
            Parsed Pear Suite response body. Contains at minimum {"id": str}.

        Raises:
            httpx.HTTPStatusError: on Pear API errors.
        """
        # Derive idempotency key from mediCalId if present, otherwise random.
        # This prevents duplicate member creation on retries.
        medi_cal_id = member_payload.get("mediCalId", "")
        idempotency_key = (
            f"create-member-{medi_cal_id}"
            if medi_cal_id
            else f"create-member-{uuid.uuid4()}"
        )

        logger.info(
            "pear_suite.create_member: firstName=%s lastName=%s "
            "mediCalId=[REDACTED] idempotency_key=%s",
            member_payload.get("firstName"),
            member_payload.get("lastName"),
            idempotency_key,
        )

        data = await self._request(
            "POST",
            "/api/beta/members",
            json=member_payload,
            idempotency_key=idempotency_key,
        )

        pear_member_id = data.get("id") or data.get("memberId")
        logger.info(
            "pear_suite.create_member.success: pear_member_id=%s",
            pear_member_id,
        )
        return data

    async def schedule_activity(
        self,
        *,
        activity_template_id: str,
        member_ids: list[str],
        chw_user_id: str,
        service_date: date,
        session_id: uuid.UUID,
        notes: str | None = None,
    ) -> dict[str, Any]:
        """Schedule an activity in Pear Suite via POST /api/beta/activities.

        Args:
            activity_template_id: Pear Suite template ID for the procedure (e.g. T1016).
            member_ids: List of Pear Suite member IDs participating in the activity.
            chw_user_id: Pear Suite userId for the CHW performing the service.
            service_date: Calendar date the CHW session occurred.
            session_id: Local Compass session UUID — used to derive idempotency key.
            notes: Optional CHW notes attached to the activity.

        Returns:
            Pear Suite activity object dict. Contains at minimum {"id": str}.
        """
        # scheduledEndAt: Pear Suite requires a datetime for the end of the
        # scheduled window. We default to end-of-day ISO8601 since we only
        # have the calendar date from billing documentation.
        scheduled_date_iso = service_date.isoformat()
        scheduled_end_iso = f"{scheduled_date_iso}T23:59:00Z"

        payload: dict[str, Any] = {
            "activityTemplateId": activity_template_id,
            "memberIds": member_ids,
            "userId": chw_user_id,
            "date": scheduled_date_iso,
            "scheduledEndAt": scheduled_end_iso,
        }
        if notes:
            payload["notes"] = notes

        idempotency_key = f"schedule-activity-session-{session_id}"
        logger.info(
            "pear_suite.schedule_activity: template_id=%s member_count=%d "
            "chw_user_id=%s service_date=%s session_id=%s",
            activity_template_id,
            len(member_ids),
            chw_user_id,
            scheduled_date_iso,
            session_id,
        )

        data = await self._request(
            "POST",
            "/api/beta/activities",
            json=payload,
            idempotency_key=idempotency_key,
        )

        pear_activity_id = data.get("id") or data.get("activityId")
        logger.info(
            "pear_suite.schedule_activity.success: pear_activity_id=%s session_id=%s",
            pear_activity_id,
            session_id,
        )
        return data

    async def complete_activity(
        self,
        *,
        pear_activity_id: str,
        pear_member_id: str,
        chw_user_id: str,
        service_date: date,
        diagnosis_codes: list[str],
        session_id: uuid.UUID,
    ) -> dict[str, Any]:
        """Mark an activity Complete with billing details via PUT /api/beta/activities/:id.

        Sets status=Complete, billable=True, and attaches billingDetails for
        the member. Uses place of service 12 (Home/Community).

        Args:
            pear_activity_id: The activity ID returned by schedule_activity.
            pear_member_id: Pear Suite member ID.
            chw_user_id: Pear Suite user ID for the CHW.
            service_date: Calendar date of the session.
            diagnosis_codes: ICD-10 codes; first element is the primary diagnosis.
            session_id: Local Compass session UUID — for idempotency key + logging.

        Returns:
            Pear Suite updated activity object dict.
        """
        scheduled_date_iso = service_date.isoformat()
        scheduled_end_iso = f"{scheduled_date_iso}T23:59:00Z"

        primary_dx = diagnosis_codes[0] if diagnosis_codes else "Z71.89"

        billing_detail: dict[str, Any] = {
            "memberId": pear_member_id,
            "placeOfService": _PLACE_OF_SERVICE_COMMUNITY,
            "primaryDiagnosisCode": primary_dx,
            "diagnosisCodes": diagnosis_codes,
            # Let Pear Suite use the template's configured charge amount.
            # Set to None rather than omitting — some Pear endpoints reject missing keys.
            "customClaimChargeAmount": None,
            # Prior auth not required for T1016 under standard Medi-Cal CHW billing.
            "priorAuthorizationNumber": None,
            # dateOfCurrentIllness: Pear requires this field; we use the service date
            # as a safe default since CHW services are episodic, not illness-indexed.
            "dateOfCurrentIllness": scheduled_date_iso,
        }

        payload: dict[str, Any] = {
            "status": _ACTIVITY_STATUS_COMPLETE,
            "date": scheduled_date_iso,
            "scheduledEndAt": scheduled_end_iso,
            "userId": chw_user_id,
            "billable": True,
            "billingDetails": [billing_detail],
        }

        idempotency_key = f"complete-activity-{pear_activity_id}-session-{session_id}"
        logger.info(
            "pear_suite.complete_activity: pear_activity_id=%s pear_member_id=%s "
            "primary_dx=%s session_id=%s",
            pear_activity_id,
            pear_member_id,
            primary_dx,
            session_id,
        )

        data = await self._request(
            "PUT",
            f"/api/beta/activities/{pear_activity_id}",
            json=payload,
            idempotency_key=idempotency_key,
        )

        logger.info(
            "pear_suite.complete_activity.success: pear_activity_id=%s "
            "response_status=%s session_id=%s",
            pear_activity_id,
            data.get("status"),
            session_id,
        )
        return data

    async def generate_claim(
        self,
        *,
        pear_member_id: str,
        pear_activity_id: str,
        session_id: uuid.UUID,
    ) -> dict[str, Any]:
        """Generate a claim via POST /api/beta/claims.

        BILL ID AMBIGUITY: Pear rep has not confirmed whether marking an
        activity Complete auto-creates a Bill that can be referenced as billId.
        Strategy:
          1. Try POST /claims with { memberId } only.
          2. If 4xx, log clearly and retry with { memberId, billId: activityId }.
          3. If both fail, raise the second error — human must resolve manually.

        Args:
            pear_member_id: Pear Suite member ID.
            pear_activity_id: The activity ID to reference (used as billId fallback).
            session_id: Local Compass session UUID — for idempotency key + logging.

        Returns:
            Pear Suite response dict. Expected shape: { success: bool, data: { id, ... } }.

        Raises:
            httpx.HTTPStatusError: if both claim-generation attempts fail.
        """
        idempotency_key = f"generate-claim-session-{session_id}"

        # Attempt 1: memberId only
        logger.info(
            "pear_suite.generate_claim.attempt1: "
            "pear_member_id=%s session_id=%s idempotency_key=%s",
            pear_member_id,
            session_id,
            idempotency_key,
        )
        try:
            data = await self._request(
                "POST",
                "/api/beta/claims",
                json={"memberId": pear_member_id},
                idempotency_key=idempotency_key,
            )
            pear_claim_id = (data.get("data") or {}).get("id") if isinstance(data.get("data"), dict) else None
            logger.info(
                "pear_suite.generate_claim.attempt1.success: "
                "pear_claim_id=%s session_id=%s",
                pear_claim_id,
                session_id,
            )
            return data

        except httpx.HTTPStatusError as exc:
            logger.warning(
                "pear_suite.generate_claim.attempt1.failed: "
                "status=%d body=%s — retrying with billId=%s session_id=%s. "
                "NOTE: Pear rep must confirm whether billId should be the activityId "
                "or a separate Bill object ID. If this retry also fails, the claim "
                "must be created manually in the Pear Suite dashboard. "
                "pear_activity_id=%s",
                exc.response.status_code,
                exc.response.text[:300],
                pear_activity_id,
                session_id,
                pear_activity_id,
            )

        # Attempt 2: memberId + billId (using activityId as the bill reference)
        idempotency_key_2 = f"generate-claim-session-{session_id}-v2"
        logger.info(
            "pear_suite.generate_claim.attempt2: "
            "pear_member_id=%s bill_id=%s session_id=%s",
            pear_member_id,
            pear_activity_id,
            session_id,
        )
        data = await self._request(
            "POST",
            "/api/beta/claims",
            json={"memberId": pear_member_id, "billId": pear_activity_id},
            idempotency_key=idempotency_key_2,
        )
        pear_claim_id = (data.get("data") or {}).get("id") if isinstance(data.get("data"), dict) else None
        logger.info(
            "pear_suite.generate_claim.attempt2.success: "
            "pear_claim_id=%s session_id=%s",
            pear_claim_id,
            session_id,
        )
        return data

    async def submit_claim(self, claim: ClaimSubmission) -> ClaimResult:
        """Submit a CHW service claim to Pear Suite.

        This method is the scheduler-facing interface (called by billing_service
        on session documentation submit). It requires that the member has already
        been synced (member.pear_suite_member_id is set) and the CHW user ID is
        available in claim.extra["pear_suite_chw_user_id"].

        For the full orchestrated demo flow (member sync + schedule + complete +
        generate), use the admin demo-claim endpoint which calls the helpers above.

        Args:
            claim: ClaimSubmission with pear_suite context in claim.extra:
                - pear_suite_member_id: str
                - pear_suite_chw_user_id: str
                - pear_suite_activity_template_id: str

        Returns:
            ClaimResult with provider_claim_id populated on success.
        """
        pear_member_id = claim.extra.get("pear_suite_member_id")
        chw_user_id = claim.extra.get("pear_suite_chw_user_id")
        template_id = claim.extra.get("pear_suite_activity_template_id")

        if not pear_member_id:
            logger.error(
                "pear_suite.submit_claim.missing_member_id: session=%s "
                "Run member sync (ensure_member_synced) first.",
                claim.session_id,
            )
            return ClaimResult(
                success=False,
                status="error",
                message="Member not synced to Pear Suite — run member sync first",
            )

        if not chw_user_id:
            logger.error(
                "pear_suite.submit_claim.missing_chw_user_id: session=%s "
                "Set pear_suite_user_id on CHWProfile via admin tooling.",
                claim.session_id,
            )
            return ClaimResult(
                success=False,
                status="error",
                message="CHW has no pear_suite_user_id — set via admin tooling",
            )

        if not template_id:
            logger.error(
                "pear_suite.submit_claim.missing_template_id: session=%s "
                "Set PEAR_SUITE_T1016_TEMPLATE_ID in env or update pear_suite_template_map.",
                claim.session_id,
            )
            return ClaimResult(
                success=False,
                status="error",
                message="Activity template ID for T1016 not configured",
            )

        try:
            # Step 1: Schedule the activity
            activity_data = await self.schedule_activity(
                activity_template_id=template_id,
                member_ids=[pear_member_id],
                chw_user_id=chw_user_id,
                service_date=claim.service_date,
                session_id=claim.session_id,
                notes=claim.notes,
            )
            pear_activity_id = activity_data.get("id") or activity_data.get("activityId")
            if not pear_activity_id:
                logger.error(
                    "pear_suite.submit_claim.no_activity_id: session=%s response=%s",
                    claim.session_id,
                    activity_data,
                )
                return ClaimResult(
                    success=False,
                    status="error",
                    message="Pear Suite did not return an activity ID",
                )

            # Step 2: Mark Complete with billing details
            dx_codes = claim.diagnosis_codes or ["Z71.89"]
            await self.complete_activity(
                pear_activity_id=pear_activity_id,
                pear_member_id=pear_member_id,
                chw_user_id=chw_user_id,
                service_date=claim.service_date,
                diagnosis_codes=dx_codes,
                session_id=claim.session_id,
            )

            # Step 3: Generate the claim
            claim_data_raw = await self.generate_claim(
                pear_member_id=pear_member_id,
                pear_activity_id=pear_activity_id,
                session_id=claim.session_id,
            )
            claim_data = claim_data_raw.get("data", {}) if isinstance(claim_data_raw.get("data"), dict) else {}
            pear_claim_id = claim_data.get("id") or claim_data.get("claimId")

            if not pear_claim_id:
                logger.error(
                    "pear_suite.submit_claim.no_claim_id: session=%s raw=%s",
                    claim.session_id,
                    claim_data_raw,
                )
                return ClaimResult(
                    success=False,
                    status="error",
                    message=(
                        f"Pear Suite did not return a claim ID. "
                        f"Activity ID={pear_activity_id} — check Pear dashboard manually."
                    ),
                )

            logger.info(
                "pear_suite.submit_claim.success: session=%s pear_claim_id=%s pear_activity_id=%s",
                claim.session_id,
                pear_claim_id,
                pear_activity_id,
            )
            return ClaimResult(
                success=True,
                provider_claim_id=pear_claim_id,
                status="submitted",
                raw_response=claim_data_raw,
            )

        except Exception as exc:  # noqa: BLE001
            logger.error(
                "pear_suite.submit_claim.error: session=%s error=%s",
                claim.session_id,
                exc,
                exc_info=True,
            )
            return ClaimResult(success=False, status="error", message=str(exc))

    async def get_claim_status(self, provider_claim_id: str) -> ClaimResult:
        """Poll claim status from Pear Suite via GET /api/beta/claims.

        Attempts GET /api/beta/claims?id=<id> first. If Pear's API uses a
        different filter parameter name, falls back to GET /api/beta/claims/:id
        (path-param style). Logs the response shape so we can identify the
        correct param during the demo.

        Args:
            provider_claim_id: The Pear Suite claim ID returned by generate_claim.

        Returns:
            ClaimResult with status mapped to our internal enum:
            submitted | paid | denied | needs_correction.
        """
        if provider_claim_id.startswith("pearsuite-stub-"):
            return ClaimResult(
                success=True,
                provider_claim_id=provider_claim_id,
                status="submitted",
                message="Stub claim — not a real Pear Suite claim ID",
            )

        logger.info(
            "pear_suite.get_claim_status: pear_claim_id=%s",
            provider_claim_id,
        )

        try:
            # Attempt query-param style first (most REST APIs use this pattern)
            data = await self._request(
                "GET",
                f"/api/beta/claims?id={provider_claim_id}",
            )
        except httpx.HTTPStatusError:
            # Fallback to path-param style
            logger.info(
                "pear_suite.get_claim_status.fallback_path_param: pear_claim_id=%s",
                provider_claim_id,
            )
            try:
                data = await self._request(
                    "GET",
                    f"/api/beta/claims/{provider_claim_id}",
                )
            except Exception as exc:  # noqa: BLE001
                logger.error(
                    "pear_suite.get_claim_status.error: pear_claim_id=%s error=%s",
                    provider_claim_id,
                    exc,
                )
                return ClaimResult(success=False, status="error", message=str(exc))

        if data.get("_placeholder"):
            return ClaimResult(success=False, status="unknown", message="Pear Suite not configured")

        # Normalize nested data envelope if present
        claim_obj = data.get("data", data) if isinstance(data.get("data"), dict) else data
        raw_status = claim_obj.get("status") or data.get("status")

        internal_status = _PEAR_STATUS_MAP.get(str(raw_status), "submitted")
        logger.info(
            "pear_suite.get_claim_status.result: pear_claim_id=%s raw_status=%s internal_status=%s",
            provider_claim_id,
            raw_status,
            internal_status,
        )

        return ClaimResult(
            success=True,
            provider_claim_id=provider_claim_id,
            status=internal_status,
            raw_response=data,
        )

    async def void_claim(self, provider_claim_id: str) -> ClaimResult:
        """Void/delete a claim via DELETE /api/beta/claims/:id.

        Args:
            provider_claim_id: The Pear Suite claim ID to void.

        Returns:
            ClaimResult with status="voided" on success.
        """
        if provider_claim_id.startswith("pearsuite-stub-"):
            logger.info("pear_suite.void_claim: stub id=%s — no-op", provider_claim_id)
            return ClaimResult(
                success=True,
                provider_claim_id=provider_claim_id,
                status="voided",
                message="Stub claim — void is a no-op",
            )

        idempotency_key = f"void-claim-{provider_claim_id}"
        logger.info(
            "pear_suite.void_claim: pear_claim_id=%s idempotency_key=%s",
            provider_claim_id,
            idempotency_key,
        )

        try:
            data = await self._request(
                "DELETE",
                f"/api/beta/claims/{provider_claim_id}",
                idempotency_key=idempotency_key,
            )
            if data.get("_placeholder"):
                return ClaimResult(success=False, status="unknown", message="Pear Suite not configured")

            logger.info(
                "pear_suite.void_claim.success: pear_claim_id=%s",
                provider_claim_id,
            )
            return ClaimResult(
                success=True,
                provider_claim_id=provider_claim_id,
                status="voided",
                raw_response=data,
            )
        except Exception as exc:  # noqa: BLE001
            logger.error(
                "pear_suite.void_claim.error: pear_claim_id=%s error=%s",
                provider_claim_id,
                exc,
                exc_info=True,
            )
            return ClaimResult(success=False, status="error", message=str(exc))

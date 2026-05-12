"""Admin endpoint for triggering a single end-to-end Pear Suite demo claim.

This router is intentionally separate from admin.py to keep demo-specific
code isolated. Mount it alongside the main admin router in app.main.

Endpoint:
    POST /api/v1/admin/pear-suite/demo-claim

Auth:
    Authorization: Bearer <ADMIN_KEY>  (same as all admin JSON endpoints)
    X-Admin-2FA-Token: <token>         (from POST /api/v1/admin/2fa/verify)

Purpose:
    Runs the full Pear Suite billing chain for a single Compass session:
      1. Load session + member profile + CHW profile
      2. Sync member to Pear Suite (idempotent — skips if already synced)
      3. Schedule an activity using Jemal's CHW user ID and the T1016 template
      4. Mark the activity Complete with billing details
      5. Generate the claim
      6. Poll claim status to confirm it landed
      7. Return a structured JSON response with all Pear IDs and a dashboard hint

All steps are heavily logged at INFO level. PHI (mediCalId, DX codes in full)
is never logged — only Pear Suite IDs and status values.
"""

import logging
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.dependencies import require_admin_key
from app.models.session import Session
from app.models.user import CHWProfile, MemberProfile, User
from app.routers.admin import require_2fa_token
from app.services.billing.pear_suite_provider import PearSuiteProvider
from app.services.pear_suite_member_sync import ensure_member_synced, get_pear_suite_provider

logger = logging.getLogger("compass.admin.demo")

router = APIRouter(prefix="/api/v1/admin", tags=["admin-demo"])


class DemoClaimRequest(BaseModel):
    """Request body for the demo-claim endpoint."""
    session_id: UUID


class DemoClaimResponse(BaseModel):
    """Response from the demo-claim endpoint.

    All Pear Suite IDs are returned so they can be cross-referenced in the
    Pear Suite dashboard. The view_url_hint is a plain-language reminder for
    Jemal to check the dashboard directly.
    """
    pear_member_id: str
    pear_activity_id: str
    pear_claim_id: str
    claim_status: str
    view_url_hint: str


def _get_default_dx_codes() -> list[str]:
    """Return the default ICD-10 diagnosis codes for demo claims.

    Reads from settings.pear_suite_default_dx_codes. Falls back to Z71.89
    (generic counseling code appropriate for CHW services) if not configured.
    """
    codes = getattr(settings, "pear_suite_default_dx_codes", None)
    if codes and isinstance(codes, list) and len(codes) > 0:
        return codes
    return ["Z71.89"]


@router.post(
    "/pear-suite/demo-claim",
    response_model=DemoClaimResponse,
    summary="Submit a single demo claim to production Pear Suite (admin only)",
)
async def submit_demo_claim(
    body: DemoClaimRequest,
    _key: bool = Depends(require_admin_key),
    _2fa: None = Depends(require_2fa_token),
    db: AsyncSession = Depends(get_db),
) -> DemoClaimResponse:
    """Orchestrate a full end-to-end Pear Suite claim for a given session.

    This is the demo path — real Pear API, fake member data. Jemal (CHW) must
    have pear_suite_user_id set on his CHWProfile before calling this endpoint.
    The T1016 template ID must be set via PEAR_SUITE_T1016_TEMPLATE_ID env var.

    Steps:
      1. Load session, member User + MemberProfile, CHW User + CHWProfile
      2. Validate CHW has pear_suite_user_id; validate T1016 template is configured
      3. ensure_member_synced → pear_member_id (idempotent)
      4. POST /api/beta/activities → pear_activity_id
      5. PUT /api/beta/activities/:id (Complete + billingDetails) → confirmation
      6. POST /api/beta/claims → pear_claim_id
      7. GET /api/beta/claims status → claim_status
      8. Return structured response

    Returns:
        DemoClaimResponse with all Pear Suite IDs and a dashboard hint.

    Raises:
        HTTP 400: session not found, CHW missing pear_suite_user_id, T1016 template not configured.
        HTTP 502: Pear Suite API returned an unexpected error.
    """
    session_id = body.session_id
    logger.info(
        "demo_claim.start: session_id=%s initiated_at=%s",
        session_id,
        datetime.now(UTC).isoformat(),
    )

    # ── Step 1: Load session ──────────────────────────────────────────────────
    session_row: Session | None = await db.get(Session, session_id)
    if session_row is None:
        logger.error("demo_claim.session_not_found: session_id=%s", session_id)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Session {session_id} not found.",
        )

    logger.info(
        "demo_claim.session_loaded: session_id=%s chw_id=%s member_id=%s "
        "vertical=%s status=%s",
        session_id,
        session_row.chw_id,
        session_row.member_id,
        session_row.vertical,
        session_row.status,
    )

    # ── Step 2: Load member User + MemberProfile ──────────────────────────────
    member_user_row: User | None = await db.get(User, session_row.member_id)
    if member_user_row is None:
        logger.error(
            "demo_claim.member_user_not_found: session_id=%s member_id=%s",
            session_id,
            session_row.member_id,
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Member user {session_row.member_id} not found.",
        )

    member_profile_result = await db.execute(
        select(MemberProfile).where(MemberProfile.user_id == session_row.member_id)
    )
    member_profile: MemberProfile | None = member_profile_result.scalar_one_or_none()
    if member_profile is None:
        logger.error(
            "demo_claim.member_profile_not_found: session_id=%s member_id=%s",
            session_id,
            session_row.member_id,
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"MemberProfile for user {session_row.member_id} not found.",
        )

    logger.info(
        "demo_claim.member_loaded: session_id=%s member_user_id=%s "
        "already_synced=%s",
        session_id,
        member_user_row.id,
        bool(member_profile.pear_suite_member_id),
    )

    # ── Step 3: Load CHW User + CHWProfile ────────────────────────────────────
    chw_user_row: User | None = await db.get(User, session_row.chw_id)
    if chw_user_row is None:
        logger.error(
            "demo_claim.chw_user_not_found: session_id=%s chw_id=%s",
            session_id,
            session_row.chw_id,
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"CHW user {session_row.chw_id} not found.",
        )

    chw_profile_result = await db.execute(
        select(CHWProfile).where(CHWProfile.user_id == session_row.chw_id)
    )
    chw_profile: CHWProfile | None = chw_profile_result.scalar_one_or_none()
    if chw_profile is None:
        logger.error(
            "demo_claim.chw_profile_not_found: session_id=%s chw_id=%s",
            session_id,
            session_row.chw_id,
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"CHWProfile for user {session_row.chw_id} not found.",
        )

    # ── Step 4: Validate CHW has pear_suite_user_id ───────────────────────────
    chw_pear_user_id: str | None = chw_profile.pear_suite_user_id
    if not chw_pear_user_id:
        logger.error(
            "demo_claim.chw_missing_pear_user_id: session_id=%s chw_id=%s "
            "Fix: set pear_suite_user_id on chw_profiles row for this CHW. "
            "Obtain the userId from the Pear Suite dashboard → Users.",
            session_id,
            session_row.chw_id,
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"CHW {session_row.chw_id} ({chw_user_row.name}) does not have a "
                "pear_suite_user_id set. "
                "Obtain Jemal's userId from the Pear Suite dashboard → Users, then "
                "UPDATE chw_profiles SET pear_suite_user_id = '<id>' WHERE user_id = '<chw_id>'."
            ),
        )

    logger.info(
        "demo_claim.chw_validated: session_id=%s chw_id=%s pear_user_id=%s",
        session_id,
        session_row.chw_id,
        chw_pear_user_id,
    )

    # ── Step 5: Validate T1016 template ID ───────────────────────────────────
    template_id: str = getattr(settings, "pear_suite_t1016_template_id", "")
    if not template_id:
        logger.error(
            "demo_claim.missing_template_id: session_id=%s "
            "Fix: set PEAR_SUITE_T1016_TEMPLATE_ID in the environment. "
            "Obtain the template ID from Pear Suite dashboard → Activity Templates.",
            session_id,
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "PEAR_SUITE_T1016_TEMPLATE_ID is not configured. "
                "Obtain the T1016 activity template ID from the Pear Suite dashboard "
                "→ Activity Templates, then set it as an environment variable."
            ),
        )

    logger.info(
        "demo_claim.template_validated: session_id=%s template_id=%s",
        session_id,
        template_id,
    )

    # ── Step 6: Resolve service date ──────────────────────────────────────────
    # Use session.ended_at if available; fall back to scheduled_at; fall back to today.
    service_datetime = (
        session_row.ended_at
        or session_row.scheduled_at
        or datetime.now(UTC)
    )
    service_date = service_datetime.date()
    logger.info(
        "demo_claim.service_date: session_id=%s service_date=%s",
        session_id,
        service_date.isoformat(),
    )

    # ── Step 7: Resolve diagnosis codes ──────────────────────────────────────
    dx_codes = _get_default_dx_codes()
    logger.info(
        "demo_claim.dx_codes: session_id=%s codes=%s",
        session_id,
        dx_codes,
    )

    # ── Step 8: Get provider ──────────────────────────────────────────────────
    try:
        provider: PearSuiteProvider = get_pear_suite_provider()
    except Exception as exc:
        logger.error(
            "demo_claim.provider_init_error: session_id=%s error=%s",
            session_id,
            exc,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Billing provider init error: {exc}",
        ) from exc

    # ── Step 9: Sync member to Pear Suite ────────────────────────────────────
    logger.info("demo_claim.member_sync: session_id=%s", session_id)
    try:
        pear_member_id = await ensure_member_synced(db, member_profile, member_user_row)
    except Exception as exc:
        logger.error(
            "demo_claim.member_sync_error: session_id=%s error=%s",
            session_id,
            exc,
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Member sync to Pear Suite failed: {exc}",
        ) from exc

    logger.info(
        "demo_claim.member_synced: session_id=%s pear_member_id=%s",
        session_id,
        pear_member_id,
    )

    # ── Step 10: Schedule activity ────────────────────────────────────────────
    logger.info(
        "demo_claim.schedule_activity: session_id=%s template_id=%s chw_user_id=%s",
        session_id,
        template_id,
        chw_pear_user_id,
    )
    try:
        activity_data = await provider.schedule_activity(
            activity_template_id=template_id,
            member_ids=[pear_member_id],
            chw_user_id=chw_pear_user_id,
            service_date=service_date,
            session_id=session_id,
            notes=f"Compass session {session_id} — demo claim",
        )
    except Exception as exc:
        logger.error(
            "demo_claim.schedule_activity_error: session_id=%s error=%s",
            session_id,
            exc,
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Pear Suite schedule activity failed: {exc}",
        ) from exc

    pear_activity_id = activity_data.get("id") or activity_data.get("activityId")
    if not pear_activity_id:
        logger.error(
            "demo_claim.schedule_activity_no_id: session_id=%s response=%s",
            session_id,
            activity_data,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=(
                "Pear Suite returned a successful response but no activity ID. "
                f"Response keys: {list(activity_data.keys())}. "
                "Check the Pear Suite dashboard manually."
            ),
        )

    logger.info(
        "demo_claim.activity_scheduled: session_id=%s pear_activity_id=%s",
        session_id,
        pear_activity_id,
    )

    # ── Step 11: Complete activity with billing details ───────────────────────
    logger.info(
        "demo_claim.complete_activity: session_id=%s pear_activity_id=%s",
        session_id,
        pear_activity_id,
    )
    try:
        await provider.complete_activity(
            pear_activity_id=pear_activity_id,
            pear_member_id=pear_member_id,
            chw_user_id=chw_pear_user_id,
            service_date=service_date,
            diagnosis_codes=dx_codes,
            session_id=session_id,
        )
    except Exception as exc:
        logger.error(
            "demo_claim.complete_activity_error: session_id=%s "
            "pear_activity_id=%s error=%s",
            session_id,
            pear_activity_id,
            exc,
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Pear Suite complete activity failed: {exc}",
        ) from exc

    logger.info(
        "demo_claim.activity_completed: session_id=%s pear_activity_id=%s",
        session_id,
        pear_activity_id,
    )

    # ── Step 12: Generate claim ───────────────────────────────────────────────
    logger.info(
        "demo_claim.generate_claim: session_id=%s pear_member_id=%s "
        "pear_activity_id=%s",
        session_id,
        pear_member_id,
        pear_activity_id,
    )
    try:
        claim_raw = await provider.generate_claim(
            pear_member_id=pear_member_id,
            pear_activity_id=pear_activity_id,
            session_id=session_id,
        )
    except Exception as exc:
        logger.error(
            "demo_claim.generate_claim_error: session_id=%s "
            "pear_activity_id=%s error=%s",
            session_id,
            pear_activity_id,
            exc,
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=(
                f"Pear Suite generate claim failed: {exc}. "
                f"Activity ID={pear_activity_id} — check Pear dashboard manually."
            ),
        ) from exc

    claim_data = (
        claim_raw.get("data", {})
        if isinstance(claim_raw.get("data"), dict)
        else {}
    )
    pear_claim_id = claim_data.get("id") or claim_data.get("claimId")
    if not pear_claim_id:
        logger.error(
            "demo_claim.generate_claim_no_id: session_id=%s raw=%s",
            session_id,
            claim_raw,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=(
                "Pear Suite returned a successful response but no claim ID. "
                f"Activity ID={pear_activity_id} — check Pear dashboard. "
                f"Response keys: {list(claim_raw.keys())}."
            ),
        )

    logger.info(
        "demo_claim.claim_generated: session_id=%s pear_claim_id=%s",
        session_id,
        pear_claim_id,
    )

    # ── Step 13: Poll claim status ────────────────────────────────────────────
    logger.info(
        "demo_claim.poll_status: session_id=%s pear_claim_id=%s",
        session_id,
        pear_claim_id,
    )
    try:
        status_result = await provider.get_claim_status(pear_claim_id)
        claim_status = status_result.status
    except Exception as exc:
        # Status poll failure is non-fatal — claim was generated, just can't confirm status.
        logger.warning(
            "demo_claim.poll_status_error: session_id=%s pear_claim_id=%s error=%s "
            "(non-fatal — claim was generated, check dashboard for status)",
            session_id,
            pear_claim_id,
            exc,
        )
        claim_status = "submitted"

    logger.info(
        "demo_claim.complete: session_id=%s pear_member_id=%s "
        "pear_activity_id=%s pear_claim_id=%s claim_status=%s",
        session_id,
        pear_member_id,
        pear_activity_id,
        pear_claim_id,
        claim_status,
    )

    return DemoClaimResponse(
        pear_member_id=pear_member_id,
        pear_activity_id=pear_activity_id,
        pear_claim_id=pear_claim_id,
        claim_status=claim_status,
        view_url_hint=(
            "Log into your Pear Suite dashboard to see the claim. "
            "Navigate to: Claims → search by member or claim ID above."
        ),
    )

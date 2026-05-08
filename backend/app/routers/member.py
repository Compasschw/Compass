from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import require_role
from app.schemas.followup import RoadmapItemResponse
from app.schemas.member import CHWMemberFacingProfile
from app.schemas.user import MemberProfileResponse, MemberProfileUpdate

router = APIRouter(prefix="/api/v1/member", tags=["member"])

@router.get("/profile", response_model=MemberProfileResponse)
async def get_profile(current_user=Depends(require_role("member")), db: AsyncSession = Depends(get_db)):
    from app.models.user import MemberProfile
    result = await db.execute(select(MemberProfile).where(MemberProfile.user_id == current_user.id))
    profile = result.scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
    # Merge associated User fields into the response so the mobile screen
    # can render phone/email/name without a second round trip.
    return MemberProfileResponse(
        id=profile.id,
        user_id=profile.user_id,
        zip_code=profile.zip_code,
        primary_language=profile.primary_language,
        primary_need=profile.primary_need,
        rewards_balance=profile.rewards_balance,
        insurance_provider=profile.insurance_provider,
        name=current_user.name,
        phone=current_user.phone,
        email=current_user.email,
    )

@router.put("/profile", response_model=MemberProfileResponse)
async def update_profile(data: MemberProfileUpdate, current_user=Depends(require_role("member")), db: AsyncSession = Depends(get_db)):
    """Upsert the member profile.

    Auto-creates the profile row if one doesn't exist — defensive cover for
    accounts created before the auth_service.register_user signup-time
    provisioning landed. New signups always have a profile row, so this
    branch only fires for legacy users.
    """
    from app.models.user import MemberProfile
    result = await db.execute(select(MemberProfile).where(MemberProfile.user_id == current_user.id))
    profile = result.scalar_one_or_none()
    if not profile:
        profile = MemberProfile(user_id=current_user.id)
        db.add(profile)
        await db.flush()
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(profile, field, value)
    await db.commit()
    await db.refresh(profile)
    # Re-read with the User join so the response matches GET /profile shape.
    return MemberProfileResponse(
        id=profile.id,
        user_id=profile.user_id,
        zip_code=profile.zip_code,
        primary_language=profile.primary_language,
        primary_need=profile.primary_need,
        rewards_balance=profile.rewards_balance,
        insurance_provider=profile.insurance_provider,
        name=current_user.name,
        phone=current_user.phone,
        email=current_user.email,
    )

@router.get("/rewards")
async def get_rewards(current_user=Depends(require_role("member")), db: AsyncSession = Depends(get_db)):
    from app.models.reward import RewardTransaction
    result = await db.execute(select(RewardTransaction).where(RewardTransaction.member_id == current_user.id).order_by(RewardTransaction.created_at.desc()).limit(50))
    return {"transactions": result.scalars().all()}


@router.get("/roadmap", response_model=list[RoadmapItemResponse])
async def get_my_roadmap(
    current_user=Depends(require_role("member")),
    db: AsyncSession = Depends(get_db),
):
    """Return follow-up items flagged for the member's roadmap.

    Filter: ``member_id == current_user`` AND ``show_on_roadmap == True``
    AND ``status != 'dismissed'``. Sorted by status (pending/confirmed first,
    then completed) and due_date ascending.

    NOTE: ``RoadmapItemResponse`` MUST be imported at module level (not inside
    the handler). FastAPI resolves ``response_model`` at app-registration time,
    not request time, so a string forward reference like
    ``response_model=list["RoadmapItemResponse"]`` paired with a lazy in-handler
    import raises:
      pydantic.errors.PydanticUserError: TypeAdapter ... is not fully defined
    on the first request and 500s every roadmap fetch.
    """
    from app.models.followup import SessionFollowup

    result = await db.execute(
        select(SessionFollowup)
        .where(
            SessionFollowup.member_id == current_user.id,
            SessionFollowup.show_on_roadmap.is_(True),
            SessionFollowup.status != "dismissed",
        )
        .order_by(
            SessionFollowup.status.asc(),
            SessionFollowup.due_date.asc().nullslast(),
            SessionFollowup.created_at.desc(),
        )
    )
    return result.scalars().all()


@router.delete("/account", status_code=status.HTTP_204_NO_CONTENT)
async def delete_my_account(
    current_user=Depends(require_role("member")),
    db: AsyncSession = Depends(get_db),
):
    """Member-initiated account deletion. Required by HIPAA 45 CFR §164.526.

    Policy: soft delete — we mark the user `is_active=False`, clear PHI fields
    (name, phone, medi_cal_id, address), revoke all refresh tokens, and preserve
    billing/session records as pseudonymized data for the 7-year Medi-Cal
    retention window. After 30 days of soft-delete, a scheduled job hard-deletes
    profile records that are no longer required for billing audit.

    Regulatory note: Medi-Cal requires 7-year retention of claims data (see
    22 CCR §51476). We cannot fully delete session/billing rows during that
    window, but we can strip identifiers so remaining data is pseudonymized.
    """
    from app.models.auth import RefreshToken
    from app.models.user import CHWProfile, MemberProfile, User

    # 1. Strip PHI from the User record, mark inactive
    user = await db.get(User, current_user.id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    pseudonym = f"deleted-user-{user.id}"
    user.name = pseudonym
    user.email = f"{pseudonym}@deleted.invalid"
    user.phone = None
    user.profile_picture_url = None
    user.is_active = False
    user.password_hash = ""  # prevent any future login attempts
    user.updated_at = datetime.now(UTC)

    # 2. Clear PHI from MemberProfile if exists
    mp_result = await db.execute(select(MemberProfile).where(MemberProfile.user_id == user.id))
    member_profile = mp_result.scalar_one_or_none()
    if member_profile:
        member_profile.medi_cal_id = None
        member_profile.insurance_provider = None
        member_profile.zip_code = None
        member_profile.latitude = None
        member_profile.longitude = None
        member_profile.additional_needs = None

    # 3. Clear CHWProfile PHI if exists (member accounts typically don't have one,
    #    but we defend against bad state)
    chw_result = await db.execute(select(CHWProfile).where(CHWProfile.user_id == user.id))
    chw_profile = chw_result.scalar_one_or_none()
    if chw_profile:
        chw_profile.bio = None
        chw_profile.zip_code = None
        chw_profile.latitude = None
        chw_profile.longitude = None
        chw_profile.is_available = False

    # 4. Revoke all refresh tokens — user is logged out everywhere
    token_result = await db.execute(
        select(RefreshToken).where(RefreshToken.user_id == user.id, RefreshToken.revoked == False)  # noqa: E712
    )
    for token in token_result.scalars():
        token.revoked = True

    await db.commit()
    return None


# ─── Member-facing CHW Profile ────────────────────────────────────────────────


def _format_years_experience(years: int) -> str:
    """Convert an integer years_experience value to a human-readable bracket.

    CHWProfile stores years_experience as an integer (default 0).  Members see
    a friendlier label instead of the raw number.

    Examples:
        0  → "<1 year"
        1  → "1 year"
        2  → "2 years"
        10 → "10 years"
    """
    if years < 1:
        return "<1 year"
    if years == 1:
        return "1 year"
    return f"{years} years"


def _extract_available_days(availability_windows: dict | None) -> list[str]:
    """Extract day-abbreviation keys from the CHWProfile.availability_windows JSONB.

    The JSONB schema stores availability as a dict keyed by lowercase day
    abbreviations (e.g. {"mon": "9-17", "wed": "9-17", "fri": "9-17"}).
    When the field is None or not a dict, we fall back to an empty list so
    callers never receive a null.

    Args:
        availability_windows: The raw JSONB value from CHWProfile, which may
            be None, an empty dict, or a populated schedule dict.

    Returns:
        A sorted list of day-abbreviation strings, e.g. ["fri", "mon", "wed"].
    """
    if not availability_windows or not isinstance(availability_windows, dict):
        return []
    return sorted(availability_windows.keys())


@router.get("/chws/{chw_id}", response_model=CHWMemberFacingProfile)
async def get_chw_member_facing_profile(
    chw_id: UUID,
    current_user=Depends(require_role("member")),
    db: AsyncSession = Depends(get_db),
) -> CHWMemberFacingProfile:
    """Return the public-style CHW profile to an authenticated member.

    Any authenticated member may view any CHW's public profile — there is no
    relationship gate on this endpoint (unlike the inverse CHW→member endpoint
    which requires an active session or service request).

    Visibility rules:
    - The chw_id must correspond to a User with role == "chw". Returns 404
      if the user doesn't exist, is not a CHW, or is inactive / deleted.
    - CHWProfile fields are read defensively; missing fields fall back to
      sensible defaults (None, [], False) rather than raising a 500.

    The ``shared_session_count`` is scoped to the calling member only: it
    counts sessions WHERE chw_id == path_param AND member_id == current_user.id
    regardless of session status (scheduled, in_progress, completed, cancelled).

    HIPAA minimum-necessary (45 CFR §164.514(d)):
    - CHW phone and email are NOT returned — members contact CHWs through the
      Compass platform (session initiation, in-app messaging).
    - Stripe / payout fields are NOT returned — irrelevant to a member.
    - Full caseload or per-member details for other members are NOT returned.
    """
    from app.models.user import CHWProfile, User

    # ── Resolve the CHW user row ──────────────────────────────────────────────
    # Require role == "chw" and is_active so deactivated/deleted accounts
    # don't surface in member-facing discovery. deleted_at IS NULL is an
    # additional guard for soft-deleted accounts.
    user_result = await db.execute(
        select(User)
        .where(User.id == chw_id)
        .where(User.role == "chw")
        .where(User.is_active.is_(True))
        .where(User.deleted_at.is_(None))
    )
    chw_user = user_result.scalar_one_or_none()
    if chw_user is None:
        raise HTTPException(status_code=404, detail="CHW not found.")

    # ── Fetch CHWProfile (may not exist for newly-registered CHWs) ───────────
    profile_result = await db.execute(
        select(CHWProfile).where(CHWProfile.user_id == chw_id)
    )
    chw_profile = profile_result.scalar_one_or_none()

    # ── Fetch CHWIntake for cert + modality fields ────────────────────────────
    # CHWIntake is stored in the chw_intake table (not in CHWProfile). We import
    # it here to avoid a circular import at module level. It may not exist for
    # newly-registered CHWs who haven't completed the questionnaire.
    ca_chw_certified = False
    modality: str | None = None
    try:
        from app.models.chw_intake import CHWIntakeResponse  # noqa: PLC0415

        intake_result = await db.execute(
            select(CHWIntakeResponse).where(CHWIntakeResponse.user_id == chw_id)
        )
        intake = intake_result.scalar_one_or_none()
        if intake is not None:
            ca_chw_certified = getattr(intake, "ca_chw_certificate", None) == "yes"
            raw_modality = getattr(intake, "preferred_modality", None)
            # Map intake values to the canonical three-state enum.
            # The intake questionnaire uses values like "in_person", "virtual",
            # "hybrid" (or "both" as an older alias for "hybrid").
            _MODALITY_MAP: dict[str, str] = {
                "in_person": "in_person",
                "virtual": "virtual",
                "hybrid": "hybrid",
                "both": "hybrid",
            }
            modality = _MODALITY_MAP.get(raw_modality or "", None)
    except ImportError:
        # CHWIntakeResponse model may not exist in all migration states.
        pass

    # ── Split CHW display name into first / last ──────────────────────────────
    # User.name stores the full display name as a single string. We split on
    # the first space; any additional tokens are treated as part of the last name.
    name_parts = (chw_user.name or "").strip().split(" ", 1)
    first_name = name_parts[0] if name_parts else ""
    last_name_raw = name_parts[1] if len(name_parts) > 1 else ""

    # Privacy shorthand: first character of last name + period.
    # Guards against empty last_name (e.g. single-name account).
    last_name_initial = f"{last_name_raw[0].upper()}." if last_name_raw else ""

    # ── Build language fields from CHWProfile.languages ───────────────────────
    all_languages: list[str] = (chw_profile.languages or []) if chw_profile else []
    primary_language = all_languages[0] if all_languages else "English"
    additional_languages = all_languages[1:] if len(all_languages) > 1 else []

    # ── Primary specialization ────────────────────────────────────────────────
    all_specializations: list[str] = (
        (chw_profile.specializations or []) if chw_profile else []
    )
    primary_specialization = all_specializations[0] if all_specializations else None

    # ── Years experience bracket ──────────────────────────────────────────────
    years_experience: str | None = None
    if chw_profile is not None:
        years_experience = _format_years_experience(chw_profile.years_experience or 0)

    # ── Service area ZIPs ─────────────────────────────────────────────────────
    # Today: single-ZIP from CHWProfile.zip_code; Phase 2 adds multi-ZIP table.
    service_area_zips: list[str] = []
    if chw_profile is not None and chw_profile.zip_code:
        service_area_zips = [chw_profile.zip_code]

    # ── Available days from availability_windows JSONB ────────────────────────
    available_days = _extract_available_days(
        chw_profile.availability_windows if chw_profile else None
    )

    # ── Shared session count (member-scoped) ──────────────────────────────────
    # Count ALL sessions between this CHW and the calling member — any status.
    # This tells the member "we've worked together N times" for social proof.
    from app.models.session import Session  # noqa: PLC0415

    session_count_result = await db.execute(
        select(func.count())
        .select_from(Session)
        .where(Session.chw_id == chw_id)
        .where(Session.member_id == current_user.id)
    )
    shared_session_count: int = session_count_result.scalar() or 0

    return CHWMemberFacingProfile(
        id=chw_user.id,
        first_name=first_name,
        last_name_initial=last_name_initial,
        primary_language=primary_language,
        additional_languages=additional_languages,
        primary_specialization=primary_specialization,
        years_experience=years_experience,
        ca_chw_certified=ca_chw_certified,
        modality=modality,
        service_area_zips=service_area_zips,
        available_days=available_days,
        shared_session_count=shared_session_count,
    )

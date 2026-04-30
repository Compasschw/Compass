"""CHW professional intake questionnaire endpoints.

Flow:
  1. After signup, CHW is prompted to complete the intake (~5 min, 27 questions)
  2. Mobile app calls GET /chw/intake on each resume to prefill + show progress
  3. Mobile app calls PATCH /chw/intake after each section to save progress
  4. Mobile app calls POST /chw/intake/submit when the CHW taps "Submit"
  5. `users.is_onboarded` is left alone — that flag tracks signup completion,
     not intake completion, so they're independent states.

Validation:
  - Each question is single-select, and the allowed option codes live in
    VALID_OPTIONS below. Unknown codes reject with 422.
  - Free-text "Other" overrides are capped at 100 chars and only relevant
    when the corresponding single-select is set to "other".
"""

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.dependencies import require_role

router = APIRouter(prefix="/api/v1/chw/intake", tags=["chw-intake"])


# ─── Allowed option codes per question ───────────────────────────────────────
# Keys match column names on CHWIntakeResponse. Each value is the set of
# acceptable option codes for that question. These mirror the PDF exactly.

VALID_OPTIONS: dict[str, set[str]] = {
    # Section 1 — About You
    # `no_experience` added per Jemal feedback ("what if they haven't worked
    # in any role as CHW?"). The original question framing assumed prior
    # experience; we now accept candidates who are new to the role.
    "years_experience": {
        "no_experience",
        "less_than_1_year", "1_2_years", "3_5_years", "6_10_years", "more_than_10_years",
    },
    "employment_status": {
        "full_time", "part_time", "contract", "volunteer", "seeking",
    },
    # `middle_school` added per Jemal feedback. We don't gate on this — the
    # answer is informational and used by the matching service to surface
    # entry-level training resources when needed.
    "education_level": {
        "middle_school",
        "hs_ged", "some_college", "associates", "bachelors", "graduate",
    },
    # `case_management` added per Jemal feedback ("Add an option for case
    # management or something similar"). Many CHW-adjacent practitioners
    # come from case-management or social-work settings.
    "primary_setting": {
        "cbo", "mcp", "fqhc", "hospital", "county_public_health", "case_management",
    },
    # Section 2 — Credentials
    "ca_chw_certificate": {
        "yes_accredited", "in_progress", "no_not_pursued", "related_not_chw",
    },
    "training_pathway": {
        "ca_accredited", "employer_sponsored", "county_local", "on_the_job", "self_directed",
    },
    "additional_certification": {
        "cpss", "medical_assistant", "cna", "ches", "none",
    },
    "medi_cal_familiarity": {
        "yes_direct", "somewhat", "heard_need_training", "not_familiar", "being_trained",
    },
    "ehr_experience": {
        "proficient_multiple", "familiar_one", "basic", "limited", "none",
    },
    # Section 3 — Languages
    "primary_language": {
        "english", "spanish", "mandarin_cantonese", "vietnamese", "other",
    },
    "other_language_fluency": {
        "fluent_one", "fluent_two_plus", "conversational", "basic_phrases", "english_only",
    },
    "additional_language": {
        "spanish", "mandarin_cantonese", "vietnamese", "tagalog", "korean",
        "hmong", "armenian", "other",
    },
    "cultural_competency_training": {
        "formal_employer", "certificate_program", "informal", "in_progress", "none",
    },
    "lived_experience": {
        "current_member", "former_member", "shared_cultural", "limited",
        "professional_only",
    },
    # Section 4 — Expertise
    "primary_specialization": {
        "chronic_disease", "behavioral_health", "maternal_child",
        "housing_social", "cancer_prevention",
    },
    "sdoh_experience": {
        "extensive", "some", "trained_limited", "currently_learning", "none",
    },
    "population_experience": {
        "older_adults", "children_adolescents", "homelessness_calaim",
        "justice_jcip", "refugee_immigrant",
    },
    "motivational_interviewing": {
        "trained_regular", "trained_occasional", "familiar_limited",
        "being_trained", "none",
    },
    "hedis_experience": {
        "extensive", "some", "general_care_gap", "learning", "none",
    },
    # Section 5 — Work Setting
    "preferred_modality": {
        "in_person", "remote", "hybrid_in_person", "hybrid_remote", "flexible",
    },
    "home_visit_comfort": {
        "prefer", "comfortable_safety", "certain_only", "rarely", "no",
    },
    "telehealth_comfort": {
        "highly_experienced", "comfortable", "somewhat", "prefer_in_person", "no",
    },
    "transportation": {
        "personal_vehicle", "public_transit", "reimbursement_required",
        "limited", "not_applicable",
    },
    "preferred_caseload": {
        "small", "moderate", "large", "high_volume", "flexible",
    },
    # Section 6 — Availability
    "preferred_schedule": {
        "weekdays_standard", "flexible_weekday", "evenings", "weekends", "rotating",
    },
    "preferred_employment_type": {
        "full_time_40", "part_time_20_32", "per_diem", "contract_temporary", "flexible",
    },
    "urgent_outreach": {
        "regularly", "occasionally", "rarely", "scheduled_only", "depends_caseload",
    },
}


# ─── Schemas ─────────────────────────────────────────────────────────────────


class IntakeUpdate(BaseModel):
    """Partial update — any field may be omitted; only present fields are saved."""

    model_config = ConfigDict(extra="forbid")

    # Section 1
    years_experience: str | None = None
    employment_status: str | None = None
    education_level: str | None = None
    primary_setting: str | None = None
    # Section 2
    ca_chw_certificate: str | None = None
    training_pathway: str | None = None
    additional_certification: str | None = None
    medi_cal_familiarity: str | None = None
    ehr_experience: str | None = None
    # Section 3
    primary_language: str | None = None
    other_language_fluency: str | None = None
    additional_language: str | None = None
    cultural_competency_training: str | None = None
    lived_experience: str | None = None
    # Section 4
    primary_specialization: str | None = None
    sdoh_experience: str | None = None
    population_experience: str | None = None
    motivational_interviewing: str | None = None
    hedis_experience: str | None = None
    # Section 5
    preferred_modality: str | None = None
    home_visit_comfort: str | None = None
    telehealth_comfort: str | None = None
    transportation: str | None = None
    preferred_caseload: str | None = None
    # Section 6
    preferred_schedule: str | None = None
    preferred_employment_type: str | None = None
    urgent_outreach: str | None = None
    # Free-text
    primary_language_other: str | None = Field(default=None, max_length=100)
    additional_language_other: str | None = Field(default=None, max_length=100)
    # Progress
    last_completed_section: int | None = Field(default=None, ge=0, le=6)


class IntakeResponse(BaseModel):
    """Full read of a CHW's intake state."""

    model_config = ConfigDict(from_attributes=True)

    # Section 1
    years_experience: str | None = None
    employment_status: str | None = None
    education_level: str | None = None
    primary_setting: str | None = None
    # Section 2
    ca_chw_certificate: str | None = None
    training_pathway: str | None = None
    additional_certification: str | None = None
    medi_cal_familiarity: str | None = None
    ehr_experience: str | None = None
    # Section 3
    primary_language: str | None = None
    other_language_fluency: str | None = None
    additional_language: str | None = None
    cultural_competency_training: str | None = None
    lived_experience: str | None = None
    # Section 4
    primary_specialization: str | None = None
    sdoh_experience: str | None = None
    population_experience: str | None = None
    motivational_interviewing: str | None = None
    hedis_experience: str | None = None
    # Section 5
    preferred_modality: str | None = None
    home_visit_comfort: str | None = None
    telehealth_comfort: str | None = None
    transportation: str | None = None
    preferred_caseload: str | None = None
    # Section 6
    preferred_schedule: str | None = None
    preferred_employment_type: str | None = None
    urgent_outreach: str | None = None
    # Free-text
    primary_language_other: str | None = None
    additional_language_other: str | None = None
    # Progress
    last_completed_section: int = 0
    completed_at: datetime | None = None


# ─── Helpers ────────────────────────────────────────────────────────────────


def _validate_options(payload: dict[str, Any]) -> None:
    """Raise 422 if any provided option code isn't in the allowed set.

    Only validates keys that appear in VALID_OPTIONS (free-text + metadata
    fields are exempt).
    """
    for field_name, value in payload.items():
        if value is None or field_name not in VALID_OPTIONS:
            continue
        if value not in VALID_OPTIONS[field_name]:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Invalid option {value!r} for {field_name!r}.",
            )


async def _get_or_create(db: AsyncSession, user_id: Any):
    """Return the CHW's intake row, creating an empty one on first call."""
    from app.models.chw_intake import CHWIntakeResponse

    result = await db.execute(
        select(CHWIntakeResponse).where(CHWIntakeResponse.user_id == user_id)
    )
    row = result.scalar_one_or_none()
    if row is None:
        row = CHWIntakeResponse(user_id=user_id)
        db.add(row)
        await db.commit()
        await db.refresh(row)
    return row


# ─── Endpoints ──────────────────────────────────────────────────────────────


@router.get("", response_model=IntakeResponse)
async def get_intake(
    current_user=Depends(require_role("chw")),
    db: AsyncSession = Depends(get_db),
):
    """Return the CHW's current intake state (creates an empty row on first call)."""
    row = await _get_or_create(db, current_user.id)
    return row


@router.patch("", response_model=IntakeResponse)
async def patch_intake(
    data: IntakeUpdate,
    current_user=Depends(require_role("chw")),
    db: AsyncSession = Depends(get_db),
):
    """Save partial progress. Pass any subset of fields; omitted fields are untouched.

    Does NOT mark the intake as complete — that's what /submit is for.
    """
    payload = data.model_dump(exclude_unset=True)
    if not payload:
        raise HTTPException(status_code=400, detail="No fields provided.")

    _validate_options(payload)

    row = await _get_or_create(db, current_user.id)
    for key, value in payload.items():
        setattr(row, key, value)
    await db.commit()
    await db.refresh(row)
    return row


@router.post("/submit", response_model=IntakeResponse)
async def submit_intake(
    current_user=Depends(require_role("chw")),
    db: AsyncSession = Depends(get_db),
):
    """Mark the intake as fully complete.

    Requires all 27 required questions to be answered. Returns 422 with a
    list of missing fields if any are still blank.
    """
    from app.models.chw_intake import CHWIntakeResponse

    result = await db.execute(
        select(CHWIntakeResponse).where(CHWIntakeResponse.user_id == current_user.id)
    )
    row = result.scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Intake not started yet.")

    # Optional fields per Jemal Figma feedback:
    #   - `training_pathway` (Q6): only relevant when the CHW holds or is
    #     pursuing a CA CHW certificate (Q5 = ca_chw_certificate). When Q5
    #     is "no_not_pursued", Q6 is hidden client-side.
    #   - `other_language_fluency` (Q11): redundant with `additional_language`
    #     (Q12) — if Q12 is set the member already speaks another language.
    OPTIONAL_FIELDS = {"training_pathway", "other_language_fluency"}
    required_fields = [f for f in VALID_OPTIONS.keys() if f not in OPTIONAL_FIELDS]
    missing = [f for f in required_fields if getattr(row, f) is None]
    if missing:
        # Friendlier human-readable list so the client can surface specific
        # questions to revisit (instead of opaque field names). The
        # structured `missing_fields` is preserved for any future client
        # that wants to navigate directly to those questions.
        readable = ", ".join(f.replace("_", " ").title() for f in missing[:5])
        more = f" (and {len(missing) - 5} more)" if len(missing) > 5 else ""
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "message": f"Intake is incomplete. Missing: {readable}{more}.",
                "missing_fields": missing,
            },
        )

    row.completed_at = datetime.now(UTC)
    row.last_completed_section = 6
    await db.commit()
    await db.refresh(row)
    return row

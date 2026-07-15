from datetime import date, datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schemas.cin_config import validate_cin_for_carrier as _validate_cin

# Pear Suite "sex" enum values accepted for the member's gender field.
_GENDER_VALUES = {"Male", "Female", "Other"}


class CHWProfileCreate(BaseModel):
    specializations: list[str] = []
    languages: list[str] = []
    bio: str | None = None
    zip_code: str | None = None
    phone: str | None = None

class CHWProfileResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    user_id: UUID
    specializations: list[str]
    languages: list[str]
    rating: float
    years_experience: int
    total_sessions: int
    is_available: bool
    bio: str | None
    zip_code: str | None
    # Surfaced from the associated User row so the Profile screens can render
    # name/email/phone without a separate /users/me call. Mirrors the
    # MemberProfileResponse shape. Always populated by /chw/profile.
    name: str | None = None
    email: str | None = None
    phone: str | None = None
    # Profile picture URL stored on the User row (S3 public bucket).
    # Null when no photo has been uploaded.
    profile_picture_url: str | None = None
    # ── Compliance ───────────────────────────────────────────────────────
    # Surfaced on the CHW Profile screen so the worker (and admins) can see
    # onboarding status at a glance. background_check_status is one of:
    # "not_started" | "pending" | "clear" | "consider".
    hipaa_training_completed: bool = False
    chw_certification: str | None = None
    background_check_status: str = "not_started"

class CHWProfileUpdate(BaseModel):
    # Lives on the User row (not CHWProfile) — routed explicitly in the endpoint.
    name: str | None = None
    specializations: list[str] | None = None
    languages: list[str] | None = None
    # Epic C3: capped at 120 chars to keep CHW profile cards scannable.
    # Enforced client-side (native/CHWProfileScreen) and here — an over-long
    # bio is rejected with 422 rather than silently truncated/stored.
    bio: str | None = Field(default=None, max_length=120)
    zip_code: str | None = None
    is_available: bool | None = None
    # QA-batch #3: was silently missing from this schema, so a PUT with
    # years_experience in the body passed Pydantic validation (extra fields
    # are ignored, not rejected) but the value never reached model_dump()'s
    # output and the handler's setattr loop never saw it — a silent no-op
    # bug. CHWProfile.years_experience already exists on the model; this
    # just lets the field flow through. Bounded 0-60 (a sanity ceiling, not
    # a real-world limit enforcement) so obviously-bad input 422s instead of
    # silently persisting.
    years_experience: int | None = Field(default=None, ge=0, le=60)
    # Optional: update the User.profile_picture_url after a presigned-URL upload.
    # Use an explicit sentinel (unset vs null) so callers can clear the photo by
    # sending null without accidentally wiping it when the field is simply absent.
    profile_picture_url: str | None = None
    # ── Compliance fields intentionally ABSENT (Epic D lockdown) ─────────
    # hipaa_training_completed / chw_certification / background_check_status
    # were previously CHW-editable here, which let a CHW self-write
    # background_check_status="clear" and bypass the chw_can_work gate
    # entirely. Post-Epic-D these change ONLY via the admin-verified
    # credential flow (routers/credentials.py) and the admin background-check
    # endpoint (routers/admin.py). Pydantic ignores unknown request keys, so
    # older clients that still send these fields no-op harmlessly instead of
    # erroring — the values can no longer reach the database from this route.

class MemberProfileCreate(BaseModel):
    zip_code: str | None = None
    primary_language: str = "English"
    primary_need: str | None = None
    insurance_provider: str | None = None

class MemberProfileResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    user_id: UUID
    zip_code: str | None
    primary_language: str
    primary_need: str | None
    rewards_balance: int
    # Surfaced from the associated User row so the mobile Profile screen can
    # render without a separate /users/me call.
    name: str | None = None
    phone: str | None = None
    # ISO-8601 timestamp set by POST /phone/confirm-verification. Null means the
    # stored phone has not been SMS-verified — the member Settings "Text
    # messages" card (SMS Output Spec 1) reads this to render its on/off state.
    phone_verified_at: datetime | None = None
    email: str | None = None
    insurance_provider: str | None = None
    # Profile picture URL stored on the User row (S3 public bucket).
    # Null when no photo has been uploaded.
    profile_picture_url: str | None = None
    # ── Full demographics (member-editable on their own profile) ──────────────
    # These mirror what a CHW sees on the member profile so the member can review
    # and edit the same fields. medi_cal_id (CIN) is returned in full here because
    # the response is member-only (require_role("member")) and the member is the
    # data subject — minimum-necessary does not restrict the subject's own view.
    preferred_name: str | None = None
    date_of_birth: date | None = None
    gender: str | None = None
    address_line1: str | None = None
    address_line2: str | None = None
    city: str | None = None
    state: str | None = None
    insurance_company: str | None = None
    medi_cal_id: str | None = None
    # Epic G2: True when this member is still on a CHW-assigned temporary
    # password and must set their own before continuing. See
    # User.must_change_password's docstring for the full rationale. Cleared
    # by a successful POST /auth/change-password.
    must_change_password: bool = False

class MemberProfileUpdate(BaseModel):
    zip_code: str | None = None
    primary_language: str | None = None
    primary_need: str | None = None
    insurance_provider: str | None = None
    preferred_mode: str | None = None
    # Medi-Cal beneficiary identification number — required for billing.
    # Stored encrypted at rest via the EncryptedString column type.
    medi_cal_id: str | None = None
    # Optional: update the User.profile_picture_url after a presigned-URL upload.
    # Sending null explicitly clears the photo; omitting the field is a no-op.
    profile_picture_url: str | None = None
    # ── Full demographics (member self-service edit) ──────────────────────────
    # name is routed to the User row; the rest live on MemberProfile. All are
    # optional so a partial PATCH-style update only touches the supplied fields.
    name: str | None = None
    preferred_name: str | None = None
    date_of_birth: date | None = None
    gender: str | None = None
    address_line1: str | None = None
    address_line2: str | None = None
    city: str | None = None
    state: str | None = None
    insurance_company: str | None = None

    @field_validator("medi_cal_id")
    @classmethod
    def _normalize_cin(cls, value: str | None) -> str | None:
        """Normalize and validate the CIN when one is supplied on edit.

        None / empty is left untouched (field is optional on PUT /member/profile).
        Accepts Medi-Cal CINs (^9\\d{7}[A-Z]\\d?$), 14-char BICs (extracted to
        10-char CIN), and commercial/Medicare IDs (^[A-Z0-9]{6,15}$).
        Cross-reference: normalize_cin() in app/schemas/cin_config.py.
        """
        if value is None:
            return None
        stripped = value.strip()
        if not stripped:
            return None
        normalized, is_valid = _validate_cin(stripped, None)
        if not is_valid:
            raise ValueError(
                "Double-check the member ID — Medi-Cal CINs look like 91234567A2."
            )
        return normalized

    @field_validator("gender")
    @classmethod
    def _validate_gender(cls, value: str | None) -> str | None:
        """Accept only the Pear Suite sex enum (Male/Female/Other) when supplied."""
        if value is None:
            return None
        v = value.strip().title()
        if not v:
            return None
        if v not in _GENDER_VALUES:
            raise ValueError(f"gender must be one of {sorted(_GENDER_VALUES)}")
        return v

    @field_validator("state")
    @classmethod
    def _normalize_state(cls, value: str | None) -> str | None:
        """Uppercase 2-letter USPS state code when supplied."""
        if value is None:
            return None
        v = value.strip().upper()
        if not v:
            return None
        if len(v) != 2 or not v.isalpha():
            raise ValueError("state must be a 2-letter USPS code (e.g. CA)")
        return v

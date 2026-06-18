import re
from datetime import date
from uuid import UUID

from pydantic import BaseModel, ConfigDict, field_validator

# Medi-Cal CIN: 8 digits + 1 letter (e.g. "12345678A"). Mirrors the signup
# validator in app/schemas/auth.py so member self-service edits enforce the
# same format the billing claim requires.
_CIN_PATTERN = re.compile(r"^\d{8}[A-Z]$")
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
    specializations: list[str] | None = None
    languages: list[str] | None = None
    bio: str | None = None
    zip_code: str | None = None
    is_available: bool | None = None
    # Optional: update the User.profile_picture_url after a presigned-URL upload.
    # Use an explicit sentinel (unset vs null) so callers can clear the photo by
    # sending null without accidentally wiping it when the field is simply absent.
    profile_picture_url: str | None = None
    # ── Compliance (CHW-editable) ────────────────────────────────────────
    hipaa_training_completed: bool | None = None
    chw_certification: str | None = None
    background_check_status: str | None = None

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
        """Validate + uppercase-normalize the CIN when one is supplied.

        Mirrors the signup validator: 8 digits + 1 letter (e.g. 12345678A).
        ``None`` / empty is left untouched (the field is optional on edit).
        """
        if value is None:
            return None
        cin = value.strip().upper()
        if not cin:
            return None
        if not _CIN_PATTERN.match(cin):
            raise ValueError("CIN must be 8 digits followed by 1 letter (e.g. 12345678A)")
        return cin

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

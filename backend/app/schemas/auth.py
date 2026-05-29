from datetime import date, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field, model_validator


# Sex values accepted by Pear Suite's CreateMember endpoint. Mirrors the
# member-signup dropdown options.
SexEnum = Literal["Male", "Female", "Other"]


class RegisterRequest(BaseModel):
    """Body for POST /auth/register.

    Hard-required for both roles: email, password, name, role.
    For members, `name` must include both a first and last name — Pear Suite
    rejects member creation when last_name is missing, and we split on
    whitespace downstream to populate Pear's firstName/lastName fields.
    The model validator below enforces "at least two non-empty whitespace-
    separated tokens" so a single-token name (e.g. "John") never reaches Pear.

    Members may additionally supply demographics + address + insurance
    captured by the expanded signup form.  All member-specific fields are
    optional at the API layer; the frontend enforces its own minimum gate
    (First + Last Name + DOB + Sex) before allowing submit.  Anything the
    client omits is left NULL on member_profiles and can be filled in later
    via the profile-edit screen.
    """

    email: EmailStr
    password: str = Field(..., min_length=8)
    name: str = Field(..., min_length=1)
    role: str = Field(..., pattern="^(chw|member)$")
    phone: str | None = None

    # ── Member-only profile fields (ignored when role != "member") ──────
    date_of_birth: date | None = None
    gender: SexEnum | None = None
    address_line1: str | None = None
    address_line2: str | None = None
    city: str | None = None
    state: str | None = Field(default=None, max_length=2)
    zip_code: str | None = Field(default=None, max_length=10)
    insurance_company: str | None = None
    # Medi-Cal CIN — PHI, stored encrypted.  Pear's primaryCIN identifier.
    medi_cal_id: str | None = None

    @model_validator(mode="after")
    def _require_full_name_for_members(self) -> "RegisterRequest":
        # Members get pushed to Pear Suite where firstName + lastName are
        # both required. Reject single-token names at the API boundary so the
        # error surfaces during signup rather than silently failing the
        # background Pear sync (which leaves the member un-billable).
        if self.role == "member":
            tokens = [t for t in self.name.strip().split() if t]
            if len(tokens) < 2:
                raise ValueError(
                    "Members must provide both first and last name"
                )
        return self


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    role: str
    name: str


class RefreshRequest(BaseModel):
    refresh_token: str


class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    email: str
    name: str
    role: str
    is_onboarded: bool
    created_at: datetime

import re
from datetime import date, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field, model_validator

# Sex values accepted by Pear Suite's CreateMember endpoint. Mirrors the
# member-signup dropdown options.
SexEnum = Literal["Male", "Female", "Other"]


# Medi-Cal CIN format: 8 digits followed by 1 letter (e.g. "12345678A").
# Pear Suite's parser is case-insensitive but we normalize to uppercase
# in the validator for storage consistency.
_CIN_PATTERN = re.compile(r"^\d{8}[A-Z]$")


class RegisterRequest(BaseModel):
    """Body for POST /auth/register.

    Hard-required for both roles: email, password, name, role.

    Members additionally must provide every field Pear's billing pipeline
    requires at the API boundary:
      - First + Last name (≥2 whitespace tokens)
      - date_of_birth, gender
      - insurance_company, medi_cal_id (CIN: 8 digits + 1 letter)
      - zip_code

    Address fields (address_line1, address_line2, city, state) and phone
    are OPTIONAL at signup — they can be filled in via PUT /member/profile
    before the first Pear sync.  State and ZIP are still format-validated
    when provided (2-letter USPS code; ZIP ≤10 chars).

    CHWs are unaffected — only basic auth fields plus name (which we relax
    to allow single-token mononyms).
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
    def _enforce_member_pear_required_fields(self) -> "RegisterRequest":
        # CHWs bypass every Pear-required check; only validate when
        # role == "member".  Anything that 422s here would otherwise show
        # up later as a silently-dropped Pear row or a failed background
        # sync, so we'd rather block at the signup boundary.
        if self.role != "member":
            return self

        # First + Last name (≥2 whitespace tokens).
        tokens = [t for t in self.name.strip().split() if t]
        if len(tokens) < 2:
            raise ValueError(
                "Members must provide both first and last name"
            )

        # Phone is OPTIONAL — Pear prefers it but the billing pipeline can
        # proceed without it.  No required-check here.

        # Required member profile fields.
        if self.date_of_birth is None:
            raise ValueError("Date of birth is required for members")
        if self.gender is None:
            raise ValueError("Sex is required for members")
        if not self.insurance_company or not self.insurance_company.strip():
            raise ValueError("Insurance is required for members")

        # CIN format: 8 digits + 1 letter (Medi-Cal standard).
        cin = (self.medi_cal_id or "").strip().upper()
        if not cin:
            raise ValueError("CIN (Medi-Cal ID) is required for members")
        if not _CIN_PATTERN.match(cin):
            raise ValueError(
                "CIN must be 8 digits followed by 1 letter (e.g. 12345678A)"
            )
        self.medi_cal_id = cin  # normalize to uppercase for storage

        # Address fields are OPTIONAL — can be completed via
        # PUT /member/profile before the first Pear sync.
        # State is format-validated (2-letter USPS) only when provided.
        if self.state is not None and self.state.strip():
            normalized_state = self.state.strip().upper()
            if len(normalized_state) != 2 or not normalized_state.isalpha():
                raise ValueError(
                    "State must be a 2-letter USPS code (e.g. CA)"
                )
            self.state = normalized_state

        # ZIP is still required for Pear's billing pipeline.
        if not self.zip_code or not self.zip_code.strip():
            raise ValueError("ZIP code is required for members")

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

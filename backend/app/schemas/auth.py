from datetime import date, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field, model_validator

from app.schemas.cin_config import validate_cin_for_carrier

# Sex values accepted by Pear Suite's CreateMember endpoint. Mirrors the
# member-signup dropdown options.
SexEnum = Literal["Male", "Female", "Other"]


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

        # CIN format: carrier-aware validation.
        #
        # Policy (cross-reference: native/src/constants/insurance.ts):
        #   - Empty / whitespace-only → always 422 (required for all members).
        #   - 14-char BIC (9+7digits+letter+check+4-digit Julian date) → the
        #     leading 10-char CIN is extracted and stored.
        #   - All configured carriers are now 'confirmed' Medi-Cal MCPs.
        #     A value is valid if, after normalization, it matches EITHER:
        #       (a) Medi-Cal CIN: ^9\d{7}[A-Z]\d?$
        #       (b) Commercial/Medicare: ^[A-Z0-9]{6,15}$
        #     Values matching neither pattern are 422'd (clearly garbage).
        #
        # See app/schemas/cin_config.py for full pattern definitions.
        raw_cin = (self.medi_cal_id or "").strip()
        if not raw_cin:
            raise ValueError("CIN (Medi-Cal ID) is required for members")

        normalized_cin, cin_valid = validate_cin_for_carrier(
            raw_cin, self.insurance_company
        )

        if not cin_valid:
            raise ValueError(
                "Double-check the member ID — Medi-Cal CINs look like 91234567A2, "
                "or enter the full commercial/Medicare ID."
            )

        self.medi_cal_id = normalized_cin  # store normalized CIN

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

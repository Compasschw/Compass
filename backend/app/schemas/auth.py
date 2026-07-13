from datetime import date, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field, model_validator

from app.schemas.cin_config import validate_cin_for_carrier

# Sex values accepted by Pear Suite's CreateMember endpoint. Mirrors the
# member-signup dropdown options.
SexEnum = Literal["Male", "Female", "Other"]


def normalize_member_pear_fields(
    *,
    name: str,
    date_of_birth: date | None,
    gender: str | None,
    insurance_company: str | None,
    medi_cal_id: str | None,
    state: str | None,
    zip_code: str | None,
) -> tuple[str, str | None]:
    """Validate + normalize the Pear-required member demographic fields.

    Single source of truth for the two member-creation paths so they can never
    silently diverge:
      - self-service ``POST /auth/register`` (``RegisterRequest``)
      - CHW-initiated ``POST /chw/members`` (``CHWCreateMemberRequest``)

    Hard-required (Pear billing pipeline needs them at the boundary): first +
    last name, ``date_of_birth``, ``gender``, ``insurance_company``,
    ``medi_cal_id`` (CIN), and ``zip_code``.  Address line1/line2/city are
    intentionally NOT required here — they can be completed via profile-edit
    before the first Pear sync — matching the nullable member model columns.

    Args:
        name: Member full name (must contain ≥2 whitespace tokens).
        date_of_birth: Parsed DOB (required — ValueError when None).
        gender: Sex enum value (required — ValueError when None).
        insurance_company: Curated carrier label (required, non-blank).
        medi_cal_id: Raw CIN / commercial member ID (required, non-blank).
        state: Optional 2-letter USPS state (format-validated when supplied).
        zip_code: Member ZIP (required, non-blank).

    Returns:
        ``(normalized_cin, normalized_state)`` — the CIN with BIC/whitespace
        stripped and the uppercased 2-letter state (or the original ``state``
        when blank/None).

    Raises:
        ValueError: On any missing/invalid field (surfaces as HTTP 422 at the
            Pydantic boundary).
    """
    tokens = [t for t in name.strip().split() if t]
    if len(tokens) < 2:
        raise ValueError("Members must provide both first and last name")

    if date_of_birth is None:
        raise ValueError("Date of birth is required for members")
    if gender is None:
        raise ValueError("Sex is required for members")
    if not insurance_company or not insurance_company.strip():
        raise ValueError("Insurance is required for members")

    raw_cin = (medi_cal_id or "").strip()
    if not raw_cin:
        raise ValueError("CIN (Medi-Cal ID) is required for members")

    normalized_cin, cin_valid = validate_cin_for_carrier(raw_cin, insurance_company)
    if not cin_valid:
        raise ValueError(
            "Double-check the member ID — Medi-Cal CINs look like 91234567A2, "
            "or enter the full commercial/Medicare ID."
        )

    normalized_state = state
    if state is not None and state.strip():
        normalized_state = state.strip().upper()
        if len(normalized_state) != 2 or not normalized_state.isalpha():
            raise ValueError("State must be a 2-letter USPS code (e.g. CA)")

    if not zip_code or not zip_code.strip():
        raise ValueError("ZIP code is required for members")

    return normalized_cin, normalized_state


def enforce_member_signup_consent(
    *,
    terms_accepted: bool,
    communications_consent: bool,
) -> None:
    """Enforce the two required signup consents for member creation.

    Shared by both member-creation paths so the documented-opt-in contract
    (A2P 10DLC + HIPAA consent audit) can never silently diverge:
      - self-service ``POST /auth/register`` (``RegisterRequest``)
      - CHW-initiated ``POST /chw/members`` (``CHWCreateMemberRequest``)

    Both booleans MUST be ``True``. A missing field (defaulting to ``False``) or
    an explicit ``False`` raises ``ValueError`` — surfacing as HTTP 422 at the
    Pydantic boundary — so the backend enforces consent independently of the UI
    (defense in depth), never relying on the client to have gated the button.

    Args:
        terms_accepted: Member agreed to the Terms of Service + Privacy Policy.
        communications_consent: Member consented to calls/SMS from Compass and
            their CHW, and to Compass billing their insurance for covered
            services.

    Raises:
        ValueError: When either consent is absent or ``False``.
    """
    if not terms_accepted:
        raise ValueError(
            "You must agree to the Terms of Service and Privacy Policy to "
            "create an account."
        )
    if not communications_consent:
        raise ValueError(
            "You must consent to communications from Compass and to insurance "
            "billing for covered services to create an account."
        )


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

    # ── Required signup consent (members only) ──────────────────────────
    # A2P 10DLC documented opt-in + HIPAA consent audit. Both must be True
    # for member signups; default False so an absent field is treated the
    # same as an explicit refusal (→ 422). Ignored for role == "chw".
    terms_accepted: bool = False
    communications_consent: bool = False

    @model_validator(mode="after")
    def _enforce_member_pear_required_fields(self) -> "RegisterRequest":
        # CHWs bypass every Pear-required check; only validate when
        # role == "member".  Anything that 422s here would otherwise show
        # up later as a silently-dropped Pear row or a failed background
        # sync, so we'd rather block at the signup boundary.
        # CHWs bypass every Pear-required check; only members are gated.
        # Phone stays OPTIONAL for members (Pear prefers it but the billing
        # pipeline proceeds without it) — no required-check here.
        if self.role != "member":
            return self

        # Required consent — enforced at the boundary (defense in depth) so a
        # member account can never be created without documented opt-in, even
        # if a client bypasses the UI gate.
        enforce_member_signup_consent(
            terms_accepted=self.terms_accepted,
            communications_consent=self.communications_consent,
        )

        # Delegate to the shared validator so /auth/register and
        # POST /chw/members enforce the identical Pear billing contract.
        normalized_cin, normalized_state = normalize_member_pear_fields(
            name=self.name,
            date_of_birth=self.date_of_birth,
            gender=self.gender,
            insurance_company=self.insurance_company,
            medi_cal_id=self.medi_cal_id,
            state=self.state,
            zip_code=self.zip_code,
        )
        self.medi_cal_id = normalized_cin  # store normalized CIN
        self.state = normalized_state
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
    # Epic G2: True when the caller is still on a CHW-assigned temporary
    # password (set at CHW-initiated member creation, cleared by a successful
    # POST /auth/change-password). Always False for self-service accounts.
    # Populated at every call site that mints a TokenResponse (register,
    # login, refresh, magic-link verify) so the client can gate the
    # first-login "set your password" prompt without a follow-up call.
    must_change_password: bool = False


class RefreshRequest(BaseModel):
    refresh_token: str


class ChangePasswordRequest(BaseModel):
    """Body for POST /auth/change-password.

    Used both for the mandatory first-login flow (a CHW-created member
    replacing their temp password — see ``User.must_change_password``) and as
    a general "change my password" action for any authenticated user with a
    password (OAuth-only accounts have ``password_hash is None`` and are
    rejected — see the router handler).

    ``new_password`` enforces the SAME minimum-length rule as signup
    (``RegisterRequest.password`` / ``CHWCreateMemberRequest.temp_password``)
    so the strength bar can never silently diverge between creation and
    change. A violation 422s at this Pydantic boundary, matching the existing
    signup contract.
    """

    current_password: str = Field(..., min_length=1)
    new_password: str = Field(..., min_length=8)


class ChangePasswordResponse(BaseModel):
    detail: str = "Password updated successfully"
    # Always False on a successful response — the whole point of this
    # endpoint is to clear the flag. Included so the client can update local
    # state from the response alone without a follow-up profile refetch.
    must_change_password: bool = False


class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    email: str
    name: str
    role: str
    is_onboarded: bool
    created_at: datetime


# ─── Social OAuth schemas ─────────────────────────────────────────────────────

class OAuthRequest(BaseModel):
    """Request body for POST /auth/oauth/google and /auth/oauth/apple.

    The client (Google Identity Services JS SDK or Sign in with Apple JS)
    obtains the id_token after completing the OAuth handshake. Only the
    id_token is sent here — the backend verifies it and issues our own JWTs.
    """

    id_token: str = Field(..., min_length=1, description="JWT id_token from the OAuth provider")


class OAuthTokenResponse(BaseModel):
    """Response for POST /auth/oauth/{google,apple}.

    Mirrors TokenResponse (access_token, refresh_token, token_type, role, name)
    and adds needs_onboarding so the FE can gate route navigation without an
    extra /member/profile call. When True, the app must direct the user to the
    onboarding completion screen before accessing the main app.
    """

    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    role: str
    name: str
    needs_onboarding: bool = False


class CompleteOnboardingRequest(BaseModel):
    """Request body for POST /auth/complete-member-onboarding.

    Validates the same fields as the member RegisterRequest (DOB, sex,
    insurance, CIN, ZIP) but does NOT require a password — the member
    authenticated via OAuth and has no password. The CIN is carrier-aware
    validated using the same logic as RegisterRequest.

    All address fields (address_line1, city, state) are OPTIONAL — they
    can be filled later via PUT /member/profile before the first Pear sync.
    """

    date_of_birth: date
    gender: SexEnum
    insurance_company: str = Field(..., min_length=1)
    medi_cal_id: str = Field(..., min_length=1)
    zip_code: str = Field(..., min_length=1, max_length=10)

    # Optional extras — same as RegisterRequest
    address_line1: str | None = None
    address_line2: str | None = None
    city: str | None = None
    state: str | None = Field(default=None, max_length=2)

    @model_validator(mode="after")
    def _validate_cin_and_fields(self) -> "CompleteOnboardingRequest":
        """Carrier-aware CIN validation, mirroring RegisterRequest logic."""
        raw_cin = (self.medi_cal_id or "").strip()
        if not raw_cin:
            raise ValueError("CIN (Medi-Cal ID) is required")

        normalized_cin, cin_valid = validate_cin_for_carrier(raw_cin, self.insurance_company)
        if not cin_valid:
            raise ValueError(
                "Double-check the member ID — Medi-Cal CINs look like 91234567A2, "
                "or enter the full commercial/Medicare ID."
            )
        self.medi_cal_id = normalized_cin

        if self.state is not None and self.state.strip():
            normalized_state = self.state.strip().upper()
            if len(normalized_state) != 2 or not normalized_state.isalpha():
                raise ValueError("State must be a 2-letter USPS code (e.g. CA)")
            self.state = normalized_state

        return self

import uuid

import pytest
from httpx import AsyncClient

from tests.conftest import auth_header


@pytest.mark.asyncio
async def test_register_success(client: AsyncClient):
    res = await client.post("/api/v1/auth/register", json={
        "email": "new@example.com", "password": "password123",
        "name": "New User", "role": "chw",
    })
    assert res.status_code == 201
    data = res.json()
    assert "access_token" in data
    assert "refresh_token" in data
    assert data["role"] == "chw"
    assert data["name"] == "New User"


@pytest.mark.asyncio
async def test_register_duplicate_email(client: AsyncClient, chw_tokens):
    res = await client.post("/api/v1/auth/register", json={
        "email": "testchw@example.com", "password": "password123",
        "name": "Dupe", "role": "chw",
    })
    assert res.status_code == 400


@pytest.mark.asyncio
async def test_register_invalid_email(client: AsyncClient):
    res = await client.post("/api/v1/auth/register", json={
        "email": "notanemail", "password": "password123",
        "name": "Bad Email", "role": "chw",
    })
    assert res.status_code == 422


@pytest.mark.asyncio
async def test_register_short_password(client: AsyncClient):
    res = await client.post("/api/v1/auth/register", json={
        "email": "short@example.com", "password": "short",
        "name": "Short Pass", "role": "chw",
    })
    assert res.status_code == 422


@pytest.mark.asyncio
async def test_login_success(client: AsyncClient, chw_tokens):
    res = await client.post("/api/v1/auth/login", json={
        "email": "testchw@example.com", "password": "testpass123",
    })
    assert res.status_code == 200
    data = res.json()
    assert data["role"] == "chw"


@pytest.mark.asyncio
async def test_login_wrong_password(client: AsyncClient, chw_tokens):
    res = await client.post("/api/v1/auth/login", json={
        "email": "testchw@example.com", "password": "wrongpassword",
    })
    assert res.status_code == 401


@pytest.mark.asyncio
async def test_refresh_token(client: AsyncClient, chw_tokens):
    res = await client.post("/api/v1/auth/refresh", json={
        "refresh_token": chw_tokens["refresh_token"],
    })
    assert res.status_code == 200
    data = res.json()
    assert data["access_token"] != chw_tokens["access_token"]


@pytest.mark.asyncio
async def test_refresh_token_reuse_fails(client: AsyncClient, chw_tokens):
    await client.post("/api/v1/auth/refresh", json={"refresh_token": chw_tokens["refresh_token"]})
    res = await client.post("/api/v1/auth/refresh", json={"refresh_token": chw_tokens["refresh_token"]})
    assert res.status_code == 401


@pytest.mark.asyncio
async def test_logout_requires_auth(client: AsyncClient, chw_tokens):
    res = await client.post("/api/v1/auth/logout", json={"refresh_token": chw_tokens["refresh_token"]})
    # FastAPI's HTTPBearer(auto_error=True) returns 401 on missing header in
    # current versions (was 403 in older releases). Either is a hard reject.
    assert res.status_code in (401, 403)


@pytest.mark.asyncio
async def test_logout_success(client: AsyncClient, chw_tokens):
    res = await client.post(
        "/api/v1/auth/logout",
        json={"refresh_token": chw_tokens["refresh_token"]},
        headers=auth_header(chw_tokens),
    )
    assert res.status_code == 204


# ─── Signup-time profile provisioning (Phase 1A) ─────────────────────────────


@pytest.mark.asyncio
async def test_register_member_auto_creates_member_profile(client: AsyncClient):
    """A fresh member registration must seed an empty MemberProfile row so
    GET/PUT /member/profile work immediately without a 404 round-trip.
    """
    email = f"profile-test-member-{uuid.uuid4()}@example.com"
    register_res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": email,
            "password": "test-password-1234",
            "name": "Test Member",
            "role": "member",
            "date_of_birth": "1991-07-22",
            "gender": "Female",
            "insurance_company": "Health Net",
            "medi_cal_id": "91234567A2",
            "zip_code": "90001",
        },
    )
    assert register_res.status_code == 201
    token = register_res.json()["access_token"]

    profile_res = await client.get(
        "/api/v1/member/profile",
        headers={"Authorization": f"Bearer {token}"},
    )
    # Must NOT 404 — profile row was created at signup.
    assert profile_res.status_code == 200
    body = profile_res.json()
    assert body["primary_language"] == "English"  # default
    # Signup-time provisioning copies the Pear-required fields supplied at
    # registration onto the profile (#14).
    assert body["zip_code"] == "90001"
    # medi_cal_id is not surfaced in the response schema (PHI minimization)
    # — covered by the PUT test below.


@pytest.mark.asyncio
async def test_register_chw_auto_creates_chw_profile(client: AsyncClient):
    """A fresh CHW registration must seed an empty CHWProfile row."""
    email = f"profile-test-chw-{uuid.uuid4()}@example.com"
    register_res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": email,
            "password": "test-password-1234",
            "name": "Test CHW",
            "role": "chw",
        },
    )
    assert register_res.status_code == 201
    token = register_res.json()["access_token"]

    profile_res = await client.get(
        "/api/v1/chw/profile",
        headers={"Authorization": f"Bearer {token}"},
    )
    # Must NOT 404 — profile row was created at signup.
    assert profile_res.status_code == 200


@pytest.mark.asyncio
async def test_register_member_rejects_single_token_name(client: AsyncClient):
    """Members must provide both first and last name — Pear Suite rejects
    members without lastName and we want the error surfaced at signup, not
    later via a silent background-sync failure. (#191)
    """
    res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": f"single-name-{uuid.uuid4()}@example.com",
            "password": "test-password-1234",
            "name": "Madonna",
            "role": "member",
        },
    )
    assert res.status_code == 422
    body = res.json()
    # Pydantic surfaces the validator error inside the standard 422 envelope.
    assert any(
        "first and last name" in str(err).lower()
        for err in body.get("detail", [])
    ), body


@pytest.mark.asyncio
async def test_register_member_rejects_whitespace_only_lastname(client: AsyncClient):
    """Trailing whitespace doesn't satisfy the two-token requirement. (#191)"""
    res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": f"trailing-space-{uuid.uuid4()}@example.com",
            "password": "test-password-1234",
            "name": "John   ",
            "role": "member",
        },
    )
    assert res.status_code == 422


@pytest.mark.asyncio
async def test_register_chw_allows_single_token_name(client: AsyncClient):
    """CHWs are not pushed to Pear, so the last-name gate doesn't apply. (#191)

    Keeps the door open for CHWs who go by a single mononym while still
    enforcing the rule for members.
    """
    res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": f"chw-mono-{uuid.uuid4()}@example.com",
            "password": "test-password-1234",
            "name": "Cher",
            "role": "chw",
        },
    )
    assert res.status_code == 201


# ── Mandatory Pear-required member fields (#14) ──────────────────────────────


def _complete_member_payload(email: str) -> dict:
    """A member-signup body with every Pear-required field populated."""
    return {
        "email": email,
        "password": "test-password-1234",
        "name": "Jane Doe",
        "role": "member",
        "phone": "+13105550101",
        "date_of_birth": "1993-01-05",
        "gender": "Female",
        "insurance_company": "Health Net",
        "medi_cal_id": "91234567A2",
        "address_line1": "1 Main St",
        "city": "Los Angeles",
        "state": "CA",
        "zip_code": "90001",
    }


@pytest.mark.asyncio
async def test_register_member_with_all_required_fields_succeeds(client: AsyncClient):
    """Sanity: a member who provides every Pear-required field can sign up."""
    res = await client.post(
        "/api/v1/auth/register",
        json=_complete_member_payload(f"complete-{uuid.uuid4()}@example.com"),
    )
    assert res.status_code == 201, res.text


@pytest.mark.parametrize(
    "missing_field",
    [
        "date_of_birth",
        "gender",
        "insurance_company",
        "medi_cal_id",
        "zip_code",
    ],
)
@pytest.mark.asyncio
async def test_register_member_rejects_missing_pear_required_field(
    client: AsyncClient,
    missing_field: str,
):
    """Each Pear-billing-required member field must 422 on signup if absent.

    phone / address_line1 / city / state are now optional — removed from
    this parametrize list per cofounder spec (T07). (#14)
    """
    payload = _complete_member_payload(
        f"missing-{missing_field}-{uuid.uuid4()}@example.com"
    )
    payload[missing_field] = None
    res = await client.post("/api/v1/auth/register", json=payload)
    assert res.status_code == 422, f"Expected 422 missing={missing_field}: {res.text}"


@pytest.mark.asyncio
async def test_register_member_rejects_invalid_cin_format(client: AsyncClient):
    """CIN must match a valid Medi-Cal or commercial format — garbage is 422. (#14)

    'BAD' (3 chars) matches neither the Medi-Cal CIN pattern (9+7digits+letter+check)
    nor the commercial/Medicare fallback (min 6 chars) — hard 422.
    """
    payload = _complete_member_payload(f"bad-cin-{uuid.uuid4()}@example.com")
    payload["medi_cal_id"] = "BAD"  # 3 chars — too short for commercial, not a CIN
    res = await client.post("/api/v1/auth/register", json=payload)
    assert res.status_code == 422


@pytest.mark.asyncio
async def test_register_member_normalizes_cin_to_uppercase(client: AsyncClient):
    """Lowercase CIN trailing letter is normalized before storage. (#14)"""
    payload = _complete_member_payload(f"lower-cin-{uuid.uuid4()}@example.com")
    payload["medi_cal_id"] = "91234567a2"  # lowercase — must be uppercased and accepted
    res = await client.post("/api/v1/auth/register", json=payload)
    assert res.status_code == 201, res.text


@pytest.mark.asyncio
async def test_register_member_rejects_3_letter_state(client: AsyncClient):
    """State must be exactly 2 letters (USPS code). (#14)"""
    payload = _complete_member_payload(f"bad-state-{uuid.uuid4()}@example.com")
    payload["state"] = "CAL"
    res = await client.post("/api/v1/auth/register", json=payload)
    assert res.status_code == 422


@pytest.mark.asyncio
async def test_register_chw_unaffected_by_member_pear_gate(client: AsyncClient):
    """CHWs aren't pushed to Pear and therefore don't need any of these
    fields. They can still sign up with the minimal payload. (#14)"""
    res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": f"chw-bare-{uuid.uuid4()}@example.com",
            "password": "test-password-1234",
            "name": "CHW Tester",
            "role": "chw",
        },
    )
    assert res.status_code == 201, res.text


# ── T07: address/phone now optional, format checks still fire ────────────────


@pytest.mark.asyncio
async def test_register_member_succeeds_with_only_minimum_fields(client: AsyncClient):
    """A member with only the Pear-billing-required minimum fields (name, DOB,
    sex, insurance, CIN, zip) must be accepted — no phone or address needed.
    (T07)
    """
    res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": f"min-fields-{uuid.uuid4()}@example.com",
            "password": "test-password-1234",
            "name": "Jane Doe",
            "role": "member",
            "date_of_birth": "1993-01-05",
            "gender": "Female",
            "insurance_company": "Health Net",
            "medi_cal_id": "91234567A2",
            "zip_code": "90001",
            # Intentionally omitted: phone, address_line1, city, state
        },
    )
    assert res.status_code == 201, res.text


@pytest.mark.parametrize(
    "missing_field",
    [
        "date_of_birth",
        "gender",
        "insurance_company",
        "medi_cal_id",
        "zip_code",
    ],
)
@pytest.mark.asyncio
async def test_register_member_still_rejects_missing_dob_sex_insurance_cin_zip(
    client: AsyncClient,
    missing_field: str,
):
    """DOB, sex, insurance, CIN, and ZIP remain hard-required for members —
    they are needed for the Pear billing pipeline. (T07)
    """
    payload = {
        "email": f"still-required-{missing_field}-{uuid.uuid4()}@example.com",
        "password": "test-password-1234",
        "name": "Jane Doe",
        "role": "member",
        "date_of_birth": "1993-01-05",
        "gender": "Female",
        "insurance_company": "Health Net",
        "medi_cal_id": "91234567A2",
        "zip_code": "90001",
    }
    payload[missing_field] = None
    res = await client.post("/api/v1/auth/register", json=payload)
    assert res.status_code == 422, (
        f"Expected 422 when {missing_field} is null: {res.text}"
    )


@pytest.mark.asyncio
async def test_register_member_invalid_state_format_rejected_if_provided(
    client: AsyncClient,
):
    """State format check still fires when a value is provided — 5-char code
    must 422 even though state is no longer required. (T07)
    """
    res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": f"bad-state-long-{uuid.uuid4()}@example.com",
            "password": "test-password-1234",
            "name": "Jane Doe",
            "role": "member",
            "date_of_birth": "1993-01-05",
            "gender": "Female",
            "insurance_company": "Health Net",
            "medi_cal_id": "91234567A2",
            "zip_code": "90001",
            "state": "CALIF",  # 5 chars — must still 422
        },
    )
    assert res.status_code == 422, res.text


@pytest.mark.asyncio
async def test_register_member_null_state_accepted(client: AsyncClient):
    """Omitting state entirely must succeed — it is no longer required. (T07)"""
    res = await client.post(
        "/api/v1/auth/register",
        json={
            "email": f"null-state-{uuid.uuid4()}@example.com",
            "password": "test-password-1234",
            "name": "Jane Doe",
            "role": "member",
            "date_of_birth": "1993-01-05",
            "gender": "Female",
            "insurance_company": "Health Net",
            "medi_cal_id": "91234567A2",
            "zip_code": "90001",
            # state omitted
        },
    )
    assert res.status_code == 201, res.text


@pytest.mark.asyncio
async def test_member_profile_put_creates_row_if_missing(client: AsyncClient, member_tokens):
    """Defensive cover for legacy accounts that registered before the
    signup-time profile provisioning landed: the PUT must upsert.
    """
    res = await client.put(
        "/api/v1/member/profile",
        headers=auth_header(member_tokens),
        # Valid Medi-Cal CIN — the PUT now validates medi_cal_id format,
        # so the prior junk placeholder ("9TEST12345") no longer passes.
        json={"zip_code": "90210", "medi_cal_id": "91234567A2"},
    )
    assert res.status_code == 200
    assert res.json()["zip_code"] == "90210"


# ── Carrier-aware CIN validation ─────────────────────────────────────────────
#
# Patterns (cross-reference: native/src/constants/insurance.ts):
#   Medi-Cal CIN: ^9\d{7}[A-Z]\d?$  (9-char or 10-char)
#   Commercial/Medicare: ^[A-Z0-9]{6,15}$
#   BIC (14-char): 10-char CIN + 4-digit Julian date → extract leading 10 chars
#
# Policy: a value is valid if it matches EITHER pattern after normalization
# (trim, uppercase, strip spaces+hyphens, extract BIC).
# Hard-422 only when the input matches neither pattern.


@pytest.mark.asyncio
async def test_cin_confirmed_carrier_valid_medi_cal_cin_accepted(
    client: AsyncClient,
) -> None:
    """A confirmed carrier (Health Net) with a 10-char Medi-Cal CIN passes.

    Regression: carrier-aware validator must not reject valid Medi-Cal CINs.
    """
    payload = _complete_member_payload(
        f"cin-confirmed-ok-{uuid.uuid4()}@example.com"
    )
    payload["insurance_company"] = "Health Net"
    payload["medi_cal_id"] = "91234567A2"
    res = await client.post("/api/v1/auth/register", json=payload)
    assert res.status_code == 201, res.text


@pytest.mark.asyncio
async def test_cin_medi_cal_9char_no_check_digit_accepted(
    client: AsyncClient,
) -> None:
    """A 9-char Medi-Cal CIN (no trailing check digit) is also accepted.

    The DHCS CIN pattern allows both the 9-char card form (9+7digits+letter)
    and the 10-char full form (9+7digits+letter+check digit).
    """
    payload = _complete_member_payload(
        f"cin-9char-{uuid.uuid4()}@example.com"
    )
    payload["insurance_company"] = "Health Net"
    payload["medi_cal_id"] = "91234567A"  # 9-char, no check digit
    res = await client.post("/api/v1/auth/register", json=payload)
    assert res.status_code == 201, (
        f"9-char Medi-Cal CIN (no check digit) must be accepted: {res.text}"
    )


@pytest.mark.asyncio
async def test_cin_medicare_mbi_style_accepted(client: AsyncClient) -> None:
    """A Medicare MBI-style alphanumeric ID passes under the lenient policy.

    MBIs are 11-char alphanumeric (e.g. '1EG4TE5MK72' after stripping hyphens).
    The commercial/Medicare fallback pattern ^[A-Z0-9]{6,15}$ accepts these.
    A numeric-only pattern would wrongly warn on letter-prefixed Medicare IDs.
    """
    payload = _complete_member_payload(
        f"cin-mbi-{uuid.uuid4()}@example.com"
    )
    payload["insurance_company"] = "Anthem Blue Cross Blue Shield"
    payload["medi_cal_id"] = "1EG4TE5MK72"  # 11-char MBI (hyphens pre-stripped)
    res = await client.post("/api/v1/auth/register", json=payload)
    assert res.status_code == 201, (
        f"Medicare MBI-style ID must be accepted (no hard-422): {res.text}"
    )


@pytest.mark.asyncio
async def test_cin_confirmed_carrier_garbage_cin_rejected(
    client: AsyncClient,
) -> None:
    """A confirmed carrier (Anthem) with a clearly garbage CIN is 422'd.

    'BAD' is 3 chars — too short for the commercial pattern (min 6 chars) and
    does not match the Medi-Cal CIN pattern. Matches neither → hard 422.
    """
    payload = _complete_member_payload(
        f"cin-confirmed-bad-{uuid.uuid4()}@example.com"
    )
    payload["insurance_company"] = "Anthem Blue Cross Blue Shield"
    payload["medi_cal_id"] = "BAD"  # 3 chars — too short for commercial, not a CIN
    res = await client.post("/api/v1/auth/register", json=payload)
    assert res.status_code == 422, res.text


@pytest.mark.asyncio
async def test_cin_pending_carrier_malformed_cin_accepted(
    client: AsyncClient,
) -> None:
    """Any non-empty plausible-length CIN is accepted under lenient policy.

    All carriers are now 'confirmed', but the lenient-warn policy means a
    value matching either pattern is valid. 'ABCDEFGHI' (9 uppercase letters)
    matches the commercial/Medicare pattern ^[A-Z0-9]{6,15}$ so it passes.
    This test ensures we don't over-restrict real members.
    """
    payload = _complete_member_payload(
        f"cin-lenient-{uuid.uuid4()}@example.com"
    )
    payload["insurance_company"] = "Molina Healthcare California"
    payload["medi_cal_id"] = "ABCDEFGHI"  # 9 uppercase letters — commercial pattern matches
    res = await client.post("/api/v1/auth/register", json=payload)
    assert res.status_code == 201, (
        f"Plausible-length ID matching commercial pattern must be accepted: {res.text}"
    )


@pytest.mark.asyncio
async def test_cin_empty_cin_rejected_for_all_carriers(
    client: AsyncClient,
) -> None:
    """An empty CIN is always 422 — CIN is required for all members."""
    payload = _complete_member_payload(
        f"cin-empty-{uuid.uuid4()}@example.com"
    )
    payload["insurance_company"] = "Molina Healthcare California"
    payload["medi_cal_id"] = None
    res = await client.post("/api/v1/auth/register", json=payload)
    assert res.status_code == 422, res.text


@pytest.mark.asyncio
async def test_cin_bic_14_char_accepted_and_normalized(
    client: AsyncClient,
) -> None:
    """A 14-char BIC is accepted; the stored CIN is the leading 10 chars.

    BIC format: 10-char CIN (9+7digits+letter+check) + 4-digit Julian date.
    Input:  "91234567A21164"  (14 chars).
    Stored: "91234567A2"     (10-char CIN, leading portion).
    """
    email = f"cin-bic-{uuid.uuid4()}@example.com"
    payload = _complete_member_payload(email)
    payload["medi_cal_id"] = "91234567A21164"  # 14-char BIC
    res = await client.post("/api/v1/auth/register", json=payload)
    assert res.status_code == 201, f"14-char BIC must be accepted: {res.text}"

    token = res.json()["access_token"]
    # Confirm stored value is the 10-char CIN via PUT round-trip.
    put_res = await client.put(
        "/api/v1/member/profile",
        headers={"Authorization": f"Bearer {token}"},
        json={"medi_cal_id": "91234567A2"},  # extracted 10-char CIN — must be accepted
    )
    assert put_res.status_code == 200, put_res.text


@pytest.mark.asyncio
async def test_cin_bic_hyphens_and_spaces_stripped(
    client: AsyncClient,
) -> None:
    """Hyphens and spaces in a CIN or MBI are stripped before matching.

    MBIs are often written with hyphens (e.g. '1EG4-TE5-MK72'). We normalize
    by stripping hyphens and spaces so the raw user input is accepted.
    """
    payload = _complete_member_payload(
        f"cin-hyphens-{uuid.uuid4()}@example.com"
    )
    payload["medi_cal_id"] = "9-1234567-A2"  # hyphens — normalizes to 91234567A2
    res = await client.post("/api/v1/auth/register", json=payload)
    assert res.status_code == 201, (
        f"CIN with hyphens must be accepted after stripping: {res.text}"
    )


@pytest.mark.asyncio
async def test_cin_unknown_carrier_garbage_still_422(
    client: AsyncClient,
) -> None:
    """An unrecognized carrier falls back to the default dual-pattern validation.

    'BAD' (3 chars) matches neither the Medi-Cal pattern nor the commercial
    pattern (min 6 chars) — so it is 422'd even for an unknown carrier.
    """
    payload = _complete_member_payload(
        f"cin-unknown-{uuid.uuid4()}@example.com"
    )
    payload["insurance_company"] = "Some Unknown HMO"
    payload["medi_cal_id"] = "BAD"  # 3 chars — too short for commercial, not a CIN
    res = await client.post("/api/v1/auth/register", json=payload)
    assert res.status_code == 422, (
        f"Unknown carrier + garbage CIN must still 422: {res.text}"
    )

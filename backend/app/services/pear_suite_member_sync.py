"""Member synchronization service for Pear Suite.

Ensures a Compass member exists in Pear Suite's system before any billing
activity can be submitted. The sync is idempotent — if the member already
has a pear_suite_member_id stored on their MemberProfile, the function
returns immediately without calling the API.

HIPAA note: mediCalId is PHI. It is passed to Pear Suite only when the
member explicitly lacks a pear_suite_member_id (i.e., first sync). It is
never logged — only the returned Pear Suite member ID is logged.

Usage:
    pear_member_id = await ensure_member_synced(db, member_profile, user)
"""

import logging
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import MemberProfile, User
from app.services.billing.pear_suite_provider import PearSuiteProvider

logger = logging.getLogger("compass.billing.member_sync")


def get_pear_suite_provider() -> PearSuiteProvider:
    """Return the configured PearSuiteProvider singleton.

    Uses the billing provider factory to ensure we always get the same
    instance (same API key, same base URL) as the rest of the billing stack.
    """
    from app.services.billing import get_billing_provider
    provider = get_billing_provider()
    if not isinstance(provider, PearSuiteProvider):
        raise TypeError(
            f"Billing provider is {type(provider).__name__}, not PearSuiteProvider. "
            "Member sync requires Pear Suite to be the configured billing provider."
        )
    return provider


def _build_member_payload(
    profile: MemberProfile,
    user: User,
) -> dict[str, Any]:
    """Construct the Pear Suite CreateMember payload from Compass models.

    Only non-None fields are included to avoid sending null values that
    Pear Suite may reject. mediCalId is included when present — it is the
    primary identifier Pear Suite uses to link our member to Medi-Cal records.

    Args:
        profile: The member's MemberProfile row.
        user: The corresponding User row (name, email, phone).

    Returns:
        Dict matching Pear Suite's POST /api/beta/members body schema.
    """
    name_parts = (user.name or "").strip().split(" ", maxsplit=1)
    first_name = name_parts[0] if name_parts else ""
    last_name = name_parts[1] if len(name_parts) > 1 else ""

    payload: dict[str, Any] = {
        "firstName": first_name,
        "lastName": last_name,
    }

    # Date of birth — Pear expects ISO 8601 YYYY-MM-DD.
    if profile.date_of_birth:
        payload["dob"] = profile.date_of_birth.isoformat()

    # Sex enum: Male | Female | Other — the signup dropdown enforces this.
    if profile.gender:
        payload["sex"] = profile.gender

    # Pear's documented schema uses ``spokenLanguages`` (array), NOT the
    # singular ``language`` we used to send (silently dropped).
    if profile.primary_language:
        payload["spokenLanguages"] = [profile.primary_language]

    # ── contactInfo (Pear's documented shape for email + phone) ──────────
    # Earlier versions sent ``email`` and ``phone`` as top-level keys
    # because the older docs implied that shape; Pear's 2026 Beta API
    # actually requires both to live inside the ``contactInfo`` object,
    # and silently drops anything at the top level.  That's why phone
    # numbers we entered at signup never appeared on the Pear member
    # page (observed on abdumahmoud@gmail.com 2026-05-18).
    #
    # ``primaryPhoneNumberDigits`` is digits-only (no +, spaces, dashes);
    # ``phoneNumbers[*].digits`` is the same shape.  We default the type
    # to "Mobile" because virtually every member signing up online has a
    # mobile number — Pear's other option, "Landline", is rarer enough
    # that we don't surface it in the signup UI today.
    phone_digits = _digits_only(user.phone) if user.phone else ""
    contact_info: dict[str, Any] = {
        # Always include email + phone keys (even when empty) so Pear's
        # Edit Member UI still renders the input fields — the page silently
        # omits the field entirely when these keys are absent from the
        # original create call.
        "email": user.email or "",
        "primaryPhoneNumberDigits": phone_digits,
    }
    if phone_digits:
        contact_info["phoneNumbers"] = [
            {
                "digits": phone_digits,
                "type": "Mobile",
                "doNotCall": False,
            }
        ]
    payload["contactInfo"] = contact_info

    # Address — Pear accepts an address sub-object.  We send whatever
    # sub-keys the member has filled in; missing keys are omitted rather
    # than sent as null so Pear's validation doesn't reject the whole block.
    address: dict[str, Any] = {}
    if profile.address_line1:
        address["address"] = profile.address_line1
    if profile.address_line2:
        address["address2"] = profile.address_line2
    if profile.city:
        address["cityName"] = profile.city
    if profile.state:
        address["stateName"] = profile.state
    if profile.zip_code:
        # 5-digit ZIP is accepted today; ZIP+4 lookup deferred until/unless
        # Pear rejects 5-digit values for billable members.  See product
        # decision recorded in conversation 2026-05-17.
        address["zip"] = profile.zip_code
    if address:
        # Country is implicit US (we don't run outside California); include it
        # only when we already have at least one other address field so we
        # don't send a country-only address that Pear may reject.
        address["countryName"] = "US"
        payload["address"] = address

    # ── Out-of-spec fields kept for forward compatibility ───────────────
    # These are NOT in Pear's published CreateMember schema.  We include
    # them anyway because:
    #   - mediCalId historically worked (test member 0d5a0a26-... had it
    #     accepted; primaryCIN write path is on the Friday meeting agenda).
    #   - insuranceCompany is a Compass-side concept that drives
    #     resolve_cost_id() at billing time — Pear may drop it server-side
    #     today but harmless to send.
    # PHI guard: mediCalId is never logged (the payload_shape log line
    # filters it out before emit).
    if profile.medi_cal_id:
        payload["mediCalId"] = profile.medi_cal_id
    if profile.insurance_company:
        payload["insuranceCompany"] = profile.insurance_company

    return payload


def _digits_only(value: str) -> str:
    """Strip everything except 0-9 from a phone string.

    Pear's ``primaryPhoneNumberDigits`` and ``phoneNumbers[*].digits``
    fields expect digits without country code, spaces, parens, or
    dashes.  US numbers like "(310) 210-2352" or "+1 310-210-2352" →
    "3102102352"; we drop a leading "1" (US country code) when the input
    is 11 digits so the resulting string is the conventional 10-digit
    NANP number Pear expects.
    """
    digits = "".join(ch for ch in (value or "") if ch.isdigit())
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    return digits


async def ensure_member_synced(
    db: AsyncSession,
    profile: MemberProfile,
    user: User,
) -> str:
    """Return the Pear Suite member ID for a member, syncing to Pear if absent.

    This function is idempotent. If profile.pear_suite_member_id is already
    set, it returns immediately. Otherwise it calls POST /api/beta/members,
    persists the returned ID on the profile, and commits the session.

    Args:
        db: Async SQLAlchemy session. The function commits after syncing.
        profile: MemberProfile ORM object. May be mutated (pear_suite_member_id set).
        user: User ORM object for name/email/phone.

    Returns:
        The Pear Suite member ID string.

    Raises:
        ValueError: if Pear Suite does not return an ID in its response.
        httpx.HTTPStatusError: if the Pear Suite API call fails.
        TypeError: if the billing provider is not PearSuiteProvider.
    """
    if profile.pear_suite_member_id:
        logger.info(
            "pear_suite.member_sync.skip: member_user_id=%s already_synced=true pear_member_id=%s",
            user.id,
            profile.pear_suite_member_id,
        )
        return profile.pear_suite_member_id

    logger.info(
        "pear_suite.member_sync.start: member_user_id=%s",
        user.id,
    )

    provider = get_pear_suite_provider()
    member_payload = _build_member_payload(profile, user)

    # PHI guard: log field names only, never values for mediCalId / email / phone
    logger.info(
        "pear_suite.member_sync.payload_shape: fields=%s member_user_id=%s",
        [k for k in member_payload.keys() if k != "mediCalId"],
        user.id,
    )

    pear_response = await provider.create_member(member_payload)

    # Pear Suite's response shape varies across endpoints.  The 2026 beta
    # API on POST /api/beta/members wraps the created member as
    # ``{"success": true, "data": {"id": "...", ...}}`` — older
    # documentation showed a flat ``{"id": ...}``.  Handle both so an
    # API-shape change doesn't silently break sync persistence (which is
    # what just happened: member was created in Pear, our extraction
    # returned None, ValueError raised, ID never persisted).
    candidate_dicts: list[dict] = [pear_response]
    inner = pear_response.get("data") if isinstance(pear_response, dict) else None
    if isinstance(inner, dict):
        candidate_dicts.append(inner)
    pear_member_id = None
    for candidate in candidate_dicts:
        pear_member_id = candidate.get("id") or candidate.get("memberId")
        if pear_member_id:
            break
    if not pear_member_id:
        logger.error(
            "pear_suite.member_sync.no_id: member_user_id=%s response_keys=%s",
            user.id,
            list(pear_response.keys()),
        )
        raise ValueError(
            f"Pear Suite did not return a member ID for member_user_id={user.id}. "
            f"Response keys: {list(pear_response.keys())}. "
            "Check Pear Suite dashboard — member may have been created but ID not returned."
        )

    profile.pear_suite_member_id = pear_member_id
    await db.commit()

    logger.info(
        "pear_suite.member_sync.success: member_user_id=%s pear_member_id=%s",
        user.id,
        pear_member_id,
    )
    return pear_member_id

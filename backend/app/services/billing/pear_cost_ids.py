"""Pear Suite per-carrier cost IDs for the CHW Service 1-Person procedure (98960).

Pear Suite's billing model requires a ``costId`` in ``billingDetails[*]`` when
completing a billable activity. Each contracted insurance carrier has its own
costId because Pear's Cost configuration encodes the per-carrier contract
(rate, modifiers, claim format, delivery method). Without the right costId,
``PUT /api/beta/activities/:id`` returns ``400 "Expected billing details"``
and the whole bill → claim → payout chain stalls.

The mapping below was provided directly by the user on 2026-05-15 after
the Pear team set up Compass's organization-level Cost configurations.
Maintain by editing this file when new carriers are contracted.

NOTE: LA Care and Molina currently share the same costId
(``78dad802-...``) — confirmed unintentional vs intentional with Pear on
2026-05-16 (TODO once answered).
"""
from __future__ import annotations

import logging
import re

logger = logging.getLogger("compass.billing.pearsuite.costids")

# ─── Canonical carrier-key → costId ───────────────────────────────────────────
#
# Keys are canonical lowercase tokens used internally; the carrier display
# name on MemberProfile.insurance_company is normalised to one of these via
# ``_normalise_carrier`` below. Add new carriers here as Pear configures them.

CHW_SERVICE_1_PERSON_COST_IDS: dict[str, str] = {
    "anthem_blue_cross_blue_shield":     "a88faa1c-e8d5-42d4-a057-ac092cb4b878",
    "blue_shield_of_california_promise": "a553f4ed-d5a4-43fa-82e9-c6b22045fa40",
    "health_net":                        "42456f6f-d745-46ad-85b1-755e2c48721b",
    "kaiser_independent_living_systems": "7e60840e-18da-4a7d-b8dd-21b0d650a4ce",
    "la_care_health_plan":               "78dad802-f121-4e33-af8b-e367f009d427",
    "molina_healthcare_california":      "78dad802-f121-4e33-af8b-e367f009d427",
}

# Display-name aliases → canonical carrier key. Any spelling MemberProfile
# might capture should map here. Lowercased + alphanumeric-stripped on lookup.
_DISPLAY_ALIASES: dict[str, str] = {
    "anthem":                                 "anthem_blue_cross_blue_shield",
    "anthembluecross":                        "anthem_blue_cross_blue_shield",
    "anthembluecrossblueshield":              "anthem_blue_cross_blue_shield",
    "anthembluecrosscalifornia":              "anthem_blue_cross_blue_shield",
    "blueshield":                             "blue_shield_of_california_promise",
    "blueshieldofcalifornia":                 "blue_shield_of_california_promise",
    "blueshieldofcaliforniapromise":          "blue_shield_of_california_promise",
    "blueshieldofcaliforniapromiseplan":      "blue_shield_of_california_promise",
    "blueshieldpromise":                      "blue_shield_of_california_promise",
    "healthnet":                              "health_net",
    "healthnetcalifornia":                    "health_net",
    "kaiser":                                 "kaiser_independent_living_systems",
    "kaiserpermanente":                       "kaiser_independent_living_systems",
    "independentlivingsystems":               "kaiser_independent_living_systems",
    "ils":                                    "kaiser_independent_living_systems",
    "lacare":                                 "la_care_health_plan",
    "lacarehealthplan":                       "la_care_health_plan",
    "molina":                                 "molina_healthcare_california",
    "molinahealthcare":                       "molina_healthcare_california",
    "molinahealthcarecalifornia":             "molina_healthcare_california",
    "molinacalifornia":                       "molina_healthcare_california",
}


def _normalise_carrier(display_name: str | None) -> str | None:
    """Reduce a free-text carrier name to a canonical key.

    "Blue Shield of CA - Promise" -> "blue_shield_of_california_promise"
    by way of stripping non-alphanumerics, lowercasing, and looking up
    against ``_DISPLAY_ALIASES`` or the canonical keys directly.
    """
    if not display_name:
        return None
    stripped = re.sub(r"[^a-z0-9]", "", display_name.lower())
    if not stripped:
        return None
    if stripped in CHW_SERVICE_1_PERSON_COST_IDS:
        return stripped
    return _DISPLAY_ALIASES.get(stripped)


def resolve_cost_id(
    insurance_company: str | None,
    *,
    procedure_code: str = "98960",
) -> str | None:
    """Resolve a Pear ``costId`` from a member's insurance carrier name.

    Args:
        insurance_company: Free-text carrier name stored on
            ``MemberProfile.insurance_company`` (or equivalent).
        procedure_code: CPT code being billed. Only 98960 (CHW 1-person)
            is mapped today; expand here when additional codes are contracted.

    Returns:
        The costId UUID string when a match is found, else None. Callers
        should treat None as "carrier not contracted yet" and skip the
        billing details until the member's insurance is updated.
    """
    if procedure_code != "98960":
        logger.warning(
            "pear_cost_ids.resolve: no mapping for procedure_code=%s "
            "(only 98960 has per-carrier costIds configured)",
            procedure_code,
        )
        return None

    canonical = _normalise_carrier(insurance_company)
    if not canonical:
        logger.warning(
            "pear_cost_ids.resolve: unknown carrier=%r — add an alias in "
            "pear_cost_ids.py if this is a valid carrier display name",
            insurance_company,
        )
        return None

    cost_id = CHW_SERVICE_1_PERSON_COST_IDS.get(canonical)
    if not cost_id:
        logger.warning(
            "pear_cost_ids.resolve: canonical key %r has no costId mapping",
            canonical,
        )
        return None

    logger.info(
        "pear_cost_ids.resolve: carrier=%r -> canonical=%s costId=%s",
        insurance_company,
        canonical,
        cost_id,
    )
    return cost_id

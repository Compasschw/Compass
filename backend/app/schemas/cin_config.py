"""Carrier-aware CIN (Medi-Cal Member ID) validation configuration.

Single source of truth for the backend. The parallel frontend definition
lives in native/src/constants/insurance.ts — keep both in sync whenever
adding a new carrier or updating patterns.

All 6 configured carriers are California Medi-Cal managed-care plans (MCPs).
Members may present either a Medi-Cal CIN or a commercial/Medicare ID.

Medi-Cal CIN (DHCS official format):
    10 chars: leading '9' + 7 digits + 1 uppercase letter + 1 check digit.
    Card variant: 9 chars (no trailing check digit).
    Pattern: ^9\\d{7}[A-Z]\\d?$  (accepts both forms)

BIC (Beneficiary Identification Card):
    14 chars: the 10-char CIN + 4-digit Julian date (YDDD).
    Pattern: ^(9\\d{7}[A-Z]\\d)\\d{4}$
    We extract the leading 10-char CIN and store that.

Commercial / Medicare MBI fallback:
    Generous alphanumeric: ^[A-Z0-9]{6,15}$
    Medicare MBIs are 11-char alphanumeric (e.g. 1EG4TE5MK73 after stripping
    hyphens). A numeric-only pattern would wrongly warn on letter-prefixed IDs.

Validation is LENIENT-WARN: a value is considered valid when it matches
EITHER pattern after normalization. We never hard-block a plausible ID.
The hard-422 threshold is "matches neither pattern" — and only for confirmed
carriers and the default/unknown-carrier path.

Cross-reference: native/src/constants/insurance.ts (mirrors this file).
"""
from __future__ import annotations

import re
from typing import Literal, TypedDict

# ─── Patterns ────────────────────────────────────────────────────────────────

# Official DHCS Medi-Cal CIN: '9' + 7 digits + 1 uppercase letter + optional
# check digit. Accepts both the 9-char card form (no check digit) and the
# 10-char full form.
_MEDI_CAL_CIN_RE = re.compile(r"^9\d{7}[A-Z]\d?$")

# Commercial / Medicare MBI fallback: 6–15 uppercase alphanumeric chars.
# MBIs are 11-char (hyphen-stripped); commercial IDs vary widely.
_COMMERCIAL_RE = re.compile(r"^[A-Z0-9]{6,15}$")

# 14-char BIC: 10-char CIN (9+7digits+letter+check) + 4-digit Julian date.
# Group 1 captures the CIN portion for extraction.
_BIC_RE = re.compile(r"^(9\d{7}[A-Z]\d)\d{4}$")

CarrierStatus = Literal["confirmed", "pending"]


class CarrierCinConfig(TypedDict):
    """Per-carrier CIN format descriptor."""

    pattern_medi_cal: re.Pattern[str]
    pattern_commercial: re.Pattern[str]
    example: str
    hint: str
    status: CarrierStatus


# ─── Carrier → CIN format map ────────────────────────────────────────────────
#
# Canonical keys mirror backend/app/services/billing/pear_cost_ids.py.
# All 6 carriers are California Medi-Cal MCPs; members may also carry
# commercial or Medicare coverage — both patterns are accepted.
# Cross-reference: native/src/constants/insurance.ts

CARRIER_CIN_CONFIG: dict[str, CarrierCinConfig] = {
    "anthem_blue_cross_blue_shield": {
        "pattern_medi_cal": _MEDI_CAL_CIN_RE,
        "pattern_commercial": _COMMERCIAL_RE,
        "example": "91234567A2",
        "hint": "Double-check the member ID — Medi-Cal CINs look like 91234567A2.",
        "status": "confirmed",
    },
    "health_net": {
        "pattern_medi_cal": _MEDI_CAL_CIN_RE,
        "pattern_commercial": _COMMERCIAL_RE,
        "example": "91234567A2",
        "hint": "Double-check the member ID — Medi-Cal CINs look like 91234567A2.",
        "status": "confirmed",
    },
    "blue_shield_of_california_promise": {
        "pattern_medi_cal": _MEDI_CAL_CIN_RE,
        "pattern_commercial": _COMMERCIAL_RE,
        "example": "91234567A2",
        "hint": "Double-check the member ID — Medi-Cal CINs look like 91234567A2.",
        "status": "confirmed",
    },
    "la_care_health_plan": {
        "pattern_medi_cal": _MEDI_CAL_CIN_RE,
        "pattern_commercial": _COMMERCIAL_RE,
        "example": "91234567A2",
        "hint": "Double-check the member ID — Medi-Cal CINs look like 91234567A2.",
        "status": "confirmed",
    },
    "molina_healthcare_california": {
        "pattern_medi_cal": _MEDI_CAL_CIN_RE,
        "pattern_commercial": _COMMERCIAL_RE,
        "example": "91234567A2",
        "hint": "Double-check the member ID — Medi-Cal CINs look like 91234567A2.",
        "status": "confirmed",
    },
    "kaiser_independent_living_systems": {
        "pattern_medi_cal": _MEDI_CAL_CIN_RE,
        "pattern_commercial": _COMMERCIAL_RE,
        "example": "91234567A2",
        "hint": "Double-check the member ID — Medi-Cal CINs look like 91234567A2.",
        "status": "confirmed",
    },
}

# ─── Display-name → canonical key ────────────────────────────────────────────
_DISPLAY_ALIASES: dict[str, str] = {
    "anthem":                            "anthem_blue_cross_blue_shield",
    "anthembluecross":                   "anthem_blue_cross_blue_shield",
    "anthembluecrossblueshield":         "anthem_blue_cross_blue_shield",
    "anthembluecrosscalifornia":         "anthem_blue_cross_blue_shield",
    "blueshield":                        "blue_shield_of_california_promise",
    "blueshieldofcalifornia":            "blue_shield_of_california_promise",
    "blueshieldofcaliforniapromise":     "blue_shield_of_california_promise",
    "blueshieldofcaliforniapromiseplan": "blue_shield_of_california_promise",
    "blueshieldpromise":                 "blue_shield_of_california_promise",
    "healthnet":                         "health_net",
    "healthnetcalifornia":               "health_net",
    "kaiser":                            "kaiser_independent_living_systems",
    "kaiserpermanente":                  "kaiser_independent_living_systems",
    "independentlivingsystems":          "kaiser_independent_living_systems",
    "ils":                               "kaiser_independent_living_systems",
    "lacare":                            "la_care_health_plan",
    "lacarehealthplan":                  "la_care_health_plan",
    "molina":                            "molina_healthcare_california",
    "molinahealthcare":                  "molina_healthcare_california",
    "molinahealthcarecalifornia":        "molina_healthcare_california",
    "molinacalifornia":                  "molina_healthcare_california",
}


def normalise_carrier_key(display_name: str | None) -> str | None:
    """Reduce a free-text carrier display name to a canonical carrier key.

    Lowercases and strips non-alphanumeric characters before lookup so
    "Blue Shield of CA - Promise Plan" → "blue_shield_of_california_promise".
    Returns None when the carrier is unknown.
    """
    if not display_name:
        return None
    stripped = re.sub(r"[^a-z0-9]", "", display_name.lower())
    if not stripped:
        return None
    if stripped in CARRIER_CIN_CONFIG:
        return stripped
    return _DISPLAY_ALIASES.get(stripped)


def normalize_cin(raw: str) -> str:
    """Normalize a raw CIN string before pattern matching.

    Normalization steps (applied in order):
    1. Trim leading/trailing whitespace.
    2. Uppercase.
    3. Strip embedded spaces and hyphens (MBIs are written as 1EG4-TE5-MK73).
    4. BIC extraction: if the result is a 14-char string matching
       ``^9\\d{7}[A-Z]\\d\\d{4}$``, extract the leading 10-char CIN.

    Returns the normalized string. Callers must still validate the result
    against the carrier's patterns — this function only normalizes.

    Cross-reference: normalizeCin() in native/src/constants/insurance.ts.
    """
    candidate = raw.strip().upper().replace(" ", "").replace("-", "")
    bic_match = _BIC_RE.match(candidate)
    if bic_match:
        return bic_match.group(1)
    return candidate


def _matches_either_pattern(normalized: str, config: CarrierCinConfig | None) -> bool:
    """Return True if normalized matches the Medi-Cal CIN or commercial pattern.

    When config is None, falls back to the module-level default patterns.
    A match on EITHER pattern is sufficient — this is the lenient-warn policy.
    """
    medi_cal_pat = config["pattern_medi_cal"] if config else _MEDI_CAL_CIN_RE
    commercial_pat = config["pattern_commercial"] if config else _COMMERCIAL_RE
    return bool(medi_cal_pat.match(normalized)) or bool(commercial_pat.match(normalized))


def validate_cin_for_carrier(
    cin: str,
    carrier_display_name: str | None,
) -> tuple[str, bool]:
    """Normalize a CIN and validate it against the carrier's expected formats.

    Args:
        cin: Raw CIN string from the request (before normalization).
        carrier_display_name: Free-text carrier name as submitted (e.g. "Health
            Net"). None / empty means unknown carrier — falls back to defaults.

    Returns:
        A (normalized_cin, is_valid) tuple.
        - ``normalized_cin``: trimmed, uppercased, hyphens/spaces stripped,
          BIC-extracted (10-char CIN if a 14-char BIC was supplied).
        - ``is_valid``: True when normalized_cin matches EITHER the Medi-Cal
          CIN pattern (``^9\\d{7}[A-Z]\\d?$``) or the commercial/Medicare
          fallback (``^[A-Z0-9]{6,15}$``). Advisory for all carriers —
          callers choose whether to hard-reject or accept-with-warning.

    Policy (mirrors normalizeCin/validateCinForCarrier in insurance.ts):
        - All configured carriers + unknown/default: validate against both
          patterns. Hard-422 only when the input matches neither. A 14-char
          BIC is extracted and the resulting 10-char CIN is validated.
        - All carriers are now 'confirmed' (Medi-Cal MCPs with known formats).
          Callers that previously checked ``status == 'pending'`` to skip
          hard-422 should now rely on ``is_valid`` directly: any non-empty
          value that matches either pattern is valid; neither-matching is the
          only hard-reject signal.

    Cross-reference: validateCinForCarrier() in native/src/constants/insurance.ts.
    """
    normalized = normalize_cin(cin)
    carrier_key = normalise_carrier_key(carrier_display_name)
    config = CARRIER_CIN_CONFIG.get(carrier_key or "")
    is_valid = _matches_either_pattern(normalized, config)
    return normalized, is_valid

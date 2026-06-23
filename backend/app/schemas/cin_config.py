"""Carrier-aware CIN (Medi-Cal Member ID) validation configuration.

Single source of truth for the backend. The parallel frontend definition
lives in native/src/constants/insurance.ts — keep both in sync whenever
adding a new carrier format.

CIN format: 8 digits + 1 uppercase letter (e.g. "12345678A").
BIC format: the 9-char CIN followed by a check digit and 4-digit Julian date
  (total 14 chars, e.g. "12345678A1164"). We extract the leading 9 chars
  (8 digits + 1 letter) and store the normalized CIN.

Confirmed carriers use the strict statewide CIN regex.
Pending carriers also use the same regex for now, but are flagged 'pending'
so that a malformed-but-non-empty value is accepted rather than 422'd —
we do not want to block a real member over an unknown carrier format.
"""
from __future__ import annotations

import re
from typing import Literal, TypedDict


# Statewide DHCS CIN: 8 digits + 1 uppercase letter.
_CIN_RE = re.compile(r"^\d{8}[A-Z]$")

# 14-char BIC: 9-char CIN (8 digits + 1 letter) + check digit (1 digit) +
# 4-digit Julian date. We accept this and strip to the leading 9 chars.
_BIC_RE = re.compile(r"^(\d{8}[A-Z])\d{5}$")

CarrierStatus = Literal["confirmed", "pending"]


class CarrierCinConfig(TypedDict):
    """Per-carrier CIN format descriptor."""

    pattern: re.Pattern[str]
    example: str
    hint: str
    status: CarrierStatus


# ─── Carrier → CIN format map ────────────────────────────────────────────────
#
# Canonical keys mirror backend/app/services/billing/pear_cost_ids.py.
# When the user provides a pending carrier's real format, replace the
# pattern here and flip status to 'confirmed'.
# TODO(user-provided format): blue_shield_of_california_promise
# TODO(user-provided format): la_care_health_plan
# TODO(user-provided format): molina_healthcare_california
# TODO(user-provided format): kaiser_independent_living_systems

CARRIER_CIN_CONFIG: dict[str, CarrierCinConfig] = {
    "anthem_blue_cross_blue_shield": {
        "pattern": _CIN_RE,
        "example": "12345678A",
        "hint": "8 digits + 1 letter, e.g. 12345678A",
        "status": "confirmed",
    },
    "health_net": {
        "pattern": _CIN_RE,
        "example": "12345678A",
        "hint": "8 digits + 1 letter, e.g. 12345678A",
        "status": "confirmed",
    },
    "blue_shield_of_california_promise": {
        "pattern": _CIN_RE,
        "example": "12345678A",
        "hint": "8 digits + 1 letter, e.g. 12345678A (format pending confirmation)",
        "status": "pending",
    },
    "la_care_health_plan": {
        "pattern": _CIN_RE,
        "example": "12345678A",
        "hint": "8 digits + 1 letter, e.g. 12345678A (format pending confirmation)",
        "status": "pending",
    },
    "molina_healthcare_california": {
        "pattern": _CIN_RE,
        "example": "12345678A",
        "hint": "8 digits + 1 letter, e.g. 12345678A (format pending confirmation)",
        "status": "pending",
    },
    "kaiser_independent_living_systems": {
        "pattern": _CIN_RE,
        "example": "12345678A",
        "hint": "8 digits + 1 letter, e.g. 12345678A (format pending confirmation)",
        "status": "pending",
    },
}

# ─── Display-name → canonical key (mirrors pear_cost_ids._DISPLAY_ALIASES) ──
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
    """Strip whitespace, uppercase, and extract CIN from a 14-char BIC.

    A 14-char BIC (``^\\d{8}[A-Z]\\d{5}$``) encodes the 9-char CIN as its
    leading characters. We extract it so the stored value is always the
    canonical 9-char CIN.

    Returns the normalized string (may not be a valid CIN — callers must
    still pattern-validate).
    """
    candidate = raw.strip().upper()
    bic_match = _BIC_RE.match(candidate)
    if bic_match:
        return bic_match.group(1)
    return candidate


def validate_cin_for_carrier(
    cin: str,
    carrier_display_name: str | None,
) -> tuple[str, bool]:
    """Normalize a CIN and validate it against the carrier's expected format.

    Args:
        cin: Raw CIN string from the request (before normalization).
        carrier_display_name: Free-text carrier name as submitted by the
            member (e.g. "Health Net", "Anthem Blue Cross Blue Shield").

    Returns:
        A (normalized_cin, is_valid) tuple.
        - ``normalized_cin``: uppercased, BIC-extracted, whitespace-stripped.
        - ``is_valid``: True when normalized_cin matches the carrier's pattern.
          For pending carriers this is advisory — callers choose whether to
          hard-reject or accept-with-warning.

    Policy:
        - Confirmed carriers (anthem, health_net) + unknown/default: validate
          strictly against ``^\\d{8}[A-Z]$``. Reject on 422 only when the
          input is clearly garbage (not matching after normalization and BIC
          extraction). A 14-char BIC is accepted and normalized.
        - Pending carriers: pattern is the same regex for now, but callers
          MUST NOT hard-422 on a mismatch — they should accept non-empty
          normalized values and log a warning.
    """
    normalized = normalize_cin(cin)
    carrier_key = normalise_carrier_key(carrier_display_name)
    config = CARRIER_CIN_CONFIG.get(carrier_key or "", None)
    pattern = config["pattern"] if config else _CIN_RE
    is_valid = bool(pattern.match(normalized))
    return normalized, is_valid

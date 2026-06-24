/**
 * Carrier-aware CIN (Medi-Cal Member ID) validation configuration.
 *
 * Single source of truth for the frontend. The parallel backend definition
 * lives in backend/app/schemas/cin_config.py — keep both in sync whenever
 * adding a new carrier or updating patterns.
 *
 * All 6 configured carriers are California Medi-Cal managed-care plans (MCPs).
 * Members may present either a Medi-Cal CIN or a commercial/Medicare ID.
 *
 * Medi-Cal CIN (DHCS official format):
 *   10 chars: leading '9' + 7 digits + 1 uppercase letter + 1 check digit.
 *   Card variant: 9 chars (no trailing check digit).
 *   Pattern: /^9\d{7}[A-Z]\d?$/  (accepts both forms)
 *
 * BIC (Beneficiary Identification Card):
 *   14 chars: the 10-char CIN + 4-digit Julian date (YDDD).
 *   Pattern: /^(9\d{7}[A-Z]\d)\d{4}$/
 *   We extract the leading 10-char CIN and store that.
 *
 * Commercial / Medicare MBI fallback:
 *   Generous alphanumeric: /^[A-Z0-9]{6,15}$/
 *   Medicare MBIs are 11-char alphanumeric (e.g. 1EG4TE5MK73 after stripping
 *   hyphens). A numeric-only pattern would wrongly warn on letter-prefixed IDs.
 *
 * Validation is LENIENT-WARN: a value is considered valid when it matches
 * EITHER pattern after normalization. We never hard-block a plausible ID.
 *
 * Cross-reference: backend/app/schemas/cin_config.py (mirrors this file).
 */

export type CarrierStatus = 'confirmed' | 'pending';

export interface CarrierCinConfig {
  /** Canonical snake_case key matching backend/pear_cost_ids.py. */
  canonicalKey: string;
  /** Regex for the DHCS Medi-Cal CIN format. */
  patternMediCal: RegExp;
  /** Regex for commercial / Medicare MBI fallback. */
  patternCommercial: RegExp;
  /** Example CIN string shown in placeholder / hint. */
  example: string;
  /** User-facing hint text for invalid input. */
  hint: string;
  /**
   * 'confirmed' = format is verified; 'pending' = format not yet confirmed.
   * All 6 carriers are now 'confirmed' (California Medi-Cal MCPs).
   */
  status: CarrierStatus;
}

/**
 * Medi-Cal CIN pattern: leading '9' + 7 digits + 1 uppercase letter + optional
 * check digit. Accepts both the 9-char card form and the 10-char full form.
 * Cross-reference: _MEDI_CAL_CIN_RE in backend/app/schemas/cin_config.py.
 */
const CIN_PATTERN = /^9\d{7}[A-Z]\d?$/;

/**
 * Commercial / Medicare MBI fallback: 6-15 uppercase alphanumeric chars.
 * MBIs are 11-char (hyphen-stripped); commercial IDs vary widely.
 * Cross-reference: _COMMERCIAL_RE in backend/app/schemas/cin_config.py.
 */
const COMMERCIAL_PATTERN = /^[A-Z0-9]{6,15}$/;

/**
 * 14-char BIC: 10-char CIN (9+7digits+letter+check) + 4-digit Julian date.
 * Capture group 1 is the 10-char CIN portion for extraction.
 * Cross-reference: _BIC_RE in backend/app/schemas/cin_config.py.
 */
const BIC_PATTERN = /^(9\d{7}[A-Z]\d)\d{4}$/;

/**
 * Carrier-to-CIN-format map.
 * Keys are the canonical carrier keys used in pear_cost_ids.py.
 * All 6 carriers are California Medi-Cal MCPs — format is now confirmed for all.
 * Cross-reference: CARRIER_CIN_CONFIG in backend/app/schemas/cin_config.py.
 */
export const CARRIER_CIN_CONFIG: Readonly<Record<string, CarrierCinConfig>> = {
  anthem_blue_cross_blue_shield: {
    canonicalKey: 'anthem_blue_cross_blue_shield',
    patternMediCal: CIN_PATTERN,
    patternCommercial: COMMERCIAL_PATTERN,
    example: '91234567A2',
    hint: 'Double-check the member ID — Medi-Cal CINs look like 91234567A2.',
    status: 'confirmed',
  },
  health_net: {
    canonicalKey: 'health_net',
    patternMediCal: CIN_PATTERN,
    patternCommercial: COMMERCIAL_PATTERN,
    example: '91234567A2',
    hint: 'Double-check the member ID — Medi-Cal CINs look like 91234567A2.',
    status: 'confirmed',
  },
  blue_shield_of_california_promise: {
    canonicalKey: 'blue_shield_of_california_promise',
    patternMediCal: CIN_PATTERN,
    patternCommercial: COMMERCIAL_PATTERN,
    example: '91234567A2',
    hint: 'Double-check the member ID — Medi-Cal CINs look like 91234567A2.',
    status: 'confirmed',
  },
  la_care_health_plan: {
    canonicalKey: 'la_care_health_plan',
    patternMediCal: CIN_PATTERN,
    patternCommercial: COMMERCIAL_PATTERN,
    example: '91234567A2',
    hint: 'Double-check the member ID — Medi-Cal CINs look like 91234567A2.',
    status: 'confirmed',
  },
  molina_healthcare_california: {
    canonicalKey: 'molina_healthcare_california',
    patternMediCal: CIN_PATTERN,
    patternCommercial: COMMERCIAL_PATTERN,
    example: '91234567A2',
    hint: 'Double-check the member ID — Medi-Cal CINs look like 91234567A2.',
    status: 'confirmed',
  },
  kaiser_independent_living_systems: {
    canonicalKey: 'kaiser_independent_living_systems',
    patternMediCal: CIN_PATTERN,
    patternCommercial: COMMERCIAL_PATTERN,
    example: '91234567A2',
    hint: 'Double-check the member ID — Medi-Cal CINs look like 91234567A2.',
    status: 'confirmed',
  },
} as const;

/**
 * Maps each display label (as shown in the UI dropdown) to a canonical
 * carrier key. Mirrors the alias logic in pear_cost_ids.py._DISPLAY_ALIASES.
 * Used by validateCinForCarrier to resolve a display label to config.
 */
export const DISPLAY_LABEL_TO_KEY: Readonly<Record<string, string>> = {
  'Anthem Blue Cross Blue Shield':              'anthem_blue_cross_blue_shield',
  'Blue Shield of California - Promise Plan':   'blue_shield_of_california_promise',
  'Health Net':                                 'health_net',
  'Independent Living Systems (Kaiser)':        'kaiser_independent_living_systems',
  'LA Care Health Plan':                        'la_care_health_plan',
  'Molina Healthcare California':               'molina_healthcare_california',
} as const;

/**
 * Curated insurance dropdown — 6 contracted Medi-Cal carriers.
 * Order is alphabetical by display label. Imported by RegisterScreen,
 * MemberProfileScreen, and CHWMemberProfileScreen (replace local copies).
 */
export const INSURANCE_OPTIONS: readonly string[] = [
  'Anthem Blue Cross Blue Shield',
  'Blue Shield of California - Promise Plan',
  'Health Net',
  'Independent Living Systems (Kaiser)',
  'LA Care Health Plan',
  'Molina Healthcare California',
] as const;

/**
 * Normalize a raw CIN string before pattern matching.
 *
 * Normalization steps (applied in order):
 * 1. Trim leading/trailing whitespace.
 * 2. Uppercase.
 * 3. Strip embedded spaces and hyphens (MBIs are written as 1EG4-TE5-MK73).
 * 4. BIC extraction: if the result is a 14-char string matching
 *    the BIC pattern, extract the leading 10-char CIN.
 *
 * @param raw - Raw user input string.
 * @returns Normalized string (may still be invalid — callers must validate).
 *
 * Cross-reference: normalize_cin() in backend/app/schemas/cin_config.py.
 */
export function normalizeCin(raw: string): string {
  const candidate = raw.trim().toUpperCase().replace(/[ -]/g, '');
  const bicMatch = BIC_PATTERN.exec(candidate);
  return bicMatch ? bicMatch[1]! : candidate;
}

export interface CinValidationResult {
  normalized: string;
  valid: boolean;
  hint: string;
  status: CarrierStatus;
}

/**
 * Normalize a CIN and validate it against the carrier's expected formats.
 *
 * A value is considered valid (no warning shown) if, after normalization,
 * it matches EITHER:
 *   (a) Medi-Cal CIN: /^9\d{7}[A-Z]\d?$/
 *   (b) Commercial/Medicare: /^[A-Z0-9]{6,15}$/
 *
 * This is the carrier-aware entry point for all CIN validation on the FE.
 * It never throws — callers receive a result object and decide whether to
 * show a soft hint (LENIENT-WARN policy: never block submission at signup;
 * BLOCK at profile edit when valid is false).
 *
 * Policy (mirrors validate_cin_for_carrier() in backend/app/schemas/cin_config.py):
 *   - All carriers are 'confirmed'; `valid` reflects whether the normalized
 *     input matches either pattern.
 *   - At signup: show `hint` when `valid` is false, but never block submission.
 *   - At profile edit: show error + block save when `valid` is false.
 *   - Unknown carrier / no carrier selected: uses module-level default patterns.
 *
 * @param cin - Raw CIN string from the TextInput.
 * @param insuranceDisplayLabel - The display label selected in the dropdown
 *   (e.g. "Health Net"). Empty string / undefined means no carrier selected.
 *
 * Cross-reference: validate_cin_for_carrier() in backend/app/schemas/cin_config.py.
 */
export function validateCinForCarrier(
  cin: string,
  insuranceDisplayLabel: string,
): CinValidationResult {
  const normalized = normalizeCin(cin);
  const canonicalKey = DISPLAY_LABEL_TO_KEY[insuranceDisplayLabel];
  const config = canonicalKey ? CARRIER_CIN_CONFIG[canonicalKey] : undefined;
  const mediCalPat = config?.patternMediCal ?? CIN_PATTERN;
  const commercialPat = config?.patternCommercial ?? COMMERCIAL_PATTERN;
  const valid = mediCalPat.test(normalized) || commercialPat.test(normalized);
  const hint =
    config?.hint ??
    'Double-check the member ID — Medi-Cal CINs look like 91234567A2.';
  const status: CarrierStatus = config?.status ?? 'confirmed';
  return { normalized, valid, hint, status };
}

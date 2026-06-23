/**
 * Carrier-aware CIN (Medi-Cal Member ID) validation configuration.
 *
 * Single source of truth for the frontend. The parallel backend definition
 * lives in backend/app/schemas/cin_config.py — keep both in sync whenever
 * adding a new carrier format.
 *
 * CIN format: 8 digits + 1 uppercase letter (e.g. "12345678A").
 * BIC format: 14-char string: 9-char CIN + 1 check digit + 4-digit Julian
 *   date (e.g. "12345678A11164"). We extract the leading 9 chars for storage.
 */

export type CarrierStatus = 'confirmed' | 'pending';

export interface CarrierCinConfig {
  /** Canonical snake_case key matching backend/pear_cost_ids.py. */
  canonicalKey: string;
  /** Regex that the normalized CIN must satisfy. */
  pattern: RegExp;
  /** Example CIN string shown in placeholder / hint. */
  example: string;
  /** User-facing hint text for invalid input. */
  hint: string;
  /**
   * 'confirmed' = format is verified by carrier; hard-validate.
   * 'pending'   = format not yet confirmed; show a soft hint, never block.
   * TODO(user-provided format): flip to 'confirmed' + update pattern when
   * the real carrier format is received.
   */
  status: CarrierStatus;
}

/** Statewide DHCS CIN regex: 8 digits + 1 uppercase letter. */
const CIN_PATTERN = /^\d{8}[A-Z]$/;

/**
 * 14-char BIC: leading 9 chars are the CIN (8 digits + 1 letter), followed
 * by 1 check digit and 4 Julian-date digits.
 * Capture group 1 is the CIN portion.
 */
const BIC_PATTERN = /^(\d{8}[A-Z])\d{5}$/;

/**
 * Carrier-to-CIN-format map.
 * Keys are the canonical carrier keys used in pear_cost_ids.py.
 *
 * To add a new confirmed format: change `pattern` to the carrier's regex and
 * set `status: 'confirmed'`. Remove the TODO comment for that carrier.
 *
 * TODO(user-provided format): blue_shield_of_california_promise
 * TODO(user-provided format): la_care_health_plan
 * TODO(user-provided format): molina_healthcare_california
 * TODO(user-provided format): kaiser_independent_living_systems
 */
export const CARRIER_CIN_CONFIG: Readonly<Record<string, CarrierCinConfig>> = {
  anthem_blue_cross_blue_shield: {
    canonicalKey: 'anthem_blue_cross_blue_shield',
    pattern: CIN_PATTERN,
    example: '12345678A',
    hint: 'Double-check your CIN — usually 8 digits + 1 letter (e.g. 12345678A)',
    status: 'confirmed',
  },
  health_net: {
    canonicalKey: 'health_net',
    pattern: CIN_PATTERN,
    example: '12345678A',
    hint: 'Double-check your CIN — usually 8 digits + 1 letter (e.g. 12345678A)',
    status: 'confirmed',
  },
  blue_shield_of_california_promise: {
    canonicalKey: 'blue_shield_of_california_promise',
    pattern: CIN_PATTERN,
    example: '12345678A',
    hint: 'Double-check your CIN — usually 8 digits + 1 letter (format pending confirmation)',
    status: 'pending',
  },
  la_care_health_plan: {
    canonicalKey: 'la_care_health_plan',
    pattern: CIN_PATTERN,
    example: '12345678A',
    hint: 'Double-check your CIN — usually 8 digits + 1 letter (format pending confirmation)',
    status: 'pending',
  },
  molina_healthcare_california: {
    canonicalKey: 'molina_healthcare_california',
    pattern: CIN_PATTERN,
    example: '12345678A',
    hint: 'Double-check your CIN — usually 8 digits + 1 letter (format pending confirmation)',
    status: 'pending',
  },
  kaiser_independent_living_systems: {
    canonicalKey: 'kaiser_independent_living_systems',
    pattern: CIN_PATTERN,
    example: '12345678A',
    hint: 'Double-check your CIN — usually 8 digits + 1 letter (format pending confirmation)',
    status: 'pending',
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
 * Strip whitespace, uppercase, and extract CIN from a 14-char BIC.
 *
 * A 14-char BIC encodes the 9-char CIN as its leading characters.
 * We extract it so the stored value is always the canonical 9-char CIN.
 *
 * @param raw - Raw user input string.
 * @returns Normalized string (may still be invalid — callers must validate).
 */
export function normalizeCin(raw: string): string {
  const candidate = raw.trim().toUpperCase();
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
 * Normalize a CIN and validate it against the carrier's expected format.
 *
 * This is the carrier-aware entry point for all CIN validation on the FE.
 * It never throws — callers receive a result object and decide whether to
 * block or show a soft hint.
 *
 * Policy (mirrors backend/app/schemas/cin_config.py):
 *   - Confirmed carriers: `valid` is true only when normalized matches the
 *     carrier's pattern. Show `hint` when false, but never block submission.
 *   - Pending carriers: `valid` reflects whether normalized matches the
 *     pattern, but the hint makes clear the format is advisory. Always
 *     allow submission regardless of `valid`.
 *   - Unknown carrier / no carrier selected: uses the default CIN pattern
 *     (confirmed-level strictness for the hint, but still never blocks).
 *
 * @param cin - Raw CIN string from the TextInput.
 * @param insuranceDisplayLabel - The display label selected in the dropdown
 *   (e.g. "Health Net"). Empty string / undefined means no carrier selected.
 */
export function validateCinForCarrier(
  cin: string,
  insuranceDisplayLabel: string,
): CinValidationResult {
  const normalized = normalizeCin(cin);
  const canonicalKey = DISPLAY_LABEL_TO_KEY[insuranceDisplayLabel];
  const config = canonicalKey ? CARRIER_CIN_CONFIG[canonicalKey] : undefined;
  const pattern = config?.pattern ?? CIN_PATTERN;
  const valid = pattern.test(normalized);
  const hint =
    config?.hint ??
    'Double-check your CIN — usually 8 digits + 1 letter (e.g. 12345678A)';
  const status: CarrierStatus = config?.status ?? 'confirmed';
  return { normalized, valid, hint, status };
}

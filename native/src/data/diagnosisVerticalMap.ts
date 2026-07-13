/**
 * diagnosisVerticalMap.ts — Z-code (ICD-10 SDOH) → resource-need vertical
 * mapping for the redesigned Diagnosis Codes section of DocumentationModal
 * (Epic Q3, 2026-07-13 documentation modal v2).
 *
 * Replaces the old `Z_CODE_CATEGORIES` grouping (counseling / housing_economic
 * / health_access / behavioral / legal — see ZCodeCategory in data/mock.ts,
 * now superseded for rendering purposes though the type/labels are left in
 * place since other code may still reference them) with groups keyed by the
 * same resource-need verticals used everywhere else in the app (Resource
 * Needs picker, member requests, filters — see lib/verticals.ts), plus an
 * "Others" bucket for codes that don't map cleanly to any vertical.
 *
 * Design notes:
 *  - `lib/verticals.ts` is READ-ONLY for this epic (owned by a concurrent
 *    agent doing the C5 housing→utilities migration) — this module does NOT
 *    edit it. It imports `VERTICAL_LABEL`/`VERTICAL_COLOR`/`verticalLabel()`
 *    from there and falls back to local labels/colors for `utilities`
 *    (and any other vertical lib/verticals.ts hasn't added yet), so this
 *    file works correctly both BEFORE and AFTER the C5 change lands.
 *  - Per the locked product decision, BOTH `housing` and `utilities` groups
 *    are rendered: `utilities` is the new, currently-selectable-elsewhere
 *    vertical (Z59.1 inadequate housing incl. heating, Z59.861/868/869
 *    financial insecurity paying for utilities); `housing` is grandfathered
 *    — it renders under the "Housing" label for historical codes
 *    (homelessness, sheltered homelessness, general housing insecurity) even
 *    though `utilities` may absorb new selections elsewhere in the product.
 *  - Every code in `diagnosisCodes` (data/mock.ts) AND every legacy code in
 *    the backend's `VALID_ICD10_CODES` allow-list (billing_service.py) is
 *    mapped here so nothing silently falls through; anything genuinely
 *    unmappable (or a future code added to one list but not the other)
 *    lands in "Others" rather than being dropped from the UI.
 */

// READ-ONLY import — do not edit lib/verticals.ts (owned by a concurrent
// agent doing the C5 housing→utilities migration). `verticalLabel()` and
// `VERTICAL_COLOR` are both additive/stable APIs that C5 only adds entries
// to, so a static import is safe; the fallback logic below (LOCAL_GROUP_*)
// handles values (`utilities`, `others`) that file doesn't know about yet.
import { verticalLabel, VERTICAL_COLOR } from '../lib/verticals';

// ─── Group keys ────────────────────────────────────────────────────────────

/**
 * Diagnosis-code group keys: the six canonical resource-need verticals
 * (mirroring lib/verticals.ts's Vertical type) plus `utilities` (pending the
 * C5 migration landing in lib/verticals.ts) and a catch-all `others` bucket.
 */
export const DIAGNOSIS_VERTICAL_GROUPS = [
  'housing',
  'utilities',
  'food',
  'transportation',
  'mental_health',
  'healthcare',
  'employment',
  'others',
] as const;

export type DiagnosisVerticalGroup = typeof DIAGNOSIS_VERTICAL_GROUPS[number];

// ─── Labels / colors (local fallbacks for anything lib/verticals.ts doesn't
//     yet know about — `utilities` and `others`) ──────────────────────────

const LOCAL_GROUP_LABEL: Record<DiagnosisVerticalGroup, string> = {
  housing: 'Housing',
  utilities: 'Utilities',
  food: 'Food Security',
  transportation: 'Transportation',
  mental_health: 'Mental Health',
  healthcare: 'Healthcare',
  employment: 'Employment',
  others: 'Others',
};

const LOCAL_GROUP_COLOR: Record<DiagnosisVerticalGroup, string> = {
  housing: '#3B82F6',        // blue-500 — matches lib/verticals.ts VERTICAL_COLOR.housing
  utilities: '#0EA5E9',      // sky-500 — distinct from housing's blue, same family
  food: '#F59E0B',           // amber-500 — matches lib/verticals.ts
  transportation: '#14B8A6', // teal-500 — matches lib/verticals.ts
  mental_health: '#8B5CF6',  // violet-500 — matches lib/verticals.ts
  healthcare: '#06B6D4',     // cyan-500 — matches lib/verticals.ts
  employment: '#6366F1',     // indigo-500 — matches lib/verticals.ts
  others: '#6B7280',         // gray-500 — neutral catch-all
};

const LOCAL_GROUP_EMOJI: Record<DiagnosisVerticalGroup, string> = {
  housing: '🏠',
  utilities: '💡',
  food: '🛒',
  transportation: '🚌',
  mental_health: '🧠',
  healthcare: '🏥',
  employment: '💼',
  others: '📋',
};

/**
 * Resolves the display label for a group, preferring lib/verticals.ts's
 * `verticalLabel()` (the authoritative source for the six base verticals)
 * and falling back to the local label map for `utilities`/`others` — or for
 * any base vertical lib/verticals.ts hasn't mapped yet, so this keeps
 * working unchanged once the C5 migration adds `utilities` there.
 *
 * `verticalLabel()` already falls back to the raw input string for values
 * it doesn't recognise (see lib/verticals.ts), so detecting that fallback
 * (`label === group`) tells us to use our local label instead of rendering
 * the raw enum key (e.g. "utilities") to the CHW.
 */
export function diagnosisGroupLabel(group: DiagnosisVerticalGroup): string {
  const label = verticalLabel(group);
  return label === group ? LOCAL_GROUP_LABEL[group] : label;
}

/** Resolves the accent color for a group — see diagnosisGroupLabel() for the fallback strategy. */
export function diagnosisGroupColor(group: DiagnosisVerticalGroup): string {
  return VERTICAL_COLOR[group as keyof typeof VERTICAL_COLOR] ?? LOCAL_GROUP_COLOR[group];
}

/** Emoji is not published by lib/verticals.ts for every group (e.g. `utilities`, `others`), so this is always local. */
export function diagnosisGroupEmoji(group: DiagnosisVerticalGroup): string {
  return LOCAL_GROUP_EMOJI[group];
}

// ─── Z-code → vertical mapping ─────────────────────────────────────────────

/**
 * Maps each diagnosis (Z-code) to the resource-need vertical it clinically
 * corresponds to. Codes not present here fall back to `others` via
 * `diagnosisCodeGroup()` below — this is a defensive default, not a sign
 * of a mapping bug, since new codes may be added to the picker or backend
 * allow-list before this map is updated.
 *
 * Covers both the active picker catalog (data/mock.ts `diagnosisCodes`) and
 * the legacy/backend-only codes in billing_service.py's `VALID_ICD10_CODES`
 * (kept valid server-side for historical documentation).
 */
const Z_CODE_TO_GROUP: Record<string, DiagnosisVerticalGroup> = {
  // ── Housing (grandfathered — homelessness / general housing insecurity) ──
  'Z59.00': 'housing', // Homelessness, unspecified
  'Z59.01': 'housing', // Sheltered homelessness
  'Z59.10': 'housing', // Inadequate housing, unspecified
  'Z59.89': 'housing', // Other problems related to housing and economic circumstances
  'Z59.9': 'housing',  // Problem related to housing/economic circumstances, unspecified

  // ── Utilities (inadequate housing conditions incl. heating, and the
  //    utility-specific financial-insecurity codes) ──
  'Z59.1': 'utilities',   // Inadequate housing (incl. heating) — legacy code
  'Z59.861': 'utilities', // Financial insecurity, difficulty paying for utilities
  'Z59.868': 'utilities', // Other specified financial insecurity (utility-adjacent)
  'Z59.869': 'utilities', // Financial insecurity, unspecified
  'Z59.86': 'utilities',  // Financial insecurity (legacy parent code)

  // ── Food ──
  'Z59.4': 'food', // Lack of adequate food and safe drinking water

  // ── Transportation ──
  'Z59.82': 'transportation', // Transportation insecurity

  // ── Mental Health (psych-adjacent Z/F-codes) ──
  'Z71.89': 'mental_health', // Other specified counseling (also picker default)
  'Z71.1': 'mental_health',  // Person with feared health complaint in whom no diagnosis is made
  'Z63.0': 'mental_health',  // Problems in relationship with spouse or partner
  'Z60.2': 'mental_health',  // Problems related to living alone
  'Z72.3': 'mental_health',  // Lack of physical exercise (behavioral/wellness)
  'Z72.89': 'mental_health', // Other problems related to lifestyle

  // ── Healthcare (access / literacy / care-dependency) ──
  'Z55.6': 'healthcare',  // Problems related to health literacy
  'Z55.9': 'healthcare',  // Problems related to education and literacy
  'Z59.71': 'healthcare', // Insufficient health insurance coverage
  'Z59.72': 'healthcare', // Insufficient welfare support (safety-net/healthcare access)
  'Z74.8': 'healthcare',  // Other problems related to care provider dependency
  'Z75.3': 'healthcare',  // Unavailability/inaccessibility of health-care facilities

  // ── Employment ──
  'Z56.9': 'employment', // Problems related to employment, unspecified

  // ── Others (no clean single-vertical fit) ──
  'Z59.6': 'others',   // Low income / lack of financial resources (general, not utility-specific)
  'Z59.7': 'others',   // Insufficient social insurance (legacy parent code)
  'Z59.87': 'others',  // Material hardship, unable to obtain adequate childcare
  'Z65.3': 'others',   // Problems related to other legal circumstances
  'Z59.12': 'others',  // Legacy "Utility Insecurity" alias — kept in Others defensively;
                        // note this ID historically meant utilities but isn't in the
                        // current picker catalog, so it's not promoted to `utilities`
                        // without product confirmation of its exact current meaning.
  'Z76.89': 'others',  // Persons encountering health services in other specified circumstances
  'Z13.89': 'others',  // Encounter for screening for other disorder
};

/**
 * Returns the resource-need vertical group for a diagnosis code, defaulting
 * to `others` for any code not present in the mapping above (new/unmapped
 * codes must never be dropped from the UI — see module docstring).
 */
export function diagnosisCodeGroup(code: string): DiagnosisVerticalGroup {
  return Z_CODE_TO_GROUP[code] ?? 'others';
}

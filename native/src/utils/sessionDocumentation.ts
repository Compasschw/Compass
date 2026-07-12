/**
 * Pure helpers for the CHW Session Documentation modal — session-time
 * input parsing/formatting and units-to-bill computation. Extracted from
 * DocumentationModal.tsx (rather than left inline) so this math is
 * unit-testable in the fast `node` tier (no React/DOM) — see
 * sessionDocumentation.test.ts.
 *
 * Session date-time input format: "MM/DD/YYYY HH:MM" entered by the CHW on a
 * 24-hour clock (e.g. "07/12/2026 14:30"). A 24-hour clock is used — rather
 * than 12-hour + AM/PM — so the auto-formatting can mirror the digits-only
 * DOB pattern in AddMemberModal.tsx (formatDobInput/parseDobInputToIso): no
 * letters to type or validate, and no AM/PM ambiguity in a billing-adjacent
 * field. Values are treated as local wall-clock time (what the CHW read off
 * a clock during the session), not a UTC instant — parsing/formatting uses
 * the JS Date's local getters/constructor, matching how DOB is handled.
 */

const SESSION_DATETIME_PATTERN =
  /^(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\/(19|20)\d{2} ([01]\d|2[0-3]):([0-5]\d)$/;

/** Auto-formats "MM/DD/YYYY HH:MM" as the CHW types (digits only + separators). */
export function formatSessionDateTimeInput(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 12);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  if (digits.length <= 8) return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
  if (digits.length <= 10) {
    return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4, 8)} ${digits.slice(8)}`;
  }
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4, 8)} ${digits.slice(8, 10)}:${digits.slice(10, 12)}`;
}

/**
 * Parses "MM/DD/YYYY HH:MM" (local wall clock, 24hr) → ISO 8601, or null when
 * the input doesn't match the expected shape or names an impossible date/time
 * (e.g. "02/30/2026 14:30", which rolls over in the Date constructor and is
 * rejected here rather than silently coerced — mirrors parseDobInputToIso's
 * UTC round-trip check).
 */
export function parseSessionDateTimeInputToIso(value: string): string | null {
  if (!SESSION_DATETIME_PATTERN.test(value)) return null;
  const [datePart, timePart] = value.split(' ');
  const [mm, dd, yyyy] = datePart.split('/');
  const [hh, min] = timePart.split(':');
  const probe = new Date(
    Number(yyyy),
    Number(mm) - 1,
    Number(dd),
    Number(hh),
    Number(min),
    0,
    0,
  );
  if (
    probe.getFullYear() !== Number(yyyy) ||
    probe.getMonth() + 1 !== Number(mm) ||
    probe.getDate() !== Number(dd) ||
    probe.getHours() !== Number(hh) ||
    probe.getMinutes() !== Number(min)
  ) {
    return null;
  }
  return probe.toISOString();
}

/**
 * Formats an ISO 8601 timestamp back to "MM/DD/YYYY HH:MM" local wall-clock,
 * for pre-filling the Session Start / Session End inputs from
 * `sessionStartedAt` / `sessionEndedAt`. Returns '' for null/undefined/unparseable
 * input so the field renders empty rather than "Invalid Date".
 */
export function formatIsoForSessionDateTimeInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yyyy = String(d.getFullYear());
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${mm}/${dd}/${yyyy} ${hh}:${min}`;
}

/**
 * Auto-derive the units-to-bill from a session's total duration.
 *
 * Founder-set bracket (2026-05-07) — must match the backend
 * ``app.services.billing_service.calculate_units`` exactly:
 *
 *   - ≤ 45 min  → 1 unit
 *   - 45–75 min → 2 units
 *   - 75–105 min → 3 units
 *   - > 105 min → 4 units (Medi-Cal daily cap)
 *
 * Returns 1 when the duration is missing so the schema's ``ge=1`` constraint
 * is honored and the CHW always gets credit for the visit.
 */
export function computeUnitsFromDuration(durationMinutes: number | null | undefined): number {
  if (durationMinutes == null || durationMinutes <= 45) return 1;
  if (durationMinutes <= 75) return 2;
  if (durationMinutes <= 105) return 3;
  return 4;
}

/**
 * Which side of the Session Start / Session End pair failed validation.
 * Null means both parsed and end > start.
 */
export type SessionTimesError = 'invalid_start' | 'invalid_end' | 'end_before_start' | null;

export interface SessionTimesUnitsResult {
  /** Whole-minute duration between start and end, or null when either input is missing/invalid. */
  durationMinutes: number | null;
  /** Units-to-bill derived from durationMinutes (see computeUnitsFromDuration; 1 when duration is unavailable). */
  units: number;
  /** Null when both times are present, parseable, and end > start. */
  error: SessionTimesError;
}

/**
 * Computes the billable duration + units from raw ISO start/end timestamps.
 * Drives the live "Units to Bill" recompute as the CHW edits the Session
 * Start / Session End fields in DocumentationModal.
 */
export function computeUnitsFromTimes(
  startIso: string | null,
  endIso: string | null,
): SessionTimesUnitsResult {
  if (startIso == null) {
    return { durationMinutes: null, units: computeUnitsFromDuration(null), error: 'invalid_start' };
  }
  const startMs = Date.parse(startIso);
  if (Number.isNaN(startMs)) {
    return { durationMinutes: null, units: computeUnitsFromDuration(null), error: 'invalid_start' };
  }
  if (endIso == null) {
    return { durationMinutes: null, units: computeUnitsFromDuration(null), error: 'invalid_end' };
  }
  const endMs = Date.parse(endIso);
  if (Number.isNaN(endMs)) {
    return { durationMinutes: null, units: computeUnitsFromDuration(null), error: 'invalid_end' };
  }
  if (endMs <= startMs) {
    return { durationMinutes: null, units: computeUnitsFromDuration(null), error: 'end_before_start' };
  }
  const durationMinutes = Math.round((endMs - startMs) / 60_000);
  return { durationMinutes, units: computeUnitsFromDuration(durationMinutes), error: null };
}

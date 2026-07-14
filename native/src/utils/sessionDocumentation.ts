/**
 * Pure helpers for the CHW Session Documentation modal — session-time
 * input parsing/formatting and units-to-bill computation. Extracted from
 * DocumentationModal.tsx (rather than left inline) so this math is
 * unit-testable in the fast `node` tier (no React/DOM) — see
 * sessionDocumentation.test.ts.
 *
 * Session date-time input format: "MM/DD/YYYY hh:MM AM/PM" (12-hour clock,
 * zero-padded hour) entered by the CHW (e.g. "07/12/2026 02:30 PM").
 *
 * #21 (2026-07-13): this format was changed FROM a 24-hour "MM/DD/YYYY
 * HH:MM" mask TO this one so it matches EXACTLY what the billing CSV export
 * requires — see `backend/app/services/billing_csv_writer.py`'s
 * `_fmt_la_datetime()`:
 *
 *   ```python
 *   def _fmt_la_datetime(value: datetime | None) -> str:
 *       """Render a UTC datetime as ``MM/DD/YYYY hh:MM AM/PM`` in LA local time.
 *
 *       Fully zero-padded: month, day, and the 12-hour clock hour ("01:30 PM",
 *       not "1:30 PM"). Ops confirmed 2026-06-17 that the billing upload
 *       requires the padded ``MM/DD/YYYY hh:MM AM/PM`` form for Activity
 *       Start/End — unpadded hours force manual correction during import.
 *       """
 *   ```
 *
 * i.e. the writer emits `MM/DD/YYYY hh:MM AM/PM` — zero-padded month, day,
 * AND 12-hour hour (never "1:30 PM", always "01:30 PM") — converted to
 * `America/Los_Angeles` local time. Before this fix, the CHW-facing modal
 * displayed/collected a 24-hour "14:30" style time (chosen at the time to
 * mirror AddMemberModal's digits-only DOB mask), which did not match what
 * Pear Suite's billing upload expects — every session time the CHW entered
 * would have required manual correction during CSV import. This module now
 * masks/parses in the exact `MM/DD/YYYY hh:MM AM/PM` shape so what the CHW
 * sees is byte-for-byte what ends up on the claim.
 *
 * Values are treated as local wall-clock time (what the CHW read off a clock
 * during the session), not a UTC instant — parsing/formatting uses the JS
 * Date's local getters/constructor (matching how DOB is handled in
 * AddMemberModal.tsx), NOT `_fmt_la_datetime`'s LA-timezone conversion — the
 * CHW enters/sees their own device's local wall-clock time, same as before;
 * only the 12-hour/AM-PM shape changed, not the timezone-handling model. The
 * wire format submitted to the backend stays ISO 8601 (unchanged) — the
 * backend/billing CSV writer independently converts to LA local at export
 * time regardless of what timezone the CHW's device was in.
 */

// Groups: 1=month(01-12) 2=day(01-31) 3=year 4=hour(01-12) 5=minute(00-59) 6=AM/PM
const SESSION_DATETIME_PATTERN =
  /^(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\/(19|20)\d{2} (0[1-9]|1[0-2]):([0-5]\d) (AM|PM)$/;

/**
 * Auto-formats "MM/DD/YYYY hh:MM AM/PM" as the CHW types. Digits are typed
 * freely (auto-inserting slashes/colon/space as each segment fills); AM/PM
 * is a trailing single keystroke ('a'/'p', case-insensitive) appended after
 * the minute digits — mirrors how a CHW would naturally type "0230p" to mean
 * "02:30 PM" without needing to type out the letters "PM".
 */
export function formatSessionDateTimeInput(raw: string): string {
  // Trailing AM/PM letter (if any) is captured separately from the digit
  // stream so it survives independently of how many date/time digits have
  // been typed so far.
  const meridiemMatch = /[aApP][mM]?$/.exec(raw.trimEnd());
  const meridiem = meridiemMatch
    ? meridiemMatch[0][0].toUpperCase() === 'A'
      ? 'AM'
      : 'PM'
    : null;

  const digits = raw.replace(/\D/g, '').slice(0, 12);
  let out: string;
  if (digits.length <= 2) {
    out = digits;
  } else if (digits.length <= 4) {
    out = `${digits.slice(0, 2)}/${digits.slice(2)}`;
  } else if (digits.length <= 8) {
    out = `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
  } else if (digits.length <= 10) {
    out = `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4, 8)} ${digits.slice(8)}`;
  } else {
    out = `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4, 8)} ${digits.slice(8, 10)}:${digits.slice(10, 12)}`;
  }

  // Only append AM/PM once the minute pair is complete (10 digits: MMDDYYYYHHMM
  // less the leading MMDDYYYYHH = 10 total digits typed) — matches the point
  // the field shows "MM/DD/YYYY hh:MM" and a trailing a/p becomes meaningful.
  if (digits.length >= 12 && meridiem) {
    out = `${out} ${meridiem}`;
  }
  return out;
}

/**
 * Parses "MM/DD/YYYY hh:MM AM/PM" (local wall clock, 12hr) → ISO 8601, or
 * null when the input doesn't match the expected shape or names an
 * impossible date/time (e.g. "02/30/2026 02:30 PM", which rolls over in the
 * Date constructor and is rejected here rather than silently coerced —
 * mirrors parseDobInputToIso's UTC round-trip check).
 */
export function parseSessionDateTimeInputToIso(value: string): string | null {
  const match = SESSION_DATETIME_PATTERN.exec(value);
  if (!match) return null;
  const [datePart, timePart, meridiem] = value.split(' ');
  const [mm, dd, yyyy] = datePart.split('/');
  const [hh12Str, min] = timePart.split(':');
  const hh12 = Number(hh12Str);
  // Convert 12-hour + AM/PM to 24-hour for the Date constructor.
  // 12 AM → 0, 12 PM → 12, otherwise PM adds 12.
  const hh24 =
    meridiem === 'AM' ? (hh12 === 12 ? 0 : hh12) : hh12 === 12 ? 12 : hh12 + 12;
  const probe = new Date(
    Number(yyyy),
    Number(mm) - 1,
    Number(dd),
    hh24,
    Number(min),
    0,
    0,
  );
  if (
    probe.getFullYear() !== Number(yyyy) ||
    probe.getMonth() + 1 !== Number(mm) ||
    probe.getDate() !== Number(dd) ||
    probe.getHours() !== hh24 ||
    probe.getMinutes() !== Number(min)
  ) {
    return null;
  }
  return probe.toISOString();
}

/**
 * Formats an ISO 8601 timestamp back to "MM/DD/YYYY hh:MM AM/PM" local
 * wall-clock, for pre-filling the Session Start / Session End inputs from
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
  const hour24 = d.getHours();
  const hour12 = hour24 % 12 || 12;
  const hh = String(hour12).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const meridiem = hour24 < 12 ? 'AM' : 'PM';
  return `${mm}/${dd}/${yyyy} ${hh}:${min} ${meridiem}`;
}

/**
 * Auto-derive the units-to-bill from a session's total duration.
 *
 * Founder-set 16-minute-floor bracket (2026-07-13, supersedes the
 * 2026-05-07 bracket) — must match the backend
 * ``app.services.billing_service.calculate_units`` exactly:
 *
 *   - < 16 min   → 0 units (NOT billable — no claim may be filed)
 *   - 16–45 min  → 1 unit
 *   - 46–75 min  → 2 units
 *   - 76–105 min → 3 units
 *   - ≥ 106 min  → 4 units (Medi-Cal daily cap)
 *
 * Returns 0 when the duration is missing — an unknown duration must never be
 * presented to the CHW as billable. The DocumentationModal shows a
 * not-billable notice and blocks submission for billing whenever this
 * returns 0 (see ``UnitsLine`` in DocumentationModal.tsx); the backend's
 * ``validate_claim`` independently rejects a computed 0 with a 422, so a
 * <16-minute claim can never be filed even if the FE gate were bypassed.
 */
export function computeUnitsFromDuration(durationMinutes: number | null | undefined): number {
  if (durationMinutes == null || durationMinutes < 16) return 0;
  if (durationMinutes <= 45) return 1;
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
  /** Units-to-bill derived from durationMinutes (see computeUnitsFromDuration; 0 — not billable — when duration is unavailable). */
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

/** Minimum whole-minute session duration that earns any billable units (Q2, 2026-07-13). */
export const MIN_BILLABLE_DURATION_MINUTES = 16;

/**
 * True when the computed units are 0 — i.e. the session is below the
 * 16-minute billable floor (or duration is unavailable). Centralizes the
 * "not billable" check so DocumentationModal's notice/gate and any future
 * caller agree on the exact condition rather than re-deriving `units === 0`
 * inline in multiple places.
 */
export function isBelowBillableFloor(units: number): boolean {
  return units === 0;
}

// ─── Potential earnings (#22) ───────────────────────────────────────────────

/**
 * Product-specified CHW payout rate, per billable unit, shown to the CHW in
 * the Documentation modal as "Potential Earnings" (#22, 2026-07-13).
 *
 * This is a DISPLAY-ONLY constant, intentionally distinct from the backend's
 * actual net payout math: `app.services.billing_service.calculate_earnings`
 * computes ``net_payout`` from ``gross_amount`` minus platform/PearSuite fees,
 * which nets out to approximately $16/unit today. Product asked the
 * CHW-facing "potential earnings" estimate shown BEFORE submission to use a
 * flat, intentionally-conservative $14/unit instead — never overstating what
 * the CHW will actually be paid. The backend's own net-payout figure (from
 * ``calculate_earnings``) remains the authoritative amount that is actually
 * billed/paid; this constant does not feed into any billing/claim submission
 * path, only this pre-submit estimate.
 */
export const CHW_RATE_PER_UNIT = 14;

/**
 * Computes the CHW-facing "Potential Earnings" estimate shown under the
 * Units line in DocumentationModal — flat ``units * CHW_RATE_PER_UNIT``.
 * Returns 0 for 0 units (not billable) rather than a negative/NaN result for
 * any unexpected input — a potential-earnings display must never suggest a
 * non-billable session is worth money.
 */
export function computePotentialEarnings(units: number): number {
  if (!Number.isFinite(units) || units <= 0) return 0;
  return units * CHW_RATE_PER_UNIT;
}

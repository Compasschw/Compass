/**
 * Availability shading helpers for the calendar grids.
 *
 * The CHW's weekly hours are stored as `{ "mon": "09:00-17:00", ... }` (clinic-
 * local wall-clock). These helpers answer "is this day/hour inside the CHW's
 * working window?" so the calendar can grey out unavailable cells. Shading is a
 * visual guide only — the actual booking is enforced server-side by the
 * available-slots endpoint.
 */

export type AvailabilityWindows = Record<string, string>;

const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

/** JS Date → Monday-first 3-letter weekday key (matches the backend keys). */
function dayKey(date: Date): string {
  // getDay(): 0=Sun..6=Sat → shift so Mon=0.
  return WEEKDAY_KEYS[(date.getDay() + 6) % 7];
}

/**
 * The [startHour, endHour] window (as decimal hours, e.g. 9.5 = 09:30) for the
 * date's weekday, or null when the CHW isn't available that day.
 */
export function windowHoursForDate(
  windows: AvailabilityWindows | undefined | null,
  date: Date,
): [number, number] | null {
  if (!windows) return null;
  const value = windows[dayKey(date)];
  if (!value || !value.includes('-')) return null;
  const [startStr, endStr] = value.split('-');
  const [sh, sm] = startStr.split(':').map(Number);
  const [eh, em] = endStr.split(':').map(Number);
  if (Number.isNaN(sh) || Number.isNaN(eh)) return null;
  return [sh + (sm || 0) / 60, eh + (em || 0) / 60];
}

/** True when the CHW works at all on the given date. */
export function isDayAvailable(
  windows: AvailabilityWindows | undefined | null,
  date: Date,
): boolean {
  return windowHoursForDate(windows, date) !== null;
}

/**
 * True when the hour cell `[hour, hour+1)` overlaps the CHW's window on `date`.
 * Returns false for unavailable days/hours.
 */
export function isHourAvailable(
  windows: AvailabilityWindows | undefined | null,
  date: Date,
  hour: number,
): boolean {
  const win = windowHoursForDate(windows, date);
  if (!win) return false;
  const [start, end] = win;
  return hour + 1 > start && hour < end;
}

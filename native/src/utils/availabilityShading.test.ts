import { describe, it, expect } from 'vitest';

import {
  windowHoursForDate,
  isDayAvailable,
  isHourAvailable,
  type AvailabilityWindows,
} from './availabilityShading';

// 2026-07-06 is a Monday; +n days walks the week. Using UTC-noon avoids any
// local-midnight DST edge shifting the weekday.
function day(offset: number): Date {
  return new Date(Date.UTC(2026, 6, 6, 12, 0, 0) + offset * 86_400_000);
}

const WINDOWS: AvailabilityWindows = {
  mon: '09:00-17:00',
  tue: '09:30-12:30',
  wed: '', // explicitly no hours
};

describe('windowHoursForDate', () => {
  it('parses HH:MM-HH:MM into decimal-hour bounds', () => {
    expect(windowHoursForDate(WINDOWS, day(0))).toEqual([9, 17]);
  });

  it('handles half-hour boundaries', () => {
    expect(windowHoursForDate(WINDOWS, day(1))).toEqual([9.5, 12.5]);
  });

  it('returns null for an empty window string', () => {
    expect(windowHoursForDate(WINDOWS, day(2))).toBeNull();
  });

  it('returns null for a day absent from the map', () => {
    expect(windowHoursForDate(WINDOWS, day(3))).toBeNull(); // Thursday
  });

  it('returns null when windows is null/undefined', () => {
    expect(windowHoursForDate(null, day(0))).toBeNull();
    expect(windowHoursForDate(undefined, day(0))).toBeNull();
  });
});

describe('isDayAvailable', () => {
  it('is true on a configured day, false otherwise', () => {
    expect(isDayAvailable(WINDOWS, day(0))).toBe(true); // Mon
    expect(isDayAvailable(WINDOWS, day(2))).toBe(false); // Wed (empty)
    expect(isDayAvailable(WINDOWS, day(5))).toBe(false); // Sat (absent)
  });
});

describe('isHourAvailable', () => {
  it('includes hours fully inside the window', () => {
    expect(isHourAvailable(WINDOWS, day(0), 9)).toBe(true);
    expect(isHourAvailable(WINDOWS, day(0), 16)).toBe(true);
  });

  it('excludes the hour cell that ends exactly at the window start', () => {
    // Tue window starts 09:30 → the [8,9) cell does not overlap.
    expect(isHourAvailable(WINDOWS, day(1), 8)).toBe(false);
  });

  it('includes a cell that partially overlaps the window', () => {
    // Tue 09:30-12:30 → the [9,10) cell overlaps (9.5 < 10).
    expect(isHourAvailable(WINDOWS, day(1), 9)).toBe(true);
    // The [12,13) cell overlaps (12 < 12.5).
    expect(isHourAvailable(WINDOWS, day(1), 12)).toBe(true);
  });

  it('excludes hours at/after the window end', () => {
    expect(isHourAvailable(WINDOWS, day(0), 17)).toBe(false);
  });

  it('is false on unavailable days', () => {
    expect(isHourAvailable(WINDOWS, day(2), 10)).toBe(false);
  });
});

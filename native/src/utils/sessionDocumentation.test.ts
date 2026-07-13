import { describe, it, expect } from 'vitest';

import {
  computeUnitsFromDuration,
  computeUnitsFromTimes,
  formatIsoForSessionDateTimeInput,
  formatSessionDateTimeInput,
  isBelowBillableFloor,
  parseSessionDateTimeInputToIso,
} from './sessionDocumentation';

describe('computeUnitsFromDuration', () => {
  it('returns 0 units (not billable) below the 16-minute floor', () => {
    expect(computeUnitsFromDuration(0)).toBe(0);
    expect(computeUnitsFromDuration(1)).toBe(0);
    expect(computeUnitsFromDuration(15)).toBe(0);
  });

  it('returns 1 unit at the 16-minute floor through 45 minutes', () => {
    expect(computeUnitsFromDuration(16)).toBe(1);
    expect(computeUnitsFromDuration(30)).toBe(1);
    expect(computeUnitsFromDuration(45)).toBe(1);
  });

  it('returns 2 units between 45 (exclusive) and 75 (inclusive)', () => {
    expect(computeUnitsFromDuration(46)).toBe(2);
    expect(computeUnitsFromDuration(60)).toBe(2);
    expect(computeUnitsFromDuration(75)).toBe(2);
  });

  it('returns 3 units between 75 (exclusive) and 105 (inclusive)', () => {
    expect(computeUnitsFromDuration(76)).toBe(3);
    expect(computeUnitsFromDuration(90)).toBe(3);
    expect(computeUnitsFromDuration(105)).toBe(3);
  });

  it('caps at 4 units above 105 minutes (Medi-Cal daily cap)', () => {
    expect(computeUnitsFromDuration(106)).toBe(4);
    expect(computeUnitsFromDuration(240)).toBe(4);
    expect(computeUnitsFromDuration(10_000)).toBe(4);
  });

  it('returns 0 (not billable) when duration is missing — never assumed billable', () => {
    expect(computeUnitsFromDuration(null)).toBe(0);
    expect(computeUnitsFromDuration(undefined)).toBe(0);
  });

  it('treats a negative duration the same as any other sub-16-minute value (0 units)', () => {
    expect(computeUnitsFromDuration(-10)).toBe(0);
  });

  it('exact boundary matrix', () => {
    const cases: Array<[number, number]> = [
      [15, 0],
      [16, 1],
      [45, 1],
      [46, 2],
      [75, 2],
      [76, 3],
      [105, 3],
      [106, 4],
      [10_000, 4],
    ];
    for (const [minutes, expectedUnits] of cases) {
      expect(computeUnitsFromDuration(minutes)).toBe(expectedUnits);
    }
  });
});

describe('isBelowBillableFloor', () => {
  it('is true only for 0 units', () => {
    expect(isBelowBillableFloor(0)).toBe(true);
    expect(isBelowBillableFloor(1)).toBe(false);
    expect(isBelowBillableFloor(4)).toBe(false);
  });
});

describe('formatSessionDateTimeInput', () => {
  it('auto-inserts date slashes as digits are typed', () => {
    expect(formatSessionDateTimeInput('0')).toBe('0');
    expect(formatSessionDateTimeInput('07')).toBe('07');
    expect(formatSessionDateTimeInput('0712')).toBe('07/12');
    expect(formatSessionDateTimeInput('07122026')).toBe('07/12/2026');
  });

  it('appends a space + colon once time digits start', () => {
    expect(formatSessionDateTimeInput('071220261')).toBe('07/12/2026 1');
    expect(formatSessionDateTimeInput('0712202614')).toBe('07/12/2026 14');
    expect(formatSessionDateTimeInput('071220261430')).toBe('07/12/2026 14:30');
  });

  it('strips non-digit characters and caps at 12 digits total', () => {
    expect(formatSessionDateTimeInput('07/12/2026 14:30extra digits 99')).toBe('07/12/2026 14:30');
  });
});

describe('parseSessionDateTimeInputToIso', () => {
  it('parses a well-formed input to an ISO string', () => {
    const iso = parseSessionDateTimeInputToIso('07/12/2026 14:30');
    expect(iso).not.toBeNull();
    expect(new Date(iso as string).getFullYear()).toBe(2026);
  });

  it('round-trips through formatIsoForSessionDateTimeInput', () => {
    const iso = parseSessionDateTimeInputToIso('07/12/2026 09:05');
    expect(formatIsoForSessionDateTimeInput(iso)).toBe('07/12/2026 09:05');
  });

  it('rejects malformed shapes', () => {
    expect(parseSessionDateTimeInputToIso('')).toBeNull();
    expect(parseSessionDateTimeInputToIso('07/12/2026')).toBeNull();
    expect(parseSessionDateTimeInputToIso('7/12/2026 14:30')).toBeNull();
    expect(parseSessionDateTimeInputToIso('07/12/2026 25:00')).toBeNull();
    expect(parseSessionDateTimeInputToIso('not a date')).toBeNull();
  });

  it('rejects impossible calendar dates instead of rolling them over', () => {
    // Feb 30 rolls over to Mar 2 in the Date constructor — must be rejected.
    expect(parseSessionDateTimeInputToIso('02/30/2026 10:00')).toBeNull();
    expect(parseSessionDateTimeInputToIso('13/01/2026 10:00')).toBeNull();
  });
});

describe('formatIsoForSessionDateTimeInput', () => {
  it('returns an empty string for null/undefined/unparseable input', () => {
    expect(formatIsoForSessionDateTimeInput(null)).toBe('');
    expect(formatIsoForSessionDateTimeInput(undefined)).toBe('');
    expect(formatIsoForSessionDateTimeInput('not-a-date')).toBe('');
  });
});

describe('computeUnitsFromTimes', () => {
  it('computes duration + units for a valid start/end pair', () => {
    const start = new Date(2026, 6, 12, 9, 0, 0).toISOString();
    const end = new Date(2026, 6, 12, 9, 50, 0).toISOString();
    const result = computeUnitsFromTimes(start, end);
    expect(result).toEqual({ durationMinutes: 50, units: 2, error: null });
  });

  it('brackets duration into units exactly like computeUnitsFromDuration', () => {
    const start = new Date(2026, 6, 12, 9, 0, 0).toISOString();
    const cases: Array<[number, number]> = [
      [15, 0],
      [16, 1],
      [45, 1],
      [46, 2],
      [75, 2],
      [76, 3],
      [105, 3],
      [106, 4],
    ];
    for (const [minutes, expectedUnits] of cases) {
      const end = new Date(2026, 6, 12, 9, minutes, 0).toISOString();
      expect(computeUnitsFromTimes(start, end).units).toBe(expectedUnits);
    }
  });

  it('flags a null/invalid start as invalid_start', () => {
    const end = new Date(2026, 6, 12, 9, 50, 0).toISOString();
    expect(computeUnitsFromTimes(null, end)).toEqual({
      durationMinutes: null,
      units: 0,
      error: 'invalid_start',
    });
    expect(computeUnitsFromTimes('not-a-date', end).error).toBe('invalid_start');
  });

  it('flags a null/invalid end as invalid_end', () => {
    const start = new Date(2026, 6, 12, 9, 0, 0).toISOString();
    expect(computeUnitsFromTimes(start, null)).toEqual({
      durationMinutes: null,
      units: 0,
      error: 'invalid_end',
    });
    expect(computeUnitsFromTimes(start, 'not-a-date').error).toBe('invalid_end');
  });

  it('flags end === start and end < start (negative duration) as end_before_start', () => {
    const start = new Date(2026, 6, 12, 9, 0, 0).toISOString();
    const sameTime = new Date(2026, 6, 12, 9, 0, 0).toISOString();
    const before = new Date(2026, 6, 12, 8, 0, 0).toISOString();

    expect(computeUnitsFromTimes(start, sameTime).error).toBe('end_before_start');
    expect(computeUnitsFromTimes(start, before).error).toBe('end_before_start');
    // Duration/units are not trusted when the pair is invalid — units falls
    // back to the not-billable (0) floor rather than reporting a negative duration.
    expect(computeUnitsFromTimes(start, before)).toEqual({
      durationMinutes: null,
      units: 0,
      error: 'end_before_start',
    });
  });

  it('returns 0 units (not billable) for a valid pair under the 16-minute floor', () => {
    const start = new Date(2026, 6, 12, 9, 0, 0).toISOString();
    const end = new Date(2026, 6, 12, 9, 10, 0).toISOString();
    expect(computeUnitsFromTimes(start, end)).toEqual({
      durationMinutes: 10,
      units: 0,
      error: null,
    });
  });
});

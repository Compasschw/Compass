import { describe, it, expect } from 'vitest';

import { elapsedSeconds, formatElapsed, formatElapsedSince } from './sessionTimer';

describe('elapsedSeconds', () => {
  const start = '2026-07-11T10:00:00.000Z';
  const startMs = Date.parse(start);

  it('returns whole seconds between start and now', () => {
    expect(elapsedSeconds(start, startMs + 65_000)).toBe(65);
  });

  it('floors partial seconds', () => {
    expect(elapsedSeconds(start, startMs + 1_999)).toBe(1);
  });

  it('clamps to 0 when now is before start (clock skew)', () => {
    expect(elapsedSeconds(start, startMs - 5_000)).toBe(0);
  });

  it('returns 0 for null/undefined/invalid start', () => {
    expect(elapsedSeconds(null, startMs)).toBe(0);
    expect(elapsedSeconds(undefined, startMs)).toBe(0);
    expect(elapsedSeconds('not-a-date', startMs)).toBe(0);
  });
});

describe('formatElapsed', () => {
  it('formats sub-minute as M:SS', () => {
    expect(formatElapsed(5)).toBe('0:05');
    expect(formatElapsed(59)).toBe('0:59');
  });

  it('formats minutes as M:SS with zero-padded seconds', () => {
    expect(formatElapsed(60)).toBe('1:00');
    expect(formatElapsed(12 * 60 + 34)).toBe('12:34');
  });

  it('formats an hour+ as H:MM:SS with zero-padded minutes', () => {
    expect(formatElapsed(3600)).toBe('1:00:00');
    expect(formatElapsed(3600 + 2 * 60 + 9)).toBe('1:02:09');
  });

  it('clamps negative / non-finite to 0:00', () => {
    expect(formatElapsed(-1)).toBe('0:00');
    expect(formatElapsed(NaN)).toBe('0:00');
    expect(formatElapsed(Infinity)).toBe('0:00');
  });
});

describe('formatElapsedSince', () => {
  it('composes elapsed + format', () => {
    const start = '2026-07-11T10:00:00.000Z';
    expect(formatElapsedSince(start, Date.parse(start) + 90_000)).toBe('1:30');
  });

  it('is 0:00 for a null start', () => {
    expect(formatElapsedSince(null, 1_000_000)).toBe('0:00');
  });
});

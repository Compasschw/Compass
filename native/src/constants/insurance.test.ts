import { describe, it, expect } from 'vitest';

import {
  normalizeCin,
  validateCinForCarrier,
  expectedFormatMessage,
} from './insurance';

describe('normalizeCin', () => {
  it('uppercases and strips spaces/dashes', () => {
    expect(normalizeCin(' 9123-4567 a2 ')).toBe('91234567A2');
  });
});

describe('validateCinForCarrier', () => {
  it('accepts a well-formed Medi-Cal CIN', () => {
    const r = validateCinForCarrier('91234567A2', 'Health Net');
    expect(r.valid).toBe(true);
    expect(r.normalized).toBe('91234567A2');
  });

  it('accepts a CIN without the trailing digit (9 digits + letter)', () => {
    expect(validateCinForCarrier('91234567A', 'Health Net').valid).toBe(true);
  });

  it('flags an obviously malformed CIN', () => {
    expect(validateCinForCarrier('12', 'Health Net').valid).toBe(false);
  });

  it('never throws and falls back for an unknown carrier label', () => {
    const r = validateCinForCarrier('91234567A2', 'Not A Real Carrier');
    expect(r.valid).toBe(true);
    expect(r.status).toBe('confirmed');
  });

  it('normalizes before validating (spaces/dashes do not fail a good CIN)', () => {
    expect(validateCinForCarrier('9123 4567 A2', 'Health Net').valid).toBe(true);
  });
});

describe('expectedFormatMessage', () => {
  it('gives a generic message when no carrier is selected', () => {
    expect(expectedFormatMessage('')).toMatch(/Member IDs look like/);
  });

  it('names the carrier when a known label is passed', () => {
    expect(expectedFormatMessage('Health Net')).toContain('Health Net');
  });
});

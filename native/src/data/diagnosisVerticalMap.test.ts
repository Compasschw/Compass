import { describe, it, expect } from 'vitest';

import { diagnosisCodes } from './mock';
import {
  DIAGNOSIS_VERTICAL_GROUPS,
  diagnosisCodeGroup,
  diagnosisGroupLabel,
  diagnosisGroupColor,
  diagnosisGroupEmoji,
} from './diagnosisVerticalMap';

describe('diagnosisCodeGroup', () => {
  it('groups a housing-coded example under housing (grandfathered)', () => {
    expect(diagnosisCodeGroup('Z59.00')).toBe('housing'); // Homelessness, unspecified
    expect(diagnosisCodeGroup('Z59.10')).toBe('housing'); // Inadequate housing, unspecified
  });

  it('groups a utilities-coded example under utilities', () => {
    expect(diagnosisCodeGroup('Z59.861')).toBe('utilities'); // difficulty paying for utilities
    expect(diagnosisCodeGroup('Z59.869')).toBe('utilities'); // financial insecurity, unspecified
  });

  it('groups food, transportation, employment codes correctly', () => {
    expect(diagnosisCodeGroup('Z59.4')).toBe('food');
    expect(diagnosisCodeGroup('Z59.82')).toBe('transportation');
    expect(diagnosisCodeGroup('Z56.9')).toBe('employment');
  });

  it('groups psych-adjacent codes under mental_health', () => {
    expect(diagnosisCodeGroup('Z71.89')).toBe('mental_health');
    expect(diagnosisCodeGroup('Z60.2')).toBe('mental_health');
  });

  it('groups healthcare-access codes under healthcare', () => {
    expect(diagnosisCodeGroup('Z55.6')).toBe('healthcare');
    expect(diagnosisCodeGroup('Z75.3')).toBe('healthcare');
  });

  it('falls back to "others" for any unmapped code', () => {
    expect(diagnosisCodeGroup('Z99.99-not-a-real-code')).toBe('others');
  });

  it('maps every code in the active picker catalog to a defined group (never silently dropped)', () => {
    for (const { code } of diagnosisCodes) {
      const group = diagnosisCodeGroup(code);
      expect(DIAGNOSIS_VERTICAL_GROUPS).toContain(group);
    }
  });
});

describe('diagnosisGroupLabel / Color / Emoji', () => {
  it('returns a non-empty, non-raw-key label for every group', () => {
    for (const group of DIAGNOSIS_VERTICAL_GROUPS) {
      const label = diagnosisGroupLabel(group);
      expect(label.length).toBeGreaterThan(0);
      // Utilities/Others aren't in lib/verticals.ts yet — must resolve to a
      // human label, not the raw enum key.
      if (group === 'utilities' || group === 'others') {
        expect(label).not.toBe(group);
      }
    }
  });

  it('returns a hex color for every group', () => {
    for (const group of DIAGNOSIS_VERTICAL_GROUPS) {
      expect(diagnosisGroupColor(group)).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it('returns an emoji for every group', () => {
    for (const group of DIAGNOSIS_VERTICAL_GROUPS) {
      expect(diagnosisGroupEmoji(group).length).toBeGreaterThan(0);
    }
  });

  it('housing label matches lib/verticals.ts authoritative label', () => {
    expect(diagnosisGroupLabel('housing')).toBe('Housing');
  });
});

import { describe, it, expect } from 'vitest';

import {
  VERTICAL_ENUM,
  SELECTABLE_VERTICALS,
  VERTICAL_LABEL,
  VERTICAL_COLOR,
  VERTICAL_EMOJI,
  VERTICAL_FILTER_OPTIONS,
  VERTICAL_PICKER_OPTIONS,
  verticalLabel,
  type Vertical,
} from './verticals';

/**
 * Epic C5 — Housing → Utilities, with historical rows grandfathered.
 *
 * These tests lock in the exact contract the rest of the app depends on:
 *   - 'housing' remains a member of VERTICAL_ENUM/Vertical (so legacy wire
 *     data still type-checks and deserializes) and of every display map
 *     (label/color/emoji), so a historical row still RENDERS as "Housing".
 *   - 'housing' is excluded from every SELECTABLE/offered surface (picker +
 *     filter options), so it can never be chosen again.
 *   - 'utilities' is present everywhere 'housing' used to be offered.
 */

describe('VERTICAL_ENUM / Vertical type', () => {
  it('still includes the grandfathered "housing" value', () => {
    expect(VERTICAL_ENUM).toContain('housing');
  });

  it('includes the new "utilities" value', () => {
    expect(VERTICAL_ENUM).toContain('utilities');
  });
});

describe('SELECTABLE_VERTICALS', () => {
  it('excludes "housing"', () => {
    expect(SELECTABLE_VERTICALS).not.toContain('housing');
  });

  it('includes "utilities"', () => {
    expect(SELECTABLE_VERTICALS).toContain('utilities');
  });

  it('contains every VERTICAL_ENUM member except housing, with no extras', () => {
    const expected = VERTICAL_ENUM.filter((v) => v !== 'housing');
    expect([...SELECTABLE_VERTICALS].sort()).toEqual([...expected].sort());
  });
});

describe('VERTICAL_LABEL', () => {
  it('still maps "housing" to "Housing" (grandfathered rendering)', () => {
    expect(VERTICAL_LABEL.housing).toBe('Housing');
  });

  it('maps "utilities" to "Utilities"', () => {
    expect(VERTICAL_LABEL.utilities).toBe('Utilities');
  });

  it('has an entry for every VERTICAL_ENUM member', () => {
    for (const v of VERTICAL_ENUM) {
      expect(VERTICAL_LABEL[v]).toBeTruthy();
    }
  });
});

describe('verticalLabel()', () => {
  it('still returns "Housing" for a legacy wire value', () => {
    expect(verticalLabel('housing')).toBe('Housing');
  });

  it('returns "Utilities" for the new value', () => {
    expect(verticalLabel('utilities')).toBe('Utilities');
  });

  it('falls back to the raw string for an unrecognised value', () => {
    expect(verticalLabel('not_a_real_vertical')).toBe('not_a_real_vertical');
  });
});

describe('VERTICAL_COLOR', () => {
  it('keeps a color for the grandfathered "housing" value', () => {
    expect(VERTICAL_COLOR.housing).toBe('#3B82F6');
  });

  it('has a distinct color for "utilities"', () => {
    expect(VERTICAL_COLOR.utilities).toBeTruthy();
    expect(VERTICAL_COLOR.utilities).not.toBe(VERTICAL_COLOR.housing);
  });

  it('has an entry for every VERTICAL_ENUM member', () => {
    for (const v of VERTICAL_ENUM) {
      expect(VERTICAL_COLOR[v]).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});

describe('VERTICAL_EMOJI', () => {
  it('keeps an emoji for the grandfathered "housing" value', () => {
    expect(VERTICAL_EMOJI.housing).toBe('🏠');
  });

  it('has a distinct emoji for "utilities"', () => {
    expect(VERTICAL_EMOJI.utilities).toBeTruthy();
    expect(VERTICAL_EMOJI.utilities).not.toBe(VERTICAL_EMOJI.housing);
  });

  it('has an entry for every VERTICAL_ENUM member', () => {
    for (const v of VERTICAL_ENUM) {
      expect(VERTICAL_EMOJI[v]).toBeTruthy();
    }
  });
});

describe('VERTICAL_FILTER_OPTIONS', () => {
  it('does not offer "housing" as a filter option', () => {
    expect(VERTICAL_FILTER_OPTIONS.some((o) => o.key === 'housing')).toBe(false);
  });

  it('offers "utilities" as a filter option with the correct label', () => {
    const option = VERTICAL_FILTER_OPTIONS.find((o) => o.key === 'utilities');
    expect(option).toBeTruthy();
    expect(option?.label).toBe('Utilities');
  });

  it('has exactly one option per SELECTABLE_VERTICALS entry', () => {
    expect(VERTICAL_FILTER_OPTIONS.map((o) => o.key).sort()).toEqual(
      [...SELECTABLE_VERTICALS].sort(),
    );
  });
});

describe('VERTICAL_PICKER_OPTIONS', () => {
  it('does not offer "housing" as a picker option', () => {
    expect(VERTICAL_PICKER_OPTIONS.some((o) => o.key === 'housing')).toBe(false);
  });

  it('offers "utilities" as a picker option with label + emoji', () => {
    const option = VERTICAL_PICKER_OPTIONS.find((o) => o.key === 'utilities');
    expect(option).toBeTruthy();
    expect(option?.label).toBe('Utilities');
    expect(option?.emoji).toBe('💡');
  });

  it('has exactly one option per SELECTABLE_VERTICALS entry', () => {
    expect(VERTICAL_PICKER_OPTIONS.map((o) => o.key).sort()).toEqual(
      [...SELECTABLE_VERTICALS].sort(),
    );
  });
});

describe('Vertical type admits legacy wire values (compile-time contract)', () => {
  it('accepts "housing" as a valid Vertical at the type level', () => {
    // This assignment only compiles if 'housing' still satisfies the
    // Vertical union — a regression here would fail `tsc`, not this
    // assertion, but the runtime check documents the intent.
    const legacy: Vertical = 'housing';
    expect(legacy).toBe('housing');
  });
});

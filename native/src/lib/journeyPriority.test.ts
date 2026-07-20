/**
 * Regression tests for shared journey-priority resolution.
 *
 * Root cause of JT's bug (2026-07-20): the Active Needs / Care Status rail
 * fabricated priority from progress % while the Member Journey card read the
 * CHW-assigned resource_need_levels — so High/Medium flipped between panels.
 * These tests lock in that priority comes from the stored level, high-first,
 * independent of progress.
 */
import { describe, expect, it } from 'vitest';

import {
  activeJourneysWithLevel,
  deriveSeverity,
  resolveResourceNeedSlug,
} from './journeyPriority';
import type { MemberJourneyResponse } from '../hooks/useApiQueries';

function journey(
  name: string,
  progressPercent: number,
  extra: Partial<MemberJourneyResponse> = {},
): MemberJourneyResponse {
  return {
    id: `j-${name}`,
    status: 'active',
    progressPercent,
    template: { name } as MemberJourneyResponse['template'],
    priorityLevel: null,
    ...extra,
  } as MemberJourneyResponse;
}

describe('activeJourneysWithLevel', () => {
  it("uses the CHW-assigned level, not progress — JT's exact scenario", () => {
    // Employment=High is further along (33%) than Transportation=Medium (0%).
    // Progress-based ranking would (wrongly) make Transportation "High" #1.
    const journeys = [journey('Employment', 33), journey('Transportation', 0)];
    const levels = { employment: 'high' as const, transportation: 'medium' as const };

    const result = activeJourneysWithLevel(journeys, levels);

    // High first regardless of progress: Employment #1 High, Transportation #2 Medium.
    expect(result.map((r) => [r.journey.template.name, r.level])).toEqual([
      ['Employment', 'high'],
      ['Transportation', 'medium'],
    ]);
  });

  it('sorts high → medium → low', () => {
    const journeys = [journey('Food Security', 10), journey('Employment', 90), journey('Healthcare', 50)];
    const levels = { food: 'low' as const, employment: 'high' as const, healthcare: 'medium' as const };

    const result = activeJourneysWithLevel(journeys, levels);

    expect(result.map((r) => r.level)).toEqual(['high', 'medium', 'low']);
  });

  it('falls back to progress-derived severity only when no CHW level exists', () => {
    const journeys = [journey('Custom Need', 10)]; // not a fixed need, no priorityLevel
    const result = activeJourneysWithLevel(journeys, {});
    expect(result[0].level).toBe('high'); // deriveSeverity(10) === 'high'
  });

  it('honors a custom journey priorityLevel over progress', () => {
    const journeys = [journey('Custom Need', 10, { priorityLevel: 'low' })];
    const result = activeJourneysWithLevel(journeys, {});
    expect(result[0].level).toBe('low');
  });

  it('resolves grandfathered Housing to its stored level', () => {
    const journeys = [journey('Housing', 5)];
    const result = activeJourneysWithLevel(journeys, { housing: 'medium' });
    expect(result[0].level).toBe('medium');
  });

  it('excludes non-active journeys', () => {
    const journeys = [journey('Employment', 0, { status: 'completed' })];
    expect(activeJourneysWithLevel(journeys, { employment: 'high' })).toHaveLength(0);
  });
});

describe('resolveResourceNeedSlug', () => {
  it('maps fixed need names to slugs and returns undefined for custom names', () => {
    expect(resolveResourceNeedSlug('Transportation')).toBe('transportation');
    expect(resolveResourceNeedSlug('Employment')).toBe('employment');
    expect(resolveResourceNeedSlug('Housing')).toBe('housing'); // grandfathered
    expect(resolveResourceNeedSlug('Some Custom Need')).toBeUndefined();
  });
});

describe('deriveSeverity', () => {
  it('maps progress to severity (fallback only)', () => {
    expect(deriveSeverity(0)).toBe('high');
    expect(deriveSeverity(50)).toBe('medium');
    expect(deriveSeverity(90)).toBe('low');
  });
});

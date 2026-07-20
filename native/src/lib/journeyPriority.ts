/**
 * Single source of truth for resource-need taxonomy and journey priority.
 *
 * Priority for a member's resource needs is CHW-assigned and stored on the
 * member profile (`resource_need_levels`, a {slug: level} map). Journeys are
 * created 1:1 from those needs, but canonical journeys carry `priority_level =
 * null` on the wire (see backend `MemberJourney.priority_level`), so priority
 * must be resolved by mapping a journey's template name back to its need slug
 * and reading the stored level.
 *
 * Every panel that shows a need's priority MUST resolve it through
 * `activeJourneysWithLevel` here — the Member Journey card and the Active
 * Needs / Care Status rail both do, so they can never disagree again. (They
 * previously diverged because one screen fabricated priority from progress %.)
 */
import type { MemberJourneyResponse, ResourceNeedLevel } from '../hooks/useApiQueries';

export type JourneySeverity = 'high' | 'medium' | 'low';

/** The six selectable resource needs (CHW picks from these when editing). */
export const RESOURCE_NEED_OPTIONS: ReadonlyArray<{ slug: string; label: string }> = [
  { slug: 'utilities',      label: 'Utilities' },
  { slug: 'transportation', label: 'Transportation' },
  { slug: 'food',           label: 'Food Security' },
  { slug: 'mental_health',  label: 'Mental Health' },
  { slug: 'healthcare',     label: 'Healthcare' },
  { slug: 'employment',     label: 'Employment' },
];

/**
 * Grandfathered superset — adds back 'housing' so a legacy Housing journey
 * still resolves to its CHW-assigned level. Use this (not RESOURCE_NEED_OPTIONS)
 * anywhere template-name/slug matching happens against EXISTING journeys.
 */
export const GRANDFATHERED_RESOURCE_NEED_OPTIONS: ReadonlyArray<{ slug: string; label: string }> = [
  { slug: 'housing', label: 'Housing' },
  ...RESOURCE_NEED_OPTIONS,
];

/** Canonical journey/template names that map 1:1 to a fixed resource need. */
export const CANONICAL_JOURNEY_NAMES: ReadonlySet<string> = new Set(
  GRANDFATHERED_RESOURCE_NEED_OPTIONS.map((o) => o.label),
);

/** Resolve a journey template name to its resource-need slug, if it is a fixed need. */
export function resolveResourceNeedSlug(templateName: string): string | undefined {
  return GRANDFATHERED_RESOURCE_NEED_OPTIONS.find((o) => o.label === templateName)?.slug;
}

/** Fallback severity derived from progress — used only when no CHW level exists. */
export function deriveSeverity(progressPercent: number): JourneySeverity {
  if (progressPercent < 33) return 'high';
  if (progressPercent < 67) return 'medium';
  return 'low';
}

/** Stable sort order for CHW-assigned resource need levels (high first). */
export const LEVEL_SORT_ORDER: Record<ResourceNeedLevel, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/**
 * The member's active journeys paired with their DISPLAY level, sorted
 * high→medium→low. THE single source of truth for priority across every panel.
 *
 * Level resolution: a fixed-need journey uses the CHW-assigned resource-need
 * level when set; a custom journey uses its own `priorityLevel`; anything else
 * falls back to a progress-derived severity.
 */
export function activeJourneysWithLevel(
  journeys: MemberJourneyResponse[] | undefined,
  resourceNeedLevels: Record<string, ResourceNeedLevel>,
): { journey: MemberJourneyResponse; level: JourneySeverity }[] {
  return (journeys ?? [])
    .filter((j) => j.status === 'active')
    .map((journey, i) => {
      const slug = resolveResourceNeedSlug(journey.template.name);
      let level: JourneySeverity;
      if (slug !== undefined && slug in resourceNeedLevels) {
        level = resourceNeedLevels[slug];
      } else if (journey.priorityLevel) {
        level = journey.priorityLevel;
      } else {
        level = deriveSeverity(journey.progressPercent);
      }
      return { journey, level, i };
    })
    .sort((a, b) => {
      const diff = LEVEL_SORT_ORDER[a.level] - LEVEL_SORT_ORDER[b.level];
      return diff !== 0 ? diff : a.i - b.i;
    })
    .map(({ journey, level }) => ({ journey, level }));
}

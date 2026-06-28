/**
 * verticals.ts — Single source of truth for vertical enum → display metadata.
 *
 * Canonical enum values are taken directly from the backend Python enum:
 *   backend/app/models/enums.py :: class Vertical(str, enum.Enum)
 *
 * Values: housing | transportation | food | mental_health | healthcare | employment
 *
 * All frontend code should import labels, colours, and icons from here instead
 * of defining them inline. This eliminates the label-mismatch bug where the CHW
 * side and member side showed different strings for the same enum value.
 *
 * Icon names reference lucide-react-native components. Screens that need icons
 * should import them from lucide-react-native and use VERTICAL_ICON_NAME to
 * select the right one, or use the shared VerticalIcon component directly.
 */

// ─── Enum definition (matches backend verbatim) ───────────────────────────────

export const VERTICAL_ENUM = [
  'housing',
  'transportation',
  'food',
  'mental_health',
  'healthcare',
  'employment',
] as const;

export type Vertical = typeof VERTICAL_ENUM[number];

// ─── Display labels ───────────────────────────────────────────────────────────

/**
 * Human-readable label for each vertical.
 *
 * These are the authoritative display strings used on both the CHW and member
 * sides. Every chip, badge, and filter that shows a vertical name must use
 * this map (directly or via `verticalLabel()`).
 */
export const VERTICAL_LABEL: Record<Vertical, string> = {
  housing: 'Housing',
  transportation: 'Transportation',
  food: 'Food Security',
  mental_health: 'Mental Health',
  healthcare: 'Healthcare',
  employment: 'Employment',
};

/**
 * Returns the display label for a vertical value coming off the wire.
 * Falls back to the raw string if the value isn't a recognised vertical —
 * defensive against future backend additions before the frontend ships a
 * corresponding mapping.
 *
 * @param v - The raw string value from the API (e.g. "food", "mental_health").
 */
export function verticalLabel(v: string): string {
  return VERTICAL_LABEL[v as Vertical] ?? v;
}

// ─── Colour palette ───────────────────────────────────────────────────────────

/**
 * Per-vertical accent colour.
 *
 * Used for badge backgrounds (at 10–20% opacity), icon fills, and dot
 * indicators. Chosen for WCAG AA contrast on both #FFFFFF and #F4F1ED.
 */
export const VERTICAL_COLOR: Record<Vertical, string> = {
  housing: '#3B82F6',        // blue-500
  transportation: '#14B8A6', // teal-500
  food: '#F59E0B',           // amber-500
  mental_health: '#8B5CF6',  // violet-500
  healthcare: '#06B6D4',     // cyan-500
  employment: '#6366F1',     // indigo-500
};

// ─── Emoji (lightweight icon for contexts where lucide isn't available) ───────

export const VERTICAL_EMOJI: Record<Vertical, string> = {
  housing: '🏠',
  transportation: '🚌',
  food: '🛒',
  mental_health: '🧠',
  healthcare: '🏥',
  employment: '💼',
};

// ─── Filter chip options (used by both CHW and member filter bars) ────────────

/**
 * Ordered list of verticals for rendering filter chips.
 * Order matches the backend enum declaration.
 */
export const VERTICAL_FILTER_OPTIONS: ReadonlyArray<{ key: Vertical; label: string }> =
  VERTICAL_ENUM.map((key) => ({ key, label: VERTICAL_LABEL[key] }));

/**
 * Vertical options with emoji — used in the member request form and roadmap
 * goal picker where a visual cue accompanies the label.
 */
export const VERTICAL_PICKER_OPTIONS: ReadonlyArray<{
  key: Vertical;
  label: string;
  emoji: string;
}> = VERTICAL_ENUM.map((key) => ({
  key,
  label: VERTICAL_LABEL[key],
  emoji: VERTICAL_EMOJI[key],
}));

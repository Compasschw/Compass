/**
 * verticals.ts — Single source of truth for vertical enum → display metadata.
 *
 * Canonical enum values are taken directly from the backend Python enum:
 *   backend/app/models/enums.py :: class Vertical(str, enum.Enum)
 *
 * Values: housing | utilities | transportation | food | mental_health | healthcare | employment
 *
 * All frontend code should import labels, colours, and icons from here instead
 * of defining them inline. This eliminates the label-mismatch bug where the CHW
 * side and member side showed different strings for the same enum value.
 *
 * Icon names reference lucide-react-native components. Screens that need icons
 * should import them from lucide-react-native and use VERTICAL_ICON_NAME to
 * select the right one, or use the shared VerticalIcon component directly.
 *
 * ─── Epic C5 — Housing → Utilities (grandfathering) ────────────────────────
 * "Utilities" replaced "Housing" as a NEWLY selectable vertical. Historical
 * `housing`-tagged rows are GRANDFATHERED, not migrated: `housing` remains in
 * VERTICAL_ENUM (so the `Vertical` type still admits it, and legacy wire data
 * type-checks and renders) and in every label/colour/emoji map (so an old row
 * still renders the "Housing" chip with its original styling). It is simply
 * excluded from `SELECTABLE_VERTICALS`, which is what drives every picker and
 * filter surface offered for NEW selections. Never re-add `housing` to
 * SELECTABLE_VERTICALS — a re-labeled homelessness case must not resurface as
 * a utility-bill case.
 */

// ─── Enum definition (matches backend verbatim) ───────────────────────────────

export const VERTICAL_ENUM = [
  'housing',
  'utilities',
  'transportation',
  'food',
  'mental_health',
  'healthcare',
  'employment',
] as const;

export type Vertical = typeof VERTICAL_ENUM[number];

/**
 * Verticals that may be NEWLY selected — used to derive every picker and
 * filter-chip surface. `housing` is intentionally excluded: it is
 * grandfathered (still renderable via VERTICAL_LABEL/COLOR/EMOJI and still a
 * member of VERTICAL_ENUM/Vertical) but must never be offered again as a
 * choice. `utilities` is its replacement.
 */
export const SELECTABLE_VERTICALS = VERTICAL_ENUM.filter(
  (v): v is Exclude<Vertical, 'housing'> => v !== 'housing',
);

// ─── Display labels ───────────────────────────────────────────────────────────

/**
 * Human-readable label for each vertical.
 *
 * These are the authoritative display strings used on both the CHW and member
 * sides. Every chip, badge, and filter that shows a vertical name must use
 * this map (directly or via `verticalLabel()`).
 */
export const VERTICAL_LABEL: Record<Vertical, string> = {
  // Grandfathered — no longer selectable, but historical rows must still
  // render "Housing" (never relabel a homelessness case as a utility case).
  housing: 'Housing',
  utilities: 'Utilities',
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
  // Grandfathered — kept so historical `housing` rows keep their original
  // badge colour. Not offered as a new selection (see SELECTABLE_VERTICALS).
  housing: '#3B82F6',        // blue-500
  utilities: '#F97316',      // orange-500
  transportation: '#14B8A6', // teal-500
  food: '#F59E0B',           // amber-500
  mental_health: '#8B5CF6',  // violet-500
  healthcare: '#06B6D4',     // cyan-500
  employment: '#6366F1',     // indigo-500
};

// ─── Emoji (lightweight icon for contexts where lucide isn't available) ───────

export const VERTICAL_EMOJI: Record<Vertical, string> = {
  // Grandfathered — kept so historical `housing` rows keep their original
  // emoji. Not offered as a new selection (see SELECTABLE_VERTICALS).
  housing: '🏠',
  utilities: '💡',
  transportation: '🚌',
  food: '🛒',
  mental_health: '🧠',
  healthcare: '🏥',
  employment: '💼',
};

// ─── Filter chip options (used by both CHW and member filter bars) ────────────

/**
 * Ordered list of verticals for rendering filter chips.
 *
 * Derived from SELECTABLE_VERTICALS (not VERTICAL_ENUM) — `housing` is
 * grandfathered and must never be offered as a filter/selection option again.
 * A legacy housing-tagged row still renders correctly via VERTICAL_LABEL; it
 * simply can't be newly chosen from this list.
 */
export const VERTICAL_FILTER_OPTIONS: ReadonlyArray<{ key: Vertical; label: string }> =
  SELECTABLE_VERTICALS.map((key) => ({ key, label: VERTICAL_LABEL[key] }));

/**
 * Vertical options with emoji — used in the member request form and roadmap
 * goal picker where a visual cue accompanies the label.
 *
 * Derived from SELECTABLE_VERTICALS — see VERTICAL_FILTER_OPTIONS comment.
 */
export const VERTICAL_PICKER_OPTIONS: ReadonlyArray<{
  key: Vertical;
  label: string;
  emoji: string;
}> = SELECTABLE_VERTICALS.map((key) => ({
  key,
  label: VERTICAL_LABEL[key],
  emoji: VERTICAL_EMOJI[key],
}));

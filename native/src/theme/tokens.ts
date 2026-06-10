/**
 * Design-system tokens for the Compass dashboard UI revamp.
 *
 * These tokens target the dark-sage sidebar + white-card aesthetic from the
 * HTML mockup. They are separate from the existing theme/* files so they can
 * be adopted incrementally — import from here, not from theme/colors.ts.
 *
 * Naming mirrors the HTML mockup's CSS custom properties for a 1-to-1 mapping.
 */

import { Platform } from 'react-native';

// ─── Colors ───────────────────────────────────────────────────────────────────

export const colors = {
  // Sidebar
  sidebarBg:         '#134e36',
  sidebarBgEnd:      '#0f3d2a',
  sidebarText:       '#a7d4be',
  sidebarActiveText: '#0f3d2a',

  // Page & card surfaces
  pageBg:     '#f5f7f6',
  cardBg:     '#ffffff',
  cardBorder: '#f1f5f4',

  // Brand primary (emerald-600 / emerald-700)
  primary:      '#16a34a',
  primaryHover: '#15803d',

  // Semantic pill colour pairs (100-bg / 700-text Tailwind equivalents)
  emerald100: '#d1fae5',
  emerald700: '#047857',

  red100: '#fee2e2',
  red700: '#b91c1c',

  amber100: '#fef3c7',
  amber700: '#b45309',
  amber800: '#92400e',

  blue100: '#dbeafe',
  blue700: '#1d4ed8',

  purple100: '#ede9fe',
  purple700: '#6d28d9',

  orange100: '#ffedd5',
  orange700: '#c2410c',

  pink100: '#fce7f3',
  pink700: '#be185d',

  gray100: '#f3f4f6',
  gray600: '#4b5563',
  gray700: '#374151',

  slate100: '#f1f5f9',
  slate600: '#475569',
  slate700: '#334155',

  cyan100: '#cffafe',
  cyan600: '#0891b2',
  cyan700: '#0e7490',

  indigo100: '#e0e7ff',
  indigo600: '#4f46e5',
  indigo700: '#4338ca',

  rose100: '#ffe4e6',
  rose600: '#e11d48',
  rose700: '#be123c',

  teal100: '#ccfbf1',
  teal600: '#0d9488',
  teal700: '#0f766e',

  // Emerald shades (used by sidebar avatar, badges, and switch-view link)
  emerald300: '#6ee7b7',
  emerald500: '#10b981',
  emerald900: '#064e3b',

  // Text
  textPrimary:   '#111827',
  textSecondary: '#6b7280',
  textMuted:     '#9ca3af',
} as const;

export type ColorToken = keyof typeof colors;

// ─── Spacing ──────────────────────────────────────────────────────────────────

export const spacing = {
  xs:   4,   // gap-1
  sm:   8,   // gap-2
  md:   12,  // gap-3 / p-3
  lg:   16,  // gap-4 / p-4
  xl:   20,  // gap-5 / p-5
  xxl:  24,  // gap-6 / p-6
  xxxl: 32,  // p-8
} as const;

export type SpacingToken = keyof typeof spacing;

// ─── Border radius ────────────────────────────────────────────────────────────

export const radius = {
  sm:   6,
  md:   10,
  // rounded-xl in Tailwind = 12px
  lg:   12,
  // rounded-2xl in Tailwind = 16px
  xl:   16,
  pill: 999,
} as const;

export type RadiusToken = keyof typeof radius;

// ─── Typographic numerals ─────────────────────────────────────────────────────

/**
 * Apply `numerals.tabular` to any text that displays numeric values — counts,
 * durations, money amounts, percentages, and timestamps. Tabular-nums forces
 * every digit to the same advance width, eliminating layout jitter when values
 * change and aligning columns without monospace fallback fonts.
 *
 * Usage:
 * ```ts
 * <Text style={[styles.value, numerals.tabular]}>142</Text>
 * ```
 */
export const numerals = {
  tabular: { fontVariant: ['tabular-nums' as const] },
} as const;

// ─── Shadows ──────────────────────────────────────────────────────────────────

/**
 * `shadows.card` and `shadows.elevated` work on both React Native and web.
 *
 * On native iOS/Android use the RN shadow props. On web, StyleSheet
 * forwards unknown props to the DOM element's `style`, so `boxShadow`
 * renders correctly when accessed via `Platform.select`.
 *
 * Shadow colours use a page-tinted near-black (`rgba(16,24,20,1)`) so
 * perceived shadows shift from neutral grey to a barely-green-grey — sitting
 * IN the page rather than ON it.
 */
export const shadows = {
  /**
   * Matches Tailwind `shadow-sm`:
   *   0 1px 3px rgba(16,24,20,.04), 0 1px 2px rgba(16,24,20,.03)
   *
   * Native approximation uses a single soft tinted shadow layer.
   * Use on standard cards and panels.
   */
  card: Platform.select<Record<string, unknown>>({
    ios: {
      shadowColor:   'rgba(16, 24, 20, 1)',
      shadowOffset:  { width: 0, height: 1 },
      shadowOpacity: 0.04,
      shadowRadius:  3,
    },
    android: {
      elevation: 1,
    },
    web: {
      boxShadow: '0 1px 3px rgba(16,24,20,.04), 0 1px 2px rgba(16,24,20,.03)',
    },
    default: {},
  }) ?? {},

  /**
   * Two-layer tinted diffusion shadow for cards that need more lift (e.g.
   * modals, detail drawers, active/focused cards). Emulates the mockup's
   * layered `box-shadow` pattern with a medium ambient layer and a deeper
   * directional layer at reduced opacity.
   *
   * Native falls back to a single larger shadow (React Native cannot compose
   * multiple shadow layers natively).
   */
  elevated: Platform.select<Record<string, unknown>>({
    web: {
      boxShadow: '0 1px 3px rgba(16,24,20,.06), 0 8px 24px -12px rgba(19,78,54,.10)',
    },
    default: {
      shadowColor:   'rgba(16, 24, 20, 1)',
      shadowOpacity: 0.08,
      shadowRadius:  16,
      shadowOffset:  { width: 0, height: 4 },
      elevation:     6,
    },
  }) ?? {},
} as const;

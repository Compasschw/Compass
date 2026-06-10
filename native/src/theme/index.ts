/**
 * Theme barrel.
 *
 * Two token systems coexist — use the correct one for your context:
 *
 *   tokens  (from ./tokens)  — CANONICAL CHW / dashboard visual language.
 *                              White cards, emerald-600 primary, pageBg #f5f7f6.
 *                              All new screens (Wave 3 Member redesign onward)
 *                              must import from here.
 *
 *   colors  (from ./colors)  — Legacy warm-cream brand palette (hsl(35 30% 95%)).
 *                              Kept for backward compat; do NOT use for new work.
 *
 * Preferred import pattern for new screens:
 *   import { colors as tokens, spacing, radius, shadows } from '../../theme/tokens';
 * Or using this barrel:
 *   import { tokens, spacing, radius, shadows } from '../../theme';
 */

// ─── Canonical design-system tokens (CHW / dashboard visual language) ─────────
export {
  colors as tokens,
  spacing,
  radius,
  shadows,
  numerals,
} from './tokens';
export type { ColorToken as TokenColorKey, SpacingToken, RadiusToken } from './tokens';

// ─── Legacy brand colors — backward compat, do NOT use in new screens ─────────
export { colors } from './colors';
export type { ColorToken } from './colors';

// ─── Typography ───────────────────────────────────────────────────────────────
export { fonts, typography } from './typography';
export type { FontToken, TypographyToken } from './typography';

// ─── Legacy shadows + spacing (kept for existing call sites) ─────────────────
export { shadows as themeShadows } from './shadows';
export type { ShadowToken } from './shadows';

export { spacing as themeSpacing, radii } from './spacing';
export type { SpacingToken as ThemeSpacingToken, RadiusToken as ThemeRadiusToken } from './spacing';

/**
 * Avatar — initials-based circular avatar component.
 *
 * Renders a (default 40×40) circle with deterministic per-person colors and
 * initials derived from the display name. Each person gets the same color
 * every time, so members are visually distinguishable in lists at a glance.
 *
 * SCHEMA GAP (follow-up required):
 *   Add `avatar_url: str | None` to both the `users` table and the
 *   `chw_profiles` table, expose it on the session response DTO
 *   (`session.memberAvatarUrl`, `session.chwAvatarUrl`), and wire it to the
 *   `photoUri` prop below. The `Image` fallback branch is already stubbed but
 *   gated behind `photoUri !== undefined` so it never fires today.
 *   Tracked: add avatar_url to User + CHWProfile schema and session DTO.
 *
 * Usage:
 * ```tsx
 * <Avatar displayName="Maria Johnson" size={40} />
 * <Avatar displayName="James T" size={32} photoUri={session.chwAvatarUrl} />
 * <Avatar displayName="Maria Johnson" initials="MJ" size={36} />
 * ```
 */

import React, { useMemo } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { colors as paletteColors } from '../../theme/tokens';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface AvatarProps {
  /**
   * Full display name used to derive initials and the deterministic color.
   * "Maria Johnson" → "MJ", "CHW" → "C", "" → "?"
   */
  displayName: string;

  /**
   * Diameter of the avatar circle in logical pixels. Defaults to 40.
   * Both width and height are set to this value; borderRadius = size / 2.
   */
  size?: number;

  /**
   * Optional remote photo URI. When provided and truthy, renders an <Image>
   * instead of initials. Not used today — see SCHEMA GAP above.
   */
  photoUri?: string;

  /**
   * Optional override for the initials shown. Used when the backend already
   * computed display-safe initials (e.g., MembersRosterItem.avatarInitials)
   * and we want to mirror that exactly instead of re-deriving locally.
   */
  initials?: string;
}

// ─── Deterministic color palette ──────────────────────────────────────────────
//
// Each person's avatar gets the same color every time, derived from a stable
// hash over the input. This makes members visually distinguishable in long
// lists without requiring photos. The palette is intentionally pastel-bg /
// dark-text so the initial reads cleanly against any container background.

const AVATAR_PALETTE: ReadonlyArray<{ bg: string; text: string }> = [
  { bg: paletteColors.emerald100, text: paletteColors.emerald700 },
  { bg: paletteColors.blue100,    text: paletteColors.blue700    },
  { bg: paletteColors.purple100,  text: paletteColors.purple700  },
  { bg: paletteColors.amber100,   text: paletteColors.amber700   },
  { bg: paletteColors.rose100,    text: paletteColors.rose700    },
  { bg: paletteColors.indigo100,  text: paletteColors.indigo700  },
];

/**
 * Pick a palette entry from a stable hash over the seed string.
 * Same seed → same color, every call.
 */
export function avatarColorFor(seed: string): { bg: string; text: string } {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) & 0xffffffff;
  }
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Derive at most two uppercase initials from a display name.
 *
 * Algorithm:
 *   - Split on whitespace.
 *   - Take first character of the first word.
 *   - If there are two or more words, also take the first character of the
 *     last word (handles middle names gracefully).
 *   - Fall back to "?" for empty or whitespace-only names.
 */
function deriveInitials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.[0]?.toUpperCase() ?? '?';
  if (parts.length === 1) return first;
  const last = parts[parts.length - 1]?.[0]?.toUpperCase() ?? '';
  return `${first}${last}`;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Circular avatar. Today always renders initials; ready to swap in a photo URI
 * once the schema gap above is resolved.
 */
export function Avatar({
  displayName,
  size = 40,
  photoUri,
  initials: initialsOverride,
}: AvatarProps): React.JSX.Element {
  const initials = useMemo(
    () => initialsOverride ?? deriveInitials(displayName),
    [initialsOverride, displayName],
  );
  const palette = useMemo(
    () => avatarColorFor(initials || displayName),
    [initials, displayName],
  );

  const containerStyle = useMemo(
    () => ({
      width: size,
      height: size,
      borderRadius: size / 2,
    }),
    [size],
  );

  const fontSize = useMemo(() => Math.max(10, Math.round(size * 0.38)), [size]);

  // Photo branch — stubbed, not reachable today (no avatar_url in schema).
  if (photoUri) {
    return (
      <Image
        source={{ uri: photoUri }}
        style={[s.base, containerStyle]}
        accessibilityIgnoresInvertColors
        accessibilityRole="image"
        accessibilityLabel={`${displayName} avatar`}
      />
    );
  }

  return (
    <View
      style={[
        s.base,
        s.initialsContainer,
        containerStyle,
        { backgroundColor: palette.bg },
      ]}
      accessibilityRole="image"
      accessibilityLabel={`${displayName} avatar — initials ${initials}`}
    >
      <Text
        style={[s.initialsText, { fontSize, color: palette.text }]}
        allowFontScaling={false}
      >
        {initials}
      </Text>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  base: {
    overflow: 'hidden',
    flexShrink: 0,
  },
  initialsContainer: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  initialsText: {
    fontWeight: '700',
    letterSpacing: 0.5,
    lineHeight: undefined, // let the system handle line height at computed fontSize
  },
});

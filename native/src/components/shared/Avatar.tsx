/**
 * Avatar — initials-based circular avatar component.
 *
 * Renders a 40×40 (configurable) circle with a sage-green background and
 * white initials derived from the display name. Intentionally initials-only
 * for now: neither User nor CHWProfile stores an `avatar_url` column in the
 * current schema, so there is no photo URI to render.
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
 * ```
 */

import React, { useMemo } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { colors } from '../../theme/colors';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface AvatarProps {
  /**
   * Full display name used to derive initials.
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
}: AvatarProps): React.JSX.Element {
  const initials = useMemo(() => deriveInitials(displayName), [displayName]);

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
      style={[s.base, s.initialsContainer, containerStyle]}
      accessibilityRole="image"
      accessibilityLabel={`${displayName} avatar — initials ${initials}`}
    >
      <Text style={[s.initialsText, { fontSize }]} allowFontScaling={false}>
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
    backgroundColor: colors.compassSage,
    alignItems: 'center',
    justifyContent: 'center',
  },
  initialsText: {
    color: '#FFFFFF',
    fontWeight: '700',
    letterSpacing: 0.5,
    lineHeight: undefined, // let the system handle line height at computed fontSize
  },
});

/**
 * ConsentCheckboxes — the required two-checkbox signup consent block shared by
 * both member-creation surfaces:
 *   - Self-service RegisterScreen (member perspective: "I agree…" / "I consent…")
 *   - CHW AddMemberModal (CHW perspective: "The member agrees…" / "…consents…")
 *
 * Both boxes must be checked before the surface's submit button enables — the
 * caller owns that gate (this component is presentational + emits toggles). The
 * consent is persisted server-side (timestamped) for A2P 10DLC documented opt-in
 * and the HIPAA consent audit; the backend independently enforces it (422 if a
 * consent is missing/false), so this UI is the first of two gates, not the only.
 *
 * Accessibility: each row is a Pressable with accessibilityRole="checkbox" and a
 * checked accessibilityState, with the full label as its accessibilityLabel.
 *
 * Styling is palette-driven so each surface can pass its own on-brand tokens
 * (RegisterScreen's `colors`, AddMemberModal's `tokens`) without this component
 * depending on either theme module.
 *
 * "Terms of Service" and "Privacy Policy" render as bold text; when
 * `onPressTerms` / `onPressPrivacy` are provided they become tappable links
 * (accent-colored) — the caller supplies the destination (no URL is invented
 * here).
 */
import React from 'react';
import { StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { Pressable } from 'react-native';

export interface ConsentPalette {
  /** Checked-box fill + link color. */
  accent: string;
  /** Primary label text color. */
  text: string;
  /** Intro / secondary text color. */
  muted: string;
  /** Unchecked checkbox border color. */
  border: string;
  /** Checkmark glyph color (on the accent fill). */
  checkmark: string;
  /** Regular body font family. */
  fontRegular: string;
  /** Semibold font family (bold phrases + intro emphasis). */
  fontSemibold: string;
}

export interface ConsentCheckboxesProps {
  /** Intro line shown above the two checkboxes. */
  intro: string;
  /**
   * Text before "Terms of Service and Privacy Policy." in checkbox 1, e.g.
   * "I agree to the Compass" or "The member agrees to the Compass".
   */
  termsPrefix: string;
  /** Full plain-text label for checkbox 2 (communications + billing consent). */
  communicationsLabel: string;
  termsAccepted: boolean;
  communicationsConsent: boolean;
  onToggleTerms: () => void;
  onToggleCommunications: () => void;
  palette: ConsentPalette;
  /** When set, "Terms of Service" becomes a tappable link. */
  onPressTerms?: () => void;
  /** When set, "Privacy Policy" becomes a tappable link. */
  onPressPrivacy?: () => void;
  /** Disables interaction (e.g. while submitting). */
  disabled?: boolean;
  /** Optional container style override. */
  style?: ViewStyle;
  /** Test id prefix for the two rows (default "consent"). */
  testIDPrefix?: string;
}

function Checkbox({
  checked,
  palette,
}: {
  checked: boolean;
  palette: ConsentPalette;
}): React.JSX.Element {
  return (
    <View
      style={[
        styles.box,
        { borderColor: checked ? palette.accent : palette.border },
        checked && { backgroundColor: palette.accent },
      ]}
    >
      {checked && (
        <Text style={[styles.checkmark, { color: palette.checkmark }]}>✓</Text>
      )}
    </View>
  );
}

export function ConsentCheckboxes({
  intro,
  termsPrefix,
  communicationsLabel,
  termsAccepted,
  communicationsConsent,
  onToggleTerms,
  onToggleCommunications,
  palette,
  onPressTerms,
  onPressPrivacy,
  disabled = false,
  style,
  testIDPrefix = 'consent',
}: ConsentCheckboxesProps): React.JSX.Element {
  const termsFull = `${termsPrefix} Terms of Service and Privacy Policy.`;

  const boldOrLink = (
    label: string,
    onPress?: () => void,
  ): React.JSX.Element => (
    <Text
      style={[
        styles.bold,
        { fontFamily: palette.fontSemibold },
        onPress && { color: palette.accent },
      ]}
      // Nested-Text onPress works on both native and react-native-web.
      onPress={onPress && !disabled ? onPress : undefined}
      accessibilityRole={onPress ? 'link' : undefined}
    >
      {label}
    </Text>
  );

  return (
    <View style={[styles.container, style]}>
      <Text
        style={[styles.intro, { color: palette.muted, fontFamily: palette.fontSemibold }]}
      >
        {intro}
      </Text>

      {/* Checkbox 1 — Terms of Service + Privacy Policy */}
      <Pressable
        onPress={disabled ? undefined : onToggleTerms}
        disabled={disabled}
        style={styles.row}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: termsAccepted, disabled }}
        aria-checked={termsAccepted}
        accessibilityLabel={termsFull}
        testID={`${testIDPrefix}-terms`}
      >
        <Checkbox checked={termsAccepted} palette={palette} />
        <Text style={[styles.label, { color: palette.text, fontFamily: palette.fontRegular }]}>
          {termsPrefix}{' '}
          {boldOrLink('Terms of Service', onPressTerms)}
          {' and '}
          {boldOrLink('Privacy Policy', onPressPrivacy)}
          {'.'}
        </Text>
      </Pressable>

      {/* Checkbox 2 — communications + insurance-billing consent */}
      <Pressable
        onPress={disabled ? undefined : onToggleCommunications}
        disabled={disabled}
        style={styles.row}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: communicationsConsent, disabled }}
        aria-checked={communicationsConsent}
        accessibilityLabel={communicationsLabel}
        testID={`${testIDPrefix}-communications`}
      >
        <Checkbox checked={communicationsConsent} palette={palette} />
        <Text style={[styles.label, { color: palette.text, fontFamily: palette.fontRegular }]}>
          {communicationsLabel}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 10,
    marginTop: 12,
  },
  intro: {
    fontSize: 13,
    lineHeight: 18,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  box: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  checkmark: {
    fontSize: 14,
    lineHeight: 16,
    fontWeight: '700',
  },
  label: {
    flex: 1,
    fontSize: 13,
    lineHeight: 19,
  },
  bold: {
    fontWeight: '600',
  },
});

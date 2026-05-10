/**
 * MemberDeviceAudioConsentModal — one-time opt-in for member-side mic capture.
 *
 * When and why
 * ─────────────
 * During in-person sessions the member's device can capture their own voice
 * via the AudioWorklet/expo-audio pipeline (the same code the CHW side already
 * uses), streaming it to the backend through the existing
 * `/transcript/stream` WebSocket.  Because the JWT role attached to the
 * connection identifies the caller, speaker attribution is automatic.
 *
 * Before any capture can start the member must explicitly opt in.  The opt-in
 * is per-CHW-relationship (one-time): once the member grants it for a given CHW,
 * the modal never appears again for future sessions with that CHW.  A session
 * with a different CHW correctly triggers a fresh modal because no prior grant
 * exists for that pairing.
 *
 * Design decisions
 * ─────────────────
 * - No "revoke" button inside the modal — the member can decline by tapping
 *   "No thanks" at any time.  A future settings screen can surface revocation.
 * - The member must make an explicit choice (no backdrop dismiss, no timeout).
 * - Declining falls through to `subscribe_only` mode (CHW's mic still picks
 *   up what it can); capture is never silently enabled.
 * - Same visual language as the existing `MemberConsentModal` inside
 *   SessionChat.tsx: same card, same button styles, same color tokens.
 *
 * HIPAA
 * ─────
 * The modal does not render any PHI.  The typed_signature it sends to
 * POST /consent is the member's name (non-PHI).  Mic access is not requested
 * until after the user taps "Yes" and `onAccept` is called; this component
 * is purely a consent gate.
 *
 * Accessibility
 * ─────────────
 * - `accessibilityViewIsModal={true}` on the card confines screen-reader focus.
 * - Both buttons carry explicit `accessibilityLabel` strings.
 * - `accessibilityRole="alert"` on the card announces it as a dialog to
 *   TalkBack / VoiceOver.
 */

import React from 'react';
import {
  ActivityIndicator,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';

// ─── Props ─────────────────────────────────────────────────────────────────────

export interface MemberDeviceAudioConsentModalProps {
  /**
   * Controls Modal visibility.  Parent is responsible for gating this to
   * `!isCHW && session.status === 'in_progress' && session.mode === 'in_person'`.
   */
  visible: boolean;

  /**
   * CHW display name, used in the disclosure copy ("your CHW" is fine as a
   * fallback when the name is not yet resolved).
   */
  chwName: string;

  /**
   * Called when the member taps "Yes, share my device's audio".
   * The parent POSTs `device_audio_capture` consent and flips transcription
   * mode to `'mic_capture'`.
   *
   * May be called while `isGranting` is still true (button is disabled in
   * that case), so the parent must guard against concurrent calls.
   */
  onAccept: () => void;

  /**
   * Called when the member taps "No thanks".
   * The parent must fall through to `'subscribe_only'` transcription mode
   * (CHW's mic still picks up what it can; no member audio is captured).
   */
  onDecline: () => void;

  /**
   * True while the POST /consent mutation is in-flight.  Both buttons are
   * disabled and the accept button shows a spinner.
   */
  isGranting: boolean;
}

// ─── Component ─────────────────────────────────────────────────────────────────

/**
 * One-time member opt-in modal for device microphone capture during in-person
 * sessions.
 *
 * @example
 * ```tsx
 * <MemberDeviceAudioConsentModal
 *   visible={!chwAudioConsentActive && !declinedAudioCapture}
 *   chwName={session.chwName ?? 'your CHW'}
 *   onAccept={handleAcceptAudioCapture}
 *   onDecline={handleDeclineAudioCapture}
 *   isGranting={grantMutation.isPending}
 * />
 * ```
 */
export function MemberDeviceAudioConsentModal({
  visible,
  chwName,
  onAccept,
  onDecline,
  isGranting,
}: MemberDeviceAudioConsentModalProps): React.JSX.Element {
  const isActing = isGranting;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      // Member must make an explicit choice — no implicit dismissal.
      onRequestClose={() => undefined}
      statusBarTranslucent
    >
      <View style={s.backdrop}>
        <View
          style={s.card}
          accessibilityRole="alert"
          accessibilityLabel="Device microphone sharing consent"
          accessibilityViewIsModal
        >
          <Text style={s.title}>Share Your Microphone?</Text>

          {/*
           * Disclosure text follows HIPAA "minimum necessary" principle:
           *   - What is captured (your voice during in-person visit)
           *   - Why (so your CHW can hear you clearly in session notes)
           *   - Where it goes (secure transcription service, session notes only)
           *   - Privacy: never shared, not stored beyond the session
           *   - Right to decline (No thanks path)
           *
           * Plain language at ~6th-grade reading level per health literacy guidelines.
           */}
          <Text style={s.body}>
            To make sure{' '}
            <Text style={s.bold}>{chwName}</Text>{' '}
            can hear you clearly during this in-person visit, this app can use
            your device&rsquo;s microphone to capture your voice.
          </Text>

          <Text style={s.body}>
            Your audio is sent securely to our transcription service and is used
            only to generate notes for this session. It is never shared and is
            not stored beyond what is needed for your clinical record.
          </Text>

          <Text style={s.body}>
            You can say &ldquo;No thanks&rdquo; at any time — your CHW&rsquo;s
            microphone will still pick up what it can.
          </Text>

          <Text style={s.footnote}>
            You only need to decide once for sessions with this CHW.
          </Text>

          <View style={s.buttonRow}>
            {/* Decline button */}
            <TouchableOpacity
              style={[s.declineButton, isActing && s.buttonDisabled]}
              onPress={() => {
                if (!isActing) onDecline();
              }}
              disabled={isActing}
              accessibilityRole="button"
              accessibilityLabel="No thanks, do not share my device audio"
              accessibilityState={{ disabled: isActing }}
            >
              <Text style={s.declineText}>No thanks</Text>
            </TouchableOpacity>

            {/* Accept button */}
            <TouchableOpacity
              style={[s.acceptButton, isActing && s.buttonDisabled]}
              onPress={() => {
                if (!isActing) onAccept();
              }}
              disabled={isActing}
              accessibilityRole="button"
              accessibilityLabel="Yes, share my device audio for this session"
              accessibilityState={{ disabled: isActing }}
            >
              {isGranting ? (
                <ActivityIndicator
                  size="small"
                  color={colors.primaryForeground}
                />
              ) : (
                <Text style={s.acceptText}>Yes, share my device&apos;s audio</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: colors.card,
    borderRadius: 20,
    padding: 24,
    gap: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.2,
    shadowRadius: 24,
    elevation: 12,
  },
  title: {
    ...typography.displaySm,
    color: colors.foreground,
    fontSize: 18,
    fontWeight: '700',
  },
  body: {
    ...typography.bodySm,
    color: colors.foreground,
    lineHeight: 22,
  },
  bold: {
    fontWeight: '700',
  },
  footnote: {
    ...typography.bodySm,
    color: colors.mutedForeground,
    fontSize: 12,
    lineHeight: 18,
    fontStyle: 'italic',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 6,
  },
  declineButton: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 12,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  declineText: {
    ...typography.bodySm,
    fontWeight: '600',
    color: colors.mutedForeground,
  },
  acceptButton: {
    flex: 2,
    paddingVertical: 13,
    borderRadius: 12,
    backgroundColor: colors.primary,
    alignItems: 'center',
    paddingHorizontal: 8,
  },
  acceptText: {
    ...typography.bodySm,
    fontWeight: '600',
    color: colors.primaryForeground,
    textAlign: 'center',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
});

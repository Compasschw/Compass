/**
 * SessionChat — real-time(-ish) in-session chat for CompassCHW (Phase 1).
 *
 * Wired to the session-scoped backend endpoints:
 *   GET  /sessions/{session_id}/messages?after=<id>  — cursor-based poll (4 s)
 *   POST /sessions/{session_id}/messages             — send text message
 *   POST /sessions/{session_id}/messages/read        — mark read (side effect only)
 *   POST /sessions/{session_id}/call                 — initiate Vonage masked call
 *   POST /sessions/{session_id}/consent              — record AI-transcription consent
 *
 * Features:
 *   - Message bubbles: own messages right-aligned (primary colour), other left (neutral)
 *   - Sender label above each bubble ("You" / their name from session data)
 *   - Relative timestamp below each bubble ("2m ago" / "12:34 PM")
 *   - Auto-scroll to bottom on mount and on new messages
 *   - Polling every 4 s via refetchInterval (continues while transcription is active)
 *   - Optimistic send: bubble appears immediately; replaced on server response;
 *     "failed" state with retry tap on error
 *   - 1000-character limit with counter shown in the last 100 characters
 *   - Phone icon (lucide Phone) in header — calls Vonage bridge, shows inline toast
 *   - Mic icon (lucide Mic/MicOff) in header — toggles live session transcription
 *   - Recording indicator: animated red dot + MM:SS timer when transcription is active
 *   - Transcript chunks rendered inline with text messages, time-ordered
 *   - Consent gate modal before first recording start
 *   - "Followups processing" banner after stop (extraction happens in a separate flow)
 *   - Web fallback: graceful inline notice when transcription is not available
 *   - Read receipts fired when modal opens and when new messages arrive
 *
 * HIPAA: message bodies and transcript text are NEVER logged, NEVER included in
 * analytics events, and NEVER included in error toasts. Error objects have their
 * `body` field redacted before bubbling.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { MessageSquare, Mic, MicOff, Phone, Send } from 'lucide-react-native';

import { useAuth } from '../../context/AuthContext';
import {
  useSession,
  useSessionMessages,
  useSessionSendMessage,
  useSessionMarkRead,
  useStartCall,
  useGrantTranscriptionConsent,
  type SessionMessageLocal,
} from '../../hooks/useApiQueries';
import {
  useSessionTranscription,
  type TranscriptChunk,
} from '../../hooks/useSessionTranscription';
import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_CHARS = 1000;
const COUNTER_THRESHOLD = 100; // show counter when within this many chars of the limit

/** Session statuses that allow initiating a call. */
const CALLABLE_STATUSES = new Set(['scheduled', 'in_progress']);

/** States in which the transcription hook is considered "active" (blocks stop). */
const TRANSCRIPTION_ACTIVE_STATES = new Set([
  'recording',
  'connecting',
  'reconnecting',
] as const);

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A union item used for the merged render list.
 * Text messages carry their original SessionMessageLocal shape;
 * transcript chunks carry the TranscriptChunk shape plus a stable render key.
 */
type RenderItem =
  | { kind: 'message'; message: SessionMessageLocal }
  | { kind: 'transcript'; chunk: TranscriptChunk; id: string }
  | { kind: 'followup_banner' };

/**
 * Consent-gate lifecycle for the recording flow.
 *
 *   closed         → CHW has not opened the modal yet
 *   sending        → consent POST in flight
 *   awaiting_tap   → consent recorded; member notified; waiting for CHW 2nd tap
 *   error          → consent POST failed
 */
type ConsentGateState = 'closed' | 'sending' | 'awaiting_tap' | 'error';

// ─── Timestamp formatter ──────────────────────────────────────────────────────

/**
 * Returns a relative label ("2m ago", "Just now") or a clock time ("12:34 PM")
 * depending on how old the message is.
 */
function formatRelativeTime(isoString: string): string {
  try {
    const delta = Date.now() - new Date(isoString).getTime();
    const seconds = Math.floor(delta / 1000);
    if (seconds < 30) return 'Just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    // Older than 1 hour — show wall-clock time
    return new Date(isoString).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

/** Format elapsed seconds as MM:SS. */
function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

// ─── Inline toast ─────────────────────────────────────────────────────────────

interface InlineToastProps {
  message: string;
  isError: boolean;
}

function InlineToast({ message, isError }: InlineToastProps): React.JSX.Element {
  return (
    <View
      style={[toastStyles.container, isError ? toastStyles.error : toastStyles.success]}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <Text style={[toastStyles.text, isError ? toastStyles.errorText : toastStyles.successText]}>
        {message}
      </Text>
    </View>
  );
}

const toastStyles = StyleSheet.create({
  container: {
    marginHorizontal: 16,
    marginBottom: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
  },
  success: {
    backgroundColor: `${colors.primary}10`,
    borderColor: `${colors.primary}40`,
  },
  error: {
    backgroundColor: `${colors.destructive}10`,
    borderColor: `${colors.destructive}40`,
  },
  text: {
    ...typography.bodySm,
    fontWeight: '500',
  },
  successText: { color: colors.primary },
  errorText: { color: colors.destructive },
});

// ─── RecordingIndicator ───────────────────────────────────────────────────────

interface RecordingIndicatorProps {
  elapsedSeconds: number;
}

/**
 * Animated red dot + MM:SS timer shown in the header when transcription is live.
 *
 * Animation: the dot pulses between full opacity and ~20% opacity on a 1-second
 * cycle using withRepeat + withSequence from react-native-reanimated. The
 * animation runs on the UI thread (no JS bridge frame drops during scroll).
 * The useSharedValue + useAnimatedStyle pattern means only the Animated.View
 * node re-renders — the parent component is not touched.
 */
function RecordingIndicator({ elapsedSeconds }: RecordingIndicatorProps): React.JSX.Element {
  const dotOpacity = useSharedValue(1);

  useEffect(() => {
    dotOpacity.value = withRepeat(
      withSequence(
        withTiming(0.2, { duration: 500 }),
        withTiming(1, { duration: 500 }),
      ),
      -1, // infinite
      false,
    );
  }, [dotOpacity]);

  const animatedDotStyle = useAnimatedStyle(() => ({
    opacity: dotOpacity.value,
  }));

  return (
    <View style={recStyles.container} accessibilityRole="none">
      <Animated.View style={[recStyles.dot, animatedDotStyle]} />
      <Text style={recStyles.timer} accessibilityLabel={`Recording — ${formatDuration(elapsedSeconds)}`}>
        {formatDuration(elapsedSeconds)}
      </Text>
    </View>
  );
}

const recStyles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.destructive,
  },
  timer: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.destructive,
    fontVariant: ['tabular-nums'],
  },
});

// ─── MessageBubble ────────────────────────────────────────────────────────────

interface MessageBubbleProps {
  message: SessionMessageLocal;
  isOwn: boolean;
  /** Display name shown above the bubble for the other party. */
  otherPartyName: string;
  onRetry: (message: SessionMessageLocal) => void;
}

function MessageBubble({
  message,
  isOwn,
  otherPartyName,
  onRetry,
}: MessageBubbleProps): React.JSX.Element {
  const isFailed = message.status === 'failed';
  const isSending = message.status === 'sending';

  return (
    <View style={[b.wrapper, isOwn ? b.wrapperOwn : b.wrapperOther]}>
      {/* Sender label */}
      <Text style={[b.senderLabel, isOwn ? b.senderLabelOwn : b.senderLabelOther]}>
        {isOwn ? 'You' : otherPartyName}
      </Text>

      {/* Bubble */}
      <TouchableOpacity
        disabled={!isFailed}
        onPress={() => isFailed && onRetry(message)}
        activeOpacity={0.75}
        accessibilityRole={isFailed ? 'button' : undefined}
        accessibilityLabel={isFailed ? 'Message failed. Tap to retry.' : undefined}
        accessibilityHint={isFailed ? 'Double-tap to resend this message.' : undefined}
      >
        <View
          style={[
            b.bubble,
            isOwn ? b.bubbleOwn : b.bubbleOther,
            isFailed && b.bubbleFailed,
          ]}
        >
          <Text style={[b.bodyText, isOwn ? b.textOwn : b.textOther]}>
            {message.body}
          </Text>
          {isFailed && (
            <Text style={b.retryHint}>Tap to retry</Text>
          )}
        </View>
      </TouchableOpacity>

      {/* Timestamp row */}
      <View style={[b.metaRow, isOwn ? b.metaRowOwn : b.metaRowOther]}>
        {isSending && (
          <ActivityIndicator size="small" color={colors.mutedForeground} style={b.sendingIndicator} />
        )}
        <Text style={[b.timestamp, isOwn ? b.timestampOwn : b.timestampOther]}>
          {isSending ? 'Sending…' : formatRelativeTime(message.createdAt)}
        </Text>
      </View>
    </View>
  );
}

const b = StyleSheet.create({
  wrapper: {
    maxWidth: '80%',
    marginBottom: 14,
    gap: 3,
  },
  wrapperOwn: { alignSelf: 'flex-end', alignItems: 'flex-end' },
  wrapperOther: { alignSelf: 'flex-start', alignItems: 'flex-start' },

  senderLabel: {
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 2,
    paddingHorizontal: 4,
  },
  senderLabelOwn: { color: colors.mutedForeground, textAlign: 'right' },
  senderLabelOther: { color: colors.mutedForeground, textAlign: 'left' },

  bubble: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 18,
  },
  bubbleOwn: {
    backgroundColor: colors.primary,
    borderBottomRightRadius: 4,
  },
  bubbleOther: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderBottomLeftRadius: 4,
  },
  bubbleFailed: {
    opacity: 0.65,
  },

  bodyText: { ...typography.bodySm, lineHeight: 20 },
  textOwn: { color: colors.primaryForeground },
  textOther: { color: colors.foreground },

  retryHint: {
    marginTop: 4,
    fontSize: 10,
    fontWeight: '700',
    color: colors.destructive,
  },

  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 4,
  },
  metaRowOwn: { justifyContent: 'flex-end' },
  metaRowOther: { justifyContent: 'flex-start' },

  timestamp: { fontSize: 10, color: colors.mutedForeground },
  timestampOwn: { textAlign: 'right' },
  timestampOther: { textAlign: 'left' },

  sendingIndicator: { width: 10, height: 10 },
});

// ─── TranscriptBubble ─────────────────────────────────────────────────────────

interface TranscriptBubbleProps {
  chunk: TranscriptChunk;
  /** Display label for speakerRole === 'chw' (e.g. "You" or chwName). */
  chwLabel: string;
  /** Display label for speakerRole === 'member'. */
  memberLabel: string;
  /**
   * Running index for unknown speakers: 'A' → "Speaker A", 'B' → "Speaker B".
   * The parent tracks which unknown speakerLabel maps to which ordinal.
   */
  unknownSpeakerLabels: Record<'A' | 'B', string>;
}

/**
 * Renders a single transcript chunk inline with the message list.
 *
 * Visual distinction from text bubbles:
 *   - Full-width, left-aligned (transcript is not directional in the same way)
 *   - Muted background (colors.muted at 60% opacity)
 *   - Italic body text
 *   - Speaker label prefix ("You:", "Maria:", "Speaker A:")
 *
 * Low-confidence chunks (< 0.7) wrap the text in [brackets] to signal
 * uncertainty. On web (no hover) the long-press tooltip is the accessible
 * equivalent; on native a Pressable triggers an onLongPress alert/tooltip.
 */
function TranscriptBubble({
  chunk,
  chwLabel,
  memberLabel,
  unknownSpeakerLabels,
}: TranscriptBubbleProps): React.JSX.Element {
  const [showConfidenceNote, setShowConfidenceNote] = useState(false);

  const speakerLabel: string = (() => {
    if (chunk.speakerRole === 'chw') return chwLabel;
    if (chunk.speakerRole === 'member') return memberLabel;
    return unknownSpeakerLabels[chunk.speakerLabel];
  })();

  const isLowConfidence = chunk.confidence < 0.7;

  // HIPAA: we do not include any transcript text in accessibility descriptions.
  return (
    <View style={tr.wrapper}>
      <Text style={tr.speakerLabel}>{speakerLabel}</Text>
      <Pressable
        onLongPress={() => {
          if (isLowConfidence) {
            setShowConfidenceNote((prev) => !prev);
          }
        }}
        accessibilityRole="text"
        accessibilityLabel={
          isLowConfidence
            ? 'Transcript segment — low confidence. Long press for details.'
            : 'Transcript segment'
        }
      >
        <View style={[tr.bubble, !chunk.isFinal && tr.bubblePartial]}>
          <Text style={[tr.bodyText, isLowConfidence && tr.bodyTextLowConf]}>
            {/* HIPAA: text is rendered but never logged or passed to analytics */}
            {isLowConfidence ? `[${chunk.text}]` : chunk.text}
          </Text>
        </View>
      </Pressable>
      {showConfidenceNote && (
        <Text style={tr.confidenceNote}>
          Low confidence transcript — may contain errors.
        </Text>
      )}
    </View>
  );
}

const TRANSCRIPT_BG = `${colors.muted}99`; // colors.muted at ~60% opacity

const tr = StyleSheet.create({
  wrapper: {
    alignSelf: 'stretch',
    marginBottom: 10,
    gap: 3,
  },
  speakerLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.compassSage,
    paddingHorizontal: 4,
    marginBottom: 2,
    textTransform: 'capitalize',
  },
  bubble: {
    backgroundColor: TRANSCRIPT_BG,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: `${colors.border}80`,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  bubblePartial: {
    borderStyle: 'dashed',
  },
  bodyText: {
    ...typography.bodySm,
    fontStyle: 'italic',
    color: colors.foreground,
    lineHeight: 20,
  },
  bodyTextLowConf: {
    color: colors.mutedForeground,
  },
  confidenceNote: {
    fontSize: 10,
    color: colors.mutedForeground,
    paddingHorizontal: 4,
    fontStyle: 'italic',
  },
});

// ─── FollowupBanner ───────────────────────────────────────────────────────────

/**
 * Inline banner shown after the CHW stops recording. The actual extraction
 * POST is fired by the post-session flow; this component is UI-only.
 */
function FollowupBanner(): React.JSX.Element {
  return (
    <View
      style={fb.container}
      accessibilityRole="none"
      accessibilityLiveRegion="polite"
    >
      <Text style={fb.icon}>📋</Text>
      <Text style={fb.text}>
        Processing session — followups will appear here when ready.
      </Text>
    </View>
  );
}

const fb = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginHorizontal: 0,
    marginBottom: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: `${colors.compassGold}18`,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: `${colors.compassGold}40`,
  },
  icon: {
    fontSize: 16,
    lineHeight: 22,
  },
  text: {
    flex: 1,
    ...typography.bodySm,
    color: colors.foreground,
    lineHeight: 20,
  },
});

// ─── ConsentModal ─────────────────────────────────────────────────────────────

interface ConsentModalProps {
  visible: boolean;
  memberFirstName: string;
  chwName: string;
  consentState: ConsentGateState;
  /** Error message from a failed consent POST, if any. */
  consentError: string | null;
  /**
   * DEMO ONLY — CHW-side override that treats both parties as having consented
   * on the same device. This checkbox and the associated logic MUST be removed
   * before production launch. See issue #[demo-consent-override].
   */
  demoOverrideChecked: boolean;
  onDemoOverrideChange: (checked: boolean) => void;
  /** CHW tapped "Send consent request" or "I understand, start recording". */
  onConfirm: (demoOverride: boolean) => void;
  onClose: () => void;
}

function ConsentModal({
  visible,
  memberFirstName,
  chwName,
  consentState,
  consentError,
  demoOverrideChecked,
  onDemoOverrideChange,
  onConfirm,
  onClose,
}: ConsentModalProps): React.JSX.Element {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable
        style={cm.backdrop}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close consent dialog"
      >
        {/* Inner press trap so taps on the card don't propagate to backdrop */}
        <Pressable style={cm.card} onPress={() => undefined}>
          <Text style={cm.title}>Enable Session Recording</Text>

          {consentState === 'closed' || consentState === 'error' ? (
            <>
              <Text style={cm.body}>
                Recording will begin once{' '}
                <Text style={cm.memberName}>{memberFirstName}</Text> confirms
                consent. Sending consent request…
              </Text>
              {consentError !== null && (
                <Text style={cm.errorText}>{consentError}</Text>
              )}

              {/*
               * DEMO ONLY — remove this entire block before production.
               * Allows founders to test the full flow on a single device by
               * treating the CHW as having confirmed consent for both parties.
               * Issue #[demo-consent-override].
               */}
              {__DEV__ && (
                <TouchableOpacity
                  style={cm.checkRow}
                  onPress={() => onDemoOverrideChange(!demoOverrideChecked)}
                  activeOpacity={0.75}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: demoOverrideChecked }}
                >
                  <View
                    style={[cm.checkbox, demoOverrideChecked && cm.checkboxChecked]}
                  >
                    {demoOverrideChecked && <Text style={cm.checkmark}>✓</Text>}
                  </View>
                  <Text style={cm.checkLabel}>
                    [Demo] I confirm consent for both parties
                  </Text>
                </TouchableOpacity>
              )}

              <View style={cm.buttonRow}>
                <TouchableOpacity
                  style={cm.cancelButton}
                  onPress={onClose}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel"
                >
                  <Text style={cm.cancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={cm.confirmButton}
                  onPress={() => onConfirm(demoOverrideChecked)}
                  accessibilityRole="button"
                  accessibilityLabel="Send consent request"
                >
                  <Text style={cm.confirmText}>Send Request</Text>
                </TouchableOpacity>
              </View>
            </>
          ) : consentState === 'sending' ? (
            <View style={cm.centeredRow}>
              <ActivityIndicator color={colors.primary} />
              <Text style={cm.body}>Sending consent request…</Text>
            </View>
          ) : (
            /* awaiting_tap */
            <>
              <Text style={cm.body}>
                Member can now grant consent on their device. Tap{' '}
                <Text style={cm.bold}>Mic</Text> again to start recording.
              </Text>
              <TouchableOpacity
                style={cm.confirmButton}
                onPress={onClose}
                accessibilityRole="button"
                accessibilityLabel="Close — ready to start recording"
              >
                <Text style={cm.confirmText}>Got it</Text>
              </TouchableOpacity>
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const cm = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
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
    gap: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 24,
    elevation: 10,
  },
  title: {
    ...typography.displaySm,
    color: colors.foreground,
    fontSize: 18,
  },
  body: {
    ...typography.bodySm,
    color: colors.foreground,
    lineHeight: 22,
  },
  memberName: {
    fontWeight: '700',
    color: colors.primary,
  },
  bold: {
    fontWeight: '700',
  },
  errorText: {
    ...typography.bodySm,
    color: colors.destructive,
  },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 4,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  checkmark: {
    fontSize: 13,
    color: colors.primaryForeground,
    fontWeight: '700',
    lineHeight: 16,
  },
  checkLabel: {
    flex: 1,
    ...typography.bodySm,
    color: colors.mutedForeground,
    fontStyle: 'italic',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  cancelButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  cancelText: {
    ...typography.bodySm,
    fontWeight: '600',
    color: colors.mutedForeground,
  },
  confirmButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: colors.primary,
    alignItems: 'center',
  },
  confirmText: {
    ...typography.bodySm,
    fontWeight: '600',
    color: colors.primaryForeground,
  },
  centeredRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
  },
});

// ─── Main component ───────────────────────────────────────────────────────────

export interface SessionChatProps {
  /** The session UUID — used directly against the session-scoped endpoints. */
  sessionId: string;
}

/**
 * Session chat thread component.
 *
 * Handles both CHW and Member perspectives: the `senderRole` field returned by
 * the API determines bubble alignment without needing a user-ID comparison.
 *
 * Optimistic updates:
 *   1. On send: append a local message with status="sending" and a temp ID.
 *   2. On success: replace the optimistic entry with the server-returned row.
 *   3. On failure: mark the entry status="failed"; user can tap to retry.
 *   The server poll (refetchInterval: 4s) continues running in the background
 *   and will eventually overwrite the local list with the authoritative state.
 *
 * Transcription flow (CHW-only, mobile only):
 *   1. CHW taps Mic → consent modal opens.
 *   2. CHW taps "Send Request" → POST /sessions/{id}/consent.
 *   3. On success, modal flips to "awaiting_tap" state.
 *   4. CHW closes modal and taps Mic again → transcription starts.
 *   5. Transcript chunks stream in via onTranscriptChunk and are merged into
 *      the render list by startedAtMs timestamp alongside text messages.
 *   6. CHW taps MicOff (active state) → transcription stops → followup banner appears.
 */
export function SessionChat({ sessionId }: SessionChatProps): React.JSX.Element {
  const { userRole, userName } = useAuth();

  const [inputValue, setInputValue] = useState('');
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [toastIsError, setToastIsError] = useState(false);
  const [callInitiating, setCallInitiating] = useState(false);

  // ── Transcription state ──────────────────────────────────────────────────────

  /** Whether the `useSessionTranscription` hook should be running. */
  const [transcriptionEnabled, setTranscriptionEnabled] = useState(false);

  /** Accumulated transcript chunks for the current session mount. */
  const [transcriptChunks, setTranscriptChunks] = useState<TranscriptChunk[]>([]);

  /** Show the "followup processing" banner after the session is stopped. */
  const [showFollowupBanner, setShowFollowupBanner] = useState(false);

  /** Consent gate lifecycle state. */
  const [consentGateState, setConsentGateState] = useState<ConsentGateState>('closed');
  const [consentError, setConsentError] = useState<string | null>(null);
  const [consentModalOpen, setConsentModalOpen] = useState(false);
  const [demoOverrideChecked, setDemoOverrideChecked] = useState(false);

  /**
   * Tracks whether the consent POST has been completed for this mount.
   * Resets if the component unmounts (i.e. a new session would re-require consent).
   */
  const consentGrantedRef = useRef(false);

  // ── Recording timer ──────────────────────────────────────────────────────────

  const [recordingElapsedSeconds, setRecordingElapsedSeconds] = useState(0);
  const recordingStartTimeRef = useRef<number | null>(null);
  const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Optimistic message list ──────────────────────────────────────────────────

  /**
   * Local optimistic message list. Starts empty; gets merged with server data.
   * We keep optimistic entries until the server confirms them (or until the
   * next successful poll replaces the whole list).
   */
  const [optimisticMessages, setOptimisticMessages] = useState<SessionMessageLocal[]>([]);

  const listRef = useRef<FlatList<RenderItem>>(null);

  // ── Data queries ─────────────────────────────────────────────────────────────

  const sessionQuery = useSession(sessionId);
  const session = sessionQuery.data;

  const messagesQuery = useSessionMessages(sessionId);
  const sendMessage = useSessionSendMessage();
  const markRead = useSessionMarkRead();
  const startCall = useStartCall();
  const grantConsent = useGrantTranscriptionConsent(sessionId);

  // ── Derived state ─────────────────────────────────────────────────────────────

  const myRole = userRole ?? 'member';
  const isCallable = session ? CALLABLE_STATUSES.has(session.status) : false;

  /** True only for CHW users. Only CHWs have the Mic button. */
  const isCHW = myRole === 'chw';

  /**
   * Resolve the display name of the other party based on auth role and
   * session data. Falls back to "CHW" / "Member" if the name isn't populated.
   */
  const otherPartyName = useMemo<string>(() => {
    if (!session) return myRole === 'chw' ? 'Member' : 'CHW';
    return myRole === 'chw'
      ? (session.memberName ?? 'Member')
      : (session.chwName ?? 'CHW');
  }, [session, myRole]);

  /** First name of the member (used in consent modal copy). */
  const memberFirstName = useMemo<string>(() => {
    const name = session?.memberName ?? 'the member';
    return name.split(' ')[0] ?? name;
  }, [session]);

  /** Label for the CHW speaker in transcript bubbles. */
  const chwSpeakerLabel = useMemo<string>(
    () => (isCHW ? 'You' : (session?.chwName ?? 'CHW')),
    [isCHW, session],
  );

  /** Label for the member speaker in transcript bubbles. */
  const memberSpeakerLabel = useMemo<string>(
    () => session?.memberName ?? 'Member',
    [session],
  );

  /**
   * Unknown speakers are labelled "Speaker A" / "Speaker B" consistently.
   * This is a stable mapping by speakerLabel character.
   */
  const unknownSpeakerLabels: Record<'A' | 'B', string> = {
    A: 'Speaker A',
    B: 'Speaker B',
  };

  // ── Transcription hook ───────────────────────────────────────────────────────

  /**
   * onTranscriptChunk is intentionally stable (useCallback with empty deps)
   * to avoid re-creating the effect inside useSessionTranscription that syncs
   * the callback ref. Appending to state here triggers a re-render and
   * auto-scroll, but the hook itself is not recreated.
   *
   * HIPAA: the chunk object is stored in component state only — never logged,
   * never included in any error report or analytics event.
   */
  const handleTranscriptChunk = useCallback((chunk: TranscriptChunk) => {
    setTranscriptChunks((prev) => [...prev, chunk]);
  }, []);

  const transcription = useSessionTranscription({
    sessionId,
    enabled: transcriptionEnabled,
    onTranscriptChunk: handleTranscriptChunk,
  });

  const isRecording = TRANSCRIPTION_ACTIVE_STATES.has(
    transcription.state as 'recording' | 'connecting' | 'reconnecting',
  );

  // ── Recording timer lifecycle ─────────────────────────────────────────────────

  useEffect(() => {
    if (transcription.state === 'recording') {
      // Start (or restart) the wall-clock timer.
      if (recordingStartTimeRef.current === null) {
        recordingStartTimeRef.current = Date.now();
      }
      timerIntervalRef.current = setInterval(() => {
        const start = recordingStartTimeRef.current ?? Date.now();
        setRecordingElapsedSeconds(Math.floor((Date.now() - start) / 1000));
      }, 1_000);
    } else {
      // Clear the interval whenever we leave the "recording" state.
      if (timerIntervalRef.current !== null) {
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
      if (transcription.state === 'stopped') {
        // Reset for the next session segment but keep elapsed for the banner.
        recordingStartTimeRef.current = null;
      }
    }

    return () => {
      if (timerIntervalRef.current !== null) {
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
    };
  }, [transcription.state]);

  // Surface transcription errors as toasts (lifecycle info only — no audio content).
  useEffect(() => {
    if (transcription.state === 'error' && transcription.errorMessage !== null) {
      showToast(transcription.errorMessage, true);
      setTranscriptionEnabled(false);
    }
  }, [transcription.state, transcription.errorMessage]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Merged render list ───────────────────────────────────────────────────────

  /**
   * Merge server messages with optimistic entries.
   * Server messages take precedence: if the server has confirmed a message ID
   * that exists optimistically, the optimistic entry is dropped.
   * Optimistic "sending"/"failed" entries without a server counterpart are
   * appended at the end.
   */
  const serverMessages = useMemo<SessionMessageLocal[]>(
    () => (messagesQuery.data ?? []) as SessionMessageLocal[],
    [messagesQuery.data],
  );

  const mergedMessages = useMemo<SessionMessageLocal[]>(() => {
    if (optimisticMessages.length === 0) return serverMessages;

    const serverIds = new Set(serverMessages.map((m) => m.id));
    const pendingOptimistic = optimisticMessages.filter((m) => !serverIds.has(m.id));
    return [...serverMessages, ...pendingOptimistic];
  }, [serverMessages, optimisticMessages]);

  /**
   * Build the unified render list by merging text messages and transcript chunks
   * in ascending chronological order.
   *
   * Text messages are ordered by their `createdAt` ISO timestamp.
   * Transcript chunks are ordered by `startedAtMs` (milliseconds epoch).
   * We convert both to epoch-ms for a uniform comparison.
   *
   * Optimistic/sending messages that have no `createdAt` equivalent (they use
   * `new Date().toISOString()` at creation time) are appended after confirmed
   * server messages, which preserves the existing optimistic UX.
   *
   * The followup banner is appended last when `showFollowupBanner` is true.
   */
  const renderItems = useMemo<RenderItem[]>(() => {
    type Weighted = { epochMs: number; item: RenderItem };

    const weighted: Weighted[] = [
      ...mergedMessages.map<Weighted>((msg) => ({
        epochMs: new Date(msg.createdAt).getTime(),
        item: { kind: 'message', message: msg } satisfies RenderItem,
      })),
      ...transcriptChunks.map<Weighted>((chunk, index) => ({
        epochMs: chunk.startedAtMs,
        item: {
          kind: 'transcript',
          chunk,
          // Stable ID: position index is safe here because the list only grows.
          id: `transcript_${index}`,
        } satisfies RenderItem,
      })),
    ];

    weighted.sort((a, z) => a.epochMs - z.epochMs);

    const sorted = weighted.map((w) => w.item);

    if (showFollowupBanner) {
      sorted.push({ kind: 'followup_banner' });
    }

    return sorted;
  }, [mergedMessages, transcriptChunks, showFollowupBanner]);

  // ── Read receipts ─────────────────────────────────────────────────────────────

  /**
   * Fire read receipt side effect. Runs when the messages list changes and
   * there are confirmed server messages to mark.
   * HIPAA: only the message ID is sent — no body content.
   */
  const lastServerMessageId = serverMessages[serverMessages.length - 1]?.id;
  const lastMarkedIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!lastServerMessageId) return;
    if (lastMarkedIdRef.current === lastServerMessageId) return;

    lastMarkedIdRef.current = lastServerMessageId;
    markRead.mutate({ sessionId, upToMessageId: lastServerMessageId });
  }, [sessionId, lastServerMessageId, markRead]);

  // ── Auto-scroll ───────────────────────────────────────────────────────────────

  const scrollToBottom = useCallback((animated: boolean) => {
    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated });
    });
  }, []);

  // Scroll to bottom on initial load (non-animated) and on new items (animated)
  const prevItemCountRef = useRef(0);
  useEffect(() => {
    const count = renderItems.length;
    if (count === 0) return;

    const isInitialLoad = prevItemCountRef.current === 0;
    scrollToBottom(!isInitialLoad);
    prevItemCountRef.current = count;
  }, [renderItems.length, scrollToBottom]);

  // ── Toast helpers ─────────────────────────────────────────────────────────────

  const showToast = useCallback((message: string, isError: boolean) => {
    setToastMessage(message);
    setToastIsError(isError);
    const timer = setTimeout(() => setToastMessage(null), 3_500);
    return () => clearTimeout(timer);
  }, []);

  // ── Consent + Mic handler ─────────────────────────────────────────────────────

  /**
   * Handle the consent POST (called from inside the consent modal).
   *
   * Uses the CHW's userName as the typed_signature. For the demo override, we
   * skip the actual API call and jump straight to 'awaiting_tap'.
   */
  const handleConsentConfirm = useCallback(
    async (demoOverride: boolean) => {
      if (demoOverride) {
        // DEMO ONLY — bypass consent POST. Remove before production.
        consentGrantedRef.current = true;
        setConsentGateState('awaiting_tap');
        return;
      }

      setConsentGateState('sending');
      setConsentError(null);

      try {
        await grantConsent.mutateAsync({
          consentType: 'ai_transcription',
          typedSignature: userName ?? 'CHW',
        });
        consentGrantedRef.current = true;
        setConsentGateState('awaiting_tap');
      } catch (err) {
        const detail =
          err instanceof Error && err.message
            ? err.message
            : 'Could not record consent. Please try again.';
        setConsentError(detail);
        setConsentGateState('error');
      }
    },
    [grantConsent, userName],
  );

  /**
   * Handle Mic button press.
   *
   * State machine:
   *   - If currently recording → stop transcription + show followup banner.
   *   - If consent not yet granted → open the consent modal.
   *   - If consent granted (awaiting_tap) → start transcription.
   */
  const handleMicPress = useCallback(async () => {
    if (!isCHW) return;

    // Stop path
    if (isRecording) {
      setTranscriptionEnabled(false);
      await transcription.stop();
      setShowFollowupBanner(true);
      setRecordingElapsedSeconds(0);
      return;
    }

    // Web fallback — transcription unsupported on web
    if (Platform.OS === 'web') {
      showToast(
        'Session transcription is only available in the mobile app.',
        true,
      );
      return;
    }

    // Consent not yet granted → open consent modal
    if (!consentGrantedRef.current) {
      setConsentGateState('closed');
      setConsentError(null);
      setDemoOverrideChecked(false);
      setConsentModalOpen(true);
      return;
    }

    // Consent granted, second tap → start recording
    setTranscriptionEnabled(true);
    await transcription.start();
  }, [isCHW, isRecording, transcription, showToast]);

  // ── Send handler ──────────────────────────────────────────────────────────────

  const handleSend = useCallback(async () => {
    const trimmed = inputValue.trim();
    if (!trimmed || sendMessage.isPending) return;

    const tempId = `optimistic_${Date.now()}`;
    const optimisticEntry: SessionMessageLocal = {
      id: tempId,
      senderUserId: '',          // unknown client-side; server provides authoritative
      senderRole: myRole as 'chw' | 'member',
      body: trimmed,
      createdAt: new Date().toISOString(),
      status: 'sending',
    };

    // 1. Append optimistic entry immediately
    setOptimisticMessages((prev) => [...prev, optimisticEntry]);
    setInputValue('');

    try {
      // 2. Fire request; get back authoritative row
      const confirmed = await sendMessage.mutateAsync({ sessionId, body: trimmed });

      // 3. Replace optimistic entry with confirmed row (status=undefined → confirmed)
      setOptimisticMessages((prev) =>
        prev
          .filter((m) => m.id !== tempId)
          .concat({ ...confirmed, status: undefined }),
      );
    } catch {
      // 4. Mark as failed. HIPAA: do not include the body in any error log.
      setOptimisticMessages((prev) =>
        prev.map((m) =>
          m.id === tempId ? { ...m, status: 'failed' } : m,
        ),
      );
    }
  }, [inputValue, sessionId, myRole, sendMessage]);

  // ── Retry handler ─────────────────────────────────────────────────────────────

  const handleRetry = useCallback(
    (failedMessage: SessionMessageLocal) => {
      // Remove the failed entry and re-populate the input for the user to resend
      setOptimisticMessages((prev) => prev.filter((m) => m.id !== failedMessage.id));
      setInputValue(failedMessage.body);
    },
    [],
  );

  // ── Call handler ──────────────────────────────────────────────────────────────

  const handleCall = useCallback(async () => {
    if (!isCallable || callInitiating) return;
    setCallInitiating(true);
    try {
      await startCall.mutateAsync(sessionId);
      showToast('Calling now — both your phones will ring.', false);
    } catch (err) {
      const detail =
        err instanceof Error && err.message ? err.message : 'Could not start the call. Try again.';
      showToast(detail, true);
    } finally {
      setCallInitiating(false);
    }
  }, [isCallable, callInitiating, sessionId, startCall, showToast]);

  // ── Render item ───────────────────────────────────────────────────────────────

  const renderItem = useCallback(
    ({ item }: { item: RenderItem }) => {
      if (item.kind === 'message') {
        const isOwn = item.message.senderRole === myRole;
        return (
          <MessageBubble
            message={item.message}
            isOwn={isOwn}
            otherPartyName={otherPartyName}
            onRetry={handleRetry}
          />
        );
      }

      if (item.kind === 'transcript') {
        return (
          <TranscriptBubble
            chunk={item.chunk}
            chwLabel={chwSpeakerLabel}
            memberLabel={memberSpeakerLabel}
            unknownSpeakerLabels={unknownSpeakerLabels}
          />
        );
      }

      // followup_banner
      return <FollowupBanner />;
    },
    [myRole, otherPartyName, handleRetry, chwSpeakerLabel, memberSpeakerLabel, unknownSpeakerLabels],
  );

  const keyExtractor = useCallback(
    (item: RenderItem) => {
      if (item.kind === 'message') return item.message.id;
      if (item.kind === 'transcript') return item.id;
      return 'followup_banner';
    },
    [],
  );

  // ── Character counter ─────────────────────────────────────────────────────────

  const charCount = inputValue.length;
  const showCharCounter = charCount >= MAX_CHARS - COUNTER_THRESHOLD;

  const isSendDisabled =
    !inputValue.trim() || sendMessage.isPending;

  // ── Web transcription unavailable message ─────────────────────────────────────

  const showWebTranscriptionNote =
    Platform.OS === 'web' && isCHW && transcription.state === 'error';

  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <>
      {/* Consent gate modal */}
      {isCHW && (
        <ConsentModal
          visible={consentModalOpen}
          memberFirstName={memberFirstName}
          chwName={userName ?? 'You'}
          consentState={consentGateState}
          consentError={consentError}
          demoOverrideChecked={demoOverrideChecked}
          onDemoOverrideChange={setDemoOverrideChecked}
          onConfirm={(demoOverride) => { void handleConsentConfirm(demoOverride); }}
          onClose={() => {
            // If consent was already granted and we are closing from "awaiting_tap",
            // allow the state to persist so the next Mic tap starts recording.
            if (consentGateState !== 'awaiting_tap') {
              setConsentGateState('closed');
            }
            setConsentModalOpen(false);
          }}
        />
      )}

      <KeyboardAvoidingView
        style={c.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 24}
      >
        <View style={c.container}>
          {/* Inner header — phone + mic icons on the right */}
          <View style={c.header}>
            <View style={c.headerLeft}>
              <MessageSquare size={14} color={colors.mutedForeground} />
              <Text style={c.headerLabel}>Session Chat</Text>
            </View>

            <View style={c.headerRight}>
              {/* Recording indicator — only visible while recording */}
              {transcription.state === 'recording' && (
                <RecordingIndicator elapsedSeconds={recordingElapsedSeconds} />
              )}

              {/* Mic button — CHW-only */}
              {isCHW && (
                <TouchableOpacity
                  style={[
                    c.iconButton,
                    isRecording && c.iconButtonRecording,
                  ]}
                  onPress={() => { void handleMicPress(); }}
                  accessibilityRole="button"
                  accessibilityLabel={isRecording ? 'Stop recording' : 'Start recording'}
                  accessibilityHint={
                    isRecording
                      ? 'Stops the live session transcription.'
                      : 'Opens the consent dialog, then starts live transcription.'
                  }
                  accessibilityState={{ selected: isRecording }}
                >
                  {isRecording ? (
                    <MicOff
                      size={16}
                      color={colors.destructive}
                    />
                  ) : (
                    <Mic
                      size={16}
                      color={
                        consentGrantedRef.current
                          ? colors.primary
                          : colors.mutedForeground
                      }
                    />
                  )}
                </TouchableOpacity>
              )}

              {/* Phone button */}
              <TouchableOpacity
                style={[
                  c.iconButton,
                  !isCallable && c.iconButtonDisabled,
                ]}
                onPress={() => { void handleCall(); }}
                disabled={!isCallable || callInitiating}
                accessibilityRole="button"
                accessibilityLabel="Start phone call"
                accessibilityHint={
                  isCallable
                    ? 'Initiates a masked phone call with both parties.'
                    : 'Calling is only available for scheduled or in-progress sessions.'
                }
                accessibilityState={{ disabled: !isCallable || callInitiating }}
              >
                {callInitiating ? (
                  <ActivityIndicator size="small" color={isCallable ? colors.primary : colors.mutedForeground} />
                ) : (
                  <Phone
                    size={16}
                    color={isCallable ? colors.primary : colors.mutedForeground}
                  />
                )}
              </TouchableOpacity>
            </View>
          </View>

          {/* Toast slot */}
          {toastMessage !== null && (
            <InlineToast message={toastMessage} isError={toastIsError} />
          )}

          {/* Web transcription unavailable notice (text chat continues to work) */}
          {showWebTranscriptionNote && (
            <View style={c.webNote} accessibilityRole="none">
              <Text style={c.webNoteText}>
                Live transcription requires the mobile app. Text chat is fully available here.
              </Text>
            </View>
          )}

          {/* Message list */}
          {messagesQuery.isLoading ? (
            <View style={c.emptyState}>
              <ActivityIndicator color={colors.primary} />
            </View>
          ) : renderItems.length === 0 ? (
            <View style={c.emptyState}>
              <View style={c.emptyIconCircle}>
                <MessageSquare size={20} color={colors.mutedForeground} />
              </View>
              <Text style={c.emptyTitle}>No messages yet</Text>
              <Text style={c.emptySubtext}>Start the conversation below.</Text>
            </View>
          ) : (
            <FlatList
              ref={listRef}
              data={renderItems}
              keyExtractor={keyExtractor}
              renderItem={renderItem}
              contentContainerStyle={c.listContent}
              showsVerticalScrollIndicator={false}
              onContentSizeChange={() => scrollToBottom(false)}
              accessibilityRole="list"
              accessibilityLabel="Message history"
              accessibilityLiveRegion="polite"
            />
          )}

          {/* Input area — always visible */}
          <View style={c.inputArea}>
            {showCharCounter && (
              <Text
                style={[
                  c.charCounter,
                  charCount >= MAX_CHARS && c.charCounterLimit,
                ]}
                accessibilityLabel={`${MAX_CHARS - charCount} characters remaining`}
              >
                {MAX_CHARS - charCount}
              </Text>
            )}
            <View style={c.inputRow}>
              <TextInput
                style={c.input}
                value={inputValue}
                onChangeText={(text) => setInputValue(text.slice(0, MAX_CHARS))}
                placeholder="Type a message…"
                placeholderTextColor={colors.mutedForeground}
                multiline
                maxLength={MAX_CHARS}
                returnKeyType="send"
                blurOnSubmit
                onSubmitEditing={() => { void handleSend(); }}
                accessibilityLabel="Message input"
              />
              <TouchableOpacity
                style={[c.sendButton, isSendDisabled && c.sendButtonDisabled]}
                onPress={() => { void handleSend(); }}
                disabled={isSendDisabled}
                accessibilityRole="button"
                accessibilityLabel="Send message"
                accessibilityState={{ disabled: isSendDisabled }}
                activeOpacity={0.75}
              >
                {sendMessage.isPending ? (
                  <ActivityIndicator size="small" color={colors.primaryForeground} />
                ) : (
                  <Send size={16} color={colors.primaryForeground} />
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const c = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, backgroundColor: colors.background },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.card,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerLabel: {
    ...typography.label,
    fontWeight: '700',
    color: colors.mutedForeground,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },

  iconButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: `${colors.primary}12`,
    borderWidth: 1,
    borderColor: `${colors.primary}30`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconButtonDisabled: {
    backgroundColor: colors.background,
    borderColor: colors.border,
  },
  iconButtonRecording: {
    backgroundColor: `${colors.destructive}12`,
    borderColor: `${colors.destructive}30`,
  },

  listContent: { padding: 16, paddingBottom: 8 },

  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: 40,
  },
  emptyIconCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: `${colors.secondary}18`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: { ...typography.bodyMd, fontWeight: '700', color: colors.foreground },
  emptySubtext: {
    ...typography.bodySm,
    color: colors.mutedForeground,
    textAlign: 'center',
  },

  webNote: {
    marginHorizontal: 16,
    marginTop: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: `${colors.compassGold}14`,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: `${colors.compassGold}30`,
  },
  webNoteText: {
    ...typography.bodySm,
    color: colors.foreground,
  },

  inputArea: {
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: Platform.OS === 'ios' ? 10 : 12,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.card,
  },
  charCounter: {
    alignSelf: 'flex-end',
    ...typography.label,
    color: colors.mutedForeground,
    marginBottom: 4,
    paddingHorizontal: 4,
  },
  charCounterLimit: {
    color: colors.destructive,
    fontWeight: '700',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    backgroundColor: colors.background,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 10,
    ...typography.bodyMd,
    color: colors.foreground,
    maxHeight: 96,      // approx 4 lines
    minHeight: 44,
  },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  sendButtonDisabled: { opacity: 0.35 },

  // Legacy alias kept so diffing is clean — renamed from phoneButton
  phoneButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: `${colors.primary}12`,
    borderWidth: 1,
    borderColor: `${colors.primary}30`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  phoneButtonDisabled: {
    backgroundColor: colors.background,
    borderColor: colors.border,
  },
});

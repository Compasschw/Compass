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
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import {
  Camera,
  ClipboardList,
  Download,
  EyeOff,
  Eye,
  FileText,
  Image as ImageIcon,
  MessageSquare,
  Mic,
  MicOff,
  Paperclip,
  Phone,
  Send,
  X as XIcon,
} from 'lucide-react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';

import { uploadFile, type RNFileAsset } from '../../api/upload';

import { useAuth } from '../../context/AuthContext';
import { ResourceMentionInput } from '../resources/ResourceMentionInput';
import { ResourceMentionText } from '../resources/ResourceMentionText';
import {
  useSession,
  useSessionMessages,
  useSessionSendMessage,
  useSessionMarkRead,
  useStartCall,
  useGrantTranscriptionConsent,
  useTranscriptExport,
  useCreateConsentRequest,
  usePendingConsents,
  useApproveConsentRequest,
  useDenyConsentRequest,
  useCancelConsentRequest,
  useConsentRequestStatus,
  useMemberDeviceAudioConsent,
  useGrantDeviceAudioConsent,
  type SessionMessageLocal,
  type ConsentRequestData,
  type ConsentRequestStatus,
} from '../../hooks/useApiQueries';
import { MemberDeviceAudioConsentModal } from './MemberDeviceAudioConsentModal';
import { Avatar } from '../shared/Avatar';
import {
  useSessionTranscription,
  type TranscriptChunk,
  type TranscriptionMode,
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
 * Consent-gate lifecycle for the CHW's recording consent flow (two-party path).
 *
 *   closed            → CHW has not opened the modal yet
 *   requesting        → POST /consent-requests in flight
 *   waiting_for_member → ConsentRequest row exists, CHW polls for member response
 *   approved          → member approved; CHW closes modal and starts recording
 *   denied            → member denied; show toast and close modal
 *   expired           → 5-min TTL elapsed with no response
 *   error             → network or server error during request creation
 */
type ConsentGateState =
  | 'closed'
  | 'requesting'
  | 'waiting_for_member'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'error';

/**
 * Which tab is active in the CHW's consent modal.
 *
 *   request_consent  → (default) send an in-app two-party consent request
 *   verbal_attest    → CHW attests member gave verbal consent (fallback for phone-only)
 */
type ConsentModalMode = 'request_consent' | 'verbal_attest';

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
  /**
   * When non-null, the indicator shows a "Connecting..." or "Reconnecting..." spinner
   * instead of the animated dot + timer. The dot animation is paused to avoid
   * misleading the CHW into thinking audio is flowing when the socket is not yet open.
   */
  connectingState: 'connecting' | 'reconnecting' | null;
}

/**
 * Animated red dot + MM:SS timer shown in the header when transcription is live.
 *
 * When `connectingState` is non-null, renders an ActivityIndicator + "Connecting..."
 * or "Reconnecting..." label instead of the pulsing dot + timer, so the CHW can
 * see exactly what phase the transcription pipeline is in.
 *
 * Animation: the dot pulses between full opacity and ~20% opacity on a 1-second
 * cycle using withRepeat + withSequence from react-native-reanimated. The
 * animation runs on the UI thread (no JS bridge frame drops during scroll).
 * The useSharedValue + useAnimatedStyle pattern means only the Animated.View
 * node re-renders — the parent component is not touched.
 */
function RecordingIndicator({
  elapsedSeconds,
  connectingState,
}: RecordingIndicatorProps): React.JSX.Element {
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

  // Connecting / reconnecting state — show spinner + label instead of dot + timer.
  if (connectingState !== null) {
    const label = connectingState === 'reconnecting' ? 'Reconnecting...' : 'Connecting...';
    return (
      <View
        style={recStyles.container}
        accessibilityRole="none"
        accessibilityLabel={label}
        accessibilityLiveRegion="polite"
      >
        <ActivityIndicator size="small" color={colors.mutedForeground} />
        <Text style={recStyles.connectingLabel}>{label}</Text>
      </View>
    );
  }

  return (
    <View style={recStyles.container} accessibilityRole="none">
      <Animated.View style={[recStyles.dot, animatedDotStyle]} />
      <Text
        style={recStyles.label}
        accessibilityLabel={`Live transcribing — ${formatDuration(elapsedSeconds)}`}
      >
        {'Live '}
      </Text>
      <Text style={recStyles.timer} importantForAccessibility="no-hide-descendants">
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
  /** "Live" label shown beside the timer when actively recording. */
  label: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.destructive,
  },
  timer: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.destructive,
    fontVariant: ['tabular-nums'],
  },
  /** Shown in the connecting / reconnecting states instead of dot + timer. */
  connectingLabel: {
    fontSize: 11,
    fontWeight: '500',
    color: colors.mutedForeground,
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

/** Format byte size as a human-readable label (e.g. "1.2 MB"). */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Open an attachment URL in the device's default handler (browser / file viewer). */
async function openAttachmentUrl(url: string): Promise<void> {
  try {
    const supported = await Linking.canOpenURL(url);
    if (supported) {
      await Linking.openURL(url);
    }
  } catch {
    // Silently swallow — the attachment URL is presigned and may have expired.
    // The next message poll will refresh the URL.
  }
}

function MessageBubble({
  message,
  isOwn,
  otherPartyName,
  onRetry,
}: MessageBubbleProps): React.JSX.Element {
  const isFailed = message.status === 'failed';
  const isSending = message.status === 'sending';
  const attachment = message.attachment ?? null;
  const isImageAttachment = attachment !== null && attachment.contentType.startsWith('image/');
  const isFileAttachment = attachment !== null && !isImageAttachment;

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
            // Image attachments get tighter padding so the photo fills the bubble
            isImageAttachment && b.bubbleImageContainer,
          ]}
        >
          {/* Image attachment — render inline, tappable to open full-size */}
          {isImageAttachment && attachment && (
            <Pressable
              onPress={() => { void openAttachmentUrl(attachment.downloadUrl); }}
              accessibilityRole="imagebutton"
              accessibilityLabel={`Image attachment: ${attachment.filename}. Tap to open.`}
            >
              <Image
                source={{ uri: attachment.downloadUrl }}
                style={b.imageAttachment}
                resizeMode="cover"
                accessibilityIgnoresInvertColors
              />
            </Pressable>
          )}

          {/* File attachment — tappable row with filename / size / icon */}
          {isFileAttachment && attachment && (
            <Pressable
              onPress={() => { void openAttachmentUrl(attachment.downloadUrl); }}
              style={[b.fileRow, isOwn ? b.fileRowOwn : b.fileRowOther]}
              accessibilityRole="button"
              accessibilityLabel={`File attachment: ${attachment.filename}. Tap to download.`}
            >
              <View style={[b.fileIconCircle, isOwn ? b.fileIconCircleOwn : b.fileIconCircleOther]}>
                <FileText
                  size={16}
                  color={isOwn ? colors.primaryForeground : colors.primary}
                />
              </View>
              <View style={b.fileInfo}>
                <Text
                  style={[b.fileName, isOwn ? b.fileNameOwn : b.fileNameOther]}
                  numberOfLines={1}
                >
                  {attachment.filename}
                </Text>
                <Text
                  style={[b.fileMeta, isOwn ? b.fileMetaOwn : b.fileMetaOther]}
                  numberOfLines={1}
                >
                  {formatFileSize(attachment.sizeBytes)} · Tap to open
                </Text>
              </View>
              <Download
                size={14}
                color={isOwn ? colors.primaryForeground : colors.primary}
              />
            </Pressable>
          )}

          {/* Body text — only render when non-empty (caption with attachment).
              ResourceMentionText renders @[Name](resource:uuid) tokens as
              tappable chips with a resource detail popover. Plain text messages
              (no tokens) fall through to a simple <Text> to avoid any overhead. */}
          {message.body.trim().length > 0 && (
            <ResourceMentionText
              text={message.body}
              textStyle={[
                b.bodyText,
                isOwn ? b.textOwn : b.textOther,
                attachment !== null && b.bodyTextWithAttachment,
              ]}
            />
          )}

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

  /** When body text is shown alongside an attachment, add a small top margin
   *  so the caption sits visually below the image / file row. */
  bodyTextWithAttachment: { marginTop: 8 },

  // ── Image attachment ────────────────────────────────────────────────────────
  bubbleImageContainer: {
    paddingHorizontal: 4,
    paddingTop: 4,
    paddingBottom: 6,
  },
  imageAttachment: {
    width: 220,
    height: 220,
    borderRadius: 12,
    backgroundColor: colors.muted,
  },

  // ── File attachment row ─────────────────────────────────────────────────────
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 6,
    minWidth: 200,
  },
  fileRowOwn: {},
  fileRowOther: {},
  fileIconCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  fileIconCircleOwn: {
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  fileIconCircleOther: {
    backgroundColor: `${colors.primary}18`,
  },
  fileInfo: {
    flex: 1,
    gap: 1,
  },
  fileName: {
    ...typography.bodySm,
    fontWeight: '700',
  },
  fileNameOwn: { color: colors.primaryForeground },
  fileNameOther: { color: colors.foreground },
  fileMeta: {
    fontSize: 11,
    fontFamily: undefined,
  },
  fileMetaOwn: { color: 'rgba(255,255,255,0.85)' },
  fileMetaOther: { color: colors.mutedForeground },

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
/**
 * Role-specific bubble colour tokens.
 *
 * CHW    — sage green (#8DA07E at 20% opacity background, full sage border)
 *          Matches the compass brand's primary CHW colour.
 * Member — amber/cream (#D4A030 at 18% opacity background, gold border)
 *          Warm, distinct from the CHW colour so the two streams read apart
 *          at a glance even in low-light clinical environments.
 * Unknown — neutral muted grey (legacy single-stream fallback).
 */
const TRANSCRIPT_BG_CHW = `${colors.compassSage}33`;     // sage green ~20% opacity
const TRANSCRIPT_BORDER_CHW = `${colors.compassSage}80`; // sage green 50% opacity
const TRANSCRIPT_LABEL_CHW = colors.compassSage;

const TRANSCRIPT_BG_MEMBER = `${colors.compassGold}2E`;     // amber ~18% opacity
const TRANSCRIPT_BORDER_MEMBER = `${colors.compassGold}80`; // amber 50% opacity
const TRANSCRIPT_LABEL_MEMBER = colors.compassGold;

const TRANSCRIPT_BG_UNKNOWN = `${colors.muted}99`; // grey ~60% opacity (legacy)
const TRANSCRIPT_BORDER_UNKNOWN = `${colors.border}80`;
const TRANSCRIPT_LABEL_UNKNOWN = colors.compassSage; // unchanged from prior default

/**
 * Resolve role-specific style tokens for a transcript bubble.
 * Returns background colour, border colour, and label colour.
 */
function resolveRoleStyles(speakerRole: string): {
  bubbleBg: string;
  bubbleBorder: string;
  labelColor: string;
  rolePrefix: string;
} {
  if (speakerRole === 'chw') {
    return {
      bubbleBg: TRANSCRIPT_BG_CHW,
      bubbleBorder: TRANSCRIPT_BORDER_CHW,
      labelColor: TRANSCRIPT_LABEL_CHW,
      rolePrefix: 'CHW',
    };
  }
  if (speakerRole === 'member') {
    return {
      bubbleBg: TRANSCRIPT_BG_MEMBER,
      bubbleBorder: TRANSCRIPT_BORDER_MEMBER,
      labelColor: TRANSCRIPT_LABEL_MEMBER,
      rolePrefix: 'Member',
    };
  }
  return {
    bubbleBg: TRANSCRIPT_BG_UNKNOWN,
    bubbleBorder: TRANSCRIPT_BORDER_UNKNOWN,
    labelColor: TRANSCRIPT_LABEL_UNKNOWN,
    rolePrefix: '',
  };
}

function TranscriptBubble({
  chunk,
  chwLabel,
  memberLabel,
  unknownSpeakerLabels,
}: TranscriptBubbleProps): React.JSX.Element {
  const [showConfidenceNote, setShowConfidenceNote] = useState(false);

  const { bubbleBg, bubbleBorder, labelColor, rolePrefix } = resolveRoleStyles(
    chunk.speakerRole,
  );

  /**
   * Human-readable speaker label shown above the bubble.
   * - CHW role: resolves to the CHW's display name (e.g. "You" or their name).
   * - Member role: resolves to the member's display name.
   * - Unknown: falls back to the diarization label ("Speaker A" / "Speaker B").
   *
   * The rolePrefix ("CHW" / "Member") is prepended inline inside the bubble
   * text as an accessibility and scan aid — it matches the label above.
   */
  const speakerLabel: string = (() => {
    if (chunk.speakerRole === 'chw') return chwLabel;
    if (chunk.speakerRole === 'member') return memberLabel;
    return unknownSpeakerLabels[chunk.speakerLabel];
  })();

  const isLowConfidence = chunk.confidence < 0.7;

  // Body text shown inside the bubble: "CHW: <text>" or "Member: <text>".
  // The inline prefix doubles as an accessible scan cue for screen readers
  // that read the bubble without the label above it.
  const bodyContent = rolePrefix ? `${rolePrefix}: ${chunk.text}` : chunk.text;
  const displayText = isLowConfidence ? `[${bodyContent}]` : bodyContent;

  // HIPAA: we do not include any transcript text in accessibility descriptions.
  return (
    <View style={tr.wrapper}>
      <Text style={[tr.speakerLabel, { color: labelColor }]}>{speakerLabel}</Text>
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
        <View
          style={[
            tr.bubble,
            { backgroundColor: bubbleBg, borderColor: bubbleBorder },
            !chunk.isFinal && tr.bubblePartial,
          ]}
        >
          <Text style={[tr.bodyText, isLowConfidence && tr.bodyTextLowConf]}>
            {/* HIPAA: text is rendered but never logged or passed to analytics */}
            {displayText}
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

const tr = StyleSheet.create({
  wrapper: {
    alignSelf: 'stretch',
    marginBottom: 10,
    gap: 3,
  },
  speakerLabel: {
    fontSize: 11,
    fontWeight: '600',
    // color is applied inline via resolveRoleStyles — no static default needed.
    paddingHorizontal: 4,
    marginBottom: 2,
    textTransform: 'capitalize',
  },
  bubble: {
    // backgroundColor and borderColor are applied inline via resolveRoleStyles.
    borderRadius: 12,
    borderWidth: 1,
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

// ─── ConsentModal (CHW side — two-party flow) ─────────────────────────────────
//
// Default mode: "Request consent from member" (in-app two-party consent).
// Fallback mode: "Verbal attestation" (phone-only, collapsed under Advanced).
//
// State machine for the request_consent mode:
//   closed            → initial state, shows Send Request button
//   requesting        → POST /consent-requests in flight (spinner)
//   waiting_for_member → request sent, CHW sees spinner + "Waiting for …" + Cancel
//   approved          → member tapped Approve (auto-closes, recording starts)
//   denied            → member tapped Deny (toast shown, modal closes)
//   expired           → 5-min TTL elapsed (toast shown, modal closes)
//   error             → network error (error text shown, retry available)

interface ConsentModalProps {
  visible: boolean;
  memberFirstName: string;
  chwName: string;
  consentState: ConsentGateState;
  consentModalMode: ConsentModalMode;
  /** Error message from a failed consent POST, if any. */
  consentError: string | null;
  /** Whether the Advanced (verbal attestation) section is expanded. */
  advancedExpanded: boolean;
  onAdvancedToggle: () => void;
  /** CHW tapped "Send Request" in the request_consent mode. */
  onSendRequest: () => void;
  /** CHW tapped "Cancel" while waiting for member. */
  onCancelRequest: () => void;
  /** CHW switched to verbal attestation mode and tapped confirm. */
  onVerbalAttest: () => void;
  onClose: () => void;
}

function ConsentModal({
  visible,
  memberFirstName,
  consentState,
  consentModalMode: _mode,
  consentError,
  advancedExpanded,
  onAdvancedToggle,
  onSendRequest,
  onCancelRequest,
  onVerbalAttest,
  onClose,
}: ConsentModalProps): React.JSX.Element {
  // Verbal-attestation checkbox state is local to the modal lifetime.
  const [verbalChecked, setVerbalChecked] = React.useState(false);

  const isWaiting = consentState === 'waiting_for_member';
  const isRequesting = consentState === 'requesting';

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
        onPress={isWaiting ? undefined : onClose}
        accessibilityRole="button"
        accessibilityLabel="Close consent dialog"
      >
        {/* Inner press trap so taps on the card don't propagate to backdrop */}
        <Pressable style={cm.card} onPress={() => undefined}>
          <Text style={cm.title}>Enable Session Recording</Text>

          {/* ── Requesting state — spinner while POST /consent-requests is in flight */}
          {isRequesting && (
            <View style={cm.centeredRow}>
              <ActivityIndicator color={colors.primary} />
              <Text style={cm.body}>Sending request…</Text>
            </View>
          )}

          {/* ── Waiting for member — after request is sent */}
          {isWaiting && (
            <>
              <View style={cm.centeredRow}>
                <ActivityIndicator color={colors.primary} />
                <Text style={cm.body}>
                  Waiting for{' '}
                  <Text style={cm.memberName}>{memberFirstName}</Text>{' '}
                  to approve…
                </Text>
              </View>
              <Text style={cm.bodySmall}>
                {memberFirstName} will see a consent prompt on their device.
                The request expires in 5 minutes.
              </Text>
              <TouchableOpacity
                style={cm.cancelButton}
                onPress={onCancelRequest}
                accessibilityRole="button"
                accessibilityLabel="Cancel consent request"
              >
                <Text style={cm.cancelText}>Cancel Request</Text>
              </TouchableOpacity>
            </>
          )}

          {/* ── Initial / error state — show Send Request button */}
          {!isRequesting && !isWaiting && (
            <>
              <Text style={cm.body}>
                <Text style={cm.memberName}>{memberFirstName}</Text> will
                receive an in-app prompt to approve session recording.
              </Text>

              {consentError !== null && (
                <Text style={cm.errorText}>{consentError}</Text>
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
                  onPress={onSendRequest}
                  accessibilityRole="button"
                  accessibilityLabel="Send consent request to member"
                >
                  <Text style={cm.confirmText}>Send Request</Text>
                </TouchableOpacity>
              </View>

              {/* ── Advanced: verbal attestation (fallback for phone-only sessions) */}
              <TouchableOpacity
                style={cm.advancedToggle}
                onPress={onAdvancedToggle}
                accessibilityRole="button"
                accessibilityLabel={
                  advancedExpanded ? 'Collapse advanced options' : 'Show advanced options'
                }
              >
                <Text style={cm.advancedToggleText}>
                  {advancedExpanded ? '▲ Advanced' : '▼ Advanced'}
                </Text>
              </TouchableOpacity>

              {advancedExpanded && (
                <View style={cm.advancedSection}>
                  <Text style={cm.advancedLabel}>
                    Phone-only fallback: if the member is on a call and
                    cannot open the app, the CHW may attest to verbal consent.
                  </Text>
                  <TouchableOpacity
                    style={cm.checkRow}
                    onPress={() => setVerbalChecked((prev) => !prev)}
                    activeOpacity={0.75}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: verbalChecked }}
                  >
                    <View
                      style={[cm.checkbox, verbalChecked && cm.checkboxChecked]}
                    >
                      {verbalChecked && <Text style={cm.checkmark}>✓</Text>}
                    </View>
                    <Text style={cm.checkLabel}>
                      Member gave verbal consent (CHW attests)
                    </Text>
                  </TouchableOpacity>
                  {verbalChecked && (
                    <TouchableOpacity
                      style={[cm.confirmButton, cm.attestButton]}
                      onPress={onVerbalAttest}
                      accessibilityRole="button"
                      accessibilityLabel="Submit verbal attestation and start recording"
                    >
                      <Text style={cm.confirmText}>{'Attest & Start Recording'}</Text>
                    </TouchableOpacity>
                  )}
                </View>
              )}
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ─── MemberConsentModal ───────────────────────────────────────────────────────
//
// Rendered on the MEMBER's side when a pending ConsentRequest is detected.
// California §632 two-party consent: this is the member's affirmative tap.
//
// Disclosure text follows HIPAA "minimum necessary" principle:
//   - What is recorded (session audio for clinical notes)
//   - Where stored (encrypted, secure storage)
//   - How used (generate session documentation only)
//   - Right to revoke (member can ask CHW to stop at any time)

interface MemberConsentModalProps {
  visible: boolean;
  consentRequest: ConsentRequestData;
  memberName: string;
  onApprove: (request: ConsentRequestData) => void;
  onDeny: (request: ConsentRequestData) => void;
  isApproving: boolean;
  isDenying: boolean;
}

function MemberConsentModal({
  visible,
  consentRequest,
  memberName,
  onApprove,
  onDeny,
  isApproving,
  isDenying,
}: MemberConsentModalProps): React.JSX.Element {
  const isActing = isApproving || isDenying;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={() => undefined} // member must explicitly choose
      statusBarTranslucent
    >
      {/* No backdrop dismiss — member must make an explicit choice */}
      <View style={mcm.backdrop}>
        <View
          style={mcm.card}
          accessibilityRole="alert"
          accessibilityLabel="Recording consent request"
          accessibilityViewIsModal
        >
          <Text style={mcm.title}>Recording Consent Request</Text>

          {/*
           * HIPAA minimum-necessary disclosure + California §632 language.
           * Both parties must affirmatively consent; this copy explains:
           *   - what is being recorded
           *   - how it is stored and used
           *   - the member's right to revoke
           */}
          <Text style={mcm.body}>
            Your CHW would like to record this session for clinical notes.
            Recordings are encrypted, stored securely, and used only to
            generate session documentation.
          </Text>
          <Text style={mcm.body}>
            You can revoke consent at any time by asking your CHW to stop
            the recording.
          </Text>

          <View style={mcm.buttonRow}>
            <TouchableOpacity
              style={[mcm.denyButton, isActing && mcm.buttonDisabled]}
              onPress={() => !isActing && onDeny(consentRequest)}
              disabled={isActing}
              accessibilityRole="button"
              accessibilityLabel="Deny recording"
              accessibilityState={{ disabled: isActing }}
            >
              {isDenying ? (
                <ActivityIndicator size="small" color={colors.mutedForeground} />
              ) : (
                <Text style={mcm.denyText}>Deny</Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              style={[mcm.approveButton, isActing && mcm.buttonDisabled]}
              onPress={() => !isActing && onApprove(consentRequest)}
              disabled={isActing}
              accessibilityRole="button"
              accessibilityLabel="Approve recording"
              accessibilityState={{ disabled: isActing }}
            >
              {isApproving ? (
                <ActivityIndicator size="small" color={colors.primaryForeground} />
              ) : (
                <Text style={mcm.approveText}>Approve</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const mcm = StyleSheet.create({
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
  buttonRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 6,
  },
  denyButton: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 12,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  denyText: {
    ...typography.bodySm,
    fontWeight: '600',
    color: colors.mutedForeground,
  },
  approveButton: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 12,
    backgroundColor: colors.primary,
    alignItems: 'center',
  },
  approveText: {
    ...typography.bodySm,
    fontWeight: '600',
    color: colors.primaryForeground,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
});

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
  bodySmall: {
    fontSize: 12,
    color: colors.mutedForeground,
    lineHeight: 18,
  },
  advancedToggle: {
    paddingTop: 4,
    alignSelf: 'flex-start',
  },
  advancedToggleText: {
    fontSize: 12,
    color: colors.mutedForeground,
    fontWeight: '500',
  },
  advancedSection: {
    gap: 10,
    paddingTop: 4,
    paddingLeft: 4,
    borderLeftWidth: 2,
    borderLeftColor: colors.border,
  },
  advancedLabel: {
    fontSize: 12,
    color: colors.mutedForeground,
    lineHeight: 18,
    fontStyle: 'italic',
  },
  attestButton: {
    marginTop: 4,
  },
});

// ─── Main component ───────────────────────────────────────────────────────────

export interface SessionChatProps {
  /** The session UUID — used directly against the session-scoped endpoints. */
  sessionId: string;
  /**
   * Optional callback invoked when the CHW taps "Start health assessment".
   * The parent screen (e.g. CHWSessionsScreen) navigates to CHWMemberAssessment.
   * Omitting this prop hides the assessment button.
   */
  onStartAssessment?: () => void;
}

// ─── MemberAudioStatusIndicator ───────────────────────────────────────────────
//
// CHW-side passive indicator: is the member sharing their device microphone?
// Rendered in the header for in-person sessions only.  Does NOT include any
// interactive element — the CHW cannot control the member's mic from here.
//
// Green dot + label when the member has an active device_audio_capture grant
// for this CHW relationship; gray otherwise (declined or no decision yet).

interface MemberAudioStatusIndicatorProps {
  /** UUID of the current session (used for the consent-list query). */
  sessionId: string;
  /** UUID of the CHW (passed to the consent query for namespacing). */
  chwId: string;
}

function MemberAudioStatusIndicator({
  sessionId,
  chwId,
}: MemberAudioStatusIndicatorProps): React.JSX.Element {
  const { chwAudioConsentActive } = useMemberDeviceAudioConsent(
    sessionId,
    chwId,
    { enabled: true },
  );

  return (
    <View
      style={memberAudioStyles.container}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <View
        style={[
          memberAudioStyles.dot,
          chwAudioConsentActive
            ? memberAudioStyles.dotActive
            : memberAudioStyles.dotInactive,
        ]}
      />
      <Text style={memberAudioStyles.label}>
        {chwAudioConsentActive ? 'Member mic on' : 'Member mic off'}
      </Text>
    </View>
  );
}

const memberAudioStyles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 8,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  dotActive: {
    backgroundColor: '#22c55e', // green-500 — matches "live" conventions in the product
  },
  dotInactive: {
    backgroundColor: colors.mutedForeground,
  },
  label: {
    fontSize: 11,
    color: colors.mutedForeground,
    fontWeight: '500',
  },
});

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
export function SessionChat({ sessionId, onStartAssessment }: SessionChatProps): React.JSX.Element {
  const { userRole, userName } = useAuth();

  const [inputValue, setInputValue] = useState('');
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [toastIsError, setToastIsError] = useState(false);
  const [callInitiating, setCallInitiating] = useState(false);

  /**
   * When true, transcript chunks with confidence < 0.7 are filtered from
   * the rendered list. State is local to the session mount — not persisted.
   */
  const [hideLowConfidence, setHideLowConfidence] = useState(false);

  /** True while the export PDF request is in flight. */
  const [exportLoading, setExportLoading] = useState(false);

  // ── Transcription state ──────────────────────────────────────────────────────

  /** Whether the `useSessionTranscription` hook should be running. */
  const [transcriptionEnabled, setTranscriptionEnabled] = useState(false);

  /** Accumulated transcript chunks for the current session mount. */
  const [transcriptChunks, setTranscriptChunks] = useState<TranscriptChunk[]>([]);

  /** Show the "followup processing" banner after the session is stopped. */
  const [showFollowupBanner, setShowFollowupBanner] = useState(false);

  // ── Two-party consent request state (CHW side) ───────────────────────────────

  /** Consent gate lifecycle state. */
  const [consentGateState, setConsentGateState] = useState<ConsentGateState>('closed');
  const [consentError, setConsentError] = useState<string | null>(null);
  const [consentModalOpen, setConsentModalOpen] = useState(false);
  /** Whether the Advanced (verbal attestation) section is expanded. */
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  /** The active consent request ID (set after POST /consent-requests succeeds). */
  const [activeConsentRequestId, setActiveConsentRequestId] = useState<string | null>(null);

  /**
   * Tracks whether the member has approved consent for this mount.
   * Resets if the component unmounts (new session re-requires consent).
   */
  const consentGrantedRef = useRef(false);

  // ── Member-side consent polling state ────────────────────────────────────────

  /**
   * The pending consent request the member sees, or null when none is active.
   * Populated by the usePendingConsents poll (member side only).
   */
  const [pendingConsentForMember, setPendingConsentForMember] =
    useState<ConsentRequestData | null>(null);

  // ── Member device-audio-capture consent state ─────────────────────────────────
  //
  // The MemberDeviceAudioConsentModal is a one-time opt-in for the member to
  // share their device mic during in-person sessions. The modal appears on the
  // first in-person session with a given CHW if no prior grant exists for that
  // CHW relationship. Once granted (or declined for this session), the modal
  // does not reappear for the lifetime of this component mount.
  //
  // `declinedAudioCaptureThisMount` tracks a transient "No thanks" tap — it
  // resets on component unmount (e.g. next session) but is NOT persisted to the
  // backend, so the member can change their mind on the next session. Only an
  // explicit "Yes" results in a backend consent row (which the
  // useMemberDeviceAudioConsent hook detects across sessions).

  /**
   * True once the member has declined device audio capture for this session mount.
   * Resets to false when the component unmounts (new session = fresh prompt).
   */
  const [declinedAudioCaptureThisMount, setDeclinedAudioCaptureThisMount] =
    useState(false);

  /**
   * True once the member has accepted device audio capture in this session mount
   * (either via the modal or because a prior grant was detected).  Prevents the
   * modal from re-appearing after accept.
   */
  const [acceptedAudioCaptureThisMount, setAcceptedAudioCaptureThisMount] =
    useState(false);

  /**
   * Member's manual mic-capture toggle for this session (Change 2 — 2026-05-06).
   *
   * Separate from `acceptedAudioCaptureThisMount`:
   *   - `acceptedAudioCaptureThisMount` tracks whether the member has *granted*
   *     consent (persists to backend on "Yes").
   *   - `memberMicCaptureOn` tracks whether the member *currently wants* to
   *     share audio. Starts false; flips to true when consent is detected or
   *     after the member accepts the modal. Member can toggle off mid-session
   *     via the header button without revoking the server-side consent row
   *     (consent persists per-CHW relationship by design — see
   *     project_compass_live_captions_decision.md).
   *
   * Only used on the member side for in-person sessions (`!isCHW && isInPersonSession`).
   * Initialised false; the effect below flips it to true once consent is resolved.
   */
  const [memberMicCaptureOn, setMemberMicCaptureOn] = useState(false);

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

  // ── Pending attachment state ───────────────────────────────────────────────
  // Set when the user picks a file/image; cleared on send or remove. The chip
  // in the input area surfaces it back to the user before sending.
  const [pendingAttachment, setPendingAttachment] = useState<RNFileAsset | null>(null);
  const [attachmentUploading, setAttachmentUploading] = useState(false);
  const [attachmentSheetOpen, setAttachmentSheetOpen] = useState(false);

  const listRef = useRef<FlatList<RenderItem>>(null);

  // ── Derived role (needed before hooks that depend on it) ────────────────────

  const myRole = userRole ?? 'member';
  /** True only for CHW users. Only CHWs have the Mic button. */
  const isCHW = myRole === 'chw';

  // ── Data queries ─────────────────────────────────────────────────────────────

  const sessionQuery = useSession(sessionId);
  const session = sessionQuery.data;

  const isCallable = session ? CALLABLE_STATUSES.has(session.status) : false;

  /**
   * True when this session is conducted over a phone call (mode='phone').
   *
   * Phone sessions fork Vonage call audio to the backend independently — the
   * CHW's browser must NOT capture the device mic.  Instead, the transcription
   * hook subscribes to the server's fan-out stream via WebSocket (subscribe_only
   * mode) and the CHW sees live captions without ever acquiring getUserMedia.
   *
   * Consent is handled by the Vonage IVR during the call setup — the in-app
   * consent modal must NOT appear for phone sessions.
   */
  const isPhoneSession = session?.mode === 'phone';

  /**
   * True when this session is an in-person session.
   * In-person sessions are candidates for member-side mic capture.
   */
  const isInPersonSession = session?.mode === 'in_person';

  /**
   * The transcription mode forwarded to the hook.
   *
   * Decision table (from the member's perspective for in-person sessions):
   *   - Phone sessions              → `'subscribe_only'`: WS receive-only, no mic.
   *   - In-person + member accepted → `'mic_capture'`: member device sends audio.
   *   - In-person + no decision yet → `'subscribe_only'`: modal is pending.
   *   - In-person + declined        → `'subscribe_only'`: member opted out.
   *   - CHW (any mode)              → determined by isPhoneSession (unchanged).
   *
   * This is derived from stable booleans so it does not cause additional
   * re-renders beyond what those booleans already drive.
   */
  const transcriptionMode: TranscriptionMode = (() => {
    if (isPhoneSession) return 'subscribe_only';
    // Member side in-person: use mic_capture only when consent has been granted
    // AND the member's manual toggle is currently ON.
    //
    // Two independent gates:
    //   1. `acceptedAudioCaptureThisMount` — consent exists on the backend.
    //   2. `memberMicCaptureOn` — the member has not toggled off mid-session.
    // Both must be true for actual mic capture to begin.
    // If the toggle is off (member paused), fall through to subscribe_only so
    // the CHW's mic stream is still received (no audio gap on the CHW side).
    if (!isCHW) {
      // Member side (any mode): mic_capture only when consent + toggle both on.
      // Phone sessions can also benefit from a member-device mic (e.g. when
      // speakerphone audio quality is poor), so we no longer gate on mode.
      return acceptedAudioCaptureThisMount && memberMicCaptureOn
        ? 'mic_capture'
        : 'subscribe_only';
    }
    // CHW side: default to mic_capture in all modes.
    return 'mic_capture';
  })();

  const messagesQuery = useSessionMessages(sessionId);
  const sendMessage = useSessionSendMessage();
  const markRead = useSessionMarkRead();
  const startCall = useStartCall();
  const grantConsent = useGrantTranscriptionConsent(sessionId);
  const transcriptExport = useTranscriptExport();

  // ── Two-party consent hooks (CHW side) ───────────────────────────────────────
  const createConsentRequest = useCreateConsentRequest(sessionId);
  const cancelConsentRequest = useCancelConsentRequest();

  // CHW polls for status of the active consent request.
  // Stops automatically when status reaches a terminal value.
  const consentRequestStatusQuery = useConsentRequestStatus(
    activeConsentRequestId ?? '',
    {
      enabled:
        isCHW &&
        activeConsentRequestId !== null &&
        consentGateState === 'waiting_for_member',
    },
  );

  // ── Two-party consent hooks (member side) ────────────────────────────────────
  // Poll for pending requests every 3 s while in an active session.
  const pendingConsentsQuery = usePendingConsents(sessionId, {
    enabled: !isCHW && session?.status === 'in_progress',
  });
  const approveConsentRequest = useApproveConsentRequest();
  const denyConsentRequest = useDenyConsentRequest();

  // ── Member device-audio-capture consent hooks ─────────────────────────────────
  //
  // Polls GET /sessions/{id}/consents to detect whether the member has already
  // granted device_audio_capture consent for any session with this CHW.
  // The `chwAudioConsentActive` boolean short-circuits the modal entirely for
  // returning members — the query is disabled once capture is accepted to avoid
  // unnecessary polling while audio is already streaming.

  const deviceAudioConsentQuery = useMemberDeviceAudioConsent(
    sessionId,
    session?.chwId ?? '',
    {
      // Only poll when:
      //   - we are on the member side
      //   - the session is in-progress and in-person
      //   - capture hasn't already been resolved for this mount
      enabled:
        !isCHW &&
        session?.status === 'in_progress' &&
        !acceptedAudioCaptureThisMount &&
        !declinedAudioCaptureThisMount,
    },
  );

  const grantDeviceAudioConsent = useGrantDeviceAudioConsent(sessionId);

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
    setTranscriptChunks((prev) => {
      // AssemblyAI Universal Streaming emits multiple TurnEvents per turn:
      // a series of partials (is_final=false) culminating in one final
      // (is_final=true). To render a single live-updating bubble per turn
      // instead of every partial as its own message, replace the trailing
      // chunk in place if it is still a partial — that's the in-progress
      // turn this chunk continues. Once a final lands, the next partial
      // belongs to a new turn and gets appended.
      if (prev.length > 0 && !prev[prev.length - 1].isFinal) {
        return [...prev.slice(0, -1), chunk];
      }
      return [...prev, chunk];
    });
  }, []);

  const transcription = useSessionTranscription({
    sessionId,
    enabled: transcriptionEnabled,
    mode: transcriptionMode,
    onTranscriptChunk: handleTranscriptChunk,
  });

  const isRecording = TRANSCRIPTION_ACTIVE_STATES.has(
    transcription.state as 'recording' | 'connecting' | 'reconnecting',
  );

  // ── Phone session: auto-start subscribe-only transcription ────────────────────
  //
  // When the CHW opens a phone session that transitions to 'in_progress', the
  // Vonage IVR has already collected consent on the call leg.  We auto-enable
  // the WS subscription without any in-app consent modal so captions appear
  // immediately when the backend starts fanning out transcript chunks.
  //
  // Design decisions:
  //   - Only the CHW side subscribes — members never see live captions (product
  //     rule enforced via isCHW gate).
  //   - We guard against double-starts with the `isRecording` check; React strict
  //     mode's double-effect is harmless because `start()` is idempotent when
  //     `state === 'connecting'`.
  //   - If the WebSocket fails, the existing error→toast path handles it; the CHW
  //     sees a toast and the indicator disappears — text chat is unaffected.
  //   - We do NOT start before `in_progress` to avoid a WS open on a session that
  //     may never connect (race with Vonage call placement).
  useEffect(() => {
    if (!isCHW || !isPhoneSession) return;
    if (session?.status !== 'in_progress') return;
    if (isRecording || transcriptionEnabled) return;

    // Auto-enable and start the subscribe-only WS connection.
    setTranscriptionEnabled(true);
    void transcription.start();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCHW, isPhoneSession, session?.status]);

  // Member-side auto-start: when the member has consented and toggled mic
  // capture on, kick off transcription.start() (which opens the WS in
  // mic_capture mode per the resolved transcriptionMode). Without this
  // effect the mode flips to mic_capture but nothing actually opens the
  // connection — the symptom is "toggle says on, nothing transcribes".
  useEffect(() => {
    if (isCHW) return;
    if (session?.status !== 'in_progress') return;
    if (transcriptionMode !== 'mic_capture') return;
    if (transcriptionEnabled) return;

    setTranscriptionEnabled(true);
    void transcription.start();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCHW, session?.status, transcriptionMode]);

  // ── Toast helpers — declared early because effects below depend on it ─────────

  const showToast = useCallback((message: string, isError: boolean) => {
    setToastMessage(message);
    setToastIsError(isError);
    const timer = setTimeout(() => setToastMessage(null), 3_500);
    return () => clearTimeout(timer);
  }, []);

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

  /**
   * Reconnect toast: show a non-blocking warning when the WebSocket is
   * attempting to reconnect, and dismiss it once recording resumes.
   * Text chat remains fully operational during reconnect.
   */
  const prevTranscriptionStateRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevTranscriptionStateRef.current;
    const next = transcription.state;
    prevTranscriptionStateRef.current = next;

    if (next === 'reconnecting' && prev !== 'reconnecting') {
      // Show persistent reconnecting notice (clears when state changes).
      setToastMessage('Connection lost — reconnecting\u2026');
      setToastIsError(true);
    } else if (next === 'recording' && prev === 'reconnecting') {
      // Connection restored — fade the toast out.
      setToastMessage('Reconnected');
      setToastIsError(false);
      // Auto-dismiss after a short delay.
      const timer = setTimeout(() => setToastMessage(null), 2_000);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [transcription.state]);

  // ── CHW polling: react to consent request status changes ─────────────────────
  //
  // Watches the polled consent-request status and transitions the consent gate
  // state machine accordingly.  The useConsentRequestStatus hook already stops
  // polling on terminal statuses — this effect handles the UI side effects.

  const consentRequestStatus = consentRequestStatusQuery.data?.status as
    | ConsentRequestStatus
    | undefined;

  useEffect(() => {
    if (!isCHW || activeConsentRequestId === null) return;
    if (consentGateState !== 'waiting_for_member') return;
    if (consentRequestStatus === undefined) return;

    if (consentRequestStatus === 'approved') {
      consentGrantedRef.current = true;
      setConsentGateState('approved');
      setConsentModalOpen(false);
      setActiveConsentRequestId(null);
      // Transition to recording: the next Mic tap (or the auto-start below) will fire.
      // We auto-start here so the CHW doesn't need a second tap after approval.
      setTranscriptionEnabled(true);
      void transcription.start();
    } else if (consentRequestStatus === 'denied') {
      setConsentGateState('denied');
      setConsentModalOpen(false);
      setActiveConsentRequestId(null);
      showToast('Member declined — you can ask again later.', false);
    } else if (consentRequestStatus === 'cancelled') {
      // Should not happen (CHW cancels from the modal), but handle defensively.
      setConsentGateState('closed');
      setConsentModalOpen(false);
      setActiveConsentRequestId(null);
    } else if (consentRequestStatus === 'expired') {
      setConsentGateState('expired');
      setConsentModalOpen(false);
      setActiveConsentRequestId(null);
      showToast('Request timed out — please try again.', true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [consentRequestStatus, isCHW, activeConsentRequestId, consentGateState]);

  // ── Member polling: surface the pending consent request in a modal ───────────
  //
  // Keeps pendingConsentForMember in sync with the latest poll result.
  // Only renders if there is exactly one pending request (expected invariant:
  // the backend 409-guards duplicate-pending rows per session+consent_type).

  useEffect(() => {
    if (isCHW) return; // CHW does not see the member approval modal
    const rows = pendingConsentsQuery.data ?? [];
    // Surface the first pending request (newest, by requested_at desc from backend).
    setPendingConsentForMember(rows.length > 0 ? (rows[0] ?? null) : null);
  }, [pendingConsentsQuery.data, isCHW]);

  // ── Member device-audio-capture: auto-accept when prior grant detected ────────
  //
  // When the useMemberDeviceAudioConsent poll returns `chwAudioConsentActive=true`,
  // the member has previously granted consent for this CHW — skip the modal and
  // flip straight to `mic_capture` mode. This is the "per-CHW-relationship" fast
  // path that avoids re-prompting a returning member.
  //
  // Guard: only flip once (acceptedAudioCaptureThisMount) to avoid a flip-flop
  // if the query result briefly goes undefined during a refetch.

  useEffect(() => {
    if (isCHW) return;
    if (acceptedAudioCaptureThisMount || declinedAudioCaptureThisMount) return;
    if (!deviceAudioConsentQuery.chwAudioConsentActive) return;

    // Prior grant detected — accept silently without showing the modal, and
    // default the member's manual toggle to ON (they opted in previously).
    // The member can still turn the toggle off mid-session via the header button.
    setAcceptedAudioCaptureThisMount(true);
    setMemberMicCaptureOn(true);
  }, [
    isCHW,
    deviceAudioConsentQuery.chwAudioConsentActive,
    acceptedAudioCaptureThisMount,
    declinedAudioCaptureThisMount,
  ]);

  // ── Member device-audio-capture handlers ──────────────────────────────────────

  /**
   * Member tapped "Yes, share my device's audio" in the opt-in modal.
   *
   * 1. POST device_audio_capture consent to the backend (persists the grant).
   * 2. Mark accepted for this mount → `transcriptionMode` flips to `'mic_capture'`.
   * 3. The existing transcription hook will pick up the mode change on its next
   *    enabled → start() cycle (driven by transcriptionEnabled).
   *
   * On error: the modal closes and falls through to subscribe_only mode.
   * The member is not shown an error toast — failure here is non-blocking; the
   * session continues without member-side capture.
   */
  const handleAcceptDeviceAudioCapture = useCallback(async () => {
    try {
      // Use the member's name from session data as the typed_signature for the
      // HIPAA "individual authorization" audit record. Falls back to a generic
      // label if the name is not yet resolved.
      const memberName = session?.memberName ?? userName ?? 'Member';
      await grantDeviceAudioConsent.mutateAsync(memberName);
      setAcceptedAudioCaptureThisMount(true);
      // Also flip the manual toggle ON so capture starts immediately after consent.
      setMemberMicCaptureOn(true);
    } catch {
      // Non-blocking: consent POST failed. Log lifecycle event only.
      // Fall through to subscribe_only — the session continues without member capture.
      console.warn(
        '[DeviceAudioCapture] consent POST failed — falling through to subscribe_only',
      );
      setDeclinedAudioCaptureThisMount(true);
    }
  }, [session?.memberName, userName, grantDeviceAudioConsent]);

  /**
   * Member tapped "No thanks" in the opt-in modal.
   *
   * Marks a transient decline for this mount. The mode stays `'subscribe_only'`.
   * No backend call is made — the absence of a consent row means the modal will
   * reappear on the next session with this CHW.
   */
  const handleDeclineDeviceAudioCapture = useCallback(() => {
    setDeclinedAudioCaptureThisMount(true);
  }, []);

  // ── Navigation hook (Change 3 — profile avatar header) ───────────────────────
  //
  // useNavigation() works when SessionChat is rendered inside a React Navigation
  // stack (the normal path: CHWSessionsScreen → Session detail, or
  // MemberSessionsScreen → Session detail).
  //
  // Trade-off / fallback: if SessionChat is ever rendered inside a plain Modal
  // (outside the React Navigation tree), useNavigation() will throw. We guard
  // with a try/catch at the call site so the rest of the component renders
  // correctly — the avatar header becomes non-tappable in that case (the touch
  // handler is a no-op) rather than crashing.
  //
  // If we later need to navigate FROM a modal context we can accept an
  // `onNavigateToProfile?: () => void` prop from the parent and call that; the
  // parent (which IS inside the navigator) can then do the push. For now the
  // guard approach is sufficient because all known entry points are stack screens.
  const navigation = useNavigation<any>(); // eslint-disable-line @typescript-eslint/no-explicit-any

  /**
   * Navigate to the other party's profile screen.
   *
   * CHW side → pushes `MemberProfile` inside the SessionsStack with `{ memberId }`.
   * Member side → pushes `CHWProfile` inside the FindStack with `{ chwId }`.
   *
   * Navigation may fail (e.g. if this component is rendered inside a plain React
   * Native Modal outside the navigation tree). In that case we catch silently —
   * the avatar tap is a convenience affordance, not a critical user flow.
   */
  const handleAvatarPress = useCallback(() => {
    if (!session) return;
    try {
      if (isCHW) {
        // CHW taps member avatar → MemberProfile inside SessionsStack.
        // `session.memberId` is the UUID of the member in this session.
        (navigation as any).navigate('MemberProfile', { memberId: session.memberId });
      } else {
        // Member taps CHW avatar → CHWProfile inside FindStack.
        // `session.chwId` is the UUID of the CHW in this session.
        (navigation as any).navigate('CHWProfile', { chwId: session.chwId });
      }
    } catch {
      // Navigation failed — most likely SessionChat is rendered outside the
      // React Navigation tree (e.g. wrapped in a plain Modal). The tap is a
      // no-op in that case; we do not surface an error to the user because the
      // failure is transparent (profile navigation is an affordance, not
      // blocking). If this becomes a real issue, add an `onNavigateToProfile`
      // prop so the parent can own the navigation call.
    }
  }, [session, isCHW, navigation]);

  /**
   * Whether the member-side mic toggle button should be shown.
   * Only visible to the member during in-person sessions.
   * The button handles both the "no consent yet" (→ opens modal) and
   * "consent active, toggle on/off" paths.
   */
  // Originally gated on `isInPersonSession` so the toggle wouldn't appear on
  // phone sessions (where the member's audio is captured via Vonage's per-leg
  // WS, not the device mic). Relaxed to show the toggle on any in-progress
  // session: it lets the member opt into device-mic capture even on phone
  // sessions (extra audio source — useful when speakerphone audio quality
  // is poor) and unblocks testers who create video/other-mode sessions.
  const showMemberMicToggle = !isCHW && session?.status === 'in_progress';

  /**
   * Member tapped the mic toggle button in the header.
   *
   * State machine:
   *   - Mic OFF (consent not yet granted): opens `MemberDeviceAudioConsentModal`
   *     by resetting the decline flag (which unblocks the modal's visibility gate).
   *   - Mic ON: shows a confirmation dialog before turning off. Turning off is
   *     local-state only — does NOT revoke the backend consent row. The member's
   *     opt-in persists per-CHW relationship so they are not re-prompted next
   *     session (per product decision in project_compass_live_captions_decision.md).
   */
  const handleMemberMicToggle = useCallback(() => {
    if (memberMicCaptureOn && acceptedAudioCaptureThisMount) {
      // Currently ON → show confirmation before turning off.
      // React Native's Alert.alert with multiple buttons is unsupported on
      // web (the buttons are ignored). Branch on Platform so members on the
      // Vercel-hosted PWA get a real confirm dialog.
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        const ok = window.confirm(
          'Stop sharing your audio?\n\nYour microphone audio will stop being captured. Your CHW can still hear you through their own mic.',
        );
        if (ok) setMemberMicCaptureOn(false);
      } else {
        Alert.alert(
          'Stop sharing your audio?',
          'Your microphone audio will stop being captured. Your CHW can still hear you through their own mic.',
          [
            { text: 'Keep sharing', style: 'cancel' },
            {
              text: 'Stop sharing',
              style: 'destructive',
              onPress: () => setMemberMicCaptureOn(false),
            },
          ],
        );
      }
    } else {
      // Currently OFF (either declined or toggled off) → re-open consent modal.
      // Reset the decline flag so the visibility gate allows the modal to show.
      // If consent was already granted (`acceptedAudioCaptureThisMount` is true),
      // the modal will not re-appear for a returning member — instead we simply
      // flip the toggle back on directly, since consent is already on file.
      if (acceptedAudioCaptureThisMount) {
        // Consent exists but toggle is off — just re-enable without re-prompting.
        setMemberMicCaptureOn(true);
      } else {
        // No consent yet (or declined this mount) — open the modal again.
        setDeclinedAudioCaptureThisMount(false);
      }
    }
  }, [memberMicCaptureOn, acceptedAudioCaptureThisMount]);

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
      ...transcriptChunks
        // When hideLowConfidence is enabled, drop chunks below the threshold.
        .filter((chunk) => !hideLowConfidence || chunk.confidence >= 0.7)
        .map<Weighted>((chunk, index) => ({
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
  }, [mergedMessages, transcriptChunks, showFollowupBanner, hideLowConfidence]);

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

  // ── Consent + Mic handlers ────────────────────────────────────────────────────

  /**
   * CHW tapped "Send Request" in the consent modal (two-party path).
   *
   * POSTs to /sessions/{id}/consent-requests, transitions modal to
   * "waiting_for_member" state, and lets the CHW polling effect react
   * to the member's response.
   */
  const handleSendConsentRequest = useCallback(async () => {
    setConsentGateState('requesting');
    setConsentError(null);

    try {
      const cr = await createConsentRequest.mutateAsync('ai_transcription');
      setActiveConsentRequestId(cr.id);
      setConsentGateState('waiting_for_member');
    } catch (err) {
      const detail =
        err instanceof Error && err.message
          ? err.message
          : 'Could not send consent request. Please try again.';
      setConsentError(detail);
      setConsentGateState('error');
    }
  }, [createConsentRequest]);

  /**
   * CHW tapped "Cancel Request" while waiting for the member to respond.
   *
   * POSTs to /consent-requests/{id}/cancel and closes the modal.
   * The member's pending-consents poll will return an empty list on the next
   * cycle, hiding the member's approval modal.
   */
  const handleCancelConsentRequest = useCallback(async () => {
    if (activeConsentRequestId === null) {
      setConsentModalOpen(false);
      setConsentGateState('closed');
      return;
    }
    try {
      await cancelConsentRequest.mutateAsync(activeConsentRequestId);
    } catch {
      // Best-effort cancel — even if it fails the CHW is closing the modal.
    } finally {
      setActiveConsentRequestId(null);
      setConsentGateState('closed');
      setConsentModalOpen(false);
    }
  }, [activeConsentRequestId, cancelConsentRequest]);

  /**
   * CHW used the verbal-attestation fallback (phone-only sessions).
   *
   * Calls the existing /sessions/{id}/consent endpoint with chw_attestation=true,
   * which creates a MemberConsent row on the member's behalf (CHW as surrogate).
   * This is the pre-existing fallback path — compliant for phone calls where the
   * member cannot open the app.
   */
  const handleVerbalAttest = useCallback(async () => {
    setConsentGateState('requesting');
    setConsentError(null);

    try {
      await grantConsent.mutateAsync({
        consentType: 'ai_transcription',
        typedSignature: userName ?? 'CHW',
        chwAttestation: true,
      });
      consentGrantedRef.current = true;
      setConsentModalOpen(false);
      setConsentGateState('approved');
      // Start recording immediately after verbal attestation.
      setTranscriptionEnabled(true);
      await transcription.start();
    } catch (err) {
      const detail =
        err instanceof Error && err.message
          ? err.message
          : 'Could not record consent. Please try again.';
      setConsentError(detail);
      setConsentGateState('error');
    }
  }, [grantConsent, userName, transcription]);

  /**
   * Handle Mic button press.
   *
   * State machine:
   *   - If currently recording → stop transcription + show followup banner.
   *   - If consent already granted (previous approval) → start recording directly.
   *   - Otherwise → open the consent modal (default: request_consent mode).
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

    // Consent already granted this session mount → start recording directly.
    if (consentGrantedRef.current) {
      setTranscriptionEnabled(true);
      await transcription.start();
      return;
    }

    // Open the consent modal (default: "Request consent from member").
    setConsentGateState('closed');
    setConsentError(null);
    setAdvancedExpanded(false);
    setConsentModalOpen(true);
  }, [isCHW, isRecording, transcription]);

  // ── Member consent handlers ───────────────────────────────────────────────────

  /**
   * Member tapped "Approve" on the consent modal.
   *
   * POSTs typed_signature (member's name) to /consent-requests/{id}/approve.
   * The backend creates a MemberConsent row with member_id = the member's own
   * user ID — this is the HIPAA "individual authorization" record.
   */
  const handleMemberApproveConsent = useCallback(
    async (consentRequest: ConsentRequestData) => {
      try {
        await approveConsentRequest.mutateAsync({
          requestId: consentRequest.id,
          // Use the member's display name as the typed signature.
          typedSignature: userName ?? 'Member',
        });
        setPendingConsentForMember(null);
        showToast('Recording approved.', false);
      } catch {
        showToast('Could not approve. Please try again.', true);
      }
    },
    [approveConsentRequest, userName, showToast],
  );

  /**
   * Member tapped "Deny" on the consent modal.
   *
   * POSTs to /consent-requests/{id}/deny. No MemberConsent row is created.
   * Denial is final for this request — the CHW must send a new request to ask again.
   */
  const handleMemberDenyConsent = useCallback(
    async (consentRequest: ConsentRequestData) => {
      try {
        await denyConsentRequest.mutateAsync(consentRequest.id);
        setPendingConsentForMember(null);
        showToast('Recording declined.', false);
      } catch {
        showToast('Could not submit response. Please try again.', true);
      }
    },
    [denyConsentRequest, showToast],
  );

  // ── Export handler ─────────────────────────────────────────────────────────────

  /**
   * Download the session transcript as PDF.
   * Shows a loading state on the button while in flight.
   * HIPAA: no transcript content is included in the toast messages.
   */
  const handleExport = useCallback(async () => {
    if (exportLoading) return;
    setExportLoading(true);
    try {
      await transcriptExport.mutateAsync(sessionId);
      showToast('Transcript saved.', false);
    } catch (err) {
      const detail =
        err instanceof Error && err.message ? err.message : 'Export failed. Try again.';
      showToast(detail, true);
    } finally {
      setExportLoading(false);
    }
  }, [exportLoading, sessionId, transcriptExport, showToast]);

  // ── Attachment pickers ────────────────────────────────────────────────────
  //
  // Three entry points (action sheet → handlers below):
  //   1. Take photo (native only — uses device camera)
  //   2. Choose photo from library (uses expo-image-picker)
  //   3. Choose file (uses expo-document-picker; PDFs only by default)
  //
  // All three converge on `setPendingAttachment(asset)` which surfaces a chip
  // in the input area. The actual S3 upload happens at send time so the user
  // can still cancel without burning network calls.

  const pickFromCamera = useCallback(async () => {
    setAttachmentSheetOpen(false);
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        showToast('Camera permission is required.', true);
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.8,
        // exif: false avoids bloating size with extra metadata
        exif: false,
      });
      if (result.canceled || result.assets.length === 0) return;
      const a = result.assets[0];
      setPendingAttachment({
        uri: a.uri,
        name: a.fileName ?? `photo_${Date.now()}.jpg`,
        type: a.mimeType ?? 'image/jpeg',
        sizeBytes: a.fileSize,
      });
    } catch {
      showToast('Could not open camera.', true);
    }
  }, [showToast]);

  const pickFromLibrary = useCallback(async () => {
    setAttachmentSheetOpen(false);
    try {
      // No permission needed on web; native asks at launch.
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.8,
        exif: false,
      });
      if (result.canceled || result.assets.length === 0) return;
      const a = result.assets[0];
      setPendingAttachment({
        uri: a.uri,
        name: a.fileName ?? `image_${Date.now()}.jpg`,
        type: a.mimeType ?? 'image/jpeg',
        sizeBytes: a.fileSize,
      });
    } catch {
      showToast('Could not pick image.', true);
    }
  }, [showToast]);

  const pickDocument = useCallback(async () => {
    setAttachmentSheetOpen(false);
    try {
      // Backend MIME allowlist for chat: PDF only for non-image files.
      const result = await DocumentPicker.getDocumentAsync({
        type: 'application/pdf',
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled || result.assets.length === 0) return;
      const a = result.assets[0];
      setPendingAttachment({
        uri: a.uri,
        name: a.name ?? `document_${Date.now()}.pdf`,
        type: a.mimeType ?? 'application/pdf',
        sizeBytes: a.size,
      });
    } catch {
      showToast('Could not pick file.', true);
    }
  }, [showToast]);

  const clearPendingAttachment = useCallback(() => {
    setPendingAttachment(null);
    setAttachmentUploading(false);
  }, []);

  // ── Send handler ──────────────────────────────────────────────────────────────

  const handleSend = useCallback(async () => {
    const trimmed = inputValue.trim();
    const hasAttachment = pendingAttachment !== null;
    if ((!trimmed && !hasAttachment) || sendMessage.isPending || attachmentUploading) return;

    const tempId = `optimistic_${Date.now()}`;
    const optimisticEntry: SessionMessageLocal = {
      id: tempId,
      senderUserId: '',          // unknown client-side; server provides authoritative
      senderRole: myRole as 'chw' | 'member',
      body: trimmed,
      // Echo the attachment back optimistically so the user sees the bubble
      // immediately. We don't have a download URL yet, so we use the local
      // file URI for image previews — the next poll will replace with the
      // server-confirmed presigned URL.
      attachment: hasAttachment && pendingAttachment
        ? {
            id: `pending_${tempId}`,
            filename: pendingAttachment.name,
            sizeBytes: pendingAttachment.sizeBytes ?? 0,
            contentType: pendingAttachment.type,
            s3Key: '',
            downloadUrl: pendingAttachment.uri,
          }
        : null,
      createdAt: new Date().toISOString(),
      status: 'sending',
    };

    // 1. Append optimistic entry immediately + clear input + chip
    setOptimisticMessages((prev) => [...prev, optimisticEntry]);
    setInputValue('');
    const attachmentToUpload = pendingAttachment;
    setPendingAttachment(null);

    try {
      // 2a. Upload the attachment to S3 first (if any)
      let uploadedAttachment: { s3Key: string; filename: string; sizeBytes: number; contentType: string } | undefined;
      if (attachmentToUpload) {
        setAttachmentUploading(true);
        // 'document' purpose routes to the PHI bucket per backend upload.py
        const s3Key = await uploadFile(attachmentToUpload, 'document');
        uploadedAttachment = {
          s3Key,
          filename: attachmentToUpload.name,
          sizeBytes: attachmentToUpload.sizeBytes ?? 0,
          contentType: attachmentToUpload.type,
        };
        setAttachmentUploading(false);
      }

      // 2b. Fire send-message request; get back authoritative row
      const confirmed = await sendMessage.mutateAsync({
        sessionId,
        body: trimmed,
        attachment: uploadedAttachment,
      });

      // 3. Replace optimistic entry with confirmed row (status=undefined → confirmed)
      setOptimisticMessages((prev) =>
        prev
          .filter((m) => m.id !== tempId)
          .concat({ ...confirmed, status: undefined }),
      );
    } catch {
      // 4. Mark as failed. HIPAA: do not include the body in any error log.
      setAttachmentUploading(false);
      setOptimisticMessages((prev) =>
        prev.map((m) =>
          m.id === tempId ? { ...m, status: 'failed' } : m,
        ),
      );
    }
  }, [inputValue, pendingAttachment, sessionId, myRole, sendMessage, attachmentUploading]);

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

  // Attachment-only sends are allowed: enable Send when there is text OR a
  // pending attachment, and we're not currently uploading or sending.
  const isSendDisabled =
    (!inputValue.trim() && pendingAttachment === null)
    || sendMessage.isPending
    || attachmentUploading;

  // ── Web transcription note ────────────────────────────────────────────────────
  // Web now supports mic transcription via AudioWorklet. This note is never shown.
  const showWebTranscriptionNote = false;

  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <>
      {/*
       * CHW consent gate modal — two-party consent request flow.
       *
       * Suppressed for phone sessions: consent is collected by the Vonage IVR
       * during call setup, so the in-app modal must not appear.
       */}
      {isCHW && !isPhoneSession && (
        <ConsentModal
          visible={consentModalOpen}
          memberFirstName={memberFirstName}
          chwName={userName ?? 'You'}
          consentState={consentGateState}
          consentModalMode="request_consent"
          consentError={consentError}
          advancedExpanded={advancedExpanded}
          onAdvancedToggle={() => setAdvancedExpanded((prev) => !prev)}
          onSendRequest={() => { void handleSendConsentRequest(); }}
          onCancelRequest={() => { void handleCancelConsentRequest(); }}
          onVerbalAttest={() => { void handleVerbalAttest(); }}
          onClose={() => {
            // Don't allow closing while waiting — CHW must Cancel explicitly.
            if (consentGateState === 'waiting_for_member') return;
            setConsentGateState('closed');
            setConsentModalOpen(false);
          }}
        />
      )}

      {/* Member consent modal — shown when CHW has sent a consent request */}
      {!isCHW && pendingConsentForMember !== null && (
        <MemberConsentModal
          visible
          consentRequest={pendingConsentForMember}
          memberName={userName ?? 'Member'}
          onApprove={(cr) => { void handleMemberApproveConsent(cr); }}
          onDeny={(cr) => { void handleMemberDenyConsent(cr); }}
          isApproving={approveConsentRequest.isPending}
          isDenying={denyConsentRequest.isPending}
        />
      )}

      {/*
       * Member device-audio-capture opt-in modal.
       *
       * Shown only to the member during in-person sessions when:
       *   - the session is in_progress
       *   - no prior device_audio_capture grant exists for this CHW relationship
       *   - the member has not already decided (accept or decline) this mount
       *
       * The MemberConsentModal (above) takes priority when a CHW-initiated
       * consent request is pending — we do not stack two modals. The device
       * audio modal is blocked while pendingConsentForMember is non-null.
       */}
      {!isCHW &&
        session?.status === 'in_progress' &&
        !acceptedAudioCaptureThisMount &&
        !declinedAudioCaptureThisMount &&
        !deviceAudioConsentQuery.chwAudioConsentActive &&
        pendingConsentForMember === null && (
          <MemberDeviceAudioConsentModal
            visible
            chwName={session?.chwName ?? 'your CHW'}
            onAccept={() => { void handleAcceptDeviceAudioCapture(); }}
            onDecline={handleDeclineDeviceAudioCapture}
            isGranting={grantDeviceAudioConsent.isPending}
          />
        )}

      {/*
       * Member-side recording-possibility banner.
       * Shown only to the member, only when the session is in_progress.
       * The CHW *may* be recording at any moment of an in-progress session.
       * The banner tells the member they could be on the record so they
       * can ask the CHW to stop or revoke consent.
       *
       * TODO: replace "may be recording" with a real recording-state check
       * (poll a /sessions/{id}/recording-status endpoint that asks the
       * transcript_hub whether a streaming session is open). Until then,
       * an honest superset is correct over zero indicator.
       */}
      {!isCHW && session?.status === 'in_progress' && (
        <View style={memberRecBannerStyles.container}>
          <View style={memberRecBannerStyles.dot} />
          <Text style={memberRecBannerStyles.text}>
            This session may be recorded for clinical notes. You can ask your CHW to stop at any time.
          </Text>
        </View>
      )}

      <KeyboardAvoidingView
        style={c.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 24}
      >
        <View style={c.container}>
          {/* Inner header — other-party avatar + name on the left; action buttons on the right */}
          <View style={c.header}>
            {/*
             * Avatar + name (Change 3 — 2026-05-06)
             *
             * Tapping navigates to the other party's profile screen:
             *   CHW taps → MemberProfile in SessionsStack ({ memberId })
             *   Member taps → CHWProfile in FindStack ({ chwId })
             *
             * Navigation trade-off: useNavigation() is used unconditionally but
             * the handleAvatarPress callback wraps the navigate() call in try/catch.
             * If SessionChat is ever rendered inside a plain Modal (outside the
             * React Navigation tree), the tap becomes a no-op rather than a crash.
             * See the handleAvatarPress comment above for the escalation path.
             *
             * SCHEMA GAP: Avatar uses initials-only today because neither User nor
             * CHWProfile stores an avatar_url. Once added to the schema and exposed
             * on the session DTO (session.memberAvatarUrl / session.chwAvatarUrl),
             * pass it as the `photoUri` prop to Avatar.
             * Tracked: add avatar_url to User + CHWProfile schema and session DTO.
             */}
            <TouchableOpacity
              style={c.headerLeft}
              onPress={handleAvatarPress}
              disabled={!session}
              accessibilityRole="button"
              accessibilityLabel={
                isCHW
                  ? `View ${otherPartyName}'s profile`
                  : `View ${otherPartyName}'s profile`
              }
              accessibilityHint="Opens the profile screen for the other party in this session."
            >
              <Avatar displayName={otherPartyName} size={36} />
              <View style={c.headerNameBlock}>
                <Text style={c.headerName} numberOfLines={1}>
                  {otherPartyName}
                </Text>
                <Text style={c.headerSubtitle} numberOfLines={1}>
                  {session?.status === 'in_progress' ? 'In session' : 'Session Chat'}
                </Text>
              </View>
            </TouchableOpacity>

            <View style={c.headerRight}>
              {/* Recording indicator — shown while recording, connecting, or reconnecting */}
              {(transcription.state === 'recording' ||
                transcription.state === 'connecting' ||
                transcription.state === 'reconnecting') && (
                <RecordingIndicator
                  elapsedSeconds={recordingElapsedSeconds}
                  connectingState={
                    transcription.state === 'connecting' ||
                    transcription.state === 'reconnecting'
                      ? transcription.state
                      : null
                  }
                />
              )}

              {/*
               * Hide low-confidence toggle — CHW-only, visible when transcript
               * chunks are present.
               * Tapping toggles hideLowConfidence; icon reflects current state.
               */}
              {isCHW && transcriptChunks.length > 0 && (
                <TouchableOpacity
                  style={[
                    c.iconButton,
                    hideLowConfidence && c.iconButtonActive,
                  ]}
                  onPress={() => setHideLowConfidence((prev) => !prev)}
                  accessibilityRole="switch"
                  accessibilityLabel={
                    hideLowConfidence
                      ? 'Show all transcript segments (including low confidence)'
                      : 'Hide low-confidence transcript segments'
                  }
                  accessibilityState={{ selected: hideLowConfidence }}
                >
                  {hideLowConfidence ? (
                    <EyeOff size={16} color={colors.primary} />
                  ) : (
                    <Eye size={16} color={colors.mutedForeground} />
                  )}
                </TouchableOpacity>
              )}

              {/*
               * Download transcript button — CHW-only, visible when there is
               * at least one transcript chunk (i.e. recording has happened).
               */}
              {isCHW && transcriptChunks.length > 0 && (
                <TouchableOpacity
                  style={[c.iconButton, exportLoading && c.iconButtonDisabled]}
                  onPress={() => { void handleExport(); }}
                  disabled={exportLoading}
                  accessibilityRole="button"
                  accessibilityLabel="Download transcript as PDF"
                  accessibilityHint="Saves the session transcript to your device."
                  accessibilityState={{ disabled: exportLoading }}
                >
                  {exportLoading ? (
                    <ActivityIndicator size="small" color={colors.primary} />
                  ) : (
                    <Download size={16} color={colors.primary} />
                  )}
                </TouchableOpacity>
              )}

              {/*
               * Phone session: show "Captions active" indicator instead of mic
               * button.  The mic button is hidden for phone sessions because audio
               * comes from the Vonage call leg — the CHW's device mic is not used.
               * The green dot + label gives passive confirmation that captions are
               * connected, matching the green dot convention used elsewhere in the
               * product for "live" states.
               */}
              {isCHW && isPhoneSession && isRecording && (
                <View
                  style={captionsActiveStyles.container}
                  accessibilityRole="none"
                  accessibilityLabel="Live captions active"
                  accessibilityLiveRegion="polite"
                >
                  <View style={captionsActiveStyles.dot} />
                  <Text style={captionsActiveStyles.label}>Captions active</Text>
                </View>
              )}

              {/*
               * Member-audio status indicator — CHW-only, in-person sessions.
               *
               * Shows whether the member's device is sharing its mic during
               * this in-person session.  Green = member opted in (mic_capture
               * active); gray = member declined or no decision yet.
               *
               * Uses a separate query on the CHW side to check whether a
               * device_audio_capture grant exists for this session's member.
               * The query is lightweight (GET /sessions/{id}/consents) and
               * polls only while the session is in_progress.
               *
               * Accessibility: the indicator is decorative (no action needed)
               * so we suppress it from screen readers with accessibilityHidden.
               * The mic button already announces the recording state.
               */}
              {isCHW && isInPersonSession && session?.status === 'in_progress' && (
                <MemberAudioStatusIndicator sessionId={sessionId} chwId={session.chwId} />
              )}

              {/*
               * Member-side mic toggle — in-person sessions only (Change 2 — 2026-05-06).
               *
               * Mirrors the visual placement of the CHW's mic button so both
               * parties have their audio-capture control in the same header area.
               *
               * States:
               *   OFF (gray) — consent not yet granted OR member toggled off.
               *     Tapping opens MemberDeviceAudioConsentModal (same modal that
               *     auto-pops on first in-person session with this CHW).
               *   ON (sage-green active) — consent granted AND toggle is on.
               *     Tapping shows a confirmation dialog, then sets toggle to off
               *     (does NOT revoke the server-side consent row).
               *
               * Accessibility: two distinct labels per state so screen readers
               * announce the toggle's current function clearly.
               */}
              {showMemberMicToggle && (
                <TouchableOpacity
                  style={[
                    c.iconButton,
                    memberMicCaptureOn && c.iconButtonMicActive,
                  ]}
                  onPress={handleMemberMicToggle}
                  accessibilityRole="button"
                  accessibilityLabel={
                    memberMicCaptureOn
                      ? 'Stop sharing my microphone audio'
                      : 'Share my microphone audio'
                  }
                  accessibilityHint={
                    memberMicCaptureOn
                      ? 'Stops sending your device microphone audio to this session.'
                      : 'Opens a prompt to share your device microphone audio with your CHW.'
                  }
                  accessibilityState={{ selected: memberMicCaptureOn }}
                >
                  {memberMicCaptureOn ? (
                    <Mic size={16} color={colors.compassSage} />
                  ) : (
                    <MicOff size={16} color={colors.mutedForeground} />
                  )}
                </TouchableOpacity>
              )}

              {/* Mic button — CHW-only, hidden for phone sessions */}
              {isCHW && !isPhoneSession && (
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

              {/* Start health assessment — CHW-only */}
              {isCHW && onStartAssessment != null && (
                <TouchableOpacity
                  style={c.iconButton}
                  onPress={onStartAssessment}
                  accessibilityRole="button"
                  accessibilityLabel="Start health assessment"
                  accessibilityHint="Opens the Member Health and Wellness questionnaire for this session."
                >
                  <ClipboardList size={16} color={colors.primary} />
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

            {/* Pending attachment chip — shown above the input row when the
                user has picked a file/image but hasn't sent yet. */}
            {pendingAttachment !== null && (
              <View style={c.attachmentChip} accessibilityRole="none">
                {pendingAttachment.type.startsWith('image/') ? (
                  <Image
                    source={{ uri: pendingAttachment.uri }}
                    style={c.attachmentChipThumb}
                    accessibilityIgnoresInvertColors
                  />
                ) : (
                  <View style={c.attachmentChipFileIcon}>
                    <FileText size={16} color={colors.primary} />
                  </View>
                )}
                <View style={c.attachmentChipInfo}>
                  <Text style={c.attachmentChipName} numberOfLines={1}>
                    {pendingAttachment.name}
                  </Text>
                  <Text style={c.attachmentChipMeta}>
                    {pendingAttachment.sizeBytes
                      ? `${formatFileSize(pendingAttachment.sizeBytes)} · `
                      : ''}
                    {attachmentUploading ? 'Uploading…' : 'Ready to send'}
                  </Text>
                </View>
                {attachmentUploading ? (
                  <ActivityIndicator size="small" color={colors.primary} />
                ) : (
                  <TouchableOpacity
                    onPress={clearPendingAttachment}
                    style={c.attachmentChipRemove}
                    accessibilityRole="button"
                    accessibilityLabel="Remove attachment"
                    hitSlop={8}
                  >
                    <XIcon size={14} color={colors.mutedForeground} />
                  </TouchableOpacity>
                )}
              </View>
            )}

            <View style={c.inputRow}>
              {/* Attach button — opens the action sheet */}
              <TouchableOpacity
                style={c.attachButton}
                onPress={() => setAttachmentSheetOpen(true)}
                disabled={attachmentUploading || sendMessage.isPending}
                accessibilityRole="button"
                accessibilityLabel="Attach a file or photo"
                accessibilityHint="Opens a menu to take a photo, choose a photo, or pick a file."
              >
                <Paperclip size={18} color={colors.primary} />
              </TouchableOpacity>

              <ResourceMentionInput
                style={c.input}
                value={inputValue}
                onChangeText={(text) => setInputValue(text.slice(0, MAX_CHARS))}
                placeholder={
                  pendingAttachment !== null ? 'Add a message (optional)…' : 'Type a message… (@resource)'
                }
                placeholderTextColor={colors.mutedForeground}
                multiline
                maxLength={MAX_CHARS}
                returnKeyType="send"
                blurOnSubmit
                onSubmit={() => { void handleSend(); }}
                accessibilityLabel="Message input. Type @ to mention a resource."
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
                {sendMessage.isPending || attachmentUploading ? (
                  <ActivityIndicator size="small" color={colors.primaryForeground} />
                ) : (
                  <Send size={16} color={colors.primaryForeground} />
                )}
              </TouchableOpacity>
            </View>
          </View>

          {/* Attachment action sheet */}
          <Modal
            visible={attachmentSheetOpen}
            transparent
            animationType="fade"
            onRequestClose={() => setAttachmentSheetOpen(false)}
          >
            <Pressable
              style={c.sheetBackdrop}
              onPress={() => setAttachmentSheetOpen(false)}
              accessibilityRole="button"
              accessibilityLabel="Close attachment menu"
            >
              <Pressable style={c.sheetCard} onPress={() => undefined}>
                <Text style={c.sheetTitle}>Attach</Text>

                {/* Camera — native only; web UAs without getUserMedia will fail */}
                {Platform.OS !== 'web' && (
                  <TouchableOpacity
                    style={c.sheetOption}
                    onPress={() => { void pickFromCamera(); }}
                    accessibilityRole="button"
                    accessibilityLabel="Take a photo"
                  >
                    <View style={c.sheetIconCircle}>
                      <Camera size={18} color={colors.primary} />
                    </View>
                    <Text style={c.sheetOptionText}>Take photo</Text>
                  </TouchableOpacity>
                )}

                <TouchableOpacity
                  style={c.sheetOption}
                  onPress={() => { void pickFromLibrary(); }}
                  accessibilityRole="button"
                  accessibilityLabel="Choose photo from library"
                >
                  <View style={c.sheetIconCircle}>
                    <ImageIcon size={18} color={colors.primary} />
                  </View>
                  <Text style={c.sheetOptionText}>Choose photo</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={c.sheetOption}
                  onPress={() => { void pickDocument(); }}
                  accessibilityRole="button"
                  accessibilityLabel="Choose a PDF file"
                >
                  <View style={c.sheetIconCircle}>
                    <FileText size={18} color={colors.primary} />
                  </View>
                  <Text style={c.sheetOptionText}>Choose file (PDF)</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={c.sheetCancel}
                  onPress={() => setAttachmentSheetOpen(false)}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel"
                >
                  <Text style={c.sheetCancelText}>Cancel</Text>
                </TouchableOpacity>
              </Pressable>
            </Pressable>
          </Modal>
        </View>
      </KeyboardAvoidingView>
    </>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const memberRecBannerStyles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#FEF3C7',
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: '#FCD34D',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#DC2626',
  },
  text: {
    flex: 1,
    fontSize: 13,
    color: '#78350F',
    fontWeight: '500',
  },
});

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
    gap: 10,
    flex: 1,
    // Cap so the header names don't push the action buttons off-screen on
    // devices with a long member or CHW display name.
    maxWidth: '60%',
  },
  headerNameBlock: {
    flex: 1,
    gap: 1,
  },
  headerName: {
    ...typography.bodyMd,
    fontWeight: '700',
    color: colors.foreground,
  },
  headerSubtitle: {
    fontSize: 11,
    color: colors.mutedForeground,
    fontWeight: '500',
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  // Kept for reference — was the old plain-text header label. No longer rendered
  // (replaced by avatar + name in Change 3). Retained so any stale StyleSheet
  // references don't produce a missing-key error at runtime.
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
  /** Active/selected state — used by the confidence toggle when filter is ON. */
  iconButtonActive: {
    backgroundColor: `${colors.primary}18`,
    borderColor: `${colors.primary}60`,
  },
  /**
   * Sage-green active state for the member-side mic toggle when capture is ON.
   * Uses compassSage rather than primary so the member's mic button reads
   * distinctly from the CHW's primary-green mic button at a glance.
   */
  iconButtonMicActive: {
    backgroundColor: `${colors.compassSage}22`,
    borderColor: `${colors.compassSage}60`,
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
    // paddingTop/paddingBottom bumped from 10 → 12 to match the taller minHeight.
    // The paperclip and send buttons remain 44×44 (flexShrink:0) — only the
    // text input grows, which is intentional (composer height fix, 2026-05-06).
    paddingTop: 16,
    paddingBottom: 16,
    ...typography.bodyMd,
    color: colors.foreground,
    maxHeight: 180,     // ~6 lines (was 140)
    minHeight: 72,      // chunky comfortable composer (was 56)
  },
  sendButton: {
    width: 56,
    height: 56,
    borderRadius: 14,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  sendButtonDisabled: { opacity: 0.35 },

  // ── Attach button (paperclip) ────────────────────────────────────────────────
  attachButton: {
    width: 56,
    height: 56,
    borderRadius: 16,
    backgroundColor: `${colors.primary}10`,
    borderWidth: 1,
    borderColor: `${colors.primary}30`,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },

  // ── Pending-attachment chip ──────────────────────────────────────────────────
  attachmentChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: `${colors.primary}08`,
    borderWidth: 1,
    borderColor: `${colors.primary}30`,
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 6,
    marginBottom: 8,
  },
  attachmentChipThumb: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: colors.muted,
  },
  attachmentChipFileIcon: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: `${colors.primary}18`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachmentChipInfo: { flex: 1, gap: 1 },
  attachmentChipName: {
    ...typography.bodySm,
    fontWeight: '700',
    color: colors.foreground,
  },
  attachmentChipMeta: {
    fontSize: 11,
    color: colors.mutedForeground,
  },
  attachmentChipRemove: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // ── Attachment action sheet ─────────────────────────────────────────────────
  sheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  sheetCard: {
    backgroundColor: colors.card,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: Platform.OS === 'ios' ? 32 : 24,
    gap: 8,
  },
  sheetTitle: {
    ...typography.bodyMd,
    fontWeight: '700',
    color: colors.foreground,
    marginBottom: 8,
  },
  sheetOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 12,
  },
  sheetIconCircle: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: `${colors.primary}12`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetOptionText: {
    ...typography.bodyMd,
    color: colors.foreground,
    fontWeight: '600',
  },
  sheetCancel: {
    marginTop: 8,
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  sheetCancelText: {
    ...typography.bodyMd,
    color: colors.mutedForeground,
    fontWeight: '600',
  },

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

/**
 * Styles for the "Captions active" indicator shown in the header during phone
 * sessions.  Replaces the mic button — the CHW's device mic is not used for
 * phone sessions, so no interactive button is appropriate.  The green dot
 * mirrors the brand convention for "live" states and is distinct from the red
 * recording dot used for in-person mic capture.
 */
const captionsActiveStyles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 10,
    backgroundColor: `${colors.compassSage}14`,
    borderWidth: 1,
    borderColor: `${colors.compassSage}40`,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: colors.compassSage,
  },
  label: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.compassSage,
  },
});

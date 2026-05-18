/**
 * CHWMessagesScreen — 3-pane SMS inbox for Community Health Workers.
 *
 * Layout (web, ≥1280px):
 *   [Thread list 320px] | [Conversation pane flex] | [Member context rail 288px]
 *
 * Responsive collapse:
 *   <1280px  → right rail hidden; thread list + conversation both visible
 *   <900px   → only conversation visible (back button reveals thread list)
 *
 * Data wiring:
 *   - Thread list: useSessions() — each session = one thread (member + CHW).
 *   - Messages: useSessionMessages(sessionId) — polls every 4s.
 *   - Send: useSessionSendMessage() mutation.
 *
 * Only rendered on web. Native falls through to the existing CHWSessionsScreen
 * (which the navigator still registers as "Sessions" in the stack for native).
 *
 * Hard constraints:
 *   - Do NOT modify DashboardSidebar.
 *   - Do NOT add new backend endpoints.
 *   - Do NOT claim TLS+at-rest is E2E encryption.
 */

import React, {
  useState,
  useCallback,
  useMemo,
  useRef,
  useEffect,
} from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Platform,
  Alert,
  ActivityIndicator,
  useWindowDimensions,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import {
  Search,
  Phone,
  CalendarPlus,
  Paperclip,
  Link as LinkIcon,
  Send,
  Sparkles,
  List,
  NotebookPen,
  Flag,
  Home,
  Utensils,
  Car,
  ArrowLeft,
  AlertCircle,
  GripVertical,
  CheckCircle,
  Clock,
  FileText,
  Pin as PinIcon,
  Archive as ArchiveIcon,
} from 'lucide-react-native';
import { useNavigation } from '@react-navigation/native';
import { OpenQuestionsDrawer } from '../../components/chw/OpenQuestionsDrawer';

import { AppShell, Card, Pill } from '../../components/ui';
import { useAuth } from '../../context/AuthContext';
import {
  useSessions,
  useSessionMessages,
  useSessionSendMessage,
  useStartCall,
  useCreateConsentRequest,
  useConsentRequestStatus,
  useGenerateAISummary,
  useSubmitDocumentation,
  useToggleSessionPin,
  useToggleSessionArchive,
  useDeleteSession,
  type SessionData,
  type SessionMessageLocal,
  type SessionMessageData,
  type AISummaryResponse,
} from '../../hooks/useApiQueries';
import { DocumentationModal } from '../../components/sessions/DocumentationModal';
import type { SessionDocumentation } from '../../data/mock';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';
import { PressableMember } from '../../components/shared/PressableMember';
import { SwipeableThreadRow } from '../../components/chw/SwipeableThreadRow';

// ─── Breakpoints ──────────────────────────────────────────────────────────────

const BP_HIDE_RAIL  = 1280; // right rail hidden below this
const BP_HIDE_LIST  = 900;  // thread list hidden below this (mobile-web)

// ─── Utils ────────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// ─── Quick-reply templates (presentation only) ────────────────────────────────

const QUICK_TEMPLATES = [
  { label: 'Appointment reminder',      emoji: '📅' },
  { label: 'Document upload reminder',  emoji: '📄' },
  { label: 'Resource link',             emoji: '🔗' },
  { label: 'Follow-up check-in',        emoji: '👋' },
  { label: 'Reschedule',                emoji: '⏰' },
] as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getInitials(name: string | null | undefined): string {
  if (!name) return '??';
  return name
    .split(' ')
    .slice(0, 2)
    .map((p) => p[0] ?? '')
    .join('')
    .toUpperCase();
}

function formatThreadTime(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  if (diffDays === 1) return 'Yesterday';
  return `${diffDays} days`;
}

function formatMessageTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatDateSeparator(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffDays = Math.floor(
    (now.setHours(0, 0, 0, 0) - d.setHours(0, 0, 0, 0)) / (1000 * 60 * 60 * 24),
  );
  if (diffDays === 0) return `Today · ${new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  if (diffDays === 1) return 'Yesterday';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Group messages into date buckets for day-separator rendering. */
function groupByDay(messages: SessionMessageLocal[]): Array<{ date: string; messages: SessionMessageLocal[] }> {
  const buckets: Record<string, SessionMessageLocal[]> = {};
  for (const msg of messages) {
    const key = new Date(msg.createdAt).toDateString();
    (buckets[key] ??= []).push(msg);
  }
  return Object.entries(buckets).map(([date, msgs]) => ({ date, messages: msgs }));
}

// ─── Inline toast ─────────────────────────────────────────────────────────────

interface InlineToastProps {
  message: string;
  isError: boolean;
}

/**
 * Transient feedback strip rendered below the conversation header.
 * Matches the toast component pattern from SessionChat.tsx.
 */
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
    marginBottom: 4,
    marginTop: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  success: {
    backgroundColor: '#f0fdf4',
    borderColor: '#bbf7d0',
  },
  error: {
    backgroundColor: '#fef2f2',
    borderColor: '#fecaca',
  },
  text: {
    fontSize: 13,
    fontWeight: '500',
  },
  successText: { color: '#15803d' },
  errorText: { color: '#dc2626' },
});

// ─── CalendarPlus button (navigates to Calendar tab) ──────────────────────────

/**
 * Navigates the CHW to the Calendar tab when pressed.
 * Extracted as a named component because useNavigation() must be called inside
 * a component that is a descendant of the NavigationContainer.
 */
function CalendarPlusButton(): React.JSX.Element {
  const navigation = useNavigation<any>(); // eslint-disable-line @typescript-eslint/no-explicit-any
  return (
    <TouchableOpacity
      style={styles.iconBtn}
      onPress={() => navigation.navigate('Calendar')}
      accessibilityRole="button"
      accessibilityLabel="Go to calendar"
    >
      <CalendarPlus size={20} color="#6B7280" />
    </TouchableOpacity>
  );
}

// ─── Avatar chip ──────────────────────────────────────────────────────────────

const AVATAR_COLORS = [
  '#d1fae5', '#dbeafe', '#ede9fe', '#fef3c7', '#ffe4e6',
  '#cffafe', '#e0e7ff', '#ffedd5',
];
const AVATAR_TEXT_COLORS = [
  '#047857', '#1d4ed8', '#6d28d9', '#b45309', '#be123c',
  '#0891b2', '#4338ca', '#c2410c',
];

function avatarColor(name: string): { bg: string; text: string } {
  const idx = name.charCodeAt(0) % AVATAR_COLORS.length;
  return { bg: AVATAR_COLORS[idx] ?? '#d1fae5', text: AVATAR_TEXT_COLORS[idx] ?? '#047857' };
}

// ─── Thread row ───────────────────────────────────────────────────────────────

interface ThreadRowProps {
  session: SessionData;
  isActive: boolean;
  lastMessage: SessionMessageData | null;
  unread: boolean;
  /** When true, renders a small pin icon next to the timestamp so the CHW
   *  sees which threads they've pinned even when scrolled into the unpinned
   *  region. Doesn't change layout — the icon takes the trailing-edge slot. */
  isPinned?: boolean;
  onSelect: (session: SessionData) => void;
}

function ThreadRow({
  session,
  isActive,
  lastMessage,
  unread,
  isPinned = false,
  onSelect,
}: ThreadRowProps): React.JSX.Element {
  const name = session.memberName ?? 'Unknown Member';
  const initials = getInitials(name);
  const { bg, text } = avatarColor(name);
  const preview = lastMessage?.body ?? session.notes ?? 'No messages yet';
  const ts = formatThreadTime(lastMessage?.createdAt ?? session.scheduledAt);

  // Note: onPress is intentionally a no-op when the parent SwipeableThreadRow
  // intercepts the tap. We keep the prop for the legacy non-swipeable callers
  // (none today, but the type contract pre-dates the swipe wrapper).
  return (
    <TouchableOpacity
      onPress={() => onSelect(session)}
      style={[styles.threadRow, isActive && styles.threadRowActive]}
      accessibilityRole="button"
      accessibilityLabel={`Thread with ${name}${unread ? ', unread' : ''}${isPinned ? ', pinned' : ''}`}
      accessibilityState={{ selected: isActive }}
    >
      <View style={[styles.avatar40, { backgroundColor: bg }]}>
        <Text style={[styles.avatarText40, { color: text }]}>{initials}</Text>
      </View>
      <View style={styles.threadInfo}>
        <View style={styles.threadTopRow}>
          <Text style={styles.threadName} numberOfLines={1}>{name}</Text>
          <View style={styles.threadTimeWrap}>
            {isPinned ? (
              <PinIcon size={10} color="#F59E0B" style={styles.threadPinIcon} />
            ) : null}
            <Text style={styles.threadTime}>{ts}</Text>
          </View>
        </View>
        <Text style={styles.threadPreview} numberOfLines={1}>{preview}</Text>
      </View>
      {unread ? <View style={styles.unreadDot} /> : null}
    </TouchableOpacity>
  );
}

// ─── Message bubble ───────────────────────────────────────────────────────────

interface BubbleProps {
  message: SessionMessageLocal;
  isMe: boolean;
}

function MessageBubble({ message, isMe }: BubbleProps): React.JSX.Element {
  return (
    <View style={isMe ? styles.bubbleRowMe : styles.bubbleRowThem}>
      <View style={[styles.bubble, isMe ? styles.bubbleMe : styles.bubbleThem]}>
        {message.attachment ? (
          <View style={styles.attachmentRow}>
            <Paperclip size={14} color={isMe ? '#fff' : '#374151'} />
            <Text style={[styles.bubbleText, isMe ? styles.bubbleTextMe : styles.bubbleTextThem]}>
              {message.attachment.filename}
            </Text>
          </View>
        ) : (
          <Text style={[styles.bubbleText, isMe ? styles.bubbleTextMe : styles.bubbleTextThem]}>
            {message.body}
          </Text>
        )}
        <Text style={[styles.bubbleTime, isMe ? styles.bubbleTimeMe : styles.bubbleTimeThem]}>
          {formatMessageTime(message.createdAt)}
          {message.status === 'sending' ? ' · Sending…' : ''}
          {message.status === 'failed' ? ' · Failed' : ''}
        </Text>
      </View>
    </View>
  );
}

// ─── Conversation pane ────────────────────────────────────────────────────────

interface ConversationPaneProps {
  session: SessionData;
  onBack?: () => void;
  showBackButton: boolean;
}

function ConversationPane({
  session,
  onBack,
  showBackButton,
}: ConversationPaneProps): React.JSX.Element {
  const [draftText, setDraftText] = useState('');
  const [localMessages, setLocalMessages] = useState<SessionMessageLocal[]>([]);
  const [callInitiating, setCallInitiating] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [toastIsError, setToastIsError] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  const messagesQuery = useSessionMessages(session.id);
  const sendMessage = useSessionSendMessage();
  const startCall = useStartCall();

  // ── Toast helper ──────────────────────────────────────────────────────────────
  const showToast = useCallback((message: string, isError: boolean) => {
    setToastMessage(message);
    setToastIsError(isError);
    const timer = setTimeout(() => setToastMessage(null), 3_500);
    return () => clearTimeout(timer);
  }, []);

  // ── Call handler (mirrors SessionChat.handleCall) ─────────────────────────────
  /**
   * Initiates a Vonage masked-number call between CHW and member.
   * Shows a confirmation alert first, then optimistically disables the button
   * while the POST is in flight. On success, both phones ring via Vonage.
   */
  const handleCall = useCallback(async () => {
    if (callInitiating) return;
    const memberName = session.memberName ?? 'this member';

    const doCall = async (): Promise<void> => {
      setCallInitiating(true);
      try {
        await startCall.mutateAsync(session.id);
        // Honest wording — Vonage accepted the call, but the member still
        // has to answer + press 1 on the consent IVR before audio bridges.
        // Failure of either step bubbles up through other webhooks, not this
        // mutation. Toast says "call requested" rather than promising both
        // phones will ring.
        showToast('Call requested — your phone should ring shortly.', false);
      } catch (err) {
        const detail =
          err instanceof Error && err.message
            ? err.message
            : 'Could not start the call. Try again.';
        showToast(detail, true);
      } finally {
        setCallInitiating(false);
      }
    };

    // Web uses window.confirm; native uses Alert.alert (no multi-button on web)
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      const ok = window.confirm(`Start masked call with ${memberName}?`);
      if (ok) void doCall();
    } else {
      Alert.alert(
        'Start call?',
        `Start a masked call with ${memberName}? Both phones will ring.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Call', onPress: () => void doCall() },
        ],
      );
    }
  }, [callInitiating, session.id, session.memberName, startCall, showToast]);

  const memberName = session.memberName ?? 'Unknown Member';
  const initials = getInitials(memberName);
  const { bg, text } = avatarColor(memberName);

  // Merge server messages with local optimistic messages
  const mergedMessages = useMemo<SessionMessageLocal[]>(() => {
    const server: SessionMessageLocal[] = (messagesQuery.data ?? []).map((m) => ({ ...m }));
    // Keep only locally-optimistic messages not yet confirmed by server
    const serverIds = new Set(server.map((m) => m.id));
    const pendingLocal = localMessages.filter((m) => !serverIds.has(m.id));
    return [...server, ...pendingLocal].sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
    );
  }, [messagesQuery.data, localMessages]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
  }, [mergedMessages.length]);

  const handleSend = useCallback(async () => {
    const trimmed = draftText.trim();
    if (!trimmed) return;

    // Optimistic message
    const optimisticId = `local-${Date.now()}`;
    const optimistic: SessionMessageLocal = {
      id: optimisticId,
      senderUserId: '',
      senderRole: 'chw',
      body: trimmed,
      type: 'text',
      createdAt: new Date().toISOString(),
      status: 'sending',
    };
    setLocalMessages((prev) => [...prev, optimistic]);
    setDraftText('');

    try {
      await sendMessage.mutateAsync({ sessionId: session.id, body: trimmed });
      // On success, server messages will replace the optimistic one via query invalidation
      setLocalMessages((prev) => prev.filter((m) => m.id !== optimisticId));
    } catch {
      setLocalMessages((prev) =>
        prev.map((m) => (m.id === optimisticId ? { ...m, status: 'failed' as const } : m)),
      );
    }
  }, [draftText, session.id, sendMessage]);

  const handleTemplatePress = useCallback((label: string) => {
    setDraftText((prev) => (prev ? `${prev} ${label}` : label));
  }, []);

  const grouped = groupByDay(mergedMessages);

  return (
    <View style={styles.convPane} accessibilityRole="main">
      {/* Header */}
      <View style={styles.convHeader}>
        {showBackButton && onBack ? (
          <TouchableOpacity
            onPress={onBack}
            style={styles.backButton}
            accessibilityRole="button"
            accessibilityLabel="Back to thread list"
          >
            <ArrowLeft size={20} color="#374151" />
          </TouchableOpacity>
        ) : null}
        <PressableMember
          memberId={session.memberId ?? ''}
          displayName={memberName}
          enabled={!!session.memberId}
        >
          <View style={[styles.avatar44, { backgroundColor: bg }]}>
            <Text style={[styles.avatarText44, { color: text }]}>{initials}</Text>
          </View>
        </PressableMember>
        <PressableMember
          memberId={session.memberId ?? ''}
          displayName={memberName}
          enabled={!!session.memberId}
          style={styles.convHeaderInfo}
        >
          <View style={styles.convHeaderNameRow}>
            <Text style={styles.convHeaderName}>{memberName}</Text>
            <Pill variant="emerald" size="sm">Highly Engaged</Pill>
          </View>
          <Text style={styles.convHeaderMeta}>
            {session.mode ? `${session.mode.replace('_', ' ')} · ` : ''}Active Member
          </Text>
        </PressableMember>
        {/* Phone button — initiates Vonage masked-number call */}
        <TouchableOpacity
          style={[styles.iconBtn, callInitiating && styles.iconBtnDisabled]}
          onPress={() => void handleCall()}
          disabled={callInitiating}
          accessibilityRole="button"
          accessibilityLabel={callInitiating ? 'Call initiating…' : 'Call member'}
          accessibilityState={{ disabled: callInitiating }}
        >
          {callInitiating ? (
            <ActivityIndicator size="small" color="#6B7280" />
          ) : (
            <Phone size={20} color="#6B7280" />
          )}
        </TouchableOpacity>

        {/* CalendarPlus button — navigate to the CHW Calendar tab */}
        <CalendarPlusButton />

        <PressableMember
          memberId={session.memberId ?? ''}
          displayName={memberName}
          enabled={!!session.memberId}
          style={styles.openProfileBtn}
        >
          <Text style={styles.openProfileText}>Open Profile →</Text>
        </PressableMember>
      </View>

      {/* Inline toast — success/error feedback for call + consent actions */}
      {toastMessage !== null ? (
        <InlineToast message={toastMessage} isError={toastIsError} />
      ) : null}

      {/* Messages thread */}
      <ScrollView
        ref={scrollRef}
        style={styles.messagesScroll}
        contentContainerStyle={styles.messagesContent}
        showsVerticalScrollIndicator={false}
        accessibilityRole="list"
        accessibilityLabel="Message thread"
      >
        {messagesQuery.isLoading ? (
          <LoadingSkeleton variant="rows" rows={4} />
        ) : messagesQuery.error ? (
          <ErrorState
            message="Could not load messages."
            onRetry={() => void messagesQuery.refetch()}
          />
        ) : grouped.length === 0 ? (
          <View style={styles.emptyMessages}>
            <Text style={styles.emptyMessagesText}>No messages yet. Say hello!</Text>
          </View>
        ) : (
          grouped.map(({ date, messages: dayMsgs }) => (
            <View key={date}>
              <View style={styles.dateSeparatorRow}>
                <Text style={styles.dateSeparatorText}>
                  {formatDateSeparator(dayMsgs[0]?.createdAt ?? date)}
                </Text>
              </View>
              {dayMsgs.map((msg) => (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  isMe={msg.senderRole === 'chw'}
                />
              ))}
            </View>
          ))
        )}
      </ScrollView>

      {/* Quick templates */}
      <View style={styles.templatesBar} accessibilityRole="toolbar" accessibilityLabel="Quick reply templates">
        <Text style={styles.templatesLabel}>Templates:</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.templatesScroll}>
          {QUICK_TEMPLATES.map(({ label, emoji }) => (
            <TouchableOpacity
              key={label}
              style={styles.templateChip}
              onPress={() => handleTemplatePress(label)}
              accessibilityRole="button"
              accessibilityLabel={`Insert template: ${label}`}
            >
              <Text style={styles.templateChipText}>{emoji} {label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* Composer */}
      <View style={styles.composerWrap}>
        <View style={styles.composerInner}>
          <TouchableOpacity
            style={styles.composerIconBtn}
            accessibilityRole="button"
            accessibilityLabel="Attach file"
          >
            <Paperclip size={20} color="#6B7280" />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.composerIconBtn}
            accessibilityRole="button"
            accessibilityLabel="Insert link"
          >
            <LinkIcon size={20} color="#6B7280" />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.composerIconBtn}
            accessibilityRole="button"
            accessibilityLabel="Schedule appointment"
          >
            <CalendarPlus size={20} color="#6B7280" />
          </TouchableOpacity>
          <TextInput
            style={styles.composerInput}
            value={draftText}
            onChangeText={setDraftText}
            placeholder={`Reply to ${memberName}…`}
            placeholderTextColor="#9CA3AF"
            multiline
            numberOfLines={2}
            accessibilityLabel="Message input"
            onSubmitEditing={() => void handleSend()}
          />
          <TouchableOpacity
            style={[styles.sendBtn, !draftText.trim() && styles.sendBtnDisabled]}
            onPress={() => void handleSend()}
            disabled={!draftText.trim() || sendMessage.isPending}
            accessibilityRole="button"
            accessibilityLabel="Send message"
          >
            <Send size={16} color="#fff" />
            <Text style={styles.sendBtnText}>Send</Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.composerMeta}>
          📱 SMS via Vonage masked number
        </Text>
      </View>
    </View>
  );
}

// ─── Right context rail ───────────────────────────────────────────────────────

interface ContextRailProps {
  session: SessionData;
  onOpenSuggestedQuestions: () => void;
}

/**
 * ConsentGateState — local to the ContextRail for the consent request flow.
 *
 *   idle              → button ready to press
 *   requesting        → POST in flight
 *   waiting_for_member → polling for member response
 *   approved          → member approved; show success pill
 *   denied            → member denied
 *   error             → network/server failure
 */
type ConsentGateState =
  | 'idle'
  | 'requesting'
  | 'waiting_for_member'
  | 'approved'
  | 'denied'
  | 'error';

function ContextRail({ session, onOpenSuggestedQuestions }: ContextRailProps): React.JSX.Element {
  // ── Consent request state ────────────────────────────────────────────────────
  const [consentGate, setConsentGate] = useState<ConsentGateState>('idle');
  const [activeConsentRequestId, setActiveConsentRequestId] = useState<string | null>(null);

  // ── AI summary state ─────────────────────────────────────────────────────────
  const [aiSummary, setAiSummary] = useState<AISummaryResponse | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  // ── End-session / documentation state ────────────────────────────────────────
  // When set, opens the DocumentationModal for this session so the CHW can
  // review notes, edit the AI summary, pick diagnosis + procedure codes, and
  // submit for billing. Mirrors the pattern in CHWSessionsScreen.
  const [documentingSessionId, setDocumentingSessionId] = useState<string | null>(null);

  const navigation = useNavigation<any>(); // eslint-disable-line @typescript-eslint/no-explicit-any

  const createConsentRequest = useCreateConsentRequest(session.id);
  const generateAISummary = useGenerateAISummary();
  const submitDocumentation = useSubmitDocumentation();

  // ── Poll for consent status while waiting for member response ────────────────
  const consentStatusQuery = useConsentRequestStatus(
    activeConsentRequestId ?? '',
    {
      enabled:
        activeConsentRequestId !== null &&
        consentGate === 'waiting_for_member',
    },
  );

  // React to status changes from the polling query
  useEffect(() => {
    const status = consentStatusQuery.data?.status;
    if (status === undefined) return;
    if (status === 'approved' && consentGate === 'waiting_for_member') {
      setConsentGate('approved');
    } else if (status === 'denied' && consentGate === 'waiting_for_member') {
      setConsentGate('denied');
    } else if (status === 'expired' && consentGate === 'waiting_for_member') {
      setConsentGate('error');
    }
  }, [consentStatusQuery.data?.status, consentGate]);

  // ── Consent request handler ──────────────────────────────────────────────────
  /**
   * Fires POST /sessions/{id}/consent-requests with type 'ai_transcription'.
   * Transitions gate to 'waiting_for_member' on success; 'error' on failure.
   */
  const handleRequestConsent = useCallback(async () => {
    if (consentGate !== 'idle') return;
    setConsentGate('requesting');
    try {
      const result = await createConsentRequest.mutateAsync('ai_transcription');
      setActiveConsentRequestId(result.id);
      setConsentGate('waiting_for_member');
    } catch {
      setConsentGate('error');
    }
  }, [consentGate, createConsentRequest]);

  // ── AI summary handler ────────────────────────────────────────────────────────
  /**
   * Fires POST /sessions/{id}/ai-summary. Enabled when the session has an
   * ended_at or at least one message. Stores the result inline for preview.
   */
  const handleGenerateSummary = useCallback(async () => {
    setSummaryError(null);
    try {
      const result = await generateAISummary.mutateAsync(session.id);
      setAiSummary(result);
    } catch (err) {
      const detail =
        err instanceof Error && err.message
          ? err.message
          : 'Could not generate summary. Try again.';
      setSummaryError(detail);
    }
  }, [generateAISummary, session.id]);

  // Summary becomes available the moment the session enters in_progress
  // — i.e. as soon as a CHW starts a call — so a CHW who hangs up and
  // wants to review the AI summary BEFORE clicking End Session sees the
  // button enabled.  Previously the gate required session.endedAt or
  // status='completed', but those flip only AFTER the CHW submits
  // documentation, which means the button was greyed exactly when the
  // CHW wanted to use it.  The backend gracefully returns an empty
  // summary if no transcript has landed yet — the auto-poll below
  // handles that case by retrying for 2 min.
  const summaryEnabled =
    session.endedAt != null
    || session.status === 'completed'
    || session.status === 'in_progress';

  // ── Auto-trigger AI summary after the call ends ──────────────────────────
  // Once the session has ended, we poll the summary endpoint up to 8 times
  // (every 15s ≈ 2 min total) so the CHW sees the summary appear inline in
  // the rail without having to click "Generate AI Summary".  The backend
  // returns ai_summary="" while the post-call AssemblyAI transcription
  // hasn't finished yet — that empty response is our "retry later" signal,
  // not an error.  After the budget is exhausted we stop and fall back to
  // the manual button so the CHW can re-trigger if AssemblyAI was slow.
  const autoPollAttempts = useRef(0);
  const [autoPollExhausted, setAutoPollExhausted] = useState(false);
  const MAX_AUTO_POLL_ATTEMPTS = 8;
  const POLL_DELAY_MS = 15_000;

  useEffect(() => {
    // Skip when:
    //   - the session hasn't ended yet (nothing to summarise)
    //   - we already have a non-empty summary (job done)
    //   - the polling budget is spent (don't keep hammering)
    //   - the mutation is mid-flight (avoid stacking concurrent calls)
    if (
      !summaryEnabled
      || (aiSummary && aiSummary.ai_summary)
      || autoPollExhausted
      || generateAISummary.isPending
    ) {
      return;
    }
    const delay = autoPollAttempts.current === 0 ? 5_000 : POLL_DELAY_MS;
    const timer = setTimeout(async () => {
      try {
        const result = await generateAISummary.mutateAsync(session.id);
        if (result.ai_summary && result.ai_summary.length > 0) {
          // Real summary arrived — show it and stop polling.
          setAiSummary(result);
          setAutoPollExhausted(true);
          return;
        }
      } catch {
        // Backend errors are treated as a transient — same retry budget
        // governs them.  The existing manual button surfaces the error
        // text if the CHW chooses to retry after exhaustion.
      }
      // No usable summary yet — schedule next attempt up to the budget.
      autoPollAttempts.current += 1;
      if (autoPollAttempts.current >= MAX_AUTO_POLL_ATTEMPTS) {
        setAutoPollExhausted(true);
      } else {
        // Re-render to trigger the next effect run.  We bump a state flag
        // through aiSummary intentionally left null so the gate above
        // doesn't short-circuit; the dep on generateAISummary.isPending
        // flipping back to false drives the next cycle.
      }
    }, delay);
    return () => clearTimeout(timer);
  }, [
    summaryEnabled,
    aiSummary,
    autoPollExhausted,
    generateAISummary,
    session.id,
  ]);

  // ── End Session / documentation submit handler ───────────────────────────────
  /**
   * Opens the DocumentationModal so the CHW can finalize the session: review
   * notes, edit the AI summary, pick diagnosis + procedure codes, then submit.
   * Submitting fires POST /api/v1/sessions/{id}/documentation which triggers
   * the Pear claim chain (member sync → schedule activity → complete with
   * costId → generate claim).
   */
  const handleOpenEndSession = useCallback(() => {
    setDocumentingSessionId(session.id);
  }, [session.id]);

  const handleDocumentationSubmit = useCallback(
    async (data: SessionDocumentation): Promise<void> => {
      if (documentingSessionId == null) return;
      try {
        await submitDocumentation.mutateAsync({
          sessionId: documentingSessionId,
          data: data as unknown as Record<string, unknown>,
        });
        setDocumentingSessionId(null);
      } catch (err) {
        const reason =
          err instanceof Error && err.message ? err.message : 'Unknown error';
        // Keep modal open so the CHW can fix and retry. Surface the error.
        // eslint-disable-next-line no-console
        console.error('[CHWMessages] submitDocumentation failed:', err);
        if (Platform.OS === 'web' && typeof window !== 'undefined') {
          window.alert(`Failed to submit documentation\n\n${reason}\n\nThe modal will stay open so you can adjust and try again.`);
        } else {
          Alert.alert('Failed to submit documentation', reason);
        }
      }
    },
    [documentingSessionId, submitDocumentation],
  );

  return (
    <ScrollView
      style={styles.contextRailOuter}
      contentContainerStyle={styles.contextRail}
      showsVerticalScrollIndicator={false}
      accessibilityRole="complementary"
      accessibilityLabel="Member context"
    >
      <Text style={styles.railSectionLabel}>Member context</Text>

      {/* Active Journey */}
      <Card style={styles.railCard}>
        <Text style={styles.railCardMeta}>Active Journey</Text>
        <Text style={styles.railCardTitle}>
          {session.vertical?.replace('_', ' ') ?? 'General'} · 60%
        </Text>
        <View style={styles.progressBar} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: 60 }}>
          <View style={[styles.progressFill, { width: '60%' }]} />
        </View>
        <View style={styles.railWarningRow}>
          <AlertCircle size={12} color="#92400E" />
          <Text style={styles.railWarningText}>Current step: Upload Documents (due in 2 days)</Text>
        </View>
      </Card>

      {/* Top Resource Needs */}
      <Card style={styles.railCard}>
        <Text style={styles.railSubLabel}>Top Resource Needs</Text>
        <View style={styles.needsRows}>
          <NeedRow icon={<Home size={14} color="#EF4444" />} label="Housing" level="High" levelVariant="red" />
          <NeedRow icon={<Utensils size={14} color="#F97316" />} label="Food Assistance" level="High" levelVariant="red" />
          <NeedRow icon={<Car size={14} color="#F59E0B" />} label="Transportation" level="Med" levelVariant="amber" />
        </View>
      </Card>

      {/* Compass Insight */}
      <Card style={[styles.railCard, styles.insightCard]}>
        <View style={styles.insightHeader}>
          <Sparkles size={14} color="#16a34a" />
          <Text style={styles.insightTitle}>Compass Insight</Text>
        </View>
        <Text style={styles.insightText}>
          This member typically responds within 30 minutes between 4–7 PM. Consider sending the resource link this evening.
        </Text>
      </Card>

      {/* Quick Actions */}
      <View>
        <Text style={styles.railSectionLabel}>Quick Actions</Text>

        {/* Existing: Open Suggested Questions */}
        <QuickActionBtn
          icon={<List size={16} color="#6B7280" />}
          label="Open Suggested Questions"
          onPress={onOpenSuggestedQuestions}
        />
        <QuickActionBtn
          icon={<NotebookPen size={16} color="#6B7280" />}
          label="Add Case Note"
        />
        <QuickActionBtn
          icon={<Flag size={16} color="#6B7280" />}
          label="Flag this Thread"
        />

        {/* New: Request Recording Consent */}
        <ConsentActionBtn
          state={consentGate}
          onPress={() => void handleRequestConsent()}
        />

        {/* New: Generate AI Summary */}
        <AISummaryActionBtn
          isPending={generateAISummary.isPending}
          isEnabled={summaryEnabled}
          summary={aiSummary}
          error={summaryError}
          onPress={() => void handleGenerateSummary()}
          onOpenFull={() =>
            navigation.navigate('SessionReview', {
              sessionId: session.id,
              memberName: session.memberName ?? 'Member',
              memberId: session.memberId,
            })
          }
        />

        {/* End Session — opens DocumentationModal for notes/AI summary review,
            diagnosis + procedure code selection, and billing submission.
            Destructive (red) styling because clicking it commits the session
            for downstream Pear claim generation. */}
        <TouchableOpacity
          style={styles.endSessionBtn}
          onPress={handleOpenEndSession}
          accessibilityRole="button"
          accessibilityLabel="End session and open documentation for review"
        >
          <FileText size={16} color="#fff" />
          <Text style={styles.endSessionBtnText}>End Session</Text>
        </TouchableOpacity>
      </View>

      {/* Documentation modal — mounted inside the rail so it owns its own
          lifecycle and we don't need to thread state up to the parent. */}
      {documentingSessionId != null && (
        <DocumentationModal
          visible={documentingSessionId != null}
          onClose={() => setDocumentingSessionId(null)}
          sessionId={documentingSessionId}
          durationMinutes={session.durationMinutes ?? null}
          onSubmit={handleDocumentationSubmit}
        />
      )}
    </ScrollView>
  );
}

// ─── Consent action button ─────────────────────────────────────────────────────

interface ConsentActionBtnProps {
  state: ConsentGateState;
  onPress: () => void;
}

/**
 * Quick action button for the CHW consent-request flow.
 * Transitions through: idle → requesting → waiting_for_member → approved | denied | error.
 */
function ConsentActionBtn({ state, onPress }: ConsentActionBtnProps): React.JSX.Element {
  if (state === 'approved') {
    return (
      <View style={styles.consentApprovedRow} accessibilityRole="status">
        <CheckCircle size={14} color="#16a34a" />
        <Text style={styles.consentApprovedText}>Consent granted</Text>
      </View>
    );
  }

  if (state === 'denied') {
    return (
      <View style={styles.consentDeniedRow} accessibilityRole="status">
        <Text style={styles.consentDeniedText}>Member declined — ask again later</Text>
      </View>
    );
  }

  if (state === 'waiting_for_member') {
    return (
      <View style={styles.consentWaitingRow} accessibilityRole="status">
        <Clock size={14} color="#9A3412" />
        <Text style={styles.consentWaitingText}>Awaiting member approval…</Text>
      </View>
    );
  }

  if (state === 'error') {
    return (
      <QuickActionBtn
        icon={<AlertCircle size={16} color="#DC2626" />}
        label="Request failed — try again"
        onPress={onPress}
      />
    );
  }

  // 'idle' or 'requesting'
  return (
    <TouchableOpacity
      style={[styles.quickActionBtn, state === 'requesting' && styles.quickActionBtnDisabled]}
      onPress={onPress}
      disabled={state === 'requesting'}
      accessibilityRole="button"
      accessibilityLabel="Request recording consent from member"
      accessibilityState={{ disabled: state === 'requesting' }}
    >
      {state === 'requesting' ? (
        <ActivityIndicator size="small" color="#6B7280" />
      ) : (
        <NotebookPen size={16} color="#6B7280" />
      )}
      <Text style={styles.quickActionText}>
        {state === 'requesting' ? 'Sending request…' : 'Request Recording Consent'}
      </Text>
    </TouchableOpacity>
  );
}

// ─── AI summary action button ──────────────────────────────────────────────────

interface AISummaryActionBtnProps {
  isPending: boolean;
  isEnabled: boolean;
  summary: AISummaryResponse | null;
  error: string | null;
  onPress: () => void;
  onOpenFull: () => void;
}

/**
 * Quick action button for generating an AI summary from the session transcript.
 * When a summary is available, shows a 200-char preview and an "Open full summary" link.
 */
function AISummaryActionBtn({
  isPending,
  isEnabled,
  summary,
  error,
  onPress,
  onOpenFull,
}: AISummaryActionBtnProps): React.JSX.Element {
  if (summary !== null && summary.ai_summary) {
    const preview = summary.ai_summary.slice(0, 200);
    const isTruncated = summary.ai_summary.length > 200;
    return (
      <View style={styles.summaryPreviewCard}>
        <View style={styles.insightHeader}>
          <Sparkles size={14} color="#16a34a" />
          <Text style={styles.insightTitle}>AI Summary</Text>
        </View>
        <Text style={styles.summaryPreviewText}>
          {preview}{isTruncated ? '…' : ''}
        </Text>
        <TouchableOpacity
          onPress={onOpenFull}
          accessibilityRole="link"
          accessibilityLabel="Open full AI summary"
        >
          <Text style={styles.summaryOpenLink}>Open full summary →</Text>
        </TouchableOpacity>
        {/* Allow regeneration */}
        <TouchableOpacity
          style={styles.summaryRegenerateBtn}
          onPress={onPress}
          disabled={isPending}
          accessibilityRole="button"
          accessibilityLabel="Regenerate AI summary"
        >
          <Text style={styles.summaryRegenerateText}>
            {isPending ? 'Regenerating…' : 'Regenerate'}
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <>
      <TouchableOpacity
        style={[
          styles.quickActionBtn,
          (!isEnabled || isPending) && styles.quickActionBtnDisabled,
        ]}
        onPress={onPress}
        disabled={!isEnabled || isPending}
        accessibilityRole="button"
        accessibilityLabel={
          !isEnabled
            ? 'Generate AI Summary — available after session ends'
            : 'Generate AI Summary'
        }
        accessibilityState={{ disabled: !isEnabled || isPending }}
      >
        {isPending ? (
          <ActivityIndicator size="small" color="#6B7280" />
        ) : (
          <Sparkles size={16} color={isEnabled ? '#6B7280' : '#D1D5DB'} />
        )}
        <Text style={[styles.quickActionText, !isEnabled && styles.quickActionTextDisabled]}>
          {isPending ? 'Generating summary…' : 'Generate AI Summary'}
        </Text>
      </TouchableOpacity>
      {!isEnabled ? (
        <Text style={styles.summaryDisabledHint}>
          Available after session ends
        </Text>
      ) : null}
      {error !== null ? (
        <Text style={styles.summaryErrorText}>{error}</Text>
      ) : null}
    </>
  );
}

interface NeedRowProps {
  icon: React.ReactNode;
  label: string;
  level: string;
  levelVariant: 'red' | 'amber' | 'emerald';
}

function NeedRow({ icon, label, level, levelVariant }: NeedRowProps): React.JSX.Element {
  return (
    <View style={styles.needRow}>
      {icon}
      <Text style={styles.needLabel}>{label}</Text>
      <View style={styles.needBadgeSpacer} />
      <Pill variant={levelVariant} size="sm">{level}</Pill>
    </View>
  );
}

interface QuickActionBtnProps {
  icon: React.ReactNode;
  label: string;
  onPress?: () => void;
}

function QuickActionBtn({ icon, label, onPress }: QuickActionBtnProps): React.JSX.Element {
  return (
    <TouchableOpacity
      style={styles.quickActionBtn}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {icon}
      <Text style={styles.quickActionText}>{label}</Text>
    </TouchableOpacity>
  );
}

// ─── Pane resize handle (web-only drag) ──────────────────────────────────────

interface ResizeHandleProps {
  /**
   * Called on mousedown with the starting clientX. Parent attaches the
   * mousemove / mouseup listeners and computes the new pane width.
   */
  onDragStart: (startX: number) => void;
  isDragging: boolean;
}

/**
 * Vertical 6-px column between two panes. On web, mouse-down begins a drag;
 * the parent screen owns the actual resize math + global event listeners so
 * the handle stays a dumb visual element. On native this just renders as
 * the same chrome (drag is web-only because there's no mouse).
 */
function ResizeHandle({ onDragStart, isDragging }: ResizeHandleProps): React.JSX.Element {
  const [hovered, setHovered] = useState(false);
  const active = hovered || isDragging;

  // RN-Web passes unknown style props through to the underlying div, so
  // `cursor` is honoured even though it's not in the RN style typings.
  const webCursorStyle =
    Platform.OS === 'web'
      ? ({ cursor: 'col-resize' } as unknown as ViewStyle)
      : undefined;

  return (
    <View
      // Web mouse events flow through View → div on RN-Web. The cast
      // bypasses the RN type system, which doesn't know about onMouseDown
      // even though the runtime accepts it.
      {...(Platform.OS === 'web'
        ? {
            onMouseDown: (e: { clientX: number; preventDefault: () => void }) => {
              e.preventDefault();
              onDragStart(e.clientX);
            },
            onMouseEnter: () => setHovered(true),
            onMouseLeave: () => setHovered(false),
          }
        : {})}
      style={[
        styles.resizeHandle,
        active && styles.resizeHandleActive,
        webCursorStyle,
      ]}
      accessibilityRole="button"
      accessibilityLabel="Drag to resize pane"
    >
      <View style={styles.resizeHandleGrip}>
        <GripVertical
          size={14}
          color={active ? '#374151' : '#9CA3AF'}
        />
      </View>
    </View>
  );
}

// ─── Pane width constraints ──────────────────────────────────────────────────

const THREAD_LIST_DEFAULT = 320;
const THREAD_LIST_MIN     = 240;
const THREAD_LIST_MAX     = 480;

const CONTEXT_RAIL_DEFAULT = 288;
const CONTEXT_RAIL_MIN     = 240;
const CONTEXT_RAIL_MAX     = 420;

// ─── Screen ───────────────────────────────────────────────────────────────────

/**
 * CHWMessagesScreen — 3-pane messaging inbox.
 * Rendered as the root of the SessionsStack on web; the navigator continues to
 * expose CHWSessionsScreen for individual session detail flows.
 *
 * Pane resizing (web only): the thread list and context rail can be dragged
 * via the GripVertical handle on each border. Widths are clamped to the
 * MIN / MAX constants above. The conversation pane fills whatever's left.
 */
export function CHWMessagesScreen(): React.JSX.Element {
  const { userName } = useAuth();
  const { width } = useWindowDimensions();

  // Inbox-archive filter toggle. Default: hide archived. The CHW flips this
  // in the header to reveal archived threads inline alongside active ones.
  const [showArchived, setShowArchived] = useState(false);
  const sessionsQuery = useSessions({ includeArchived: showArchived });

  // Swipe-action mutations. Each invalidates the sessions cache on success
  // so the row visually moves (pin → top) or disappears (archive/delete).
  const toggleSessionPin = useToggleSessionPin();
  const toggleSessionArchive = useToggleSessionArchive();
  const deleteSession = useDeleteSession();

  const [selectedSession, setSelectedSession] = useState<SessionData | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterTab, setFilterTab] = useState<'all' | 'unread' | 'flagged'>('all');
  // On narrow viewports the thread list can be toggled
  const [showThreadList, setShowThreadList] = useState(true);
  // Open Questions drawer — only shown when a member thread is active
  const [questionsDrawerOpen, setQuestionsDrawerOpen] = useState(false);

  // ── Pane widths (web-only resize) ─────────────────────────────────────────
  const [threadListWidth, setThreadListWidth] = useState(THREAD_LIST_DEFAULT);
  const [contextRailWidth, setContextRailWidth] = useState(CONTEXT_RAIL_DEFAULT);
  // Which handle is being dragged. Drives global mousemove/mouseup wiring.
  const [draggingHandle, setDraggingHandle] = useState<'list' | 'rail' | null>(null);
  // The clientX where drag began + the pane width at that moment. Closed-over
  // by the mousemove handler so we apply absolute deltas (avoids drift from
  // accumulating per-frame deltas).
  const dragStartXRef = useRef(0);
  const dragStartWidthRef = useRef(0);

  // Attach global pointer listeners only while a drag is active. Detach on
  // mouseup so we don't keep a hot mousemove handler running idle.
  useEffect(() => {
    if (draggingHandle === null || Platform.OS !== 'web') return;

    const doc = (globalThis as { document?: Document }).document;
    if (doc === undefined) return;

    const handleMove = (e: MouseEvent): void => {
      const delta = e.clientX - dragStartXRef.current;
      if (draggingHandle === 'list') {
        const next = clamp(
          dragStartWidthRef.current + delta,
          THREAD_LIST_MIN,
          THREAD_LIST_MAX,
        );
        setThreadListWidth(next);
      } else {
        // Rail handle: dragging right shrinks the rail, dragging left grows it.
        const next = clamp(
          dragStartWidthRef.current - delta,
          CONTEXT_RAIL_MIN,
          CONTEXT_RAIL_MAX,
        );
        setContextRailWidth(next);
      }
    };
    const handleUp = (): void => setDraggingHandle(null);

    doc.addEventListener('mousemove', handleMove);
    doc.addEventListener('mouseup', handleUp);
    return () => {
      doc.removeEventListener('mousemove', handleMove);
      doc.removeEventListener('mouseup', handleUp);
    };
  }, [draggingHandle]);

  const handleListDragStart = useCallback((startX: number) => {
    dragStartXRef.current = startX;
    dragStartWidthRef.current = threadListWidth;
    setDraggingHandle('list');
  }, [threadListWidth]);

  const handleRailDragStart = useCallback((startX: number) => {
    dragStartXRef.current = startX;
    dragStartWidthRef.current = contextRailWidth;
    setDraggingHandle('rail');
  }, [contextRailWidth]);

  const hideRail = width < BP_HIDE_RAIL;
  const hideList = width < BP_HIDE_LIST;

  const memberInitials = (userName ?? 'CHW')
    .split(' ')
    .slice(0, 2)
    .map((p) => p[0] ?? '')
    .join('')
    .toUpperCase();

  const shellUserBlock = {
    initials: memberInitials,
    name: userName ?? 'CHW',
    role: 'CHW' as const,
  };

  // All sessions for the CHW — each session is a "thread" with a member
  const allSessions: SessionData[] = sessionsQuery.data ?? [];

  // Filter to sessions that have a member (i.e., have messages to show)
  const filteredSessions = useMemo(() => {
    let list = allSessions.filter((s) => s.memberName);
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter((s) => (s.memberName ?? '').toLowerCase().includes(q));
    }
    // For now unread/flagged are presentation-only (no backend field); all sessions show
    return list;
  }, [allSessions, searchQuery]);

  // Auto-select first thread when list loads (desktop behaviour)
  useEffect(() => {
    if (filteredSessions.length > 0 && !selectedSession) {
      setSelectedSession(filteredSessions[0] ?? null);
    }
  }, [filteredSessions, selectedSession]);

  const handleSelectSession = useCallback((session: SessionData) => {
    setSelectedSession(session);
    // Close the questions drawer when switching threads — context has changed.
    setQuestionsDrawerOpen(false);
    // On narrow viewport, switch to conversation view
    if (hideList) {
      setShowThreadList(false);
    }
  }, [hideList]);

  const handleBack = useCallback(() => {
    setShowThreadList(true);
  }, []);

  if (sessionsQuery.isLoading) {
    return (
      <AppShell role="chw" activeKey="messages" userBlock={shellUserBlock} disableMainScroll>
        <View style={styles.loadingWrap}>
          <LoadingSkeleton variant="rows" rows={6} />
        </View>
      </AppShell>
    );
  }

  if (sessionsQuery.error) {
    return (
      <AppShell role="chw" activeKey="messages" userBlock={shellUserBlock} disableMainScroll>
        <ErrorState
          message="Could not load messages. Please try again."
          onRetry={() => void sessionsQuery.refetch()}
        />
      </AppShell>
    );
  }

  const shouldShowList = !hideList || showThreadList;
  const shouldShowConv = !hideList || !showThreadList;

  return (
    <AppShell
      role="chw"
      activeKey="messages"
      userBlock={shellUserBlock}
      disableMainScroll
    >
      <View style={styles.root}>
        {/* Thread list */}
        {shouldShowList ? (
          <View
            style={[styles.threadList, { width: threadListWidth }]}
            accessibilityRole="navigation"
            accessibilityLabel="Message threads"
          >
            {/* Header */}
            <View style={styles.threadListHeader}>
              <Text style={styles.threadListTitle}>Messages</Text>
              {/* Search */}
              <View style={styles.searchWrap}>
                <View style={styles.searchIcon}>
                  <Search size={16} color="#9CA3AF" />
                </View>
                <TextInput
                  style={styles.searchInput}
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  placeholder="Search threads…"
                  placeholderTextColor="#9CA3AF"
                  accessibilityLabel="Search message threads"
                />
              </View>
              {/* Filter chips */}
              <View style={styles.filterRow}>
                {(['all', 'unread', 'flagged'] as const).map((key) => (
                  <TouchableOpacity
                    key={key}
                    style={[styles.filterChip, filterTab === key && styles.filterChipActive]}
                    onPress={() => setFilterTab(key)}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: filterTab === key }}
                    accessibilityLabel={`Filter: ${key}`}
                  >
                    <Text style={[styles.filterChipText, filterTab === key && styles.filterChipTextActive]}>
                      {key === 'all' ? `All (${filteredSessions.length})` : key.charAt(0).toUpperCase() + key.slice(1)}
                    </Text>
                  </TouchableOpacity>
                ))}
                {/* Archive toggle — flips the inbox between "active only" and
                    "active + archived". Sits beside the existing filter chips
                    so it reads as a peer filter, not a settings toggle. */}
                <TouchableOpacity
                  style={[styles.filterChip, showArchived && styles.filterChipActive]}
                  onPress={() => setShowArchived((v) => !v)}
                  accessibilityRole="switch"
                  accessibilityState={{ checked: showArchived }}
                  accessibilityLabel={showArchived ? 'Hide archived threads' : 'Show archived threads'}
                >
                  <ArchiveIcon size={12} color={showArchived ? '#fff' : '#6B7280'} />
                  <Text style={[styles.filterChipText, showArchived && styles.filterChipTextActive]}>
                    Archived
                  </Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* Thread rows */}
            <ScrollView style={styles.threadScrollView} showsVerticalScrollIndicator={false}>
              {filteredSessions.length === 0 ? (
                <View style={styles.emptyThreads}>
                  <Text style={styles.emptyThreadsText}>No threads found.</Text>
                </View>
              ) : (
                filteredSessions.map((session) => {
                  const isPinned = session.pinnedAt != null;
                  return (
                    <SwipeableThreadRow
                      key={session.id}
                      isPinned={isPinned}
                      onPress={() => handleSelectSession(session)}
                      onPin={(nextPinned) =>
                        toggleSessionPin.mutate({ sessionId: session.id, pinned: nextPinned })
                      }
                      onArchive={() =>
                        toggleSessionArchive.mutate({ sessionId: session.id, archived: true })
                      }
                      onDelete={() => deleteSession.mutate(session.id)}
                    >
                      <ThreadRow
                        session={session}
                        isActive={selectedSession?.id === session.id}
                        lastMessage={null}
                        unread={false}
                        isPinned={isPinned}
                        onSelect={handleSelectSession}
                      />
                    </SwipeableThreadRow>
                  );
                })
              )}
            </ScrollView>
          </View>
        ) : null}

        {/* Resize handle — between thread list and conversation pane.
         *  Web only (no mouse on native). Hidden when the list isn't visible. */}
        {shouldShowList && shouldShowConv && Platform.OS === 'web' ? (
          <ResizeHandle
            onDragStart={handleListDragStart}
            isDragging={draggingHandle === 'list'}
          />
        ) : null}

        {/* Conversation pane */}
        {shouldShowConv && selectedSession ? (
          <View style={styles.convPaneWrap}>
            <ConversationPane
              key={selectedSession.id}
              session={selectedSession}
              onBack={handleBack}
              showBackButton={hideList}
            />
          </View>
        ) : shouldShowConv ? (
          <View style={styles.noSelectionPlaceholder}>
            <Text style={styles.noSelectionText}>Select a thread to start messaging</Text>
          </View>
        ) : null}

        {/* Resize handle — between conversation pane and context rail. */}
        {!hideRail && selectedSession && Platform.OS === 'web' ? (
          <ResizeHandle
            onDragStart={handleRailDragStart}
            isDragging={draggingHandle === 'rail'}
          />
        ) : null}

        {/* Right context rail — hidden below BP_HIDE_RAIL */}
        {!hideRail && selectedSession ? (
          <View style={[styles.contextRailWrap, { width: contextRailWidth }]}>
            <ContextRail
              session={selectedSession}
              onOpenSuggestedQuestions={() => setQuestionsDrawerOpen(true)}
            />
          </View>
        ) : null}
      </View>

      {/* Open Questions drawer — renders over the whole screen as a right overlay */}
      {selectedSession != null && (
        <OpenQuestionsDrawer
          visible={questionsDrawerOpen}
          onClose={() => setQuestionsDrawerOpen(false)}
          member={{
            name:                 selectedSession.memberName ?? 'Member',
            age:                  null,
            initials:             getInitials(selectedSession.memberName),
            engagementLabel:      'Active Member',
          }}
          journey={
            selectedSession.vertical
              ? {
                  templateName:    `${selectedSession.vertical.replace('_', ' ')} Journey`,
                  currentStepName: 'Current Step',
                  vertical:        selectedSession.vertical,
                }
              : undefined
          }
        />
      )}
    </AppShell>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // Layout
  root: {
    flex: 1,
    flexDirection: 'row',
    backgroundColor: '#f9fafb',
    overflow: 'hidden',
  } as ViewStyle,
  loadingWrap: {
    padding: 24,
    flex: 1,
  } as ViewStyle,

  // Thread list — width is set inline from threadListWidth state.
  threadList: {
    borderRightWidth: 0,
    backgroundColor: '#fff',
    flexShrink: 0,
  } as ViewStyle,
  threadListHeader: {
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  } as ViewStyle,
  threadListTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 12,
  } as TextStyle,
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 8,
    paddingHorizontal: 10,
    marginBottom: 10,
  } as ViewStyle,
  searchIcon: {
    marginRight: 6,
    justifyContent: 'center',
  } as ViewStyle,
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: '#111827',
    paddingVertical: 8,
    outlineStyle: 'none',
  } as TextStyle,
  filterRow: {
    flexDirection: 'row',
    gap: 6,
  } as ViewStyle,
  filterChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
  } as ViewStyle,
  filterChipActive: {
    backgroundColor: '#D1FAE5',
  } as ViewStyle,
  filterChipText: {
    fontSize: 12,
    fontWeight: '500',
    color: '#6B7280',
  } as TextStyle,
  filterChipTextActive: {
    color: '#065F46',
    fontWeight: '600',
  } as TextStyle,
  threadScrollView: {
    flex: 1,
  } as ViewStyle,
  emptyThreads: {
    padding: 24,
    alignItems: 'center',
  } as ViewStyle,
  emptyThreadsText: {
    fontSize: 14,
    color: '#9CA3AF',
  } as TextStyle,

  // Thread row
  threadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  } as ViewStyle,
  threadRowActive: {
    backgroundColor: '#ECFDF5',
    borderLeftWidth: 3,
    borderLeftColor: '#10B981',
    paddingLeft: 13,
  } as ViewStyle,
  avatar40: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,
  avatarText40: {
    fontSize: 13,
    fontWeight: '700',
  } as TextStyle,
  threadInfo: {
    flex: 1,
    minWidth: 0,
  } as ViewStyle,
  threadTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 3,
  } as ViewStyle,
  threadName: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
  } as TextStyle,
  threadTime: {
    fontSize: 11,
    color: '#9CA3AF',
    flexShrink: 0,
  } as TextStyle,
  // Wrapper so the pin icon and the timestamp sit on the same trailing-edge
  // baseline. flexShrink:0 prevents the timestamp from being squeezed when
  // the member name is long.
  threadTimeWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    flexShrink: 0,
  } as ViewStyle,
  threadPinIcon: {
    // Lucide icons accept a style prop for transforms; keep it empty/cosmetic.
  } as ViewStyle,
  threadPreview: {
    fontSize: 12,
    color: '#6B7280',
  } as TextStyle,
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#10B981',
    flexShrink: 0,
  } as ViewStyle,

  // Conversation pane
  convPane: {
    flex: 1,
    flexDirection: 'column',
    backgroundColor: '#F9FAFB',
    overflow: 'hidden',
  } as ViewStyle,
  convHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 14,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  } as ViewStyle,
  backButton: {
    padding: 6,
    borderRadius: 8,
  } as ViewStyle,
  avatar44: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,
  avatarText44: {
    fontSize: 15,
    fontWeight: '700',
  } as TextStyle,
  convHeaderInfo: {
    flex: 1,
    minWidth: 0,
  } as ViewStyle,
  convHeaderNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 2,
  } as ViewStyle,
  convHeaderName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111827',
  } as TextStyle,
  convHeaderMeta: {
    fontSize: 12,
    color: '#6B7280',
  } as TextStyle,
  iconBtn: {
    padding: 8,
    borderRadius: 8,
  } as ViewStyle,
  iconBtnDisabled: {
    opacity: 0.5,
  } as ViewStyle,
  openProfileBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 8,
  } as ViewStyle,
  openProfileText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
  } as TextStyle,

  // Messages
  messagesScroll: {
    flex: 1,
  } as ViewStyle,
  messagesContent: {
    padding: 20,
    gap: 4,
  } as ViewStyle,
  emptyMessages: {
    flex: 1,
    alignItems: 'center',
    paddingTop: 40,
  } as ViewStyle,
  emptyMessagesText: {
    fontSize: 14,
    color: '#9CA3AF',
  } as TextStyle,
  dateSeparatorRow: {
    alignItems: 'center',
    marginVertical: 12,
  } as ViewStyle,
  dateSeparatorText: {
    fontSize: 12,
    color: '#9CA3AF',
  } as TextStyle,
  bubbleRowMe: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginBottom: 6,
  } as ViewStyle,
  bubbleRowThem: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    marginBottom: 6,
  } as ViewStyle,
  bubble: {
    maxWidth: '75%',
    padding: 10,
    paddingHorizontal: 14,
    gap: 4,
  } as ViewStyle,
  bubbleMe: {
    backgroundColor: '#10B981',
    borderRadius: 18,
    borderBottomRightRadius: 4,
  } as ViewStyle,
  bubbleThem: {
    backgroundColor: '#F3F4F6',
    borderRadius: 18,
    borderBottomLeftRadius: 4,
  } as ViewStyle,
  bubbleText: {
    fontSize: 14,
    lineHeight: 20,
  } as TextStyle,
  bubbleTextMe: {
    color: '#fff',
  } as TextStyle,
  bubbleTextThem: {
    color: '#111827',
  } as TextStyle,
  bubbleTime: {
    fontSize: 10,
    marginTop: 2,
  } as TextStyle,
  bubbleTimeMe: {
    color: 'rgba(255,255,255,0.7)',
    textAlign: 'right',
  } as TextStyle,
  bubbleTimeThem: {
    color: '#9CA3AF',
  } as TextStyle,
  attachmentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  } as ViewStyle,

  // Templates bar
  templatesBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
    gap: 10,
  } as ViewStyle,
  templatesLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#9CA3AF',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    flexShrink: 0,
  } as TextStyle,
  templatesScroll: {
    gap: 8,
    flexDirection: 'row',
  } as ViewStyle,
  templateChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#fff',
  } as ViewStyle,
  templateChipText: {
    fontSize: 12,
    fontWeight: '500',
    color: '#374151',
  } as TextStyle,

  // Composer
  composerWrap: {
    padding: 14,
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
  } as ViewStyle,
  composerInner: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 16,
    padding: 10,
  } as ViewStyle,
  composerIconBtn: {
    padding: 6,
    borderRadius: 8,
  } as ViewStyle,
  composerInput: {
    flex: 1,
    fontSize: 14,
    color: '#111827',
    paddingVertical: 6,
    minHeight: 36,
    maxHeight: 100,
    outlineStyle: 'none',
  } as TextStyle,
  sendBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#059669',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 12,
  } as ViewStyle,
  sendBtnDisabled: {
    opacity: 0.5,
  } as ViewStyle,
  sendBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#fff',
  } as TextStyle,
  composerMeta: {
    fontSize: 12,
    color: '#9CA3AF',
    marginTop: 8,
    textAlign: 'center',
  } as TextStyle,

  // No selection
  noSelectionPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  noSelectionText: {
    fontSize: 14,
    color: '#9CA3AF',
  } as TextStyle,

  // Context rail wrap — width is set inline from contextRailWidth state.
  contextRailWrap: {
    borderLeftWidth: 0,
    backgroundColor: '#fff',
    flexShrink: 0,
  } as ViewStyle,
  // Inner ScrollView still uses the same outer/inner split.
  contextRailOuter: {
    flex: 1,
    backgroundColor: '#fff',
  } as ViewStyle,

  // Conversation pane wrap — flex:1 so it fills the space between the two
  // resizable panes regardless of their widths.
  convPaneWrap: {
    flex: 1,
    minWidth: 0,
  } as ViewStyle,

  // ── Resize handles between panes ──
  resizeHandle: {
    width: 6,
    backgroundColor: '#F3F4F6',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    // No transition on RN, but the hover state changes color via active flag.
  } as ViewStyle,
  resizeHandleActive: {
    backgroundColor: '#D1D5DB',
  } as ViewStyle,
  resizeHandleGrip: {
    alignItems: 'center',
    justifyContent: 'center',
    height: 32,
    width: 14,
    borderRadius: 4,
    // Slight inset so the icon sits clearly on the bar
  } as ViewStyle,
  contextRail: {
    padding: 20,
    gap: 12,
  } as ViewStyle,
  railCard: {
    padding: 14,
    gap: 6,
  } as ViewStyle,
  railSectionLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#9CA3AF',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  } as TextStyle,
  railSubLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#9CA3AF',
    marginBottom: 6,
  } as TextStyle,
  railCardMeta: {
    fontSize: 12,
    color: '#9CA3AF',
  } as TextStyle,
  railCardTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
  } as TextStyle,
  progressBar: {
    height: 8,
    backgroundColor: '#F3F4F6',
    borderRadius: 4,
    overflow: 'hidden',
  } as ViewStyle,
  progressFill: {
    height: 8,
    backgroundColor: '#10B981',
    borderRadius: 4,
  } as ViewStyle,
  railWarningRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 4,
  } as ViewStyle,
  railWarningText: {
    fontSize: 12,
    color: '#92400E',
    flex: 1,
  } as TextStyle,
  needsRows: {
    gap: 8,
  } as ViewStyle,
  needRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  } as ViewStyle,
  needLabel: {
    fontSize: 14,
    color: '#111827',
    flex: 1,
  } as TextStyle,
  needBadgeSpacer: {
    flex: 1,
  } as ViewStyle,
  insightCard: {
    backgroundColor: '#F0FDF4',
  } as ViewStyle,
  insightHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  } as ViewStyle,
  insightTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: '#111827',
  } as TextStyle,
  insightText: {
    fontSize: 12,
    color: '#374151',
    lineHeight: 18,
  } as TextStyle,
  quickActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 8,
    marginBottom: 6,
  } as ViewStyle,
  quickActionText: {
    fontSize: 14,
    color: '#374151',
  } as TextStyle,
  quickActionBtnDisabled: {
    opacity: 0.5,
  } as ViewStyle,
  quickActionTextDisabled: {
    color: '#9CA3AF',
  } as TextStyle,

  // End Session — destructive call-to-action that opens DocumentationModal.
  // Red background, white text + icon to communicate finality (this submits
  // the session for downstream Pear claim generation).
  endSessionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 11,
    backgroundColor: '#DC2626',
    borderRadius: 8,
    marginTop: 8,
    marginBottom: 4,
  } as ViewStyle,
  endSessionBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#FFFFFF',
  } as TextStyle,

  // Consent flow status rows
  consentApprovedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: '#bbf7d0',
    borderRadius: 8,
    marginBottom: 6,
    backgroundColor: '#f0fdf4',
  } as ViewStyle,
  consentApprovedText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#15803d',
  } as TextStyle,
  consentDeniedRow: {
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: '#fecaca',
    borderRadius: 8,
    marginBottom: 6,
    backgroundColor: '#fef2f2',
  } as ViewStyle,
  consentDeniedText: {
    fontSize: 13,
    color: '#dc2626',
  } as TextStyle,
  consentWaitingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: '#fed7aa',
    borderRadius: 8,
    marginBottom: 6,
    backgroundColor: '#fff7ed',
  } as ViewStyle,
  consentWaitingText: {
    fontSize: 13,
    color: '#9A3412',
  } as TextStyle,

  // AI Summary preview card
  summaryPreviewCard: {
    borderWidth: 1,
    borderColor: '#d1fae5',
    borderRadius: 8,
    padding: 12,
    marginBottom: 6,
    backgroundColor: '#f0fdf4',
    gap: 6,
  } as ViewStyle,
  summaryPreviewText: {
    fontSize: 13,
    color: '#374151',
    lineHeight: 18,
  } as TextStyle,
  summaryOpenLink: {
    fontSize: 13,
    fontWeight: '600',
    color: '#059669',
    marginTop: 2,
  } as TextStyle,
  summaryRegenerateBtn: {
    marginTop: 4,
    alignSelf: 'flex-start',
  } as ViewStyle,
  summaryRegenerateText: {
    fontSize: 12,
    color: '#6B7280',
  } as TextStyle,
  summaryDisabledHint: {
    fontSize: 11,
    color: '#9CA3AF',
    paddingHorizontal: 12,
    marginTop: -2,
    marginBottom: 6,
  } as TextStyle,
  summaryErrorText: {
    fontSize: 12,
    color: '#dc2626',
    paddingHorizontal: 12,
    marginBottom: 6,
  } as TextStyle,
});

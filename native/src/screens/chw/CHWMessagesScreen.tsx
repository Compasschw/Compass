/**
 * CHWMessagesScreen — 3-pane SMS inbox for Community Health Workers.
 *
 * Pane layout (web, ≥1280px):
 *   [ThreadListPane 320px] | [ConversationPane flex] | [MemberContextRail 288px]
 *
 * Responsive collapse:
 *   <1280px → right rail hidden; thread list + conversation both visible
 *   <900px  → only one pane visible at a time; back button reveals thread list
 *
 * Data wiring:
 *   - ThreadListPane    : useSessions() — each session = one member thread
 *   - ConversationPane  : useSessionMessages(sessionId) — polls every 4 s
 *   - MemberContextRail : useChwJourneys() + useMemberServicesConsent(memberId)
 *
 * Design alignment (Phase 1 Second Run):
 *   - Left pane: 4 tabs (All / Unread / Flagged / Archived)
 *   - Center header: engagement Pill + modality sub-line + action icons
 *   - Composer: TEMPLATES row + icon toolbar + SMS caption
 *   - Right rail: Active Journey · Resource Needs · Compass Insight · Quick Actions
 *                 · Generate AI Summary (disabled stub) · End Session (destructive)
 *
 * Hard constraints (do NOT modify):
 *   - Do NOT modify DashboardSidebar.
 *   - Do NOT add new backend endpoints unless unavoidable (see End Session note below).
 *   - Do NOT alter session-per-call backend behaviour or call-bridge calls.
 *   - Do NOT claim TLS+at-rest is E2E encryption.
 *
 * STUB NOTES:
 *   - "Add Case Note" → Wired to POST /api/v1/case-notes (shipped 2026-06-09).
 *     Opens CaseNoteModal (RightDrawer) in MemberContextRail.
 *   - "Request Recording Consent" → uses existing useCreateConsentRequest (consent-requests
 *     endpoint exists). Wired to POST /sessions/{id}/consent-requests.
 *   - "End Session" → POST /sessions/{id}/end — backend shipped 2026-06-09.
 *     Transitions session to awaiting_documentation and opens DocumentationModal.
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
  Pressable,
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
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  AlertCircle,
  FileText,
  XCircle,
  Sparkles,
  LogOut,
  Home,
  ShoppingCart,
  Truck,
  HeartPulse,
  MessageSquare,
  Flag,
  BookOpen,
} from 'lucide-react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { CHWSessionsStackParamList } from '../../navigation/CHWTabNavigator';

import { AppShell, Card, Pill, SectionHeader, ResizableDivider, RightDrawer } from '../../components/ui';
import { useAuth } from '../../context/AuthContext';
import {
  useSessions,
  useSessionMessages,
  useSessionSendMessage,
  useStartCall,
  useSubmitDocumentation,
  useChwJourneys,
  useMemberServicesConsent,
  useCreateConsentRequest,
  useCreateFlagNote,
  useDeleteFlagNote,
  useFlagNote,
  useCreateCaseNote,
  useEndSession as useEndSessionHook,
  type SessionData,
  type SessionMessageLocal,
  type SessionMessageData,
  type MemberJourneyResponse,
  type ServicesConsentValue,
} from '../../hooks/useApiQueries';
import {
  useEngagementStatus,
  useCompassInsight,
} from '../../hooks/useMessagesInsights';
import { OpenQuestionsDrawer } from '../../components/chw/OpenQuestionsDrawer';
import { DocumentationModal } from '../../components/sessions/DocumentationModal';
import type { SessionDocumentation } from '../../data/mock';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';
import { PressableMember } from '../../components/shared/PressableMember';
import { colors as tokens, spacing, radius } from '../../theme/tokens';

// ─── Breakpoints ──────────────────────────────────────────────────────────────

/** Below this width the right rail is hidden. */
const BP_HIDE_RAIL = 1280;
/** Below this width only one pane is shown at a time. */
const BP_HIDE_LIST = 900;

// ─── Pane width constraints ───────────────────────────────────────────────────

const THREAD_LIST_WIDTH = 320;
const CONTEXT_RAIL_WIDTH = 300;

/** Min/max bounds for each draggable pane — tuned for CHW screen. */
const CHW_LEFT_MIN = 200;
const CHW_LEFT_MAX = 500;
const CHW_RIGHT_MIN = 260;
const CHW_RIGHT_MAX = 480;

/** localStorage keys for persisted pane widths. */
const LS_KEY_CHW_LEFT = 'compass:chwMessages:leftWidth';
const LS_KEY_CHW_RIGHT = 'compass:chwMessages:rightWidth';

/**
 * Reads a numeric pane width from localStorage.
 * Returns the provided fallback when running in SSR context or when the key
 * is absent / holds a non-numeric value.
 */
function readStoredWidth(key: string, fallback: number): number {
  if (typeof window === 'undefined') return fallback;
  try {
    const stored = window.localStorage.getItem(key);
    if (stored === null) return fallback;
    const parsed = Number(stored);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Persists a pane width to localStorage.
 * Silently swallows errors (e.g. private-browsing quota exceptions).
 */
function writeStoredWidth(key: string, value: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Storage unavailable — ignore.
  }
}

// ─── Avatar palette ───────────────────────────────────────────────────────────

const AVATAR_BACKGROUND_COLORS = [
  '#d1fae5', '#dbeafe', '#ede9fe', '#fef3c7',
  '#ffe4e6', '#cffafe', '#e0e7ff', '#ffedd5',
];
const AVATAR_FOREGROUND_COLORS = [
  '#047857', '#1d4ed8', '#6d28d9', '#b45309',
  '#be123c', '#0891b2', '#4338ca', '#c2410c',
];

// ─── Pure utilities ───────────────────────────────────────────────────────────

/** Returns up to two uppercase initials from a display name. */
function getInitials(name: string | null | undefined): string {
  if (!name) return '??';
  return name
    .split(' ')
    .slice(0, 2)
    .map((part) => part[0] ?? '')
    .join('')
    .toUpperCase();
}

/** Returns the first word (first name) of a display name. */
function getFirstName(name: string | null | undefined): string {
  if (!name) return 'Member';
  return name.split(' ')[0] ?? name;
}

/** Deterministic avatar colour pair keyed on the first character of the name. */
function avatarColorFor(name: string): { bg: string; fg: string } {
  const index = name.charCodeAt(0) % AVATAR_BACKGROUND_COLORS.length;
  return {
    bg: AVATAR_BACKGROUND_COLORS[index] ?? '#d1fae5',
    fg: AVATAR_FOREGROUND_COLORS[index] ?? '#047857',
  };
}

/** Human-readable timestamp for a thread row (today → time, yesterday → "Yesterday", older → days). */
function formatThreadTimestamp(iso: string | undefined): string {
  if (!iso) return '';
  const then = new Date(iso);
  const now = new Date();
  const diffDays = Math.floor(
    (now.setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) /
      (1000 * 60 * 60 * 24),
  );
  if (diffDays === 0) {
    return then.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  if (diffDays === 1) return 'Yesterday';
  return `${diffDays}d`;
}

/** Human-readable time for a message bubble. */
function formatMessageTimestamp(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Date-separator label shown between message groups. */
function formatDaySeparator(iso: string): string {
  const then = new Date(iso);
  const diffDays = Math.floor(
    (new Date().setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) /
      (1000 * 60 * 60 * 24),
  );
  if (diffDays === 0) {
    return `Today · ${then.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  }
  if (diffDays === 1) return 'Yesterday';
  return then.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Groups a flat message list into per-day buckets for day-separator rendering. */
function groupMessagesByDay(
  messages: SessionMessageLocal[],
): Array<{ dateKey: string; messages: SessionMessageLocal[] }> {
  const buckets = new Map<string, SessionMessageLocal[]>();
  for (const message of messages) {
    const key = new Date(message.createdAt).toDateString();
    const bucket = buckets.get(key) ?? [];
    bucket.push(message);
    buckets.set(key, bucket);
  }
  return Array.from(buckets.entries()).map(([dateKey, msgs]) => ({
    dateKey,
    messages: msgs,
  }));
}

/**
 * Derives a human-readable modality label from the session mode field.
 * Used in the conversation header sub-line.
 */
function formatModality(mode: string | null | undefined): string {
  if (!mode) return 'phone';
  const normalized = mode.toLowerCase().replace(/_/g, ' ');
  if (normalized.includes('video') || normalized.includes('virtual')) return 'video';
  if (normalized.includes('person')) return 'in-person';
  return 'phone';
}

/**
 * Returns the icon component to use for a resource-needs journey category.
 * Lucide icons passed as a component reference.
 */
function journeyCategoryIcon(category: string | undefined): React.ComponentType<{ size: number; color: string }> {
  switch ((category ?? '').toLowerCase()) {
    case 'housing': return Home;
    case 'food': return ShoppingCart;
    case 'transportation': return Truck;
    case 'healthcare':
    case 'mental_health':
    case 'rehab': return HeartPulse;
    default: return BookOpen;
  }
}

// ─── Resource-needs severity heuristic ───────────────────────────────────────

/**
 * Severity tier derived from journey progress percentage.
 * Mirrors the same heuristic used in CHWMemberProfileScreen:
 *   < 33 → High (red), 33–67 → Medium (amber), ≥ 67 → Low (yellow/amber-dark)
 */
type ResourceSeverity = 'High' | 'Medium' | 'Low';

function deriveSeverity(progressPercent: number): ResourceSeverity {
  if (progressPercent < 33) return 'High';
  if (progressPercent < 67) return 'Medium';
  return 'Low';
}

type SeverityPillVariant = 'red' | 'amber-dark' | 'amber';

function severityPillVariant(severity: ResourceSeverity): SeverityPillVariant {
  if (severity === 'High') return 'red';
  if (severity === 'Medium') return 'amber-dark';
  return 'amber';
}

// ─── Inline toast ─────────────────────────────────────────────────────────────

interface InlineToastProps {
  readonly message: string;
  readonly isError: boolean;
}

/**
 * Transient feedback strip shown below the conversation header.
 * Disappears after 3.5 s (controlled by the parent).
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
    marginHorizontal: spacing.lg,
    marginVertical: spacing.xs,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: radius.md,
    borderWidth: 1,
  } as ViewStyle,
  success: {
    backgroundColor: '#f0fdf4',
    borderColor: '#bbf7d0',
  } as ViewStyle,
  error: {
    backgroundColor: '#fef2f2',
    borderColor: '#fecaca',
  } as ViewStyle,
  text: {
    fontSize: 13,
    fontWeight: '500',
  } as TextStyle,
  successText: { color: '#15803d' } as TextStyle,
  errorText: { color: '#dc2626' } as TextStyle,
});

// ─── CalendarPlus navigation button ──────────────────────────────────────────

/**
 * Navigates the CHW to the Calendar tab.
 * Isolated as its own component because useNavigation() must be called inside
 * a NavigationContainer descendant.
 */
function CalendarNavigationButton(): React.JSX.Element {
  const navigation = useNavigation<any>(); // eslint-disable-line @typescript-eslint/no-explicit-any
  return (
    <TouchableOpacity
      style={styles.iconBtn}
      onPress={() => navigation.navigate('Calendar')}
      accessibilityRole="button"
      accessibilityLabel="Go to calendar"
    >
      <CalendarPlus size={20} color={tokens.textSecondary} />
    </TouchableOpacity>
  );
}

// ─── Thread row ───────────────────────────────────────────────────────────────

interface ThreadRowProps {
  readonly session: SessionData;
  readonly isActive: boolean;
  readonly lastMessage: SessionMessageData | null;
  readonly hasUnread: boolean;
  readonly onSelect: (session: SessionData) => void;
}

/**
 * A single row in the thread list pane.
 * Shows avatar, member name, message preview, timestamp, and an unread dot.
 */
function ThreadRow({
  session,
  isActive,
  lastMessage,
  hasUnread,
  onSelect,
}: ThreadRowProps): React.JSX.Element {
  const name = session.memberName ?? 'Unknown Member';
  const initials = getInitials(name);
  const { bg, fg } = avatarColorFor(name);
  const preview = lastMessage?.body ?? session.notes ?? 'No messages yet';
  const timestamp = formatThreadTimestamp(
    lastMessage?.createdAt ?? session.scheduledAt,
  );

  return (
    <TouchableOpacity
      onPress={() => onSelect(session)}
      style={[styles.threadRow, isActive && styles.threadRowActive]}
      accessibilityRole="button"
      accessibilityLabel={`Thread with ${name}${hasUnread ? ', unread' : ''}`}
      accessibilityState={{ selected: isActive }}
    >
      <View style={[styles.threadAvatar, { backgroundColor: bg }]}>
        <Text style={[styles.threadAvatarText, { color: fg }]}>{initials}</Text>
      </View>

      <View style={styles.threadBody}>
        <View style={styles.threadTopRow}>
          <Text style={styles.threadName} numberOfLines={1}>
            {name}
          </Text>
          <Text style={styles.threadTimestamp}>{timestamp}</Text>
        </View>
        <Text style={styles.threadPreview} numberOfLines={1}>
          {preview}
        </Text>
      </View>

      {hasUnread ? <View style={styles.unreadIndicator} /> : null}
    </TouchableOpacity>
  );
}

// ─── Thread list pane ─────────────────────────────────────────────────────────

type ThreadFilterTab = 'all' | 'unread' | 'flagged' | 'archived';

interface ThreadListPaneProps {
  readonly sessions: SessionData[];
  readonly selectedSessionId: string | null;
  readonly onSelectSession: (session: SessionData) => void;
}

/**
 * Left pane: alphabetical list of member threads with search and 4 filter tabs.
 *
 * Tabs: All (n) / Unread / Flagged / Archived.
 * "Unread", "Flagged", and "Archived" are presentation-only in v1 —
 * the backend flag fields (archivedAt, pinnedAt) exist on SessionData but
 * the "flagged" concept maps to thread-level flagging (distinct from member
 * flag notes). Real counts wire in without a design change.
 */
function ThreadListPane({
  sessions,
  selectedSessionId,
  onSelectSession,
}: ThreadListPaneProps): React.JSX.Element {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<ThreadFilterTab>('all');

  const withMember = useMemo(
    () => sessions.filter((s) => !!s.memberName),
    [sessions],
  );

  const visibleSessions = useMemo(() => {
    // Sort: alphabetical by member name
    const sorted = [...withMember].sort((a, b) =>
      (a.memberName ?? '').localeCompare(b.memberName ?? ''),
    );

    let filtered = sorted;

    // Apply tab filter
    switch (activeFilter) {
      case 'archived':
        filtered = filtered.filter((s) => !!s.archivedAt);
        break;
      case 'unread':
      case 'flagged':
        // Unread/flagged are presentation-only in v1 — show same list.
        // Real unread count comes from backend; flagged threads TBD.
        break;
      default:
        // 'all' — no additional filter, but exclude archived by default
        filtered = filtered.filter((s) => !s.archivedAt);
        break;
    }

    // Search
    const query = searchQuery.trim().toLowerCase();
    if (query) {
      filtered = filtered.filter((s) =>
        (s.memberName ?? '').toLowerCase().includes(query),
      );
    }

    return filtered;
  }, [withMember, searchQuery, activeFilter]);

  const totalCount = useMemo(
    () => withMember.filter((s) => !s.archivedAt).length,
    [withMember],
  );

  const tabs: { key: ThreadFilterTab; label: string }[] = [
    { key: 'all', label: `All (${totalCount})` },
    { key: 'unread', label: 'Unread' },
    { key: 'flagged', label: 'Flagged' },
    { key: 'archived', label: 'Archived' },
  ];

  return (
    <View style={styles.threadListPane} accessibilityRole={"navigation" as any} accessibilityLabel="Message threads">
      {/* Header */}
      <View style={styles.threadListHeader}>
        <Text style={styles.threadListTitle}>Messages</Text>

        {/* Search */}
        <View style={styles.searchBar}>
          <Search size={15} color={tokens.textMuted} style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search members…"
            placeholderTextColor={tokens.textMuted}
            accessibilityLabel="Search message threads"
          />
        </View>

        {/* Filter tabs */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.filterRow}
          contentContainerStyle={styles.filterRowContent}
          accessibilityRole="radiogroup"
        >
          {tabs.map((tab) => (
            <TouchableOpacity
              key={tab.key}
              style={[styles.filterChip, activeFilter === tab.key && styles.filterChipActive]}
              onPress={() => setActiveFilter(tab.key)}
              accessibilityRole="radio"
              accessibilityState={{ checked: activeFilter === tab.key }}
              accessibilityLabel={tab.label}
            >
              <Text
                style={[
                  styles.filterChipText,
                  activeFilter === tab.key && styles.filterChipTextActive,
                ]}
              >
                {tab.label}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* Thread rows */}
      <ScrollView
        style={styles.threadScrollView}
        showsVerticalScrollIndicator={false}
        accessibilityRole="list"
        accessibilityLabel="Member threads"
      >
        {visibleSessions.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyStateText}>
              {searchQuery ? 'No threads match your search.' : 'No conversations here.'}
            </Text>
          </View>
        ) : (
          visibleSessions.map((session) => (
            <ThreadRow
              key={session.id}
              session={session}
              isActive={selectedSessionId === session.id}
              lastMessage={null}
              hasUnread={false}
              onSelect={onSelectSession}
            />
          ))
        )}
      </ScrollView>
    </View>
  );
}

// ─── Message bubble ───────────────────────────────────────────────────────────

interface MessageBubbleProps {
  readonly message: SessionMessageLocal;
  readonly isSentByChw: boolean;
}

function MessageBubble({ message, isSentByChw }: MessageBubbleProps): React.JSX.Element {
  return (
    <View style={isSentByChw ? styles.bubbleRowOutbound : styles.bubbleRowInbound}>
      <View style={[styles.bubble, isSentByChw ? styles.bubbleOutbound : styles.bubbleInbound]}>
        {message.attachment ? (
          <View style={styles.attachmentRow}>
            <Paperclip size={14} color={isSentByChw ? '#fff' : tokens.textPrimary} />
            <Text
              style={[
                styles.bubbleText,
                isSentByChw ? styles.bubbleTextOutbound : styles.bubbleTextInbound,
              ]}
            >
              {message.attachment.filename}
            </Text>
          </View>
        ) : (
          <Text
            style={[
              styles.bubbleText,
              isSentByChw ? styles.bubbleTextOutbound : styles.bubbleTextInbound,
            ]}
          >
            {message.body}
          </Text>
        )}
        <Text
          style={[
            styles.bubbleTimestamp,
            isSentByChw ? styles.bubbleTimestampOutbound : styles.bubbleTimestampInbound,
          ]}
        >
          {formatMessageTimestamp(message.createdAt)}
          {message.status === 'sending' ? ' · Sending…' : ''}
          {message.status === 'failed' ? ' · Failed' : ''}
        </Text>
      </View>
    </View>
  );
}

// ─── Conversation pane ────────────────────────────────────────────────────────

interface ConversationPaneProps {
  readonly session: SessionData;
  readonly onBack?: () => void;
  readonly showBackButton: boolean;
  /**
   * When true, fire the masked-number call sequence on mount.
   * Set by the parent when route.params.autoCall === true.
   */
  readonly autoCallOnMount?: boolean;
  readonly onAutoCallConsumed?: () => void;
  /** Callback so the rail can open the Documentation modal post-end. */
  readonly onRequestOpenDocumentation?: () => void;
}

/**
 * Center pane: message thread + composer.
 *
 * Handles optimistic message rendering, auto-scroll, call initiation, and
 * the "Complete Session" documentation modal.
 */
function ConversationPane({
  session,
  onBack,
  showBackButton,
  autoCallOnMount,
  onAutoCallConsumed,
  onRequestOpenDocumentation,
}: ConversationPaneProps): React.JSX.Element {
  const [draftText, setDraftText] = useState('');
  const [localMessages, setLocalMessages] = useState<SessionMessageLocal[]>([]);
  const [callInitiating, setCallInitiating] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [toastIsError, setToastIsError] = useState(false);
  const [documentingSessionId, setDocumentingSessionId] = useState<string | null>(null);

  const scrollRef = useRef<ScrollView>(null);
  const navigation = useNavigation<any>(); // eslint-disable-line @typescript-eslint/no-explicit-any

  const messagesQuery = useSessionMessages(session.id);
  const sendMessage = useSessionSendMessage();
  const startCall = useStartCall();
  const submitDocumentation = useSubmitDocumentation();

  // ── Toast ─────────────────────────────────────────────────────────────────

  const showToast = useCallback((message: string, isError: boolean): void => {
    setToastMessage(message);
    setToastIsError(isError);
    const timer = setTimeout(() => setToastMessage(null), 3_500);
    void timer;
  }, []);

  // ── Call handler ──────────────────────────────────────────────────────────

  const handleCall = useCallback(async (): Promise<void> => {
    if (callInitiating) return;
    const memberName = session.memberName ?? 'this member';

    const executeCall = async (): Promise<void> => {
      setCallInitiating(true);
      try {
        await startCall.mutateAsync(session.id);
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

    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      if (window.confirm(`Start masked call with ${memberName}?`)) {
        void executeCall();
      }
    } else {
      Alert.alert(
        'Start call?',
        `Start a masked call with ${memberName}? Both phones will ring.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Call', onPress: () => void executeCall() },
        ],
      );
    }
  }, [callInitiating, session.id, session.memberName, startCall, showToast]);

  // ── Auto-call on mount ────────────────────────────────────────────────────

  useEffect(() => {
    if (!autoCallOnMount || callInitiating) return;
    setCallInitiating(true);
    void (async () => {
      try {
        await startCall.mutateAsync(session.id);
        showToast('Call requested — your phone should ring shortly.', false);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Call failed.';
        showToast(message, true);
      } finally {
        setCallInitiating(false);
        onAutoCallConsumed?.();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCallOnMount, session.id]);

  // ── Merged messages (server + optimistic) ────────────────────────────────

  const mergedMessages = useMemo<SessionMessageLocal[]>(() => {
    const serverMessages: SessionMessageLocal[] = (messagesQuery.data ?? []).map(
      (m) => ({ ...m }),
    );
    const serverIds = new Set(serverMessages.map((m) => m.id));
    const pendingOptimistic = localMessages.filter((m) => !serverIds.has(m.id));
    return [...serverMessages, ...pendingOptimistic].sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
    );
  }, [messagesQuery.data, localMessages]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
  }, [mergedMessages.length]);

  // ── Send message ──────────────────────────────────────────────────────────

  const handleSend = useCallback(async (): Promise<void> => {
    const trimmed = draftText.trim();
    if (!trimmed) return;

    const optimisticId = `local-${Date.now()}`;
    const optimisticMessage: SessionMessageLocal = {
      id: optimisticId,
      senderUserId: '',
      senderRole: 'chw',
      body: trimmed,
      type: 'text',
      createdAt: new Date().toISOString(),
      status: 'sending',
    };

    setLocalMessages((prev) => [...prev, optimisticMessage]);
    setDraftText('');

    try {
      await sendMessage.mutateAsync({ sessionId: session.id, body: trimmed });
      setLocalMessages((prev) => prev.filter((m) => m.id !== optimisticId));
    } catch {
      setLocalMessages((prev) =>
        prev.map((m) =>
          m.id === optimisticId ? { ...m, status: 'failed' as const } : m,
        ),
      );
    }
  }, [draftText, session.id, sendMessage]);

  // ── Template chip insertion ───────────────────────────────────────────────

  const insertTemplate = useCallback((text: string): void => {
    setDraftText((prev) => (prev ? `${prev} ${text}` : text));
  }, []);

  // ── Complete Session ──────────────────────────────────────────────────────

  const handleOpenCompleteSession = useCallback((): void => {
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
        if (Platform.OS === 'web' && typeof window !== 'undefined') {
          window.alert(
            `Failed to submit documentation\n\n${reason}\n\nThe modal will stay open so you can adjust and try again.`,
          );
        } else {
          Alert.alert('Failed to submit documentation', reason);
        }
      }
    },
    [documentingSessionId, submitDocumentation],
  );

  const memberName = session.memberName ?? 'Unknown Member';
  const memberFirstName = getFirstName(memberName);
  const initials = getInitials(memberName);
  const { bg, fg } = avatarColorFor(memberName);
  const grouped = groupMessagesByDay(mergedMessages);

  // Derive engagement status for header pill
  // Pass session.chwId so CHW-authored messages are identified correctly in
  // the engagement heuristic. senderRole='chw' is the primary signal; chwId
  // is a secondary guard for edge cases where senderRole is missing.
  const engagement = useEngagementStatus(mergedMessages, session.chwId ?? '');
  const modality = formatModality(session.mode);

  // ── Quick-reply templates ─────────────────────────────────────────────────

  const templateChips: Array<{
    label: string;
    icon: React.ComponentType<{ size: number; color: string }>;
    text: string;
  }> = [
    {
      label: 'Appointment reminder',
      icon: CalendarPlus,
      text: `Hi ${memberFirstName}, this is a reminder about your upcoming appointment. Please reply to confirm or reschedule.`,
    },
    {
      label: 'Document upload reminder',
      icon: FileText,
      text: `Hi ${memberFirstName}, we still need a few documents to move forward. Can you upload them when you get a chance?`,
    },
    {
      label: 'Resource link',
      icon: LinkIcon,
      // TODO(resources): When a resource picker is available, replace this stub
      // with the actual resource URL selected from the resource drawer.
      text: '[resource]',
    },
  ];

  return (
    <View style={styles.convPane} accessibilityRole={"main" as any}>
      {/* Header */}
      <View style={styles.convHeader}>
        {showBackButton && onBack ? (
          <TouchableOpacity
            onPress={onBack}
            style={styles.backBtn}
            accessibilityRole="button"
            accessibilityLabel="Back to thread list"
          >
            <ArrowLeft size={20} color={tokens.textPrimary} />
          </TouchableOpacity>
        ) : null}

        <PressableMember
          memberId={session.memberId ?? ''}
          displayName={memberName}
          enabled={!!session.memberId}
        >
          <View style={[styles.convHeaderAvatar, { backgroundColor: bg }]}>
            <Text style={[styles.convHeaderAvatarText, { color: fg }]}>{initials}</Text>
          </View>
        </PressableMember>

        <View style={styles.convHeaderInfo}>
          <View style={styles.convHeaderNameRow}>
            <PressableMember
              memberId={session.memberId ?? ''}
              displayName={memberName}
              enabled={!!session.memberId}
            >
              <Text style={styles.convHeaderName} numberOfLines={1}>
                {memberName}
              </Text>
            </PressableMember>
            <Pill variant={engagement.pillVariant} size="sm" withDot>
              {engagement.label}
            </Pill>
          </View>
          <Text style={styles.convHeaderMeta}>
            {modality} · Active Member
          </Text>
        </View>

        {/* Call button */}
        <TouchableOpacity
          style={[styles.iconBtn, callInitiating && styles.iconBtnDisabled]}
          onPress={() => void handleCall()}
          disabled={callInitiating}
          accessibilityRole="button"
          accessibilityLabel={callInitiating ? 'Call initiating…' : 'Call member'}
          accessibilityState={{ disabled: callInitiating }}
        >
          {callInitiating ? (
            <ActivityIndicator size="small" color={tokens.textSecondary} />
          ) : (
            <Phone size={20} color={tokens.textSecondary} />
          )}
        </TouchableOpacity>

        {/* Calendar navigation */}
        <CalendarNavigationButton />

        {/* Open Member Profile */}
        <PressableMember
          memberId={session.memberId ?? ''}
          displayName={memberName}
          enabled={!!session.memberId}
          style={styles.openProfileBtn}
        >
          <ArrowRight size={14} color={tokens.gray700} />
          <Text style={styles.openProfileText}>Open Profile</Text>
        </PressableMember>
      </View>

      {/* Inline toast */}
      {toastMessage !== null ? (
        <InlineToast message={toastMessage} isError={toastIsError} />
      ) : null}

      {/* Message thread */}
      <ScrollView
        ref={scrollRef}
        style={styles.messagesScrollView}
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
          grouped.map(({ dateKey, messages: dayMessages }) => (
            <View key={dateKey}>
              <View style={styles.daySeparator}>
                <Text style={styles.daySeparatorText}>
                  {formatDaySeparator(dayMessages[0]?.createdAt ?? dateKey)}
                </Text>
              </View>
              {dayMessages.map((msg) => (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  isSentByChw={msg.senderRole === 'chw'}
                />
              ))}
            </View>
          ))
        )}
      </ScrollView>

      {/* Composer area */}
      <View style={styles.composerWrap}>
        {/* Quick-reply template chips */}
        <View style={styles.templateRow}>
          <Text style={styles.templateLabel}>TEMPLATES:</Text>
          {templateChips.map((chip) => {
            const IconComponent = chip.icon;
            return (
              <TouchableOpacity
                key={chip.label}
                style={styles.templateChip}
                onPress={() => insertTemplate(chip.text)}
                accessibilityRole="button"
                accessibilityLabel={`Insert template: ${chip.label}`}
              >
                <IconComponent size={12} color={tokens.textSecondary} />
                <Text style={styles.templateChipText}>{chip.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Composer row */}
        <View style={styles.composerInner}>
          <TouchableOpacity
            style={styles.composerIconBtn}
            accessibilityRole="button"
            accessibilityLabel="Attach file"
          >
            <Paperclip size={20} color={tokens.textSecondary} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.composerIconBtn}
            accessibilityRole="button"
            accessibilityLabel="Insert link"
          >
            <LinkIcon size={20} color={tokens.textSecondary} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.composerIconBtn}
            accessibilityRole="button"
            accessibilityLabel="Schedule appointment"
            onPress={() => insertTemplate(`Appointment scheduled — I'll send you details shortly.`)}
          >
            <CalendarPlus size={20} color={tokens.textSecondary} />
          </TouchableOpacity>
          <TextInput
            style={styles.composerInput}
            value={draftText}
            onChangeText={setDraftText}
            placeholder={`Reply to ${memberFirstName}…`}
            placeholderTextColor={tokens.textMuted}
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

        {/* Complete Session CTA */}
        <TouchableOpacity
          style={styles.completeSessionBtn}
          onPress={handleOpenCompleteSession}
          accessibilityRole="button"
          accessibilityLabel="Complete session and open documentation"
        >
          <FileText size={15} color="#fff" />
          <Text style={styles.completeSessionBtnText}>Complete Session</Text>
        </TouchableOpacity>

        <Text style={styles.composerMeta}>SMS via Vonage masked number</Text>
      </View>

      {/* Documentation modal */}
      {documentingSessionId != null && (
        <DocumentationModal
          visible={documentingSessionId != null}
          onClose={() => setDocumentingSessionId(null)}
          sessionId={documentingSessionId}
          durationMinutes={session.durationMinutes ?? null}
          onSubmit={handleDocumentationSubmit}
        />
      )}
    </View>
  );
}

// ─── Services consent status widget ──────────────────────────────────────────

interface ServicesConsentStatusProps {
  readonly consentValue: ServicesConsentValue | null;
  readonly isLoading: boolean;
}

/**
 * Read-only consent status indicator for the CHW right rail.
 * The CHW cannot change this value — only the member can (via their Profile).
 */
function ServicesConsentStatus({
  consentValue,
  isLoading,
}: ServicesConsentStatusProps): React.JSX.Element {
  if (isLoading) {
    return (
      <View style={consentStyles.row}>
        <ActivityIndicator size="small" color={tokens.textMuted} />
        <Text style={consentStyles.label}>Loading consent status…</Text>
      </View>
    );
  }

  if (consentValue === null) {
    return (
      <View style={[consentStyles.row, consentStyles.neutral]}>
        <AlertCircle size={14} color={tokens.textMuted} />
        <Text style={consentStyles.neutralText}>Consent status unavailable</Text>
      </View>
    );
  }

  if (consentValue === 'refuse_services') {
    return (
      <View style={[consentStyles.row, consentStyles.refused]}>
        <XCircle size={14} color="#b91c1c" />
        <Text style={consentStyles.refusedText}>Member has refused services</Text>
      </View>
    );
  }

  return (
    <View style={[consentStyles.row, consentStyles.consented]}>
      <CheckCircle2 size={14} color="#15803d" />
      <Text style={consentStyles.consentedText}>Consent to services</Text>
    </View>
  );
}

const consentStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
  } as ViewStyle,
  neutral: {
    backgroundColor: tokens.gray100,
  } as ViewStyle,
  neutralText: {
    fontSize: 13,
    color: tokens.textMuted,
  } as TextStyle,
  consented: {
    backgroundColor: '#f0fdf4',
    borderWidth: 1,
    borderColor: '#bbf7d0',
  } as ViewStyle,
  consentedText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#15803d',
  } as TextStyle,
  refused: {
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
  } as ViewStyle,
  refusedText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#b91c1c',
  } as TextStyle,
  label: {
    fontSize: 13,
    color: tokens.textMuted,
  } as TextStyle,
});

// ─── Flag Thread Modal (inline; mirrors FlagMemberModal from CHWMemberProfileScreen) ──

interface FlagThreadModalProps {
  readonly memberId: string;
  readonly visible: boolean;
  readonly onClose: () => void;
}

/**
 * Re-uses the flag-note backend contract to attach a CHW-only note
 * to this member directly from the messages screen.
 *
 * Identical in behaviour to FlagMemberModal in CHWMemberProfileScreen.
 * Not exported — internal to this screen only.
 */
function FlagThreadModal({ memberId, visible, onClose }: FlagThreadModalProps): React.JSX.Element {
  const { data: existingNote, isLoading: noteLoading } = useFlagNote(memberId);
  const createNote = useCreateFlagNote(memberId);
  const deleteNote = useDeleteFlagNote(memberId);
  const [noteText, setNoteText] = useState('');

  const handleSave = useCallback(async (): Promise<void> => {
    const trimmed = noteText.trim();
    if (!trimmed) return;
    await createNote.mutateAsync(trimmed);
    setNoteText('');
    onClose();
  }, [noteText, createNote, onClose]);

  const handleDelete = useCallback(async (): Promise<void> => {
    await deleteNote.mutateAsync();
    onClose();
  }, [deleteNote, onClose]);

  if (!visible) return <></>;

  return (
    <RightDrawer
      isOpen={visible}
      onClose={onClose}
      title="Flag Thread"
      subtitle="CHW-only note attached to this member's profile"
      footer={
        <View style={flagModalStyles.footer}>
          <TouchableOpacity
            style={flagModalStyles.cancelBtn}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
          >
            <Text style={flagModalStyles.cancelBtnText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              flagModalStyles.saveBtn,
              (createNote.isPending || noteText.trim().length === 0) && flagModalStyles.saveBtnDisabled,
            ]}
            onPress={() => { void handleSave(); }}
            disabled={createNote.isPending || noteText.trim().length === 0}
            accessibilityRole="button"
            accessibilityLabel="Save flag note"
          >
            {createNote.isPending ? (
              <ActivityIndicator size="small" color="#ffffff" />
            ) : (
              <Text style={flagModalStyles.saveBtnText}>Save Flag</Text>
            )}
          </TouchableOpacity>
        </View>
      }
    >
      <View style={flagModalStyles.content}>
        {noteLoading ? (
          <ActivityIndicator size="small" color={tokens.textMuted} />
        ) : null}

        {existingNote && !noteLoading ? (
          <View style={flagModalStyles.existingNote}>
            <View style={flagModalStyles.existingNoteHeader}>
              <Flag size={14} color="#DC2626" />
              <Text style={flagModalStyles.existingNoteTitle}>Current Flag Note</Text>
            </View>
            <Text style={flagModalStyles.existingNoteBody}>{existingNote.body}</Text>
            <TouchableOpacity
              style={flagModalStyles.removeBtn}
              onPress={() => { void handleDelete(); }}
              disabled={deleteNote.isPending}
              accessibilityRole="button"
              accessibilityLabel="Remove flag note"
            >
              {deleteNote.isPending ? (
                <ActivityIndicator size="small" color="#DC2626" />
              ) : (
                <Text style={flagModalStyles.removeBtnText}>Remove Flag</Text>
              )}
            </TouchableOpacity>
          </View>
        ) : null}

        <Text style={flagModalStyles.inputLabel}>
          {existingNote ? 'Replace with a new note:' : 'Add a flag note:'}
        </Text>
        <TextInput
          style={flagModalStyles.noteInput}
          value={noteText}
          onChangeText={setNoteText}
          placeholder="e.g. Member expressed concern about housing — follow up next session."
          placeholderTextColor={tokens.textMuted}
          multiline
          numberOfLines={4}
          accessibilityLabel="Flag note text"
        />
      </View>
    </RightDrawer>
  );
}

const flagModalStyles = StyleSheet.create({
  content: {
    gap: spacing.md,
    padding: spacing.lg,
  } as ViewStyle,
  existingNote: {
    backgroundColor: '#fef3c7',
    borderWidth: 1,
    borderColor: '#fde68a',
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
  } as ViewStyle,
  existingNoteHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  } as ViewStyle,
  existingNoteTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#92400e',
  } as TextStyle,
  existingNoteBody: {
    fontSize: 13,
    color: '#78350f',
    lineHeight: 18,
  } as TextStyle,
  removeBtn: {
    alignSelf: 'flex-start',
  } as ViewStyle,
  removeBtnText: {
    fontSize: 12,
    color: '#DC2626',
    fontWeight: '500',
  } as TextStyle,
  inputLabel: {
    fontSize: 13,
    fontWeight: '500',
    color: tokens.textSecondary,
  } as TextStyle,
  noteInput: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: radius.md,
    padding: spacing.md,
    fontSize: 14,
    color: tokens.textPrimary,
    minHeight: 96,
    textAlignVertical: 'top',
  } as unknown as TextStyle,
  footer: {
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.lg,
  } as ViewStyle,
  cancelBtn: {
    flex: 1,
    paddingVertical: 11,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: radius.md,
    alignItems: 'center',
  } as ViewStyle,
  cancelBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: tokens.textSecondary,
  } as TextStyle,
  saveBtn: {
    flex: 1,
    paddingVertical: 11,
    backgroundColor: tokens.primary,
    borderRadius: radius.md,
    alignItems: 'center',
  } as ViewStyle,
  saveBtnDisabled: {
    opacity: 0.5,
  } as ViewStyle,
  saveBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#ffffff',
  } as TextStyle,
});

// ─── Case Note Modal ──────────────────────────────────────────────────────────

interface CaseNoteModalProps {
  readonly memberId: string;
  readonly sessionId: string;
  readonly visible: boolean;
  readonly onClose: () => void;
}

/**
 * RightDrawer modal for adding a clinical case note for the member.
 *
 * POSTs to POST /api/v1/case-notes via ``useCreateCaseNote``.
 * On success shows a brief "Case note saved" inline toast (via Alert on native)
 * then closes.  The note is optionally attached to the current session.
 *
 * Note: not exported — internal to this screen.
 */
function CaseNoteModal({
  memberId,
  sessionId,
  visible,
  onClose,
}: CaseNoteModalProps): React.JSX.Element {
  const [noteBody, setNoteBody] = useState('');
  const [isPinned, setIsPinned] = useState(false);
  const createNote = useCreateCaseNote();

  const handleSave = useCallback(async (): Promise<void> => {
    const trimmed = noteBody.trim();
    if (!trimmed) return;
    await createNote.mutateAsync({
      memberId,
      body: trimmed,
      sessionId,
      isPinned,
    });
    setNoteBody('');
    setIsPinned(false);
    onClose();
    // Brief feedback on native after close.
    Alert.alert('Case note saved', 'Your note has been added to this member.');
  }, [noteBody, isPinned, memberId, sessionId, createNote, onClose]);

  const handleClose = useCallback((): void => {
    setNoteBody('');
    setIsPinned(false);
    onClose();
  }, [onClose]);

  if (!visible) return <></>;

  return (
    <RightDrawer
      isOpen={visible}
      onClose={handleClose}
      title="Add Case Note"
      subtitle="Attach a clinical note to this member's record"
      footer={
        <View style={caseNoteModalStyles.footer}>
          <TouchableOpacity
            style={caseNoteModalStyles.cancelBtn}
            onPress={handleClose}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
          >
            <Text style={caseNoteModalStyles.cancelBtnText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              caseNoteModalStyles.saveBtn,
              (createNote.isPending || noteBody.trim().length === 0) &&
                caseNoteModalStyles.saveBtnDisabled,
            ]}
            onPress={() => {
              void handleSave();
            }}
            disabled={createNote.isPending || noteBody.trim().length === 0}
            accessibilityRole="button"
            accessibilityLabel="Save case note"
          >
            {createNote.isPending ? (
              <ActivityIndicator size="small" color="#ffffff" />
            ) : (
              <Text style={caseNoteModalStyles.saveBtnText}>Save Note</Text>
            )}
          </TouchableOpacity>
        </View>
      }
    >
      <View style={caseNoteModalStyles.content}>
        <Text style={caseNoteModalStyles.inputLabel}>Note</Text>
        <TextInput
          style={caseNoteModalStyles.noteInput}
          value={noteBody}
          onChangeText={setNoteBody}
          placeholder="Clinical observations, follow-up actions, member updates…"
          placeholderTextColor={tokens.textMuted}
          multiline
          numberOfLines={5}
          accessibilityLabel="Case note body"
          autoFocus
        />
        <TouchableOpacity
          style={caseNoteModalStyles.pinRow}
          onPress={() => setIsPinned((v) => !v)}
          accessibilityRole="checkbox"
          accessibilityLabel={isPinned ? 'Unpin note' : 'Pin note to top'}
        >
          <View
            style={[
              caseNoteModalStyles.checkbox,
              isPinned && caseNoteModalStyles.checkboxActive,
            ]}
          >
            {isPinned ? (
              <CheckCircle2 size={14} color="#ffffff" />
            ) : null}
          </View>
          <Text style={caseNoteModalStyles.pinLabel}>Pin to top of notes</Text>
        </TouchableOpacity>
      </View>
    </RightDrawer>
  );
}

const caseNoteModalStyles = StyleSheet.create({
  content: {
    gap: spacing.md,
    padding: spacing.lg,
  } as ViewStyle,
  inputLabel: {
    fontSize: 13,
    fontWeight: '500',
    color: tokens.textSecondary,
  } as TextStyle,
  noteInput: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: radius.md,
    padding: spacing.md,
    fontSize: 14,
    color: tokens.textPrimary,
    minHeight: 120,
    textAlignVertical: 'top',
  } as unknown as TextStyle,
  pinRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  } as ViewStyle,
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: '#D1D5DB',
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  checkboxActive: {
    backgroundColor: tokens.primary,
    borderColor: tokens.primary,
  } as ViewStyle,
  pinLabel: {
    fontSize: 13,
    color: tokens.textSecondary,
  } as TextStyle,
  footer: {
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.lg,
  } as ViewStyle,
  cancelBtn: {
    flex: 1,
    paddingVertical: 11,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: radius.md,
    alignItems: 'center',
  } as ViewStyle,
  cancelBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: tokens.textSecondary,
  } as TextStyle,
  saveBtn: {
    flex: 1,
    paddingVertical: 11,
    backgroundColor: tokens.primary,
    borderRadius: radius.md,
    alignItems: 'center',
  } as ViewStyle,
  saveBtnDisabled: {
    opacity: 0.5,
  } as ViewStyle,
  saveBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#ffffff',
  } as TextStyle,
});

// ─── Member context rail ──────────────────────────────────────────────────────

interface MemberContextRailProps {
  readonly session: SessionData;
  readonly onEndSessionComplete?: () => void;
}

/**
 * Right pane: member context sections in order:
 *   1. Active Journey card
 *   2. Top Resource Needs card
 *   3. Compass Insight card (emerald tinted)
 *   4. Quick Actions (Open Suggested Questions, Add Case Note, Flag Thread,
 *      Request Recording Consent)
 *   5. Generate AI Summary (disabled until session ends)
 *   6. End Session button (red, destructive)
 *   7. Services Consent (informational)
 */
function MemberContextRail({
  session,
  onEndSessionComplete,
}: MemberContextRailProps): React.JSX.Element {
  const navigation = useNavigation<any>(); // eslint-disable-line @typescript-eslint/no-explicit-any

  const [questionsDrawerOpen, setQuestionsDrawerOpen] = useState(false);
  const [flagModalOpen, setFlagModalOpen] = useState(false);
  const [caseNoteModalOpen, setCaseNoteModalOpen] = useState(false);
  const [endSessionPending, setEndSessionPending] = useState(false);

  const endSession = useEndSessionHook();
  const consentRequestMutation = useCreateConsentRequest(session.id);
  const messagesQuery = useSessionMessages(session.id);

  // Journey data
  const journeysQuery = useChwJourneys();
  const memberJourneys: MemberJourneyResponse[] = useMemo(() => {
    const allJourneys = journeysQuery.data ?? [];
    return allJourneys.filter(
      (j) => j.memberId === session.memberId && j.status === 'active',
    );
  }, [journeysQuery.data, session.memberId]);

  const activeJourney: MemberJourneyResponse | null = useMemo(
    () =>
      [...memberJourneys].sort(
        (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt),
      )[0] ?? null,
    [memberJourneys],
  );

  // Top resource needs — top 3 active journeys ranked by severity (lowest progress first)
  const topResourceNeeds = useMemo<MemberJourneyResponse[]>(() => {
    return [...memberJourneys]
      .sort((a, b) => a.progressPercent - b.progressPercent)
      .slice(0, 3);
  }, [memberJourneys]);

  // Services consent
  const consentQuery = useMemberServicesConsent(session.memberId ?? '');
  const consentValue = consentQuery.data?.value ?? null;
  const servicesRefused = consentValue === 'refuse_services';

  // Compass insight
  const messages = messagesQuery.data ?? [];
  const memberFirstName = getFirstName(session.memberName);
  const compassInsight = useCompassInsight(messages, memberFirstName);

  // Journey display values
  const journeyPercent = activeJourney?.progressPercent ?? 0;
  const journeyName = activeJourney?.template.name ?? session.vertical?.replace(/_/g, ' ') ?? 'General';
  const journeyCurrentStep = activeJourney?.currentStep?.stepName ?? null;
  const journeyDueDate = activeJourney?.currentStep?.dueDate ?? null;

  const dueDateCaption = useMemo((): string | null => {
    if (!journeyCurrentStep) return null;
    if (!journeyDueDate) return `Current step: ${journeyCurrentStep}`;
    const daysUntilDue = Math.ceil(
      (Date.parse(journeyDueDate) - Date.now()) / (1000 * 60 * 60 * 24),
    );
    return `Current step: ${journeyCurrentStep} (due in ${daysUntilDue}d)`;
  }, [journeyCurrentStep, journeyDueDate]);

  // ── End Session handler ───────────────────────────────────────────────────

  const handleEndSession = useCallback((): void => {
    const memberName = session.memberName ?? 'this member';
    const confirmAndEnd = async (): Promise<void> => {
      setEndSessionPending(true);
      try {
        await endSession.mutateAsync(session.id);
        onEndSessionComplete?.();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Could not end session. Try again.';
        if (Platform.OS === 'web' && typeof window !== 'undefined') {
          window.alert(`Failed to end session\n\n${message}`);
        } else {
          Alert.alert('Failed to end session', message);
        }
      } finally {
        setEndSessionPending(false);
      }
    };

    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      if (
        window.confirm(
          `End the session for ${memberName}? Recording stops and you'll be prompted to document.`,
        )
      ) {
        void confirmAndEnd();
      }
    } else {
      Alert.alert(
        'End Session?',
        `End the session for ${memberName}? Recording stops and you'll be prompted to document.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'End Session',
            style: 'destructive',
            onPress: () => void confirmAndEnd(),
          },
        ],
      );
    }
  }, [session.id, session.memberName, endSession, onEndSessionComplete]);

  // ── Request Recording Consent handler ────────────────────────────────────

  const handleRequestRecordingConsent = useCallback(async (): Promise<void> => {
    try {
      await consentRequestMutation.mutateAsync('ai_transcription');
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.alert('Consent request sent — the member will receive an in-app notification.');
      } else {
        Alert.alert(
          'Consent request sent',
          'The member will receive an in-app notification to approve or deny recording.',
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not send consent request.';
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.alert(`Could not send consent request\n\n${message}`);
      } else {
        Alert.alert('Could not send consent request', message);
      }
    }
  }, [consentRequestMutation]);

  const memberName = session.memberName ?? 'Unknown Member';
  const initials = getInitials(memberName);
  const { bg, fg } = avatarColorFor(memberName);

  // Suggested questions drawer context
  const questionsJourney = activeJourney
    ? {
        templateName: activeJourney.template.name,
        currentStepName: activeJourney.currentStep?.stepName ?? '',
        vertical: activeJourney.template.category ?? session.vertical ?? '',
      }
    : undefined;
  const questionsMember = {
    name: memberName,
    age: null,
    initials,
  };

  return (
    <ScrollView
      style={styles.railOuter}
      contentContainerStyle={styles.railContent}
      showsVerticalScrollIndicator={false}
      accessibilityRole={"complementary" as any}
      accessibilityLabel="Member context"
    >
      {/* 1. Active Journey */}
      <Card style={styles.railCard}>
        <SectionHeader title="Active Journey" marginBottom={spacing.md} />
        <Text style={styles.railJourneyName} numberOfLines={1}>
          {journeyName} · {journeyPercent}%
        </Text>
        <View
          style={styles.progressTrack}
          accessibilityRole="progressbar"
          accessibilityValue={{ min: 0, max: 100, now: journeyPercent }}
          accessibilityLabel={`Journey ${journeyPercent}% complete`}
        >
          <View
            style={[
              styles.progressFill,
              { width: `${journeyPercent}%` as `${number}%`, backgroundColor: tokens.emerald500 },
            ]}
          />
        </View>
        {dueDateCaption ? (
          <Text style={styles.railJourneyStep} numberOfLines={2}>
            {dueDateCaption}
          </Text>
        ) : (
          <Text style={styles.railJourneyPercent}>{journeyPercent}% complete</Text>
        )}
      </Card>

      {/* 2. Top Resource Needs */}
      {topResourceNeeds.length > 0 ? (
        <Card style={styles.railCard}>
          <SectionHeader title="Top Resource Needs" marginBottom={spacing.md} />
          <View style={styles.resourceNeedsList}>
            {topResourceNeeds.map((journey) => {
              const severity = deriveSeverity(journey.progressPercent);
              const pillVariant = severityPillVariant(severity);
              const IconComponent = journeyCategoryIcon(journey.template.category);
              return (
                <View key={journey.id} style={styles.resourceNeedRow}>
                  <View style={styles.resourceNeedIconWrap}>
                    <IconComponent size={14} color={tokens.textSecondary} />
                  </View>
                  <Text style={styles.resourceNeedName} numberOfLines={1}>
                    {journey.template.name}
                  </Text>
                  <Pill variant={pillVariant} size="sm">
                    {severity}
                  </Pill>
                </View>
              );
            })}
          </View>
        </Card>
      ) : null}

      {/* 3. Compass Insight */}
      <View style={styles.insightCard}>
        <View style={styles.insightHeader}>
          <Sparkles size={14} color="#15803d" />
          <Text style={styles.insightTitle}>Compass Insight</Text>
        </View>
        <Text style={styles.insightBody}>{compassInsight}</Text>
      </View>

      {/* 4. Quick Actions */}
      <View style={styles.quickActionsSection}>
        <Text style={styles.quickActionsLabel}>QUICK ACTIONS</Text>
        <View style={styles.quickActionsStack}>
          {/* Open Suggested Questions */}
          <Pressable
            style={({ pressed }) => [styles.quickActionBtn, pressed && styles.quickActionBtnPressed]}
            onPress={() => setQuestionsDrawerOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="Open suggested questions"
          >
            <MessageSquare size={16} color={tokens.textSecondary} />
            <Text style={styles.quickActionBtnText}>Open Suggested Questions</Text>
          </Pressable>

          {/* Add Case Note */}
          <Pressable
            style={({ pressed }) => [styles.quickActionBtn, pressed && styles.quickActionBtnPressed]}
            onPress={() => setCaseNoteModalOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="Add case note"
          >
            <BookOpen size={16} color={tokens.textSecondary} />
            <Text style={styles.quickActionBtnText}>Add Case Note</Text>
          </Pressable>

          {/* Flag this Thread */}
          <Pressable
            style={({ pressed }) => [styles.quickActionBtn, pressed && styles.quickActionBtnPressed]}
            onPress={() => setFlagModalOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="Flag this thread"
          >
            <Flag size={16} color={tokens.textSecondary} />
            <Text style={styles.quickActionBtnText}>Flag this Thread</Text>
          </Pressable>

          {/* Request Recording Consent */}
          <Pressable
            style={({ pressed }) => [
              styles.quickActionBtn,
              pressed && styles.quickActionBtnPressed,
              consentRequestMutation.isPending && styles.quickActionBtnDisabled,
            ]}
            onPress={() => { void handleRequestRecordingConsent(); }}
            disabled={consentRequestMutation.isPending}
            accessibilityRole="button"
            accessibilityLabel="Request recording consent"
          >
            {consentRequestMutation.isPending ? (
              <ActivityIndicator size="small" color={tokens.textSecondary} />
            ) : (
              <FileText size={16} color={tokens.textSecondary} />
            )}
            <Text style={styles.quickActionBtnText}>
              {consentRequestMutation.isPending ? 'Sending…' : 'Request Recording Consent'}
            </Text>
          </Pressable>
        </View>
      </View>

      {/* 5. Generate AI Summary (disabled until session ends) */}
      <View style={styles.aiSummarySection}>
        <TouchableOpacity
          style={styles.aiSummaryBtn}
          disabled
          accessibilityRole="button"
          accessibilityLabel="Generate AI summary — available after session ends"
          accessibilityState={{ disabled: true }}
        >
          <Sparkles size={15} color={tokens.textMuted} />
          <Text style={styles.aiSummaryBtnText}>Generate AI Summary</Text>
        </TouchableOpacity>
        <Text style={styles.aiSummaryCaption}>Available after session ends</Text>
      </View>

      {/* 6. End Session (destructive) */}
      <TouchableOpacity
        style={[styles.endSessionBtn, (endSessionPending || servicesRefused) && styles.endSessionBtnDisabled]}
        onPress={handleEndSession}
        disabled={endSessionPending}
        accessibilityRole="button"
        accessibilityLabel={
          servicesRefused
            ? 'End session disabled — member has refused services'
            : endSessionPending
            ? 'Ending session…'
            : 'End session'
        }
        accessibilityState={{ disabled: endSessionPending || servicesRefused }}
      >
        {endSessionPending ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <LogOut size={16} color="#fff" />
        )}
        <Text style={styles.endSessionBtnText}>
          {endSessionPending ? 'Ending…' : 'End Session'}
        </Text>
      </TouchableOpacity>

      {/* 7. Services Consent (informational) */}
      <View style={styles.railConsentSection}>
        <SectionHeader title="Services Consent" marginBottom={spacing.sm} />
        <ServicesConsentStatus
          consentValue={consentValue}
          isLoading={consentQuery.isLoading && consentQuery.fetchStatus !== 'idle'}
        />
      </View>

      {/* Modals */}
      <OpenQuestionsDrawer
        visible={questionsDrawerOpen}
        onClose={() => setQuestionsDrawerOpen(false)}
        member={questionsMember}
        journey={questionsJourney}
      />

      {session.memberId ? (
        <FlagThreadModal
          memberId={session.memberId}
          visible={flagModalOpen}
          onClose={() => setFlagModalOpen(false)}
        />
      ) : null}

      {session.memberId ? (
        <CaseNoteModal
          memberId={session.memberId}
          sessionId={session.id}
          visible={caseNoteModalOpen}
          onClose={() => setCaseNoteModalOpen(false)}
        />
      ) : null}
    </ScrollView>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

/**
 * CHWMessagesScreen — 3-pane messaging inbox.
 *
 * Panes:
 *   ThreadListPane      — thread list with search + 4 filter tabs
 *   ConversationPane    — message thread + templates + composer + Complete Session button
 *   MemberContextRail  — journey, resource needs, Compass Insight, quick actions, End Session
 */
export function CHWMessagesScreen(): React.JSX.Element {
  const { userName } = useAuth();
  const { width } = useWindowDimensions();

  const sessionsQuery = useSessions();
  const [selectedSession, setSelectedSession] = useState<SessionData | null>(null);
  const [showThreadList, setShowThreadList] = useState(true);
  const [documentingSessionId, setDocumentingSessionId] = useState<string | null>(null);

  // Route params — navigate from CHWMemberProfileScreen with memberId + autoCall
  const route = useRoute<RouteProp<CHWSessionsStackParamList, 'Messages'>>();
  const targetMemberId = route.params?.memberId;
  const shouldAutoCall = route.params?.autoCall === true;
  const autoCallFiredRef = useRef(false);

  const hideRail = width < BP_HIDE_RAIL;
  const hideList = width < BP_HIDE_LIST;

  // Resizable pane widths (web only, persisted via localStorage)
  const [leftWidth, setLeftWidth] = useState<number>(() =>
    readStoredWidth(LS_KEY_CHW_LEFT, THREAD_LIST_WIDTH),
  );
  const [rightWidth, setRightWidth] = useState<number>(() =>
    readStoredWidth(LS_KEY_CHW_RIGHT, CONTEXT_RAIL_WIDTH),
  );

  const handleLeftWidthChange = useCallback((next: number): void => {
    setLeftWidth(next);
    writeStoredWidth(LS_KEY_CHW_LEFT, next);
  }, []);

  const handleRightWidthChange = useCallback((next: number): void => {
    setRightWidth(next);
    writeStoredWidth(LS_KEY_CHW_RIGHT, next);
  }, []);

  const allSessions: SessionData[] = sessionsQuery.data ?? [];

  // Auto-select target member's thread or first thread alphabetically
  useEffect(() => {
    if (allSessions.length === 0) return;

    if (targetMemberId) {
      const match = allSessions.find((s) => s.memberId === targetMemberId);
      if (match && selectedSession?.id !== match.id) {
        setSelectedSession(match);
        return;
      }
    }

    if (!selectedSession) {
      const firstAlpha = [...allSessions]
        .filter((s) => !!s.memberName)
        .sort((a, b) => (a.memberName ?? '').localeCompare(b.memberName ?? ''))[0];
      setSelectedSession(firstAlpha ?? null);
    }
  }, [allSessions, selectedSession, targetMemberId]);

  const handleSelectSession = useCallback(
    (session: SessionData): void => {
      setSelectedSession(session);
      if (hideList) {
        setShowThreadList(false);
      }
    },
    [hideList],
  );

  const handleBack = useCallback((): void => {
    setShowThreadList(true);
  }, []);

  // After End Session completes — open DocumentationModal automatically
  const handleEndSessionComplete = useCallback((): void => {
    if (selectedSession) {
      setDocumentingSessionId(selectedSession.id);
    }
  }, [selectedSession]);

  const submitDocumentation = useSubmitDocumentation();

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
        if (Platform.OS === 'web' && typeof window !== 'undefined') {
          window.alert(
            `Failed to submit documentation\n\n${reason}\n\nThe modal will stay open so you can adjust and try again.`,
          );
        } else {
          Alert.alert('Failed to submit documentation', reason);
        }
      }
    },
    [documentingSessionId, submitDocumentation],
  );

  const shellUserBlock = {
    initials: (userName ?? 'CHW')
      .split(' ')
      .slice(0, 2)
      .map((p) => p[0] ?? '')
      .join('')
      .toUpperCase(),
    name: userName ?? 'CHW',
    role: 'CHW' as const,
  };

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
        {/* Left: thread list */}
        {shouldShowList ? (
          <View style={[styles.threadListWrap, { width: !hideRail ? leftWidth : THREAD_LIST_WIDTH }]}>
            <ThreadListPane
              sessions={allSessions}
              selectedSessionId={selectedSession?.id ?? null}
              onSelectSession={handleSelectSession}
            />
          </View>
        ) : null}

        {/* Divider between left and center */}
        {shouldShowList && shouldShowConv ? (
          <ResizableDivider
            width={leftWidth}
            onChange={handleLeftWidthChange}
            min={CHW_LEFT_MIN}
            max={CHW_LEFT_MAX}
          />
        ) : null}

        {/* Center: conversation */}
        {shouldShowConv && selectedSession ? (
          <View style={styles.convPaneWrap}>
            <ConversationPane
              key={selectedSession.id}
              session={selectedSession}
              onBack={handleBack}
              showBackButton={hideList}
              autoCallOnMount={
                shouldAutoCall &&
                !autoCallFiredRef.current &&
                selectedSession.memberId === targetMemberId
              }
              onAutoCallConsumed={() => {
                autoCallFiredRef.current = true;
              }}
              onRequestOpenDocumentation={() => {
                setDocumentingSessionId(selectedSession.id);
              }}
            />
          </View>
        ) : shouldShowConv ? (
          <View style={styles.noSelectionWrap}>
            <Text style={styles.noSelectionText}>
              Select a thread to start messaging
            </Text>
          </View>
        ) : null}

        {/* Divider between center and right */}
        {!hideRail && selectedSession ? (
          <ResizableDivider
            width={rightWidth}
            onChange={handleRightWidthChange}
            min={CHW_RIGHT_MIN}
            max={CHW_RIGHT_MAX}
            side="right"
          />
        ) : null}

        {/* Right: member context rail */}
        {!hideRail && selectedSession ? (
          <View style={[styles.railWrap, { width: rightWidth }]}>
            <MemberContextRail
              session={selectedSession}
              onEndSessionComplete={handleEndSessionComplete}
            />
          </View>
        ) : null}
      </View>

      {/* Documentation modal triggered by End Session */}
      {documentingSessionId != null && (
        <DocumentationModal
          visible={documentingSessionId != null}
          onClose={() => setDocumentingSessionId(null)}
          sessionId={documentingSessionId}
          durationMinutes={selectedSession?.durationMinutes ?? null}
          onSubmit={handleDocumentationSubmit}
        />
      )}
    </AppShell>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // ── Root layout ─────────────────────────────────────────────────────────────
  root: {
    flex: 1,
    flexDirection: 'row',
    backgroundColor: tokens.pageBg,
    overflow: 'hidden',
  } as ViewStyle,

  loadingWrap: {
    flex: 1,
    padding: spacing.xxl,
  } as ViewStyle,

  // ── Thread list pane ─────────────────────────────────────────────────────────
  threadListWrap: {
    backgroundColor: tokens.cardBg,
    borderRightWidth: 1,
    borderRightColor: tokens.cardBorder,
    flexShrink: 0,
  } as ViewStyle,

  threadListPane: {
    flex: 1,
    flexDirection: 'column',
  } as ViewStyle,

  threadListHeader: {
    padding: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
    gap: spacing.sm,
  } as ViewStyle,

  threadListTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: tokens.textPrimary,
  } as TextStyle,

  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: tokens.pageBg,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  } as ViewStyle,

  searchIcon: {
    marginRight: spacing.sm,
  } as ViewStyle,

  searchInput: {
    flex: 1,
    fontSize: 14,
    color: tokens.textPrimary,
    paddingVertical: spacing.sm,
    outlineStyle: 'none',
  } as unknown as TextStyle,

  filterRow: {
    flexShrink: 0,
  } as ViewStyle,

  filterRowContent: {
    flexDirection: 'row',
    gap: spacing.xs,
  } as ViewStyle,

  filterChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
  } as ViewStyle,

  filterChipActive: {
    backgroundColor: tokens.emerald100,
  } as ViewStyle,

  filterChipText: {
    fontSize: 12,
    fontWeight: '500',
    color: tokens.textSecondary,
  } as TextStyle,

  filterChipTextActive: {
    color: tokens.emerald700,
    fontWeight: '600',
  } as TextStyle,

  threadScrollView: {
    flex: 1,
  } as ViewStyle,

  emptyState: {
    padding: spacing.xxl,
    alignItems: 'center',
  } as ViewStyle,

  emptyStateText: {
    fontSize: 14,
    color: tokens.textMuted,
    textAlign: 'center',
  } as TextStyle,

  // ── Thread row ────────────────────────────────────────────────────────────────
  threadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  } as ViewStyle,

  threadRowActive: {
    backgroundColor: '#ECFDF5',
    borderLeftWidth: 3,
    borderLeftColor: tokens.primary,
    paddingLeft: 13,
  } as ViewStyle,

  threadAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,

  threadAvatarText: {
    fontSize: 13,
    fontWeight: '700',
  } as TextStyle,

  threadBody: {
    flex: 1,
    minWidth: 0,
  } as ViewStyle,

  threadTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: 3,
  } as ViewStyle,

  threadName: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: tokens.textPrimary,
  } as TextStyle,

  threadTimestamp: {
    fontSize: 11,
    color: tokens.textMuted,
    flexShrink: 0,
  } as TextStyle,

  threadPreview: {
    fontSize: 12,
    color: tokens.textSecondary,
  } as TextStyle,

  unreadIndicator: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: tokens.primary,
    flexShrink: 0,
  } as ViewStyle,

  // ── Conversation pane ─────────────────────────────────────────────────────────
  convPaneWrap: {
    flex: 1,
    minWidth: 0,
  } as ViewStyle,

  convPane: {
    flex: 1,
    flexDirection: 'column',
    backgroundColor: tokens.pageBg,
    overflow: 'hidden',
  } as ViewStyle,

  convHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingVertical: 14,
    backgroundColor: tokens.cardBg,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  } as ViewStyle,

  backBtn: {
    padding: spacing.sm,
    borderRadius: radius.sm,
  } as ViewStyle,

  convHeaderAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,

  convHeaderAvatarText: {
    fontSize: 15,
    fontWeight: '700',
  } as TextStyle,

  convHeaderInfo: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  } as ViewStyle,

  convHeaderNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flexWrap: 'wrap',
  } as ViewStyle,

  convHeaderName: {
    fontSize: 16,
    fontWeight: '600',
    color: tokens.textPrimary,
  } as TextStyle,

  convHeaderMeta: {
    fontSize: 12,
    color: tokens.textSecondary,
  } as TextStyle,

  iconBtn: {
    padding: spacing.sm,
    borderRadius: radius.sm,
  } as ViewStyle,

  iconBtnDisabled: {
    opacity: 0.5,
  } as ViewStyle,

  openProfileBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: radius.sm,
  } as ViewStyle,

  openProfileText: {
    fontSize: 13,
    fontWeight: '600',
    color: tokens.gray700,
  } as TextStyle,

  // ── Messages ──────────────────────────────────────────────────────────────────
  messagesScrollView: {
    flex: 1,
  } as ViewStyle,

  messagesContent: {
    padding: spacing.xl,
    gap: spacing.xs,
  } as ViewStyle,

  emptyMessages: {
    flex: 1,
    alignItems: 'center',
    paddingTop: 40,
  } as ViewStyle,

  emptyMessagesText: {
    fontSize: 14,
    color: tokens.textMuted,
  } as TextStyle,

  daySeparator: {
    alignItems: 'center',
    marginVertical: spacing.md,
  } as ViewStyle,

  daySeparatorText: {
    fontSize: 12,
    color: tokens.textMuted,
  } as TextStyle,

  bubbleRowOutbound: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginBottom: 6,
  } as ViewStyle,

  bubbleRowInbound: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    marginBottom: 6,
  } as ViewStyle,

  bubble: {
    maxWidth: '75%',
    padding: 10,
    paddingHorizontal: 14,
    gap: spacing.xs,
  } as ViewStyle,

  bubbleOutbound: {
    backgroundColor: tokens.emerald500,
    borderRadius: 18,
    borderBottomRightRadius: 4,
  } as ViewStyle,

  bubbleInbound: {
    backgroundColor: '#F3F4F6',
    borderRadius: 18,
    borderBottomLeftRadius: 4,
  } as ViewStyle,

  bubbleText: {
    fontSize: 14,
    lineHeight: 20,
  } as TextStyle,

  bubbleTextOutbound: {
    color: '#fff',
  } as TextStyle,

  bubbleTextInbound: {
    color: tokens.textPrimary,
  } as TextStyle,

  bubbleTimestamp: {
    fontSize: 10,
    marginTop: 2,
  } as TextStyle,

  bubbleTimestampOutbound: {
    color: 'rgba(255,255,255,0.7)',
    textAlign: 'right',
  } as TextStyle,

  bubbleTimestampInbound: {
    color: tokens.textMuted,
  } as TextStyle,

  attachmentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  } as ViewStyle,

  // ── Composer ──────────────────────────────────────────────────────────────────
  composerWrap: {
    padding: 14,
    backgroundColor: tokens.cardBg,
    borderTopWidth: 1,
    borderTopColor: '#E5E7EB',
    gap: spacing.sm,
  } as ViewStyle,

  templateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.xs,
  } as ViewStyle,

  templateLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: tokens.textMuted,
    letterSpacing: 0.5,
    marginRight: 2,
  } as TextStyle,

  templateChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: radius.pill,
  } as ViewStyle,

  templateChipText: {
    fontSize: 12,
    color: tokens.textSecondary,
    fontWeight: '500',
  } as TextStyle,

  composerInner: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
    backgroundColor: tokens.pageBg,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: radius.lg,
    padding: 10,
  } as ViewStyle,

  composerIconBtn: {
    padding: 6,
    borderRadius: radius.sm,
  } as ViewStyle,

  composerInput: {
    flex: 1,
    fontSize: 14,
    color: tokens.textPrimary,
    paddingVertical: 6,
    minHeight: 36,
    maxHeight: 100,
    outlineStyle: 'none',
  } as unknown as TextStyle,

  sendBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: tokens.primary,
    paddingHorizontal: 14,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
  } as ViewStyle,

  sendBtnDisabled: {
    opacity: 0.4,
  } as ViewStyle,

  sendBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#fff',
  } as TextStyle,

  // "Complete Session" — happy-path CTA (green, not red)
  completeSessionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    backgroundColor: tokens.primary,
    borderRadius: radius.md,
  } as ViewStyle,

  completeSessionBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#fff',
  } as TextStyle,

  composerMeta: {
    fontSize: 11,
    color: tokens.textMuted,
    textAlign: 'center',
  } as TextStyle,

  // ── No selection ──────────────────────────────────────────────────────────────
  noSelectionWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,

  noSelectionText: {
    fontSize: 14,
    color: tokens.textMuted,
  } as TextStyle,

  // ── Member context rail ───────────────────────────────────────────────────────
  railWrap: {
    backgroundColor: tokens.cardBg,
    borderLeftWidth: 1,
    borderLeftColor: tokens.cardBorder,
    flexShrink: 0,
  } as ViewStyle,

  railOuter: {
    flex: 1,
    backgroundColor: tokens.cardBg,
  } as ViewStyle,

  railContent: {
    padding: spacing.xl,
    gap: spacing.md,
    paddingBottom: spacing.xxxl,
  } as ViewStyle,

  railCard: {
    padding: spacing.lg,
  } as ViewStyle,

  // Journey card
  railJourneyName: {
    fontSize: 14,
    fontWeight: '600',
    color: tokens.textPrimary,
    marginBottom: spacing.sm,
  } as TextStyle,

  railJourneyStep: {
    fontSize: 12,
    color: tokens.textSecondary,
    marginTop: spacing.xs,
  } as TextStyle,

  progressTrack: {
    height: 8,
    backgroundColor: '#E5E7EB',
    borderRadius: radius.pill,
    overflow: 'hidden',
    marginBottom: spacing.xs,
  } as ViewStyle,

  progressFill: {
    height: 8,
    borderRadius: radius.pill,
  } as ViewStyle,

  railJourneyPercent: {
    fontSize: 11,
    color: tokens.textMuted,
  } as TextStyle,

  // Resource needs
  resourceNeedsList: {
    gap: spacing.sm,
  } as ViewStyle,

  resourceNeedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  } as ViewStyle,

  resourceNeedIconWrap: {
    width: 24,
    height: 24,
    borderRadius: 6,
    backgroundColor: tokens.gray100,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,

  resourceNeedName: {
    flex: 1,
    fontSize: 13,
    color: tokens.textPrimary,
    fontWeight: '500',
  } as TextStyle,

  // Compass Insight card
  insightCard: {
    backgroundColor: '#F0FDF4',
    borderWidth: 1,
    borderColor: '#BBF7D0',
    borderRadius: radius.xl,
    padding: spacing.lg,
    gap: spacing.sm,
  } as ViewStyle,

  insightHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  } as ViewStyle,

  insightTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#14532D',
  } as TextStyle,

  insightBody: {
    fontSize: 13,
    color: '#14532D',
    lineHeight: 18,
  } as TextStyle,

  // Quick Actions
  quickActionsSection: {
    gap: spacing.sm,
  } as ViewStyle,

  quickActionsLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: tokens.textMuted,
    letterSpacing: 0.8,
  } as TextStyle,

  quickActionsStack: {
    gap: spacing.xs,
  } as ViewStyle,

  quickActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: radius.md,
    backgroundColor: tokens.cardBg,
  } as ViewStyle,

  quickActionBtnPressed: {
    backgroundColor: tokens.gray100,
  } as ViewStyle,

  quickActionBtnDisabled: {
    opacity: 0.5,
  } as ViewStyle,

  quickActionBtnText: {
    fontSize: 13,
    fontWeight: '500',
    color: tokens.textPrimary,
    flex: 1,
  } as TextStyle,

  // Generate AI Summary
  aiSummarySection: {
    gap: 4,
  } as ViewStyle,

  aiSummaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: radius.md,
    backgroundColor: tokens.gray100,
    opacity: 0.6,
  } as ViewStyle,

  aiSummaryBtnText: {
    fontSize: 13,
    fontWeight: '500',
    color: tokens.textMuted,
  } as TextStyle,

  aiSummaryCaption: {
    fontSize: 11,
    color: tokens.textMuted,
    textAlign: 'center',
  } as TextStyle,

  // End Session (destructive)
  endSessionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: 12,
    paddingHorizontal: spacing.lg,
    backgroundColor: tokens.red700,
    borderRadius: radius.lg,
  } as ViewStyle,

  endSessionBtnDisabled: {
    opacity: 0.5,
  } as ViewStyle,

  endSessionBtnText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#fff',
  } as TextStyle,

  // Consent section
  railConsentSection: {
    gap: spacing.xs,
  } as ViewStyle,
});

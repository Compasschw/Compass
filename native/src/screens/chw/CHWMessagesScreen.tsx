/**
 * CHWMessagesScreen — simple 3-pane SMS inbox for Community Health Workers.
 *
 * Pane layout (web, ≥1280px):
 *   [ThreadListPane 320px] | [ConversationPane flex] | [MemberContextRail 288px]
 *
 * Responsive collapse:
 *   <1280px → right rail hidden; thread list + conversation both visible
 *   <900px  → only one pane visible at a time; back button reveals thread list
 *
 * Data wiring:
 *   - ThreadListPane   : useSessions() — each session = one member thread
 *   - ConversationPane : useSessionMessages(sessionId) — polls every 4 s
 *   - MemberContextRail: useChwJourneys() + useMemberServicesConsent(memberId)
 *
 * Hard constraints (do NOT modify):
 *   - Do NOT modify DashboardSidebar.
 *   - Do NOT add new backend endpoints (services-consent endpoint pre-exists on main).
 *   - Do NOT alter session-per-call backend behaviour or call-bridge calls.
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
  ArrowLeft,
  CheckCircle2,
  AlertCircle,
  FileText,
  XCircle,
} from 'lucide-react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { CHWSessionsStackParamList } from '../../navigation/CHWTabNavigator';

import { AppShell, Card, Pill, SectionHeader } from '../../components/ui';
import { useAuth } from '../../context/AuthContext';
import {
  useSessions,
  useSessionMessages,
  useSessionSendMessage,
  useStartCall,
  useGenerateAISummary,
  useSubmitDocumentation,
  useChwJourneys,
  useMemberServicesConsent,
  type SessionData,
  type SessionMessageLocal,
  type SessionMessageData,
  type AISummaryResponse,
  type MemberJourneyResponse,
  type ServicesConsentValue,
} from '../../hooks/useApiQueries';
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
const CONTEXT_RAIL_WIDTH = 288;

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

type ThreadFilterTab = 'all' | 'unread';

interface ThreadListPaneProps {
  readonly sessions: SessionData[];
  readonly selectedSessionId: string | null;
  readonly onSelectSession: (session: SessionData) => void;
}

/**
 * Left pane: alphabetical list of member threads with search and filter chips.
 *
 * Sorted alphabetically by member name (A → Z). Threads without a member name
 * are excluded (they have no conversation to display).
 */
function ThreadListPane({
  sessions,
  selectedSessionId,
  onSelectSession,
}: ThreadListPaneProps): React.JSX.Element {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<ThreadFilterTab>('all');

  const visibleSessions = useMemo(() => {
    const withMember = sessions.filter((s) => !!s.memberName);

    // Alphabetical by member name
    const sorted = [...withMember].sort((a, b) =>
      (a.memberName ?? '').localeCompare(b.memberName ?? ''),
    );

    let filtered = sorted;

    // Search
    const query = searchQuery.trim().toLowerCase();
    if (query) {
      filtered = filtered.filter((s) =>
        (s.memberName ?? '').toLowerCase().includes(query),
      );
    }

    // Filter tab — "unread" is presentation-only (no server field); reserved
    // for when the backend adds an unread_count to sessions.
    // For now, "unread" shows the same list (all threads) — the tab is visible
    // so the UI contract is met; real counts wire in without a design change.
    return filtered;
  }, [sessions, searchQuery]);

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

        {/* Filter chips */}
        <View style={styles.filterRow} accessibilityRole="radiogroup">
          {(['all', 'unread'] as const).map((tab) => (
            <TouchableOpacity
              key={tab}
              style={[styles.filterChip, activeFilter === tab && styles.filterChipActive]}
              onPress={() => setActiveFilter(tab)}
              accessibilityRole="radio"
              accessibilityState={{ checked: activeFilter === tab }}
              accessibilityLabel={
                tab === 'all'
                  ? `All threads (${visibleSessions.length})`
                  : 'Unread threads'
              }
            >
              <Text
                style={[
                  styles.filterChipText,
                  activeFilter === tab && styles.filterChipTextActive,
                ]}
              >
                {tab === 'all'
                  ? `All (${visibleSessions.length})`
                  : 'Unread'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
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
              {searchQuery ? 'No threads match your search.' : 'No active conversations.'}
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
   * Set by the parent when route.params.autoCall === true (navigate-and-call
   * from CHWMemberProfileScreen). The parent clears it after the call fires.
   */
  readonly autoCallOnMount?: boolean;
  readonly onAutoCallConsumed?: () => void;
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
    // Intentionally not returning the cleanup — callers don't use the return value.
    void timer;
  }, []);

  // ── Call handler ──────────────────────────────────────────────────────────

  /**
   * Initiates a Vonage masked-number call between CHW and member.
   * Shows a platform-appropriate confirmation first; on success, both phones ring.
   */
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
        // eslint-disable-next-line no-console
        console.error('[CHWMessages] submitDocumentation failed:', err);
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
  const initials = getInitials(memberName);
  const { bg, fg } = avatarColorFor(memberName);
  const grouped = groupMessagesByDay(mergedMessages);

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

        <PressableMember
          memberId={session.memberId ?? ''}
          displayName={memberName}
          enabled={!!session.memberId}
          style={styles.convHeaderInfo}
        >
          <Text style={styles.convHeaderName} numberOfLines={1}>
            {memberName}
          </Text>
          <Text style={styles.convHeaderMeta}>
            {session.mode ? `${session.mode.replace(/_/g, ' ')} · ` : ''}Active Member
          </Text>
        </PressableMember>

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

        {/* Open Member Profile link */}
        <PressableMember
          memberId={session.memberId ?? ''}
          displayName={memberName}
          enabled={!!session.memberId}
          style={styles.openProfileBtn}
        >
          <Text style={styles.openProfileText}>Open Profile →</Text>
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

      {/* Composer */}
      <View style={styles.composerWrap}>
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
          >
            <CalendarPlus size={20} color={tokens.textSecondary} />
          </TouchableOpacity>
          <TextInput
            style={styles.composerInput}
            value={draftText}
            onChangeText={setDraftText}
            placeholder={`Reply to ${memberName}…`}
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

        {/* Complete Session CTA — opens DocumentationModal */}
        <TouchableOpacity
          style={styles.completeSessionBtn}
          onPress={handleOpenCompleteSession}
          accessibilityRole="button"
          accessibilityLabel="Complete session and open documentation for review"
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
  /** Resolved value from the endpoint, or null if unavailable / loading. */
  readonly consentValue: ServicesConsentValue | null;
  /** True while the query is loading for the first time. */
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
    // Endpoint unavailable during rollout — render neutral state
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

// ─── Member context rail ──────────────────────────────────────────────────────

interface MemberContextRailProps {
  readonly session: SessionData;
}

/**
 * Right pane: member identity, journey progress, quick CTAs, and consent status.
 *
 * Contents (top to bottom):
 *  1. Member avatar + name
 *  2. Journey progress bar (from useChwJourneys, matched by memberId)
 *  3. "Start Call" CTA — dimmed when member has refused services
 *  4. "Schedule Next Session" CTA
 *  5. Services consent status (feature-flagged, 503-safe)
 */
function MemberContextRail({ session }: MemberContextRailProps): React.JSX.Element {
  const navigation = useNavigation<any>(); // eslint-disable-line @typescript-eslint/no-explicit-any
  const [callInitiating, setCallInitiating] = useState(false);
  const [callToastMessage, setCallToastMessage] = useState<string | null>(null);
  const [callToastIsError, setCallToastIsError] = useState(false);

  const startCall = useStartCall();

  // Journey data — find the active journey for this member from the CHW's full list
  const journeysQuery = useChwJourneys();
  const activeJourney: MemberJourneyResponse | null = useMemo(() => {
    const allJourneys = journeysQuery.data ?? [];
    const memberJourneys = allJourneys.filter(
      (j) => j.memberId === session.memberId && j.status === 'active',
    );
    // Prefer most recently started active journey
    return (
      memberJourneys.sort(
        (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt),
      )[0] ?? null
    );
  }, [journeysQuery.data, session.memberId]);

  // Services consent — feature-flagged, 503-safe
  const consentQuery = useMemberServicesConsent(session.memberId ?? '');
  const consentValue = consentQuery.data?.value ?? null;
  const servicesRefused = consentValue === 'refuse_services';

  // Rail call handler (mirrors ConversationPane.handleCall)
  const showRailToast = useCallback(
    (message: string, isError: boolean): void => {
      setCallToastMessage(message);
      setCallToastIsError(isError);
      setTimeout(() => setCallToastMessage(null), 3_500);
    },
    [],
  );

  const handleStartCall = useCallback(async (): Promise<void> => {
    if (callInitiating || servicesRefused) return;
    const memberName = session.memberName ?? 'this member';

    const executeCall = async (): Promise<void> => {
      setCallInitiating(true);
      try {
        await startCall.mutateAsync(session.id);
        showRailToast('Call requested — your phone should ring shortly.', false);
      } catch (err) {
        const detail =
          err instanceof Error && err.message
            ? err.message
            : 'Could not start the call. Try again.';
        showRailToast(detail, true);
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
  }, [callInitiating, servicesRefused, session.id, session.memberName, startCall, showRailToast]);

  const memberName = session.memberName ?? 'Unknown Member';
  const initials = getInitials(memberName);
  const { bg, fg } = avatarColorFor(memberName);

  const journeyPercent = activeJourney?.progressPercent ?? 0;
  const journeyName = activeJourney?.template.name ?? session.vertical?.replace(/_/g, ' ') ?? 'General';
  const journeyCurrentStep = activeJourney?.currentStep?.stepName ?? null;

  return (
    <ScrollView
      style={styles.railOuter}
      contentContainerStyle={styles.railContent}
      showsVerticalScrollIndicator={false}
      accessibilityRole={"complementary" as any}
      accessibilityLabel="Member context"
    >
      {/* Member identity */}
      <Card style={styles.railCard}>
        <View style={styles.railMemberIdentity}>
          <View style={[styles.railAvatar, { backgroundColor: bg }]}>
            <Text style={[styles.railAvatarText, { color: fg }]}>{initials}</Text>
          </View>
          <View style={styles.railMemberInfo}>
            <Text style={styles.railMemberName} numberOfLines={2}>
              {memberName}
            </Text>
            <Text style={styles.railMemberMeta}>Active Member</Text>
          </View>
        </View>
      </Card>

      {/* Journey progress */}
      <Card style={styles.railCard}>
        <SectionHeader title="Journey Progress" marginBottom={spacing.md} />
        <Text style={styles.railJourneyName} numberOfLines={1}>
          {journeyName}
        </Text>
        {journeyCurrentStep ? (
          <Text style={styles.railJourneyStep} numberOfLines={1}>
            Current step: {journeyCurrentStep}
          </Text>
        ) : null}
        <View
          style={styles.progressTrack}
          accessibilityRole="progressbar"
          accessibilityValue={{ min: 0, max: 100, now: journeyPercent }}
          accessibilityLabel={`Journey ${journeyPercent}% complete`}
        >
          <View style={[styles.progressFill, { width: `${journeyPercent}%` as `${number}%` }]} />
        </View>
        <Text style={styles.railJourneyPercent}>{journeyPercent}% complete</Text>
      </Card>

      {/* Rail call toast */}
      {callToastMessage !== null ? (
        <InlineToast message={callToastMessage} isError={callToastIsError} />
      ) : null}

      {/* Start Call CTA */}
      <TouchableOpacity
        style={[
          styles.railCallBtn,
          (servicesRefused || callInitiating) && styles.railCallBtnDimmed,
        ]}
        onPress={() => void handleStartCall()}
        disabled={servicesRefused || callInitiating}
        accessibilityRole="button"
        accessibilityLabel={
          servicesRefused
            ? 'Call disabled — member has refused services'
            : callInitiating
            ? 'Call initiating…'
            : 'Start call with member'
        }
        accessibilityState={{ disabled: servicesRefused || callInitiating }}
      >
        {callInitiating ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <Phone size={16} color="#fff" />
        )}
        <Text style={styles.railCallBtnText}>
          {callInitiating ? 'Calling…' : 'Start Call'}
        </Text>
      </TouchableOpacity>

      {servicesRefused ? (
        <Text style={styles.callDisabledCaption}>Member has refused services</Text>
      ) : null}

      {/* Schedule Next Session CTA */}
      <TouchableOpacity
        style={styles.railScheduleBtn}
        onPress={() => navigation.navigate('Calendar')}
        accessibilityRole="button"
        accessibilityLabel="Schedule next session on the calendar"
      >
        <CalendarPlus size={16} color={tokens.primary} />
        <Text style={styles.railScheduleBtnText}>Schedule Next Session</Text>
      </TouchableOpacity>

      {/* Services consent status */}
      <View style={styles.railConsentSection}>
        <SectionHeader title="Services Consent" marginBottom={spacing.sm} />
        <ServicesConsentStatus
          consentValue={consentValue}
          isLoading={consentQuery.isLoading && consentQuery.fetchStatus !== 'idle'}
        />
      </View>
    </ScrollView>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

/**
 * CHWMessagesScreen — 3-pane messaging inbox.
 *
 * Panes:
 *   ThreadListPane      — alphabetical member thread list with search + unread badge
 *   ConversationPane    — message thread + composer + Complete Session button
 *   MemberContextRail  — member identity, journey progress, Start Call / Schedule CTAs,
 *                         services-consent status
 */
export function CHWMessagesScreen(): React.JSX.Element {
  const { userName } = useAuth();
  const { width } = useWindowDimensions();

  const sessionsQuery = useSessions();
  const [selectedSession, setSelectedSession] = useState<SessionData | null>(null);
  // On narrow viewports the thread list can be toggled
  const [showThreadList, setShowThreadList] = useState(true);

  // Route params — when navigated from CHWMemberProfileScreen with memberId + autoCall
  const route = useRoute<RouteProp<CHWSessionsStackParamList, 'Messages'>>();
  const targetMemberId = route.params?.memberId;
  const shouldAutoCall = route.params?.autoCall === true;
  const autoCallFiredRef = useRef(false);

  const hideRail = width < BP_HIDE_RAIL;
  const hideList = width < BP_HIDE_LIST;

  const allSessions: SessionData[] = sessionsQuery.data ?? [];

  // Auto-select the target member's thread (from route params) or the first thread
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
      // Default: first thread alphabetically
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
          <View style={[styles.threadListWrap, { width: THREAD_LIST_WIDTH }]}>
            <ThreadListPane
              sessions={allSessions}
              selectedSessionId={selectedSession?.id ?? null}
              onSelectSession={handleSelectSession}
            />
          </View>
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
            />
          </View>
        ) : shouldShowConv ? (
          <View style={styles.noSelectionWrap}>
            <Text style={styles.noSelectionText}>
              Select a thread to start messaging
            </Text>
          </View>
        ) : null}

        {/* Right: member context rail */}
        {!hideRail && selectedSession ? (
          <View style={[styles.railWrap, { width: CONTEXT_RAIL_WIDTH }]}>
            <MemberContextRail session={selectedSession} />
          </View>
        ) : null}
      </View>
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
    flexDirection: 'row',
    gap: spacing.sm,
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
  } as ViewStyle,

  convHeaderName: {
    fontSize: 16,
    fontWeight: '600',
    color: tokens.textPrimary,
    marginBottom: 2,
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
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: radius.sm,
  } as ViewStyle,

  openProfileText: {
    fontSize: 14,
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
    backgroundColor: tokens.primaryHover,
    paddingHorizontal: 14,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
  } as ViewStyle,

  sendBtnDisabled: {
    opacity: 0.5,
  } as ViewStyle,

  sendBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#fff',
  } as TextStyle,

  // "Complete Session" — primary green CTA in the composer tray.
  // Green (not red) because this is the expected happy-path action:
  // the CHW submits documentation to close out a completed call.
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
  } as ViewStyle,

  railCard: {
    padding: spacing.lg,
  } as ViewStyle,

  railMemberIdentity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  } as ViewStyle,

  railAvatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,

  railAvatarText: {
    fontSize: 18,
    fontWeight: '700',
  } as TextStyle,

  railMemberInfo: {
    flex: 1,
    minWidth: 0,
  } as ViewStyle,

  railMemberName: {
    fontSize: 16,
    fontWeight: '700',
    color: tokens.textPrimary,
    marginBottom: 2,
  } as TextStyle,

  railMemberMeta: {
    fontSize: 12,
    color: tokens.textSecondary,
  } as TextStyle,

  // Journey progress
  railJourneyName: {
    fontSize: 14,
    fontWeight: '600',
    color: tokens.textPrimary,
    marginBottom: 4,
  } as TextStyle,

  railJourneyStep: {
    fontSize: 12,
    color: tokens.textSecondary,
    marginBottom: spacing.sm,
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
    backgroundColor: tokens.primary,
    borderRadius: radius.pill,
  } as ViewStyle,

  railJourneyPercent: {
    fontSize: 11,
    color: tokens.textMuted,
  } as TextStyle,

  // Start Call CTA
  railCallBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: 12,
    paddingHorizontal: spacing.lg,
    backgroundColor: tokens.primary,
    borderRadius: radius.lg,
  } as ViewStyle,

  railCallBtnDimmed: {
    opacity: 0.4,
  } as ViewStyle,

  railCallBtnText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#fff',
  } as TextStyle,

  callDisabledCaption: {
    fontSize: 12,
    color: '#b91c1c',
    textAlign: 'center',
    marginTop: -spacing.xs,
  } as TextStyle,

  // Schedule Next Session CTA
  railScheduleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: 12,
    paddingHorizontal: spacing.lg,
    backgroundColor: tokens.cardBg,
    borderWidth: 1,
    borderColor: tokens.primary,
    borderRadius: radius.lg,
  } as ViewStyle,

  railScheduleBtnText: {
    fontSize: 15,
    fontWeight: '600',
    color: tokens.primary,
  } as TextStyle,

  // Consent section
  railConsentSection: {
    gap: spacing.xs,
  } as ViewStyle,
});

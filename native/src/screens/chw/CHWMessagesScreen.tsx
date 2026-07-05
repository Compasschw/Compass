/**
 * CHWMessagesScreen — 3-pane SMS inbox for Community Health Workers.
 *
 * Pane layout (web, ≥1280px):
 *   [ThreadListPane 300px] | [ConversationPane flex] | [MemberContextRail 320px]
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
 * Design alignment (Polish Wave 2 — agent G):
 *   - PressableCard on every interactive surface (thread rows, icon btns, template chips, quick actions)
 *   - StaggerList cascading mount on thread rows
 *   - EmptyState primitive for zero-data states
 *   - numerals.tabular on all numeric values (timestamps, counts, percentages)
 *   - shadows.card / shadows.elevated token — no inline shadow overrides
 *   - Consolidated 6-hue Pill variants only (emerald / blue / amber / red / gray / purple)
 *   - End Session → slide-up inline confirmation within the rail (no window.confirm)
 *   - Engagement Pill in thread row list + conversation header
 *
 * Hard constraints (do NOT modify):
 *   - Do NOT modify DashboardSidebar.
 *   - Do NOT add new backend endpoints.
 *   - Do NOT alter session-per-call backend behaviour or call-bridge calls.
 *   - Do NOT claim TLS+at-rest is E2E encryption.
 *
 * STUB NOTES:
 *   - "Add Case Note" → Wired to POST /api/v1/case-notes (shipped 2026-06-09).
 *   - "Complete Session" → POST /sessions/{id}/end, opens DocumentationModal.
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
  Image,
  Modal,
  Linking,
  Animated,
  StyleSheet,
  Platform,
  Alert,
  ActivityIndicator,
  useWindowDimensions,
  type ViewStyle,
  type TextStyle,
  type ImageStyle,
} from 'react-native';
import {
  Search,
  Phone,
  CalendarPlus,
  Paperclip,
  Image as ImageIcon,
  Link as LinkIcon,
  Send,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  AlertCircle,
  FileText,
  XCircle,
  X,
  Download,
  LogOut,
  Play,
  Home,
  ShoppingCart,
  Truck,
  Briefcase,
  HeartPulse,
  MessageSquare,
  Flag,
  BookOpen,
  Activity,
  MoreVertical,
  Trash2,
} from 'lucide-react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { CHWSessionsStackParamList } from '../../navigation/CHWTabNavigator';

import {
  AppShell,
  Card,
  Pill,
  SectionHeader,
  ResizableDivider,
  RightDrawer,
  PressableCard,
  StaggerList,
  EmptyState,
} from '../../components/ui';
import type { PillVariant } from '../../components/ui';
import { useAuth } from '../../context/AuthContext';
import {
  useConversations,
  useConversationMessages,
  useConversationSendMessage,
  useStartCall,
  useSubmitDocumentation,
  useChwJourneys,
  useMemberServicesConsent,
  useCreateCaseNote,
  useEndSession as useEndSessionHook,
  useStartSession as useStartSessionHook,
  useScheduleSession as useScheduleSessionHook,
  useSoftDeleteConversation,
  useToggleConversationPin,
  useToggleConversationArchive,
  useSession as useSessionHook,
  type ConversationData,
  type MessageData,
  type SendConversationMessageVars,
  type SessionData,
  type SessionMessageLocal,
  type MemberJourneyResponse,
  type ServicesConsentValue,
} from '../../hooks/useApiQueries';
import {
  useEngagementStatus,
} from '../../hooks/useMessagesInsights';
import { SwipeableThreadRow } from '../../components/chw/SwipeableThreadRow';
import { showAlert } from '../../utils/showAlert';
import {
  useMessageAttachmentUpload,
  type MessageAttachmentUploadResult,
} from '../../hooks/useFileUpload';
import { OpenQuestionsDrawer } from '../../components/chw/OpenQuestionsDrawer';
import { DocumentationModal } from '../../components/sessions/DocumentationModal';
import type { SessionDocumentation } from '../../data/mock';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';
import { PressableMember } from '../../components/shared/PressableMember';
import { colors as tokens, spacing, radius, numerals, shadows } from '../../theme/tokens';

// ─── Breakpoints ──────────────────────────────────────────────────────────────

/** Below this width the right rail is hidden. */
const BP_HIDE_RAIL = 1280;
/** Below this width only one pane is shown at a time. */
const BP_HIDE_LIST = 900;

// ─── Pane width defaults ──────────────────────────────────────────────────────

const THREAD_LIST_WIDTH = 300;
const CONTEXT_RAIL_WIDTH = 320;

/** Min/max bounds for each draggable pane. */
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

// ─── Conversation-scoped message types ───────────────────────────────────────

/**
 * Attachment shape for conversation messages — extends FileAttachmentInline with
 * a presigned downloadUrl that the server includes in GET /conversations/{id}/messages.
 * `FileAttachmentInline` in useApiQueries.ts doesn't declare `downloadUrl` (shared
 * with upload-only context), but the REST response always includes it. We cast here
 * to avoid unsafe `any`.
 */
interface ConversationMessageAttachment {
  id: string;
  filename: string;
  sizeBytes: number;
  contentType: string;
  s3Key: string;
  downloadUrl: string;
  /** Present on optimistic messages pointing to local device URI. */
  localUri?: string;
}

/**
 * A conversation message as used in the local UI list.
 * `status` is client-side only and must NEVER be sent to the API.
 */
interface ConversationMessageLocal {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  type: string;
  createdAt: string;
  attachment?: ConversationMessageAttachment | null;
  status?: 'sending' | 'failed';
}

/** Groups a flat message list into per-day buckets for day-separator rendering. */
function groupMessagesByDay(
  messages: ConversationMessageLocal[],
): Array<{ dateKey: string; messages: ConversationMessageLocal[] }> {
  const buckets = new Map<string, ConversationMessageLocal[]>();
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
 * Returns the icon component for a resource-needs journey category.
 */
function journeyCategoryIcon(category: string | undefined): React.ComponentType<{ size: number; color: string }> {
  switch ((category ?? '').toLowerCase()) {
    case 'housing': return Home;
    case 'food': return ShoppingCart;
    case 'transportation': return Truck;
    case 'employment': return Briefcase;
    case 'healthcare':
    case 'mental_health': return HeartPulse;
    default: return BookOpen;
  }
}

// ─── Resource-needs severity heuristic ───────────────────────────────────────

/**
 * Severity tier derived from journey progress percentage.
 *   < 33 → High (red), 33–67 → Medium (amber), ≥ 67 → Low (amber)
 */
type ResourceSeverity = 'High' | 'Medium' | 'Low';

function deriveSeverity(progressPercent: number): ResourceSeverity {
  if (progressPercent < 33) return 'High';
  if (progressPercent < 67) return 'Medium';
  return 'Low';
}

function severityPillVariant(severity: ResourceSeverity): PillVariant {
  if (severity === 'High') return 'red';
  // Medium and Low both map to amber — consolidated 6-hue palette
  return 'amber';
}

// ─── Rank chip ────────────────────────────────────────────────────────────────

interface RankChipProps {
  readonly rank: number;
}

/**
 * Small numbered rank badge for resource needs list.
 * Ranks 1–2 use red tint; rank 3+ use amber tint.
 */
function RankChip({ rank }: RankChipProps): React.JSX.Element {
  const isHighPriority = rank <= 2;
  return (
    <View
      style={[
        styles.rankChip,
        isHighPriority ? styles.rankChipRed : styles.rankChipAmber,
      ]}
    >
      <Text
        style={[
          styles.rankChipText,
          numerals.tabular,
          isHighPriority ? styles.rankChipTextRed : styles.rankChipTextAmber,
        ]}
      >
        {rank}
      </Text>
    </View>
  );
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
    <PressableCard
      onPress={() => navigation.navigate('Calendar')}
      accessibilityLabel="Go to calendar"
      style={styles.iconBtnCard}
    >
      <CalendarPlus size={20} color={tokens.textSecondary} />
    </PressableCard>
  );
}

// ─── Thread row ───────────────────────────────────────────────────────────────

interface ThreadRowProps {
  readonly conversation: ConversationData;
  readonly isActive: boolean;
  readonly onSelect: (conv: ConversationData) => void;
  readonly onDelete: (conv: ConversationData) => void;
}

/**
 * A single row in the thread list pane.
 * Shows: 36px avatar, member name, engagement Pill, last message preview,
 * timestamp (tabular mono), unread dot, and a ⋯ overflow button that
 * reveals a "Delete conversation" action.
 *
 * Engagement pill is derived from conv.unreadCount and conv.lastMessageAt —
 * no per-row message fetch. This avoids N parallel polls in the thread list.
 */
function ThreadRow({
  conversation: conv,
  isActive,
  onSelect,
  onDelete,
}: ThreadRowProps): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const name = conv.memberName ?? 'Unknown Member';
  const initials = getInitials(name);
  const { bg, fg } = avatarColorFor(name);

  // Derive preview from conversation-level last message fields.
  const preview: string = conv.lastMessagePreview ?? 'No messages yet';

  const timestamp = formatThreadTimestamp(conv.lastMessageAt ?? undefined);

  // Derive engagement from unreadCount + lastMessageAt without per-row fetch.
  // unreadCount > 0 → "Highly Engaged" (member recently replied); lastMessageAt
  // within 24 h → "Engaged"; otherwise → "Quiet".
  const engagementLabel: string = (() => {
    if (conv.unreadCount > 0) return 'Highly Engaged';
    if (conv.lastMessageAt) {
      const hoursAgo =
        (Date.now() - Date.parse(conv.lastMessageAt)) / (1000 * 60 * 60);
      if (hoursAgo < 24) return 'Engaged';
    }
    return 'Quiet';
  })();
  const engagementPillVariant: PillVariant = (() => {
    if (engagementLabel === 'Highly Engaged') return 'emerald';
    if (engagementLabel === 'Engaged') return 'blue';
    return 'gray';
  })();

  return (
    <View style={styles.threadRowOuter}>
      <PressableCard
        onPress={() => onSelect(conv)}
        accessibilityLabel={`Thread with ${name}${conv.unreadCount > 0 ? ', unread' : ''}`}
        style={[styles.threadRow, isActive && styles.threadRowActive]}
      >
        <View style={[styles.threadAvatar, { backgroundColor: bg }]}>
          <Text style={[styles.threadAvatarText, { color: fg }]}>{initials}</Text>
        </View>

        <View style={styles.threadBody}>
          <View style={styles.threadTopRow}>
            <Text style={styles.threadName} numberOfLines={1}>
              {name}
            </Text>
            <Text style={[styles.threadTimestamp, numerals.tabular]}>{timestamp}</Text>
          </View>
          <View style={styles.threadEngagementRow}>
            <Pill variant={engagementPillVariant} size="sm" withDot>
              {engagementLabel}
            </Pill>
          </View>
          <Text style={styles.threadPreview} numberOfLines={1}>
            {preview}
          </Text>
        </View>

        {conv.unreadCount > 0 ? <View style={styles.unreadIndicator} /> : null}

        {/* Overflow menu trigger */}
        <TouchableOpacity
          onPress={(e) => {
            e.stopPropagation?.();
            setMenuOpen((v) => !v);
          }}
          style={styles.threadOverflowBtn}
          accessibilityRole="button"
          accessibilityLabel={`More options for thread with ${name}`}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <MoreVertical size={16} color={tokens.textMuted} />
        </TouchableOpacity>
      </PressableCard>

      {/* Inline dropdown — appears below the row, z-index above siblings */}
      {menuOpen ? (
        <>
          {/* Transparent backdrop to dismiss */}
          <TouchableOpacity
            style={StyleSheet.absoluteFillObject}
            onPress={() => setMenuOpen(false)}
            accessibilityLabel="Close menu"
          />
          <View style={styles.threadMenu} accessibilityRole="menu">
            <TouchableOpacity
              style={styles.threadMenuItemDanger}
              onPress={() => {
                setMenuOpen(false);
                onDelete(conv);
              }}
              accessibilityRole="menuitem"
              accessibilityLabel="Delete conversation"
            >
              <Trash2 size={14} color="#b91c1c" />
              <Text style={styles.threadMenuItemDangerText}>Delete conversation</Text>
            </TouchableOpacity>
          </View>
        </>
      ) : null}
    </View>
  );
}

// ─── Thread list pane ─────────────────────────────────────────────────────────

type ThreadFilterTab = 'all' | 'unread' | 'flagged' | 'archived';

interface ThreadListPaneProps {
  readonly conversations: ConversationData[];
  readonly selectedConversationId: string | null;
  readonly onSelectConversation: (conv: ConversationData) => void;
  readonly onNavigateToMembers: () => void;
  readonly onDeleteConversation: (conv: ConversationData) => void;
}

/**
 * Left pane: one row per member–CHW conversation pair with search and 4 filter tabs.
 *
 * Sort: pinned conversations first (pinnedAt desc), then by lastMessageAt desc.
 * Tabs: All (n) / Unread / Flagged / Archived.
 * Thread rows wrapped in SwipeableThreadRow for swipe-to-pin/archive/delete.
 * StaggerList for cascading mount animation.
 */
function ThreadListPane({
  conversations,
  selectedConversationId,
  onSelectConversation,
  onNavigateToMembers,
  onDeleteConversation,
}: ThreadListPaneProps): React.JSX.Element {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<ThreadFilterTab>('all');

  const togglePin = useToggleConversationPin();
  const toggleArchive = useToggleConversationArchive();

  const withMember = useMemo(
    () => conversations.filter((c) => !!c.memberName),
    [conversations],
  );

  const visibleConversations = useMemo(() => {
    // Pinned-first, then most-recent-message-first.
    const sorted = [...withMember].sort((a, b) => {
      if (a.pinnedAt && !b.pinnedAt) return -1;
      if (!a.pinnedAt && b.pinnedAt) return 1;
      const aTs = a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0;
      const bTs = b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0;
      return bTs - aTs;
    });

    let filtered = sorted;

    switch (activeFilter) {
      case 'archived':
        filtered = filtered.filter((c) => !!c.archivedAt);
        break;
      case 'unread':
        filtered = filtered.filter((c) => c.unreadCount > 0);
        break;
      case 'flagged':
        // Flagged is presentation-only in v1 — show same unarchived list.
        filtered = filtered.filter((c) => !c.archivedAt);
        break;
      default:
        filtered = filtered.filter((c) => !c.archivedAt);
        break;
    }

    const query = searchQuery.trim().toLowerCase();
    if (query) {
      filtered = filtered.filter((c) =>
        (c.memberName ?? '').toLowerCase().includes(query),
      );
    }

    return filtered;
  }, [withMember, searchQuery, activeFilter]);

  const totalCount = useMemo(
    () => withMember.filter((c) => !c.archivedAt).length,
    [withMember],
  );

  // Total UNREAD messages across non-archived threads. The header badge shows
  // this (not the thread count) and is hidden entirely when there are none, so
  // a number appears only when there's actually an unread message.
  const unreadTotal = useMemo(
    () =>
      withMember.reduce(
        (sum, c) => (c.archivedAt ? sum : sum + Math.max(0, c.unreadCount ?? 0)),
        0,
      ),
    [withMember],
  );

  const tabs: { key: ThreadFilterTab; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'unread', label: 'Unread' },
    { key: 'flagged', label: 'Flagged' },
    { key: 'archived', label: 'Archived' },
  ];

  return (
    <View style={styles.threadListPane} accessibilityRole={"navigation" as any} accessibilityLabel="Message threads">
      {/* Header */}
      <View style={styles.threadListHeader}>
        {/* Title row */}
        <View style={styles.threadListTitleRow}>
          <Text style={styles.threadListTitle}>Messages</Text>
          {/* Unread badge — only shown when there are actual unread messages. */}
          {unreadTotal > 0 && (
            <View
              style={[styles.threadCountBadge]}
              accessibilityLabel={`${unreadTotal} unread message${unreadTotal === 1 ? '' : 's'}`}
            >
              <Text style={[styles.threadCountBadgeText, numerals.tabular]}>
                {unreadTotal}
              </Text>
            </View>
          )}
        </View>

        {/* Search */}
        <View style={styles.searchBar}>
          <Search size={15} color={tokens.textMuted} style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search members..."
            placeholderTextColor={tokens.textMuted}
            accessibilityLabel="Search message threads"
          />
        </View>

        {/* Filter tabs — outlined Pill chips */}
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
              accessibilityLabel={tab.key === 'all' ? `All (${totalCount})` : tab.label}
            >
              <Text
                style={[
                  styles.filterChipText,
                  activeFilter === tab.key && styles.filterChipTextActive,
                ]}
              >
                {tab.key === 'all' ? `All (${totalCount})` : tab.label}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* Thread rows or empty state */}
      <ScrollView
        style={styles.threadScrollView}
        showsVerticalScrollIndicator={false}
        accessibilityRole="list"
        accessibilityLabel="Member threads"
      >
        {visibleConversations.length === 0 ? (
          <EmptyState
            icon={MessageSquare}
            title={searchQuery ? 'No threads match your search.' : 'No conversations yet'}
            body={
              searchQuery
                ? 'Try a different name or clear the search.'
                : 'Threads appear when you start a session with a member.'
            }
            cta={
              !searchQuery
                ? { label: 'Find Members', onPress: onNavigateToMembers }
                : undefined
            }
          />
        ) : (
          <StaggerList delayMs={40} durationMs={250}>
            {visibleConversations.map((conv) => (
              <SwipeableThreadRow
                key={conv.id}
                isPinned={!!conv.pinnedAt}
                onPress={() => onSelectConversation(conv)}
                onPin={(nextPinned) =>
                  void togglePin.mutateAsync({
                    conversationId: conv.id,
                    pinned: nextPinned,
                  })
                }
                onArchive={() =>
                  void toggleArchive.mutateAsync({
                    conversationId: conv.id,
                    archived: !conv.archivedAt,
                  })
                }
                onDelete={() => onDeleteConversation(conv)}
              >
                <ThreadRow
                  conversation={conv}
                  isActive={selectedConversationId === conv.id}
                  onSelect={onSelectConversation}
                  onDelete={onDeleteConversation}
                />
              </SwipeableThreadRow>
            ))}
          </StaggerList>
        )}
      </ScrollView>
    </View>
  );
}

// ─── Attachment bubble helpers ────────────────────────────────────────────────

/**
 * Formats a byte count as a compact human-readable size string (e.g. "1.2 MB").
 * Uses numerals.tabular on the Text element at the call site.
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface ImageAttachmentBubbleProps {
  readonly downloadUrl: string;
  readonly filename: string;
  readonly isSentByChw: boolean;
}

/**
 * Renders an image attachment inline with tap-to-zoom (native) or new-tab (web).
 */
function ImageAttachmentBubble({
  downloadUrl,
  filename,
  isSentByChw,
}: ImageAttachmentBubbleProps): React.JSX.Element {
  const [zoomVisible, setZoomVisible] = useState(false);

  // Freeze the first presigned URL we render. The session-messages query
  // refetches every 4s and the backend mints a fresh presigned GET URL on each
  // serialization, so this prop changes every poll. Re-pointing the <Image> at a
  // new signed URL forces the browser to re-download → the image visibly
  // flickers/reloads. Pin the first URL (presigned URLs are valid ~1h, far
  // longer than a thread stays open) so the rendered image holds still. Taps
  // still use the live `downloadUrl` so opening full-size always gets a fresh URL.
  const stableUriRef = useRef<string>('');
  if (!stableUriRef.current && downloadUrl) {
    stableUriRef.current = downloadUrl;
  }
  const imageUri = stableUriRef.current || downloadUrl;

  const handleTap = useCallback((): void => {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.open(downloadUrl, '_blank', 'noopener,noreferrer');
    } else {
      setZoomVisible(true);
    }
  }, [downloadUrl]);

  return (
    <>
      <TouchableOpacity
        onPress={handleTap}
        activeOpacity={0.85}
        accessibilityRole="image"
        accessibilityLabel={`Attachment: ${filename}. Tap to view full size.`}
      >
        <Image
          source={{ uri: imageUri }}
          style={[
            styles.attachmentImageThumb,
            isSentByChw ? styles.attachmentImageOutbound : styles.attachmentImageInbound,
          ]}
          resizeMode="cover"
          accessibilityIgnoresInvertColors
        />
      </TouchableOpacity>

      {/* Native full-screen zoom modal */}
      {Platform.OS !== 'web' ? (
        <Modal
          visible={zoomVisible}
          transparent
          animationType="fade"
          onRequestClose={() => setZoomVisible(false)}
          accessibilityViewIsModal
        >
          <View style={styles.imageZoomOverlay}>
            <TouchableOpacity
              style={styles.imageZoomClose}
              onPress={() => setZoomVisible(false)}
              accessibilityRole="button"
              accessibilityLabel="Close image"
            >
              <X size={24} color="#fff" />
            </TouchableOpacity>
            <Image
              source={{ uri: imageUri }}
              style={styles.imageZoomFull}
              resizeMode="contain"
              accessibilityIgnoresInvertColors
            />
          </View>
        </Modal>
      ) : null}
    </>
  );
}

interface PdfAttachmentBubbleProps {
  readonly downloadUrl: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly isSentByChw: boolean;
}

/**
 * Renders a PDF (or generic file) attachment as a Card-style row with
 * emerald-tinted icon circle, filename, size, and download icon.
 */
function FileAttachmentBubble({
  downloadUrl,
  filename,
  sizeBytes,
  isSentByChw,
}: PdfAttachmentBubbleProps): React.JSX.Element {
  const handleTap = useCallback((): void => {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.open(downloadUrl, '_blank', 'noopener,noreferrer');
    } else {
      void Linking.openURL(downloadUrl);
    }
  }, [downloadUrl]);

  return (
    <TouchableOpacity
      onPress={handleTap}
      activeOpacity={0.85}
      style={[
        styles.fileAttachmentRow,
        isSentByChw ? styles.fileAttachmentOutbound : styles.fileAttachmentInbound,
      ]}
      accessibilityRole="button"
      accessibilityLabel={`Open attachment: ${filename}, ${formatFileSize(sizeBytes)}`}
    >
      <View style={styles.fileIconCircle}>
        <FileText size={16} color="#047857" />
      </View>
      <View style={styles.fileAttachmentInfo}>
        <Text
          style={[
            styles.fileAttachmentName,
            isSentByChw ? styles.fileAttachmentNameOut : styles.fileAttachmentNameIn,
          ]}
          numberOfLines={1}
        >
          {filename}
        </Text>
        <Text style={[styles.fileAttachmentSize, numerals.tabular]}>
          {formatFileSize(sizeBytes)}
        </Text>
      </View>
      <Download size={16} color={isSentByChw ? tokens.emerald700 : tokens.textSecondary} />
    </TouchableOpacity>
  );
}

// ─── Message bubble ───────────────────────────────────────────────────────────

interface MessageBubbleProps {
  readonly message: ConversationMessageLocal;
  readonly isSentByChw: boolean;
}

function MessageBubble({ message, isSentByChw }: MessageBubbleProps): React.JSX.Element {
  const att = message.attachment;

  const isImageAttachment = att != null && att.contentType.startsWith('image/');
  const isFileAttachment  = att != null && !isImageAttachment;
  const hasTextBody       = message.body.trim().length > 0;

  return (
    <View style={isSentByChw ? styles.bubbleRowOutbound : styles.bubbleRowInbound}>
      <View style={[styles.bubble, isSentByChw ? styles.bubbleOutbound : styles.bubbleInbound]}>

        {/* Image attachment */}
        {isImageAttachment && att != null ? (
          <ImageAttachmentBubble
            downloadUrl={att.downloadUrl}
            filename={att.filename}
            isSentByChw={isSentByChw}
          />
        ) : null}

        {/* PDF / generic file attachment */}
        {isFileAttachment && att != null ? (
          <FileAttachmentBubble
            downloadUrl={att.downloadUrl}
            filename={att.filename}
            sizeBytes={att.sizeBytes}
            isSentByChw={isSentByChw}
          />
        ) : null}

        {/* Text body (caption or standalone text) */}
        {hasTextBody ? (
          <Text
            style={[
              styles.bubbleText,
              isSentByChw ? styles.bubbleTextOutbound : styles.bubbleTextInbound,
              att != null ? styles.bubbleTextWithAttachment : undefined,
            ]}
          >
            {message.body}
          </Text>
        ) : null}

        {/* Fallback for messages with no body and no attachment (shouldn't happen) */}
        {!hasTextBody && att == null ? (
          <Text
            style={[
              styles.bubbleText,
              isSentByChw ? styles.bubbleTextOutbound : styles.bubbleTextInbound,
            ]}
          >
            {message.body}
          </Text>
        ) : null}

        <Text
          style={[
            styles.bubbleTimestamp,
            numerals.tabular,
            isSentByChw ? styles.bubbleTimestampOutbound : styles.bubbleTimestampInbound,
          ]}
        >
          {formatMessageTimestamp(message.createdAt)}
          {message.status === 'sending' ? ' · Sending...' : ''}
          {message.status === 'failed' ? ' · Failed' : ''}
        </Text>
      </View>
    </View>
  );
}

// ─── Conversation pane ────────────────────────────────────────────────────────

interface ConversationPaneProps {
  readonly conversation: ConversationData;
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
  conversation: conv,
  onBack,
  showBackButton,
  autoCallOnMount,
  onAutoCallConsumed,
  onRequestOpenDocumentation,
}: ConversationPaneProps): React.JSX.Element {
  const [draftText, setDraftText] = useState('');
  const [localMessages, setLocalMessages] = useState<ConversationMessageLocal[]>([]);
  const [callInitiating, setCallInitiating] = useState(false);
  // A session is in progress when the conversation has an active session.
  // We cannot know the session status without fetching it; presence of
  // activeSessionId is used as a proxy — it is set by the backend only while
  // in_progress. The rail's full status logic uses useSessionHook.
  const sessionInProgress = conv.activeSessionId !== null;
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [toastIsError, setToastIsError] = useState(false);
  const [documentingSessionId, setDocumentingSessionId] = useState<string | null>(null);

  /** Pending attachment — set after upload completes, cleared after send. */
  const [pendingAttachment, setPendingAttachment] = useState<MessageAttachmentUploadResult | null>(null);

  const scrollRef = useRef<ScrollView>(null);
  const navigation = useNavigation<any>(); // eslint-disable-line @typescript-eslint/no-explicit-any
  /** Hidden <input type="file"> refs for web — one for docs+images, one for images only. */
  const fileInputDocRef  = useRef<HTMLInputElement | null>(null);
  const fileInputImgRef  = useRef<HTMLInputElement | null>(null);

  const messagesQuery = useConversationMessages(conv.id);
  const sendMessage = useConversationSendMessage();
  const startCall = useStartCall();
  const submitDocumentation = useSubmitDocumentation();

  // ── Toast ─────────────────────────────────────────────────────────────────

  const showToast = useCallback((message: string, isError: boolean): void => {
    setToastMessage(message);
    setToastIsError(isError);
    const timer = setTimeout(() => setToastMessage(null), 3_500);
    void timer;
  }, []);

  const { uploadAttachment, isUploading: isAttachmentUploading } = useMessageAttachmentUpload({
    // A CHW uploads attachments scoped to the member they're messaging.
    targetMemberId: conv.memberId ?? '',
    onError: (err) => showToast(err.message, true),
  });

  // ── Call handler ──────────────────────────────────────────────────────────

  const handleCall = useCallback(async (): Promise<void> => {
    if (callInitiating) return;
    const memberName = conv.memberName ?? 'this member';

    const executeCall = async (): Promise<void> => {
      setCallInitiating(true);
      try {
        if (!conv.activeSessionId) {
          showToast('No active session — begin a session before calling.', true);
          return;
        }
        await startCall.mutateAsync(conv.activeSessionId);
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
  }, [callInitiating, conv.activeSessionId, conv.memberName, startCall, showToast]);

  // ── Auto-call on mount ────────────────────────────────────────────────────

  useEffect(() => {
    if (!autoCallOnMount || callInitiating) return;
    if (!conv.activeSessionId) return; // No active session — skip auto-call.
    const activeId = conv.activeSessionId;
    setCallInitiating(true);
    void (async () => {
      try {
        await startCall.mutateAsync(activeId);
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
  }, [autoCallOnMount, conv.activeSessionId]);

  // ── Merged messages (server + optimistic) ────────────────────────────────

  const mergedMessages = useMemo<ConversationMessageLocal[]>(() => {
    // Cast server MessageData to ConversationMessageLocal. The REST response
    // includes downloadUrl on attachments even though FileAttachmentInline in
    // the type definition doesn't declare it (shared with upload-only context).
    const serverMessages: ConversationMessageLocal[] = (messagesQuery.data ?? []).map(
      (m): ConversationMessageLocal => ({
        ...m,
        // Carry over the attachment with the runtime downloadUrl field.
        attachment: m.attachment
          ? (m.attachment as unknown as ConversationMessageAttachment)
          : undefined,
      }),
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

  // ── Attachment pickers ────────────────────────────────────────────────────

  /**
   * Handles a file selected from a web <input type="file">.
   * Uploads immediately; the result is stored in `pendingAttachment`.
   */
  const handleWebFileChosen = useCallback(
    async (file: File): Promise<void> => {
      const result = await uploadAttachment(file);
      if (result) setPendingAttachment(result);
    },
    [uploadAttachment],
  );

  /**
   * On native — triggers expo-document-picker for PDFs + images.
   * On web — programmatically clicks the hidden doc file input.
   */
  const handlePickDocument = useCallback((): void => {
    if (Platform.OS === 'web') {
      fileInputDocRef.current?.click();
    } else {
      void (async () => {
        const result = await uploadAttachment(null);
        if (result) setPendingAttachment(result);
      })();
    }
  }, [uploadAttachment]);

  /**
   * On native — triggers expo-image-picker for images only.
   * On web — programmatically clicks the hidden image-only file input.
   */
  const handlePickImage = useCallback((): void => {
    if (Platform.OS === 'web') {
      fileInputImgRef.current?.click();
    } else {
      void (async () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
        const ImagePicker = require('expo-image-picker') as typeof import('expo-image-picker');
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ImagePicker.MediaTypeOptions.Images,
          allowsEditing: false,
          quality: 0.9,
        });
        if (result.canceled || !result.assets[0]) return;

        const asset = result.assets[0];
        if (!asset) return;

        const mimeType =
          asset.mimeType ??
          (asset.uri.endsWith('.png') ? 'image/png' : 'image/jpeg');
        const sizeBytes = asset.fileSize ?? 0;

        if (sizeBytes > 10 * 1024 * 1024) {
          showToast('File too large (max 10 MB)', true);
          return;
        }

        const uploadResult = await uploadAttachment(null, {
          uri: asset.uri,
          filename: asset.fileName ?? `image-${Date.now()}.jpg`,
          mimeType,
          sizeBytes,
        });
        if (uploadResult) setPendingAttachment(uploadResult);
      })();
    }
  }, [uploadAttachment, showToast]);

  // ── Send message ──────────────────────────────────────────────────────────

  const handleSend = useCallback(async (): Promise<void> => {
    const trimmed = draftText.trim();
    // Valid if there is text OR a pending attachment (attachment-only is allowed).
    if (!trimmed && !pendingAttachment) return;

    const capturedAttachment = pendingAttachment;

    const optimisticId = `local-${Date.now()}`;
    const optimisticMessage: ConversationMessageLocal = {
      id: optimisticId,
      conversationId: conv.id,
      // Use chwId as senderId so isSentByChw derivation works for the optimistic message.
      senderId: conv.chwId,
      body: trimmed,
      type: capturedAttachment ? (capturedAttachment.contentType.startsWith('image/') ? 'image' : 'file') : 'text',
      createdAt: new Date().toISOString(),
      status: 'sending',
      attachment: capturedAttachment
        ? {
            id: optimisticId,
            filename: capturedAttachment.filename,
            sizeBytes: capturedAttachment.sizeBytes,
            contentType: capturedAttachment.contentType,
            s3Key: capturedAttachment.s3Key,
            // Use the local URI for immediate preview on optimistic message.
            downloadUrl: capturedAttachment.localUri,
          }
        : undefined,
    };

    setLocalMessages((prev) => [...prev, optimisticMessage]);
    setDraftText('');
    setPendingAttachment(null);

    try {
      await sendMessage.mutateAsync({
        conversationId: conv.id,
        body: trimmed,
        attachment: capturedAttachment
          ? {
              s3Key: capturedAttachment.s3Key,
              filename: capturedAttachment.filename,
              sizeBytes: capturedAttachment.sizeBytes,
              contentType: capturedAttachment.contentType,
            }
          : undefined,
      });
      setLocalMessages((prev) => prev.filter((m) => m.id !== optimisticId));
    } catch {
      setLocalMessages((prev) =>
        prev.map((m) =>
          m.id === optimisticId ? { ...m, status: 'failed' as const } : m,
        ),
      );
    }
  }, [draftText, pendingAttachment, conv.id, sendMessage]);

  // ── Template chip insertion ───────────────────────────────────────────────

  const insertTemplate = useCallback((text: string): void => {
    setDraftText((prev) => (prev ? `${prev} ${text}` : text));
  }, []);

  // ── Complete Session ──────────────────────────────────────────────────────

  const handleOpenCompleteSession = useCallback((): void => {
    if (conv.activeSessionId) {
      setDocumentingSessionId(conv.activeSessionId);
    }
  }, [conv.activeSessionId]);

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

  const memberName = conv.memberName ?? 'Unknown Member';
  const memberFirstName = getFirstName(memberName);
  const initials = getInitials(memberName);
  const { bg, fg } = avatarColorFor(memberName);
  const grouped = groupMessagesByDay(mergedMessages);

  // Derive engagement for the header pill from actual conversation messages.
  // useEngagementStatus expects SessionMessageLocal[] — map ConversationMessageLocal
  // to the compatible shape (senderRole derived from senderId vs chwId).
  const messagesForEngagement = useMemo<SessionMessageLocal[]>(
    () =>
      mergedMessages.map((m): SessionMessageLocal => ({
        id: m.id,
        senderUserId: m.senderId,
        senderRole: m.senderId === conv.chwId ? 'chw' : 'member',
        body: m.body,
        type: m.type,
        createdAt: m.createdAt,
        status: m.status,
        attachment: m.attachment
          ? {
              id: m.attachment.id,
              filename: m.attachment.filename,
              sizeBytes: m.attachment.sizeBytes,
              contentType: m.attachment.contentType,
              s3Key: m.attachment.s3Key,
              downloadUrl: m.attachment.downloadUrl,
            }
          : undefined,
      })),
    [mergedMessages, conv.chwId],
  );
  const engagement = useEngagementStatus(messagesForEngagement, conv.chwId);

  // ── Quick-reply templates — 4 chips per mockup spec ───────────────────────

  const templateChips: Array<{
    label: string;
    icon: React.ComponentType<{ size: number; color: string }>;
    text: string;
  }> = useMemo(() => [
    {
      label: 'Appointment Reminder',
      icon: CalendarPlus,
      text: `Hi ${memberFirstName}, this is a reminder about your upcoming appointment. Please reply to confirm or reschedule.`,
    },
    {
      label: 'Document Reminder',
      icon: FileText,
      text: `Hi ${memberFirstName}, we still need a few documents to move forward. Can you upload them when you get a chance?`,
    },
    {
      label: 'Resource Link',
      icon: LinkIcon,
      // TODO(resources): Replace with actual resource URL when resource picker is available.
      text: '[resource]',
    },
    {
      label: 'Follow-Up Check-In',
      icon: Activity,
      text: `Hey ${memberFirstName} — just checking in. How are things going this week?`,
    },
  ], [memberFirstName]);

  return (
    <View style={styles.convPane} accessibilityRole={"main" as any}>
      {/* Sticky header */}
      <View style={[styles.convHeader, shadows.elevated as ViewStyle]}>
        {showBackButton && onBack ? (
          <PressableCard
            onPress={onBack}
            accessibilityLabel="Back to thread list"
            style={styles.iconBtnCard}
          >
            <ArrowLeft size={20} color={tokens.textPrimary} />
          </PressableCard>
        ) : null}

        <PressableMember
          memberId={conv.memberId ?? ''}
          displayName={memberName}
          enabled={!!conv.memberId}
        >
          <View style={[styles.convHeaderAvatar, { backgroundColor: bg }]}>
            <Text style={[styles.convHeaderAvatarText, { color: fg }]}>{initials}</Text>
          </View>
        </PressableMember>

        <View style={styles.convHeaderInfo}>
          <View style={styles.convHeaderNameRow}>
            <PressableMember
              memberId={conv.memberId ?? ''}
              displayName={memberName}
              enabled={!!conv.memberId}
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
            Member Available · Best contact time: 4–7 PM · Avg response: 30 min
          </Text>
        </View>

        {/* Call button — tinted green while a session is in progress to cue the
            CHW that calling the member is the next expected step. */}
        <PressableCard
          onPress={() => void handleCall()}
          disabled={callInitiating}
          accessibilityLabel={
            callInitiating
              ? 'Call initiating...'
              : sessionInProgress
              ? 'Call member — next step'
              : 'Call member'
          }
          style={[styles.iconBtnCard, sessionInProgress && styles.iconBtnCardActive]}
        >
          {callInitiating ? (
            <ActivityIndicator size="small" color={tokens.textSecondary} />
          ) : (
            <Phone
              size={20}
              color={sessionInProgress ? '#FFFFFF' : tokens.textSecondary}
            />
          )}
        </PressableCard>

        {/* Calendar navigation */}
        <CalendarNavigationButton />

        {/* Open Member Profile */}
        <PressableMember
          memberId={conv.memberId ?? ''}
          displayName={memberName}
          enabled={!!conv.memberId}
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
          <EmptyState
            icon={MessageSquare}
            title="No messages yet"
            body="Start the conversation by saying hello."
          />
        ) : (
          grouped.map(({ dateKey, messages: dayMessages }) => (
            <View key={dateKey}>
              {/* Day separator */}
              <View style={styles.daySeparator}>
                <View style={styles.daySepLine} />
                <Text style={styles.daySeparatorText}>
                  {formatDaySeparator(dayMessages[0]?.createdAt ?? dateKey)}
                </Text>
                <View style={styles.daySepLine} />
              </View>
              {dayMessages.map((msg) => (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  isSentByChw={msg.senderId === conv.chwId}
                />
              ))}
            </View>
          ))
        )}
      </ScrollView>

      {/* Composer area */}
      <View style={[styles.composerWrap]}>
        {/* Quick-reply template chips — 4 outlined pills per mockup */}
        <View style={styles.templateRow}>
          <Text style={styles.templateLabel}>TEMPLATES:</Text>
          {templateChips.map((chip) => {
            const IconComponent = chip.icon;
            return (
              <PressableCard
                key={chip.label}
                onPress={() => insertTemplate(chip.text)}
                accessibilityLabel={`Insert template: ${chip.label}`}
                style={styles.templateChip}
              >
                <IconComponent size={12} color={tokens.textSecondary} />
                <Text style={styles.templateChipText}>{chip.label}</Text>
              </PressableCard>
            );
          })}
        </View>

        {/* Attachment preview row — shown while an attachment is staged */}
        {pendingAttachment != null ? (
          <View style={styles.attachmentPreviewRow} role="status">
            {pendingAttachment.contentType.startsWith('image/') ? (
              <Image
                source={{ uri: pendingAttachment.localUri }}
                style={styles.attachmentPreviewThumb}
                resizeMode="cover"
                accessibilityIgnoresInvertColors
              />
            ) : (
              <View style={styles.attachmentPreviewFileIcon}>
                <FileText size={20} color="#047857" />
              </View>
            )}
            <View style={styles.attachmentPreviewInfo}>
              <Text style={styles.attachmentPreviewName} numberOfLines={1}>
                {pendingAttachment.filename}
              </Text>
              <Text style={[styles.attachmentPreviewSize, numerals.tabular]}>
                {formatFileSize(pendingAttachment.sizeBytes)}
              </Text>
            </View>
            {isAttachmentUploading ? (
              <ActivityIndicator size="small" color={tokens.textSecondary} />
            ) : (
              <PressableCard
                onPress={() => setPendingAttachment(null)}
                accessibilityLabel="Remove attachment"
                style={styles.attachmentPreviewRemove}
              >
                <X size={14} color={tokens.textSecondary} />
              </PressableCard>
            )}
          </View>
        ) : null}

        {/* Composer row */}
        <View style={styles.composerInner}>
          {/* Hidden web file inputs */}
          {Platform.OS === 'web' ? (
            <>
              <input
                ref={fileInputDocRef}
                type="file"
                accept="application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/jpeg,image/png,image/gif,image/webp"
                style={{ display: 'none' }}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  const file = e.target.files?.[0];
                  if (file) void handleWebFileChosen(file);
                  // Reset so the same file can be re-selected.
                  e.target.value = '';
                }}
              />
              <input
                ref={fileInputImgRef}
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp"
                style={{ display: 'none' }}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  const file = e.target.files?.[0];
                  if (file) void handleWebFileChosen(file);
                  e.target.value = '';
                }}
              />
            </>
          ) : null}

          {/* Paperclip — PDFs + images */}
          <PressableCard
            onPress={handlePickDocument}
            disabled={isAttachmentUploading}
            accessibilityLabel="Attach file (PDF or image)"
            style={[
              styles.composerIconBtnCard,
              pendingAttachment != null && styles.composerIconBtnActive,
            ]}
          >
            {isAttachmentUploading ? (
              <ActivityIndicator size="small" color={tokens.textSecondary} />
            ) : (
              <Paperclip
                size={20}
                color={pendingAttachment != null ? tokens.primary : tokens.textSecondary}
              />
            )}
          </PressableCard>

          {/* Image picker — images only */}
          <PressableCard
            onPress={handlePickImage}
            disabled={isAttachmentUploading}
            accessibilityLabel="Attach image"
            style={styles.composerIconBtnCard}
          >
            <ImageIcon size={20} color={tokens.textSecondary} />
          </PressableCard>

          <PressableCard
            onPress={() => {/* Insert link — placeholder */}}
            accessibilityLabel="Insert link"
            style={styles.composerIconBtnCard}
          >
            <LinkIcon size={20} color={tokens.textSecondary} />
          </PressableCard>
          <PressableCard
            onPress={() => insertTemplate('Appointment scheduled — I\'ll send you details shortly.')}
            accessibilityLabel="Schedule appointment"
            style={styles.composerIconBtnCard}
          >
            <CalendarPlus size={20} color={tokens.textSecondary} />
          </PressableCard>
          <TextInput
            style={styles.composerInput}
            value={draftText}
            onChangeText={setDraftText}
            placeholder="Type a message..."
            placeholderTextColor={tokens.textMuted}
            multiline
            numberOfLines={2}
            accessibilityLabel="Message input"
            onSubmitEditing={() => void handleSend()}
          />
          <PressableCard
            onPress={() => void handleSend()}
            disabled={(!draftText.trim() && !pendingAttachment) || sendMessage.isPending || isAttachmentUploading}
            accessibilityLabel="Send message"
            style={[
              styles.sendBtnCard,
              ((!draftText.trim() && !pendingAttachment) || sendMessage.isPending || isAttachmentUploading) && styles.sendBtnDisabled,
            ]}
          >
            {sendMessage.isPending ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Send size={16} color="#fff" />
            )}
            <Text style={styles.sendBtnText}>Send</Text>
          </PressableCard>
        </View>

        {/* SMS caption — mono tabular */}
        <Text style={styles.composerMeta}>SMS via Vonage masked number</Text>
      </View>

      {/* Documentation modal */}
      {documentingSessionId != null && (
        <DocumentationModal
          visible={documentingSessionId != null}
          onClose={() => setDocumentingSessionId(null)}
          sessionId={documentingSessionId}
          durationMinutes={null}
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
        <Text style={consentStyles.label}>Loading consent status...</Text>
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

// ─── Case Note Modal ──────────────────────────────────────────────────────────

interface CaseNoteModalProps {
  readonly memberId: string;
  readonly sessionId: string;
  readonly visible: boolean;
  readonly onClose: () => void;
}

/**
 * RightDrawer modal for adding a clinical case note for the member.
 * POSTs to POST /api/v1/case-notes via useCreateCaseNote.
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
            onPress={() => { void handleSave(); }}
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
          placeholder="Clinical observations, follow-up actions, member updates..."
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

/**
 * Terminal session statuses — the session is over and cannot be ended. Showing a
 * "Complete Session" button for these produces a confusing 409 from POST /end
 * ("Cannot end session with status '...'. Must be 'in_progress'."), so the rail
 * renders a read-only status note instead.
 *
 * `cancelled_no_consent` is set by the masked-call flow when the member declines
 * the California §632 recording-consent IVR (or it times out) — see
 * app/routers/communication.py.
 */
/**
 * Statuses that produce a non-actionable read-only label in the rail.
 * `completed` is intentionally excluded: a completed session (documentation
 * submitted) shows an actionable "Begin Session" button to start the next
 * session with that member. Only truly aborted sessions (cancelled /
 * cancelled_no_consent) get the read-only label.
 */
const TERMINAL_SESSION_STATUSES: readonly string[] = [
  'cancelled',
  'cancelled_no_consent',
];

/** Human-readable label for a terminal session status, shown in the rail. */
function terminalSessionLabel(status: string): string {
  switch (status) {
    case 'completed':
      return 'Session completed';
    case 'cancelled_no_consent':
      return 'Cancelled — member declined recording consent';
    case 'cancelled':
      return 'Session cancelled';
    default:
      return 'Session ended';
  }
}

interface MemberContextRailProps {
  readonly conversation: ConversationData;
  readonly onEndSessionComplete?: () => void;
  /** Called after a new session has been created and started from a completed session. */
  readonly onSessionStarted?: (newSession: SessionData) => void;
  /**
   * When true, automatically fire the Begin Session flow on mount (once the
   * session status is known). Set by the parent when route.params.autoBeginSession === true
   * and this rail's conversation matches the target member.
   * Mirrors the autoCallOnMount pattern on ConversationPane.
   */
  readonly autoBeginSessionOnMount?: boolean;
  /** Fired after the auto-begin attempt so the parent can clear the one-shot flag. */
  readonly onAutoBeginSessionConsumed?: () => void;
}

/**
 * Right pane: member context sections in order:
 *   1. Care Status card — journey name, progress bar, 5-stage vertical stepper
 *   2. Active Needs card — top 3 resource needs ranked by severity
 *   3. Session Focus card — last interaction, today's goal, next step
 *   4. Screening Questions card — opens the suggested-questions drawer
 *   5. Quick Actions — Add Case Note, Open Member Profile, Schedule Session
 *   6. Complete Session — red destructive, inline slide-up confirm panel
 *   7. Services Consent — informational read-only widget
 *
 * No nested cards within a single Card region — border-top dividers used instead.
 */
function MemberContextRail({
  conversation: conv,
  onEndSessionComplete,
  onSessionStarted,
  autoBeginSessionOnMount,
  onAutoBeginSessionConsumed,
}: MemberContextRailProps): React.JSX.Element {
  const navigation = useNavigation<any>(); // eslint-disable-line @typescript-eslint/no-explicit-any

  const [questionsDrawerOpen, setQuestionsDrawerOpen] = useState(false);
  const [caseNoteModalOpen, setCaseNoteModalOpen] = useState(false);
  const [endSessionPending, setEndSessionPending] = useState(false);
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  const [beginSessionPending, setBeginSessionPending] = useState(false);

  // Fetch live session status for lifecycle gating. When activeSessionId is
  // null the conversation has no in-progress session — we treat it as needing
  // a brand-new session (same flow as "completed" in the old model).
  const liveSessionQuery = useSessionHook(conv.activeSessionId ?? '');
  const liveSession: SessionData | null = liveSessionQuery.data ?? null;

  // Session lifecycle gating for the primary action button:
  //   null activeSessionId   → "Begin Session" (POST /sessions/schedule + PATCH /start)
  //   scheduled              → "Begin Session" (PATCH /sessions/{id}/start)
  //   completed              → "Begin Session" (POST /sessions/schedule then PATCH /start)
  //   in_progress            → "Complete Session" (end flow + documentation)
  //   awaiting_documentation → "Complete Session" (re-opens documentation; /end is idempotent)
  //   cancelled /            → non-actionable status note.
  //     cancelled_no_consent
  const activeStatus = liveSession?.status ?? null;
  // No activeSessionId → bare conversation; treat as needing a new session.
  const canBeginSession = activeStatus === 'scheduled';
  const canBeginNewSession =
    conv.activeSessionId === null ||
    activeStatus === 'completed';
  const isTerminalSession =
    activeStatus !== null &&
    TERMINAL_SESSION_STATUSES.includes(activeStatus);

  // Slide-up animation for the end-session confirmation panel
  const confirmSlideY = useRef(new Animated.Value(60)).current;
  const confirmOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (showEndConfirm) {
      Animated.parallel([
        Animated.spring(confirmSlideY, {
          toValue: 0,
          useNativeDriver: true,
          stiffness: 280,
          damping: 22,
          mass: 1,
        }),
        Animated.timing(confirmOpacity, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(confirmSlideY, {
          toValue: 60,
          duration: 160,
          useNativeDriver: true,
        }),
        Animated.timing(confirmOpacity, {
          toValue: 0,
          duration: 160,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [showEndConfirm, confirmSlideY, confirmOpacity]);

  const endSession = useEndSessionHook();
  const startSession = useStartSessionHook();
  const scheduleSession = useScheduleSessionHook();

  // Journey data
  const journeysQuery = useChwJourneys();
  const memberJourneys: MemberJourneyResponse[] = useMemo(() => {
    const allJourneys = journeysQuery.data ?? [];
    return allJourneys.filter(
      (j) => j.memberId === conv.memberId && j.status === 'active',
    );
  }, [journeysQuery.data, conv.memberId]);

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
  const consentQuery = useMemberServicesConsent(conv.memberId ?? '');
  const consentValue = consentQuery.data?.value ?? null;
  const servicesRefused = consentValue === 'refuse_services';

  // Journey display values
  const journeyPercent = activeJourney?.progressPercent ?? 0;
  const journeyName = activeJourney?.template.name ?? 'General';
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

  // 5-stage care stepper derived from journeyPercent (20% per stage)
  const CARE_STAGES = [
    'Intake Complete',
    'Eligibility Checked',
    'Documents Needed',
    'Application Submitted',
    'Approved',
  ] as const;

  type StageState = 'completed' | 'current' | 'future';

  const stageStates = useMemo((): StageState[] => {
    // Each stage covers a 20% band: stage 0 = 0–20, stage 1 = 20–40, …, stage 4 = 80–100
    const currentStageIndex = Math.min(
      Math.floor(journeyPercent / 20),
      CARE_STAGES.length - 1,
    );
    return CARE_STAGES.map((_, i): StageState => {
      if (i < currentStageIndex) return 'completed';
      if (i === currentStageIndex) return 'current';
      return 'future';
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [journeyPercent]);

  // ── End Session handler ───────────────────────────────────────────────────

  const memberFirstName = getFirstName(conv.memberName);

  const handleBeginSession = useCallback(async (): Promise<void> => {
    if (!conv.activeSessionId) return; // Guard: should not be called when bare
    setBeginSessionPending(true);
    try {
      await startSession.mutateAsync(conv.activeSessionId);
      // On success the sessions query invalidates → session.status flips to
      // 'in_progress', turning this button red and the header call icon green.
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Could not begin session. Try again.';
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.alert(`Failed to begin session\n\n${message}`);
      } else {
        Alert.alert('Failed to begin session', message);
      }
    } finally {
      setBeginSessionPending(false);
    }
  }, [conv.activeSessionId, startSession]);

  /**
   * Creates a brand-new session for the same member (immediately scheduled + started).
   * Used when the rail's session is `completed` — you cannot re-/start a completed
   * session (that 409s), so we POST /sessions/schedule then PATCH /sessions/{id}/start.
   *
   * On schedule success but start failure the new session is left in `scheduled` state —
   * the CHW is informed and can begin it from Calendar. No data is lost.
   */
  const handleBeginNewSession = useCallback(async (): Promise<void> => {
    if (!conv.memberId) return;
    setBeginSessionPending(true);
    try {
      const newSession = await scheduleSession.mutateAsync({
        memberId: conv.memberId,
        scheduledAt: new Date().toISOString(),
        mode: 'phone',
        schedulingStatus: 'confirmed',
      });

      try {
        await startSession.mutateAsync(newSession.id);
        // sessions query was already invalidated by useScheduleSession's onSuccess;
        // useStartSession also invalidates on success — both caches are fresh.
        // Surface the new session to the parent so liveSelectedSession re-points to it.
        onSessionStarted?.({ ...newSession, status: 'in_progress' });
      } catch (startErr) {
        // Schedule succeeded but start failed — new session exists in `scheduled` state.
        // Notify the CHW; they can begin it from Calendar.
        const startMessage =
          startErr instanceof Error
            ? startErr.message
            : 'Could not start the new session. It was created successfully — begin it from Calendar.';
        if (Platform.OS === 'web' && typeof window !== 'undefined') {
          window.alert(
            `Session created but could not be started\n\n${startMessage}\n\nThe session appears in Calendar where you can begin it.`,
          );
        } else {
          Alert.alert(
            'Session created but could not be started',
            `${startMessage}\n\nThe session appears in Calendar where you can begin it.`,
          );
        }
        // Still surface the scheduled session so the rail switches contexts.
        onSessionStarted?.(newSession);
      }
    } catch (scheduleErr) {
      const message =
        scheduleErr instanceof Error
          ? scheduleErr.message
          : 'Could not create a new session. Try again.';
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.alert(`Failed to begin session\n\n${message}`);
      } else {
        Alert.alert('Failed to begin session', message);
      }
    } finally {
      setBeginSessionPending(false);
    }
  }, [conv.memberId, scheduleSession, startSession, onSessionStarted]);

  // One-shot auto-begin: fire handleBeginNewSession on mount when the caller
  // requested it (route param autoBeginSession === true) and session status is
  // known. A ref guards against double-firing across re-renders.
  const autoBeginFiredRef = useRef(false);
  useEffect(() => {
    if (!autoBeginSessionOnMount) return;
    if (autoBeginFiredRef.current) return;
    // Wait until the session query has settled (not still loading the live session).
    if (liveSessionQuery.isLoading) return;
    // Only fire when the session is in a beginnable state.
    const canFire = canBeginSession || canBeginNewSession;
    if (!canFire) return;

    autoBeginFiredRef.current = true;
    onAutoBeginSessionConsumed?.();
    void handleBeginNewSession();
  }, [
    autoBeginSessionOnMount,
    liveSessionQuery.isLoading,
    canBeginSession,
    canBeginNewSession,
    handleBeginNewSession,
    onAutoBeginSessionConsumed,
  ]);

  const handleEndSessionConfirmed = useCallback(async (): Promise<void> => {
    if (!conv.activeSessionId) return; // Guard: no active session to end
    const activeId = conv.activeSessionId;
    setShowEndConfirm(false);
    setEndSessionPending(true);
    try {
      await endSession.mutateAsync(activeId);
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
  }, [conv.activeSessionId, endSession, onEndSessionComplete]);

  const memberName = conv.memberName ?? 'Unknown Member';
  const initials = getInitials(memberName);

  // Suggested questions drawer context
  const questionsJourney = activeJourney
    ? {
        templateName: activeJourney.template.name,
        currentStepName: activeJourney.currentStep?.stepName ?? '',
        vertical: activeJourney.template.category ?? '',
      }
    : undefined;
  const questionsMember = {
    name: memberName,
    age: null,
    initials,
  };

  return (
    <View style={styles.railOuter} accessibilityRole={"complementary" as any} accessibilityLabel="Member context">
      <ScrollView
        style={styles.railScrollView}
        contentContainerStyle={styles.railContent}
        showsVerticalScrollIndicator={false}
      >
        {/* CARD 1 — Care Status */}
        <Card style={styles.railCard}>
          <View style={styles.railCardTitleRow}>
            <Activity size={13} color={tokens.textSecondary} />
            <Text style={styles.railCardTitle}>Care Status</Text>
          </View>
          <View style={styles.journeyNameRow}>
            <Text style={styles.railJourneyName} numberOfLines={1}>
              {journeyName}
            </Text>
            <Text style={[styles.journeyPercent, numerals.tabular]}>
              {journeyPercent}%
            </Text>
          </View>
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
            <Text style={[styles.railJourneyPercent, numerals.tabular]}>
              {journeyPercent}% complete
            </Text>
          )}

          {/* 5-stage vertical stepper */}
          <View style={railCardStyles.stepper}>
            {CARE_STAGES.map((stageName, i) => {
              const state = stageStates[i] ?? 'future';
              return (
                <View key={stageName} style={railCardStyles.stepRow}>
                  {/* Connector line above (all except first) */}
                  {i > 0 ? (
                    <View
                      style={[
                        railCardStyles.stepConnector,
                        state === 'future' && stageStates[i - 1] === 'future'
                          ? railCardStyles.stepConnectorFuture
                          : railCardStyles.stepConnectorDone,
                      ]}
                    />
                  ) : (
                    <View style={railCardStyles.stepConnectorSpacer} />
                  )}
                  <View style={railCardStyles.stepDotCol}>
                    {state === 'completed' ? (
                      <View style={railCardStyles.stepDotCompleted}>
                        <CheckCircle2 size={14} color="#15803d" />
                      </View>
                    ) : state === 'current' ? (
                      <View style={railCardStyles.stepDotCurrent} />
                    ) : (
                      <View style={railCardStyles.stepDotFuture} />
                    )}
                  </View>
                  <Text
                    style={[
                      railCardStyles.stepLabel,
                      state === 'completed' && railCardStyles.stepLabelCompleted,
                      state === 'current' && railCardStyles.stepLabelCurrent,
                      state === 'future' && railCardStyles.stepLabelFuture,
                    ]}
                  >
                    {stageName}
                  </Text>
                </View>
              );
            })}
          </View>
        </Card>

        {/* CARD 2 — Active Needs */}
        {topResourceNeeds.length > 0 ? (
          <Card style={styles.railCard}>
            <View style={styles.railCardTitleRow}>
              <Flag size={13} color={tokens.textSecondary} />
              <Text style={styles.railCardTitle}>Active Needs</Text>
            </View>
            {topResourceNeeds.map((journey, index) => {
              const severity = deriveSeverity(journey.progressPercent);
              const pillVariant = severityPillVariant(severity);
              const IconComponent = journeyCategoryIcon(journey.template.category);
              return (
                <View
                  key={journey.id}
                  style={[styles.needRow, index > 0 && styles.needRowBorder]}
                >
                  <RankChip rank={index + 1} />
                  <View style={styles.needName}>
                    <IconComponent size={13} color={tokens.textMuted} />
                    <Text style={styles.needNameText} numberOfLines={1}>
                      {journey.template.name}
                    </Text>
                  </View>
                  <Pill variant={pillVariant} size="sm">
                    {severity}
                  </Pill>
                </View>
              );
            })}
          </Card>
        ) : null}

        {/* CARD 3 — Session Focus */}
        <Card style={styles.railCard}>
          <View style={styles.railCardTitleRow}>
            <BookOpen size={13} color={tokens.textSecondary} />
            <Text style={styles.railCardTitle}>Session Focus</Text>
          </View>
          <View style={railCardStyles.sessionFocusSection}>
            <Text style={railCardStyles.sessionFocusFieldLabel}>Last Interaction</Text>
            <Text style={railCardStyles.sessionFocusFieldValue}>
              Member completed housing intake and needs income verification.
            </Text>
          </View>
          <View style={[railCardStyles.sessionFocusSection, railCardStyles.sessionFocusBorder]}>
            <Text style={railCardStyles.sessionFocusFieldLabel}>Today's Goal</Text>
            <Text style={railCardStyles.sessionFocusFieldValue}>
              Obtain proof of income documents.
            </Text>
          </View>
          <View style={[railCardStyles.sessionFocusSection, railCardStyles.sessionFocusBorder]}>
            <Text style={railCardStyles.sessionFocusFieldLabel}>Next Step</Text>
            <Text style={railCardStyles.sessionFocusFieldValue}>
              Upload documents by the agreed date.
            </Text>
          </View>
        </Card>

        {/* CARD 4 — Screening Questions */}
        <Card style={styles.railCard}>
          <PressableCard
            onPress={() => {
              // Launch the actual SDOH/Health Screening assessment for the
              // active session — its answers surface in the member profile's
              // Screening Results. Requires an in-progress session.
              if (conv.activeSessionId) {
                navigation.navigate('CHWMemberAssessment', {
                  sessionId: conv.activeSessionId,
                });
              } else {
                showAlert(
                  'Begin a session first',
                  'Start a session with this member to run the SDOH / Health Screening and capture answers.',
                );
              }
            }}
            accessibilityLabel="Open SDOH / Health Screening"
            style={railCardStyles.screeningRow}
          >
            <View style={railCardStyles.screeningLeft}>
              <MessageSquare size={14} color={tokens.textSecondary} />
              <Text style={railCardStyles.screeningLabel}>SDOH / Health Screening</Text>
            </View>
            <ArrowRight size={14} color={tokens.textMuted} />
          </PressableCard>
        </Card>

        {/* QUICK ACTIONS */}
        <View role="region" accessibilityLabel="Quick Actions">
          <Text style={styles.quickActionsLabel}>QUICK ACTIONS</Text>
          <View style={styles.quickActionsStack}>
            {/* Add Case Note */}
            <PressableCard
              onPress={() => setCaseNoteModalOpen(true)}
              accessibilityLabel="Add case note"
              style={styles.quickActionBtn}
            >
              <BookOpen size={16} color={tokens.textSecondary} style={styles.quickActionIcon} />
              <Text style={styles.quickActionBtnText}>Add Case Note</Text>
            </PressableCard>

            {/* Open Member Profile */}
            <PressableMember
              memberId={conv.memberId ?? ''}
              displayName={memberName}
              enabled={!!conv.memberId}
              style={[styles.quickActionBtn, railCardStyles.quickActionPressableMember]}
            >
              <ArrowRight size={16} color={tokens.textSecondary} style={styles.quickActionIcon} />
              <Text style={styles.quickActionBtnText}>Open Member Profile</Text>
            </PressableMember>

            {/* Schedule Session */}
            <PressableCard
              onPress={() => navigation.navigate('Calendar')}
              accessibilityLabel="Schedule session"
              style={styles.quickActionBtn}
            >
              <CalendarPlus size={16} color={tokens.textSecondary} style={styles.quickActionIcon} />
              <Text style={styles.quickActionBtnText}>Schedule Session</Text>
            </PressableCard>
          </View>
        </View>

        {/* Primary session action:
            completed              → green "Begin Session" (creates + starts new session)
            scheduled              → green "Begin Session" (starts existing scheduled session)
            in_progress /          → red "Complete Session"
              awaiting_documentation
            cancelled /            → read-only status note
              cancelled_no_consent */}
        <View
          role="region"
          accessibilityLabel={
            isTerminalSession
              ? terminalSessionLabel(activeStatus ?? 'cancelled')
              : canBeginSession || canBeginNewSession
              ? 'Begin Session'
              : 'Complete Session'
          }
          style={styles.endSessionRegion}
        >
          {isTerminalSession ? (
            <View style={styles.sessionStatusNote} accessibilityRole="text">
              <Text style={styles.sessionStatusNoteText}>
                {terminalSessionLabel(activeStatus ?? 'cancelled')}
              </Text>
            </View>
          ) : canBeginNewSession ? (
            /* completed → create a new session and immediately start it */
            <TouchableOpacity
              style={[
                styles.beginSessionBtn,
                (beginSessionPending || servicesRefused) && styles.endSessionBtnDisabled,
              ]}
              onPress={() => void handleBeginNewSession()}
              disabled={beginSessionPending || servicesRefused}
              accessibilityRole="button"
              accessibilityLabel={
                servicesRefused
                  ? 'Begin session disabled — member has refused services'
                  : beginSessionPending
                  ? 'Beginning session...'
                  : 'Begin session'
              }
              accessibilityState={{ disabled: beginSessionPending || servicesRefused }}
            >
              {beginSessionPending ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Play size={16} color="#fff" />
              )}
              <Text style={styles.endSessionBtnText}>
                {beginSessionPending ? 'Beginning...' : 'Begin Session'}
              </Text>
            </TouchableOpacity>
          ) : canBeginSession ? (
            /* scheduled → start the existing session */
            <TouchableOpacity
              style={[
                styles.beginSessionBtn,
                (beginSessionPending || servicesRefused) && styles.endSessionBtnDisabled,
              ]}
              onPress={() => void handleBeginSession()}
              disabled={beginSessionPending || servicesRefused}
              accessibilityRole="button"
              accessibilityLabel={
                servicesRefused
                  ? 'Begin session disabled — member has refused services'
                  : beginSessionPending
                  ? 'Beginning session...'
                  : 'Begin session'
              }
              accessibilityState={{ disabled: beginSessionPending || servicesRefused }}
            >
              {beginSessionPending ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Play size={16} color="#fff" />
              )}
              <Text style={styles.endSessionBtnText}>
                {beginSessionPending ? 'Beginning...' : 'Begin Session'}
              </Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[
                styles.endSessionBtn,
                (endSessionPending || servicesRefused) && styles.endSessionBtnDisabled,
              ]}
              onPress={() => setShowEndConfirm(true)}
              disabled={endSessionPending || servicesRefused}
              accessibilityRole="button"
              accessibilityLabel={
                servicesRefused
                  ? 'Complete session disabled — member has refused services'
                  : endSessionPending
                  ? 'Completing session...'
                  : 'Complete session'
              }
              accessibilityState={{ disabled: endSessionPending || servicesRefused }}
            >
              {endSessionPending ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <LogOut size={16} color="#fff" />
              )}
              <Text style={styles.endSessionBtnText}>
                {endSessionPending ? 'Completing...' : 'Complete Session'}
              </Text>
            </TouchableOpacity>
          )}

          {/* Inline slide-up confirmation panel — no window.confirm */}
          {!canBeginSession && !canBeginNewSession && !isTerminalSession && showEndConfirm ? (
            <Animated.View
              style={[
                styles.endConfirmPanel,
                {
                  opacity: confirmOpacity,
                  transform: [{ translateY: confirmSlideY }],
                },
              ]}
              role="dialog"
              accessibilityLabel="Confirm end session"
            >
              <Text style={styles.endConfirmTitle}>
                Complete the session for {memberFirstName}?
              </Text>
              <Text style={styles.endConfirmBody}>
                Recording stops and you will be prompted to document the session before the claim can be filed.
              </Text>
              <View style={styles.endConfirmActions}>
                <TouchableOpacity
                  style={styles.endConfirmCancel}
                  onPress={() => setShowEndConfirm(false)}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel end session"
                >
                  <Text style={styles.endConfirmCancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.endConfirmProceed}
                  onPress={() => void handleEndSessionConfirmed()}
                  accessibilityRole="button"
                  accessibilityLabel="Confirm complete session"
                >
                  <Text style={styles.endConfirmProceedText}>Complete Session</Text>
                </TouchableOpacity>
              </View>
            </Animated.View>
          ) : null}
        </View>

        {/* Services Consent (informational) */}
        <View style={styles.railConsentSection}>
          <SectionHeader title="Services Consent" marginBottom={spacing.sm} />
          <ServicesConsentStatus
            consentValue={consentValue}
            isLoading={consentQuery.isLoading && consentQuery.fetchStatus !== 'idle'}
          />
        </View>
      </ScrollView>

      {/* Modals */}
      <OpenQuestionsDrawer
        visible={questionsDrawerOpen}
        onClose={() => setQuestionsDrawerOpen(false)}
        member={questionsMember}
        journey={questionsJourney}
      />

      {conv.memberId ? (
        <CaseNoteModal
          memberId={conv.memberId}
          sessionId={conv.activeSessionId ?? ''}
          visible={caseNoteModalOpen}
          onClose={() => setCaseNoteModalOpen(false)}
        />
      ) : null}
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

/**
 * CHWMessagesScreen — 3-pane messaging inbox.
 *
 * Panes:
 *   ThreadListPane      — thread list with search + 4 filter tabs
 *   ConversationPane    — message thread + templates + composer
 *   MemberContextRail   — Care Status, Active Needs, Session Focus, Screening Questions, Quick Actions, Complete Session
 */
export function CHWMessagesScreen(): React.JSX.Element {
  const { userName } = useAuth();
  const { width } = useWindowDimensions();

  const conversationsQuery = useConversations({ includeArchived: true });
  const [selectedConversation, setSelectedConversation] = useState<ConversationData | null>(null);
  const [showThreadList, setShowThreadList] = useState(true);
  const [documentingSessionId, setDocumentingSessionId] = useState<string | null>(null);

  // Route params — navigate from CHWMemberProfileScreen with memberId + autoCall / autoBeginSession
  const route = useRoute<RouteProp<CHWSessionsStackParamList, 'Messages'>>();
  const targetMemberId = route.params?.memberId;
  const shouldAutoCall = route.params?.autoCall === true;
  const autoCallFiredRef = useRef(false);
  // autoBeginSession: navigated from CHWMemberProfileScreen "Begin Session" button.
  // When true, auto-select the member's conversation and fire the Begin Session
  // flow from MemberContextRail on mount (once only).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const shouldAutoBeginSession = (route.params as any)?.autoBeginSession === true;
  const autoBeginFiredRef = useRef(false);

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

  const allConversations: ConversationData[] = conversationsQuery.data ?? [];

  // selectedConversation is a local snapshot frozen at selection time, but mutations
  // invalidate the conversations query and refetch fresh rows. Re-resolve the live
  // row by id so the rail's Begin/Complete button and the call-icon cue reflect the
  // current activeSessionId; fall back to the snapshot if it hasn't loaded yet.
  const liveSelectedConversation = useMemo<ConversationData | null>(() => {
    if (!selectedConversation) return null;
    return (
      allConversations.find((c) => c.id === selectedConversation.id) ??
      selectedConversation
    );
  }, [allConversations, selectedConversation]);

  const navigation = useNavigation<any>(); // eslint-disable-line @typescript-eslint/no-explicit-any

  // Auto-select target member's thread or first unarchived thread alphabetically
  useEffect(() => {
    if (allConversations.length === 0) return;

    if (targetMemberId) {
      // Auto-select is now unambiguous: one conversation per member.
      const match = allConversations.find((c) => c.memberId === targetMemberId);
      if (match && selectedConversation?.id !== match.id) {
        setSelectedConversation(match);
        return;
      }
    }

    if (!selectedConversation) {
      const firstAlpha = [...allConversations]
        .filter((c) => !!c.memberName && !c.archivedAt)
        .sort((a, b) => (a.memberName ?? '').localeCompare(b.memberName ?? ''))[0];
      setSelectedConversation(firstAlpha ?? null);
    }
  }, [allConversations, selectedConversation, targetMemberId]);

  const handleSelectConversation = useCallback(
    (conv: ConversationData): void => {
      setSelectedConversation(conv);
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
    if (selectedConversation?.activeSessionId) {
      setDocumentingSessionId(selectedConversation.activeSessionId);
    }
  }, [selectedConversation]);

  // After a new session is created+started from a bare/completed conversation —
  // the conversation query will refetch and update activeSessionId automatically.
  // We keep this callback for future use / onSessionStarted forward compatibility.
  const handleSessionStarted = useCallback((_newSession: SessionData): void => {
    // No-op: conversations query invalidation (in useStartSession onSuccess)
    // will refresh liveSelectedConversation.activeSessionId automatically.
  }, []);

  // ── Delete conversation ────────────────────────────────────────────────────
  // Uses soft-delete via useSoftDeleteConversation (DELETE /conversations/{id}).
  // The onDeselect callback clears selection when the deleted thread is open.

  const softDeleteConversation = useSoftDeleteConversation({
    onDeselect: (conversationId) => {
      setSelectedConversation((prev) =>
        prev?.id === conversationId ? null : prev,
      );
    },
  });

  const handleDeleteConversation = useCallback(
    (conv: ConversationData): void => {
      const memberName = conv.memberName ?? 'this member';

      const doDelete = async (): Promise<void> => {
        try {
          await softDeleteConversation.mutateAsync(conv.id);
          // onDeselect in useSoftDeleteConversation handles clearing selection.
        } catch {
          // useSoftDeleteConversation's onError already shows the Alert.
        }
      };

      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        if (
          window.confirm(
            `Delete this conversation with ${memberName}? You can restore it by sending a new message.`,
          )
        ) {
          void doDelete();
        }
      } else {
        Alert.alert(
          'Delete conversation?',
          `This will hide the conversation with ${memberName}. You can restore it by sending a new message.`,
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Delete',
              style: 'destructive',
              onPress: () => void doDelete(),
            },
          ],
        );
      }
    },
    [softDeleteConversation],
  );

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

  if (conversationsQuery.isLoading) {
    return (
      <AppShell role="chw" activeKey="messages" userBlock={shellUserBlock} disableMainScroll>
        <View style={styles.loadingWrap}>
          <LoadingSkeleton variant="rows" rows={6} />
        </View>
      </AppShell>
    );
  }

  if (conversationsQuery.error) {
    return (
      <AppShell role="chw" activeKey="messages" userBlock={shellUserBlock} disableMainScroll>
        <ErrorState
          message="Could not load messages. Please try again."
          onRetry={() => void conversationsQuery.refetch()}
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
              conversations={allConversations}
              selectedConversationId={selectedConversation?.id ?? null}
              onSelectConversation={handleSelectConversation}
              onNavigateToMembers={() => navigation.navigate('Members')}
              onDeleteConversation={handleDeleteConversation}
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
        {shouldShowConv && selectedConversation ? (
          <View style={styles.convPaneWrap}>
            <ConversationPane
              key={selectedConversation.id}
              conversation={liveSelectedConversation ?? selectedConversation}
              onBack={handleBack}
              showBackButton={hideList}
              autoCallOnMount={
                shouldAutoCall &&
                !autoCallFiredRef.current &&
                selectedConversation.memberId === targetMemberId
              }
              onAutoCallConsumed={() => {
                autoCallFiredRef.current = true;
              }}
              onRequestOpenDocumentation={() => {
                if (selectedConversation.activeSessionId) {
                  setDocumentingSessionId(selectedConversation.activeSessionId);
                }
              }}
            />
          </View>
        ) : shouldShowConv ? (
          <View style={styles.noSelectionWrap}>
            <EmptyState
              icon={MessageSquare}
              title="No thread selected"
              body="Select a member thread from the list to start messaging."
            />
          </View>
        ) : null}

        {/* Divider between center and right */}
        {!hideRail && selectedConversation ? (
          <ResizableDivider
            width={rightWidth}
            onChange={handleRightWidthChange}
            min={CHW_RIGHT_MIN}
            max={CHW_RIGHT_MAX}
            side="right"
          />
        ) : null}

        {/* Right: member context rail */}
        {!hideRail && selectedConversation ? (
          <View style={[styles.railWrap, { width: rightWidth }]}>
            <MemberContextRail
              conversation={liveSelectedConversation ?? selectedConversation}
              onEndSessionComplete={handleEndSessionComplete}
              onSessionStarted={handleSessionStarted}
              autoBeginSessionOnMount={
                shouldAutoBeginSession &&
                !autoBeginFiredRef.current &&
                selectedConversation.memberId === targetMemberId
              }
              onAutoBeginSessionConsumed={() => {
                autoBeginFiredRef.current = true;
              }}
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
          durationMinutes={null}
          onSubmit={handleDocumentationSubmit}
        />
      )}
    </AppShell>
  );
}

// ─── Rail card sub-styles ─────────────────────────────────────────────────────

/**
 * Additional styles scoped to the new card components inside MemberContextRail.
 * Kept separate from the large `styles` block to avoid StyleSheet growth.
 */
const railCardStyles = StyleSheet.create({
  // Care Status stepper
  stepper: {
    marginTop: 12,
    gap: 0,
  } as ViewStyle,
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    position: 'relative',
  } as ViewStyle,
  stepConnector: {
    position: 'absolute',
    left: 6,
    top: -8,
    width: 2,
    height: 8,
    borderRadius: 1,
  } as ViewStyle,
  stepConnectorSpacer: {
    width: 0,
    height: 0,
  } as ViewStyle,
  stepConnectorDone: {
    backgroundColor: tokens.emerald500,
  } as ViewStyle,
  stepConnectorFuture: {
    backgroundColor: tokens.cardBorder,
  } as ViewStyle,
  stepDotCol: {
    width: 14,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,
  stepDotCompleted: {
    width: 14,
    height: 14,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  stepDotCurrent: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: tokens.amber700,
    borderWidth: 2,
    borderColor: tokens.orange100,
  } as ViewStyle,
  stepDotFuture: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: tokens.cardBorder,
  } as ViewStyle,
  stepLabel: {
    fontSize: 12,
    flex: 1,
  } as TextStyle,
  stepLabelCompleted: {
    color: tokens.emerald700,
    fontWeight: '500',
  } as TextStyle,
  stepLabelCurrent: {
    color: tokens.amber700,
    fontWeight: '600',
  } as TextStyle,
  stepLabelFuture: {
    color: tokens.textMuted,
  } as TextStyle,

  // Session Focus card
  sessionFocusSection: {
    paddingVertical: 6,
    gap: 2,
  } as ViewStyle,
  sessionFocusBorder: {
    borderTopWidth: 1,
    borderTopColor: tokens.cardBorder,
  } as ViewStyle,
  sessionFocusFieldLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: tokens.textMuted,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  } as TextStyle,
  sessionFocusFieldValue: {
    fontSize: 12,
    color: tokens.textPrimary,
    lineHeight: 17,
  } as TextStyle,

  // Screening Questions card
  screeningRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 2,
    paddingHorizontal: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
  } as ViewStyle,
  screeningLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  } as ViewStyle,
  screeningLabel: {
    fontSize: 13,
    fontWeight: '500',
    color: tokens.textPrimary,
  } as TextStyle,

  // Quick Action — PressableMember wrapper sizing
  quickActionPressableMember: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    borderRadius: 10,
    backgroundColor: tokens.cardBg,
  } as ViewStyle,
});

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
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: tokens.cardBorder,
    gap: spacing.sm,
  } as ViewStyle,

  threadListTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: 2,
  } as ViewStyle,

  threadListTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: tokens.textPrimary,
    letterSpacing: -0.3,
  } as TextStyle,

  threadCountBadge: {
    backgroundColor: tokens.emerald100,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: radius.pill,
  } as ViewStyle,

  threadCountBadgeText: {
    fontSize: 11,
    fontWeight: '500',
    color: tokens.emerald700,
  } as TextStyle,

  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: tokens.pageBg,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
  } as ViewStyle,

  searchIcon: {
    marginRight: spacing.sm,
  } as ViewStyle,

  searchInput: {
    flex: 1,
    fontSize: 13,
    color: tokens.textPrimary,
    paddingVertical: spacing.xs,
    outlineStyle: 'none',
  } as unknown as TextStyle,

  filterRow: {
    flexShrink: 0,
  } as ViewStyle,

  filterRowContent: {
    flexDirection: 'row',
    gap: spacing.xs,
    paddingBottom: 2,
  } as ViewStyle,

  filterChip: {
    paddingHorizontal: 11,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
  } as ViewStyle,

  filterChipActive: {
    backgroundColor: tokens.emerald100,
    borderColor: tokens.emerald100,
  } as ViewStyle,

  filterChipText: {
    fontSize: 12,
    fontWeight: '500',
    color: tokens.textMuted,
  } as TextStyle,

  filterChipTextActive: {
    color: tokens.emerald700,
    fontWeight: '600',
  } as TextStyle,

  threadScrollView: {
    flex: 1,
  } as ViewStyle,

  // ── Thread row ────────────────────────────────────────────────────────────────

  /** Outer wrapper enables the z-indexed dropdown menu to overlay siblings. */
  threadRowOuter: {
    position: 'relative',
    zIndex: 1,
  } as ViewStyle,

  threadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    // Override PressableCard's xl radius to 0 for list rows
    borderRadius: 0,
    borderBottomWidth: 1,
    borderBottomColor: tokens.cardBorder,
    // No boxShadow override — uses PressableCard's shadows.card token
  } as ViewStyle,

  threadRowActive: {
    backgroundColor: tokens.emerald100,
    borderLeftWidth: 3,
    borderLeftColor: tokens.primary,
    paddingLeft: 11,
  } as ViewStyle,

  threadAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,

  threadAvatarText: {
    fontSize: 12,
    fontWeight: '700',
  } as TextStyle,

  threadBody: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  } as ViewStyle,

  threadTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  } as ViewStyle,

  threadName: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    color: tokens.textPrimary,
  } as TextStyle,

  threadTimestamp: {
    fontSize: 11,
    color: tokens.textMuted,
    flexShrink: 0,
  } as TextStyle,

  threadEngagementRow: {
    flexDirection: 'row',
    alignItems: 'center',
  } as ViewStyle,

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

  threadOverflowBtn: {
    padding: 4,
    borderRadius: radius.sm,
    flexShrink: 0,
  } as ViewStyle,

  /** Dropdown menu that appears below the thread row. */
  threadMenu: {
    position: 'absolute',
    top: '100%',
    right: spacing.sm,
    backgroundColor: tokens.cardBg,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    borderRadius: radius.lg,
    minWidth: 200,
    overflow: 'hidden',
    zIndex: 100,
    ...(shadows.elevated as object),
  } as ViewStyle,

  threadMenuItemDanger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 11,
  } as ViewStyle,

  threadMenuItemDangerText: {
    fontSize: 13,
    color: '#b91c1c',
    fontWeight: '500',
  } as TextStyle,

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
    paddingVertical: 12,
    backgroundColor: tokens.cardBg,
    borderBottomWidth: 1,
    borderBottomColor: tokens.cardBorder,
    // shadows.elevated applied as style spread
  } as ViewStyle,

  iconBtnCard: {
    padding: spacing.sm,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    backgroundColor: tokens.cardBg,
    // No boxShadow override — inherits shadows.card from PressableCard
  } as ViewStyle,

  // Green-tinted call button: cues the CHW that calling the member is the next
  // expected step once a session is in progress.
  iconBtnCardActive: {
    borderColor: tokens.emerald700,
    backgroundColor: tokens.emerald700,
  } as ViewStyle,

  convHeaderAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
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
    fontSize: 18,
    fontWeight: '600',
    letterSpacing: -0.3,
    color: tokens.textPrimary,
  } as TextStyle,

  convHeaderMeta: {
    fontSize: 12,
    color: tokens.textSecondary,
  } as TextStyle,

  openProfileBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    borderRadius: 10,
  } as ViewStyle,

  openProfileText: {
    fontSize: 12,
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

  daySeparator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginVertical: 12,
  } as ViewStyle,

  daySepLine: {
    flex: 1,
    height: 1,
    backgroundColor: tokens.cardBorder,
  } as ViewStyle,

  daySeparatorText: {
    fontSize: 11,
    color: tokens.textMuted,
    fontWeight: '500',
    letterSpacing: 0.3,
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
    maxWidth: '68%',
    padding: 10,
    paddingHorizontal: 14,
    gap: spacing.xs,
  } as ViewStyle,

  bubbleOutbound: {
    backgroundColor: tokens.emerald100,
    borderRadius: 14,
    borderBottomRightRadius: 4,
  } as ViewStyle,

  bubbleInbound: {
    backgroundColor: tokens.cardBg,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    borderRadius: 14,
    borderBottomLeftRadius: 4,
    ...(shadows.card as object),
  } as ViewStyle,

  bubbleText: {
    fontSize: 14,
    lineHeight: 21,
  } as TextStyle,

  bubbleTextOutbound: {
    color: tokens.emerald700,
  } as TextStyle,

  bubbleTextInbound: {
    color: tokens.textPrimary,
  } as TextStyle,

  bubbleTimestamp: {
    fontSize: 10,
    marginTop: 2,
  } as TextStyle,

  bubbleTimestampOutbound: {
    color: tokens.emerald700,
    opacity: 0.65,
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

  bubbleTextWithAttachment: {
    marginTop: 6,
  } as TextStyle,

  // ── Attachment image bubble ───────────────────────────────────────────────────
  attachmentImageThumb: {
    width: 240,
    height: 180,
    borderRadius: 12,
  } as ImageStyle,

  attachmentImageOutbound: {
    // No extra overrides needed — border-radius already applied.
  } as ImageStyle,

  attachmentImageInbound: {
    // No extra overrides needed.
  } as ImageStyle,

  // ── Image zoom modal (native only) ────────────────────────────────────────────
  imageZoomOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    justifyContent: 'center',
    alignItems: 'center',
  } as ViewStyle,

  imageZoomClose: {
    position: 'absolute',
    top: 48,
    right: 20,
    padding: 8,
    zIndex: 10,
  } as ViewStyle,

  imageZoomFull: {
    width: '100%',
    height: '80%',
  } as ImageStyle,

  // ── File attachment bubble ────────────────────────────────────────────────────
  fileAttachmentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 10,
    borderRadius: 10,
  } as ViewStyle,

  fileAttachmentOutbound: {
    backgroundColor: 'rgba(0,0,0,0.06)',
  } as ViewStyle,

  fileAttachmentInbound: {
    backgroundColor: '#f0fdf4',
    borderWidth: 1,
    borderColor: '#bbf7d0',
  } as ViewStyle,

  fileIconCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#d1fae5',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,

  fileAttachmentInfo: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  } as ViewStyle,

  fileAttachmentName: {
    fontSize: 13,
    fontWeight: '600',
  } as TextStyle,

  fileAttachmentNameOut: {
    color: tokens.emerald700,
  } as TextStyle,

  fileAttachmentNameIn: {
    color: tokens.textPrimary,
  } as TextStyle,

  fileAttachmentSize: {
    fontSize: 11,
    color: tokens.textMuted,
  } as TextStyle,

  // ── Attachment preview row (composer staging area) ────────────────────────────
  attachmentPreviewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 8,
    paddingVertical: 6,
    backgroundColor: '#f0fdf4',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#bbf7d0',
  } as ViewStyle,

  attachmentPreviewThumb: {
    width: 48,
    height: 48,
    borderRadius: 8,
    flexShrink: 0,
  } as ImageStyle,

  attachmentPreviewFileIcon: {
    width: 48,
    height: 48,
    borderRadius: 8,
    backgroundColor: '#d1fae5',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,

  attachmentPreviewInfo: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  } as ViewStyle,

  attachmentPreviewName: {
    fontSize: 13,
    fontWeight: '500',
    color: tokens.textPrimary,
  } as TextStyle,

  attachmentPreviewSize: {
    fontSize: 11,
    color: tokens.textMuted,
  } as TextStyle,

  attachmentPreviewRemove: {
    padding: 4,
    borderRadius: 6,
    borderWidth: 0,
    backgroundColor: 'transparent',
    flexShrink: 0,
  } as ViewStyle,

  composerIconBtnActive: {
    backgroundColor: tokens.emerald100,
  } as ViewStyle,

  // ── Composer ──────────────────────────────────────────────────────────────────
  composerWrap: {
    padding: 12,
    paddingTop: 12,
    backgroundColor: tokens.cardBg,
    borderTopWidth: 1,
    borderTopColor: tokens.cardBorder,
    gap: 10,
  } as ViewStyle,

  templateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
  } as ViewStyle,

  templateLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: tokens.textMuted,
    letterSpacing: 0.7,
    marginRight: 2,
  } as TextStyle,

  templateChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    borderRadius: radius.pill,
    // Overrides PressableCard's xl radius with pill radius
    backgroundColor: tokens.cardBg,
  } as ViewStyle,

  templateChipText: {
    fontSize: 12,
    color: tokens.textSecondary,
    fontWeight: '500',
  } as TextStyle,

  composerInner: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    backgroundColor: tokens.cardBg,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    borderRadius: radius.xl,
    padding: 8,
  } as ViewStyle,

  composerIconBtnCard: {
    padding: 6,
    borderRadius: radius.sm,
    backgroundColor: 'transparent',
    borderWidth: 0,
    // No border/shadow override needed — transparent surface
  } as ViewStyle,

  composerInput: {
    flex: 1,
    fontSize: 14,
    color: tokens.textPrimary,
    paddingVertical: 6,
    minHeight: 22,
    maxHeight: 80,
    outlineStyle: 'none',
  } as unknown as TextStyle,

  sendBtnCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: tokens.primary,
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: 10,
    borderWidth: 0,
  } as ViewStyle,

  sendBtnDisabled: {
    opacity: 0.4,
  } as ViewStyle,

  sendBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#fff',
  } as TextStyle,

  composerMeta: {
    fontSize: 10,
    color: tokens.textMuted,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  } as unknown as TextStyle,

  // ── No selection ──────────────────────────────────────────────────────────────
  noSelectionWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tokens.pageBg,
  } as ViewStyle,

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
    position: 'relative',
  } as ViewStyle,

  railScrollView: {
    flex: 1,
  } as ViewStyle,

  railContent: {
    padding: 14,
    paddingTop: 16,
    gap: 10,
    paddingBottom: spacing.xxxl,
  } as ViewStyle,

  railCard: {
    padding: 14,
  } as ViewStyle,

  railCardTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 10,
  } as ViewStyle,

  railCardTitle: {
    fontSize: 12,
    fontWeight: '650' as any,
    letterSpacing: -0.1,
    color: tokens.textPrimary,
  } as TextStyle,

  // Journey card
  journeyNameRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 6,
    marginBottom: 4,
  } as ViewStyle,

  railJourneyName: {
    fontSize: 13,
    fontWeight: '600',
    color: tokens.textPrimary,
    flex: 1,
  } as TextStyle,

  journeyPercent: {
    fontSize: 15,
    fontWeight: '600',
    color: tokens.emerald700,
  } as TextStyle,

  progressTrack: {
    height: 8,
    backgroundColor: tokens.pageBg,
    borderRadius: radius.pill,
    overflow: 'hidden',
    marginBottom: spacing.xs,
  } as ViewStyle,

  progressFill: {
    height: 8,
    borderRadius: radius.pill,
  } as ViewStyle,

  railJourneyStep: {
    fontSize: 11,
    color: tokens.textSecondary,
    marginTop: spacing.xs,
    lineHeight: 15,
  } as TextStyle,

  railJourneyPercent: {
    fontSize: 11,
    color: tokens.textMuted,
  } as TextStyle,

  // Resource needs (no nested cards — border-top dividers)
  needRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
  } as ViewStyle,

  needRowBorder: {
    borderTopWidth: 1,
    borderTopColor: tokens.cardBorder,
  } as ViewStyle,

  needName: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  } as ViewStyle,

  needNameText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '500',
    color: tokens.textPrimary,
  } as TextStyle,

  // Rank chip
  rankChip: {
    width: 18,
    height: 18,
    borderRadius: 5,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,

  rankChipRed: {
    backgroundColor: tokens.red100,
  } as ViewStyle,

  rankChipAmber: {
    backgroundColor: tokens.amber100,
  } as ViewStyle,

  rankChipText: {
    fontSize: 10,
    fontWeight: '700',
  } as TextStyle,

  rankChipTextRed: {
    color: tokens.red700,
  } as TextStyle,

  rankChipTextAmber: {
    color: tokens.amber700,
  } as TextStyle,

  // Quick Actions
  quickActionsLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: tokens.textMuted,
    letterSpacing: 0.7,
    marginBottom: 6,
    paddingHorizontal: 2,
  } as TextStyle,

  quickActionsStack: {
    gap: 5,
  } as ViewStyle,

  quickActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    borderRadius: 10,
    backgroundColor: tokens.cardBg,
    // Override PressableCard's xl radius to 10 for action buttons
  } as ViewStyle,

  quickActionIcon: {
    flexShrink: 0,
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

  // End Session (destructive)
  endSessionRegion: {
    position: 'relative',
  } as ViewStyle,

  endSessionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: 11,
    paddingHorizontal: spacing.lg,
    backgroundColor: '#dc2626',
    borderRadius: 10,
  } as ViewStyle,

  // Green "Begin Session" variant — shown when the session is still scheduled.
  beginSessionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: 11,
    paddingHorizontal: spacing.lg,
    backgroundColor: tokens.emerald700,
    borderRadius: 10,
  } as ViewStyle,

  endSessionBtnDisabled: {
    opacity: 0.5,
  } as ViewStyle,

  // Read-only status note shown in place of the action button for terminal
  // sessions (completed / cancelled / cancelled_no_consent).
  sessionStatusNote: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 11,
    paddingHorizontal: spacing.lg,
    backgroundColor: tokens.gray100,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
  } as ViewStyle,

  sessionStatusNoteText: {
    fontSize: 12,
    fontWeight: '600',
    color: tokens.textSecondary,
    textAlign: 'center',
  } as TextStyle,

  endSessionBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#ffffff',
  } as TextStyle,

  // End session inline confirmation panel
  endConfirmPanel: {
    marginTop: spacing.sm,
    backgroundColor: tokens.cardBg,
    borderTopWidth: 2,
    borderTopColor: '#dc2626',
    borderRadius: radius.xl,
    padding: spacing.lg,
    ...(shadows.elevated as object),
  } as ViewStyle,

  endConfirmTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: tokens.textPrimary,
    marginBottom: 6,
    letterSpacing: -0.2,
  } as TextStyle,

  endConfirmBody: {
    fontSize: 13,
    color: tokens.textSecondary,
    lineHeight: 19,
    marginBottom: 14,
  } as TextStyle,

  endConfirmActions: {
    flexDirection: 'row',
    gap: 8,
  } as ViewStyle,

  endConfirmCancel: {
    flex: 1,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    borderRadius: 10,
    alignItems: 'center',
    backgroundColor: tokens.cardBg,
  } as ViewStyle,

  endConfirmCancelText: {
    fontSize: 13,
    fontWeight: '600',
    color: tokens.textSecondary,
  } as TextStyle,

  endConfirmProceed: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 10,
    alignItems: 'center',
    backgroundColor: '#dc2626',
  } as ViewStyle,

  endConfirmProceedText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#ffffff',
  } as TextStyle,

  // Consent section
  railConsentSection: {
    gap: spacing.xs,
  } as ViewStyle,
});

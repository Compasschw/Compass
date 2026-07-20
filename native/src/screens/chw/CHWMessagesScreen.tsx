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
 * SDOH / Health Screening panel (InlineSdohPanel) sizing:
 *   >=1280px (rail visible) → always a real sibling pane, never an overlay.
 *   On widths too narrow for all 4 columns at once (>=1280 and
 *   <SDOH_PANEL_PANE_BREAKPOINT) opening it temporarily collapses the
 *   thread-list pane to reclaim room instead of falling back to a
 *   rail-covering overlay sheet — see `collapseListForSdoh` below.
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
 *   - Engagement Pill in thread row list + conversation header
 *
 * Active-session control surface (#19/#20, 2026-07-13): while a session is
 * in_progress / awaiting_documentation, the rail no longer shows its own
 * "Complete Session" button or confirm panel — ActiveSessionBadge (mounted
 * app-wide for CHWs, see components/sessions/ActiveSessionBadge.tsx) is the
 * SOLE control surface for Complete / Cancel / Missed while a session is
 * active. The rail shows a read-only note pointing to the badge instead (see
 * `isActiveSession` in MemberContextRail). Tapping Complete on the badge (or
 * landing here with route.params.promptComplete === true) calls
 * POST /sessions/{id}/end directly, then opens DocumentationModal as an
 * overlay — no intermediate confirm panel.
 *
 * Hard constraints (do NOT modify):
 *   - Do NOT modify DashboardSidebar.
 *   - Do NOT add new backend endpoints.
 *   - Do NOT alter session-per-call backend behaviour or call-bridge calls.
 *   - Do NOT claim TLS+at-rest is E2E encryption.
 *
 * STUB NOTES:
 *   - "Add Case Note" → Wired to POST /api/v1/case-notes (shipped 2026-06-09).
 *   - "Complete" (via ActiveSessionBadge or promptComplete) → POST
 *     /sessions/{id}/end, then opens DocumentationModal directly.
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
  Clock,
  CalendarPlus,
  Paperclip,
  Image as ImageIcon,
  Link as LinkIcon,
  Send,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  FileText,
  X,
  Download,
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
  ChevronLeft,
  ChevronRight,
  MoreVertical,
  Trash2,
  Pin,
  Archive,
  Bell,
  BellOff,
  Info,
} from 'lucide-react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { CHWSessionsStackParamList } from '../../navigation/CHWTabNavigator';

import {
  AppShell,
  Card,
  Pill,
  SectionHeader,
  ResizableDivider,
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
  useConversationMarkRead,
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
  useToggleSessionMute,
  useSession as useSessionHook,
  useChwChecklist,
  type ConversationData,
  type MessageData,
  type SendConversationMessageVars,
  type SessionData,
  type SessionMessageLocal,
  type MemberJourneyResponse,
  useChwMemberResourceNeedLevels,
} from '../../hooks/useApiQueries';
import {
  activeJourneysWithLevel,
  type JourneySeverity,
} from '../../lib/journeyPriority';
import {
  useEngagementStatus,
} from '../../hooks/useMessagesInsights';
import { SwipeableThreadRow } from '../../components/chw/SwipeableThreadRow';
import { applyThreadFilter, type ThreadFilterTab } from './threadFilter';
import { formatElapsedSince } from '../../utils/sessionTimer';
import {
  useMessageAttachmentUpload,
  type MessageAttachmentUploadResult,
} from '../../hooks/useFileUpload';
import { OpenQuestionsDrawer } from '../../components/chw/OpenQuestionsDrawer';
import { DocumentationModal } from '../../components/sessions/DocumentationModal';
import {
  InlineSdohPanel,
  SDOH_PANEL_PANE_BREAKPOINT,
} from '../../components/assessment/InlineSdohPanel';
import type { SessionDocumentation } from '../../data/mock';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';
import { PressableMember } from '../../components/shared/PressableMember';
import { colors as tokens, spacing, radius, numerals, shadows } from '../../theme/tokens';
import { BP_PHONE } from '../../constants/breakpoints';

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

/** localStorage key for the CHW's muted conversation ids. */
const LS_KEY_CHW_MUTED = 'compass:chwMessages:mutedConvIds';

/**
 * Reads the set of muted conversation ids from localStorage.
 *
 * The inbox is conversation-based while mute state lives on the underlying
 * session (``muted_at``), and the conversation-list payload does not surface
 * that field — so the row-level muted indicator is driven from this locally
 * persisted set (best-effort mirrored to the backend on toggle). Returns an
 * empty set in SSR context or when the stored value is missing / malformed.
 */
function readStoredMutedIds(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const stored = window.localStorage.getItem(LS_KEY_CHW_MUTED);
    if (stored === null) return new Set();
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === 'string'));
  } catch {
    return new Set();
  }
}

/**
 * Persists the set of muted conversation ids to localStorage.
 * Silently swallows errors (e.g. private-browsing quota exceptions).
 */
function writeStoredMutedIds(ids: Set<string>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LS_KEY_CHW_MUTED, JSON.stringify([...ids]));
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

/**
 * Real conversation-header meta line. Derived from the member's actual last
 * message time (no mock availability / contact-time / response-rate data
 * exists to back the old placeholder). Returns null when there are no messages.
 */
function formatLastMessageMeta(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const label = formatThreadTimestamp(iso);
  if (!label) return null;
  if (label === 'Yesterday') return 'Last message yesterday';
  const dayMatch = /^(\d+)d$/.exec(label);
  if (dayMatch) return `Last message ${dayMatch[1]} days ago`;
  return `Last message at ${label}`;
}

/** Presence window: a member counts as "Active" if seen within this long. */
const PRESENCE_WINDOW_MS = 10 * 60 * 1000;

/**
 * True when the member was on the app within the presence window (~10 min),
 * based on their last authenticated activity (memberLastActiveAt).
 */
function isMemberPresent(lastActiveAt: string | null | undefined): boolean {
  if (!lastActiveAt) return false;
  const t = Date.parse(lastActiveAt);
  return Number.isFinite(t) && Date.now() - t < PRESENCE_WINDOW_MS;
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
  /**
   * Server-side SMS delivery status (SMS Output Spec 1 §4). Distinct from the
   * client-only `status` above: 'failed' here means Vonage could not deliver
   * the mirrored text, and the CHW bubble shows a "Not delivered by text" note.
   * 'delivered'/null render nothing.
   */
  deliveryStatus?: 'delivered' | 'failed' | null;
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

// ─── Resource-needs priority display ─────────────────────────────────────────

/**
 * Display label + pill variant for a CHW-assigned need level. Priority itself
 * is resolved by the shared `activeJourneysWithLevel` (../../lib/journeyPriority)
 * from the member's stored resource_need_levels — NOT fabricated from progress —
 * so this rail matches the Member Journey card's priority exactly.
 */
const SEVERITY_LABEL: Record<JourneySeverity, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

function severityPillVariant(level: JourneySeverity): PillVariant {
  if (level === 'high') return 'red';
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
  /** True when the CHW has muted this thread (unread badge suppressed). */
  readonly isMuted: boolean;
  readonly onSelect: (conv: ConversationData) => void;
  readonly onDelete: (conv: ConversationData) => void;
  readonly onTogglePin: (conv: ConversationData) => void;
  readonly onToggleArchive: (conv: ConversationData) => void;
  readonly onToggleMute: (conv: ConversationData) => void;
}

/**
 * A single row in the thread list pane.
 * Shows: 36px avatar, member name, engagement Pill, last message preview,
 * timestamp (tabular mono), unread dot, an optional bell-off (muted) icon,
 * and a ⋯ overflow button that reveals Pin / Archive / Mute / Delete actions
 * (each toggling based on the thread's current state).
 *
 * Engagement pill is derived from conv.unreadCount and conv.lastMessageAt —
 * no per-row message fetch. This avoids N parallel polls in the thread list.
 */
function ThreadRow({
  conversation: conv,
  isActive,
  isMuted,
  onSelect,
  onDelete,
  onTogglePin,
  onToggleArchive,
  onToggleMute,
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
    // Presence wins: member currently on the app (active < 10 min ago).
    if (isMemberPresent(conv.memberLastActiveAt)) return 'Active';
    if (conv.unreadCount > 0) return 'Highly Engaged';
    if (conv.lastMessageAt) {
      const hoursAgo =
        (Date.now() - Date.parse(conv.lastMessageAt)) / (1000 * 60 * 60);
      if (hoursAgo < 24) return 'Engaged';
    }
    return 'Quiet';
  })();
  const engagementPillVariant: PillVariant = (() => {
    if (engagementLabel === 'Active') return 'emerald';
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
            {isMuted ? (
              <BellOff
                size={12}
                color={tokens.textMuted}
                accessibilityLabel="Muted"
              />
            ) : null}
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

        {conv.unreadCount > 0 && !isMuted ? <View style={styles.unreadIndicator} /> : null}

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
              style={styles.threadMenuItem}
              onPress={() => {
                setMenuOpen(false);
                onTogglePin(conv);
              }}
              accessibilityRole="menuitem"
              accessibilityLabel={conv.pinnedAt ? 'Unpin conversation' : 'Pin conversation'}
            >
              <Pin size={14} color={tokens.textSecondary} />
              <Text style={styles.threadMenuItemText}>
                {conv.pinnedAt ? 'Unpin' : 'Pin'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.threadMenuItem}
              onPress={() => {
                setMenuOpen(false);
                onToggleArchive(conv);
              }}
              accessibilityRole="menuitem"
              accessibilityLabel={
                conv.archivedAt ? 'Unarchive conversation' : 'Archive conversation'
              }
            >
              <Archive size={14} color={tokens.textSecondary} />
              <Text style={styles.threadMenuItemText}>
                {conv.archivedAt ? 'Unarchive' : 'Archive'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.threadMenuItem}
              onPress={() => {
                setMenuOpen(false);
                onToggleMute(conv);
              }}
              accessibilityRole="menuitem"
              accessibilityLabel={isMuted ? 'Unmute conversation' : 'Mute conversation'}
            >
              {isMuted ? (
                <Bell size={14} color={tokens.textSecondary} />
              ) : (
                <BellOff size={14} color={tokens.textSecondary} />
              )}
              <Text style={styles.threadMenuItemText}>
                {isMuted ? 'Unmute' : 'Mute'}
              </Text>
            </TouchableOpacity>

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

// Thread-list tab filtering lives in ./threadFilter (pure, unit-tested).

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
 * Tabs: All (n) / Unread / Pinned / Archived.
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
  const toggleMute = useToggleSessionMute();

  // Muted conversation ids. The inbox is conversation-based but mute state
  // lives on the underlying session, and the conversation-list payload does
  // not surface it — so the locally persisted set is the source of truth for
  // the row indicator + badge suppression, and we best-effort mirror the
  // toggle to the backend session-mute endpoint.
  const [mutedConvIds, setMutedConvIds] = useState<Set<string>>(() =>
    readStoredMutedIds(),
  );

  const handleTogglePin = useCallback(
    (conv: ConversationData): void => {
      void togglePin.mutateAsync({ conversationId: conv.id, pinned: !conv.pinnedAt });
    },
    [togglePin],
  );

  const handleToggleArchive = useCallback(
    (conv: ConversationData): void => {
      void toggleArchive.mutateAsync({
        conversationId: conv.id,
        archived: !conv.archivedAt,
      });
    },
    [toggleArchive],
  );

  const handleToggleMute = useCallback(
    (conv: ConversationData): void => {
      const willMute = !mutedConvIds.has(conv.id);
      setMutedConvIds((prev) => {
        const next = new Set(prev);
        if (willMute) next.add(conv.id);
        else next.delete(conv.id);
        writeStoredMutedIds(next);
        return next;
      });
      // Persist to the backend when the conversation has an underlying session
      // (originating or active). Best-effort — the local set already drives the
      // UI, so a session-less thread still mutes visually.
      const sessionId = conv.sessionId ?? conv.activeSessionId;
      if (sessionId) {
        void toggleMute.mutateAsync({ sessionId, muted: willMute });
      }
    },
    [mutedConvIds, toggleMute],
  );

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

    let filtered = applyThreadFilter(sorted, activeFilter);

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
        (sum, c) =>
          c.archivedAt || mutedConvIds.has(c.id)
            ? sum
            : sum + Math.max(0, c.unreadCount ?? 0),
        0,
      ),
    [withMember, mutedConvIds],
  );

  const tabs: { key: ThreadFilterTab; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'unread', label: 'Unread' },
    { key: 'pinned', label: 'Pinned' },
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
                  isMuted={mutedConvIds.has(conv.id)}
                  onSelect={onSelectConversation}
                  onDelete={onDeleteConversation}
                  onTogglePin={handleTogglePin}
                  onToggleArchive={handleToggleArchive}
                  onToggleMute={handleToggleMute}
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

  // Open an in-app full-size preview (lightbox) on all platforms, so the image
  // is viewable without opening a new tab / downloading.
  const handleTap = useCallback((): void => {
    setZoomVisible(true);
  }, []);

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

      {/* Full-screen zoom modal (lightbox) — web + native */}
      <Modal
        visible={zoomVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setZoomVisible(false)}
        accessibilityViewIsModal
      >
        <TouchableOpacity
          style={styles.imageZoomOverlay}
          activeOpacity={1}
          onPress={() => setZoomVisible(false)}
          accessibilityRole="button"
          accessibilityLabel="Close image preview"
        >
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
        </TouchableOpacity>
      </Modal>
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

        {/* SMS delivery failure (Spec 1 §4): shown ONLY when Vonage could not
            deliver a CHW-sent mirrored text. Delivered/null render nothing so
            the thread stays uncluttered. Member-side UI shows no indicator. */}
        {isSentByChw && message.deliveryStatus === 'failed' ? (
          <Text style={styles.bubbleUndelivered}>
            Not delivered by text — member will see it in the app.
          </Text>
        ) : null}
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
  /**
   * Epic K (mobile web polish): at phone widths the member-context rail
   * isn't rendered as a sibling pane (no room), so this header button opens
   * it as a full-screen overlay instead. Omitted (undefined) at wider
   * widths, where the rail is already visible as its own pane.
   */
  readonly onOpenPhoneRail?: () => void;
}

/**
 * Live session timer — counts up from the active session's `started_at`, shown
 * in the conversation header (to the left of the call button) while a session
 * is in progress. Driven by the server-stamped start time, so it survives a
 * refresh and reflects the true elapsed time, not a client-local stopwatch.
 * Renders nothing when there's no active session.
 */
function SessionTimer({ startedAt }: { startedAt: string | null }): React.JSX.Element | null {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!startedAt) return;
    // Re-render every second while the session is live. Cleared when the timer
    // unmounts (session ended) or the start time changes.
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  if (!startedAt) return null;

  return (
    <View style={styles.sessionTimer} accessibilityLabel="Session elapsed time">
      <Clock size={13} color={tokens.primary} />
      <Text style={[styles.sessionTimerText, numerals.tabular]}>
        {formatElapsedSince(startedAt, nowMs)}
      </Text>
    </View>
  );
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
  onOpenPhoneRail,
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
  const markRead = useConversationMarkRead();
  const startCall = useStartCall();
  const submitDocumentation = useSubmitDocumentation();
  // QA batch #2 (Wave-2 B1): disables the composer send button when the
  // backend work gate is live AND this CHW currently fails the compliance
  // checklist — mirrors the identical flag-conditional 403 the backend
  // already enforces on POST /conversations/{id}/messages and .../sms for
  // CHW senders (members are never gated; this screen is CHW-only).
  const checklistQuery = useChwChecklist();
  const isComposerGated =
    checklistQuery.data?.gateEnabled === true && checklistQuery.data?.canWork === false;

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

  // ── Mark thread read while the CHW is viewing it ───────────────────────────
  // Advances the CHW read cursor (server field `chw_read_up_to`) to the newest
  // message so the inbox row's unread dot AND the sidebar "Messages" badge clear
  // without a manual refresh. The mark-read mutation invalidates the
  // `['conversations']` query key, which the AppShell badge sums over — so the
  // badge decrements immediately and hides at 0.
  //
  // The backend read cursor is monotonic (idempotent); we only fire while
  // unreadCount > 0 so a subsequent refetch (unreadCount → 0) doesn't loop.
  const newestServerMessageId = useMemo<string | null>(() => {
    const msgs = messagesQuery.data ?? [];
    if (msgs.length === 0) return null;
    return msgs.reduce((latest, m) =>
      Date.parse(m.createdAt) >= Date.parse(latest.createdAt) ? m : latest,
    ).id;
  }, [messagesQuery.data]);

  useEffect(() => {
    if (conv.unreadCount > 0 && newestServerMessageId) {
      markRead.mutate({
        conversationId: conv.id,
        upToMessageId: newestServerMessageId,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conv.id, conv.unreadCount, newestServerMessageId]);

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
      // On failure, let the error propagate — DocumentationModal's own
      // performSubmit catches it and renders the on-brand inline
      // `submitError` banner (Part 12, QA batch 2026-07-14 #12). No
      // window.alert / Alert.alert here: never a browser/OS dialog for this
      // failure, and the modal stays open (documentingSessionId is left set)
      // so the CHW can adjust and retry.
      await submitDocumentation.mutateAsync({
        sessionId: documentingSessionId,
        data: data as unknown as Record<string, unknown>,
      });
      setDocumentingSessionId(null);
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
  // Presence takes precedence over message-derived engagement: if the member is
  // currently on the app (active < 10 min ago), show a green "Active" pill.
  const memberPresent = isMemberPresent(conv.memberLastActiveAt);

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

        {/* Epic S follow-up: "Back to Messages" origin params on every
            Member-Profile launch point from this screen. */}
        <PressableMember
          memberId={conv.memberId ?? ''}
          displayName={memberName}
          enabled={!!conv.memberId}
          backLabel="Messages"
          backTo="Messages"
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
              backLabel="Messages"
              backTo="Messages"
            >
              <Text style={styles.convHeaderName} numberOfLines={1}>
                {memberName}
              </Text>
            </PressableMember>
            <Pill
              variant={memberPresent ? 'emerald' : engagement.pillVariant}
              size="sm"
              withDot
            >
              {memberPresent ? 'Active' : engagement.label}
            </Pill>
          </View>
          {formatLastMessageMeta(conv.lastMessageAt) !== null && (
            <Text style={styles.convHeaderMeta}>
              {formatLastMessageMeta(conv.lastMessageAt)}
            </Text>
          )}
        </View>

        {/* Live session timer — visible while a session is in progress, to the
            left of the call button. Counts up from the server-stamped start. */}
        <SessionTimer startedAt={conv.activeSessionStartedAt} />

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

        {/* Phone-width only: the member-context rail (Care Status, Active
            Needs, Quick Actions, Complete Session) has no sibling pane to
            live in at this width — this button opens it as a full-screen
            overlay instead. Hidden entirely at wider widths, where the rail
            renders as its own pane and this would be redundant. */}
        {onOpenPhoneRail != null ? (
          <PressableCard
            onPress={onOpenPhoneRail}
            accessibilityLabel="Open member context"
            style={styles.iconBtnCard}
          >
            <Info size={20} color={tokens.textSecondary} />
          </PressableCard>
        ) : null}

        {/* Open Member Profile */}
        <PressableMember
          memberId={conv.memberId ?? ''}
          displayName={memberName}
          enabled={!!conv.memberId}
          style={styles.openProfileBtn}
          backLabel="Messages"
          backTo="Messages"
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
            disabled={
              (!draftText.trim() && !pendingAttachment) ||
              sendMessage.isPending ||
              isAttachmentUploading ||
              isComposerGated
            }
            accessibilityLabel={
              isComposerGated
                ? 'Send message (disabled until your compliance checklist is complete)'
                : 'Send message'
            }
            style={[
              styles.sendBtnCard,
              ((!draftText.trim() && !pendingAttachment) ||
                sendMessage.isPending ||
                isAttachmentUploading ||
                isComposerGated) &&
                styles.sendBtnDisabled,
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

        {/* QA batch #2: inline note when the work gate blocks sending —
            links to the Profile checklist so the CHW knows how to unblock. */}
        {isComposerGated ? (
          <Pressable
            onPress={() => navigation.navigate('Profile' as never)}
            accessibilityRole="link"
            accessibilityLabel="Complete your compliance checklist to send messages"
          >
            <Text style={styles.composerGatedNote}>
              Finish your compliance checklist to send messages. Go to Profile →
            </Text>
          </Pressable>
        ) : (
          /* SMS caption — mono tabular */
          <Text style={styles.composerMeta}>SMS via Vonage masked number</Text>
        )}
      </View>

      {/* Documentation modal — Epic Q4: on-brand overlay, anchored over this
          Messages page rather than a full-screen takeover (see `presentation`
          on DocumentationModal). */}
      {documentingSessionId != null && (
        <DocumentationModal
          visible={documentingSessionId != null}
          onClose={() => setDocumentingSessionId(null)}
          sessionId={documentingSessionId}
          memberId={conv.memberId ?? undefined}
          durationMinutes={null}
          // Best-effort pre-fill: this pane only has the conversation's
          // in-progress-session start stamp, not an ended-session end time
          // (this modal is opened via handleOpenCompleteSession, which is
          // not currently wired to any control — the live Complete Session
          // flow is CHWMessagesScreen's rail-driven modal below, which
          // captures both timestamps from the /end response). The CHW can
          // still fill in Session End manually.
          sessionStartedAt={conv.activeSessionStartedAt}
          sessionEndedAt={null}
          onSubmit={handleDocumentationSubmit}
          presentation="overlay"
        />
      )}
    </View>
  );
}

// ─── Case Note inline section ──────────────────────────────────────────────

interface CaseNoteInlineSectionProps {
  readonly memberId: string;
  /**
   * Null when there is no active session — the note is created standalone.
   * Previously this was typed `string` and the call site passed
   * `conv.activeSessionId ?? ''`, which silently turned "no active session"
   * into a session_id of `''` and would have sent an empty-string
   * session_id to the backend. Typing this `string | null` (matching
   * `CreateCaseNotePayload.sessionId`) and passing `conv.activeSessionId`
   * straight through removes that footgun at the type level.
   */
  readonly sessionId: string | null;
  readonly onClose: () => void;
}

/**
 * Inline, in-flow case-note editor rendered directly inside
 * MemberContextRail's scrollable content — deliberately NOT a `RightDrawer`.
 *
 * It used to be a right-docked `RightDrawer` (`CaseNoteModal`). On web,
 * RightDrawer's default (non-inline) mode renders `position: fixed` at
 * `zIndex: 1000` pinned to the right edge of the viewport — the same edge
 * and (effectively) the same stacking layer `InlineSdohPanel`'s 'sheet'
 * variant uses. Opening a case note while the SDOH panel was open therefore
 * visually overlapped it. An un-merged side-by-side attempt (PR #174) tried
 * to reconcile the two fixed overlays; that approach was abandoned in favor
 * of this simpler fix: render the case note as a normal sibling *inside*
 * the rail's own document flow. A pure in-flow element can never cover
 * anything living outside the rail (the SDOH pane, the thread list, etc.)
 * — expanding it only ever grows the rail's own scroll content, which is
 * exactly the "grows into the empty space below Quick Actions" behavior
 * this was asked for.
 *
 * Persistence: unchanged — POSTs to POST /api/v1/case-notes via
 * useCreateCaseNote, same Pin-to-top toggle.
 */
function CaseNoteInlineSection({
  memberId,
  sessionId,
  onClose,
}: CaseNoteInlineSectionProps): React.JSX.Element {
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

  return (
    <View
      style={[caseNoteInlineStyles.container, shadows.card as ViewStyle]}
      role="region"
      accessibilityLabel="Case Note"
    >
      <View style={caseNoteInlineStyles.header}>
        <View style={caseNoteInlineStyles.headerTextBlock}>
          <Text style={caseNoteInlineStyles.headerTitle}>Add Case Note</Text>
          <Text style={caseNoteInlineStyles.headerSubtitle}>
            Attach a clinical note to this member&apos;s record
          </Text>
        </View>
        <TouchableOpacity
          onPress={handleClose}
          accessibilityRole="button"
          accessibilityLabel="Close case note"
          style={caseNoteInlineStyles.closeBtn}
        >
          <X size={16} color={tokens.textSecondary} />
        </TouchableOpacity>
      </View>

      {/* flex:1 + minHeight: large by default, and grows further into any
          empty space left below Quick Actions when the rail's ScrollView
          content is shorter than the viewport (railContent's flexGrow: 1).
          Multiline TextInput renders as a native <textarea> on web, which
          scrolls internally once the note text exceeds the box height —
          the rail itself never has to grow to accommodate a long note. */}
      <TextInput
        style={caseNoteInlineStyles.noteInput}
        value={noteBody}
        onChangeText={setNoteBody}
        placeholder="Clinical observations, follow-up actions, member updates..."
        placeholderTextColor={tokens.textMuted}
        multiline
        numberOfLines={10}
        accessibilityLabel="Case note body"
        autoFocus
        textAlignVertical="top"
      />

      <TouchableOpacity
        style={caseNoteInlineStyles.pinRow}
        onPress={() => setIsPinned((v) => !v)}
        accessibilityRole="checkbox"
        accessibilityLabel={isPinned ? 'Unpin note' : 'Pin note to top'}
        accessibilityState={{ checked: isPinned }}
      >
        <View
          style={[
            caseNoteInlineStyles.checkbox,
            isPinned && caseNoteInlineStyles.checkboxActive,
          ]}
        >
          {isPinned ? (
            <CheckCircle2 size={14} color="#ffffff" />
          ) : null}
        </View>
        <Text style={caseNoteInlineStyles.pinLabel}>Pin to top of notes</Text>
      </TouchableOpacity>

      <View style={caseNoteInlineStyles.footer}>
        <TouchableOpacity
          style={caseNoteInlineStyles.cancelBtn}
          onPress={handleClose}
          accessibilityRole="button"
          accessibilityLabel="Cancel case note"
        >
          <Text style={caseNoteInlineStyles.cancelBtnText}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            caseNoteInlineStyles.saveBtn,
            (createNote.isPending || noteBody.trim().length === 0) &&
              caseNoteInlineStyles.saveBtnDisabled,
          ]}
          onPress={() => { void handleSave(); }}
          disabled={createNote.isPending || noteBody.trim().length === 0}
          accessibilityRole="button"
          accessibilityLabel="Save case note"
        >
          {createNote.isPending ? (
            <ActivityIndicator size="small" color="#ffffff" />
          ) : (
            <Text style={caseNoteInlineStyles.saveBtnText}>Save Note</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const caseNoteInlineStyles = StyleSheet.create({
  container: {
    flex: 1,
    minHeight: 260,
    backgroundColor: tokens.cardBg,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    borderRadius: radius.xl,
    padding: 14,
    gap: spacing.sm,
  } as ViewStyle,
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  } as ViewStyle,
  headerTextBlock: {
    flex: 1,
    gap: 2,
  } as ViewStyle,
  headerTitle: {
    fontSize: 13,
    fontWeight: '650' as any, // eslint-disable-line @typescript-eslint/no-explicit-any -- matches railCardTitle's numeric-weight pattern
    color: tokens.textPrimary,
  } as TextStyle,
  headerSubtitle: {
    fontSize: 11,
    color: tokens.textSecondary,
    lineHeight: 15,
    marginTop: 2,
  } as TextStyle,
  closeBtn: {
    padding: 4,
    borderRadius: 6,
    marginLeft: spacing.sm,
  } as ViewStyle,
  noteInput: {
    flex: 1,
    minHeight: 160,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: radius.md,
    padding: spacing.md,
    fontSize: 13,
    color: tokens.textPrimary,
    textAlignVertical: 'top',
  } as unknown as TextStyle,
  pinRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  } as ViewStyle,
  checkbox: {
    width: 18,
    height: 18,
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
    fontSize: 12,
    color: tokens.textSecondary,
  } as TextStyle,
  footer: {
    flexDirection: 'row',
    gap: spacing.sm,
  } as ViewStyle,
  cancelBtn: {
    flex: 1,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: radius.md,
    alignItems: 'center',
  } as ViewStyle,
  cancelBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: tokens.textSecondary,
  } as TextStyle,
  saveBtn: {
    flex: 1,
    paddingVertical: 9,
    backgroundColor: tokens.primary,
    borderRadius: radius.md,
    alignItems: 'center',
  } as ViewStyle,
  saveBtnDisabled: {
    opacity: 0.5,
  } as ViewStyle,
  saveBtnText: {
    fontSize: 13,
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
 * session with that member. Only truly aborted/ended sessions (cancelled /
 * cancelled_no_consent / no_show) get the read-only label.
 *
 * `no_show` (Epic O2) — the CHW began the session but the member never
 * attended (PATCH /sessions/{id}/no-show, "Missed Session" action). Terminal
 * like cancelled, but semantically distinct: it's a record-keeping status
 * that stays visible on the calendar tagged "Missed" (see deriveBadgeStatus
 * in CHWCalendarScreen/MemberCalendarScreen), whereas cancelled sessions
 * vanish from the calendar grid entirely (Epic N1).
 */
const TERMINAL_SESSION_STATUSES: readonly string[] = [
  'cancelled',
  'cancelled_no_consent',
  'no_show',
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
    case 'no_show':
      return 'Missed — member did not attend';
    default:
      return 'Session ended';
  }
}

interface MemberContextRailProps {
  readonly conversation: ConversationData;
  /**
   * Called after the in-progress session is ended, with the just-ended
   * session id (and its started/ended timestamps, straight off the /end
   * response) so the parent can open the documentation modal pre-filled with
   * both. The id is passed explicitly because conversation.activeSessionId
   * resolves to the in_progress session only, and goes null the moment the
   * session flips to awaiting_documentation — re-reading it here would open
   * nothing.
   */
  readonly onEndSessionComplete?: (
    endedSessionId: string,
    startedAt: string | null,
    endedAt: string | null,
  ) => void;
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
  /**
   * When true, automatically open the inline Complete-Session confirm panel
   * on mount (once the session status is known and it's actually in a
   * completable state). Set by the parent when route.params.promptComplete
   * === true and this rail's conversation matches the target member — see
   * ActiveSessionBadge's "Complete Session" button. Mirrors the
   * autoBeginSessionOnMount pattern above.
   */
  readonly promptCompleteOnMount?: boolean;
  /** Fired after the auto-prompt attempt so the parent can clear the one-shot flag. */
  readonly onPromptCompleteConsumed?: () => void;
  /**
   * Called when the CHW taps "SDOH / Health Screening" — with OR without an
   * active session (Wave-2 #26 removed the "begin a session first" gate).
   * `sessionId` is passed when `conv.activeSessionId` is set (preserves the
   * exact pre-existing in-session behavior); `memberId` is always passed so
   * the panel can fall back to the session-less start endpoint when there is
   * no active session. The parent (CHWMessagesScreen) owns the panel's
   * open/close state because the panel renders as a sibling pane of the
   * rail, not nested inside it — see InlineSdohPanel's header comment for
   * why.
   */
  readonly onOpenSdohPanel: (target: { sessionId: string | null; memberId: string }) => void;
}

/**
 * Right pane: member context sections in order:
 *   1. Care Status card — journey name, progress bar, 5-stage vertical stepper
 *   2. Active Needs card — top 3 resource needs ranked by severity
 *   3. Session Focus card — last interaction, today's goal, next step
 *   4. Screening Questions card — opens the suggested-questions drawer
 *   5. Quick Actions — Add Case Note, Open Member Profile, Schedule Session
 *   6. Primary session action — "Begin Session" (scheduled/completed/no
 *      active session) or a read-only "session is active, use the badge"
 *      note (in_progress/awaiting_documentation — #19/#20: ActiveSessionBadge
 *      is the sole Complete/Cancel/Missed control surface while active) or a
 *      terminal-status note (cancelled/cancelled_no_consent/no_show).
 *
 * No nested cards within a single Card region — border-top dividers used instead.
 */
function MemberContextRail({
  conversation: conv,
  onEndSessionComplete,
  onSessionStarted,
  autoBeginSessionOnMount,
  onAutoBeginSessionConsumed,
  promptCompleteOnMount,
  onPromptCompleteConsumed,
  onOpenSdohPanel,
}: MemberContextRailProps): React.JSX.Element {
  const navigation = useNavigation<any>(); // eslint-disable-line @typescript-eslint/no-explicit-any

  const [questionsDrawerOpen, setQuestionsDrawerOpen] = useState(false);
  // Inline (not drawer) case-note editor state — see CaseNoteInlineSection's
  // header comment for why this is no longer a RightDrawer.
  const [caseNoteOpen, setCaseNoteOpen] = useState(false);
  const [endSessionPending, setEndSessionPending] = useState(false);
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
  //   in_progress /          → read-only "active session" note — the badge
  //     awaiting_documentation  (ActiveSessionBadge) is the sole control
  //                             surface for Complete/Cancel/Missed while a
  //                             session is active (#19/#20, 2026-07-13; see
  //                             the removed red "Complete Session" button +
  //                             confirm panel below).
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
  // A session is "active" (in_progress / awaiting_documentation) whenever
  // it's neither beginnable nor terminal — the state ActiveSessionBadge is
  // mounted for and solely controls (#19/#20).
  const isActiveSession = !canBeginSession && !canBeginNewSession && !isTerminalSession;

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

  // CHW-assigned resource-need priorities (authoritative, same source + cache
  // key as the member-profile screen) so this rail's priority matches the
  // Member Journey card instead of being fabricated from progress %.
  const resourceNeedLevelsQuery = useChwMemberResourceNeedLevels(conv.memberId);
  const resourceNeedLevels = resourceNeedLevelsQuery.data ?? {};

  // Member's active journeys paired with their CHW-assigned level, sorted
  // high→medium→low — THE shared source of truth (see lib/journeyPriority).
  const leveledNeeds = useMemo(
    () => activeJourneysWithLevel(memberJourneys, resourceNeedLevels),
    [memberJourneys, resourceNeedLevels],
  );

  const activeJourney: MemberJourneyResponse | null = useMemo(
    () =>
      [...memberJourneys].sort(
        (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt),
      )[0] ?? null,
    [memberJourneys],
  );

  // Top resource needs — top 3 by CHW-assigned priority (high first).
  const topResourceNeeds = useMemo<{ journey: MemberJourneyResponse; level: JourneySeverity }[]>(
    () => leveledNeeds.slice(0, 3),
    [leveledNeeds],
  );

  // ── Session Focus ───────────────────────────────────────────────────────────
  // The focus journey = the member's top priority: highest CHW-assigned priority
  // (high > medium > low > none), tie-broken by urgency (lowest progress).
  const focusJourney = useMemo<MemberJourneyResponse | null>(() => {
    if (memberJourneys.length === 0) return null;
    const rank = (p: MemberJourneyResponse['priorityLevel']): number =>
      p === 'high' ? 3 : p === 'medium' ? 2 : p === 'low' ? 1 : 0;
    return (
      [...memberJourneys].sort((a, b) => {
        const byPriority = rank(b.priorityLevel) - rank(a.priorityLevel);
        if (byPriority !== 0) return byPriority;
        return a.progressPercent - b.progressPercent;
      })[0] ?? null
    );
  }, [memberJourneys]);

  // Derive Last Interaction / Today's Goal / Next Step from the focus journey's
  // step state. Null when the member has no active journeys.
  const sessionFocus = useMemo(() => {
    if (!focusJourney) return null;
    const journeyName = focusJourney.template?.name ?? 'the top resource need';
    const steps = [...(focusJourney.steps ?? [])].sort(
      (a, b) => a.stepOrder - b.stepOrder,
    );
    const stepText = (
      s: (typeof steps)[number] | null | undefined,
    ): string | null =>
      s ? s.stepDescription?.trim() || s.stepName?.trim() || null : null;

    const completed = steps.filter((s) => s.status === 'completed');
    const lastCompleted =
      [...completed]
        .filter((s) => s.completedAt)
        .sort((a, b) => Date.parse(b.completedAt!) - Date.parse(a.completedAt!))[0] ??
      completed[completed.length - 1] ??
      null;
    const current =
      focusJourney.currentStep ??
      steps.find((s) => s.status === 'in_progress') ??
      steps.find((s) => s.status === 'upcoming') ??
      null;
    const currentIdx = current
      ? steps.findIndex((s) => s.id === current.id)
      : -1;
    const next =
      steps.slice(currentIdx + 1).find((s) => s.status !== 'completed') ?? null;

    return {
      lastInteraction: lastCompleted
        ? `Completed "${lastCompleted.stepName}" in ${journeyName}.`
        : `Started the ${journeyName} journey.`,
      todaysGoal: stepText(current) ?? `Advance ${journeyName}.`,
      nextStep:
        stepText(next) ?? 'Complete the current step to unlock the next one.',
    };
  }, [focusJourney]);

  // Services consent
  const consentQuery = useMemberServicesConsent(conv.memberId ?? '');
  const consentValue = consentQuery.data?.value ?? null;
  const servicesRefused = consentValue === 'refuse_services';

  // Journey display values
  // Care Status card: the CHW can switch across the member's active journeys;
  // the card shows that journey's real step track (mirrors the member profile).
  const [careJourneyIndex, setCareJourneyIndex] = useState(0);
  useEffect(() => {
    setCareJourneyIndex(0);
  }, [conv.memberId]);
  // Paginate Care Status over the priority-ordered list so its order matches
  // the Active Needs ranking (high → low), not raw journey-fetch order.
  const careJourneyCount = leveledNeeds.length;
  const careIndex =
    careJourneyCount > 0 ? Math.min(careJourneyIndex, careJourneyCount - 1) : 0;
  const careJourney = leveledNeeds[careIndex]?.journey ?? null;
  const careSteps = useMemo(
    () =>
      careJourney
        ? [...careJourney.steps].sort((a, b) => a.stepOrder - b.stepOrder)
        : [],
    [careJourney],
  );

  const journeyPercent = careJourney?.progressPercent ?? 0;
  const journeyName = careJourney?.template.name ?? 'General';
  const journeyCurrentStep = careJourney?.currentStep?.stepName ?? null;
  const journeyDueDate = careJourney?.currentStep?.dueDate ?? null;

  const dueDateCaption = useMemo((): string | null => {
    if (!journeyCurrentStep) return null;
    if (!journeyDueDate) return `Current step: ${journeyCurrentStep}`;
    const daysUntilDue = Math.ceil(
      (Date.parse(journeyDueDate) - Date.now()) / (1000 * 60 * 60 * 24),
    );
    return `Current step: ${journeyCurrentStep} (due in ${daysUntilDue}d)`;
  }, [journeyCurrentStep, journeyDueDate]);

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

  /**
   * "Complete" — ends the in-progress session (POST /sessions/{id}/end,
   * transitioning in_progress → awaiting_documentation and tearing down any
   * active Vonage call bridge) then hands the just-ended session's id +
   * started/ended timestamps to the parent via `onEndSessionComplete`, which
   * opens DocumentationModal pre-filled with both.
   *
   * #19/#20 (2026-07-13): this now fires directly — from the badge's
   * Complete button (via the promptCompleteOnMount effect below) or,
   * on this rail, there is no longer a separate manual trigger for it (see
   * the removed red "Complete Session" button + confirm panel further down —
   * the badge is now the single active-session control surface; it already
   * offers Cancel/Missed before the CHW ever reaches Complete, so a second
   * confirm here was redundant friction). Defined ahead of the
   * promptCompleteOnMount effect (rather than after, as originally written)
   * so that effect can call it directly without an intermediate ref.
   */
  const handleEndSessionConfirmed = useCallback(async (): Promise<void> => {
    if (!conv.activeSessionId) return; // Guard: no active session to end
    const activeId = conv.activeSessionId;
    setEndSessionPending(true);
    try {
      const endedSession = await endSession.mutateAsync(activeId);
      // Pass the just-ended session id + its started/ended timestamps so the
      // parent can open the documentation modal pre-filled with both —
      // activeSessionId is already null by now (in_progress only), so this
      // is the only place those timestamps are available post-end.
      onEndSessionComplete?.(
        activeId,
        endedSession.startedAt ?? null,
        endedSession.endedAt ?? null,
      );
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

  // One-shot auto-complete: on mount, when the caller requested it (route
  // param promptComplete === true, e.g. from ActiveSessionBadge's "Complete"
  // button) and the session is actually in a completable state (in_progress /
  // awaiting_documentation, not terminal, and not disabled by a
  // services-refused consent — mirrors the old manual button's own disabled
  // condition), immediately call /end and open DocumentationModal directly —
  // NO intermediate confirm panel (#19/#20). A ref guards against
  // double-firing across re-renders, same as autoBeginFiredRef above.
  const promptCompleteFiredRef = useRef(false);
  useEffect(() => {
    if (!promptCompleteOnMount) return;
    if (promptCompleteFiredRef.current) return;
    // Wait until both the live session AND the consent query have settled —
    // firing while consent is still loading would race servicesRefused (it
    // defaults to false until the fetch resolves), risking a false-negative
    // auto-open for a member who has actually refused services.
    if (liveSessionQuery.isLoading || consentQuery.isLoading) return;
    const canComplete =
      !canBeginSession && !canBeginNewSession && !isTerminalSession && !servicesRefused;
    if (!canComplete) return;

    promptCompleteFiredRef.current = true;
    onPromptCompleteConsumed?.();
    void handleEndSessionConfirmed();
  }, [
    promptCompleteOnMount,
    liveSessionQuery.isLoading,
    consentQuery.isLoading,
    canBeginSession,
    canBeginNewSession,
    isTerminalSession,
    servicesRefused,
    onPromptCompleteConsumed,
    handleEndSessionConfirmed,
  ]);

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
            {careJourneyCount > 1 && (
              <View style={styles.careSwitcher}>
                <Pressable
                  onPress={() =>
                    setCareJourneyIndex(
                      (careIndex - 1 + careJourneyCount) % careJourneyCount,
                    )
                  }
                  accessibilityRole="button"
                  accessibilityLabel="Previous journey"
                  hitSlop={8}
                  style={styles.careSwitcherBtn}
                >
                  <ChevronLeft size={16} color={tokens.textSecondary} />
                </Pressable>
                <Text style={[styles.careSwitcherCount, numerals.tabular]}>
                  {careIndex + 1}/{careJourneyCount}
                </Text>
                <Pressable
                  onPress={() =>
                    setCareJourneyIndex((careIndex + 1) % careJourneyCount)
                  }
                  accessibilityRole="button"
                  accessibilityLabel="Next journey"
                  hitSlop={8}
                  style={styles.careSwitcherBtn}
                >
                  <ChevronRight size={16} color={tokens.textSecondary} />
                </Pressable>
              </View>
            )}
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

          {/* Real step track for the selected journey (mirrors the member profile) */}
          <View style={railCardStyles.stepper}>
            {careSteps.length === 0 ? (
              <Text style={railCardStyles.stepLabelFuture}>
                No steps in this journey yet.
              </Text>
            ) : (
              careSteps.map((step, i) => {
                const toState = (s: string): 'completed' | 'current' | 'future' =>
                  s === 'completed'
                    ? 'completed'
                    : s === 'in_progress'
                    ? 'current'
                    : 'future';
                const state = toState(step.status);
                const prevState = i > 0 ? toState(careSteps[i - 1].status) : null;
                return (
                  <View key={step.id} style={railCardStyles.stepRow}>
                    {/* Connector line above (all except first) */}
                    {i > 0 ? (
                      <View
                        style={[
                          railCardStyles.stepConnector,
                          state === 'future' && prevState === 'future'
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
                      numberOfLines={2}
                    >
                      {step.stepName?.trim() || 'Untitled step'}
                    </Text>
                  </View>
                );
              })
            )}
          </View>
        </Card>

        {/* CARD 2 — Active Needs */}
        {topResourceNeeds.length > 0 ? (
          <Card style={styles.railCard}>
            <View style={styles.railCardTitleRow}>
              <Flag size={13} color={tokens.textSecondary} />
              <Text style={styles.railCardTitle}>Active Needs</Text>
            </View>
            {topResourceNeeds.map(({ journey, level }, index) => {
              const pillVariant = severityPillVariant(level);
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
                    {SEVERITY_LABEL[level]}
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
              {sessionFocus?.lastInteraction ?? 'No journey activity logged yet.'}
            </Text>
          </View>
          <View style={[railCardStyles.sessionFocusSection, railCardStyles.sessionFocusBorder]}>
            <Text style={railCardStyles.sessionFocusFieldLabel}>Today's Goal</Text>
            <Text style={railCardStyles.sessionFocusFieldValue}>
              {sessionFocus?.todaysGoal ?? "Identify the member's top resource need."}
            </Text>
          </View>
          <View style={[railCardStyles.sessionFocusSection, railCardStyles.sessionFocusBorder]}>
            <Text style={railCardStyles.sessionFocusFieldLabel}>Next Step</Text>
            <Text style={railCardStyles.sessionFocusFieldValue}>
              {sessionFocus?.nextStep ?? 'Add a journey to set next steps.'}
            </Text>
          </View>
        </Card>

        {/* CARD 4 — Screening Questions */}
        <Card style={styles.railCard}>
          <PressableCard
            onPress={() => {
              // Open the SDOH/Health Screening questionnaire inline, within
              // this Messages page — its answers surface in the member
              // profile's Screening Results. Wave-2 #26: no longer requires
              // an active session — pass activeSessionId when present (same
              // in-session behavior as before) and always pass memberId so
              // the panel can start a session-less assessment otherwise.
              onOpenSdohPanel({
                sessionId: conv.activeSessionId ?? null,
                memberId: conv.memberId ?? '',
              });
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
            {/* Add Case Note — toggles the inline editor below, in-flow in
                this rail's own scroll content (see CaseNoteInlineSection). */}
            <PressableCard
              onPress={() => setCaseNoteOpen((v) => !v)}
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
              backLabel="Messages"
              backTo="Messages"
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

        {/* Inline Case Note editor — expands in-flow below Quick Actions
            instead of stacking a 2nd right-docked drawer on top of the SDOH
            panel. Both used to dock at the right edge at the same z-index
            (RightDrawer's WebDrawer is `position: fixed`), so opening a case
            note while the SDOH panel was open visually overlapped it. An
            un-merged side-by-side attempt (PR #174) was abandoned in favor
            of this simpler inline-expansion approach: because this section
            is a normal sibling in the rail's own ScrollView content, it can
            never cover anything outside the rail — it only ever grows the
            rail's own scroll area. See CaseNoteInlineSection's header
            comment. */}
        {caseNoteOpen && conv.memberId ? (
          <CaseNoteInlineSection
            memberId={conv.memberId}
            sessionId={conv.activeSessionId}
            onClose={() => setCaseNoteOpen(false)}
          />
        ) : null}

        {/* Primary session action:
            completed              → green "Begin Session" (creates + starts new session)
            scheduled              → green "Begin Session" (starts existing scheduled session)
            in_progress /          → read-only "active session" note — the
              awaiting_documentation  badge (ActiveSessionBadge) is the sole
                                      Complete/Cancel/Missed control surface
                                      while a session is active (#19/#20)
            cancelled /            → read-only status note
              cancelled_no_consent */}
        <View
          role="region"
          accessibilityLabel={
            isTerminalSession
              ? terminalSessionLabel(activeStatus ?? 'cancelled')
              : canBeginSession || canBeginNewSession
              ? 'Begin Session'
              : 'Active session'
          }
          style={styles.endSessionRegion}
        >
          {isTerminalSession ? (
            <View style={styles.sessionStatusNote} accessibilityRole="text">
              <Text style={styles.sessionStatusNoteText}>
                {terminalSessionLabel(activeStatus ?? 'cancelled')}
              </Text>
            </View>
          ) : isActiveSession ? (
            /* #19/#20: no manual Complete/Cancel/Missed control here anymore —
               the persistent ActiveSessionBadge (mounted app-wide for CHWs,
               see ActiveSessionBadge.tsx) is the single active-session
               control surface. This read-only note tells the CHW where to
               go rather than duplicating those controls in two places. */
            <View style={styles.sessionStatusNote} accessibilityRole="text">
              <Text style={styles.sessionStatusNoteText}>
                Session with {memberFirstName} is active — use the session
                badge to Complete, Cancel, or mark it Missed.
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
          ) : null}
        </View>
      </ScrollView>

      {/* Modals */}
      <OpenQuestionsDrawer
        visible={questionsDrawerOpen}
        onClose={() => setQuestionsDrawerOpen(false)}
        member={questionsMember}
        journey={questionsJourney}
      />
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
  // Epic K (mobile web polish): at phone widths the member-context rail has
  // nowhere to live as a sibling pane (there isn't room for even two
  // columns), so it's reachable via this toggle instead — rendered as a
  // full-screen overlay over the conversation pane. See `showPhoneRail`
  // below and its render block near the end of this component's JSX.
  const [showPhoneRail, setShowPhoneRail] = useState(false);
  const [documentingSessionId, setDocumentingSessionId] = useState<string | null>(null);
  // Session Start / Session End (ISO 8601) captured from the /end response
  // when the just-ended session opens the documentation modal below — see
  // handleEndSessionComplete. Pre-fills DocumentationModal's editable
  // Session Start/End fields so the CHW isn't re-typing timestamps the
  // server already recorded.
  const [documentingSessionStartedAt, setDocumentingSessionStartedAt] = useState<string | null>(
    null,
  );
  const [documentingSessionEndedAt, setDocumentingSessionEndedAt] = useState<string | null>(null);
  // SDOH / Health Screening — opened inline from MemberContextRail's rail
  // card (see onOpenSdohPanel below). Owned here, not inside
  // MemberContextRail, because the panel renders as a 4th sibling pane next
  // to the rail (wide desktop) rather than nested/overlaying inside it — see
  // InlineSdohPanel's header comment.
  // Wave-2 #26: holds BOTH sessionId (null when no active session) and
  // memberId (always set) so the panel can fall back to the session-less
  // start endpoint when there's no active session — the "Begin a session
  // first" gate was removed.
  const [sdohTarget, setSdohTarget] = useState<{ sessionId: string | null; memberId: string } | null>(
    null,
  );

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
  // promptComplete: navigated from ActiveSessionBadge's "Complete Session"
  // button (any CHW page). When true, auto-select the member's conversation
  // (handled by the same effect as targetMemberId below) and open
  // MemberContextRail's inline Complete-Session confirm panel on mount.
  const shouldPromptComplete = route.params?.promptComplete === true;
  const promptCompleteFiredRef = useRef(false);

  const hideRail = width < BP_HIDE_RAIL;
  const hideList = width < BP_HIDE_LIST;
  const isPhone = width < BP_PHONE;

  // SDOH panel variant: 'pane' whenever the member-context rail itself is
  // visible, so the panel always renders as a genuine sibling column next
  // to the rail — never an overlay on top of it. That's the non-blocking
  // design the feature requires: thread, rail, and panel all stay
  // visible/interactive at once.
  //
  // On widths where the rail is visible but there isn't quite enough room
  // for all four columns side by side (BP_HIDE_RAIL <= width <
  // SDOH_PANEL_PANE_BREAKPOINT), the thread-list pane — the lowest-priority
  // pane once a member's conversation is already open — is temporarily
  // collapsed below (`collapseListForSdoh`) to reclaim the room instead of
  // falling back to an overlay. Below BP_HIDE_RAIL the rail isn't rendered
  // at all, so there's nothing left for a sheet to cover; the overlay
  // fallback there is the same intentional, documented tradeoff described
  // in InlineSdohPanel's header comment, left unchanged by this fix.
  const sdohOpen = sdohTarget != null;
  const collapseListForSdoh = sdohOpen && !hideRail && width < SDOH_PANEL_PANE_BREAKPOINT;
  const sdohPanelVariant: 'pane' | 'sheet' = !hideRail ? 'pane' : 'sheet';

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

  const handleOpenSdohPanel = useCallback(
    (target: { sessionId: string | null; memberId: string }): void => {
      setSdohTarget(target);
    },
    [],
  );

  const handleCloseSdohPanel = useCallback((): void => {
    setSdohTarget(null);
  }, []);

  // Close the SDOH panel when the CHW switches to a different member's
  // thread — otherwise it would keep showing (and could resume/complete)
  // the previous member's in-progress assessment against the new thread.
  useEffect(() => {
    setSdohTarget(null);
  }, [selectedConversation?.id]);

  // Close the phone-width rail overlay on thread switch too, for the same
  // reason — it should never keep showing a stale member's context.
  useEffect(() => {
    setShowPhoneRail(false);
  }, [selectedConversation?.id]);

  // After End Session completes — open DocumentationModal with the just-ended
  // session id (passed from the rail). Do NOT re-read activeSessionId here: it
  // resolves to the in_progress session only, so it's already null by now and
  // the modal would never open (the bug that required a full page refresh).
  // Also captures the session's started/ended timestamps straight off the
  // /end response so DocumentationModal's Session Start/End fields are
  // pre-filled rather than blank.
  const handleEndSessionComplete = useCallback(
    (endedSessionId: string, startedAt: string | null, endedAt: string | null): void => {
      setDocumentingSessionId(endedSessionId);
      setDocumentingSessionStartedAt(startedAt);
      setDocumentingSessionEndedAt(endedAt);
    },
    [],
  );

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
      // On failure, let the error propagate — DocumentationModal's own
      // performSubmit catches it and renders the on-brand inline
      // `submitError` banner (Part 12, QA batch 2026-07-14 #12). No
      // window.alert / Alert.alert here: never a browser/OS dialog for this
      // failure, and the modal stays open so the CHW can adjust and retry.
      await submitDocumentation.mutateAsync({
        sessionId: documentingSessionId,
        data: data as unknown as Record<string, unknown>,
      });
      setDocumentingSessionId(null);
      setDocumentingSessionStartedAt(null);
      setDocumentingSessionEndedAt(null);
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

  // Reclaim the thread-list pane's width for the SDOH panel on mid-width
  // screens (see collapseListForSdoh above) — the panel opening temporarily
  // takes priority over browsing other threads, which the CHW can still get
  // back to by closing the panel (X).
  const shouldShowList = (!hideList || showThreadList) && !collapseListForSdoh;
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
              onOpenPhoneRail={isPhone ? () => setShowPhoneRail(true) : undefined}
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
              promptCompleteOnMount={
                shouldPromptComplete &&
                !promptCompleteFiredRef.current &&
                selectedConversation.memberId === targetMemberId
              }
              onPromptCompleteConsumed={() => {
                promptCompleteFiredRef.current = true;
              }}
              onOpenSdohPanel={handleOpenSdohPanel}
            />
          </View>
        ) : null}

        {/* SDOH / Health Screening — inline panel. A genuine sibling pane of
            the rail (never nested inside it) so the thread and every rail
            control, including "Add Case Note", stay visible and clickable
            while it's open. See InlineSdohPanel's header comment for the
            'pane' vs 'sheet' variant tradeoff. */}
        {sdohTarget != null ? (
          <InlineSdohPanel
            key={sdohTarget.sessionId ?? sdohTarget.memberId}
            sessionId={sdohTarget.sessionId}
            memberId={sdohTarget.memberId}
            memberName={
              (liveSelectedConversation ?? selectedConversation)?.memberName ?? null
            }
            onClose={handleCloseSdohPanel}
            variant={sdohPanelVariant}
          />
        ) : null}

        {/* Phone-width member context rail — reachable via the "Info" button
            in ConversationPane's header (see onOpenPhoneRail). Rendered as a
            full-screen overlay (scrim + card, same visual language as
            DocumentationModal's `presentation="overlay"`) since there's no
            room for it as a sibling pane at this width. */}
        {isPhone && showPhoneRail && selectedConversation ? (
          <View style={styles.phoneRailOverlay} accessibilityViewIsModal accessibilityRole="none">
            <Pressable
              style={styles.phoneRailScrim}
              onPress={() => setShowPhoneRail(false)}
              accessibilityLabel="Dismiss member context overlay"
            />
            <View style={styles.phoneRailCard}>
              <View style={styles.phoneRailHeader}>
                <Text style={styles.phoneRailHeaderText}>Member Context</Text>
                <PressableCard
                  onPress={() => setShowPhoneRail(false)}
                  accessibilityLabel="Close member context"
                  style={styles.iconBtnCard}
                >
                  <X size={18} color={tokens.textSecondary} />
                </PressableCard>
              </View>
              <MemberContextRail
                conversation={liveSelectedConversation ?? selectedConversation}
                onEndSessionComplete={handleEndSessionComplete}
                onSessionStarted={handleSessionStarted}
                autoBeginSessionOnMount={false}
                onAutoBeginSessionConsumed={() => {}}
                promptCompleteOnMount={false}
                onPromptCompleteConsumed={() => {}}
                onOpenSdohPanel={(target) => {
                  setShowPhoneRail(false);
                  handleOpenSdohPanel(target);
                }}
              />
            </View>
          </View>
        ) : null}
      </View>

      {/* Documentation modal triggered by End Session — Epic Q4: renders as an
          on-brand overlay anchored over this Messages page (scrim + card,
          AppShell sidebar/nav stays visible underneath) instead of a
          full-screen takeover. See `presentation` on DocumentationModal;
          every other launch path (e.g. CHWSessionsScreen) omits this prop and
          keeps the original full-screen behavior. */}
      {documentingSessionId != null && (
        <DocumentationModal
          visible={documentingSessionId != null}
          onClose={() => {
            setDocumentingSessionId(null);
            setDocumentingSessionStartedAt(null);
            setDocumentingSessionEndedAt(null);
          }}
          sessionId={documentingSessionId}
          memberId={selectedConversation?.memberId ?? undefined}
          durationMinutes={null}
          sessionStartedAt={documentingSessionStartedAt}
          sessionEndedAt={documentingSessionEndedAt}
          onSubmit={handleDocumentationSubmit}
          presentation="overlay"
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

  threadMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 11,
  } as ViewStyle,

  threadMenuItemText: {
    fontSize: 13,
    color: tokens.textPrimary,
    fontWeight: '500',
  } as TextStyle,

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

  // Live session timer pill, shown left of the call button while a session runs.
  sessionTimer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: tokens.primary + '33',
    backgroundColor: tokens.primary + '14',
  } as ViewStyle,
  sessionTimerText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: tokens.primary,
  } as TextStyle,

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

  bubbleUndelivered: {
    fontSize: 10,
    lineHeight: 14,
    marginTop: 2,
    color: tokens.textMuted,
    textAlign: 'right',
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

  // QA batch #2: inline note shown in place of composerMeta when the CHW
  // work gate blocks sending.
  composerGatedNote: {
    fontSize: 11,
    color: '#B45309',
    textAlign: 'center',
    fontWeight: '600',
  } as TextStyle,

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

  // ── Phone-width member context rail overlay (Epic K) ──────────────────────────
  // Same scrim + card language as DocumentationModal's `presentation="overlay"` —
  // absolutely fills `styles.root` (a positioned ancestor), not the whole window,
  // so it never escapes the AppShell chrome.
  phoneRailOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 40,
    alignItems: 'stretch',
    justifyContent: 'flex-end',
  } as ViewStyle,

  phoneRailScrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
  } as ViewStyle,

  phoneRailCard: {
    width: '100%',
    maxHeight: '88%',
    backgroundColor: tokens.cardBg,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    overflow: 'hidden',
    ...(shadows.card as object),
  } as ViewStyle,

  phoneRailHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: tokens.cardBorder,
    backgroundColor: tokens.cardBg,
  } as ViewStyle,

  phoneRailHeaderText: {
    fontSize: 16,
    fontWeight: '700',
    color: tokens.textPrimary,
  } as TextStyle,

  railScrollView: {
    flex: 1,
  } as ViewStyle,

  railContent: {
    padding: 14,
    paddingTop: 16,
    gap: 10,
    paddingBottom: spacing.xxxl,
    // Lets a flex:1 child (CaseNoteInlineSection, when open) grow to fill
    // any empty space below Quick Actions when the rail's natural content
    // height is shorter than the viewport. A no-op otherwise: flexGrow only
    // stretches content when there IS spare space, so this doesn't change
    // sizing/scroll behavior for any other (non-flex) rail card.
    flexGrow: 1,
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

  // Care Status journey switcher (< X/N > on the right of the title row).
  careSwitcher: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginLeft: 'auto',
  } as ViewStyle,
  careSwitcherBtn: {
    padding: 2,
    borderRadius: 6,
  } as ViewStyle,
  careSwitcherCount: {
    fontSize: 11,
    fontWeight: '600',
    color: tokens.textSecondary,
    minWidth: 26,
    textAlign: 'center',
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

  // End Session region — now just a layout anchor; the destructive
  // "Complete Session" button + confirm panel that used to render here moved
  // to ActiveSessionBadge (#19/#20) and were removed from this rail.
  endSessionRegion: {
    position: 'relative',
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
});

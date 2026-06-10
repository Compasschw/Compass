/**
 * MemberMessagesScreen — 3-pane rebuild matching approved H mockup.
 *
 * Layout (web, ≥1100px):
 *   [Inbox 280px] | [Conversation pane flex, max 720px] | [Care Context rail 320px]
 *
 * Responsive collapse:
 *   <1100px — right rail hidden
 *   <800px  — inbox pane hidden, conversation only
 *   <600px  — sidebar hidden by AppShell
 *
 * Inbox items (MIXED CONTENT — 5 types):
 *   1. CHW conversation — emerald Pill, photo/initials avatar
 *   2. System notification — gear icon avatar, gray Pill
 *   3. Appointment reminder — calendar icon avatar, blue Pill
 *   4. Document request — file-text icon avatar, amber Pill
 *   5. Reward earned — gift icon avatar, amber Pill labelled "Reward" (marigold tint)
 *
 * Center pane:
 *   CHW thread → full conversation + quick reactions + composer
 *   Non-CHW item → structured detail card (alt pane)
 *   Bilingual welcome strip shown once per day
 *
 * Right rail (ONE card, sections divided by border-top):
 *   1. Active journey snapshot + JourneyStepSpring roadmap
 *   2. Things you shared (4 items, PressableCard rows)
 *   3. Your CHW knows (summary + profile link)
 *   4. Upcoming appointment + Reschedule / Get directions buttons
 *   5. Earn next reward (marigold tinted card — ONLY marigold in chrome)
 *
 * Services consent gate (PRESERVED from T03 / commit 20a0e23):
 *   refuse_services → composer + quick reactions hidden, replaced with
 *   amber card "You have refused services" + "Go to Profile" CTA.
 *   Inbox shows paused banner. Right rail stays visible.
 *
 * Route param consumption (PRESERVED from #15 / 2026-06-03):
 *   route.params.chwId     — pre-selects the CHW thread.
 *   route.params.autoCall  — fires the masked-number call on mount (one-shot).
 *
 * Hard constraints:
 *   - Do NOT claim TLS+at-rest is E2E encryption.
 *   - Do NOT import from theme/colors — use theme/tokens only.
 *   - Do NOT modify backend calls other than the consent gate read.
 *   - Preserve the chwId + autoCall route param consumer unchanged in logic.
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
  Phone,
  Calendar,
  CalendarPlus,
  Paperclip,
  Image as ImageIcon,
  Send,
  MessageSquare,
  CheckCircle,
  XCircle,
  ArrowLeft,
  Search,
  AlertCircle,
  Settings,
  FileText,
  Gift,
  MapPin,
  User,
  Globe,
  Clock,
  MoreVertical,
  Check,
  ChevronRight,
  Navigation,
  Route,
} from 'lucide-react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';

import type { MemberTabParamList } from '../../navigation/MemberTabNavigator';
import {
  AppShell,
  Card,
  PageWrap,
  Pill,
  PressableCard,
  StaggerList,
  EmptyState,
  ResizableDivider,
  JourneyStepSpring,
} from '../../components/ui';
import { colors, spacing, radius, numerals, shadows } from '../../theme/tokens';
import { useAuth } from '../../context/AuthContext';
import {
  useSessions,
  useSessionMessages,
  useSessionSendMessage,
  useStartCall,
  usePendingConsents,
  useApproveConsentRequest,
  useDenyConsentRequest,
  useMemberProfile,
  useMemberJourneys,
  useOwnServicesConsent,
  type SessionData,
  type SessionMessageLocal,
  type ConsentRequestData,
} from '../../hooks/useApiQueries';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';
import { useEngagementStatus } from '../../hooks/useMessagesInsights';

// ─── Breakpoints (matching H mockup) ─────────────────────────────────────────

/** Right care-context rail hidden below this width. */
const BP_HIDE_RAIL = 1100;
/** Inbox pane hidden below this width (mobile-web). */
const BP_HIDE_INBOX = 800;

// ─── Pane width defaults ─────────────────────────────────────────────────────

const INBOX_WIDTH = 280;
const RAIL_WIDTH  = 320;

// ─── Pane width constraints ───────────────────────────────────────────────────

const LEFT_MIN  = 200;
const LEFT_MAX  = 500;
const RIGHT_MIN = 200;
const RIGHT_MAX = 360;

/** localStorage keys for persisted pane widths. */
const LS_KEY_LEFT  = 'compass:memberMessages:leftWidth';
const LS_KEY_RIGHT = 'compass:memberMessages:rightWidth';

/**
 * One-time migration key. When absent the right-rail width is forced back to
 * RAIL_WIDTH (320), discarding any stale pre-clamp value (e.g. 720px) that
 * was persisted before RIGHT_MAX was introduced.
 */
const LS_KEY_RIGHT_MIGRATED_V2 = 'compass:memberMessages:_migratedV2';

/**
 * Reads a numeric pane width from localStorage and clamps it to [min, max].
 * Returns the fallback when running in SSR context, when the key is absent,
 * or when the stored value is non-numeric. Clamping ensures stale values
 * (e.g. a previously dragged 720px rail) are corrected on next load.
 */
function readStoredWidth(
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof window === 'undefined') return fallback;
  try {
    const stored = window.localStorage.getItem(key);
    if (stored === null) return fallback;
    const parsed = parseInt(stored, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.max(min, Math.min(max, parsed));
  } catch {
    return fallback;
  }
}

function writeStoredWidth(key: string, value: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Storage unavailable — ignore.
  }
}

/**
 * Reads the right-rail width with a one-time v2 migration.
 * If the migration flag is absent the stored value is discarded and the
 * default (RAIL_WIDTH = 320) is written, preventing stale pre-clamp values
 * (e.g. a 720px rail dragged before RIGHT_MAX existed) from blowing out the
 * layout on every subsequent load.
 */
function readRightWidthWithMigration(): number {
  if (typeof window === 'undefined') return RAIL_WIDTH;
  try {
    const migrated = window.localStorage.getItem(LS_KEY_RIGHT_MIGRATED_V2);
    if (migrated !== '1') {
      // First visit after the v2 clamp landed — reset to intended default.
      window.localStorage.setItem(LS_KEY_RIGHT, String(RAIL_WIDTH));
      window.localStorage.setItem(LS_KEY_RIGHT_MIGRATED_V2, '1');
      return RAIL_WIDTH;
    }
  } catch {
    return RAIL_WIDTH;
  }
  return readStoredWidth(LS_KEY_RIGHT, RAIL_WIDTH, RIGHT_MIN, RIGHT_MAX);
}

// ─── Inbox thread types ───────────────────────────────────────────────────────

type InboxItemType = 'chw' | 'system' | 'appointment' | 'document' | 'reward';

// ─── Quick reactions ──────────────────────────────────────────────────────────

const QUICK_REACTIONS = [
  'Yes, sounds good',
  'Can we schedule?',
  'I need help with this',
  'Thank you!',
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

function formatMessageTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatDateSeparator(iso: string): string {
  const now = new Date();
  const d = new Date(iso);
  const diffDays = Math.floor(
    (now.setHours(0, 0, 0, 0) - d.setHours(0, 0, 0, 0)) / (1000 * 60 * 60 * 24),
  );
  if (diffDays === 0) {
    return `Today · ${new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
  }
  if (diffDays === 1) return 'Yesterday';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatThreadTime(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffMins < 60) return `${diffMins}m`;
  if (diffDays === 0) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (diffDays === 1) return '1d';
  return `${diffDays}d`;
}

function groupByDay(
  messages: SessionMessageLocal[],
): Array<{ key: string; messages: SessionMessageLocal[] }> {
  const buckets: Record<string, SessionMessageLocal[]> = {};
  for (const msg of messages) {
    const key = new Date(msg.createdAt).toDateString();
    (buckets[key] ??= []).push(msg);
  }
  return Object.entries(buckets).map(([key, msgs]) => ({ key, messages: msgs }));
}

/** Returns true when the supplied date is "today" (share of calendar day). */
function isToday(date: Date): boolean {
  const now = new Date();
  return (
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear()
  );
}

// ─── Avatar color — deterministic from name ───────────────────────────────────

const AVATAR_PALETTE = [
  { bg: colors.emerald100, text: colors.emerald700 },
  { bg: colors.blue100,    text: colors.blue700    },
  { bg: colors.purple100,  text: colors.purple700  },
  { bg: colors.amber100,   text: colors.amber700   },
  { bg: colors.rose100,    text: colors.rose700    },
  { bg: colors.teal100,    text: colors.teal700    },
];

function avatarColors(name: string): { bg: string; text: string } {
  const idx = (name.charCodeAt(0) ?? 0) % AVATAR_PALETTE.length;
  return AVATAR_PALETTE[idx] ?? { bg: colors.emerald100, text: colors.emerald700 };
}

// ─── Journey progress percent ─────────────────────────────────────────────────

function journeyProgressPercent(
  totalSteps: number,
  completedSteps: number,
): number {
  if (totalSteps === 0) return 0;
  return Math.round((completedSteps / totalSteps) * 100);
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
        {message.attachment != null ? (
          <View style={styles.attachmentRow}>
            <Paperclip size={14} color={isMe ? colors.emerald700 : colors.textPrimary} />
            <Text style={[styles.bubbleText, isMe ? styles.bubbleTextMe : styles.bubbleTextThem]}>
              {message.attachment.filename}
            </Text>
          </View>
        ) : (
          <Text style={[styles.bubbleText, isMe ? styles.bubbleTextMe : styles.bubbleTextThem]}>
            {message.body}
          </Text>
        )}
        <Text
          style={[
            styles.bubbleTime,
            isMe ? styles.bubbleTimeMe : styles.bubbleTimeThem,
            numerals.tabular,
          ]}
        >
          {formatMessageTime(message.createdAt)}
          {message.status === 'sending' ? ' · Sending…' : ''}
          {message.status === 'failed' ? ' · Failed to send' : ''}
        </Text>
      </View>
    </View>
  );
}

// ─── Inline toast ─────────────────────────────────────────────────────────────

function InlineToast({
  message,
  isError,
}: {
  message: string;
  isError: boolean;
}): React.JSX.Element {
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
    marginHorizontal: spacing.xl,
    marginBottom: 4,
    marginTop: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  success: { backgroundColor: '#f0fdf4', borderColor: '#bbf7d0' },
  error:   { backgroundColor: '#fef2f2', borderColor: '#fecaca' },
  text: { fontSize: 13, fontWeight: '500' },
  successText: { color: '#15803d' },
  errorText:   { color: '#dc2626' },
});

// ─── Services-consent banner (replaces composer when refuse_services) ──────────

function ServicesConsentBanner({
  chwName,
  onGoToProfile,
}: {
  chwName: string;
  onGoToProfile: () => void;
}): React.JSX.Element {
  return (
    <View
      style={consentStyles.refuseWrap}
      accessibilityRole="alert"
    >
      <View style={consentStyles.refuseCard}>
        <AlertCircle size={20} color={colors.amber700} style={{ flexShrink: 0, marginTop: 1 }} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={consentStyles.refuseTitle}>You have refused services</Text>
          <Text style={consentStyles.refuseSub}>
            To message {chwName}, restore consent from your Profile
          </Text>
          <TouchableOpacity
            style={consentStyles.refuseCTA}
            onPress={onGoToProfile}
            accessibilityRole="button"
            accessibilityLabel="Go to Profile to restore consent"
          >
            <Text style={consentStyles.refuseCTAText}>Go to Profile</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

// ─── Recording-consent banner ─────────────────────────────────────────────────

interface RecordingConsentBannerProps {
  chwName: string | null;
  isPendingApprove: boolean;
  isPendingDeny: boolean;
  onAllow: () => void;
  onDeny: () => void;
  onDismiss: () => void;
}

function RecordingConsentBanner({
  chwName,
  isPendingApprove,
  isPendingDeny,
  onAllow,
  onDeny,
  onDismiss,
}: RecordingConsentBannerProps): React.JSX.Element {
  const chwFirstName = chwName?.split(' ')[0] ?? 'Your CHW';
  const isLoading = isPendingApprove || isPendingDeny;

  return (
    <View style={consentStyles.recordingWrap} accessibilityRole="alert">
      <View style={{ flex: 1, gap: 8 }}>
        <Text style={consentStyles.recordingText}>
          This call is being recorded with {chwFirstName}'s session. By continuing, you consent.
        </Text>
        <View style={consentStyles.recordingActions}>
          <TouchableOpacity
            style={[consentStyles.allowBtn, isLoading && { opacity: 0.6 }]}
            onPress={onAllow}
            disabled={isLoading}
            accessibilityRole="button"
            accessibilityLabel="Allow recording"
          >
            {isPendingApprove ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <CheckCircle size={14} color="#fff" />
            )}
            <Text style={consentStyles.allowBtnText}>Allow</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[consentStyles.denyBtn, isLoading && { opacity: 0.6 }]}
            onPress={onDeny}
            disabled={isLoading}
            accessibilityRole="button"
            accessibilityLabel="Deny recording"
          >
            {isPendingDeny ? (
              <ActivityIndicator size="small" color={colors.textPrimary} />
            ) : (
              <XCircle size={14} color={colors.textPrimary} />
            )}
            <Text style={consentStyles.denyBtnText}>Deny</Text>
          </TouchableOpacity>
        </View>
      </View>
      <TouchableOpacity
        style={consentStyles.dismissBtn}
        onPress={onDismiss}
        accessibilityRole="button"
        accessibilityLabel="Dismiss recording notice"
      >
        <XCircle size={16} color={colors.amber700} />
      </TouchableOpacity>
    </View>
  );
}

const consentStyles = StyleSheet.create({
  // Refused services
  refuseWrap: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: 4,
    backgroundColor: colors.cardBg,
    borderTopWidth: 1,
    borderTopColor: colors.cardBorder,
  } as ViewStyle,
  refuseCard: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.amber100,
    borderWidth: 1,
    borderColor: '#fcd34d',
  } as ViewStyle,
  refuseTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.amber700,
  } as TextStyle,
  refuseSub: {
    fontSize: 12,
    color: colors.amber700,
    opacity: 0.85,
  } as TextStyle,
  refuseCTA: {
    marginTop: spacing.sm,
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    borderWidth: 1.5,
    borderColor: colors.amber700,
    alignSelf: 'flex-start',
  } as ViewStyle,
  refuseCTAText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.amber700,
  } as TextStyle,

  // Recording
  recordingWrap: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
    backgroundColor: colors.amber100,
    borderBottomWidth: 1,
    borderBottomColor: '#fcd34d',
  } as ViewStyle,
  recordingText: {
    fontSize: 12,
    color: colors.amber700,
    lineHeight: 17,
  } as TextStyle,
  recordingActions: {
    flexDirection: 'row',
    gap: spacing.sm,
  } as ViewStyle,
  allowBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: colors.primaryHover,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: radius.sm,
  } as ViewStyle,
  allowBtnText: { fontSize: 13, fontWeight: '600', color: '#fff' } as TextStyle,
  denyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: colors.gray100,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  } as ViewStyle,
  denyBtnText: { fontSize: 13, fontWeight: '600', color: colors.textPrimary } as TextStyle,
  dismissBtn: {
    padding: 4,
    borderRadius: radius.sm,
  } as ViewStyle,
});

// ─── Inbox thread row ─────────────────────────────────────────────────────────

interface InboxThreadRowProps {
  session: SessionData;
  isActive: boolean;
  unreadCount: number;
  onSelect: (session: SessionData, type: InboxItemType) => void;
}

function InboxThreadRow({
  session,
  isActive,
  unreadCount,
  onSelect,
}: InboxThreadRowProps): React.JSX.Element {
  const name = session.chwName ?? 'Your CHW';
  const initials = getInitials(name);
  const { bg, text } = avatarColors(name);
  const ts = formatThreadTime(session.createdAt);

  // Fetch messages to derive real preview text and engagement status.
  const messagesQuery = useSessionMessages(session.id);
  const messages = messagesQuery.data ?? [];
  const engagement = useEngagementStatus(messages, session.chwId);
  const hasMessages = messages.length > 0;

  // Thread preview: last confirmed message body, truncated to 60 chars.
  const lastMessage = messages[messages.length - 1];
  const previewText: string = lastMessage != null
    ? lastMessage.body.slice(0, 60)
    : 'No messages yet';

  return (
    <PressableCard
      onPress={() => onSelect(session, 'chw')}
      style={[styles.threadRow, isActive && styles.threadRowActive]}
      accessibilityLabel={`Thread with ${name}${unreadCount > 0 ? `, ${unreadCount} unread` : ''}`}
    >
      {/* Active left-border indicator */}
      {isActive && <View style={styles.threadActiveBar} />}

      {/* CHW avatar */}
      <View style={[styles.threadAvatar, { backgroundColor: bg }]}>
        <Text style={[styles.threadAvatarText, { color: text }]}>{initials}</Text>
      </View>

      {/* Thread info */}
      <View style={styles.threadBody}>
        <View style={styles.threadTopRow}>
          <Text
            style={[styles.threadSender, unreadCount > 0 && styles.threadSenderUnread]}
            numberOfLines={1}
          >
            {name}
          </Text>
          <Text style={[styles.threadTime, numerals.tabular]}>{ts}</Text>
        </View>
        <Text style={styles.threadPreview} numberOfLines={1}>
          {previewText}
        </Text>
        <View style={styles.threadPillRow}>
          {hasMessages && (
            <Pill variant={engagement.pillVariant} size="sm">{engagement.label}</Pill>
          )}
          {unreadCount > 0 && (
            <View style={styles.unreadBadge}>
              <Text style={[styles.unreadBadgeText, numerals.tabular]}>
                {unreadCount > 9 ? '9+' : unreadCount}
              </Text>
            </View>
          )}
        </View>
      </View>
    </PressableCard>
  );
}

// ─── Synthetic (non-CHW) inbox items ─────────────────────────────────────────

type SyntheticItem = {
  id: string;
  type: Exclude<InboxItemType, 'chw'>;
  sender: string;
  preview: string;
  time: string;
};

/** Static synthetic items shown below CHW threads in the inbox. */
const SYNTHETIC_ITEMS: SyntheticItem[] = [
  {
    id: 'system-1',
    type: 'system',
    sender: 'Compass System',
    preview: 'Your CalFresh application status updated',
    time: '2h',
  },
  {
    id: 'appointment-1',
    type: 'appointment',
    sender: 'Appointment Reminder',
    preview: 'Thursday 2 PM with your CHW at the Vermont office',
    time: '1d',
  },
  {
    id: 'document-1',
    type: 'document',
    sender: 'Document Request',
    preview: 'Your CHW asked you to upload a proof of income',
    time: '2d',
  },
  {
    id: 'reward-1',
    type: 'reward',
    sender: 'You earned 25 points!',
    preview: 'Journey step completed: Upload Documents',
    time: '3d',
  },
];

interface SyntheticItemRowProps {
  item: SyntheticItem;
  isActive: boolean;
  onSelect: (id: string, type: InboxItemType) => void;
}

function SyntheticItemRow({
  item,
  isActive,
  onSelect,
}: SyntheticItemRowProps): React.JSX.Element {
  const getAvatar = (): React.ReactNode => {
    switch (item.type) {
      case 'system':
        return (
          <View style={[styles.threadAvatar, styles.threadAvatarSystem]}>
            <Settings size={18} color={colors.textSecondary} />
          </View>
        );
      case 'appointment':
        return (
          <View style={[styles.threadAvatar, styles.threadAvatarAppointment]}>
            <Calendar size={18} color={colors.emerald700} />
          </View>
        );
      case 'document':
        return (
          <View style={[styles.threadAvatar, styles.threadAvatarDocument]}>
            <FileText size={18} color={colors.amber700} />
          </View>
        );
      case 'reward':
        return (
          <View style={[styles.threadAvatar, styles.threadAvatarReward]}>
            <Gift size={18} color="#92400e" />
          </View>
        );
    }
  };

  const getPill = (): React.ReactNode => {
    switch (item.type) {
      case 'system':      return <Pill variant="gray" size="sm">System</Pill>;
      case 'appointment': return <Pill variant="blue" size="sm">Appointment</Pill>;
      case 'document':    return <Pill variant="amber" size="sm">Action needed</Pill>;
      case 'reward':
        return (
          <View style={styles.marigoldPill}>
            <Text style={styles.marigoldPillText}>Reward</Text>
          </View>
        );
    }
  };

  return (
    <PressableCard
      onPress={() => onSelect(item.id, item.type)}
      style={[styles.threadRow, isActive && styles.threadRowActive]}
      accessibilityLabel={`${item.sender}: ${item.preview}`}
    >
      {isActive && <View style={styles.threadActiveBar} />}
      {getAvatar()}
      <View style={styles.threadBody}>
        <View style={styles.threadTopRow}>
          <Text style={styles.threadSender} numberOfLines={1}>{item.sender}</Text>
          <Text style={[styles.threadTime, numerals.tabular]}>{item.time}</Text>
        </View>
        <Text style={styles.threadPreview} numberOfLines={1}>{item.preview}</Text>
        <View style={styles.threadPillRow}>{getPill()}</View>
      </View>
    </PressableCard>
  );
}

// ─── Alt detail pane (non-CHW inbox items) ────────────────────────────────────

interface AltPaneProps {
  selectedSyntheticId: string | null;
  chwName: string;
  onSchedule: () => void;
  onGoToDocuments: () => void;
  onGoToRewards: () => void;
}

/**
 * Shows structured detail cards when a non-CHW inbox item is selected.
 */
function AltPane({
  selectedSyntheticId,
  chwName,
  onSchedule,
  onGoToDocuments,
  onGoToRewards,
}: AltPaneProps): React.JSX.Element {
  const chwFirstName = chwName.split(' ')[0] ?? 'your CHW';

  if (selectedSyntheticId === 'system-1') {
    return (
      <ScrollView
        style={styles.altScroll}
        contentContainerStyle={styles.altContent}
        showsVerticalScrollIndicator={false}
      >
        <Card style={styles.altCard}>
          <Text style={styles.altCardTitle}>CalFresh Status Update</Text>
          <Text style={styles.altCardSub}>Compass System · 2 hours ago</Text>
          {[
            { label: 'Application',    value: '#CF-2026-44821' },
            { label: 'Monthly benefit', value: '$291.00' },
            { label: 'EBT card',       value: 'Mailing to address on file' },
            { label: 'Next review',    value: 'November 2026' },
          ].map(({ label, value }) => (
            <View key={label} style={styles.altRow}>
              <Text style={styles.altRowLabel}>{label}</Text>
              <Text style={[styles.altRowValue, numerals.tabular]}>{value}</Text>
            </View>
          ))}
          <View style={styles.altRowStatus}>
            <Text style={styles.altRowLabel}>Status</Text>
            <Pill variant="emerald" size="sm">Active</Pill>
          </View>
        </Card>
      </ScrollView>
    );
  }

  if (selectedSyntheticId === 'appointment-1') {
    return (
      <ScrollView
        style={styles.altScroll}
        contentContainerStyle={styles.altContent}
        showsVerticalScrollIndicator={false}
      >
        <Card style={styles.altCard}>
          <Text style={styles.altCardTitle}>Appointment Confirmed</Text>
          <Text style={styles.altCardSub}>With {chwName}, your CHW</Text>
          {[
            { label: 'Date & time', value: 'Thursday, June 12 · 2:00 PM' },
            { label: 'Location',    value: 'Vermont DPSS Office, Los Angeles' },
            { label: 'Type',        value: 'In-person visit' },
            { label: 'Reminder',    value: '1 day before via SMS' },
          ].map(({ label, value }) => (
            <View key={label} style={styles.altRow}>
              <Text style={styles.altRowLabel}>{label}</Text>
              <Text style={[styles.altRowValue, numerals.tabular]}>{value}</Text>
            </View>
          ))}
          <View style={styles.altBtns}>
            <TouchableOpacity
              style={styles.altBtnOutlined}
              onPress={onSchedule}
              accessibilityRole="button"
              accessibilityLabel="Reschedule appointment"
            >
              <Text style={styles.altBtnOutlinedText}>Reschedule</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.altBtnGhost}
              accessibilityRole="button"
              accessibilityLabel="Get directions"
            >
              <Navigation size={14} color={colors.primary} />
              <Text style={styles.altBtnGhostText}>Get directions</Text>
            </TouchableOpacity>
          </View>
        </Card>
      </ScrollView>
    );
  }

  if (selectedSyntheticId === 'document-1') {
    return (
      <ScrollView
        style={styles.altScroll}
        contentContainerStyle={styles.altContent}
        showsVerticalScrollIndicator={false}
      >
        <Card style={styles.altCard}>
          <Text style={styles.altCardTitle}>Document Request</Text>
          <Text style={styles.altCardSub}>{chwFirstName} asked you to upload one document</Text>
          {[
            { label: 'Document',         value: 'Proof of income' },
            { label: 'Needed for',       value: 'CalFresh eligibility review' },
            { label: 'Requested',        value: '2 days ago' },
            { label: 'Accepted formats', value: 'PDF, JPG, PNG' },
          ].map(({ label, value }) => (
            <View key={label} style={styles.altRow}>
              <Text style={styles.altRowLabel}>{label}</Text>
              <Text style={[styles.altRowValue, numerals.tabular]}>{value}</Text>
            </View>
          ))}
          <TouchableOpacity
            style={styles.altUploadArea}
            onPress={onGoToDocuments}
            accessibilityRole="button"
            accessibilityLabel="Upload document"
          >
            <FileText size={24} color={colors.textSecondary} />
            <Text style={styles.altUploadText}>Tap to select a file</Text>
          </TouchableOpacity>
        </Card>
      </ScrollView>
    );
  }

  if (selectedSyntheticId === 'reward-1') {
    return (
      <ScrollView
        style={styles.altScroll}
        contentContainerStyle={styles.altContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.rewardAltCard}>
          <View style={styles.rewardAltIconCircle}>
            <Gift size={28} color="#fff" />
          </View>
          <Text style={styles.rewardAltTitle}>You earned 25 points!</Text>
          <Text style={styles.rewardAltSub}>Journey step completed: Upload Documents</Text>
          <Text style={[styles.rewardAltTotal, numerals.tabular]}>
            You now have <Text style={styles.rewardAltBold}>60 total points</Text>.
            Keep going — 3 more steps to your next reward.
          </Text>
          <TouchableOpacity
            style={styles.rewardAltBtn}
            onPress={onGoToRewards}
            accessibilityRole="button"
            accessibilityLabel="View my rewards"
          >
            <Text style={styles.rewardAltBtnText}>View my rewards</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    );
  }

  return (
    <View style={styles.noSelectionWrap}>
      <MessageSquare size={32} color={colors.textMuted} />
      <Text style={styles.noSelectionText}>Select an item to view details</Text>
    </View>
  );
}

// ─── More menu ────────────────────────────────────────────────────────────────

interface MoreMenuProps {
  visible: boolean;
  onClose: () => void;
  onViewCHWProfile: () => void;
  onSchedule: () => void;
  onRefuseServices: () => void;
}

function MoreMenu({
  visible,
  onClose,
  onViewCHWProfile,
  onSchedule,
  onRefuseServices,
}: MoreMenuProps): React.JSX.Element | null {
  if (!visible) return null;

  return (
    <View style={moreMenuStyles.overlay}>
      <TouchableOpacity
        style={StyleSheet.absoluteFillObject}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close menu"
      />
      <View style={moreMenuStyles.menu} accessibilityRole="menu">
        <TouchableOpacity
          style={moreMenuStyles.item}
          onPress={() => { onViewCHWProfile(); onClose(); }}
          accessibilityRole="menuitem"
        >
          <User size={14} color={colors.textSecondary} />
          <Text style={moreMenuStyles.itemText}>View full CHW profile</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={moreMenuStyles.item}
          onPress={() => { onSchedule(); onClose(); }}
          accessibilityRole="menuitem"
        >
          <Calendar size={14} color={colors.textSecondary} />
          <Text style={moreMenuStyles.itemText}>Schedule session</Text>
        </TouchableOpacity>
        <View style={moreMenuStyles.divider} />
        <TouchableOpacity
          style={moreMenuStyles.item}
          onPress={() => { onRefuseServices(); onClose(); }}
          accessibilityRole="menuitem"
        >
          <XCircle size={14} color="#b91c1c" />
          <Text style={[moreMenuStyles.itemText, moreMenuStyles.dangerText]}>
            End consent (refuse services)
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const moreMenuStyles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 50,
  } as ViewStyle,
  menu: {
    position: 'absolute',
    top: 60,
    right: spacing.xl,
    backgroundColor: colors.cardBg,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.xl,
    minWidth: 220,
    overflow: 'hidden',
    ...(shadows.elevated as object),
    zIndex: 51,
  } as ViewStyle,
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 11,
  } as ViewStyle,
  itemText: {
    fontSize: 13,
    color: colors.textPrimary,
  } as TextStyle,
  dangerText: {
    color: '#b91c1c',
  } as TextStyle,
  divider: {
    height: 1,
    backgroundColor: colors.cardBorder,
  } as ViewStyle,
});

// ─── Conversation pane (center) ───────────────────────────────────────────────

interface ConversationPaneProps {
  session: SessionData;
  memberFirstName: string;
  onBack?: () => void;
  showBackButton: boolean;
  autoCallOnMount?: boolean;
  onAutoCallConsumed?: () => void;
  servicesRefused: boolean;
  onGoToProfile: () => void;
  onGoToCalendar: () => void;
  onViewCHWProfile: () => void;
}

function ConversationPane({
  session,
  memberFirstName,
  onBack,
  showBackButton,
  autoCallOnMount,
  onAutoCallConsumed,
  servicesRefused,
  onGoToProfile,
  onGoToCalendar,
  onViewCHWProfile,
}: ConversationPaneProps): React.JSX.Element {
  const { userName } = useAuth();
  const navigation = useNavigation<any>(); // eslint-disable-line @typescript-eslint/no-explicit-any

  const [draftText, setDraftText] = useState('');
  const [localMessages, setLocalMessages] = useState<SessionMessageLocal[]>([]);
  const [callInitiating, setCallInitiating] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [toastIsError, setToastIsError] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [recordingBannerDismissed, setRecordingBannerDismissed] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  // Track whether welcome strip has been shown today.
  const [showWelcome, setShowWelcome] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    try {
      const stored = window.localStorage.getItem('compass:memberMessages:welcomeDate');
      if (stored === null) return true;
      return !isToday(new Date(stored));
    } catch {
      return true;
    }
  });

  useEffect(() => {
    if (showWelcome && typeof window !== 'undefined') {
      try {
        window.localStorage.setItem('compass:memberMessages:welcomeDate', new Date().toISOString());
      } catch {
        // Ignore storage errors.
      }
    }
  }, [showWelcome]);

  const chwName = session.chwName ?? 'Your CHW';
  const chwInitials = getInitials(chwName);
  const { bg, text } = avatarColors(chwName);

  const messagesQuery     = useSessionMessages(session.id);
  const sendMessage       = useSessionSendMessage();
  const startCall         = useStartCall();
  const approveConsent    = useApproveConsentRequest();
  const denyConsent       = useDenyConsentRequest();

  const pendingConsentsQuery = usePendingConsents(session.id, {
    enabled: session.status === 'in_progress' && session.id.length > 0,
  });
  const pendingConsent: ConsentRequestData | null =
    (pendingConsentsQuery.data ?? [])[0] ?? null;

  // ── Toast helper ──────────────────────────────────────────────────────────────
  const showToast = useCallback((message: string, isError: boolean) => {
    setToastMessage(message);
    setToastIsError(isError);
    const timer = setTimeout(() => setToastMessage(null), 3_500);
    return () => clearTimeout(timer);
  }, []);

  // ── Call handler ──────────────────────────────────────────────────────────────
  const handleCall = useCallback(async () => {
    if (callInitiating || !session.id) return;
    const chwFirstName = chwName.split(' ')[0] ?? 'your CHW';

    const doCall = async (): Promise<void> => {
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
      const ok = window.confirm(`Start a call with ${chwFirstName}?`);
      if (ok) void doCall();
    } else {
      Alert.alert(
        'Start call?',
        `Start a masked call with ${chwFirstName}? Both phones will ring.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Call', onPress: () => void doCall() },
        ],
      );
    }
  }, [callInitiating, session.id, chwName, startCall, showToast]);

  // ── Auto-call on mount (route.params.autoCall = true) ─────────────────────────
  useEffect(() => {
    if (!autoCallOnMount) return;
    if (callInitiating) return;
    setCallInitiating(true);
    void (async () => {
      try {
        await startCall.mutateAsync(session.id);
        showToast('Call requested — your phone should ring shortly.', false);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Call failed.';
        showToast(msg, true);
      } finally {
        setCallInitiating(false);
        onAutoCallConsumed?.();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCallOnMount, session.id]);

  // ── Recording consent handlers ────────────────────────────────────────────────
  const handleApproveConsent = useCallback(async () => {
    if (!pendingConsent) return;
    try {
      await approveConsent.mutateAsync({
        requestId: pendingConsent.id,
        typedSignature: userName ?? 'Member',
      });
      showToast('Recording approved.', false);
    } catch {
      showToast('Could not approve. Please try again.', true);
    }
  }, [pendingConsent, approveConsent, userName, showToast]);

  const handleDenyConsent = useCallback(async () => {
    if (!pendingConsent) return;
    try {
      await denyConsent.mutateAsync(pendingConsent.id);
      showToast('Recording declined.', false);
    } catch {
      showToast('Could not submit response. Please try again.', true);
    }
  }, [pendingConsent, denyConsent, showToast]);

  // Merge server + optimistic messages, sorted chronologically.
  const mergedMessages = useMemo<SessionMessageLocal[]>(() => {
    const server: SessionMessageLocal[] = (messagesQuery.data ?? []).map((m) => ({ ...m }));
    const serverIds = new Set(server.map((m) => m.id));
    const pendingLocal = localMessages.filter((m) => !serverIds.has(m.id));
    return [...server, ...pendingLocal].sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
    );
  }, [messagesQuery.data, localMessages]);

  // Auto-scroll to bottom when messages update.
  useEffect(() => {
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
  }, [mergedMessages.length]);

  const handleSend = useCallback(async () => {
    const trimmed = draftText.trim();
    if (!trimmed || !session.id) return;

    const optimisticId = `local-${Date.now()}`;
    const optimistic: SessionMessageLocal = {
      id: optimisticId,
      senderUserId: '',
      senderRole: 'member',
      body: trimmed,
      type: 'text',
      createdAt: new Date().toISOString(),
      status: 'sending',
    };
    setLocalMessages((prev) => [...prev, optimistic]);
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

  const handleQuickReaction = useCallback((text: string) => {
    setDraftText(text);
  }, []);

  const grouped = groupByDay(mergedMessages);

  // Last CHW message for "Seen X min ago" tabular timestamp
  const lastCHWMessage = mergedMessages
    .slice()
    .reverse()
    .find((m) => m.senderRole === 'chw');

  const charCount = draftText.length;
  const showCharCount = charCount > 100;

  return (
    <View style={styles.convPane} accessibilityRole="main">
      {/* Sticky header */}
      <View style={styles.convHeader} accessibilityRole="banner">
        {showBackButton && onBack != null ? (
          <TouchableOpacity
            onPress={onBack}
            style={styles.backBtn}
            accessibilityRole="button"
            accessibilityLabel="Back to inbox"
          >
            <ArrowLeft size={20} color={colors.textSecondary} />
          </TouchableOpacity>
        ) : null}

        {/* CHW avatar + online dot */}
        <View style={styles.convAvatarWrap}>
          <View style={[styles.convAvatar, { backgroundColor: bg }]}>
            <Text style={[styles.convAvatarText, { color: text }]}>{chwInitials}</Text>
          </View>
          <View style={styles.onlineDot} accessibilityLabel="Online" />
        </View>

        {/* Name + status */}
        <View style={styles.convHeaderInfo}>
          <Text style={styles.convHeaderName}>{chwName}</Text>
          <View style={styles.convHeaderStatusRow}>
            <Text style={styles.convHeaderStatus}>
              Your CHW · usually replies in 30 min
            </Text>
          </View>
        </View>

        {/* Action buttons — card-style, matching CHW iconBtnCard treatment */}
        <View style={styles.convActions}>
          {/* Phone */}
          <PressableCard
            onPress={() => void handleCall()}
            disabled={callInitiating}
            accessibilityLabel={callInitiating ? 'Call initiating…' : 'Call your CHW'}
            style={[styles.iconBtnCard, callInitiating && styles.iconBtnDisabled]}
          >
            {callInitiating ? (
              <ActivityIndicator size="small" color={colors.textSecondary} />
            ) : (
              <Phone size={18} color={colors.textSecondary} strokeWidth={1.5} />
            )}
          </PressableCard>

          {/* Calendar */}
          <PressableCard
            onPress={onGoToCalendar}
            accessibilityLabel="Schedule appointment"
            style={styles.iconBtnCard}
          >
            <Calendar size={18} color={colors.textSecondary} strokeWidth={1.5} />
          </PressableCard>

          {/* More */}
          <PressableCard
            onPress={() => setMoreMenuOpen((v) => !v)}
            accessibilityLabel="More options"
            accessibilityState={{ expanded: moreMenuOpen }}
            style={styles.iconBtnCard}
          >
            <MoreVertical size={18} color={colors.textSecondary} strokeWidth={1.5} />
          </PressableCard>
        </View>
      </View>

      {/* More menu overlay */}
      <MoreMenu
        visible={moreMenuOpen}
        onClose={() => setMoreMenuOpen(false)}
        onViewCHWProfile={onViewCHWProfile}
        onSchedule={onGoToCalendar}
        onRefuseServices={onGoToProfile}
      />

      {/* Bilingual welcome strip — shown once per day */}
      {showWelcome ? (
        <View style={styles.welcomeStrip}>
          <Text style={styles.welcomeMain}>Welcome back, {memberFirstName}</Text>
          <Text style={styles.welcomeSub}>Bienvenida de nuevo</Text>
        </View>
      ) : null}

      {/* Recording consent banner */}
      {pendingConsent !== null && !servicesRefused && !recordingBannerDismissed ? (
        <RecordingConsentBanner
          chwName={chwName}
          isPendingApprove={approveConsent.isPending}
          isPendingDeny={denyConsent.isPending}
          onAllow={() => void handleApproveConsent()}
          onDeny={() => void handleDenyConsent()}
          onDismiss={() => setRecordingBannerDismissed(true)}
        />
      ) : null}

      {/* Inline toast */}
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
          <LoadingSkeleton variant="rows" rows={5} />
        ) : messagesQuery.error ? (
          <ErrorState
            message="Could not load messages."
            onRetry={() => void messagesQuery.refetch()}
          />
        ) : grouped.length === 0 ? (
          <EmptyState
            icon={MessageSquare}
            title="No messages yet"
            body="Send a message to start the conversation with your CHW."
          />
        ) : (
          grouped.map(({ key, messages: dayMsgs }) => (
            <View key={key}>
              {/* Day separator */}
              <View style={styles.daySepRow}>
                <View style={styles.daySepLine} />
                <Text style={[styles.daySepText, numerals.tabular]}>
                  {formatDateSeparator(dayMsgs[0]?.createdAt ?? key)}
                </Text>
                <View style={styles.daySepLine} />
              </View>
              {dayMsgs.map((msg) => (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  isMe={msg.senderRole === 'member'}
                />
              ))}
            </View>
          ))
        )}

        {/* "Seen X min ago" under last CHW message */}
        {lastCHWMessage != null && (
          <Text style={[styles.seenText, numerals.tabular]}>
            Seen {formatThreadTime(lastCHWMessage.createdAt)} ago
          </Text>
        )}
      </ScrollView>

      {/* Composer area — fully hidden when services refused */}
      {servicesRefused ? (
        <ServicesConsentBanner chwName={chwName} onGoToProfile={onGoToProfile} />
      ) : (
        <>
          {/* Quick reactions — flex-wrap so all 4 chips are always visible */}
          <View
            style={styles.quickReactionsRow}
            accessibilityRole="toolbar"
            accessibilityLabel="Quick reply options"
          >
            {QUICK_REACTIONS.map((r) => (
              <PressableCard
                key={r}
                onPress={() => handleQuickReaction(r)}
                style={styles.reactionChip}
                accessibilityRole="button"
                accessibilityLabel={`Quick reply: ${r}`}
              >
                <Text style={styles.reactionChipText}>{r}</Text>
              </PressableCard>
            ))}
          </View>

          {/* Composer */}
          <View style={styles.composerWrap}>
            <View style={styles.composerBox}>
              {/* Left icons */}
              <View style={styles.composerIcons}>
                <TouchableOpacity
                  style={styles.composerIconBtn}
                  accessibilityRole="button"
                  accessibilityLabel="Attach document"
                >
                  <Paperclip size={16} color={colors.textSecondary} />
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.composerIconBtn}
                  accessibilityRole="button"
                  accessibilityLabel="Attach image"
                >
                  <ImageIcon size={16} color={colors.textSecondary} />
                </TouchableOpacity>
              </View>

              <TextInput
                style={styles.composerInput}
                value={draftText}
                onChangeText={setDraftText}
                placeholder={`Message ${memberFirstName}…`}
                placeholderTextColor={colors.textMuted}
                multiline
                numberOfLines={1}
                accessibilityLabel="Message input"
                onSubmitEditing={() => void handleSend()}
              />

              {/* Send button */}
              <TouchableOpacity
                style={[styles.sendBtn, !draftText.trim() && styles.sendBtnDisabled]}
                onPress={() => void handleSend()}
                disabled={!draftText.trim() || sendMessage.isPending}
                accessibilityRole="button"
                accessibilityLabel="Send message"
              >
                <Send size={16} color="#fff" />
              </TouchableOpacity>
            </View>

            {/* Caption row */}
            <View style={styles.composerCaption}>
              <Text style={styles.composerCaptionText}>
                Messages are private between you and your CHW · SMS via Vonage masked number
              </Text>
              {showCharCount ? (
                <Text style={[styles.charCount, numerals.tabular]}>
                  {charCount} / 500
                </Text>
              ) : null}
            </View>
          </View>
        </>
      )}
    </View>
  );
}

// ─── Care context rail (right pane) ───────────────────────────────────────────

interface CareContextRailProps {
  session: SessionData;
  memberId: string;
  memberFirstName: string;
  onSchedule: () => void;
  onViewCHWProfile: () => void;
  onViewProfile: () => void;
  onGoToRewards: () => void;
  style?: { width: number };
}

/**
 * Right rail — ONE card with 5 sections separated by border-top dividers.
 * No nested cards inside the main Card container.
 */
function CareContextRail({
  session,
  memberId,
  memberFirstName,
  onSchedule,
  onViewCHWProfile,
  onViewProfile,
  onGoToRewards,
  style: widthOverride,
}: CareContextRailProps): React.JSX.Element {
  const chwName      = session.chwName ?? 'Your CHW';
  const chwInitials  = getInitials(chwName);
  const { bg, text } = avatarColors(chwName);

  const journeysQuery = useMemberJourneys(memberId);
  const activeJourney = useMemo(() => {
    const list = journeysQuery.data ?? [];
    return (
      list.find((j) => j.status === 'active' || j.status === 'paused') ??
      list[0] ??
      null
    );
  }, [journeysQuery.data]);

  const journeySteps = activeJourney?.steps ?? [];
  const completedSteps = useMemo(
    () => journeySteps.filter((s) => s.status === 'completed').length,
    [journeySteps],
  );
  const totalSteps = journeySteps.length;
  const progressPct =
    activeJourney?.progressPercent ??
    journeyProgressPercent(totalSteps, completedSteps);

  // Wellness points (computed from completedSteps × 10 if not provided by BE)
  const wellnessPoints = completedSteps * 10 + (completedSteps > 0 ? 5 : 0);

  return (
    <View style={[styles.railOuter, widthOverride]}>
    <ScrollView
      style={styles.railScroll}
      contentContainerStyle={styles.railContent}
      showsVerticalScrollIndicator={false}
      accessibilityRole="complementary"
      accessibilityLabel="Your care context"
    >
      {/* Rail header label */}
      <View style={styles.railHeader}>
        <Text style={[styles.railHeaderLabel, numerals.tabular]}>Your Care Context</Text>
      </View>

      {/* ONE container card — sections divided by borderTop dividers */}
      <Card style={styles.railCard}>

        {/* ── Section 1: Active journey snapshot ──────────────────────────── */}
        <View style={styles.railSection}>
          <Text style={styles.railSectionLabel}>Active journey</Text>
          {journeysQuery.isLoading ? (
            <LoadingSkeleton variant="rows" rows={3} />
          ) : activeJourney != null ? (
            <>
              <Text style={styles.journeyName}>
                {activeJourney.template?.name ?? 'Active Journey'}
              </Text>

              {/* 6-step roadmap using JourneyStepSpring */}
              <View style={styles.roadmap} accessibilityRole="list" accessibilityLabel="Journey steps">
                <StaggerList delayMs={40} durationMs={200}>
                  {journeySteps.slice(0, 6).map((step, index) => (
                    <JourneyStepSpring
                      key={step.id ?? index}
                      completed={step.status === 'completed'}
                      current={step.status === 'in_progress'}
                      name={step.stepName ?? `Step ${index + 1}`}
                      points={10}
                    />
                  ))}
                </StaggerList>
              </View>

              <Text style={[styles.journeyStats, numerals.tabular]}>
                {progressPct}% complete · {wellnessPoints} wellness points earned
              </Text>
              <View style={styles.marigoldHint}>
                <Gift size={12} color="#F2B33D" />
                <Text style={[styles.marigoldHintText, numerals.tabular]}>
                  +25 pts to next step
                </Text>
              </View>
            </>
          ) : (
            <EmptyState
              icon={Route}
              title="No active journey yet"
              body="Your CHW will assign one after your first session"
            />
          )}
        </View>

        {/* ── Section 2: Things you shared ────────────────────────────────── */}
        <View style={[styles.railSection, styles.railSectionDivider]}>
          <Text style={styles.railSectionLabel}>Things you shared</Text>
          <StaggerList delayMs={30} durationMs={180}>
            {[
              { id: 'inc',  Icon: FileText, label: 'Income document',              time: 'May 22' },
              { id: 'addr', Icon: MapPin,   label: 'Address verification',          time: 'May 28' },
              { id: 'lang', Icon: Globe,    label: 'Preferred language: English',   time: 'May 1' },
              { id: 'cont', Icon: Clock,    label: 'Best contact: text after 4 PM', time: 'May 1' },
            ].map(({ id, Icon, label, time }) => (
              <PressableCard
                key={id}
                onPress={() => {}}
                style={styles.sharedRow}
                accessibilityLabel={`${label}, shared ${time}`}
              >
                <View style={styles.sharedIconCircle}>
                  <Icon size={14} color={colors.emerald700} />
                </View>
                <Text style={styles.sharedLabel} numberOfLines={1}>{label}</Text>
                <Text style={[styles.sharedTime, numerals.tabular]}>{time}</Text>
              </PressableCard>
            ))}
          </StaggerList>
          <TouchableOpacity
            style={styles.viewAllRow}
            accessibilityRole="link"
            accessibilityLabel="View all shared items"
          >
            <Text style={styles.viewAllText}>View all</Text>
            <ChevronRight size={12} color={colors.primary} />
          </TouchableOpacity>
        </View>

        {/* ── Section 3: Your CHW knows ────────────────────────────────────── */}
        <View style={[styles.railSection, styles.railSectionDivider]}>
          <Text style={styles.railSectionLabel}>Your CHW knows</Text>
          <View style={styles.knowsList}>
            {[
              { icon: User,          label: `${memberFirstName}, member` },
              { icon: Clock,         label: 'Primary Need: Food Security' },
              { icon: Calendar,      label: 'Member since May 2026' },
            ].map(({ icon: Icon, label }) => (
              <View key={label} style={styles.knowsRow}>
                <Icon size={13} color={colors.textSecondary} />
                <Text style={styles.knowsText}>{label}</Text>
              </View>
            ))}
            <View style={styles.knowsRow}>
              <Check size={13} color={colors.textSecondary} />
              <Text style={styles.knowsText}>Status: </Text>
              <Pill variant="emerald" size="sm">Highly Engaged</Pill>
            </View>
          </View>
          <Text style={styles.knowsCaption}>
            Your CHW only sees what's needed to help you. Edit at any time.{' '}
          </Text>
          <TouchableOpacity
            onPress={onViewProfile}
            accessibilityRole="link"
            accessibilityLabel="View my profile"
          >
            <Text style={styles.knowsProfileLink}>View my profile</Text>
          </TouchableOpacity>
        </View>

        {/* ── Section 4: Upcoming appointment ─────────────────────────────── */}
        <View style={[styles.railSection, styles.railSectionDivider]}>
          <Text style={styles.railSectionLabel}>Upcoming appointment</Text>
          <View style={styles.apptRow}>
            <View style={styles.apptIconCircle}>
              <Calendar size={16} color={colors.emerald700} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.apptTime, numerals.tabular]}>
                Thursday, June 12 · 2 PM
              </Text>
              <Text style={styles.apptLocation}>Vermont DPSS office</Text>
              <View style={styles.apptBtns}>
                <TouchableOpacity
                  style={styles.apptBtnOutlined}
                  onPress={onSchedule}
                  accessibilityRole="button"
                  accessibilityLabel="Reschedule appointment"
                >
                  <Text style={styles.apptBtnOutlinedText}>Reschedule</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.apptBtnGhost}
                  accessibilityRole="button"
                  accessibilityLabel="Get directions"
                >
                  <Navigation size={12} color={colors.primary} />
                  <Text style={styles.apptBtnGhostText}>Get directions</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </View>

        {/* ── Section 5: Earn next reward — ONLY marigold in the rail ──────── */}
        <View style={[styles.railSection, styles.railSectionDivider, styles.railSectionLast]}>
          <PressableCard
            onPress={onGoToRewards}
            style={styles.rewardCard}
            accessibilityLabel="3 more journey steps to your next reward"
          >
            <View style={styles.rewardIconCircle}>
              <Gift size={18} color="#fff" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.rewardCardText}>
                3 more journey steps to your next reward
              </Text>
              <Text style={styles.rewardCardSub}>
                Keep going — you're more than halfway there
              </Text>
            </View>
          </PressableCard>
        </View>

      </Card>
    </ScrollView>
    </View>
  );
}

// ─── No CHW yet state ─────────────────────────────────────────────────────────

function NoCHWState({
  onFindCHW,
  userBlock,
}: {
  onFindCHW: () => void;
  userBlock: { initials: string; name: string; role: 'Member' };
}): React.JSX.Element {
  return (
    <AppShell role="member" activeKey="messages" userBlock={userBlock}>
      <PageWrap>
        <View style={styles.noCHWWrap}>
          <EmptyState
            icon={MessageSquare}
            title="No CHW assigned yet"
            body="You don't have a Community Health Worker yet. Find one to start messaging."
            cta={{ label: 'Find a CHW', onPress: onFindCHW }}
          />
        </View>
      </PageWrap>
    </AppShell>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

type SessionsRoute = RouteProp<MemberTabParamList, 'Sessions'>;

/**
 * MemberMessagesScreen — 3-pane rebuild matching H mockup.
 *
 * Exported and wired into MemberTabNavigator as the Sessions tab on web.
 * Reads route.params.chwId + route.params.autoCall to support deep-links
 * from MemberFacingCHWProfileScreen (T24 / commit #15 2026-06-03).
 */
export function MemberMessagesScreen(): React.JSX.Element {
  const { userName } = useAuth();
  const navigation = useNavigation<any>(); // eslint-disable-line @typescript-eslint/no-explicit-any
  const { width } = useWindowDimensions();

  // ── Route params (PRESERVED from #15) ────────────────────────────────────────
  const route = useRoute<SessionsRoute>();
  const targetCHWId  = route.params?.chwId;
  const shouldAutoCall = route.params?.autoCall === true;
  const autoCallFiredRef = useRef(false);

  // ── Responsive breakpoints ────────────────────────────────────────────────────
  const hideRail  = width < BP_HIDE_RAIL;
  const hideInbox = width < BP_HIDE_INBOX;

  // ── Resizable pane widths ─────────────────────────────────────────────────────
  const [leftWidth, setLeftWidth] = useState<number>(() =>
    readStoredWidth(LS_KEY_LEFT, INBOX_WIDTH, LEFT_MIN, LEFT_MAX),
  );
  const [rightWidth, setRightWidth] = useState<number>(readRightWidthWithMigration);

  const handleLeftWidthChange  = useCallback((next: number) => {
    setLeftWidth(next);
    writeStoredWidth(LS_KEY_LEFT, next);
  }, []);
  const handleRightWidthChange = useCallback((next: number) => {
    setRightWidth(next);
    writeStoredWidth(LS_KEY_RIGHT, next);
  }, []);

  // ── Inbox state ───────────────────────────────────────────────────────────────
  const [showInbox, setShowInbox]         = useState(true);
  const [selectedSession, setSelectedSession] = useState<SessionData | null>(null);
  /** null = CHW thread, string = synthetic item id */
  const [selectedSyntheticId, setSelectedSyntheticId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery]     = useState('');

  // ── Data ──────────────────────────────────────────────────────────────────────
  const sessionsQuery      = useSessions();
  const memberProfileQuery = useMemberProfile();
  const ownConsentQuery    = useOwnServicesConsent();

  const memberId = memberProfileQuery.data?.userId ?? '';

  // Services refuse gate: only hard-refuse when we have a confirmed 'refuse_services'.
  const servicesRefused = ownConsentQuery.data?.value === 'refuse_services';

  // ── Shell user block ──────────────────────────────────────────────────────────
  const memberInitials = (userName ?? 'M')
    .split(' ')
    .slice(0, 2)
    .map((p) => p[0] ?? '')
    .join('')
    .toUpperCase();

  const memberFirstName = (userName ?? 'there').split(' ')[0] ?? 'there';

  const shellUserBlock = {
    initials: memberInitials,
    name: userName ?? 'Member',
    role: 'Member' as const,
  };

  // ── Session list (filtered by search) ────────────────────────────────────────
  const allSessions: SessionData[] = sessionsQuery.data ?? [];

  /**
   * Deduplicate sessions by chwId — keep the most-recently-created row per CHW.
   * The UNIQUE constraint (commit ce70623) prevents future duplicates, but existing
   * prod data may have multiple rows for the same (chwId, memberId) pair.
   */
  const deduplicatedSessions = useMemo<SessionData[]>(() => {
    const map = new Map<string, SessionData>();
    for (const session of allSessions) {
      const existing = map.get(session.chwId);
      if (!existing || session.createdAt > existing.createdAt) {
        map.set(session.chwId, session);
      }
    }
    return Array.from(map.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [allSessions]);

  const filteredSessions = useMemo<SessionData[]>(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return deduplicatedSessions;
    return deduplicatedSessions.filter(
      (s) =>
        (s.chwName ?? '').toLowerCase().includes(q) ||
        (s.notes ?? '').toLowerCase().includes(q),
    );
  }, [deduplicatedSessions, searchQuery]);

  // ── Synthetic items filtered by search only (no tab filtering) ───────────────
  const filteredSynthetic = useMemo<SyntheticItem[]>(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return SYNTHETIC_ITEMS;
    return SYNTHETIC_ITEMS.filter(
      (item) =>
        item.sender.toLowerCase().includes(q) ||
        item.preview.toLowerCase().includes(q),
    );
  }, [searchQuery]);

  const hasAnyItems = filteredSessions.length > 0 || filteredSynthetic.length > 0;

  // ── Auto-select thread on load or when chwId route param is present ───────────
  useEffect(() => {
    if (filteredSessions.length === 0) return;

    if (targetCHWId) {
      const match = filteredSessions.find((s) => s.chwId === targetCHWId);
      if (match != null && selectedSession?.id !== match.id) {
        setSelectedSession(match);
        setSelectedSyntheticId(null);
        return;
      }
    }

    if (selectedSession == null) {
      setSelectedSession(filteredSessions[0] ?? null);
      setSelectedSyntheticId(null);
    }
  }, [filteredSessions, selectedSession, targetCHWId]);

  const handleSelectSession = useCallback(
    (session: SessionData) => {
      setSelectedSession(session);
      setSelectedSyntheticId(null);
      if (hideInbox) setShowInbox(false);
    },
    [hideInbox],
  );

  const handleSelectSynthetic = useCallback(
    (id: string, _type: InboxItemType) => {
      setSelectedSyntheticId(id);
      setSelectedSession(null);
      if (hideInbox) setShowInbox(false);
    },
    [hideInbox],
  );

  const handleBack = useCallback(() => {
    setShowInbox(true);
  }, []);

  const handleFindCHW          = useCallback(() => navigation.navigate('FindCHW'),   [navigation]);
  const handleGoToCalendar     = useCallback(() => navigation.navigate('Calendar'),  [navigation]);
  const handleGoToProfile      = useCallback(() => navigation.navigate('Profile'),   [navigation]);
  const handleGoToDocuments    = useCallback(() => navigation.navigate('Documents'), [navigation]);
  const handleGoToRewards      = useCallback(() => navigation.navigate('Rewards'),   [navigation]);
  const handleViewCHWProfile   = useCallback(() => navigation.navigate('FindCHW'),   [navigation]);

  // ── Loading state ─────────────────────────────────────────────────────────────
  if (sessionsQuery.isLoading) {
    return (
      <AppShell role="member" activeKey="messages" userBlock={shellUserBlock} disableMainScroll>
        <PageWrap style={styles.loadingWrap}>
          <LoadingSkeleton variant="card" />
          <LoadingSkeleton variant="rows" rows={4} />
        </PageWrap>
      </AppShell>
    );
  }

  if (sessionsQuery.error) {
    return (
      <AppShell role="member" activeKey="messages" userBlock={shellUserBlock}>
        <PageWrap>
          <ErrorState
            message="Could not load your messages. Please try again."
            onRetry={() => void sessionsQuery.refetch()}
          />
        </PageWrap>
      </AppShell>
    );
  }

  // ── No CHW state ──────────────────────────────────────────────────────────────
  if (allSessions.length === 0) {
    return <NoCHWState onFindCHW={handleFindCHW} userBlock={shellUserBlock} />;
  }

  const shouldShowInbox = !hideInbox || showInbox;
  const shouldShowConv  = !hideInbox || !showInbox;

  // Determine the CHW name for alt pane header
  const activeCHWName = selectedSession?.chwName ?? (allSessions[0]?.chwName ?? 'Your CHW');

  return (
    <AppShell role="member" activeKey="messages" userBlock={shellUserBlock} disableMainScroll>
      <View style={styles.root}>

        {/* ── Left pane: inbox ── */}
        {shouldShowInbox ? (
          <View
            style={[styles.inboxPane, { width: !hideRail ? leftWidth : INBOX_WIDTH }]}
            accessibilityRole="navigation"
            accessibilityLabel="Message inbox"
          >
            {/* Paused banner (refused services) */}
            {servicesRefused ? (
              <View style={styles.pausedBanner} accessibilityRole="alert">
                <AlertCircle size={14} color={colors.amber700} />
                <Text style={styles.pausedBannerText}>
                  Messages paused — restore consent to resume
                </Text>
              </View>
            ) : null}

            {/* Inbox header */}
            <View style={styles.inboxHeader}>
              <Text style={styles.inboxTitle}>Inbox</Text>
              <Text style={styles.inboxSubtitle}>Messages from your care team</Text>
              {/* Search */}
              <View style={styles.inboxSearch}>
                <Search size={14} color={colors.textMuted} />
                <TextInput
                  style={styles.inboxSearchInput}
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  placeholder="Search messages..."
                  placeholderTextColor={colors.textMuted}
                  accessibilityLabel="Search messages"
                />
              </View>
            </View>

            {/* Thread list */}
            <ScrollView style={styles.inboxList} showsVerticalScrollIndicator={false}>
              {hasAnyItems ? (
                <StaggerList delayMs={50} durationMs={240}>
                  {/* CHW sessions */}
                  {filteredSessions.map((session) => (
                    <InboxThreadRow
                      key={session.id}
                      session={session}
                      isActive={selectedSession?.id === session.id && selectedSyntheticId === null}
                      unreadCount={0}
                      onSelect={handleSelectSession}
                    />
                  ))}
                  {/* Synthetic items */}
                  {filteredSynthetic.map((item) => (
                    <SyntheticItemRow
                      key={item.id}
                      item={item}
                      isActive={selectedSyntheticId === item.id}
                      onSelect={handleSelectSynthetic}
                    />
                  ))}
                </StaggerList>
              ) : (
                <EmptyState
                  icon={MessageSquare}
                  title="Your inbox is quiet for now"
                  body="Messages from your CHW and Compass appear here"
                />
              )}
            </ScrollView>
          </View>
        ) : null}

        {/* ── Divider: inbox ↔ conversation ── */}
        {shouldShowInbox && shouldShowConv ? (
          <ResizableDivider
            width={leftWidth}
            onChange={handleLeftWidthChange}
            min={LEFT_MIN}
            max={LEFT_MAX}
          />
        ) : null}

        {/* ── Center pane: conversation or alt detail ── */}
        {shouldShowConv ? (
          selectedSession != null ? (
            <ConversationPane
              key={selectedSession.id}
              session={selectedSession}
              memberFirstName={memberFirstName}
              onBack={handleBack}
              showBackButton={hideInbox}
              autoCallOnMount={
                shouldAutoCall &&
                !autoCallFiredRef.current &&
                selectedSession.chwId === targetCHWId
              }
              onAutoCallConsumed={() => { autoCallFiredRef.current = true; }}
              servicesRefused={servicesRefused}
              onGoToProfile={handleGoToProfile}
              onGoToCalendar={handleGoToCalendar}
              onViewCHWProfile={handleViewCHWProfile}
            />
          ) : selectedSyntheticId !== null ? (
            <View style={styles.convPane}>
              {/* Alt pane shares the conversation header style */}
              <View style={styles.convHeader} accessibilityRole="banner">
                {hideInbox ? (
                  <TouchableOpacity
                    onPress={handleBack}
                    style={styles.backBtn}
                    accessibilityRole="button"
                    accessibilityLabel="Back to inbox"
                  >
                    <ArrowLeft size={20} color={colors.textSecondary} />
                  </TouchableOpacity>
                ) : null}
                <View style={styles.convHeaderInfo}>
                  <Text style={styles.convHeaderName}>
                    {SYNTHETIC_ITEMS.find((i) => i.id === selectedSyntheticId)?.sender ?? 'Compass'}
                  </Text>
                  <Text style={styles.convHeaderStatus}>
                    {selectedSyntheticId === 'appointment-1' ? 'Thursday, June 12 · 2 PM'
                      : selectedSyntheticId === 'document-1' ? 'Action required'
                      : selectedSyntheticId === 'reward-1'   ? '25 points earned'
                      : 'Automated notification'}
                  </Text>
                </View>
              </View>
              <AltPane
                selectedSyntheticId={selectedSyntheticId}
                chwName={activeCHWName}
                onSchedule={handleGoToCalendar}
                onGoToDocuments={handleGoToDocuments}
                onGoToRewards={handleGoToRewards}
              />
            </View>
          ) : (
            <View style={styles.noSelectionWrap}>
              <MessageSquare size={32} color={colors.textMuted} />
              <Text style={styles.noSelectionText}>Select a thread to start messaging</Text>
            </View>
          )
        ) : null}

        {/* ── Divider: conversation ↔ rail ── */}
        {!hideRail && (selectedSession != null || selectedSyntheticId !== null) ? (
          <ResizableDivider
            width={rightWidth}
            onChange={handleRightWidthChange}
            min={RIGHT_MIN}
            max={RIGHT_MAX}
            side="right"
          />
        ) : null}

        {/* ── Right pane: care context rail ── */}
        {!hideRail ? (
          <CareContextRail
            session={selectedSession ?? allSessions[0]!}
            memberId={memberId}
            memberFirstName={memberFirstName}
            onSchedule={handleGoToCalendar}
            onViewCHWProfile={handleViewCHWProfile}
            onViewProfile={handleGoToProfile}
            onGoToRewards={handleGoToRewards}
            style={{ width: rightWidth }}
          />
        ) : null}

      </View>
    </AppShell>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

/** Marigold design token values (used inline — not from theme to keep it explicit). */
const MARIGOLD    = '#F2B33D';
const MARIGOLD_BG = '#fef9c3';

const styles = StyleSheet.create({

  // ── Root ────────────────────────────────────────────────────────────────────
  root: {
    flex: 1,
    flexDirection: 'row',
    backgroundColor: colors.pageBg,
    overflow: 'hidden',
  } as ViewStyle,

  loadingWrap: {
    padding: spacing.xxl,
    gap: spacing.lg,
    flex: 1,
  } as ViewStyle,

  // ── Left pane: inbox ─────────────────────────────────────────────────────────
  inboxPane: {
    width: INBOX_WIDTH,
    flexShrink: 0,
    backgroundColor: colors.cardBg,
    borderRightWidth: 1,
    borderRightColor: colors.cardBorder,
    flexDirection: 'column',
  } as ViewStyle,

  // Paused banner
  pausedBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    backgroundColor: colors.amber100,
    borderBottomWidth: 1,
    borderBottomColor: '#fcd34d',
  } as ViewStyle,
  pausedBannerText: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.amber700,
  } as TextStyle,

  // Inbox header
  inboxHeader: {
    padding: spacing.lg,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
    gap: spacing.sm,
    position: 'relative',
  } as ViewStyle,
  inboxTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.textPrimary,
  } as TextStyle,
  inboxSubtitle: {
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 2,
  } as TextStyle,
  inboxSearch: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.pageBg,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    marginTop: spacing.sm,
  } as ViewStyle,
  inboxSearchInput: {
    flex: 1,
    fontSize: 13,
    color: colors.textPrimary,
    outlineStyle: 'none',
  } as unknown as TextStyle,

  // Thread list scroll
  inboxList: {
    flex: 1,
  } as ViewStyle,

  // Thread row (shared by CHW + synthetic)
  threadRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderRadius: 0,
    borderWidth: 0,
    borderLeftWidth: 3,
    borderLeftColor: 'transparent',
    // Override PressableCard defaults for list context
    backgroundColor: colors.cardBg,
  } as ViewStyle,
  threadRowActive: {
    backgroundColor: '#f0fdf4',
    borderLeftColor: colors.primary,
  } as ViewStyle,
  threadActiveBar: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 3,
    backgroundColor: colors.primary,
    borderRadius: 0,
  } as ViewStyle,

  // Avatars
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
  threadAvatarSystem: {
    backgroundColor: colors.gray100,
  } as ViewStyle,
  threadAvatarAppointment: {
    backgroundColor: colors.emerald100,
  } as ViewStyle,
  threadAvatarDocument: {
    backgroundColor: colors.amber100,
  } as ViewStyle,
  threadAvatarReward: {
    backgroundColor: MARIGOLD_BG,
  } as ViewStyle,

  // Thread body
  threadBody: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  } as ViewStyle,
  threadTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 4,
  } as ViewStyle,
  threadSender: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textPrimary,
    flex: 1,
    minWidth: 0,
  } as TextStyle,
  threadSenderUnread: {
    fontWeight: '700',
  } as TextStyle,
  threadTime: {
    fontSize: 11,
    color: colors.textSecondary,
    flexShrink: 0,
  } as TextStyle,
  threadPreview: {
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 16,
  } as TextStyle,
  threadPillRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: 4,
  } as ViewStyle,

  // Marigold pill (not in 6-hue Pill component — rendered as plain View)
  marigoldPill: {
    alignSelf: 'flex-start',
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
    backgroundColor: MARIGOLD_BG,
  } as ViewStyle,
  marigoldPillText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#92400e',
  } as TextStyle,

  // Unread badge
  unreadBadge: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  } as ViewStyle,
  unreadBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#fff',
  } as TextStyle,

  // ── Center pane ───────────────────────────────────────────────────────────────
  convPane: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'column',
    backgroundColor: colors.pageBg,
    overflow: 'hidden',
  } as ViewStyle,

  // Sticky header
  convHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    paddingVertical: 12,
    backgroundColor: colors.cardBg,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
    ...(shadows.card as object),
    flexShrink: 0,
  } as ViewStyle,

  backBtn: {
    padding: 6,
    borderRadius: radius.sm,
    marginRight: 4,
  } as ViewStyle,

  convAvatarWrap: {
    position: 'relative',
    flexShrink: 0,
  } as ViewStyle,
  convAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  convAvatarText: {
    fontSize: 14,
    fontWeight: '700',
  } as TextStyle,
  onlineDot: {
    position: 'absolute',
    bottom: 1,
    right: 1,
    width: 11,
    height: 11,
    borderRadius: 6,
    backgroundColor: colors.primary,
    borderWidth: 2,
    borderColor: colors.cardBg,
  } as ViewStyle,

  convHeaderInfo: {
    flex: 1,
    minWidth: 0,
    gap: 1,
  } as ViewStyle,
  convHeaderName: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.textPrimary,
    lineHeight: 20,
  } as TextStyle,
  convHeaderStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  } as ViewStyle,
  convHeaderStatus: {
    fontSize: 12,
    color: colors.textSecondary,
  } as TextStyle,
  convActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  } as ViewStyle,
  // Card-style icon button — matches CHW iconBtnCard exactly:
  // padding gives ~40×40 tap target; border + white bg make it a visible chip.
  iconBtnCard: {
    padding: spacing.sm,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    backgroundColor: colors.cardBg,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  iconBtnDisabled: {
    opacity: 0.5,
  } as ViewStyle,

  // Welcome strip
  welcomeStrip: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
    backgroundColor: colors.cardBg,
    flexShrink: 0,
  } as ViewStyle,
  welcomeMain: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.textPrimary,
  } as TextStyle,
  welcomeSub: {
    fontSize: 14,
    fontStyle: 'italic',
    color: colors.textSecondary,
    marginTop: 2,
  } as TextStyle,

  // Messages scroll
  messagesScroll: {
    flex: 1,
    backgroundColor: colors.pageBg,
  } as ViewStyle,
  messagesContent: {
    padding: spacing.xl,
    gap: 4,
  } as ViewStyle,

  // Day separator
  daySepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginVertical: spacing.md,
  } as ViewStyle,
  daySepLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#e5e7eb',
  } as ViewStyle,
  daySepText: {
    fontSize: 11,
    color: colors.textSecondary,
  } as TextStyle,

  // Message bubbles
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
    backgroundColor: colors.emerald100,
    borderRadius: 16,
    borderBottomRightRadius: 4,
  } as ViewStyle,
  bubbleThem: {
    backgroundColor: colors.cardBg,
    borderRadius: 16,
    borderBottomLeftRadius: 4,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    ...(shadows.card as object),
  } as ViewStyle,
  bubbleText: {
    fontSize: 13,
    lineHeight: 20,
  } as TextStyle,
  bubbleTextMe: {
    color: colors.emerald700,
  } as TextStyle,
  bubbleTextThem: {
    color: colors.textPrimary,
  } as TextStyle,
  bubbleTime: {
    fontSize: 10,
    marginTop: 2,
  } as TextStyle,
  bubbleTimeMe: {
    color: colors.textSecondary,
    textAlign: 'right',
  } as TextStyle,
  bubbleTimeThem: {
    color: colors.textMuted,
  } as TextStyle,
  attachmentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  } as ViewStyle,
  seenText: {
    fontSize: 11,
    color: colors.textMuted,
    textAlign: 'right',
    paddingRight: 4,
    marginTop: 2,
  } as TextStyle,

  // Quick reactions — wrapping row so all 4 chips are always fully visible.
  // Falls to 2-row layout when the conversation pane is narrow.
  quickReactionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: spacing.xl,
    paddingVertical: 10,
    backgroundColor: colors.cardBg,
    borderTopWidth: 1,
    borderTopColor: colors.cardBorder,
    flexShrink: 0,
  } as ViewStyle,
  reactionChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    backgroundColor: '#ffffff',
  } as ViewStyle,
  reactionChipText: {
    fontSize: 13.5,
    fontWeight: '500',
    color: colors.textPrimary,
  } as TextStyle,

  // Composer
  composerWrap: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    paddingBottom: spacing.md,
    backgroundColor: colors.cardBg,
    borderTopWidth: 1,
    borderTopColor: colors.cardBorder,
    flexShrink: 0,
  } as ViewStyle,
  composerBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.cardBg,
    borderWidth: 1.5,
    borderColor: colors.cardBorder,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.sm,
    paddingVertical: 8,
  } as ViewStyle,
  composerIcons: {
    flexDirection: 'row',
    gap: 2,
  } as ViewStyle,
  composerIconBtn: {
    width: 30,
    height: 30,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  composerInput: {
    flex: 1,
    fontSize: 14,
    color: colors.textPrimary,
    outlineStyle: 'none',
    minHeight: 22,
    maxHeight: 80,
  } as unknown as TextStyle,
  sendBtn: {
    width: 34,
    height: 34,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,
  sendBtnDisabled: {
    opacity: 0.35,
  } as ViewStyle,
  composerCaption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 5,
    gap: spacing.sm,
  } as ViewStyle,
  composerCaptionText: {
    fontSize: 11,
    color: colors.textMuted,
    flex: 1,
  } as TextStyle,
  charCount: {
    fontSize: 11,
    color: colors.textMuted,
    flexShrink: 0,
  } as TextStyle,

  // Alt pane (non-CHW detail view)
  altScroll: {
    flex: 1,
    backgroundColor: colors.pageBg,
  } as ViewStyle,
  altContent: {
    padding: spacing.xl,
    alignItems: 'center',
  } as ViewStyle,
  altCard: {
    padding: spacing.xxl,
    width: '100%',
    maxWidth: 480,
  } as ViewStyle,
  altCardTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 4,
  } as TextStyle,
  altCardSub: {
    fontSize: 13,
    color: colors.textSecondary,
    marginBottom: spacing.lg,
  } as TextStyle,
  altRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
  } as ViewStyle,
  altRowStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  } as ViewStyle,
  altRowLabel: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textPrimary,
    width: 130,
    flexShrink: 0,
  } as TextStyle,
  altRowValue: {
    fontSize: 13,
    color: colors.textSecondary,
    flex: 1,
  } as TextStyle,
  altBtns: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.lg,
  } as ViewStyle,
  altBtnOutlined: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.sm,
    borderWidth: 1.5,
    borderColor: colors.cardBorder,
    backgroundColor: colors.cardBg,
  } as ViewStyle,
  altBtnOutlinedText: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.textPrimary,
  } as TextStyle,
  altBtnGhost: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
  } as ViewStyle,
  altBtnGhostText: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.primary,
  } as TextStyle,
  altUploadArea: {
    marginTop: spacing.lg,
    padding: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: colors.cardBorder,
    backgroundColor: colors.pageBg,
    alignItems: 'center',
    gap: spacing.sm,
  } as ViewStyle,
  altUploadText: {
    fontSize: 13,
    color: colors.textSecondary,
  } as TextStyle,

  // Reward alt pane
  rewardAltCard: {
    width: '100%',
    maxWidth: 480,
    backgroundColor: MARIGOLD_BG,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: '#fcd34d',
    padding: spacing.xxxl,
    alignItems: 'center',
    gap: spacing.md,
  } as ViewStyle,
  rewardAltIconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: MARIGOLD,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  rewardAltTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#78350f',
    textAlign: 'center',
  } as TextStyle,
  rewardAltSub: {
    fontSize: 14,
    color: '#78350f',
    textAlign: 'center',
  } as TextStyle,
  rewardAltTotal: {
    fontSize: 13,
    color: '#92400e',
    textAlign: 'center',
    lineHeight: 20,
  } as TextStyle,
  rewardAltBold: {
    fontWeight: '700',
  } as TextStyle,
  rewardAltBtn: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.xl,
    paddingVertical: 10,
    borderRadius: radius.md,
    backgroundColor: MARIGOLD,
    alignItems: 'center',
  } as ViewStyle,
  rewardAltBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#78350f',
  } as TextStyle,

  // No selection
  noSelectionWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.pageBg,
  } as ViewStyle,
  noSelectionText: {
    fontSize: 14,
    color: colors.textMuted,
    textAlign: 'center',
  } as TextStyle,

  // ── Right rail ────────────────────────────────────────────────────────────────
  // railOuter is the sizing container — it receives the dynamic width + flexShrink.
  // railScroll fills it with flex:1 so the ScrollView never dictates its own width.
  // This mirrors the CHW screen's railWrap + railOuter two-layer pattern exactly.
  railOuter: {
    width: RAIL_WIDTH,
    flexShrink: 0,
    backgroundColor: colors.cardBg,
    borderLeftWidth: 1,
    borderLeftColor: colors.cardBorder,
    overflow: 'hidden',
  } as ViewStyle,
  railScroll: {
    flex: 1,
  } as ViewStyle,
  railContent: {
    // no gap — the ONE card fills the rail
  } as ViewStyle,
  railHeader: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
    flexShrink: 0,
  } as ViewStyle,
  railHeaderLabel: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.7,
    textTransform: 'uppercase',
    color: colors.textSecondary,
  } as TextStyle,

  // ONE card — sections divided by borderTop
  railCard: {
    margin: 0,
    borderRadius: 0,
    borderWidth: 0,
    borderTopWidth: 0,
  } as ViewStyle,

  railSection: {
    padding: spacing.lg,
  } as ViewStyle,
  railSectionDivider: {
    borderTopWidth: 1,
    borderTopColor: colors.cardBorder,
  } as ViewStyle,
  railSectionLast: {
    // last section has no bottom border
  } as ViewStyle,
  railSectionLabel: {
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: colors.textSecondary,
    marginBottom: spacing.sm,
  } as TextStyle,

  // Journey
  journeyName: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: spacing.md,
  } as TextStyle,
  roadmap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 0,
    marginBottom: spacing.sm,
    overflow: 'visible',
  } as ViewStyle,
  journeyStats: {
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 6,
  } as TextStyle,
  marigoldHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 4,
  } as ViewStyle,
  marigoldHintText: {
    fontSize: 11,
    fontWeight: '600',
    color: MARIGOLD,
  } as TextStyle,
  // Shared items
  sharedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 7,
    borderRadius: radius.md,
    borderWidth: 0,
    backgroundColor: 'transparent',
  } as ViewStyle,
  sharedIconCircle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.emerald100,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,
  sharedLabel: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.textPrimary,
    flex: 1,
  } as TextStyle,
  sharedTime: {
    fontSize: 11,
    color: colors.textMuted,
    flexShrink: 0,
  } as TextStyle,
  viewAllRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 2,
    marginTop: spacing.xs,
  } as ViewStyle,
  viewAllText: {
    fontSize: 12,
    color: colors.primary,
  } as TextStyle,

  // CHW knows
  knowsList: {
    gap: 4,
    marginBottom: spacing.sm,
  } as ViewStyle,
  knowsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 4,
  } as ViewStyle,
  knowsText: {
    fontSize: 12,
    color: colors.textPrimary,
  } as TextStyle,
  knowsCaption: {
    fontSize: 11,
    color: colors.textSecondary,
    lineHeight: 16,
    marginTop: spacing.sm,
  } as TextStyle,
  knowsProfileLink: {
    fontSize: 12,
    color: colors.primary,
    marginTop: 4,
  } as TextStyle,

  // Appointment
  apptRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  } as ViewStyle,
  apptIconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.emerald100,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,
  apptTime: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary,
  } as TextStyle,
  apptLocation: {
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: 2,
  } as TextStyle,
  apptBtns: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
    alignItems: 'center',
  } as ViewStyle,
  apptBtnOutlined: {
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    borderRadius: radius.sm,
    borderWidth: 1.5,
    borderColor: colors.cardBorder,
    backgroundColor: colors.cardBg,
  } as ViewStyle,
  apptBtnOutlinedText: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.textPrimary,
  } as TextStyle,
  apptBtnGhost: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 4,
    paddingVertical: 5,
  } as ViewStyle,
  apptBtnGhostText: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.primary,
  } as TextStyle,

  // Reward card (marigold — ONLY marigold in rail)
  rewardCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: MARIGOLD_BG,
    borderWidth: 0,
  } as ViewStyle,
  rewardIconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: MARIGOLD,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,
  rewardCardText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#78350f',
  } as TextStyle,
  rewardCardSub: {
    fontSize: 11,
    color: '#92400e',
    marginTop: 2,
  } as TextStyle,

  // ── No-CHW state ──────────────────────────────────────────────────────────────
  noCHWWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
});

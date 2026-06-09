/**
 * MemberMessagesScreen — 3-pane messaging screen for members.
 *
 * Layout (web, ≥960px):
 *   [Thread list 280px] | [Conversation pane flex] | [Context rail 260px]
 *
 * Responsive collapse:
 *   <960px  → right rail hidden; thread list + conversation visible
 *   <640px  → conversation-only; back button reveals thread list
 *
 * Panes:
 *   Left   — thread list showing each member↔CHW session as a row with
 *             unread badge; filtered by route.params.chwId when present.
 *   Center — active conversation (messages + quick replies + composer).
 *             Composer is hidden when member has refused services.
 *   Right  — member-side context rail: CHW info (photo/name/specializations),
 *             member journey progress, "Schedule next session" CTA.
 *
 * Route param consumption (PRESERVED from #15 / 2026-06-03):
 *   route.params.chwId     — pre-selects the thread for this CHW's session.
 *   route.params.autoCall  — fires the masked-number call on mount.
 *
 * Services consent gate (T03 / commit 20a0e23):
 *   GET /api/v1/member/services-consent is called on mount.
 *   If status === 'refuse_services', the composer is hidden and a status
 *   banner is shown above the thread: "You have refused services — to message
 *   your CHW, restore consent from your Profile."
 *   Feature-flagged with 503-fallback (SERVICES_CONSENT_FEATURE_ENABLED) so
 *   the UI never crashes if the migration has not been applied yet.
 *
 * Hard constraints:
 *   - Do NOT claim TLS+at-rest is E2E encryption.
 *   - Do NOT import from theme/colors — use theme/tokens only.
 *   - Do NOT modify backend calls other than adding the consent gate read.
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
  CalendarPlus,
  Paperclip,
  Send,
  Lock,
  MessageSquare,
  CheckCircle,
  XCircle,
  ArrowLeft,
  Search,
  AlertCircle,
  MapPin,
  Star,
  Clock,
  User,
} from 'lucide-react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';

import type { MemberTabParamList } from '../../navigation/MemberTabNavigator';
import { AppShell, Card, PageWrap, SectionHeader, Pill } from '../../components/ui';
import { colors, spacing, radius } from '../../theme/tokens';
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

// ─── Breakpoints ──────────────────────────────────────────────────────────────

/** Right context rail hidden below this viewport width. */
const BP_HIDE_RAIL = 960;
/** Thread list hidden below this viewport width (mobile-web). */
const BP_HIDE_LIST = 640;

// ─── Quick replies ────────────────────────────────────────────────────────────

const QUICK_REPLIES = [
  'Yes, that works',
  'Can we reschedule?',
  'I have a question',
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
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  if (diffDays === 1) return 'Yesterday';
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
  /** True when the message was sent by the member (current user). */
  isMe: boolean;
}

function MessageBubble({ message, isMe }: BubbleProps): React.JSX.Element {
  return (
    <View style={isMe ? styles.bubbleRowMe : styles.bubbleRowThem}>
      <View style={[styles.bubble, isMe ? styles.bubbleMe : styles.bubbleThem]}>
        {message.attachment != null ? (
          <View style={styles.attachmentRow}>
            <Paperclip size={14} color={isMe ? '#fff' : colors.textPrimary} />
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
          {message.status === 'failed' ? ' · Failed to send' : ''}
        </Text>
      </View>
    </View>
  );
}

// ─── Inline toast ─────────────────────────────────────────────────────────────

interface InlineToastProps {
  message: string;
  isError: boolean;
}

/**
 * Transient success/error strip rendered below the conversation header.
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
    marginBottom: 4,
    marginTop: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: radius.md,
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

// ─── Services-consent banner ──────────────────────────────────────────────────

/**
 * Shown instead of the composer when the member has status 'refuse_services'.
 * Directs them to MemberProfileScreen to restore consent.
 */
function ServicesConsentBanner({
  onGoToProfile,
}: {
  onGoToProfile: () => void;
}): React.JSX.Element {
  return (
    <View style={consentBannerStyles.refuseContainer} accessibilityRole="alert">
      <AlertCircle size={16} color={consentBannerStyles.refuseIcon.color} />
      <View style={consentBannerStyles.refuseTextBlock}>
        <Text style={consentBannerStyles.refuseTitle}>
          You have refused services
        </Text>
        <Text style={consentBannerStyles.refuseBody}>
          To message your CHW, restore consent from your Profile.
        </Text>
      </View>
      <TouchableOpacity
        style={consentBannerStyles.refuseBtn}
        onPress={onGoToProfile}
        accessibilityRole="button"
        accessibilityLabel="Go to Profile to restore consent"
      >
        <Text style={consentBannerStyles.refuseBtnText}>Profile →</Text>
      </TouchableOpacity>
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
}

/**
 * Banner shown when the CHW has requested permission to record the session.
 * Mirrors the consent request UI from SessionChat for the member side.
 */
function RecordingConsentBanner({
  chwName,
  isPendingApprove,
  isPendingDeny,
  onAllow,
  onDeny,
}: RecordingConsentBannerProps): React.JSX.Element {
  const chwFirstName = chwName?.split(' ')[0] ?? 'Your CHW';
  const isLoading = isPendingApprove || isPendingDeny;

  return (
    <View style={consentBannerStyles.recordingContainer} accessibilityRole="alert">
      <Text style={consentBannerStyles.recordingMessage}>
        {chwFirstName} has requested permission to record this session for AI notes.
      </Text>
      <View style={consentBannerStyles.recordingActions}>
        <TouchableOpacity
          style={[consentBannerStyles.allowBtn, isLoading && consentBannerStyles.btnDisabled]}
          onPress={onAllow}
          disabled={isLoading}
          accessibilityRole="button"
          accessibilityLabel="Allow recording"
          accessibilityState={{ disabled: isLoading }}
        >
          {isPendingApprove ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <CheckCircle size={14} color="#fff" />
          )}
          <Text style={consentBannerStyles.allowBtnText}>Allow</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[consentBannerStyles.denyBtn, isLoading && consentBannerStyles.btnDisabled]}
          onPress={onDeny}
          disabled={isLoading}
          accessibilityRole="button"
          accessibilityLabel="Deny recording"
          accessibilityState={{ disabled: isLoading }}
        >
          {isPendingDeny ? (
            <ActivityIndicator size="small" color={colors.textPrimary} />
          ) : (
            <XCircle size={14} color={colors.textPrimary} />
          )}
          <Text style={consentBannerStyles.denyBtnText}>Deny</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const consentBannerStyles = StyleSheet.create({
  // Services refuse banner
  refuseContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    marginBottom: 4,
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
  } as ViewStyle,
  refuseIcon: {
    color: '#dc2626',
  },
  refuseTextBlock: {
    flex: 1,
    gap: 2,
  } as ViewStyle,
  refuseTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#dc2626',
    lineHeight: 18,
  } as TextStyle,
  refuseBody: {
    fontSize: 12,
    color: '#9ca3af',
    lineHeight: 16,
  } as TextStyle,
  refuseBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: '#fecaca',
    backgroundColor: '#fff',
  } as ViewStyle,
  refuseBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#dc2626',
  } as TextStyle,

  // Recording consent banner
  recordingContainer: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    marginBottom: 4,
    padding: 14,
    borderRadius: radius.lg,
    backgroundColor: '#fefce8',
    borderWidth: 1,
    borderColor: '#fde68a',
    gap: 10,
  } as ViewStyle,
  recordingMessage: {
    fontSize: 14,
    color: colors.amber800,
    lineHeight: 20,
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
    paddingVertical: 8,
    borderRadius: radius.sm,
  } as ViewStyle,
  allowBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#fff',
  } as TextStyle,
  denyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: colors.gray100,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  } as ViewStyle,
  denyBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary,
  } as TextStyle,
  btnDisabled: {
    opacity: 0.6,
  } as ViewStyle,
});

// ─── Thread row (left pane) ───────────────────────────────────────────────────

interface ThreadRowProps {
  session: SessionData;
  isActive: boolean;
  unreadCount: number;
  onSelect: (session: SessionData) => void;
}

/**
 * A single row in the left thread list.
 * Shows CHW name, last-message preview, timestamp, and unread badge.
 */
function ThreadRow({
  session,
  isActive,
  unreadCount,
  onSelect,
}: ThreadRowProps): React.JSX.Element {
  const name = session.chwName ?? 'Unknown CHW';
  const initials = getInitials(name);
  const { bg, text } = avatarColors(name);
  const ts = formatThreadTime(session.createdAt);

  return (
    <TouchableOpacity
      onPress={() => onSelect(session)}
      style={[styles.threadRow, isActive && styles.threadRowActive]}
      accessibilityRole="button"
      accessibilityLabel={`Thread with ${name}${unreadCount > 0 ? `, ${unreadCount} unread` : ''}`}
      accessibilityState={{ selected: isActive }}
    >
      <View style={[styles.threadAvatar, { backgroundColor: bg }]}>
        <Text style={[styles.threadAvatarText, { color: text }]}>{initials}</Text>
      </View>
      <View style={styles.threadInfo}>
        <View style={styles.threadTopRow}>
          <Text style={[styles.threadName, unreadCount > 0 && styles.threadNameUnread]} numberOfLines={1}>
            {name}
          </Text>
          <Text style={styles.threadTime}>{ts}</Text>
        </View>
        <Text style={styles.threadPreview} numberOfLines={1}>
          {session.notes ?? 'No messages yet'}
        </Text>
      </View>
      {unreadCount > 0 ? (
        <View style={styles.unreadBadge} accessibilityLabel={`${unreadCount} unread`}>
          <Text style={styles.unreadBadgeText}>
            {unreadCount > 9 ? '9+' : unreadCount}
          </Text>
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

// ─── No CHW yet state ─────────────────────────────────────────────────────────

interface NoCHWStateProps {
  onFindCHW: () => void;
  userBlock: { initials: string; name: string; role: 'Member' };
}

function NoCHWState({ onFindCHW, userBlock }: NoCHWStateProps): React.JSX.Element {
  return (
    <AppShell role="member" activeKey="messages" userBlock={userBlock}>
      <PageWrap>
        <View style={styles.noCHWWrap}>
          <View style={styles.noCHWIconWrap}>
            <MessageSquare size={32} color={colors.primary} />
          </View>
          <Text style={styles.noCHWTitle}>No CHW assigned yet</Text>
          <Text style={styles.noCHWSub}>
            You don't have a Community Health Worker yet. Find one to start messaging.
          </Text>
          <TouchableOpacity
            style={styles.findCHWBtn}
            onPress={onFindCHW}
            accessibilityRole="button"
            accessibilityLabel="Find a Community Health Worker"
          >
            <Text style={styles.findCHWBtnText}>Find a CHW</Text>
          </TouchableOpacity>
        </View>
      </PageWrap>
    </AppShell>
  );
}

// ─── Context rail (right pane) ────────────────────────────────────────────────

interface ContextRailProps {
  session: SessionData;
  memberId: string;
  onSchedule: () => void;
  onViewCHWProfile: () => void;
}

/**
 * Right pane showing the CHW's info, member's journey progress, and a
 * "Schedule next session" CTA.
 */
function ContextRail({
  session,
  memberId,
  onSchedule,
  onViewCHWProfile,
}: ContextRailProps): React.JSX.Element {
  const chwName = session.chwName ?? 'Your CHW';
  const chwInitials = getInitials(chwName);
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

  const completedSteps = useMemo(
    () => (activeJourney?.steps ?? []).filter((s) => s.status === 'completed').length,
    [activeJourney],
  );
  const totalSteps = (activeJourney?.steps ?? []).length;
  // Use server-computed progressPercent when available; fall back to local calc.
  const progressPct =
    activeJourney?.progressPercent ??
    journeyProgressPercent(totalSteps, completedSteps);

  return (
    <ScrollView
      style={styles.railOuter}
      contentContainerStyle={styles.railContent}
      showsVerticalScrollIndicator={false}
      accessibilityRole="complementary"
      accessibilityLabel="CHW and journey context"
    >
      {/* CHW Info card */}
      <Card style={styles.railCard}>
        <SectionHeader title="Your CHW" marginBottom={spacing.md} />
        <TouchableOpacity
          style={styles.chwInfoRow}
          onPress={onViewCHWProfile}
          accessibilityRole="button"
          accessibilityLabel={`View ${chwName}'s profile`}
        >
          <View style={[styles.chwAvatar, { backgroundColor: bg }]}>
            <Text style={[styles.chwAvatarText, { color: text }]}>{chwInitials}</Text>
          </View>
          <View style={styles.chwInfoText}>
            <Text style={styles.chwName}>{chwName}</Text>
            {session.vertical != null && session.vertical.length > 0 ? (
              <Pill variant="emerald" size="sm">{session.vertical.replace('_', ' ')}</Pill>
            ) : (
              <Text style={styles.chwSubLabel}>Community Health Worker</Text>
            )}
          </View>
        </TouchableOpacity>

        <View style={styles.chwMetaRow}>
          <Clock size={13} color={colors.textSecondary} />
          <Text style={styles.chwMetaText}>Typically replies within 2 hours</Text>
        </View>
        <View style={styles.chwMetaRow}>
          <User size={13} color={colors.textSecondary} />
          <Text style={styles.chwMetaText}>
            {session.mode != null
              ? session.mode.replace('_', ' ')
              : 'In-person + Telehealth'}
          </Text>
        </View>

        <TouchableOpacity
          style={styles.viewProfileBtn}
          onPress={onViewCHWProfile}
          accessibilityRole="link"
          accessibilityLabel={`View ${chwName}'s full profile`}
        >
          <Text style={styles.viewProfileBtnText}>View full profile →</Text>
        </TouchableOpacity>
      </Card>

      {/* Journey progress card */}
      <Card style={styles.railCard}>
        <SectionHeader title="My Journey" marginBottom={spacing.md} />
        {journeysQuery.isLoading ? (
          <LoadingSkeleton variant="rows" rows={2} />
        ) : activeJourney != null ? (
          <>
            <Text style={styles.journeyTemplateName} numberOfLines={2}>
              {activeJourney.template?.name ?? 'Active Journey'}
            </Text>
            <View style={styles.progressRow}>
              <View
                style={styles.progressBar}
                accessibilityRole="progressbar"
                accessibilityValue={{ min: 0, max: 100, now: progressPct }}
              >
                <View style={[styles.progressFill, { width: `${progressPct}%` as `${number}%` }]} />
              </View>
              <Text style={styles.progressPct}>{progressPct}%</Text>
            </View>
            <Text style={styles.progressDetail}>
              {completedSteps} of {totalSteps} steps completed
            </Text>
            {activeJourney.currentStep != null ? (
              <View style={styles.currentStepRow}>
                <MapPin size={12} color={colors.primary} />
                <Text style={styles.currentStepText} numberOfLines={2}>
                  Current: {activeJourney.currentStep.stepName}
                </Text>
              </View>
            ) : null}
          </>
        ) : (
          <Text style={styles.noJourneyText}>No active journey yet.</Text>
        )}
      </Card>

      {/* Schedule next session CTA */}
      <Card style={[styles.railCard, styles.scheduleCard]}>
        <View style={styles.scheduleIconWrap}>
          <CalendarPlus size={20} color={colors.primary} />
        </View>
        <Text style={styles.scheduleTitle}>Schedule next session</Text>
        <Text style={styles.scheduleBody}>
          Book your next appointment with {chwName.split(' ')[0] ?? 'your CHW'} directly from the calendar.
        </Text>
        <TouchableOpacity
          style={styles.scheduleBtn}
          onPress={onSchedule}
          accessibilityRole="button"
          accessibilityLabel="Schedule next session"
        >
          <CalendarPlus size={14} color="#fff" />
          <Text style={styles.scheduleBtnText}>Schedule</Text>
        </TouchableOpacity>
      </Card>

      {/* Star rating reminder */}
      {session.status === 'completed' ? (
        <Card style={styles.railCard}>
          <View style={styles.ratingRow}>
            {[1, 2, 3, 4, 5].map((n) => (
              <Star key={n} size={18} color={colors.amber700} />
            ))}
          </View>
          <Text style={styles.ratingPrompt}>Rate your last session with {chwName.split(' ')[0] ?? 'your CHW'}.</Text>
        </Card>
      ) : null}
    </ScrollView>
  );
}

// ─── Conversation pane (center) ───────────────────────────────────────────────

interface ConversationPaneProps {
  session: SessionData;
  onBack?: () => void;
  showBackButton: boolean;
  /** When true, fire the masked-number call sequence on mount (one-shot). */
  autoCallOnMount?: boolean;
  /** Called after the auto-call fires (or fails) to ack the one-shot. */
  onAutoCallConsumed?: () => void;
  /** True when the member has refused services — hides the composer. */
  servicesRefused: boolean;
  onGoToProfile: () => void;
}

function ConversationPane({
  session,
  onBack,
  showBackButton,
  autoCallOnMount,
  onAutoCallConsumed,
  servicesRefused,
  onGoToProfile,
}: ConversationPaneProps): React.JSX.Element {
  const { userName } = useAuth();
  const navigation = useNavigation<any>(); // eslint-disable-line @typescript-eslint/no-explicit-any

  const [draftText, setDraftText] = useState('');
  const [localMessages, setLocalMessages] = useState<SessionMessageLocal[]>([]);
  const [callInitiating, setCallInitiating] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [toastIsError, setToastIsError] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  const chwName = session.chwName ?? 'Your CHW';
  const chwInitials = getInitials(chwName);
  const { bg, text } = avatarColors(chwName);

  const messagesQuery = useSessionMessages(session.id);
  const sendMessage = useSessionSendMessage();
  const startCall = useStartCall();
  const approveConsentRequest = useApproveConsentRequest();
  const denyConsentRequest = useDenyConsentRequest();

  // Poll for recording consent requests while the session is in-progress.
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
  /**
   * Initiates a Vonage masked-number call between member and their assigned CHW.
   * Shows a confirmation prompt first, then disables the button while in flight.
   */
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
  // Fires the call sequence immediately when autoCallOnMount is true.
  // The member already confirmed intent on the previous screen — no second prompt.
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
      await approveConsentRequest.mutateAsync({
        requestId: pendingConsent.id,
        typedSignature: userName ?? 'Member',
      });
      showToast('Recording approved.', false);
    } catch {
      showToast('Could not approve. Please try again.', true);
    }
  }, [pendingConsent, approveConsentRequest, userName, showToast]);

  const handleDenyConsent = useCallback(async () => {
    if (!pendingConsent) return;
    try {
      await denyConsentRequest.mutateAsync(pendingConsent.id);
      showToast('Recording declined.', false);
    } catch {
      showToast('Could not submit response. Please try again.', true);
    }
  }, [pendingConsent, denyConsentRequest, showToast]);

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

  const handleQuickReply = useCallback((text: string) => {
    setDraftText(text);
  }, []);

  const grouped = groupByDay(mergedMessages);

  return (
    <View style={styles.convPane} accessibilityRole="main">
      {/* Conversation header */}
      <View style={styles.convHeader} accessibilityRole="banner">
        {showBackButton && onBack != null ? (
          <TouchableOpacity
            onPress={onBack}
            style={styles.backBtn}
            accessibilityRole="button"
            accessibilityLabel="Back to thread list"
          >
            <ArrowLeft size={20} color={colors.textSecondary} />
          </TouchableOpacity>
        ) : null}

        {/* CHW avatar with online dot */}
        <View style={styles.convAvatarWrap}>
          <View style={[styles.convAvatar, { backgroundColor: bg }]}>
            <Text style={[styles.convAvatarText, { color: text }]}>{chwInitials}</Text>
          </View>
          <View style={styles.onlineDot} accessibilityLabel="Online" />
        </View>

        <View style={styles.convHeaderInfo}>
          <Text style={styles.convHeaderName}>{chwName}</Text>
          <Text style={styles.convHeaderStatus}>Active now · Reply within 2h typically</Text>
        </View>

        {/* Phone button — Vonage masked-number call */}
        <TouchableOpacity
          style={[styles.iconBtn, callInitiating && styles.iconBtnDisabled]}
          onPress={() => void handleCall()}
          disabled={callInitiating}
          accessibilityRole="button"
          accessibilityLabel={callInitiating ? 'Call initiating…' : 'Call your CHW'}
          accessibilityState={{ disabled: callInitiating }}
        >
          {callInitiating ? (
            <ActivityIndicator size="small" color={colors.textSecondary} />
          ) : (
            <Phone size={20} color={colors.textSecondary} />
          )}
        </TouchableOpacity>

        {/* Calendar button — navigate to Appointments tab */}
        <TouchableOpacity
          style={styles.iconBtn}
          onPress={() => navigation.navigate('Calendar')}
          accessibilityRole="button"
          accessibilityLabel="Go to appointments"
        >
          <CalendarPlus size={20} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>

      {/* Inline toast */}
      {toastMessage !== null ? (
        <InlineToast message={toastMessage} isError={toastIsError} />
      ) : null}

      {/* Services refuse banner (above the thread) */}
      {servicesRefused ? (
        <ServicesConsentBanner onGoToProfile={onGoToProfile} />
      ) : null}

      {/* Recording consent request banner */}
      {pendingConsent !== null && !servicesRefused ? (
        <RecordingConsentBanner
          chwName={chwName}
          isPendingApprove={approveConsentRequest.isPending}
          isPendingDeny={denyConsentRequest.isPending}
          onAllow={() => void handleApproveConsent()}
          onDeny={() => void handleDenyConsent()}
        />
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
          <View style={styles.emptyMessages}>
            <MessageSquare size={28} color={colors.textMuted} />
            <Text style={styles.emptyMessagesText}>
              No messages yet. Send a message to get started!
            </Text>
          </View>
        ) : (
          grouped.map(({ key, messages: dayMsgs }) => (
            <View key={key}>
              <View style={styles.dateSeparatorRow}>
                <Text style={styles.dateSeparatorText}>
                  {formatDateSeparator(dayMsgs[0]?.createdAt ?? key)}
                </Text>
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
      </ScrollView>

      {/* Composer area — hidden when services refused */}
      {!servicesRefused ? (
        <>
          {/* Quick replies */}
          <View
            style={styles.quickRepliesBar}
            accessibilityRole="toolbar"
            accessibilityLabel="Quick reply options"
          >
            <Text style={styles.quickRepliesLabel}>Quick:</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.quickRepliesScroll}
            >
              {QUICK_REPLIES.map((reply) => (
                <TouchableOpacity
                  key={reply}
                  style={styles.quickReplyChip}
                  onPress={() => handleQuickReply(reply)}
                  accessibilityRole="button"
                  accessibilityLabel={`Quick reply: ${reply}`}
                >
                  <Text style={styles.quickReplyText}>{reply}</Text>
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
                accessibilityLabel="Attach a file"
              >
                <Paperclip size={20} color={colors.textSecondary} />
              </TouchableOpacity>
              <TextInput
                style={styles.composerInput}
                value={draftText}
                onChangeText={setDraftText}
                placeholder={`Reply to ${chwName}…`}
                placeholderTextColor={colors.textMuted}
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

            {/* HIPAA note — TLS+at-rest only, NOT E2E */}
            <View style={styles.hipaaNote}>
              <Lock size={11} color={colors.textMuted} />
              <Text style={styles.hipaaText}>Messages are encrypted and HIPAA-compliant</Text>
            </View>
          </View>
        </>
      ) : null}
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

type SessionsRoute = RouteProp<MemberTabParamList, 'Sessions'>;

/**
 * MemberMessagesScreen — 3-pane messaging screen for the member role.
 *
 * Exported and wired into MemberTabNavigator as the Sessions tab on web.
 * Reads route.params.chwId + route.params.autoCall to support deep-links
 * from MemberFacingCHWProfileScreen (T24 / commit #15 2026-06-03).
 */
export function MemberMessagesScreen(): React.JSX.Element {
  const { userName } = useAuth();
  const navigation = useNavigation<any>(); // eslint-disable-line @typescript-eslint/no-explicit-any
  const { width } = useWindowDimensions();

  // ── Route params (chwId + autoCall deep-link — PRESERVED) ────────────────────
  const route = useRoute<SessionsRoute>();
  const targetCHWId = route.params?.chwId;
  const shouldAutoCall = route.params?.autoCall === true;
  // One-shot guard — auto-call must only fire once per mount even on re-renders.
  const autoCallFiredRef = useRef(false);

  // ── Responsive breakpoints ────────────────────────────────────────────────────
  const hideRail = width < BP_HIDE_RAIL;
  const hideList = width < BP_HIDE_LIST;

  const [showThreadList, setShowThreadList] = useState(true);
  const [selectedSession, setSelectedSession] = useState<SessionData | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // ── Data ──────────────────────────────────────────────────────────────────────
  const sessionsQuery = useSessions();
  const memberProfileQuery = useMemberProfile();
  const ownConsentQuery = useOwnServicesConsent();

  const memberId = memberProfileQuery.data?.userId ?? '';

  // Services refuse gate: only hard-refuse when we have a confirmed 'refuse_services'
  // response. While loading or on 503-fallback (null data), default to permissive.
  const servicesRefused =
    ownConsentQuery.data?.value === 'refuse_services';

  // ── Shell user block ──────────────────────────────────────────────────────────
  const memberInitials = (userName ?? 'M')
    .split(' ')
    .slice(0, 2)
    .map((p) => p[0] ?? '')
    .join('')
    .toUpperCase();

  const shellUserBlock = {
    initials: memberInitials,
    name: userName ?? 'Member',
    role: 'Member' as const,
  };

  // ── Session list (filtered by search) ────────────────────────────────────────
  const allSessions: SessionData[] = sessionsQuery.data ?? [];

  const filteredSessions = useMemo<SessionData[]>(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return allSessions;
    return allSessions.filter(
      (s) =>
        (s.chwName ?? '').toLowerCase().includes(q) ||
        (s.notes ?? '').toLowerCase().includes(q),
    );
  }, [allSessions, searchQuery]);

  // ── Auto-select thread on load or when chwId route param is present ───────────
  useEffect(() => {
    if (filteredSessions.length === 0) return;

    // chwId deep-link: pre-select the thread whose CHW matches targetCHWId.
    // The session shape carries chwId (populated by the backend as the CHW's user UUID).
    if (targetCHWId) {
      const match = filteredSessions.find((s) => s.chwId === targetCHWId);
      if (match != null && selectedSession?.id !== match.id) {
        setSelectedSession(match);
        return;
      }
    }

    // Default: auto-select first thread when none selected (desktop behaviour).
    if (selectedSession == null) {
      setSelectedSession(filteredSessions[0] ?? null);
    }
  }, [filteredSessions, selectedSession, targetCHWId]);

  const handleSelectSession = useCallback(
    (session: SessionData) => {
      setSelectedSession(session);
      if (hideList) {
        setShowThreadList(false);
      }
    },
    [hideList],
  );

  const handleBack = useCallback(() => {
    setShowThreadList(true);
  }, []);

  const handleFindCHW = useCallback(() => {
    navigation.navigate('FindCHW');
  }, [navigation]);

  const handleGoToCalendar = useCallback(() => {
    navigation.navigate('Calendar');
  }, [navigation]);

  const handleGoToProfile = useCallback(() => {
    navigation.navigate('Profile');
  }, [navigation]);

  const handleViewCHWProfile = useCallback(() => {
    navigation.navigate('FindCHW');
  }, [navigation]);

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

  const shouldShowList = !hideList || showThreadList;
  const shouldShowConv = !hideList || !showThreadList;

  return (
    <AppShell role="member" activeKey="messages" userBlock={shellUserBlock} disableMainScroll>
      <View style={styles.root}>
        {/* ── Left pane: thread list ── */}
        {shouldShowList ? (
          <View style={styles.threadList} accessibilityRole="navigation" accessibilityLabel="Message threads">
            {/* List header */}
            <View style={styles.threadListHeader}>
              <Text style={styles.threadListTitle}>Messages</Text>
              {/* Search */}
              <View style={styles.searchWrap}>
                <View style={styles.searchIconWrap}>
                  <Search size={14} color={colors.textMuted} />
                </View>
                <TextInput
                  style={styles.searchInput}
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  placeholder="Search CHW…"
                  placeholderTextColor={colors.textMuted}
                  accessibilityLabel="Search message threads"
                />
              </View>
            </View>

            {/* Thread rows */}
            <ScrollView style={styles.threadScroll} showsVerticalScrollIndicator={false}>
              {filteredSessions.length === 0 ? (
                <View style={styles.emptyThreads}>
                  <Text style={styles.emptyThreadsText}>No threads found.</Text>
                </View>
              ) : (
                filteredSessions.map((session) => (
                  <ThreadRow
                    key={session.id}
                    session={session}
                    isActive={selectedSession?.id === session.id}
                    unreadCount={0}
                    onSelect={handleSelectSession}
                  />
                ))
              )}
            </ScrollView>
          </View>
        ) : null}

        {/* ── Divider ── */}
        {shouldShowList && shouldShowConv ? (
          <View style={styles.divider} />
        ) : null}

        {/* ── Center pane: conversation ── */}
        {shouldShowConv ? (
          selectedSession != null ? (
            <ConversationPane
              key={selectedSession.id}
              session={selectedSession}
              onBack={handleBack}
              showBackButton={hideList}
              autoCallOnMount={
                shouldAutoCall &&
                !autoCallFiredRef.current &&
                selectedSession.chwId === targetCHWId
              }
              onAutoCallConsumed={() => {
                autoCallFiredRef.current = true;
              }}
              servicesRefused={servicesRefused}
              onGoToProfile={handleGoToProfile}
            />
          ) : (
            <View style={styles.noSelectionWrap}>
              <MessageSquare size={32} color={colors.textMuted} />
              <Text style={styles.noSelectionText}>Select a thread to start messaging</Text>
            </View>
          )
        ) : null}

        {/* ── Right pane: context rail ── */}
        {!hideRail && selectedSession != null ? (
          <>
            <View style={styles.divider} />
            <ContextRail
              session={selectedSession}
              memberId={memberId}
              onSchedule={handleGoToCalendar}
              onViewCHWProfile={handleViewCHWProfile}
            />
          </>
        ) : null}
      </View>
    </AppShell>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const THREAD_LIST_WIDTH = 280;
const CONTEXT_RAIL_WIDTH = 260;

const styles = StyleSheet.create({
  // Root 3-pane container
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

  // ── Left pane: thread list ──────────────────────────────────────────────────
  threadList: {
    width: THREAD_LIST_WIDTH,
    flexShrink: 0,
    backgroundColor: colors.cardBg,
    borderRightWidth: 1,
    borderRightColor: colors.cardBorder,
    flexDirection: 'column',
  } as ViewStyle,

  threadListHeader: {
    padding: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
    gap: spacing.sm,
  } as ViewStyle,

  threadListTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.textPrimary,
  } as TextStyle,

  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.pageBg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    paddingHorizontal: spacing.sm,
    gap: spacing.xs,
  } as ViewStyle,

  searchIconWrap: {
    flexShrink: 0,
  } as ViewStyle,

  searchInput: {
    flex: 1,
    fontSize: 13,
    color: colors.textPrimary,
    paddingVertical: 8,
    outlineStyle: 'none',
  } as unknown as TextStyle,

  threadScroll: {
    flex: 1,
  } as ViewStyle,

  threadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
  } as ViewStyle,

  threadRowActive: {
    backgroundColor: colors.emerald100,
  } as ViewStyle,

  threadAvatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,

  threadAvatarText: {
    fontSize: 13,
    fontWeight: '700',
  } as TextStyle,

  threadInfo: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  } as ViewStyle,

  threadTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  } as ViewStyle,

  threadName: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textPrimary,
    flex: 1,
    minWidth: 0,
  } as TextStyle,

  threadNameUnread: {
    fontWeight: '700',
  } as TextStyle,

  threadTime: {
    fontSize: 11,
    color: colors.textMuted,
    flexShrink: 0,
    marginLeft: spacing.xs,
  } as TextStyle,

  threadPreview: {
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 16,
  } as TextStyle,

  unreadBadge: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
    flexShrink: 0,
  } as ViewStyle,

  unreadBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#fff',
  } as TextStyle,

  emptyThreads: {
    padding: spacing.xxl,
    alignItems: 'center',
  } as ViewStyle,

  emptyThreadsText: {
    fontSize: 13,
    color: colors.textMuted,
    textAlign: 'center',
  } as TextStyle,

  // ── Divider between panes ───────────────────────────────────────────────────
  divider: {
    width: 1,
    backgroundColor: colors.cardBorder,
  } as ViewStyle,

  // ── Center pane: conversation ───────────────────────────────────────────────
  convPane: {
    flex: 1,
    flexDirection: 'column',
    backgroundColor: colors.cardBg,
    overflow: 'hidden',
  } as ViewStyle,

  // Conversation header
  convHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
    backgroundColor: colors.cardBg,
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
    width: 44,
    height: 44,
    borderRadius: 22,
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
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.emerald500,
    borderWidth: 2,
    borderColor: colors.cardBg,
  } as ViewStyle,

  convHeaderInfo: {
    flex: 1,
    minWidth: 0,
    gap: 1,
  } as ViewStyle,

  convHeaderName: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary,
  } as TextStyle,

  convHeaderStatus: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.primary,
  } as TextStyle,

  iconBtn: {
    padding: 8,
    borderRadius: radius.sm,
  } as ViewStyle,

  iconBtnDisabled: {
    opacity: 0.5,
  } as ViewStyle,

  // Messages scroll region
  messagesScroll: {
    flex: 1,
    backgroundColor: colors.pageBg,
  } as ViewStyle,

  messagesContent: {
    padding: spacing.xl,
    gap: 4,
  } as ViewStyle,

  emptyMessages: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingTop: 64,
  } as ViewStyle,

  emptyMessagesText: {
    fontSize: 14,
    color: colors.textMuted,
    textAlign: 'center',
    lineHeight: 20,
  } as TextStyle,

  dateSeparatorRow: {
    alignItems: 'center',
    marginVertical: spacing.md,
  } as ViewStyle,

  dateSeparatorText: {
    fontSize: 11,
    color: colors.textMuted,
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
    backgroundColor: colors.emerald500,
    borderRadius: 18,
    borderBottomRightRadius: 4,
  } as ViewStyle,

  bubbleThem: {
    backgroundColor: colors.gray100,
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
    color: colors.textPrimary,
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
    color: colors.textMuted,
  } as TextStyle,

  attachmentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  } as ViewStyle,

  // Quick replies
  quickRepliesBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.cardBg,
    borderTopWidth: 1,
    borderTopColor: colors.cardBorder,
    gap: spacing.sm,
  } as ViewStyle,

  quickRepliesLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    flexShrink: 0,
  } as TextStyle,

  quickRepliesScroll: {
    flexDirection: 'row',
    gap: spacing.sm,
  } as ViewStyle,

  quickReplyChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    backgroundColor: colors.cardBg,
  } as ViewStyle,

  quickReplyText: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.textSecondary,
  } as TextStyle,

  // Composer
  composerWrap: {
    padding: spacing.md,
    backgroundColor: colors.cardBg,
    borderTopWidth: 1,
    borderTopColor: colors.cardBorder,
  } as ViewStyle,

  composerInner: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    backgroundColor: colors.pageBg,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.xl,
    padding: 10,
  } as ViewStyle,

  composerIconBtn: {
    padding: 6,
    borderRadius: radius.sm,
  } as ViewStyle,

  composerInput: {
    flex: 1,
    fontSize: 14,
    color: colors.textPrimary,
    paddingVertical: 6,
    minHeight: 36,
    maxHeight: 100,
    outlineStyle: 'none',
  } as unknown as TextStyle,

  sendBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.primary,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radius.lg,
  } as ViewStyle,

  sendBtnDisabled: {
    opacity: 0.5,
  } as ViewStyle,

  sendBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#fff',
  } as TextStyle,

  hipaaNote: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    marginTop: spacing.sm,
  } as ViewStyle,

  hipaaText: {
    fontSize: 11,
    color: colors.textMuted,
    textAlign: 'center',
  } as TextStyle,

  // No-selection placeholder (center pane, no thread selected)
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

  // ── No-CHW state ────────────────────────────────────────────────────────────
  noCHWWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
    padding: spacing.xxxl,
  } as ViewStyle,

  noCHWIconWrap: {
    width: 64,
    height: 64,
    borderRadius: radius.xl,
    backgroundColor: colors.emerald100,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,

  noCHWTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.textPrimary,
    textAlign: 'center',
  } as TextStyle,

  noCHWSub: {
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 320,
  } as TextStyle,

  findCHWBtn: {
    marginTop: spacing.sm,
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.lg,
  } as ViewStyle,

  findCHWBtnText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#fff',
  } as TextStyle,

  // ── Right pane: context rail ────────────────────────────────────────────────
  railOuter: {
    width: CONTEXT_RAIL_WIDTH,
    flexShrink: 0,
    backgroundColor: colors.pageBg,
  } as ViewStyle,

  railContent: {
    padding: spacing.lg,
    gap: spacing.md,
  } as ViewStyle,

  railCard: {
    padding: spacing.lg,
  } as ViewStyle,

  // CHW info card
  chwInfoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  } as ViewStyle,

  chwAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,

  chwAvatarText: {
    fontSize: 13,
    fontWeight: '700',
  } as TextStyle,

  chwInfoText: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  } as ViewStyle,

  chwName: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary,
  } as TextStyle,

  chwSubLabel: {
    fontSize: 12,
    color: colors.textSecondary,
  } as TextStyle,

  chwMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: 4,
  } as ViewStyle,

  chwMetaText: {
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 16,
  } as TextStyle,

  viewProfileBtn: {
    marginTop: spacing.sm,
    paddingVertical: 8,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    alignItems: 'center',
  } as ViewStyle,

  viewProfileBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.primary,
  } as TextStyle,

  // Journey progress
  journeyTemplateName: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary,
    marginBottom: spacing.sm,
    lineHeight: 18,
  } as TextStyle,

  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: 4,
  } as ViewStyle,

  progressBar: {
    flex: 1,
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.cardBorder,
    overflow: 'hidden',
  } as ViewStyle,

  progressFill: {
    height: '100%',
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
  } as ViewStyle,

  progressPct: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.primary,
    flexShrink: 0,
  } as TextStyle,

  progressDetail: {
    fontSize: 11,
    color: colors.textSecondary,
    marginBottom: 4,
  } as TextStyle,

  currentStepRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 4,
    marginTop: spacing.xs,
  } as ViewStyle,

  currentStepText: {
    fontSize: 11,
    color: colors.textSecondary,
    flex: 1,
    lineHeight: 15,
  } as TextStyle,

  noJourneyText: {
    fontSize: 13,
    color: colors.textMuted,
    textAlign: 'center',
    paddingVertical: spacing.sm,
  } as TextStyle,

  // Schedule CTA
  scheduleCard: {
    alignItems: 'center',
    gap: spacing.sm,
  } as ViewStyle,

  scheduleIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.emerald100,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,

  scheduleTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary,
    textAlign: 'center',
  } as TextStyle,

  scheduleBody: {
    fontSize: 12,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 17,
  } as TextStyle,

  scheduleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.lg,
    paddingVertical: 8,
    borderRadius: radius.lg,
    marginTop: 4,
  } as ViewStyle,

  scheduleBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#fff',
  } as TextStyle,

  // Star rating
  ratingRow: {
    flexDirection: 'row',
    gap: 4,
    justifyContent: 'center',
    marginBottom: spacing.sm,
  } as ViewStyle,

  ratingPrompt: {
    fontSize: 12,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 17,
  } as TextStyle,
});

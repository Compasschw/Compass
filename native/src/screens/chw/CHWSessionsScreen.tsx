/**
 * CHWSessionsScreen — Session management for CHW users.
 *
 * Features:
 *  - Tab bar: Active (scheduled + in_progress) vs Completed
 *  - Session cards with vertical icon, member name, status badge, date/time, mode
 *  - Active sessions: live timer (MM:SS), consent checkbox before start, Start / Complete actions
 *  - In-progress sessions: Chat button (opens SessionChat modal)
 *  - In-progress sessions: "Call Member (masked)" button — triggers Vonage masked bridge
 *  - Completed sessions: "Document Session" button (opens DocumentationModal)
 *  - Duration, units billed, net earnings on completed sessions
 */

import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { CHWSessionsStackParamList } from '../../navigation/CHWTabNavigator';
import {
  Play,
  CheckCircle,
  Home,
  RefreshCw,
  Utensils,
  Brain,
  Stethoscope,
  Clock,
  DollarSign,
  MessageSquare,
  FileText,
  Phone,
  X,
} from 'lucide-react-native';

import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import {
  formatCurrency,
  sessionModeLabels,
  sessionStatusLabels,
  type SessionStatus,
  type Vertical,
  type SessionDocumentation,
} from '../../data/mock';

// ─── Vertical labels (for "Need" badge per Jemal Sessions feedback) ──────────
const VERTICAL_LABELS: Record<Vertical, string> = {
  housing: 'Housing',
  rehab: 'Rehab',
  food: 'Food',
  mental_health: 'Mental Health',
  healthcare: 'Healthcare',
};

// ─── Member need-journey status (mocked) — see CHWDashboardScreen ────────────
// TODO(backend): expose journey_status per session.
type JourneyStatus = 'starting' | 'awaiting_confirmation' | 'resolved';
const JOURNEY_COLORS: Record<JourneyStatus, string> = {
  starting: '#EF4444',
  awaiting_confirmation: '#F59E0B',
  resolved: '#22C55E',
};
const JOURNEY_LABELS: Record<JourneyStatus, string> = {
  starting: 'Starting',
  awaiting_confirmation: 'Awaiting confirmation',
  resolved: 'Resolved',
};
function mockJourneyStatus(id: string): JourneyStatus {
  const sum = id.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const idx = sum % 3;
  return idx === 0 ? 'starting' : idx === 1 ? 'awaiting_confirmation' : 'resolved';
}

// ─── Active-queue priority order (Jemal: sort by urgency + scheduled time) ──
// Lower number = higher priority. Falls back to scheduledAt for tie-break.
const URGENCY_PRIORITY: Record<string, number> = {
  in_progress: 0,
  urgent: 1,
  soon: 2,
  routine: 3,
};
function urgencyRank(s: SessionData): number {
  if (s.status === 'in_progress') return URGENCY_PRIORITY.in_progress;
  // SessionData doesn't carry urgency directly; the request that spawned it
  // does. Until backend joins it through, fall back to a deterministic mock
  // so the sort is at least stable per session.
  // TODO(backend): expose request.urgency on SessionData (or expose
  // session.priority computed server-side).
  const pseudo = mockJourneyStatus(s.id);
  if (pseudo === 'starting') return URGENCY_PRIORITY.urgent;
  if (pseudo === 'awaiting_confirmation') return URGENCY_PRIORITY.soon;
  return URGENCY_PRIORITY.routine;
}
import { ApiError } from '../../api/client';
import {
  useChwClaims,
  useSessions,
  useStartSession,
  useCompleteSession,
  useSubmitDocumentation,
  type ChwClaim,
  type SessionData,
} from '../../hooks/useApiQueries';
import { useRefreshControl } from '../../hooks/useRefreshControl';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';
import { DocumentationModal } from '../../components/sessions/DocumentationModal';
import { SessionChatWithFollowup } from '../../components/sessions/SessionChatWithFollowup';
import { phone } from '../../services/phone';

// ─── Constants ────────────────────────────────────────────────────────────────

const VERTICAL_COLORS: Record<Vertical, string> = {
  housing: '#3B82F6',
  rehab: '#EF4444',
  food: '#F59E0B',
  mental_health: '#8B5CF6',
  healthcare: '#06B6D4',
};

type BillingStatus = 'pending' | 'submitted' | 'approved' | 'rejected';

const BILLING_STATUS_COLORS: Record<BillingStatus, string> = {
  pending: colors.compassGold,
  submitted: colors.secondary,
  approved: colors.primary,
  rejected: '#DC2626',
};

const BILLING_STATUS_LABELS: Record<BillingStatus, string> = {
  pending: 'Pending',
  submitted: 'Submitted',
  approved: 'Paid',
  rejected: 'Rejected',
};

/**
 * Convert a backend BillingClaim.status string into the local BillingStatus
 * union the badge renders. Mirrors the helper in CHWEarningsScreen so both
 * screens display identical status labels for the same claim.
 */
function mapClaimStatus(claimStatus: string | undefined): BillingStatus {
  switch (claimStatus) {
    case 'submitted':
      return 'submitted';
    case 'paid':
      return 'approved';
    case 'rejected':
      return 'rejected';
    default:
      return 'pending';
  }
}

const SESSION_STATUS_COLORS: Record<SessionStatus, string> = {
  scheduled: colors.secondary,
  in_progress: colors.compassGold,
  completed: colors.primary,
  cancelled: colors.mutedForeground,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Look up a real billing status for a given session by inspecting the
 * /chw/claims response. Falls back to 'pending' when no claim has been
 * filed yet — common for sessions that just completed and whose CHW
 * hasn't submitted documentation. Replaces the hardcoded sess-002/003/004
 * mock map that misled CHWs about the actual lifecycle of their claims.
 */
function lookupBillingStatus(
  sessionId: string,
  claimsBySession: Map<string, ChwClaim>,
): BillingStatus {
  const claim = claimsBySession.get(sessionId);
  return mapClaimStatus(claim?.status);
}

function formatScheduledAt(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Formats elapsed seconds as MM:SS (e.g. 65 to "01:05").
 */
function formatElapsedTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ─── VerticalIcon helper ──────────────────────────────────────────────────────

function VerticalIconComponent({
  vertical,
  size = 20,
}: {
  vertical: Vertical;
  size?: number;
}): React.JSX.Element {
  const iconColor = VERTICAL_COLORS[vertical];
  switch (vertical) {
    case 'housing':
      return <Home size={size} color={iconColor} />;
    case 'rehab':
      return <RefreshCw size={size} color={iconColor} />;
    case 'food':
      return <Utensils size={size} color={iconColor} />;
    case 'mental_health':
      return <Brain size={size} color={iconColor} />;
    case 'healthcare':
      return <Stethoscope size={size} color={iconColor} />;
  }
}

// ─── SessionTimer ─────────────────────────────────────────────────────────────

interface SessionTimerProps {
  /** Unix timestamp (ms) when session was started */
  startedAtMs: number;
}

/**
 * Live session timer that ticks every second using setInterval.
 * Displays elapsed time in MM:SS format.
 */
function SessionTimer({ startedAtMs }: SessionTimerProps): React.JSX.Element {
  const [elapsedSeconds, setElapsedSeconds] = useState(() =>
    Math.floor((Date.now() - startedAtMs) / 1000),
  );

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAtMs) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [startedAtMs]);

  return (
    <View style={timerStyles.container}>
      <Clock size={12} color={colors.compassGold} />
      <Text style={timerStyles.text}>{formatElapsedTime(elapsedSeconds)}</Text>
    </View>
  );
}

const timerStyles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.compassGold + '18',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.compassGold + '40',
  },
  text: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.compassGold,
    fontVariant: ['tabular-nums'],
  },
});

// ─── SessionCard sub-component ────────────────────────────────────────────────
//
// Member-recording consent used to be gated here via a checkbox above the
// Start Session button. Per Akram instruction the consent flow now happens
// AFTER the call session starts — handled inside SessionChat.tsx by the Mic
// button's consent modal. The CHW announces the recording out loud at the
// start of the call rather than pre-acknowledging it in the queue.

interface SessionCardProps {
  session: SessionData;
  /** Unix ms timestamp for when session entered in_progress status */
  startedAtMs?: number;
  /** True when this is the CHW's first session ever with this member */
  isFirstSession: boolean;
  /** Map of session_id to claim, indexed once at the parent for O(1) lookup */
  claimsBySession: Map<string, ChwClaim>;
  /** True while the Vonage call-bridge request for this session is in flight */
  isCallingMember: boolean;
  /**
   * When true the Start Session button on THIS card is disabled because another
   * session is already in_progress. The button is visually dimmed and labelled
   * "Another session active" to signal the reason to the CHW.
   */
  isStartDisabled: boolean;
  onStart: (id: string) => void;
  onComplete: (id: string) => void;
  onDocumentSession: (id: string) => void;
  onOpenChat: (id: string) => void;
  /** Initiate a masked Vonage call to the member on this session. */
  onCallMember: (session: SessionData) => void;
  onOpenMemberProfile: (memberId: string | undefined, memberName: string | undefined) => void;
  /** Called when the CHW taps a disabled Start Session button. */
  onStartDisabledPress: () => void;
}

function SessionCard({
  session,
  startedAtMs,
  isFirstSession,
  claimsBySession,
  isCallingMember,
  isStartDisabled,
  onStart,
  onComplete,
  onDocumentSession,
  onOpenChat,
  onCallMember,
  onOpenMemberProfile,
  onStartDisabledPress,
}: SessionCardProps): React.JSX.Element {
  const verticalColor = VERTICAL_COLORS[session.vertical as Vertical] ?? '#6B7A6B';
  const verticalLabel = VERTICAL_LABELS[session.vertical as Vertical] ?? session.vertical;
  const statusColor = SESSION_STATUS_COLORS[session.status as SessionStatus] ?? colors.mutedForeground;
  const billingStatus = lookupBillingStatus(session.id, claimsBySession);
  const journey = mockJourneyStatus(session.id);

  const isScheduled = session.status === 'scheduled';
  const isInProgress = session.status === 'in_progress';
  const isActive = isScheduled || isInProgress;
  const isCompleted = session.status === 'completed';

  return (
    <View style={cardStyles.card}>
      {/* Header */}
      <View style={cardStyles.headerRow}>
        <View style={[cardStyles.iconCircle, { backgroundColor: verticalColor + '18' }]}>
          <VerticalIconComponent vertical={session.vertical as Vertical} size={20} />
        </View>
        <View style={cardStyles.headerInfo}>
          <View style={cardStyles.badgeRow}>
            {/* Member name: tap opens profile detail (per Jemal: "should be
                able to click it to see their full profile in more detail") */}
            <TouchableOpacity
              onPress={() => onOpenMemberProfile(session.memberId, session.memberName)}
              accessibilityRole="link"
              accessibilityLabel={`Open profile for ${session.memberName}`}
              hitSlop={4}
            >
              <Text style={cardStyles.memberNameLink}>{session.memberName}</Text>
            </TouchableOpacity>
            <View style={[cardStyles.badge, { backgroundColor: statusColor + '18' }]}>
              <Text style={[cardStyles.badgeText, { color: statusColor }]}>
                {sessionStatusLabels[session.status as SessionStatus] ?? session.status}
              </Text>
            </View>
            {/* "First session" chip when applicable (Jemal feedback) */}
            {isFirstSession && (
              <View style={cardStyles.firstSessionChip}>
                <Text style={cardStyles.firstSessionChipText}>First session</Text>
              </View>
            )}
            {/* Live timer for in-progress sessions */}
            {isInProgress && startedAtMs != null && (
              <SessionTimer startedAtMs={startedAtMs} />
            )}
          </View>

          {/* Need category + journey-status pills */}
          <View style={cardStyles.subBadgeRow}>
            <View style={[cardStyles.badge, { backgroundColor: verticalColor + '18' }]}>
              <Text style={[cardStyles.badgeText, { color: verticalColor }]}>
                {verticalLabel}
              </Text>
            </View>
            <View style={cardStyles.journeyPill}>
              <View style={[cardStyles.journeyDot, { backgroundColor: JOURNEY_COLORS[journey] }]} />
              <Text style={cardStyles.journeyText}>{JOURNEY_LABELS[journey]}</Text>
            </View>
          </View>

          <Text style={cardStyles.meta}>
            {formatScheduledAt(session.scheduledAt)}
            {' · '}
            {sessionModeLabels[session.mode as keyof typeof sessionModeLabels] ?? session.mode}
          </Text>
        </View>
      </View>

      {/* Completed stats */}
      {isCompleted && (
        <View style={cardStyles.statsRow}>
          {session.durationMinutes != null && (
            <View style={cardStyles.statChip}>
              <Clock size={12} color={colors.mutedForeground} />
              <Text style={cardStyles.statChipText}>{session.durationMinutes} min</Text>
            </View>
          )}
          {session.unitsBilled != null && (
            <View style={cardStyles.statChip}>
              <Text style={cardStyles.statChipText}>{session.unitsBilled} units</Text>
            </View>
          )}
          {session.netAmount != null && (
            <View style={cardStyles.statChip}>
              <DollarSign size={12} color={colors.primary} />
              <Text style={[cardStyles.statChipText, { color: colors.primary, fontWeight: '700' }]}>
                {formatCurrency(session.netAmount)} net
              </Text>
            </View>
          )}
          <View
            style={[
              cardStyles.badge,
              { backgroundColor: BILLING_STATUS_COLORS[billingStatus] + '18' },
            ]}
          >
            <Text
              style={[cardStyles.badgeText, { color: BILLING_STATUS_COLORS[billingStatus] }]}
            >
              {BILLING_STATUS_LABELS[billingStatus]}
            </Text>
          </View>
        </View>
      )}

      {/* Active action buttons */}
      {isActive && (
        <View style={cardStyles.actionRow}>
          {isScheduled && (
            <TouchableOpacity
              style={[cardStyles.startButton, isStartDisabled && cardStyles.startButtonDisabled]}
              onPress={() => {
                if (isStartDisabled) {
                  onStartDisabledPress();
                } else {
                  onStart(session.id);
                }
              }}
              accessibilityLabel={
                isStartDisabled
                  ? `Cannot start — another session is already in progress`
                  : `Start session with ${session.memberName}`
              }
              accessibilityRole="button"
              accessibilityState={{ disabled: isStartDisabled }}
            >
              <Play size={14} color={isStartDisabled ? '#AAAAAA' : '#FFFFFF'} />
              <Text
                style={[
                  cardStyles.startButtonText,
                  isStartDisabled && cardStyles.startButtonDisabledText,
                ]}
              >
                {isStartDisabled ? 'Another session active' : 'Start Session'}
              </Text>
            </TouchableOpacity>
          )}
          {isInProgress && (
            <>
              <TouchableOpacity
                style={cardStyles.chatButton}
                onPress={() => onOpenChat(session.id)}
                accessibilityLabel={`Open chat for session with ${session.memberName}`}
                accessibilityRole="button"
              >
                <MessageSquare size={14} color={colors.secondary} />
                <Text style={cardStyles.chatButtonText}>Chat</Text>
              </TouchableOpacity>
              {/* Vonage masked-call bridge — only visible on in_progress sessions.
                  The member's real number is never exposed to the CHW device. */}
              <TouchableOpacity
                style={[
                  cardStyles.callButton,
                  isCallingMember && cardStyles.callButtonDisabled,
                ]}
                onPress={() => onCallMember(session)}
                disabled={isCallingMember}
                accessibilityLabel={`Call ${session.memberName ?? 'member'} using masked number`}
                accessibilityRole="button"
                accessibilityState={{ disabled: isCallingMember }}
              >
                {isCallingMember ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Phone size={14} color="#FFFFFF" />
                )}
                <Text style={cardStyles.callButtonText}>
                  {isCallingMember ? 'Connecting...' : 'Call Member (masked)'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={cardStyles.completeButton}
                onPress={() => onComplete(session.id)}
                accessibilityLabel={`Complete session with ${session.memberName}`}
                accessibilityRole="button"
              >
                <CheckCircle size={14} color={colors.primary} />
                <Text style={cardStyles.completeButtonText}>Complete</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      )}

      {/* Document button — shown on completed sessions */}
      {isCompleted && (
        <View style={[cardStyles.actionRow, { marginTop: 10 }]}>
          <TouchableOpacity
            style={cardStyles.documentButton}
            onPress={() => onDocumentSession(session.id)}
            accessibilityLabel={`Document session with ${session.memberName}`}
            accessibilityRole="button"
          >
            <FileText size={14} color={colors.primary} />
            <Text style={cardStyles.documentButtonText}>Document Session</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const cardStyles = StyleSheet.create({
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    padding: 16,
    marginBottom: 12,
    shadowColor: '#3D5A3E',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 24,
    elevation: 3,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    marginBottom: 8,
  },
  iconCircle: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    backgroundColor: '#3D5A3E15',
  },
  headerInfo: {
    flex: 1,
    gap: 4,
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
  },
  memberName: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    lineHeight: 22,
    color: '#1E3320',
  },
  memberNameLink: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    lineHeight: 22,
    color: colors.primary,
    textDecorationLine: 'underline',
  },
  subBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 4,
  },
  firstSessionChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 100,
    backgroundColor: colors.compassGold + '22',
    borderWidth: 1,
    borderColor: colors.compassGold + '50',
  },
  firstSessionChipText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 11,
    color: colors.compassGold,
  },
  journeyPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 100,
    backgroundColor: '#F4F1ED',
    borderWidth: 1,
    borderColor: '#DDD6CC',
  },
  journeyDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  journeyText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 11,
    color: '#6B7A6B',
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 100,
  },
  badgeText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    lineHeight: 16,
  },
  meta: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    letterSpacing: 1,
    color: '#6B7A6B',
  },
  statsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
    marginBottom: 4,
  },
  statChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
  },
  statChipText: {
    ...typography.label,
    color: colors.mutedForeground,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
  },
  startButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#3D5A3E',
    paddingVertical: 14,
    borderRadius: 12,
  },
  startButtonDisabled: {
    backgroundColor: '#E5E5E5',
    borderWidth: 1,
    borderColor: '#CCCCCC',
    opacity: 1,
  },
  startButtonText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#FFFFFF',
  },
  startButtonDisabledText: {
    color: '#888888',
    fontSize: 13,
  },
  completeButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#3D5A3E',
    paddingVertical: 14,
    borderRadius: 12,
  },
  completeButtonText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#3D5A3E',
  },
  chatButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#7A9F5A',
    paddingVertical: 14,
    borderRadius: 12,
  },
  chatButtonText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#7A9F5A',
  },
  /** Vonage masked-call button — indigo fill distinguishes it from the green/white CHW palette */
  callButton: {
    flex: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#1D4ED8',
    paddingVertical: 14,
    borderRadius: 12,
  },
  callButtonDisabled: {
    opacity: 0.55,
  },
  callButtonText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: '#FFFFFF',
  },
  documentButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#3D5A3E15',
    borderWidth: 1,
    borderColor: '#3D5A3E',
    paddingVertical: 14,
    borderRadius: 12,
  },
  documentButtonText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#3D5A3E',
  },
});

// ─── ChatModal wrapper ────────────────────────────────────────────────────────

interface ChatModalProps {
  visible: boolean;
  sessionId: string;
  onClose: () => void;
}

function ChatModal({ visible, sessionId, onClose }: ChatModalProps): React.JSX.Element {
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
      accessible
      accessibilityViewIsModal
    >
      <SafeAreaView style={{ flex: 1, backgroundColor: '#F4F1ED' }} edges={['top']}>
        {/* Modal header */}
        <View style={chatModalStyles.header}>
          <Text style={chatModalStyles.headerTitle}>Session Chat</Text>
          <TouchableOpacity
            style={chatModalStyles.closeButton}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close chat"
          >
            <X size={20} color={colors.foreground} />
          </TouchableOpacity>
        </View>
        <SessionChatWithFollowup sessionId={sessionId} />
      </SafeAreaView>
    </Modal>
  );
}

const chatModalStyles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#DDD6CC',
    backgroundColor: '#FFFFFF',
  },
  headerTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 24,
    lineHeight: 30,
    color: '#1E3320',
  },
  closeButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#F4F1ED',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#DDD6CC',
  },
});

// ─── ToastBanner ─────────────────────────────────────────────────────────────

interface ToastBannerProps {
  message: string;
}

/**
 * Ephemeral banner shown at the top of the screen for short-lived feedback.
 * Auto-dismissed by the parent after a timeout — this component is purely
 * presentational.
 */
function ToastBanner({ message }: ToastBannerProps): React.JSX.Element {
  return (
    <View
      style={toastBannerStyles.container}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <Phone size={14} color="#FFFFFF" />
      <Text style={toastBannerStyles.text} numberOfLines={2}>
        {message}
      </Text>
    </View>
  );
}

const toastBannerStyles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 54 : 16,
    left: 16,
    right: 16,
    zIndex: 99,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#1D4ED8',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 16,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.2,
        shadowRadius: 12,
      },
      android: {
        elevation: 8,
      },
    }),
  },
  text: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: '#FFFFFF',
    flex: 1,
  },
});

// ─── ActiveSessionBanner ─────────────────────────────────────────────────────
//
// Shown at the top of the Active tab when the CHW already has a session in
// in_progress. Tapping "View" scrolls the FlatList to the in-progress card.

interface ActiveSessionBannerProps {
  /** ID of the currently in-progress session. Used to build the "View" action. */
  activeSessionId: string;
  /** Called when the CHW taps the "View active session" link. */
  onViewActiveSession: (sessionId: string) => void;
}

/**
 * Persistent inline banner reminding the CHW that one session is in progress.
 * Uses the same visual language as the consent/error banners in the app:
 * gold/amber background with dark text, rounded card, left accent.
 */
function ActiveSessionBanner({
  activeSessionId,
  onViewActiveSession,
}: ActiveSessionBannerProps): React.JSX.Element {
  return (
    <View
      style={activeBannerStyles.container}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <View style={activeBannerStyles.accentBar} />
      <View style={activeBannerStyles.body}>
        <Text style={activeBannerStyles.message}>
          You have a session in progress. Complete it before starting another.
        </Text>
        <TouchableOpacity
          onPress={() => onViewActiveSession(activeSessionId)}
          accessibilityRole="link"
          accessibilityLabel="View active session"
          hitSlop={8}
        >
          <Text style={activeBannerStyles.link}>View active session →</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const activeBannerStyles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    backgroundColor: colors.compassGold + '18',
    borderWidth: 1,
    borderColor: colors.compassGold + '60',
    borderRadius: 12,
    marginHorizontal: 20,
    marginBottom: 8,
    overflow: 'hidden',
  },
  accentBar: {
    width: 4,
    backgroundColor: colors.compassGold,
    borderTopLeftRadius: 12,
    borderBottomLeftRadius: 12,
  },
  body: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 4,
  },
  message: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: '#7A5800',
    lineHeight: 18,
  },
  link: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    color: colors.compassGold,
    textDecorationLine: 'underline',
  },
});

// ─── Main Component ───────────────────────────────────────────────────────────

type SessionTab = 'active' | 'completed';

/**
 * CHW Sessions screen — lists active and completed sessions with:
 * - Live timer for in-progress sessions
 * - Consent checkbox before starting
 * - Chat modal for active sessions
 * - "Call Member (masked)" button on in-progress sessions (Vonage bridge)
 * - Documentation modal for completed sessions
 */
type SessionsNavProp = NativeStackNavigationProp<CHWSessionsStackParamList, 'Sessions'>;

export function CHWSessionsScreen(): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<SessionTab>('active');
  const navigation = useNavigation<SessionsNavProp>();

  const { data: rawSessions, isLoading, error, refetch } = useSessions();
  const { data: rawClaims } = useChwClaims();
  const claimsBySession = useMemo<Map<string, ChwClaim>>(() => {
    const map = new Map<string, ChwClaim>();
    for (const claim of rawClaims ?? []) {
      if (claim.sessionId && !map.has(claim.sessionId)) {
        map.set(claim.sessionId, claim);
      }
    }
    return map;
  }, [rawClaims]);
  const refresh = useRefreshControl([refetch]);
  const startSession = useStartSession();
  const completeSession = useCompleteSession();
  const submitDocumentation = useSubmitDocumentation();

  // Tracks when sessions went in_progress locally (for live timer).
  // The API handles the actual status; this is just for the timer UX.
  const startTimestamps = useRef<Record<string, number>>({});

  // Documentation modal state
  const [documentingSessionId, setDocumentingSessionId] = useState<string | null>(null);

  // Chat modal state
  const [chatSessionId, setChatSessionId] = useState<string | null>(null);

  // Call-bridge state: tracks which session is currently dialing (null = idle).
  // Only one call can be in flight at a time — the button disables itself while
  // callingSessionId matches its own session id.
  const [callingSessionId, setCallingSessionId] = useState<string | null>(null);

  // Toast notification — auto-clears after 3.5 s.
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const allSessions = rawSessions ?? [];

  // Active queue sorted by urgency, then by scheduled time (Jemal Sessions
  // feedback: "ensure this queue shows up in order of priority and
  // scheduled date/time").
  const activeSessions = useMemo<SessionData[]>(() => {
    const arr = allSessions.filter(
      (s) => s.status === 'scheduled' || s.status === 'in_progress',
    );
    return arr.slice().sort((a, b) => {
      const ra = urgencyRank(a);
      const rb = urgencyRank(b);
      if (ra !== rb) return ra - rb;
      return new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime();
    });
  }, [allSessions]);

  const completedSessions = useMemo<SessionData[]>(
    () => allSessions.filter((s) => s.status === 'completed'),
    [allSessions],
  );

  // For each member, the earliest session is treated as their "first session"
  // for the "First session" chip per Jemal feedback. Recomputed whenever the
  // session list changes.
  // TODO(backend): expose session.is_first_with_member computed server-side.
  const firstSessionIds = useMemo<Set<string>>(() => {
    const earliest = new Map<string, { id: string; ts: number }>();
    for (const s of allSessions) {
      if (!s.memberId) continue;
      const ts = new Date(s.scheduledAt).getTime();
      const cur = earliest.get(s.memberId);
      if (!cur || ts < cur.ts) earliest.set(s.memberId, { id: s.id, ts });
    }
    return new Set([...earliest.values()].map((v) => v.id));
  }, [allSessions]);

  const displayedSessions = activeTab === 'active' ? activeSessions : completedSessions;

  // ── One-active-session-per-CHW gating ────────────────────────────────────────
  // Computed from the live sessions list so it auto-updates after start/complete.
  const inProgressSession = useMemo<SessionData | undefined>(
    () => allSessions.find((s) => s.status === 'in_progress'),
    [allSessions],
  );
  const hasActiveInProgress = inProgressSession !== undefined;

  // Ref to the FlatList so we can scroll to the in-progress card when the CHW
  // taps "View active session →" in the banner.
  const flatListRef = useRef<FlatList<SessionData>>(null);

  /**
   * Show a short-lived toast banner at the top of the screen.
   * Cancels any in-flight timer so rapid calls don't stack banners.
   * Defined before all handlers that reference it.
   */
  const showToast = useCallback((message: string): void => {
    if (toastTimerRef.current !== null) {
      clearTimeout(toastTimerRef.current);
    }
    setToastMessage(message);
    toastTimerRef.current = setTimeout(() => {
      setToastMessage(null);
      toastTimerRef.current = null;
    }, 3500);
  }, []);

  const handleViewActiveSession = useCallback(
    (activeSessionId: string): void => {
      const idx = activeSessions.findIndex((s) => s.id === activeSessionId);
      if (idx >= 0 && flatListRef.current) {
        flatListRef.current.scrollToIndex({ index: idx, animated: true, viewPosition: 0 });
      }
    },
    [activeSessions],
  );

  /**
   * Called when the CHW taps a disabled Start Session button. Shows a toast
   * reminding them to complete the current session first.
   */
  const handleStartDisabledPress = useCallback((): void => {
    showToast(
      'You have a session in progress. Complete it before starting another.',
    );
  }, [showToast]);

  const handleStart = useCallback(
    async (id: string): Promise<void> => {
      startTimestamps.current[id] = Date.now();
      try {
        await startSession.mutateAsync(id);
      } catch (err) {
        // Check for the structured 409 — another session is already in progress.
        if (
          err instanceof ApiError &&
          err.status === 409 &&
          err.rawDetail !== null &&
          err.rawDetail['code'] === 'ANOTHER_SESSION_IN_PROGRESS'
        ) {
          showToast(
            'You have a session in progress. Complete it before starting another.',
          );
          return;
        }
        // All other errors — surface the message so the CHW knows what happened.
        const reason =
          err instanceof Error && err.message.trim().length > 0
            ? err.message
            : 'Failed to start session. Please try again.';
        showToast(reason);
      }
    },
    [startSession, showToast],
  );

  const handleComplete = useCallback((id: string): void => {
    void completeSession.mutateAsync(id);
    setActiveTab('completed');
  }, [completeSession]);

  const handleDocumentSession = useCallback((id: string): void => {
    setDocumentingSessionId(id);
  }, []);

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
        // Surface the real error instead of silently closing the modal.
        // Keeps the modal open so the CHW can fix and resubmit.
        const reason =
          err instanceof Error && err.message ? err.message : 'Unknown error';
        // eslint-disable-next-line no-console
        console.error('[CHWSessions] submitDocumentation failed:', err);
        if (Platform.OS === 'web' && typeof window !== 'undefined') {
          window.alert(`Failed to submit documentation\n\n${reason}\n\nThe modal will stay open so you can adjust and try again.`);
        } else {
          Alert.alert('Failed to submit documentation', reason);
        }
      }
    },
    [documentingSessionId, submitDocumentation],
  );

  const handleOpenChat = useCallback((id: string): void => {
    setChatSessionId(id);
  }, []);

  const handleOpenMemberProfile = useCallback(
    (memberId: string | undefined, _memberName: string | undefined): void => {
      if (!memberId) {
        // Guard: session card may not have a memberId in edge-case data states.
        return;
      }
      navigation.navigate('MemberProfile', { memberId });
    },
    [navigation],
  );

  /**
   * Initiate a Vonage masked call for an in-progress session.
   *
   * Guard clauses:
   *   - Rejects if a call is already in flight (prevents double-dial).
   *   - Rejects with a toast if chwId or memberId is absent on the session row.
   *
   * Happy path:
   *   phone.dial() calls VonageMaskedDialProvider which POSTs to
   *   /communication/call-bridge. Vonage dials the CHW; on answer it
   *   bridges to the member's masked number.
   *
   * Error path:
   *   Surfaces a native Alert (or window.alert on web) with the error message
   *   and re-enables the button via the finally-block.
   */
  const handleCallMember = useCallback(
    async (session: SessionData): Promise<void> => {
      if (callingSessionId !== null) {
        // Prevent double-tap while a bridge request is already in flight.
        return;
      }

      const missingFields = [
        !session.chwId ? 'CHW id' : null,
        !session.memberId ? 'member id' : null,
      ].filter(Boolean);

      if (missingFields.length > 0) {
        showToast(`Cannot initiate call — missing ${missingFields.join(', ')}.`);
        return;
      }

      setCallingSessionId(session.id);
      try {
        await phone.dial({
          callerId: session.chwId,
          recipientId: session.memberId,
          sessionId: session.id,
        });
        showToast('Call connected — member is being bridged via masked number.');
      } catch (err) {
        const reason =
          err instanceof Error && err.message.trim().length > 0
            ? err.message
            : 'Unable to connect the call. Please try again.';

        if (Platform.OS === 'web' && typeof window !== 'undefined') {
          window.alert(`Call failed\n\n${reason}`);
        } else {
          Alert.alert('Call failed', reason);
        }
      } finally {
        setCallingSessionId(null);
      }
    },
    [callingSessionId, showToast],
  );

  const renderItem = useCallback(
    ({ item }: { item: SessionData }) => {
      // The Start Session button is disabled when another session is in_progress
      // AND this card is not itself the in-progress one (in-progress cards don't
      // show a Start button at all, but we guard here for safety).
      const isStartDisabled =
        hasActiveInProgress && item.status === 'scheduled';

      return (
        <SessionCard
          session={item}
          startedAtMs={
            item.status === 'in_progress' ? (startTimestamps.current[item.id] ?? Date.now()) : undefined
          }
          isFirstSession={firstSessionIds.has(item.id)}
          claimsBySession={claimsBySession}
          isCallingMember={callingSessionId === item.id}
          isStartDisabled={isStartDisabled}
          onStart={(id) => { void handleStart(id); }}
          onComplete={handleComplete}
          onDocumentSession={handleDocumentSession}
          onOpenChat={handleOpenChat}
          onCallMember={(session) => { void handleCallMember(session); }}
          onOpenMemberProfile={handleOpenMemberProfile}
          onStartDisabledPress={handleStartDisabledPress}
        />
      );
    },
    [
      hasActiveInProgress,
      firstSessionIds,
      claimsBySession,
      callingSessionId,
      handleStart,
      handleStartDisabledPress,
      handleComplete,
      handleDocumentSession,
      handleOpenChat,
      handleCallMember,
      handleOpenMemberProfile,
    ],
  );

  if (isLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.headerBlock}>
          <Text style={styles.pageTitle}>Sessions</Text>
        </View>
        <View style={styles.listContent}>
          <LoadingSkeleton variant="rows" rows={3} />
        </View>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <ErrorState message="Failed to load sessions" onRetry={() => void refetch()} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* Toast overlay — positioned absolutely over all content */}
      {toastMessage !== null && <ToastBanner message={toastMessage} />}

      {/* Page header */}
      <View style={styles.headerBlock}>
        <Text style={styles.pageTitle}>Sessions</Text>

        {/* Tab bar */}
        <View style={styles.tabBar}>
          {(['active', 'completed'] as SessionTab[]).map((tab) => {
            const isActive = activeTab === tab;
            const count = tab === 'active' ? activeSessions.length : completedSessions.length;
            return (
              <TouchableOpacity
                key={tab}
                style={[styles.tabItem, isActive && styles.tabItemActive]}
                onPress={() => setActiveTab(tab)}
                accessibilityRole="tab"
                accessibilityState={{ selected: isActive }}
              >
                <Text style={[styles.tabLabel, isActive && styles.tabLabelActive]}>
                  {tab === 'active' ? 'Active' : 'Completed'}
                  {count > 0 ? ` (${count})` : ''}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {/* Active-session lock banner — shown above the active list when
          a session is already in_progress. Positioned between the tab bar and
          the session list so it is visible without scrolling. Only shown on the
          Active tab (where scheduled cards are visible and could be tapped). */}
      {activeTab === 'active' && hasActiveInProgress && inProgressSession !== undefined && (
        <ActiveSessionBanner
          activeSessionId={inProgressSession.id}
          onViewActiveSession={handleViewActiveSession}
        />
      )}

      {/* Session list */}
      {displayedSessions.length > 0 ? (
        <FlatList<SessionData>
          ref={flatListRef}
          data={displayedSessions}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          refreshControl={refresh.control}
          onScrollToIndexFailed={() => {
            // If the index is not yet measured (list hasn't fully laid out),
            // scroll to the top as a graceful fallback.
            flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
          }}
        />
      ) : (
        <View style={styles.emptyState}>
          <View style={styles.emptyIconCircle}>
            <CheckCircle size={24} color={colors.mutedForeground} />
          </View>
          <Text style={styles.emptyTitle}>
            {activeTab === 'active' ? 'No active sessions' : 'No completed sessions yet'}
          </Text>
          <Text style={styles.emptySubtext}>
            {activeTab === 'active'
              ? 'Accept a request to start a session.'
              : 'Completed sessions will appear here.'}
          </Text>
        </View>
      )}

      {/* Documentation modal */}
      {documentingSessionId != null && (
        <DocumentationModal
          visible={documentingSessionId != null}
          onClose={() => setDocumentingSessionId(null)}
          sessionId={documentingSessionId}
          onSubmit={handleDocumentationSubmit}
        />
      )}

      {/* Chat modal */}
      {chatSessionId != null && (
        <ChatModal
          visible={chatSessionId != null}
          sessionId={chatSessionId}
          onClose={() => setChatSessionId(null)}
        />
      )}
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#F4F1ED',
  },
  headerBlock: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 4,
    backgroundColor: '#F4F1ED',
  },
  pageTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 24,
    lineHeight: 30,
    color: '#1E3320',
    marginBottom: 16,
  },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    padding: 4,
    marginBottom: 12,
  },
  tabItem: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabItemActive: {
    backgroundColor: '#3D5A3E',
  },
  tabLabel: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#6B7A6B',
  },
  tabLabelActive: {
    color: '#FFFFFF',
  },
  listContent: {
    padding: 20,
    paddingTop: 8,
    paddingBottom: 40,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
    gap: 12,
  },
  emptyIconCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#3D5A3E15',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    lineHeight: 22,
    color: '#1E3320',
  },
  emptySubtext: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#6B7A6B',
    textAlign: 'center',
    maxWidth: 280,
  },
});

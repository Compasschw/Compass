/**
 * MemberSessionsScreen — View and manage CHW sessions.
 *
 * Tabs:
 * - Active: scheduled/in_progress sessions with cancel action
 * - Completed: past sessions with star ratings and expandable notes
 *
 * Mock member: Rosa Delgado (first in memberProfiles)
 */

import React, { useCallback, useState } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  CalendarCheck,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Inbox,
  MessageCircle,
  Star,
  XCircle,
} from 'lucide-react-native';

import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import {
  sessionModeLabels,
  sessionStatusLabels,
  verticalLabels,
  type SessionStatus,
  type Vertical,
  type SessionMode,
} from '../../data/mock';
import {
  useSessions,
  type SessionData,
} from '../../hooks/useApiQueries';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';

// ─── Constants ────────────────────────────────────────────────────────────────

type TabKey = 'active' | 'completed';

const MOCK_MEMBER_NAME = 'Rosa Delgado';

const statusBadgeColors: Record<SessionStatus, { bg: string; text: string }> = {
  scheduled: { bg: `${colors.secondary}20`, text: colors.secondary },
  in_progress: { bg: `${colors.compassGold}20`, text: colors.compassGold },
  completed: { bg: `${colors.primary}15`, text: colors.primary },
  cancelled: { bg: `${colors.mutedForeground}15`, text: colors.mutedForeground },
};

const verticalColors: Record<Vertical, string> = {
  housing: '#3B82F6',
  rehab: '#EF4444',
  food: '#F59E0B',
  mental_health: '#8B5CF6',
  healthcare: '#06B6D4',
};

const verticalEmoji: Record<Vertical, string> = {
  housing: '🏠',
  rehab: '💪',
  food: '🛒',
  mental_health: '🧠',
  healthcare: '🏥',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .slice(0, 2)
    .map((part) => part[0] ?? '')
    .join('')
    .toUpperCase();
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface ToastBannerProps {
  message: string;
}

function ToastBanner({ message }: ToastBannerProps): React.JSX.Element {
  return (
    <View style={toastStyles.container} accessibilityRole="alert" accessibilityLiveRegion="polite">
      <CheckCircle color="#FFFFFF" size={15} />
      <Text style={toastStyles.text}>{message}</Text>
    </View>
  );
}

const toastStyles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 54 : 16,
    left: 16,
    right: 16,
    zIndex: 99,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.primary,
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
    ...typography.bodySm,
    color: '#FFFFFF',
    fontWeight: '600',
    flex: 1,
  },
});

// ─── Cancel Confirm Modal ─────────────────────────────────────────────────────

interface ConfirmCancelModalProps {
  session: SessionData;
  visible: boolean;
  onConfirm: (sessionId: string) => void;
  onDismiss: () => void;
}

function ConfirmCancelModal({
  session,
  visible,
  onConfirm,
  onDismiss,
}: ConfirmCancelModalProps): React.JSX.Element {
  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent
      onRequestClose={onDismiss}
    >
      <View style={cancelModalStyles.backdrop}>
        <View style={cancelModalStyles.dialog}>
          <Text style={cancelModalStyles.title}>Cancel Session?</Text>
          <Text style={cancelModalStyles.body}>
            Are you sure you want to cancel your session with{' '}
            <Text style={{ fontWeight: '700' }}>{session.chwName ?? 'your CHW'}</Text>?
            {' '}This cannot be undone.
          </Text>
          <View style={cancelModalStyles.btnRow}>
            <TouchableOpacity
              onPress={() => onConfirm(session.id)}
              style={cancelModalStyles.cancelBtn}
              accessibilityRole="button"
              accessibilityLabel="Confirm cancel session"
            >
              <Text style={cancelModalStyles.cancelBtnText}>Yes, Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={onDismiss}
              style={cancelModalStyles.keepBtn}
              accessibilityRole="button"
              accessibilityLabel="Keep session"
            >
              <Text style={cancelModalStyles.keepBtnText}>Keep Session</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const cancelModalStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  dialog: {
    backgroundColor: colors.card,
    borderRadius: 20,
    padding: 24,
    width: '100%',
    maxWidth: 360,
  },
  title: {
    ...typography.bodyMd,
    fontWeight: '700',
    color: colors.foreground,
    marginBottom: 8,
  },
  body: {
    ...typography.bodySm,
    color: colors.mutedForeground,
    marginBottom: 20,
    lineHeight: 20,
  },
  btnRow: {
    flexDirection: 'row',
    gap: 10,
  },
  cancelBtn: {
    flex: 1,
    backgroundColor: colors.destructive,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  cancelBtnText: {
    ...typography.bodySm,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  keepBtn: {
    flex: 1,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  keepBtnText: {
    ...typography.bodySm,
    fontWeight: '600',
    color: colors.mutedForeground,
  },
});

// ─── Star Rating ──────────────────────────────────────────────────────────────

interface StarRatingProps {
  sessionId: string;
  currentRating: number;
  onRate: (sessionId: string, rating: number) => void;
}

function StarRating({ sessionId, currentRating, onRate }: StarRatingProps): React.JSX.Element {
  return (
    <View
      style={starStyles.row}
      accessibilityLabel={`Rate session, currently ${currentRating} stars`}
    >
      {Array.from({ length: 5 }, (_, i) => {
        const starValue = i + 1;
        const isFilled = starValue <= currentRating;
        const isRated = currentRating > 0;

        return (
          <TouchableOpacity
            key={i}
            onPress={() => !isRated && onRate(sessionId, starValue)}
            disabled={isRated}
            accessibilityRole="button"
            accessibilityLabel={`${starValue} star${starValue !== 1 ? 's' : ''}`}
            hitSlop={6}
          >
            <Star
              size={20}
              color={isFilled ? '#FBBF24' : colors.border}
              fill={isFilled ? '#FBBF24' : colors.border}
            />
          </TouchableOpacity>
        );
      })}
      {currentRating > 0 && (
        <Text style={starStyles.ratingText}>{currentRating}.0</Text>
      )}
    </View>
  );
}

const starStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  ratingText: {
    ...typography.label,
    color: colors.mutedForeground,
    fontWeight: '600',
    marginLeft: 4,
  },
});

// ─── Active Session Card ───────────────────────────────────────────────────────

interface ActiveSessionCardProps {
  session: SessionData;
  onMessage: (firstName: string) => void;
  onRequestCancel: (session: SessionData) => void;
}

function ActiveSessionCard({
  session,
  onMessage,
  onRequestCancel,
}: ActiveSessionCardProps): React.JSX.Element {
  const chwDisplayName = session.chwName ?? 'CHW';
  const statusColors = statusBadgeColors[session.status as SessionStatus] ?? {
    bg: `${colors.mutedForeground}15`,
    text: colors.mutedForeground,
  };
  const initials = getInitials(chwDisplayName);
  const verticalColor = verticalColors[session.vertical as Vertical] ?? colors.primary;

  return (
    <View style={activeCardStyles.container}>
      {/* Top row */}
      <View style={activeCardStyles.topRow}>
        <View style={[activeCardStyles.avatar, { backgroundColor: `${colors.primary}18` }]}>
          <Text style={activeCardStyles.avatarText}>{initials}</Text>
        </View>
        <View style={activeCardStyles.infoCol}>
          <View style={activeCardStyles.nameRow}>
            <Text style={activeCardStyles.chwName} numberOfLines={1}>{chwDisplayName}</Text>
            <View style={[activeCardStyles.statusBadge, { backgroundColor: statusColors.bg }]}>
              <Text style={[activeCardStyles.statusBadgeText, { color: statusColors.text }]}>
                {sessionStatusLabels[session.status as SessionStatus] ?? session.status}
              </Text>
            </View>
          </View>
          <View style={activeCardStyles.metaRow}>
            <View style={[activeCardStyles.verticalDot, { backgroundColor: verticalColor }]} />
            <Text style={activeCardStyles.metaText}>
              {verticalLabels[session.vertical as Vertical] ?? session.vertical}
            </Text>
            <Text style={activeCardStyles.separator}>·</Text>
            <Text style={activeCardStyles.metaText}>
              {sessionModeLabels[session.mode as SessionMode] ?? session.mode}
            </Text>
          </View>
        </View>
      </View>

      {/* Date */}
      <View style={activeCardStyles.dateRow}>
        <CalendarCheck color={colors.secondary} size={13} />
        <Text style={activeCardStyles.dateText}>{formatDate(session.scheduledAt)}</Text>
      </View>

      {/* Notes */}
      {session.notes ? (
        <Text style={activeCardStyles.notes} numberOfLines={1}>{session.notes}</Text>
      ) : null}

      {/* Actions */}
      <View style={activeCardStyles.actionRow}>
        <TouchableOpacity
          onPress={() => onMessage((session.chwName ?? 'CHW').split(' ')[0] ?? 'CHW')}
          style={activeCardStyles.messageBtn}
          accessibilityRole="button"
          accessibilityLabel={`Message ${session.chwName ?? 'CHW'}`}
        >
          <MessageCircle color="#FFFFFF" size={13} />
          <Text style={activeCardStyles.messageBtnText}>Message CHW</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => onRequestCancel(session)}
          style={activeCardStyles.cancelBtn}
          accessibilityRole="button"
          accessibilityLabel={`Cancel session with ${session.chwName ?? 'CHW'}`}
        >
          <XCircle color={colors.mutedForeground} size={13} />
          <Text style={activeCardStyles.cancelBtnText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const activeCardStyles = StyleSheet.create({
  container: {
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
  topRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 10,
    alignItems: 'flex-start',
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  avatarText: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.primary,
  },
  infoCol: {
    flex: 1,
    gap: 4,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  chwName: {
    ...typography.bodySm,
    fontWeight: '700',
    color: colors.foreground,
    flex: 1,
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  statusBadgeText: {
    fontSize: 10,
    fontWeight: '600',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  verticalDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  metaText: {
    ...typography.label,
    color: colors.mutedForeground,
  },
  separator: {
    color: colors.mutedForeground,
  },
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8,
  },
  dateText: {
    ...typography.label,
    color: colors.mutedForeground,
  },
  notes: {
    ...typography.label,
    color: colors.mutedForeground,
    fontStyle: 'italic',
    marginBottom: 12,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 8,
  },
  messageBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    backgroundColor: '#7A9F5A',
    borderRadius: 12,
    paddingVertical: 12,
  },
  messageBtnText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#FFFFFF',
  },
  cancelBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    backgroundColor: '#FFFFFF',
  },
  cancelBtnText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#6B7A6B',
  },
});

// ─── Completed Session Card ────────────────────────────────────────────────────

interface CompletedSessionCardProps {
  session: SessionData;
  rating: number;
  isExpanded: boolean;
  onRate: (sessionId: string, rating: number) => void;
  onToggleExpand: (sessionId: string) => void;
  onBookAgain: () => void;
}

function CompletedSessionCard({
  session,
  rating,
  isExpanded,
  onRate,
  onToggleExpand,
  onBookAgain,
}: CompletedSessionCardProps): React.JSX.Element {
  const chwDisplayName = session.chwName ?? 'CHW';
  const initials = getInitials(chwDisplayName);
  const verticalColor = verticalColors[session.vertical as Vertical] ?? colors.primary;

  return (
    <View style={completedCardStyles.container}>
      {/* Top row */}
      <View style={completedCardStyles.topRow}>
        <View style={[completedCardStyles.avatar, { backgroundColor: `${colors.secondary}18` }]}>
          <Text style={completedCardStyles.avatarText}>{initials}</Text>
        </View>
        <View style={completedCardStyles.infoCol}>
          <View style={completedCardStyles.nameRow}>
            <Text style={completedCardStyles.chwName} numberOfLines={1}>{chwDisplayName}</Text>
            <View style={[completedCardStyles.statusBadge, { backgroundColor: `${colors.primary}15` }]}>
              <Text style={[completedCardStyles.statusBadgeText, { color: colors.primary }]}>
                Completed
              </Text>
            </View>
          </View>
          <View style={completedCardStyles.metaRow}>
            <View style={[completedCardStyles.verticalDot, { backgroundColor: verticalColor }]} />
            <Text style={completedCardStyles.metaText}>
              {verticalLabels[session.vertical as Vertical] ?? session.vertical}
            </Text>
            <Text style={completedCardStyles.separator}>·</Text>
            <Text style={completedCardStyles.metaText}>
              {sessionModeLabels[session.mode as SessionMode] ?? session.mode}
            </Text>
          </View>
        </View>
      </View>

      {/* Date + duration */}
      <View style={completedCardStyles.dateRow}>
        <Text style={completedCardStyles.dateText}>{formatShortDate(session.scheduledAt)}</Text>
        {session.durationMinutes ? (
          <>
            <Text style={completedCardStyles.separator}>·</Text>
            <Text style={completedCardStyles.dateText}>{session.durationMinutes} min</Text>
          </>
        ) : null}
      </View>

      {/* Star rating */}
      <View style={completedCardStyles.ratingRow}>
        <Text style={completedCardStyles.ratingLabel}>
          {rating > 0 ? 'Your rating' : 'Rate this session'}
        </Text>
        <StarRating sessionId={session.id} currentRating={rating} onRate={onRate} />
      </View>

      {/* Expandable notes */}
      {session.notes ? (
        <View style={completedCardStyles.notesSection}>
          <TouchableOpacity
            onPress={() => onToggleExpand(session.id)}
            style={completedCardStyles.notesToggle}
            accessibilityRole="button"
            accessibilityLabel={isExpanded ? 'Hide session notes' : 'View session notes'}
          >
            {isExpanded ? (
              <ChevronUp color={colors.secondary} size={13} />
            ) : (
              <ChevronDown color={colors.secondary} size={13} />
            )}
            <Text style={completedCardStyles.notesToggleText}>
              {isExpanded ? 'Hide notes' : 'View session notes'}
            </Text>
          </TouchableOpacity>
          {isExpanded ? (
            <View style={completedCardStyles.notesBox}>
              <Text style={completedCardStyles.notesText}>{session.notes}</Text>
            </View>
          ) : null}
        </View>
      ) : null}

      {/* Book again */}
      <TouchableOpacity
        onPress={onBookAgain}
        style={completedCardStyles.bookAgainBtn}
        accessibilityRole="button"
        accessibilityLabel={`Book another session with ${session.chwName ?? 'CHW'}`}
      >
        <Text style={completedCardStyles.bookAgainText}>Book Again</Text>
      </TouchableOpacity>
    </View>
  );
}

const completedCardStyles = StyleSheet.create({
  container: {
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
  topRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 10,
    alignItems: 'flex-start',
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  avatarText: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.secondary,
  },
  infoCol: {
    flex: 1,
    gap: 4,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  chwName: {
    ...typography.bodySm,
    fontWeight: '700',
    color: colors.foreground,
    flex: 1,
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  statusBadgeText: {
    fontSize: 10,
    fontWeight: '600',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  verticalDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  metaText: {
    ...typography.label,
    color: colors.mutedForeground,
  },
  separator: {
    ...typography.label,
    color: colors.mutedForeground,
  },
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 10,
  },
  dateText: {
    ...typography.label,
    color: colors.mutedForeground,
  },
  ratingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  ratingLabel: {
    ...typography.label,
    fontWeight: '600',
    color: colors.foreground,
  },
  notesSection: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 12,
    marginBottom: 12,
  },
  notesToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  notesToggleText: {
    ...typography.label,
    fontWeight: '500',
    color: colors.secondary,
  },
  notesBox: {
    marginTop: 8,
    backgroundColor: colors.background,
    borderRadius: 10,
    padding: 12,
  },
  notesText: {
    ...typography.label,
    color: colors.mutedForeground,
    lineHeight: 18,
  },
  bookAgainBtn: {
    borderWidth: 1,
    borderColor: '#3D5A3E',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
  },
  bookAgainText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#3D5A3E',
  },
});

// ─── Screen ───────────────────────────────────────────────────────────────────

export function MemberSessionsScreen(): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<TabKey>('active');
  const [cancellingSession, setCancellingSession] = useState<SessionData | null>(null);
  const [cancelledIds, setCancelledIds] = useState<Set<string>>(new Set());
  const [ratings, setRatings] = useState<Record<string, number>>({});
  const [expandedNotes, setExpandedNotes] = useState<Set<string>>(new Set());
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const sessionsQuery = useSessions();
  const allSessions = sessionsQuery.data ?? [];

  // API already scopes to the authenticated member — no client-side name filter needed
  const activeSessions = allSessions.filter(
    (s) =>
      (s.status === 'scheduled' || s.status === 'in_progress') &&
      !cancelledIds.has(s.id),
  );

  const completedSessions = allSessions.filter((s) => s.status === 'completed');

  const showToast = useCallback((message: string) => {
    setToastMessage(message);
    const timer = setTimeout(() => setToastMessage(null), 3500);
    return () => clearTimeout(timer);
  }, []);

  const handleMessage = useCallback(
    (firstName: string) => {
      showToast(`Message sent to ${firstName}. They'll respond soon.`);
    },
    [showToast],
  );

  const handleRequestCancel = useCallback((session: SessionData) => {
    setCancellingSession(session);
  }, []);

  const handleConfirmCancel = useCallback(
    (sessionId: string) => {
      setCancelledIds((prev) => new Set(prev).add(sessionId));
      setCancellingSession(null);
      showToast('Session cancelled successfully.');
    },
    [showToast],
  );

  const handleDismissCancel = useCallback(() => {
    setCancellingSession(null);
  }, []);

  const handleRate = useCallback((sessionId: string, rating: number) => {
    setRatings((prev) => ({ ...prev, [sessionId]: rating }));
  }, []);

  const handleToggleExpand = useCallback((sessionId: string) => {
    setExpandedNotes((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }, []);

  const handleBookAgain = useCallback(() => {
    showToast('Navigate to Find CHW to book a new session.');
  }, [showToast]);

  if (sessionsQuery.isLoading) {
    return (
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        <StatusBar barStyle="dark-content" backgroundColor={colors.background} />
        <View style={{ flex: 1, padding: 16, paddingTop: 20 }}>
          <LoadingSkeleton variant="rows" rows={4} />
        </View>
      </SafeAreaView>
    );
  }

  if (sessionsQuery.error) {
    return (
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        <StatusBar barStyle="dark-content" backgroundColor={colors.background} />
        <ErrorState
          message="Could not load your sessions. Please try again."
          onRetry={() => void sessionsQuery.refetch()}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <StatusBar barStyle="dark-content" backgroundColor={colors.background} />

      {toastMessage ? <ToastBanner message={toastMessage} /> : null}

      {cancellingSession ? (
        <ConfirmCancelModal
          session={cancellingSession}
          visible={cancellingSession !== null}
          onConfirm={handleConfirmCancel}
          onDismiss={handleDismissCancel}
        />
      ) : null}

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>My Sessions</Text>
        <Text style={styles.subtitle}>View and manage your CHW sessions</Text>
      </View>

      {/* Tab bar */}
      <View style={styles.tabBar} accessibilityRole="tablist">
        {(
          [
            { key: 'active' as TabKey, label: 'Active', count: activeSessions.length },
            { key: 'completed' as TabKey, label: 'Completed', count: completedSessions.length },
          ] as const
        ).map(({ key, label, count }) => {
          const isActive = activeTab === key;
          return (
            <TouchableOpacity
              key={key}
              onPress={() => setActiveTab(key)}
              style={[styles.tab, isActive && styles.tabActive]}
              accessibilityRole="tab"
              accessibilityState={{ selected: isActive }}
              accessibilityLabel={`${label} sessions`}
            >
              <Text style={[styles.tabText, isActive && styles.tabTextActive]}>
                {label}
              </Text>
              {count > 0 ? (
                <View style={[styles.tabBadge, isActive && styles.tabBadgeActive]}>
                  <Text style={[styles.tabBadgeText, isActive && styles.tabBadgeTextActive]}>
                    {count}
                  </Text>
                </View>
              ) : null}
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Content */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {activeTab === 'active' ? (
          activeSessions.length > 0 ? (
            activeSessions.map((session) => (
              <ActiveSessionCard
                key={session.id}
                session={session}
                onMessage={handleMessage}
                onRequestCancel={handleRequestCancel}
              />
            ))
          ) : (
            <View style={styles.emptyState}>
              <Inbox color={colors.mutedForeground} size={28} />
              <Text style={styles.emptyTitle}>No active sessions</Text>
              <Text style={styles.emptySub}>Find a CHW to get started!</Text>
            </View>
          )
        ) : (
          completedSessions.length > 0 ? (
            completedSessions.map((session) => (
              <CompletedSessionCard
                key={session.id}
                session={session}
                rating={ratings[session.id] ?? 0}
                isExpanded={expandedNotes.has(session.id)}
                onRate={handleRate}
                onToggleExpand={handleToggleExpand}
                onBookAgain={handleBookAgain}
              />
            ))
          ) : (
            <View style={styles.emptyState}>
              <Inbox color={colors.mutedForeground} size={28} />
              <Text style={styles.emptyTitle}>No completed sessions</Text>
              <Text style={styles.emptySub}>
                Your completed sessions will appear here after your first meeting.
              </Text>
            </View>
          )
        )}
        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#F4F1ED',
  },
  header: {
    paddingHorizontal: 16,
    paddingTop: 20,
    paddingBottom: 16,
  },
  title: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 24,
    lineHeight: 30,
    color: '#1E3320',
  },
  subtitle: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 16,
    lineHeight: 24,
    color: '#6B7A6B',
    marginTop: 4,
  },
  tabBar: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    marginBottom: 16,
  },
  tab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    backgroundColor: '#FFFFFF',
  },
  tabActive: {
    backgroundColor: '#3D5A3E',
    borderColor: '#3D5A3E',
  },
  tabText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#6B7A6B',
  },
  tabTextActive: {
    color: '#FFFFFF',
  },
  tabBadge: {
    minWidth: 20,
    height: 20,
    paddingHorizontal: 5,
    borderRadius: 10,
    backgroundColor: '#6B7A6B20',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabBadgeActive: {
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  tabBadgeText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 11,
    color: '#6B7A6B',
  },
  tabBadgeTextActive: {
    color: '#FFFFFF',
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 16,
  },
  emptyState: {
    paddingTop: 48,
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 32,
  },
  emptyTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    lineHeight: 22,
    color: '#1E3320',
  },
  emptySub: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#6B7A6B',
    textAlign: 'center',
  },
});

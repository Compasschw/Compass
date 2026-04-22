/**
 * CHWSessionsScreen — Session management for CHW users.
 *
 * Features:
 *  - Tab bar: Active (scheduled + in_progress) vs Completed
 *  - Session cards with vertical icon, member name, status badge, date/time, mode
 *  - Active sessions: live timer (MM:SS), consent checkbox before start, Start / Complete actions
 *  - In-progress sessions: Chat button (opens SessionChat modal)
 *  - Completed sessions: "Document Session" button (opens DocumentationModal)
 *  - Duration, units billed, net earnings on completed sessions
 */

import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import {
  FlatList,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
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
  X,
  Check,
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
import {
  useSessions,
  useStartSession,
  useCompleteSession,
  useSubmitDocumentation,
  type SessionData,
} from '../../hooks/useApiQueries';
import { useRefreshControl } from '../../hooks/useRefreshControl';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';
import { DocumentationModal } from '../../components/sessions/DocumentationModal';
import { SessionChat } from '../../components/sessions/SessionChat';

// ─── Constants ────────────────────────────────────────────────────────────────

const VERTICAL_COLORS: Record<Vertical, string> = {
  housing: '#3B82F6',
  rehab: '#EF4444',
  food: '#F59E0B',
  mental_health: '#8B5CF6',
  healthcare: '#06B6D4',
};

type BillingStatus = 'pending' | 'submitted' | 'approved';

const BILLING_STATUS_COLORS: Record<BillingStatus, string> = {
  pending: colors.compassGold,
  submitted: colors.secondary,
  approved: colors.primary,
};

const BILLING_STATUS_LABELS: Record<BillingStatus, string> = {
  pending: 'Pending',
  submitted: 'Submitted',
  approved: 'Approved',
};

const SESSION_STATUS_COLORS: Record<SessionStatus, string> = {
  scheduled: colors.secondary,
  in_progress: colors.compassGold,
  completed: colors.primary,
  cancelled: colors.mutedForeground,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Derives a mock billing/payout status from the session ID for demo purposes.
 */
function deriveBillingStatus(sessionId: string): BillingStatus {
  const map: Record<string, BillingStatus> = {
    'sess-002': 'submitted',
    'sess-003': 'approved',
    'sess-004': 'approved',
  };
  return map[sessionId] ?? 'pending';
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
 * Formats elapsed seconds as MM:SS (e.g. 65 → "01:05").
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

// ─── ConsentCheckbox ──────────────────────────────────────────────────────────

interface ConsentCheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

/**
 * Member recording consent checkbox displayed before starting a session.
 */
function ConsentCheckbox({ checked, onChange }: ConsentCheckboxProps): React.JSX.Element {
  return (
    <TouchableOpacity
      style={[consentStyles.row, checked && consentStyles.rowChecked]}
      onPress={() => onChange(!checked)}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel="I confirm the member has consented to this session being recorded"
      activeOpacity={0.7}
    >
      <View style={[consentStyles.checkbox, checked && consentStyles.checkboxChecked]}>
        {checked && <Check size={9} color="#FFFFFF" strokeWidth={3} />}
      </View>
      <Text style={consentStyles.text}>
        Member has consented to session recording (required)
      </Text>
    </TouchableOpacity>
  );
}

const consentStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 10,
    backgroundColor: colors.background,
    marginTop: 10,
  },
  rowChecked: {
    borderColor: colors.primary,
    backgroundColor: colors.primary + '06',
  },
  checkbox: {
    width: 16,
    height: 16,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
    flexShrink: 0,
  },
  checkboxChecked: {
    borderColor: colors.primary,
    backgroundColor: colors.primary,
  },
  text: {
    flex: 1,
    ...typography.label,
    color: colors.mutedForeground,
    lineHeight: 18,
  },
});

// ─── SessionCard sub-component ────────────────────────────────────────────────

interface SessionCardProps {
  session: SessionData;
  /** Unix ms timestamp for when session entered in_progress status */
  startedAtMs?: number;
  /** Whether consent checkbox has been checked for this session */
  consentChecked: boolean;
  onConsentChange: (id: string, checked: boolean) => void;
  onStart: (id: string) => void;
  onComplete: (id: string) => void;
  onDocumentSession: (id: string) => void;
  onOpenChat: (id: string) => void;
}

function SessionCard({
  session,
  startedAtMs,
  consentChecked,
  onConsentChange,
  onStart,
  onComplete,
  onDocumentSession,
  onOpenChat,
}: SessionCardProps): React.JSX.Element {
  const verticalColor = VERTICAL_COLORS[session.vertical as Vertical] ?? '#6B7A6B';
  const statusColor = SESSION_STATUS_COLORS[session.status as SessionStatus] ?? colors.mutedForeground;
  const billingStatus = deriveBillingStatus(session.id);

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
            <Text style={cardStyles.memberName}>{session.memberName}</Text>
            <View style={[cardStyles.badge, { backgroundColor: statusColor + '18' }]}>
              <Text style={[cardStyles.badgeText, { color: statusColor }]}>
                {sessionStatusLabels[session.status as SessionStatus] ?? session.status}
              </Text>
            </View>
            {/* Live timer for in-progress sessions */}
            {isInProgress && startedAtMs != null && (
              <SessionTimer startedAtMs={startedAtMs} />
            )}
          </View>
          <Text style={cardStyles.meta}>
            {formatScheduledAt(session.scheduledAt)}
            {' · '}
            {sessionModeLabels[session.mode as keyof typeof sessionModeLabels] ?? session.mode}
          </Text>
        </View>
      </View>

      {/* Consent checkbox — shown on scheduled sessions before starting */}
      {isScheduled && (
        <ConsentCheckbox
          checked={consentChecked}
          onChange={(checked) => onConsentChange(session.id, checked)}
        />
      )}

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
              style={[
                cardStyles.startButton,
                !consentChecked && cardStyles.startButtonDisabled,
              ]}
              onPress={() => onStart(session.id)}
              disabled={!consentChecked}
              accessibilityLabel={`Start session with ${session.memberName}`}
              accessibilityRole="button"
              accessibilityState={{ disabled: !consentChecked }}
            >
              <Play size={14} color="#FFFFFF" />
              <Text style={cardStyles.startButtonText}>Start Session</Text>
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
    opacity: 0.4,
  },
  startButtonText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#FFFFFF',
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
        <SessionChat sessionId={sessionId} />
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

// ─── Main Component ───────────────────────────────────────────────────────────

type SessionTab = 'active' | 'completed';

/**
 * CHW Sessions screen — lists active and completed sessions with:
 * - Live timer for in-progress sessions
 * - Consent checkbox before starting
 * - Chat modal for active sessions
 * - Documentation modal for completed sessions
 */
export function CHWSessionsScreen(): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<SessionTab>('active');

  const { data: rawSessions, isLoading, error, refetch } = useSessions();
  const refresh = useRefreshControl([refetch]);
  const startSession = useStartSession();
  const completeSession = useCompleteSession();
  const submitDocumentation = useSubmitDocumentation();

  // Tracks when sessions went in_progress locally (for live timer).
  // The API handles the actual status; this is just for the timer UX.
  const startTimestamps = useRef<Record<string, number>>({});

  // Consent checkbox state per session
  const [consentState, setConsentState] = useState<Record<string, boolean>>({});

  // Documentation modal state
  const [documentingSessionId, setDocumentingSessionId] = useState<string | null>(null);

  // Chat modal state
  const [chatSessionId, setChatSessionId] = useState<string | null>(null);

  const allSessions = rawSessions ?? [];

  const activeSessions = useMemo<SessionData[]>(
    () => allSessions.filter((s) => s.status === 'scheduled' || s.status === 'in_progress'),
    [allSessions],
  );

  const completedSessions = useMemo<SessionData[]>(
    () => allSessions.filter((s) => s.status === 'completed'),
    [allSessions],
  );

  const displayedSessions = activeTab === 'active' ? activeSessions : completedSessions;

  const handleConsentChange = useCallback((id: string, checked: boolean): void => {
    setConsentState((prev) => ({ ...prev, [id]: checked }));
  }, []);

  const handleStart = useCallback((id: string): void => {
    startTimestamps.current[id] = Date.now();
    void startSession.mutateAsync(id);
  }, [startSession]);

  const handleComplete = useCallback((id: string): void => {
    void completeSession.mutateAsync(id);
    setActiveTab('completed');
  }, [completeSession]);

  const handleDocumentSession = useCallback((id: string): void => {
    setDocumentingSessionId(id);
  }, []);

  const handleDocumentationSubmit = useCallback(
    (data: SessionDocumentation): void => {
      if (documentingSessionId != null) {
        void submitDocumentation.mutateAsync({
          sessionId: documentingSessionId,
          data: data as unknown as Record<string, unknown>,
        });
      }
      setDocumentingSessionId(null);
    },
    [documentingSessionId, submitDocumentation],
  );

  const handleOpenChat = useCallback((id: string): void => {
    setChatSessionId(id);
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: SessionData }) => (
      <SessionCard
        session={item}
        startedAtMs={
          item.status === 'in_progress' ? (startTimestamps.current[item.id] ?? Date.now()) : undefined
        }
        consentChecked={consentState[item.id] ?? false}
        onConsentChange={handleConsentChange}
        onStart={handleStart}
        onComplete={handleComplete}
        onDocumentSession={handleDocumentSession}
        onOpenChat={handleOpenChat}
      />
    ),
    [
      consentState,
      handleConsentChange,
      handleStart,
      handleComplete,
      handleDocumentSession,
      handleOpenChat,
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

      {/* Session list */}
      {displayedSessions.length > 0 ? (
        <FlatList<SessionData>
          data={displayedSessions}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          refreshControl={refresh.control}
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

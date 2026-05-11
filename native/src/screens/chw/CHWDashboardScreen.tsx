/**
 * CHWDashboardScreen — Landing screen for authenticated Community Health Workers.
 *
 * Re-skinned to the new design system (AppShell + StatTile + Card + Pill + PageHeader).
 * Behavior, hooks, mutations, and navigation are identical to the original.
 *
 * Layout (web):
 *  - 4 KPI StatTiles in a 2×2 grid (Sessions today, Overdue follow-ups,
 *    Messages awaiting reply, Earnings this week)
 *  - 2-column row: Today's Schedule (left) + Needs Your Attention (right)
 *  - Bottom row: Weekly Snapshot + Recent Activity feed
 *
 * On native: AppShell is a passthrough — the existing navigator provides chrome.
 */

import React, { useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Platform,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import {
  DollarSign,
  Star,
  CalendarCheck,
  ClipboardList,
  Home,
  Heart,
  Utensils,
  Brain,
  Stethoscope,
  RefreshCw,
  ClipboardCheck,
  ArrowRight,
  MapPin,
  Target,
  Clock,
  AlertCircle,
  MessageSquare,
  TrendingUp,
} from 'lucide-react-native';

import { colors as themeColors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import { colors as tokens } from '../../theme/tokens';
import { useAuth } from '../../context/AuthContext';
import {
  formatCurrency,
  type Vertical,
} from '../../data/mock';
import {
  useChwEarnings,
  useSessions,
  useRequests,
  useCHWIntake,
  type SessionData,
  type ServiceRequestData,
} from '../../hooks/useApiQueries';
import { useRefreshControl } from '../../hooks/useRefreshControl';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';
import { VERTICAL_LABEL, VERTICAL_COLOR } from '../../lib/verticals';

import {
  AppShell,
  PageHeader,
  Card,
  StatTile,
  Pill,
} from '../../components/ui';

// ─── Vertical helpers — sourced from lib/verticals (single source of truth) ───

const VERTICAL_COLORS: Record<Vertical, string> = VERTICAL_COLOR;
const VERTICAL_LABELS: Record<Vertical, string> = VERTICAL_LABEL;

const SESSION_MODE_LABELS: Record<string, string> = {
  in_person: 'In Person',
  virtual: 'Video Call',
  phone: 'Phone',
};

// ─── VerticalIcon sub-component ───────────────────────────────────────────────

interface VerticalIconProps {
  vertical: Vertical;
  size?: number;
  color?: string;
}

function VerticalIconComponent({ vertical, size = 18, color }: VerticalIconProps): React.JSX.Element {
  const iconColor = color ?? VERTICAL_COLORS[vertical];
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

// ─── Member need-journey status (mocked until backend lands) ──────────────────
//
// TODO(backend): expose member_journey_status per session/request as one of
// 'starting' | 'awaiting_confirmation' | 'resolved'. Until then, derive a
// stable mock from the entity id so the same row always shows the same dot.

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

/**
 * Maps a JourneyStatus to the Pill variant colours.
 */
function journeyStatusToPillVariant(status: JourneyStatus): 'red' | 'amber' | 'emerald' {
  if (status === 'starting') return 'red';
  if (status === 'awaiting_confirmation') return 'amber';
  return 'emerald';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Formats an ISO date string to a human-readable date + time.
 */
function formatScheduledAt(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function CHWDashboardScreen(): React.JSX.Element {
  const { userName } = useAuth();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const navigation = useNavigation<any>();
  const firstName = userName?.split(' ')[0] ?? 'there';

  // Derive initials for AppShell userBlock
  const initials = useMemo(() => {
    if (!userName) return 'CW';
    return userName
      .split(' ')
      .map((n) => n[0] ?? '')
      .join('')
      .toUpperCase()
      .slice(0, 2);
  }, [userName]);

  const earningsQuery = useChwEarnings();
  const sessionsQuery = useSessions();
  const requestsQuery = useRequests();
  const intakeQuery = useCHWIntake();

  const isLoading = earningsQuery.isLoading || sessionsQuery.isLoading || requestsQuery.isLoading;
  const queryError = earningsQuery.error ?? sessionsQuery.error ?? requestsQuery.error;

  const intake = intakeQuery.data;
  const intakeIncomplete = intake != null && !intake.completedAt;
  const intakeSectionsDone = intake?.lastCompletedSection ?? 0;

  const handleRetry = () => {
    void earningsQuery.refetch();
    void sessionsQuery.refetch();
    void requestsQuery.refetch();
  };

  const refresh = useRefreshControl([
    earningsQuery.refetch,
    sessionsQuery.refetch,
    requestsQuery.refetch,
    intakeQuery.refetch,
  ]);

  const earnings = earningsQuery.data;
  const allSessions = sessionsQuery.data ?? [];
  const allRequests = requestsQuery.data ?? [];

  const openRequests = useMemo<ServiceRequestData[]>(
    () => allRequests.filter((r) => r.status === 'open'),
    [allRequests],
  );

  const upcomingSession = useMemo<SessionData | undefined>(
    () => allSessions.find((s) => s.status === 'scheduled'),
    [allSessions],
  );

  const recentRequests = useMemo<ServiceRequestData[]>(
    () => openRequests.slice(0, 3),
    [openRequests],
  );

  // KPI derivations for the 4 StatTile row
  // Sessions today: scheduled sessions for today's date
  const todaySessions = useMemo<number>(() => {
    const today = new Date().toDateString();
    return allSessions.filter(
      (s) => s.status === 'scheduled' && new Date(s.scheduledAt).toDateString() === today,
    ).length;
  }, [allSessions]);

  // Overdue follow-ups: open requests older than 48 h (best proxy until backend exposes it)
  // TODO(backend): expose overdue_followups_count from /chw/dashboard/stats
  const overdueFollowups = useMemo<number>(() => {
    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
    return openRequests.filter(
      (r) => r.urgency === 'urgent' || new Date(r.createdAt ?? 0).getTime() < cutoff,
    ).length;
  }, [openRequests]);

  if (isLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
          <View style={styles.pageWrap}>
            <LoadingSkeleton variant="stat-grid" />
            <LoadingSkeleton variant="rows" rows={2} />
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (queryError) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <ErrorState message="Failed to load dashboard" onRetry={handleRetry} />
      </SafeAreaView>
    );
  }

  const screenContent = (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={Platform.OS === 'web' ? styles.contentWeb : styles.content}
      showsVerticalScrollIndicator={false}
      refreshControl={refresh.control}
    >
      <View style={Platform.OS === 'web' ? styles.pageWrapWeb : styles.pageWrap}>

        {/* ── Page header ── */}
        <PageHeader
          title={`Good morning, ${firstName}`}
          subtitle="Here's what's happening with your work today."
        />

        {/* ── Professional intake prompt (only while incomplete) ── */}
        {intakeIncomplete && (
          <TouchableOpacity
            style={styles.intakeBanner}
            onPress={() => navigation.navigate('Intake')}
            accessibilityRole="button"
            accessibilityLabel="Complete your professional intake"
            activeOpacity={0.85}
          >
            <View style={styles.intakeIconWrap}>
              <ClipboardCheck size={20} color={themeColors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.intakeTitle}>Complete your professional intake</Text>
              <Text style={styles.intakeSubtitle}>
                {intakeSectionsDone > 0
                  ? `${intakeSectionsDone} of 6 sections complete — resume where you left off`
                  : '27 quick questions help us match you with the right members'}
              </Text>
            </View>
            <ArrowRight size={18} color={themeColors.primary} />
          </TouchableOpacity>
        )}

        {/* ── KPI stat tiles — 4-up grid ── */}
        <View style={styles.statGrid}>
          <StatTile
            icon={<CalendarCheck size={18} color={tokens.emerald700} />}
            iconBg={tokens.emerald100}
            label="Sessions Today"
            value={todaySessions}
            delta={`${allSessions.filter((s) => s.status === 'scheduled').length} this week`}
            style={styles.statTile}
          />
          <StatTile
            icon={<AlertCircle size={18} color={tokens.red700} />}
            iconBg={tokens.red100}
            label="Overdue Follow-ups"
            value={overdueFollowups}
            delta={overdueFollowups > 0 ? 'Needs attention' : 'All clear'}
            deltaColor={overdueFollowups > 0 ? tokens.red700 : tokens.emerald700}
            style={styles.statTile}
          />
          <StatTile
            icon={<MessageSquare size={18} color={tokens.blue700} />}
            iconBg={tokens.blue100}
            label="Open Requests"
            value={openRequests.length}
            delta="Awaiting match"
            deltaColor={tokens.blue700}
            style={styles.statTile}
          />
          <StatTile
            icon={<DollarSign size={18} color={tokens.emerald700} />}
            iconBg={tokens.emerald100}
            label="Earnings This Week"
            value={earnings ? formatCurrency(earnings.thisMonth) : '$0.00'}
            delta={earnings ? `${formatCurrency(earnings.pendingPayout)} pending` : ''}
            style={styles.statTile}
          />
        </View>

        {/* ── Two-column layout (web) / stacked (native) ── */}
        <View style={styles.midRow}>

          {/* ── Left column: Today's Schedule (Upcoming Session) ── */}
          <View style={styles.midLeft}>
            <Text style={styles.sectionTitle}>Today's Schedule</Text>
            {upcomingSession ? (
              <Card style={styles.card}>
                <View style={styles.sessionRow}>
                  <View
                    style={[
                      styles.verticalIconCircle,
                      { backgroundColor: (VERTICAL_COLORS[upcomingSession.vertical as Vertical] ?? '#6B7A6B') + '18' },
                    ]}
                  >
                    <VerticalIconComponent vertical={upcomingSession.vertical as Vertical} size={20} />
                  </View>
                  <View style={styles.sessionInfo}>
                    <View style={styles.badgeRow}>
                      <Pill variant="emerald" size="sm">
                        {VERTICAL_LABELS[upcomingSession.vertical as Vertical] ?? upcomingSession.vertical}
                      </Pill>
                      <Pill variant="blue" size="sm">Scheduled</Pill>
                      {(() => {
                        const status = mockJourneyStatus(upcomingSession.id);
                        return (
                          <Pill variant={journeyStatusToPillVariant(status)} size="sm">
                            {JOURNEY_LABELS[status]}
                          </Pill>
                        );
                      })()}
                    </View>
                    <Text style={styles.memberName}>{upcomingSession.memberName}</Text>
                    <Text style={styles.sessionMeta}>
                      {formatScheduledAt(upcomingSession.scheduledAt)}
                      {' · '}
                      {SESSION_MODE_LABELS[upcomingSession.mode] ?? upcomingSession.mode}
                    </Text>
                    {/* Member address — TODO(backend): expose member.address on SessionData. */}
                    <View style={styles.metaIconRow}>
                      <MapPin size={12} color={themeColors.mutedForeground} />
                      <Text style={styles.sessionMeta}>
                        1834 W 6th St, Los Angeles, CA 90057
                      </Text>
                    </View>
                    {/* Session goal — TODO(backend): expose session.goal_note. */}
                    <View style={styles.actionNote}>
                      <Target size={12} color={themeColors.primary} />
                      <Text style={styles.actionNoteText}>
                        Goal: walk through Medi-Cal renewal paperwork together.
                      </Text>
                    </View>
                  </View>
                </View>
              </Card>
            ) : (
              <Card style={styles.card}>
                <Text style={styles.emptyText}>No sessions scheduled today.</Text>
              </Card>
            )}
          </View>

          {/* ── Right column: Needs Your Attention (Open Requests) ── */}
          <View style={styles.midRight}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Needs Your Attention</Text>
              {openRequests.length > 0 && (
                <Pill variant="amber" size="sm">{openRequests.length}</Pill>
              )}
            </View>
            <Card style={styles.card}>
              {recentRequests.length === 0 ? (
                <Text style={styles.emptyText}>No open requests right now.</Text>
              ) : (
                recentRequests.map((request, index) => {
                  const verticalLabel = VERTICAL_LABELS[request.vertical as Vertical] ?? request.vertical;
                  const verticalColor = VERTICAL_COLORS[request.vertical as Vertical] ?? '#6B7A6B';
                  return (
                    <View key={request.id}>
                      {index > 0 ? <View style={styles.divider} /> : null}
                      <View style={styles.requestRow}>
                        <View
                          style={[
                            styles.verticalIconCircle,
                            { backgroundColor: verticalColor + '18' },
                          ]}
                        >
                          <VerticalIconComponent vertical={request.vertical as Vertical} size={18} />
                        </View>
                        <View style={styles.requestInfo}>
                          <View style={styles.badgeRow}>
                            <Text style={styles.memberName}>{request.memberName}</Text>
                            <Pill variant="gray" size="sm">{verticalLabel}</Pill>
                          </View>
                          <Text style={styles.requestDescription} numberOfLines={2}>
                            {request.description}
                          </Text>
                          {/* Mode + member-requested time. TODO(backend): expose request.preferred_time. */}
                          <View style={styles.metaIconRow}>
                            <Clock size={12} color={themeColors.mutedForeground} />
                            <Text style={styles.sessionMeta}>
                              {SESSION_MODE_LABELS[request.preferredMode] ?? request.preferredMode}
                              {' · Wants Thu 5:30 PM'}
                            </Text>
                          </View>
                        </View>
                      </View>
                    </View>
                  );
                })
              )}
            </Card>
          </View>
        </View>

        {/* ── Bottom row: Weekly Snapshot + Recent Activity ── */}
        <View style={styles.bottomRow}>
          {/* Weekly Snapshot */}
          <Card style={[styles.card, styles.bottomCard]}>
            <View style={styles.cardHeader}>
              <TrendingUp size={16} color={themeColors.primary} />
              <Text style={styles.cardTitle}>Weekly Snapshot</Text>
            </View>
            <View style={styles.snapshotGrid}>
              <View style={styles.snapshotItem}>
                <Text style={styles.snapshotValue}>
                  {earnings ? earnings.sessionsThisWeek : 0}
                </Text>
                <Text style={styles.snapshotLabel}>Sessions</Text>
              </View>
              <View style={styles.snapshotItem}>
                <Text style={styles.snapshotValue}>
                  {earnings ? earnings.avgRating.toFixed(1) : '—'}
                </Text>
                <View style={styles.metaIconRow}>
                  <Star size={11} color={themeColors.compassGold} />
                  <Text style={styles.snapshotLabel}>Avg Rating</Text>
                </View>
              </View>
              <View style={styles.snapshotItem}>
                <Text style={styles.snapshotValue}>{openRequests.length}</Text>
                <Text style={styles.snapshotLabel}>Open Requests</Text>
              </View>
            </View>
          </Card>

          {/* Recent Activity */}
          <Card style={[styles.card, styles.bottomCard]}>
            <View style={styles.cardHeader}>
              <Heart size={16} color={themeColors.primary} />
              <Text style={styles.cardTitle}>Recent Activity</Text>
            </View>
            {allSessions.slice(0, 3).length === 0 ? (
              <Text style={styles.emptyText}>No recent activity.</Text>
            ) : (
              allSessions.slice(0, 3).map((session, index) => (
                <View key={session.id}>
                  {index > 0 ? <View style={styles.divider} /> : null}
                  <View style={styles.activityRow}>
                    <View style={styles.activityDot} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.activityText} numberOfLines={1}>
                        {session.memberName}
                      </Text>
                      <Text style={styles.activityMeta}>
                        {SESSION_MODE_LABELS[session.mode] ?? session.mode}
                        {' · '}
                        {formatScheduledAt(session.scheduledAt)}
                      </Text>
                    </View>
                    <Pill
                      variant={session.status === 'completed' ? 'emerald' : session.status === 'cancelled' ? 'red' : 'blue'}
                      size="sm"
                    >
                      {session.status}
                    </Pill>
                  </View>
                </View>
              ))
            )}
          </Card>
        </View>

        {/* Rate footnote removed per Jemal's feedback (was misleading). */}
      </View>
    </ScrollView>
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <AppShell
        role="chw"
        activeKey="dashboard"
        userBlock={{ initials, name: userName ?? 'CHW', role: 'CHW' }}
      >
        {screenContent}
      </AppShell>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: tokens.pageBg,
  } as ViewStyle,
  scroll: {
    flex: 1,
  } as ViewStyle,
  content: {
    flexGrow: 1,
    alignItems: 'center',
  } as ViewStyle,
  contentWeb: {
    flexGrow: 1,
  } as ViewStyle,
  pageWrap: {
    width: '100%',
    maxWidth: 960,
    alignSelf: 'center',
    padding: 20,
    paddingBottom: 40,
  } as ViewStyle,
  pageWrapWeb: {
    width: '100%',
    maxWidth: 1100,
    alignSelf: 'center',
    paddingBottom: 40,
  } as ViewStyle,

  // ── Intake banner
  intakeBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: 14,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: themeColors.primary + '40',
    marginBottom: 20,
  } as ViewStyle,
  intakeIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: themeColors.primary + '18',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,
  intakeTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
    color: themeColors.foreground,
  } as TextStyle,
  intakeSubtitle: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: themeColors.mutedForeground,
    marginTop: 2,
    lineHeight: 16,
  } as TextStyle,

  // ── KPI grid
  statGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginBottom: 24,
  } as ViewStyle,
  statTile: {
    // Each tile takes ~47% width — same as original StatCard sizing.
    // On web AppShell provides wider canvas so 4 can fit in a row.
    minWidth: 160,
    flex: 1,
  } as ViewStyle,

  // ── Mid row (two-column on web, stacked on native)
  midRow: {
    flexDirection: Platform.OS === 'web' ? 'row' : 'column',
    gap: 16,
    marginBottom: 24,
  } as ViewStyle,
  midLeft: {
    flex: Platform.OS === 'web' ? 7 : undefined,
  } as ViewStyle,
  midRight: {
    flex: Platform.OS === 'web' ? 5 : undefined,
  } as ViewStyle,

  // ── Bottom row
  bottomRow: {
    flexDirection: Platform.OS === 'web' ? 'row' : 'column',
    gap: 16,
  } as ViewStyle,
  bottomCard: {
    flex: 1,
    padding: 16,
  } as ViewStyle,

  // ── Section headings
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  } as ViewStyle,
  sectionTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    lineHeight: 22,
    color: '#1E3320',
    marginBottom: 12,
  } as TextStyle,

  // ── Card surface
  card: {
    padding: 16,
  } as ViewStyle,

  // ── Card inner header row
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  } as ViewStyle,
  cardTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
    color: '#1E3320',
  } as TextStyle,

  // ── Session row
  sessionRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  } as ViewStyle,
  verticalIconCircle: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    backgroundColor: '#3D5A3E15',
  } as ViewStyle,
  sessionInfo: {
    flex: 1,
    gap: 4,
  } as ViewStyle,
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 4,
  } as ViewStyle,
  memberName: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    lineHeight: 22,
    color: '#1E3320',
  } as TextStyle,
  sessionMeta: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    letterSpacing: 1,
    color: '#6B7A6B',
    marginTop: 2,
  } as TextStyle,
  metaIconRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 2,
  } as ViewStyle,
  actionNote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: themeColors.primary + '0D',
    borderLeftWidth: 3,
    borderLeftColor: themeColors.primary,
  } as ViewStyle,
  actionNoteText: {
    flex: 1,
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    color: themeColors.foreground,
    lineHeight: 16,
  } as TextStyle,

  // ── Request rows
  requestRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 4,
  } as ViewStyle,
  requestInfo: {
    flex: 1,
    gap: 4,
  } as ViewStyle,
  requestDescription: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#6B7A6B',
    lineHeight: 20,
  } as TextStyle,

  // ── Snapshot grid
  snapshotGrid: {
    flexDirection: 'row',
    gap: 12,
  } as ViewStyle,
  snapshotItem: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
  } as ViewStyle,
  snapshotValue: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 22,
    color: '#1E3320',
  } as TextStyle,
  snapshotLabel: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#6B7A6B',
  } as TextStyle,

  // ── Activity feed
  activityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
  } as ViewStyle,
  activityDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: themeColors.primary,
    flexShrink: 0,
  } as ViewStyle,
  activityText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: '#1E3320',
  } as TextStyle,
  activityMeta: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#6B7A6B',
  } as TextStyle,

  // ── Shared
  divider: {
    height: 1,
    backgroundColor: '#DDD6CC',
    marginVertical: 8,
  } as ViewStyle,
  emptyText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#6B7A6B',
    textAlign: 'center',
    paddingVertical: 8,
  } as TextStyle,
});

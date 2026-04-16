/**
 * CHWDashboardScreen — Landing screen for authenticated Community Health Workers.
 *
 * Sections:
 *  - Personalised greeting derived from auth context
 *  - 2×2 stat card grid: month earnings, avg rating, sessions this week, open requests
 *  - Upcoming scheduled session card (if any)
 *  - Recent open requests (top 3)
 */

import React, { useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
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
} from 'lucide-react-native';

import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import { useAuth } from '../../context/AuthContext';
import {
  formatCurrency,
  MEDI_CAL_RATE,
  NET_PAYOUT_RATE,
  type Vertical,
} from '../../data/mock';
import {
  useChwEarnings,
  useSessions,
  useRequests,
  type SessionData,
  type ServiceRequestData,
} from '../../hooks/useApiQueries';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';

// ─── Vertical helpers ─────────────────────────────────────────────────────────

const VERTICAL_COLORS: Record<Vertical, string> = {
  housing: '#3B82F6',
  rehab: '#EF4444',
  food: '#F59E0B',
  mental_health: '#8B5CF6',
  healthcare: '#06B6D4',
};

const VERTICAL_LABELS: Record<Vertical, string> = {
  housing: 'Housing',
  rehab: 'Rehab',
  food: 'Food',
  mental_health: 'Mental Health',
  healthcare: 'Healthcare',
};

const URGENCY_COLORS: Record<string, string> = {
  routine: colors.secondary,
  soon: colors.compassGold,
  urgent: colors.destructive,
};

const URGENCY_LABELS: Record<string, string> = {
  routine: 'Routine',
  soon: 'Soon',
  urgent: 'Urgent',
};

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

// ─── StatCard sub-component ───────────────────────────────────────────────────

interface StatCardProps {
  icon: React.ReactNode;
  iconBg: string;
  label: string;
  value: string | number;
  subtext?: string;
}

function StatCard({ icon, iconBg, label, value, subtext }: StatCardProps): React.JSX.Element {
  return (
    <View style={styles.statCard}>
      <View style={[styles.statIconCircle, { backgroundColor: iconBg }]}>{icon}</View>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
      {subtext ? <Text style={styles.statSubtext}>{subtext}</Text> : null}
    </View>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

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

export function CHWDashboardScreen(): React.JSX.Element {
  const { userName } = useAuth();
  const firstName = userName?.split(' ')[0] ?? 'there';

  const earningsQuery = useChwEarnings();
  const sessionsQuery = useSessions();
  const requestsQuery = useRequests();

  const isLoading = earningsQuery.isLoading || sessionsQuery.isLoading || requestsQuery.isLoading;
  const queryError = earningsQuery.error ?? sessionsQuery.error ?? requestsQuery.error;

  const handleRetry = () => {
    void earningsQuery.refetch();
    void sessionsQuery.refetch();
    void requestsQuery.refetch();
  };

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

  if (isLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
          <LoadingSkeleton variant="stat-grid" />
          <LoadingSkeleton variant="rows" rows={2} />
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

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Greeting ── */}
        <View style={styles.greetingBlock}>
          <Text style={styles.greetingText}>
            Good morning,{' '}
            <Text style={styles.greetingName}>{firstName}</Text>
          </Text>
          <Text style={styles.greetingSubtext}>
            Here's what's happening with your work today.
          </Text>
        </View>

        {/* ── Stat cards 2×2 ── */}
        <View style={styles.statGrid}>
          <StatCard
            icon={<DollarSign size={20} color={colors.primary} />}
            iconBg={colors.primary + '18'}
            label="This Month"
            value={earnings ? formatCurrency(earnings.thisMonth) : '$0.00'}
            subtext={earnings ? `${formatCurrency(earnings.pendingPayout)} pending` : ''}
          />
          <StatCard
            icon={<Star size={20} color={colors.compassGold} />}
            iconBg={colors.compassGold + '18'}
            label="Avg Rating"
            value={earnings ? earnings.avgRating.toFixed(1) : '—'}
            subtext="From reviews"
          />
          <StatCard
            icon={<CalendarCheck size={20} color={colors.secondary} />}
            iconBg={colors.secondary + '18'}
            label="Sessions"
            value={earnings ? earnings.sessionsThisWeek : 0}
            subtext="This week"
          />
          <StatCard
            icon={<ClipboardList size={20} color={colors.primary} />}
            iconBg={colors.primary + '18'}
            label="Open Requests"
            value={openRequests.length}
            subtext="Awaiting match"
          />
        </View>

        {/* ── Upcoming Session ── */}
        {upcomingSession ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Upcoming Session</Text>
            <View style={styles.card}>
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
                    <View
                      style={[
                        styles.badge,
                        { backgroundColor: (VERTICAL_COLORS[upcomingSession.vertical as Vertical] ?? '#6B7A6B') + '18' },
                      ]}
                    >
                      <Text
                        style={[
                          styles.badgeText,
                          { color: VERTICAL_COLORS[upcomingSession.vertical as Vertical] ?? '#6B7A6B' },
                        ]}
                      >
                        {VERTICAL_LABELS[upcomingSession.vertical as Vertical] ?? upcomingSession.vertical}
                      </Text>
                    </View>
                    <View style={[styles.badge, { backgroundColor: colors.secondary + '18' }]}>
                      <Text style={[styles.badgeText, { color: colors.secondary }]}>Scheduled</Text>
                    </View>
                  </View>
                  <Text style={styles.memberName}>{upcomingSession.memberName}</Text>
                  <Text style={styles.sessionMeta}>
                    {formatScheduledAt(upcomingSession.scheduledAt)}
                    {' · '}
                    {SESSION_MODE_LABELS[upcomingSession.mode] ?? upcomingSession.mode}
                  </Text>
                </View>
              </View>
            </View>
          </View>
        ) : null}

        {/* ── Open Requests ── */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Open Requests Near You</Text>
          </View>
          <View style={styles.card}>
            {recentRequests.length === 0 ? (
              <Text style={styles.emptyText}>No open requests right now.</Text>
            ) : (
              recentRequests.map((request, index) => (
                <View key={request.id}>
                  {index > 0 ? <View style={styles.divider} /> : null}
                  <View style={styles.requestRow}>
                    <View
                      style={[
                        styles.verticalIconCircle,
                        { backgroundColor: (VERTICAL_COLORS[request.vertical as Vertical] ?? '#6B7A6B') + '18' },
                      ]}
                    >
                      <VerticalIconComponent vertical={request.vertical as Vertical} size={18} />
                    </View>
                    <View style={styles.requestInfo}>
                      <View style={styles.badgeRow}>
                        <Text style={styles.memberName}>{request.memberName}</Text>
                        <View
                          style={[
                            styles.badge,
                            {
                              backgroundColor: (URGENCY_COLORS[request.urgency] ?? '#6B7A6B') + '18',
                            },
                          ]}
                        >
                          <Text
                            style={[
                              styles.badgeText,
                              { color: URGENCY_COLORS[request.urgency] ?? '#6B7A6B' },
                            ]}
                          >
                            {URGENCY_LABELS[request.urgency] ?? request.urgency}
                          </Text>
                        </View>
                      </View>
                      <Text style={styles.requestDescription} numberOfLines={2}>
                        {request.description}
                      </Text>
                      <Text style={styles.sessionMeta}>
                        {SESSION_MODE_LABELS[request.preferredMode] ?? request.preferredMode}
                        {' · '}~{request.estimatedUnits} units
                        {' · '}
                        {formatCurrency(
                          request.estimatedUnits * MEDI_CAL_RATE * NET_PAYOUT_RATE,
                        )}{' '}
                        net
                      </Text>
                    </View>
                  </View>
                </View>
              ))
            )}
          </View>
        </View>

        {/* ── Rate footnote ── */}
        <Text style={styles.footnote}>
          Rates reflect $26.66/unit Medi-Cal reimbursement · 85% CHW net payout.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#F4F1ED',
  },
  scroll: {
    flex: 1,
  },
  content: {
    padding: 20,
    paddingBottom: 40,
  },
  greetingBlock: {
    marginBottom: 24,
  },
  greetingText: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 24,
    lineHeight: 30,
    color: '#1E3320',
  },
  greetingName: {
    color: '#7A9F5A',
  },
  greetingSubtext: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 16,
    lineHeight: 24,
    color: '#6B7A6B',
    marginTop: 4,
  },
  statGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginBottom: 24,
  },
  statCard: {
    width: '47%',
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    padding: 16,
    shadowColor: '#3D5A3E',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 24,
    elevation: 3,
  },
  statIconCircle: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
    backgroundColor: '#3D5A3E15',
  },
  statValue: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 24,
    lineHeight: 30,
    color: '#1E3320',
  },
  statLabel: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#6B7A6B',
    marginTop: 2,
  },
  statSubtext: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    letterSpacing: 1,
    color: '#7A9F5A',
    marginTop: 2,
  },
  section: {
    marginBottom: 24,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  sectionTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    lineHeight: 22,
    color: '#1E3320',
    marginBottom: 12,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    padding: 16,
    shadowColor: '#3D5A3E',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 24,
    elevation: 3,
  },
  sessionRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  verticalIconCircle: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    backgroundColor: '#3D5A3E15',
  },
  sessionInfo: {
    flex: 1,
    gap: 4,
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 4,
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
  memberName: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    lineHeight: 22,
    color: '#1E3320',
  },
  sessionMeta: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    letterSpacing: 1,
    color: '#6B7A6B',
    marginTop: 2,
  },
  requestRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 4,
  },
  requestInfo: {
    flex: 1,
    gap: 4,
  },
  requestDescription: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#6B7A6B',
    lineHeight: 20,
  },
  divider: {
    height: 1,
    backgroundColor: '#DDD6CC',
    marginVertical: 12,
  },
  emptyText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#6B7A6B',
    textAlign: 'center',
    paddingVertical: 8,
  },
  footnote: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    letterSpacing: 1,
    color: '#6B7A6B',
    textAlign: 'center',
    marginTop: 4,
  },
});

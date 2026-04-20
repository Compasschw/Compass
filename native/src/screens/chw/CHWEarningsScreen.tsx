/**
 * CHWEarningsScreen — Money dashboard for CHW users.
 *
 * Sections:
 *  1. Three stat cards: This Week, This Month, All Time
 *  2. View-based weekly bar chart (no charting library dependency)
 *  3. Recent payouts list with payout status badges
 *  4. Medi-Cal rate / payout schedule note
 */

import React, { useMemo } from 'react';
import {
  Pressable,
  View,
  Text,
  ScrollView,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import {
  ArrowRight,
  DollarSign,
  TrendingUp,
  CalendarCheck,
  Banknote,
  CreditCard,
  Home,
  RefreshCw,
  Utensils,
  Brain,
  Stethoscope,
  TableProperties,
} from 'lucide-react-native';

import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import {
  formatCurrency,
  MEDI_CAL_RATE,
  sessionModeLabels,
  type Vertical,
} from '../../data/mock';
import {
  useChwEarnings,
  usePaymentsAccountStatus,
  useSessions,
  type SessionData,
} from '../../hooks/useApiQueries';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';

// ─── Earnings scenario constants ─────────────────────────────────────────────

/** Phase 1 net payout rate (72% of gross billing). */
const PHASE_1_RATE = 0.72;

/** Phase 2 net payout rate (82.6% of gross billing). */
const PHASE_2_RATE = 0.826;

interface EarningsScenario {
  label: string;
  unitsPerDay: number;
}

const EARNINGS_SCENARIOS: EarningsScenario[] = [
  { label: 'Light', unitsPerDay: 2 },
  { label: 'Moderate', unitsPerDay: 8 },
  { label: 'Full', unitsPerDay: 18 },
  { label: 'Max Daily', unitsPerDay: 20 },
];

// ─── Constants ────────────────────────────────────────────────────────────────

const VERTICAL_COLORS: Record<Vertical, string> = {
  housing: '#3B82F6',
  rehab: '#EF4444',
  food: '#F59E0B',
  mental_health: '#8B5CF6',
  healthcare: '#06B6D4',
};

type PayoutStatus = 'pending' | 'submitted' | 'approved';

const PAYOUT_STATUS_COLORS: Record<PayoutStatus, string> = {
  pending: colors.compassGold,
  submitted: colors.secondary,
  approved: colors.primary,
};

const PAYOUT_STATUS_LABELS: Record<PayoutStatus, string> = {
  pending: 'Pending',
  submitted: 'Submitted',
  approved: 'Approved',
};

/**
 * Mock weekly bar chart data derived from completed sessions.
 */
const WEEKLY_DATA = [
  { day: 'Mon', amount: 90.64 },
  { day: 'Tue', amount: 0 },
  { day: 'Wed', amount: 45.32 },
  { day: 'Thu', amount: 67.98 },
  { day: 'Fri', amount: 0 },
  { day: 'Sat', amount: 0 },
  { day: 'Sun', amount: 0 },
];

/**
 * Derives a mock payout status from session ID for demo purposes.
 */
function derivePayoutStatus(sessionId: string): PayoutStatus {
  const map: Record<string, PayoutStatus> = {
    'sess-002': 'submitted',
    'sess-003': 'approved',
    'sess-004': 'approved',
  };
  return map[sessionId] ?? 'pending';
}

function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

// ─── VerticalIcon helper ──────────────────────────────────────────────────────

function VerticalIconComponent({
  vertical,
  size = 16,
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

// ─── Main Component ───────────────────────────────────────────────────────────

/**
 * CHW Earnings screen — tracks Medi-Cal reimbursements and payout history.
 */
export function CHWEarningsScreen(): React.JSX.Element {
  const navigation = useNavigation();
  const earningsQuery = useChwEarnings();
  const sessionsQuery = useSessions();
  const payoutsQuery = usePaymentsAccountStatus();
  const payoutsEnabled = payoutsQuery.data?.payoutsEnabled === true;
  const payoutsInProgress =
    !!payoutsQuery.data?.accountId && !payoutsQuery.data.payoutsEnabled;

  const isLoading = earningsQuery.isLoading || sessionsQuery.isLoading;
  const queryError = earningsQuery.error ?? sessionsQuery.error;

  const handleRetry = () => {
    void earningsQuery.refetch();
    void sessionsQuery.refetch();
  };

  const earnings = earningsQuery.data;
  const allSessions = sessionsQuery.data ?? [];

  const completedSessions = useMemo<SessionData[]>(
    () => allSessions.filter((s) => s.status === 'completed'),
    [allSessions],
  );

  const maxBarAmount = useMemo(
    () => Math.max(...WEEKLY_DATA.map((d) => d.amount), 1),
    [],
  );

  if (isLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
          <LoadingSkeleton variant="stat-grid" />
          <LoadingSkeleton variant="rows" rows={3} />
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (queryError) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <ErrorState message="Failed to load earnings" onRetry={handleRetry} />
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
        {/* Page header */}
        <View style={styles.pageHeader}>
          <Text style={styles.pageTitle}>Earnings & Payouts</Text>
          <Text style={styles.pageSubtitle}>
            Track your Medi-Cal reimbursements and payout history.
          </Text>
        </View>

        {/* ── Payout setup banner (only shown until payouts are enabled) ── */}
        {!payoutsEnabled && (
          <Pressable
            style={[
              styles.payoutBanner,
              payoutsInProgress && styles.payoutBannerPending,
            ]}
            onPress={() => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (navigation as any).navigate('Payments');
            }}
            accessibilityRole="button"
            accessibilityLabel={
              payoutsInProgress
                ? 'Continue payout setup'
                : 'Set up direct deposit'
            }
          >
            <View style={styles.payoutBannerIcon}>
              <CreditCard size={20} color="#FFFFFF" />
            </View>
            <View style={styles.payoutBannerContent}>
              <Text style={styles.payoutBannerTitle}>
                {payoutsInProgress
                  ? 'Finish setting up direct deposit'
                  : 'Set up direct deposit'}
              </Text>
              <Text style={styles.payoutBannerSubtitle}>
                {payoutsInProgress
                  ? 'Stripe needs a few more details before you can get paid'
                  : 'Connect your bank to start receiving Medi-Cal payouts'}
              </Text>
            </View>
            <ArrowRight size={20} color="#FFFFFF" />
          </Pressable>
        )}

        {/* ── Stat cards ── */}
        <View style={styles.statRow}>
          <View style={styles.statCard}>
            <View style={[styles.statIconCircle, { backgroundColor: colors.primary + '18' }]}>
              <DollarSign size={18} color={colors.primary} />
            </View>
            <Text style={styles.statValue}>{formatCurrency(earnings?.pendingPayout ?? 0)}</Text>
            <Text style={styles.statLabel}>Pending</Text>
            <Text style={styles.statSubtext}>
              {earnings?.sessionsThisWeek ?? 0} sessions this week
            </Text>
          </View>

          <View style={styles.statCard}>
            <View style={[styles.statIconCircle, { backgroundColor: colors.secondary + '18' }]}>
              <TrendingUp size={18} color={colors.secondary} />
            </View>
            <Text style={styles.statValue}>{formatCurrency(earnings?.thisMonth ?? 0)}</Text>
            <Text style={styles.statLabel}>This Month</Text>
            <Text style={styles.statSubtext}>+8% vs last month</Text>
          </View>

          <View style={styles.statCard}>
            <View style={[styles.statIconCircle, { backgroundColor: colors.compassGold + '18' }]}>
              <CalendarCheck size={18} color={colors.compassGold} />
            </View>
            <Text style={styles.statValue}>{formatCurrency(earnings?.allTime ?? 0)}</Text>
            <Text style={styles.statLabel}>All Time</Text>
            <Text style={styles.statSubtext}>
              {earnings?.avgRating.toFixed(1) ?? '—'} avg rating
            </Text>
          </View>
        </View>

        {/* ── Weekly bar chart ── */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Weekly Breakdown</Text>
          <View style={styles.barChartContainer}>
            {WEEKLY_DATA.map((d) => {
              const heightPct = d.amount > 0 ? Math.max((d.amount / maxBarAmount) * 100, 6) : 6;
              const hasAmount = d.amount > 0;
              return (
                <View key={d.day} style={styles.barColumn}>
                  <Text style={styles.barAmountLabel}>
                    {hasAmount ? formatCurrency(d.amount) : ''}
                  </Text>
                  <View style={styles.barTrack}>
                    <View
                      style={[
                        styles.barFill,
                        {
                          height: `${heightPct}%` as `${number}%`,
                          backgroundColor: hasAmount ? colors.primary : colors.primary + '28',
                        },
                      ]}
                    />
                  </View>
                  <Text style={styles.barDayLabel}>{d.day}</Text>
                </View>
              );
            })}
          </View>
        </View>

        {/* ── Recent payouts ── */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Recent Payouts</Text>
          {completedSessions.length === 0 ? (
            <View style={styles.emptyPayouts}>
              <DollarSign size={22} color={colors.mutedForeground} />
              <Text style={styles.emptyTitle}>No payouts yet</Text>
              <Text style={styles.emptySubtext}>Complete sessions to start earning.</Text>
            </View>
          ) : (
            completedSessions.map((session, index) => {
              const payoutStatus = derivePayoutStatus(session.id);
              const statusColor = PAYOUT_STATUS_COLORS[payoutStatus];
              const verticalColor = VERTICAL_COLORS[session.vertical as Vertical] ?? '#6B7A6B';
              return (
                <View key={session.id}>
                  {index > 0 ? <View style={styles.divider} /> : null}
                  <View style={styles.payoutRow}>
                    <View
                      style={[
                        styles.payoutIconCircle,
                        { backgroundColor: verticalColor + '18' },
                      ]}
                    >
                      <VerticalIconComponent vertical={session.vertical as Vertical} size={16} />
                    </View>
                    <View style={styles.payoutInfo}>
                      <Text style={styles.payoutMemberName} numberOfLines={1}>
                        {session.memberName}
                      </Text>
                      <Text style={styles.payoutMeta}>
                        {formatShortDate(session.scheduledAt)}
                        {session.unitsBilled != null
                          ? ` · ${session.unitsBilled} ${session.unitsBilled === 1 ? 'unit' : 'units'}`
                          : ''}
                        {' · '}
                        {sessionModeLabels[session.mode as keyof typeof sessionModeLabels] ?? session.mode}
                      </Text>
                    </View>
                    <View style={styles.payoutRight}>
                      <Text style={styles.payoutAmount}>
                        {formatCurrency(session.netAmount ?? 0)}
                      </Text>
                      <View style={[styles.badge, { backgroundColor: statusColor + '18' }]}>
                        <Text style={[styles.badgeText, { color: statusColor }]}>
                          {PAYOUT_STATUS_LABELS[payoutStatus]}
                        </Text>
                      </View>
                    </View>
                  </View>
                </View>
              );
            })
          )}
        </View>

        {/* ── Earnings scenarios table ── */}
        <View style={styles.card}>
          <View style={styles.scenarioHeaderRow}>
            <TableProperties size={16} color={colors.primary} />
            <Text style={styles.sectionTitle}>Earnings Scenarios</Text>
          </View>
          <Text style={styles.scenarioSubtitle}>
            Estimated daily earnings at various billing volumes (Medi-Cal rate: {formatCurrency(MEDI_CAL_RATE)}/unit).
          </Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.tableScroll}
            contentContainerStyle={styles.tableScrollContent}
          >
            {/* Table header */}
            <View>
              <View style={styles.tableRow}>
                <View style={[styles.tableCell, styles.tableCellHeader, styles.tableCellFirst]}>
                  <Text style={styles.tableHeaderText}>Scenario</Text>
                </View>
                <View style={[styles.tableCell, styles.tableCellHeader]}>
                  <Text style={styles.tableHeaderText}>Units/Day</Text>
                </View>
                <View style={[styles.tableCell, styles.tableCellHeader]}>
                  <Text style={styles.tableHeaderText}>Gross/Day</Text>
                </View>
                <View style={[styles.tableCell, styles.tableCellHeader]}>
                  <Text style={styles.tableHeaderText}>Net P1/Day</Text>
                </View>
                <View style={[styles.tableCell, styles.tableCellHeader]}>
                  <Text style={styles.tableHeaderText}>Net P2/Day</Text>
                </View>
              </View>
              {/* Table body */}
              {EARNINGS_SCENARIOS.map((scenario, index) => {
                const gross = scenario.unitsPerDay * MEDI_CAL_RATE;
                const netP1 = gross * PHASE_1_RATE;
                const netP2 = gross * PHASE_2_RATE;
                const isEven = index % 2 === 0;
                return (
                  <View
                    key={scenario.label}
                    style={[styles.tableRow, isEven && styles.tableRowShaded]}
                  >
                    <View style={[styles.tableCell, styles.tableCellFirst]}>
                      <Text style={styles.tableCellLabelText}>{scenario.label}</Text>
                    </View>
                    <View style={styles.tableCell}>
                      <Text style={styles.tableCellText}>{scenario.unitsPerDay}</Text>
                    </View>
                    <View style={styles.tableCell}>
                      <Text style={styles.tableCellText}>{formatCurrency(gross)}</Text>
                    </View>
                    <View style={styles.tableCell}>
                      <Text style={[styles.tableCellText, styles.tableCellNetP1]}>
                        {formatCurrency(netP1)}
                      </Text>
                    </View>
                    <View style={styles.tableCell}>
                      <Text style={[styles.tableCellText, styles.tableCellNetP2]}>
                        {formatCurrency(netP2)}
                      </Text>
                    </View>
                  </View>
                );
              })}
            </View>
          </ScrollView>
          {/* Phase footnote */}
          <View style={styles.phaseFootnote}>
            <Text style={styles.phaseFootnoteText}>
              <Text style={styles.phaseFootnoteBold}>Phase 1 (72%)</Text>
              {' '}— Launch rate during initial CHW onboarding period (first 6 months).{' '}
              <Text style={styles.phaseFootnoteBold}>Phase 2 (82.6%)</Text>
              {' '}— Graduated rate after performance milestones are met.
            </Text>
          </View>
        </View>

        {/* ── Payout schedule note ── */}
        <View style={styles.noteCard}>
          <View style={[styles.noteIconCircle, { backgroundColor: colors.primary + '18' }]}>
            <Banknote size={18} color={colors.primary} />
          </View>
          <Text style={styles.noteText}>
            <Text style={styles.noteBold}>Payout schedule: </Text>
            Payouts are processed weekly via direct deposit, every Friday for the prior week's
            approved sessions.
          </Text>
        </View>

        {/* Medi-Cal rate footnote */}
        <Text style={styles.footnote}>
          Rate: $26.66/unit (15 min) · Phase 1: 72% net · Phase 2: 82.6% net.
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
  pageHeader: {
    marginBottom: 20,
  },
  pageTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 24,
    lineHeight: 30,
    color: '#1E3320',
  },
  pageSubtitle: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 16,
    lineHeight: 24,
    color: '#6B7A6B',
    marginTop: 4,
  },
  payoutBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.primary,
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 20,
  },
  payoutBannerPending: {
    backgroundColor: colors.compassGold,
  },
  payoutBannerIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.22)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  payoutBannerContent: {
    flex: 1,
  },
  payoutBannerTitle: {
    fontFamily: 'DMSans_600SemiBold',
    fontSize: 15,
    color: '#FFFFFF',
    marginBottom: 2,
  },
  payoutBannerSubtitle: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: 'rgba(255,255,255,0.9)',
    lineHeight: 16,
  },
  statRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 20,
  },
  statCard: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    padding: 14,
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
    marginBottom: 10,
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
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    padding: 16,
    marginBottom: 20,
    shadowColor: '#3D5A3E',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 24,
    elevation: 3,
  },
  sectionTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    lineHeight: 22,
    color: '#1E3320',
    marginBottom: 16,
  },
  barChartContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    height: 140,
    gap: 6,
  },
  barColumn: {
    flex: 1,
    height: '100%',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 4,
  },
  barAmountLabel: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 8,
    color: '#6B7A6B',
    textAlign: 'center',
    lineHeight: 12,
    minHeight: 12,
  },
  barTrack: {
    flex: 1,
    width: '100%',
    justifyContent: 'flex-end',
  },
  barFill: {
    width: '100%',
    borderRadius: 6,
    minHeight: 6,
  },
  barDayLabel: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 10,
    color: '#6B7A6B',
    textAlign: 'center',
  },
  divider: {
    height: 1,
    backgroundColor: '#DDD6CC',
    marginVertical: 10,
  },
  payoutRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  payoutIconCircle: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    backgroundColor: '#3D5A3E15',
  },
  payoutInfo: {
    flex: 1,
    gap: 2,
  },
  payoutMemberName: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 16,
    lineHeight: 24,
    color: '#1E3320',
  },
  payoutMeta: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#6B7A6B',
  },
  payoutRight: {
    alignItems: 'flex-end',
    gap: 4,
    flexShrink: 0,
  },
  payoutAmount: {
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
  emptyPayouts: {
    alignItems: 'center',
    paddingVertical: 20,
    gap: 8,
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
  },
  noteCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    padding: 16,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    marginBottom: 16,
    shadowColor: '#3D5A3E',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 24,
    elevation: 3,
  },
  noteIconCircle: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    backgroundColor: '#3D5A3E15',
  },
  noteText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#6B7A6B',
    flex: 1,
    lineHeight: 20,
  },
  noteBold: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    color: '#1E3320',
  },
  footnote: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    letterSpacing: 1,
    color: '#6B7A6B',
    textAlign: 'center',
  },

  // ── Earnings scenario table ─────────────────────────────────────────────────
  scenarioHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  scenarioSubtitle: {
    ...typography.bodySm,
    color: colors.mutedForeground,
    marginBottom: 14,
  },
  tableScroll: {
    marginHorizontal: -4,
  },
  tableScrollContent: {
    paddingHorizontal: 4,
  },
  tableRow: {
    flexDirection: 'row',
  },
  tableRowShaded: {
    backgroundColor: colors.background,
  },
  tableCell: {
    width: 90,
    paddingVertical: 10,
    paddingHorizontal: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  tableCellFirst: {
    width: 100,
    alignItems: 'flex-start',
  },
  tableCellHeader: {
    borderBottomWidth: 2,
    borderBottomColor: colors.primary + '40',
    paddingBottom: 8,
  },
  tableHeaderText: {
    ...typography.label,
    color: colors.mutedForeground,
    textAlign: 'center',
  },
  tableCellText: {
    ...typography.bodySm,
    color: colors.foreground,
    fontWeight: '500',
    textAlign: 'center',
  },
  tableCellLabelText: {
    ...typography.bodySm,
    fontWeight: '700',
    color: colors.foreground,
  },
  tableCellNetP1: {
    color: colors.secondary,
    fontWeight: '700',
  },
  tableCellNetP2: {
    color: colors.primary,
    fontWeight: '700',
  },
  phaseFootnote: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  phaseFootnoteText: {
    ...typography.label,
    color: colors.mutedForeground,
    lineHeight: 18,
  },
  phaseFootnoteBold: {
    fontWeight: '700',
    color: colors.foreground,
  },
});

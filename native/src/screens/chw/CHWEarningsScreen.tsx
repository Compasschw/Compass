/**
 * CHWEarningsScreen — Money dashboard for CHW users.
 *
 * Sections:
 *  1. 4 KPI stat tiles (Earnings This Month, Pending Payout, Paid Out This Month, Claims Pending)
 *  2. 8/12 Earnings trend chart + 4/12 Bank & payout setup card
 *  3. Sessions billed table card
 *  4. Recent payouts card
 *  5. Earnings scenarios table
 *  6. Payout schedule note
 */

import React, { useMemo, useState } from 'react';
import {
  Pressable,
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
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
  CheckCircle,
  Clock,
} from 'lucide-react-native';

import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import {
  formatCurrency,
  MEDI_CAL_RATE,
  NET_PAYOUT_RATE,
  sessionModeLabels,
  type Vertical,
} from '../../data/mock';
import {
  useChwClaims,
  useChwEarnings,
  usePaymentsAccountStatus,
  useSessions,
  type ChwClaim,
  type SessionData,
} from '../../hooks/useApiQueries';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';
import {
  AppShell,
  PageHeader,
  Card,
  StatTile,
} from '../../components/ui';
import { colors as tokens } from '../../theme/tokens';

// ─── Earnings scenario constants ─────────────────────────────────────────────
//
// Per Jemal's Figma feedback the gross billing splits three ways:
//   - Platform fee (Compass operating costs)            → 15%
//   - Member rewards pool (engagement / redemption)     → 25%
//   - CHW net payout                                    → 60%

const PLATFORM_FEE_RATE = 0.15;
const REWARDS_POOL_RATE = 0.25;
const CHW_NET_RATE = 0.60;

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

/**
 * Maps the four backend BillingClaim statuses to the visual buckets the
 * payout-status pill renders.
 */
type PayoutStatus = 'pending' | 'submitted' | 'approved' | 'rejected';

const PAYOUT_STATUS_COLORS: Record<PayoutStatus, string> = {
  pending: colors.compassGold,
  submitted: colors.secondary,
  approved: colors.primary,
  rejected: '#DC2626',
};

const PAYOUT_STATUS_LABELS: Record<PayoutStatus, string> = {
  pending: 'Pending Payout',
  submitted: 'Submitted',
  approved: 'Paid',
  rejected: 'Rejected',
};

/**
 * Convert a backend BillingClaim.status string into the local PayoutStatus
 * union the UI renders. Unknown values fall back to 'pending' so a future
 * status added server-side never crashes the render.
 */
function mapClaimStatus(claimStatus: string | undefined): PayoutStatus {
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

/** Day-of-week labels for the Weekly Breakdown chart, Mon–Sun. */
const WEEK_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
type WeekDay = typeof WEEK_DAYS[number];

interface DayBucket {
  day: WeekDay;
  amount: number;
  sessions: SessionData[];
}

/**
 * Maps `Date.getDay()` (0=Sun … 6=Sat) into our Mon–Sun bucket index
 * (0=Mon … 6=Sun) so weekly chart buckets line up with WEEK_DAYS.
 */
function dayOfWeekIndex(date: Date): number {
  const js = date.getDay();
  return js === 0 ? 6 : js - 1;
}

/**
 * CHW net for a session, computed at the current 60% rate from the stored
 * gross amount. Falls back to `unitsBilled × MEDI_CAL_RATE × 0.60`, then
 * to the stored netAmount as a last resort.
 */
function chwNetFromSession(s: SessionData): number {
  if (s.grossAmount != null) return s.grossAmount * NET_PAYOUT_RATE;
  if (s.unitsBilled != null) return s.unitsBilled * MEDI_CAL_RATE * NET_PAYOUT_RATE;
  return s.netAmount ?? 0;
}

/**
 * Look up a real payout status for a given session by inspecting the
 * /chw/claims response.
 */
function lookupPayoutStatus(
  sessionId: string,
  claimsBySession: Map<string, ChwClaim>,
): PayoutStatus {
  const claim = claimsBySession.get(sessionId);
  return mapClaimStatus(claim?.status);
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
  const claimsQuery = useChwClaims();
  const payoutsQuery = usePaymentsAccountStatus();
  const payoutsEnabled = payoutsQuery.data?.payoutsEnabled === true;
  const payoutsInProgress =
    !!payoutsQuery.data?.accountId && !payoutsQuery.data.payoutsEnabled;

  const isLoading =
    earningsQuery.isLoading || sessionsQuery.isLoading || claimsQuery.isLoading;
  const queryError =
    earningsQuery.error ?? sessionsQuery.error ?? claimsQuery.error;

  const handleRetry = () => {
    void earningsQuery.refetch();
    void sessionsQuery.refetch();
    void claimsQuery.refetch();
  };

  const earnings = earningsQuery.data;
  const allSessions = sessionsQuery.data ?? [];
  const allClaims: ChwClaim[] = claimsQuery.data ?? [];

  // Index claims by sessionId once so the per-row payout-status lookup is O(1).
  const claimsBySession = useMemo<Map<string, ChwClaim>>(() => {
    const map = new Map<string, ChwClaim>();
    for (const claim of allClaims) {
      if (claim.sessionId && !map.has(claim.sessionId)) {
        map.set(claim.sessionId, claim);
      }
    }
    return map;
  }, [allClaims]);

  const completedSessions = useMemo<SessionData[]>(
    () => allSessions.filter((s) => s.status === 'completed'),
    [allSessions],
  );

  // KPI: Paid out this month — sum of approved claims for sessions in current calendar month
  const paidOutThisMonth = useMemo<number>(() => {
    const now = new Date();
    return completedSessions.reduce((acc, s) => {
      const status = lookupPayoutStatus(s.id, claimsBySession);
      if (status !== 'approved') return acc;
      const sessionDate = new Date(s.scheduledAt);
      if (
        sessionDate.getFullYear() === now.getFullYear() &&
        sessionDate.getMonth() === now.getMonth()
      ) {
        return acc + chwNetFromSession(s);
      }
      return acc;
    }, 0);
  }, [completedSessions, claimsBySession]);

  // KPI: Claims pending — count of sessions with 'pending' or 'submitted' status
  const claimsPendingCount = useMemo<number>(() => {
    return completedSessions.filter((s) => {
      const status = lookupPayoutStatus(s.id, claimsBySession);
      return status === 'pending' || status === 'submitted';
    }).length;
  }, [completedSessions, claimsBySession]);

  // Bucket completed sessions by day-of-week for the Weekly Breakdown chart.
  const weeklyData = useMemo<DayBucket[]>(() => {
    const buckets: DayBucket[] = WEEK_DAYS.map((day) => ({
      day,
      amount: 0,
      sessions: [],
    }));
    for (const session of completedSessions) {
      const idx = dayOfWeekIndex(new Date(session.scheduledAt));
      buckets[idx].sessions.push(session);
      buckets[idx].amount += chwNetFromSession(session);
    }
    for (const b of buckets) {
      b.sessions.sort(
        (a, c) => new Date(c.scheduledAt).getTime() - new Date(a.scheduledAt).getTime(),
      );
    }
    return buckets;
  }, [completedSessions]);

  const maxBarAmount = useMemo(
    () => Math.max(...weeklyData.map((d) => d.amount), 1),
    [weeklyData],
  );

  const avgEarningPerMember = useMemo(() => {
    if (completedSessions.length === 0) return 0;
    const total = completedSessions.reduce((acc, s) => acc + chwNetFromSession(s), 0);
    return total / completedSessions.length;
  }, [completedSessions]);

  // Tap a bar in the Weekly Breakdown to surface that day's detail card.
  const [selectedBarIdx, setSelectedBarIdx] = useState<number | null>(null);
  const selectedBar = selectedBarIdx !== null ? weeklyData[selectedBarIdx] : null;

  if (isLoading) {
    return (
      <AppShell role="chw" activeKey="earnings" userBlock={{ initials: '...', name: '...', role: 'CHW' }}>
        <SafeAreaView style={styles.safe} edges={['top']}>
          <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
            <View style={styles.pageWrap}>
              <LoadingSkeleton variant="stat-grid" />
              <LoadingSkeleton variant="rows" rows={3} />
            </View>
          </ScrollView>
        </SafeAreaView>
      </AppShell>
    );
  }

  if (queryError) {
    return (
      <AppShell role="chw" activeKey="earnings" userBlock={{ initials: '...', name: '...', role: 'CHW' }}>
        <SafeAreaView style={styles.safe} edges={['top']}>
          <ErrorState message="Failed to load earnings" onRetry={handleRetry} />
        </SafeAreaView>
      </AppShell>
    );
  }

  return (
    <AppShell role="chw" activeKey="earnings" userBlock={{ initials: 'C', name: 'CHW', role: 'CHW' }}>
      <SafeAreaView style={styles.safe} edges={['top']}>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.pageWrap}>
            {/* Page header */}
            <PageHeader
              title="Earnings & Payouts"
              subtitle="Track your Medi-Cal reimbursements and payout history."
            />

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

            {/* ── 4 KPI stat tiles ── */}
            <View style={styles.statGrid}>
              <StatTile
                icon={<TrendingUp color={tokens.emerald700} size={18} />}
                iconBg={tokens.emerald100}
                label="Earnings This Month"
                value={formatCurrency(earnings?.thisMonth ?? 0)}
                delta={`${earnings?.sessionsThisWeek ?? 0} sessions this week`}
                style={styles.statTile}
              />
              <StatTile
                icon={<DollarSign color={tokens.amber700} size={18} />}
                iconBg={tokens.amber100}
                label="Pending Payout"
                value={formatCurrency(earnings?.pendingPayout ?? 0)}
                delta="Awaiting approval"
                deltaColor={tokens.amber700}
                style={styles.statTile}
              />
              <StatTile
                icon={<CheckCircle color={tokens.blue700} size={18} />}
                iconBg={tokens.blue100}
                label="Paid Out This Month"
                value={formatCurrency(paidOutThisMonth)}
                delta="+8% vs last month"
                deltaColor={tokens.emerald700}
                style={styles.statTile}
              />
              <StatTile
                icon={<Clock color={tokens.purple700} size={18} />}
                iconBg={tokens.purple100}
                label="Claims Pending"
                value={claimsPendingCount}
                delta={claimsPendingCount === 1 ? '1 session' : `${claimsPendingCount} sessions`}
                deltaColor={claimsPendingCount > 0 ? tokens.amber700 : tokens.gray700}
                style={styles.statTile}
              />
            </View>

            {/* ── Trend + Bank row (8/12 chart + 4/12 bank card) ── */}
            <View style={styles.chartBankRow}>
              {/* Earnings trend chart (8/12) */}
              <Card style={styles.chartCard}>
                <Text style={styles.sectionTitle}>Weekly Breakdown</Text>
                <View style={styles.barChartContainer}>
                  {weeklyData.map((d, idx) => {
                    const heightPct = d.amount > 0 ? Math.max((d.amount / maxBarAmount) * 100, 6) : 6;
                    const hasAmount = d.amount > 0;
                    const isSelected = selectedBarIdx === idx;
                    return (
                      <TouchableOpacity
                        key={d.day}
                        style={styles.barColumn}
                        onPress={() => setSelectedBarIdx(isSelected ? null : idx)}
                        accessibilityRole="button"
                        accessibilityLabel={`${d.day}: ${hasAmount ? formatCurrency(d.amount) : 'no earnings'}`}
                        accessibilityState={{ selected: isSelected }}
                        activeOpacity={0.7}
                      >
                        <Text style={styles.barAmountLabel}>
                          {hasAmount ? formatCurrency(d.amount) : ''}
                        </Text>
                        <View style={styles.barTrack}>
                          <View
                            style={[
                              styles.barFill,
                              {
                                height: `${heightPct}%` as `${number}%`,
                                backgroundColor: hasAmount
                                  ? (isSelected ? colors.secondary : colors.primary)
                                  : colors.primary + '28',
                              },
                            ]}
                          />
                        </View>
                        <Text style={[styles.barDayLabel, isSelected && styles.barDayLabelSelected]}>
                          {d.day}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                {/* Detail card for the selected day */}
                {selectedBar && (
                  <View style={styles.barDetailCard}>
                    <View style={styles.barDetailHeader}>
                      <Text style={styles.barDetailDay}>{selectedBar.day}</Text>
                      <Text style={styles.barDetailAmount}>
                        {selectedBar.amount > 0 ? formatCurrency(selectedBar.amount) : 'No earnings'}
                      </Text>
                    </View>
                    {selectedBar.sessions.length === 0 ? (
                      <Text style={styles.barDetailMeta}>
                        No completed sessions on {selectedBar.day}.
                      </Text>
                    ) : (
                      <View style={styles.barDetailSessionList}>
                        {selectedBar.sessions.map((s, i) => {
                          const verticalColor = VERTICAL_COLORS[s.vertical as Vertical] ?? '#6B7A6B';
                          return (
                            <View key={s.id}>
                              {i > 0 ? <View style={styles.barDetailSessionDivider} /> : null}
                              <View style={styles.barDetailSessionRow}>
                                <View
                                  style={[
                                    styles.barDetailVerticalIcon,
                                    { backgroundColor: verticalColor + '18' },
                                  ]}
                                >
                                  <VerticalIconComponent vertical={s.vertical as Vertical} size={14} />
                                </View>
                                <View style={styles.barDetailSessionInfo}>
                                  <Text style={styles.barDetailSessionMember} numberOfLines={1}>
                                    {s.memberName ?? 'Member'}
                                  </Text>
                                  <Text style={styles.barDetailSessionMeta}>
                                    {formatShortDate(s.scheduledAt)}
                                    {s.unitsBilled != null
                                      ? ` · ${s.unitsBilled} ${s.unitsBilled === 1 ? 'unit' : 'units'}`
                                      : ''}
                                  </Text>
                                </View>
                                <Text style={styles.barDetailSessionAmount}>
                                  {formatCurrency(chwNetFromSession(s))}
                                </Text>
                              </View>
                            </View>
                          );
                        })}
                      </View>
                    )}
                  </View>
                )}
              </Card>

              {/* Bank & payout setup card (4/12) */}
              <Card style={styles.bankCard}>
                <View style={styles.bankCardIconRow}>
                  <View style={[styles.bankIconCircle, { backgroundColor: payoutsEnabled ? colors.primary + '18' : colors.compassGold + '18' }]}>
                    {payoutsEnabled
                      ? <CheckCircle size={22} color={colors.primary} />
                      : <CreditCard size={22} color={colors.compassGold} />
                    }
                  </View>
                </View>
                <Text style={styles.bankCardTitle}>
                  {payoutsEnabled ? 'Payouts Active' : payoutsInProgress ? 'Setup in Progress' : 'Connect Your Bank'}
                </Text>
                <Text style={styles.bankCardDesc}>
                  {payoutsEnabled
                    ? 'Direct deposit is active. Paid every Friday for the prior week.'
                    : payoutsInProgress
                    ? 'Stripe is reviewing your information. Usually takes a few minutes.'
                    : 'Connect your bank account to receive Medi-Cal payouts.'}
                </Text>
                {!payoutsEnabled && (
                  <Pressable
                    style={styles.bankCardCTA}
                    onPress={() => {
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      (navigation as any).navigate('Payments');
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={payoutsInProgress ? 'Continue setup' : 'Set up direct deposit'}
                  >
                    <Text style={styles.bankCardCTAText}>
                      {payoutsInProgress ? 'Continue Setup' : 'Set Up Payouts'}
                    </Text>
                    <ArrowRight size={14} color="#FFFFFF" />
                  </Pressable>
                )}
                <Text style={styles.bankCardNote}>
                  Avg per session: {formatCurrency(avgEarningPerMember)}
                </Text>
              </Card>
            </View>

            {/* ── Sessions billed table card ── */}
            <Card style={styles.card}>
              <Text style={styles.sectionTitle}>Sessions Billed</Text>
              {completedSessions.length === 0 ? (
                <View style={styles.emptyPayouts}>
                  <DollarSign size={22} color={colors.mutedForeground} />
                  <Text style={styles.emptyTitle}>No billed sessions yet</Text>
                  <Text style={styles.emptySubtext}>Complete sessions to start earning.</Text>
                </View>
              ) : (
                completedSessions.slice(0, 10).map((session, index) => {
                  const payoutStatus = lookupPayoutStatus(session.id, claimsBySession);
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
                            {formatCurrency(chwNetFromSession(session))}
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
            </Card>

            {/* ── Recent payouts card (mirrors sessions billed, kept separate for clarity) ── */}
            <Card style={styles.card}>
              <Text style={styles.sectionTitle}>Recent Payouts</Text>
              {completedSessions.filter((s) => lookupPayoutStatus(s.id, claimsBySession) === 'approved').length === 0 ? (
                <View style={styles.emptyPayouts}>
                  <DollarSign size={22} color={colors.mutedForeground} />
                  <Text style={styles.emptyTitle}>No payouts yet</Text>
                  <Text style={styles.emptySubtext}>Complete sessions to start earning.</Text>
                </View>
              ) : (
                completedSessions
                  .filter((s) => lookupPayoutStatus(s.id, claimsBySession) === 'approved')
                  .map((session, index) => {
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
                            </Text>
                          </View>
                          <View style={styles.payoutRight}>
                            <Text style={[styles.payoutAmount, { color: colors.primary }]}>
                              {formatCurrency(chwNetFromSession(session))}
                            </Text>
                            <View style={[styles.badge, { backgroundColor: colors.primary + '18' }]}>
                              <Text style={[styles.badgeText, { color: colors.primary }]}>Paid</Text>
                            </View>
                          </View>
                        </View>
                      </View>
                    );
                  })
              )}
            </Card>

            {/* ── Earnings scenarios table ── */}
            <Card style={styles.card}>
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
                      <Text style={styles.tableHeaderText}>Platform (15%)</Text>
                    </View>
                    <View style={[styles.tableCell, styles.tableCellHeader]}>
                      <Text style={styles.tableHeaderText}>Rewards (25%)</Text>
                    </View>
                    <View style={[styles.tableCell, styles.tableCellHeader]}>
                      <Text style={styles.tableHeaderText}>CHW Net (60%)</Text>
                    </View>
                  </View>
                  {EARNINGS_SCENARIOS.map((scenario, index) => {
                    const gross = scenario.unitsPerDay * MEDI_CAL_RATE;
                    const platformFee = gross * PLATFORM_FEE_RATE;
                    const rewardsPool = gross * REWARDS_POOL_RATE;
                    const chwNet = gross * CHW_NET_RATE;
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
                          <Text style={[styles.tableCellText, styles.tableCellMuted]}>
                            −{formatCurrency(platformFee)}
                          </Text>
                        </View>
                        <View style={styles.tableCell}>
                          <Text style={[styles.tableCellText, styles.tableCellRewards]}>
                            −{formatCurrency(rewardsPool)}
                          </Text>
                        </View>
                        <View style={styles.tableCell}>
                          <Text style={[styles.tableCellText, styles.tableCellChwNet]}>
                            {formatCurrency(chwNet)}
                          </Text>
                        </View>
                      </View>
                    );
                  })}
                </View>
              </ScrollView>
            </Card>

            {/* ── Payout schedule note ── */}
            <Card style={styles.noteCard}>
              <View style={[styles.noteIconCircle, { backgroundColor: colors.primary + '18' }]}>
                <Banknote size={18} color={colors.primary} />
              </View>
              <Text style={styles.noteText}>
                <Text style={styles.noteBold}>Payout schedule: </Text>
                Payouts are processed weekly via direct deposit, every Friday for the prior week's
                approved sessions.
              </Text>
            </Card>
          </View>
        </ScrollView>
      </SafeAreaView>
    </AppShell>
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
    flexGrow: 1,
    alignItems: 'center',
  },
  pageWrap: {
    width: '100%',
    maxWidth: 960,
    alignSelf: 'center',
    padding: 20,
    paddingBottom: 40,
  },

  // ── 4-tile stat grid ────────────────────────────────────────────────────────
  statGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginBottom: 20,
  },
  statTile: {
    flex: 1,
    minWidth: 160,
  },

  // ── Chart + bank row ────────────────────────────────────────────────────────
  chartBankRow: {
    flexDirection: 'row',
    gap: 16,
    marginBottom: 20,
    flexWrap: 'wrap',
  },
  chartCard: {
    flex: 2,
    padding: 16,
    minWidth: 260,
  },
  bankCard: {
    flex: 1,
    padding: 16,
    minWidth: 180,
    gap: 10,
    justifyContent: 'center',
  },
  bankCardIconRow: {
    marginBottom: 4,
  },
  bankIconCircle: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bankCardTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 15,
    color: '#1E3320',
    lineHeight: 20,
  },
  bankCardDesc: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: '#6B7A6B',
    lineHeight: 17,
  },
  bankCardCTA: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.primary,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginTop: 4,
  },
  bankCardCTAText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: '#FFFFFF',
  },
  bankCardNote: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#9CA3AF',
    textAlign: 'center',
    marginTop: 4,
  },

  // ── Payout banner ────────────────────────────────────────────────────────────
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

  // ── Generic card shell ────────────────────────────────────────────────────────
  card: {
    padding: 16,
    marginBottom: 20,
  },
  sectionTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    lineHeight: 22,
    color: '#1E3320',
    marginBottom: 16,
  },

  // ── Bar chart ────────────────────────────────────────────────────────────────
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
  barDayLabelSelected: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    color: colors.secondary,
  },
  barDetailCard: {
    marginTop: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: colors.secondary + '12',
    borderLeftWidth: 3,
    borderLeftColor: colors.secondary,
  },
  barDetailHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  barDetailDay: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 13,
    color: '#1E3320',
  },
  barDetailAmount: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
    color: colors.secondary,
  },
  barDetailMeta: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: '#6B7A6B',
    lineHeight: 16,
  },
  barDetailSessionList: {
    marginTop: 8,
    gap: 6,
  },
  barDetailSessionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 6,
  },
  barDetailVerticalIcon: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  barDetailSessionInfo: {
    flex: 1,
    gap: 1,
  },
  barDetailSessionMember: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: '#1E3320',
  },
  barDetailSessionMeta: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#6B7A6B',
  },
  barDetailSessionAmount: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
    color: colors.primary,
    flexShrink: 0,
  },
  barDetailSessionDivider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: 2,
  },

  // ── Payout rows ───────────────────────────────────────────────────────────────
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

  // ── Scenarios table ────────────────────────────────────────────────────────────
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
  tableCellMuted: {
    color: colors.mutedForeground,
  },
  tableCellRewards: {
    color: colors.compassGold,
  },
  tableCellChwNet: {
    color: colors.primary,
    fontWeight: '700',
  },

  // ── Note card ─────────────────────────────────────────────────────────────────
  noteCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    marginBottom: 16,
    padding: 16,
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
});

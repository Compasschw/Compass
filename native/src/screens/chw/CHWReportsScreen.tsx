/**
 * CHWReportsScreen — Personal performance dashboard for CHWs.
 *
 * Displays KPIs (sessions completed, average rating, total earnings, active
 * members), a session-volume bar chart (pure View-based, no library), and a
 * tabular breakdown of care-vertical distribution.
 *
 * All data is mocked inline for v1. Replace with a real query hook once the
 * /chw/reports endpoint ships.
 */

import React, { useMemo, useState } from 'react';
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
import {
  BarChart3,
  Star,
  DollarSign,
  Users,
  CalendarCheck,
  TrendingUp,
  TrendingDown,
  Activity,
} from 'lucide-react-native';

import { AppShell, PageHeader, Card, Pill, RightRail, StatTile } from '../../components/ui';
import { colors, spacing, radius } from '../../theme/tokens';
import { useAuth } from '../../context/AuthContext';

// ─── Types ────────────────────────────────────────────────────────────────────

type DateRange = '7d' | '30d' | '90d' | 'ytd';

interface WeeklyBar {
  label: string;   // e.g. "Apr 28"
  count: number;
}

interface VerticalRow {
  vertical: string;
  label: string;
  sessions: number;
  percentOfTotal: number;
  avgDuration: number;
  pillVariant: 'emerald' | 'blue' | 'purple' | 'amber' | 'orange';
}

// ─── Mock data — TODO: replace with real hook ─────────────────────────────────

// TODO: replace with real hook — GET /chw/reports?range=...
const MOCK_STATS = {
  sessionsCompleted: 42,
  sessionsCompletedDelta: '+8 this month',
  avgRating: 4.8,
  avgRatingDelta: '+0.2 vs last month',
  totalEarnings: 6_840,
  totalEarningsDelta: '+$1,120 this month',
  activeMembers: 14,
  activeMembersDelta: '+3 this month',
};

const MOCK_WEEKLY_BARS: WeeklyBar[] = [
  { label: 'Apr 7',  count: 4 },
  { label: 'Apr 14', count: 6 },
  { label: 'Apr 21', count: 5 },
  { label: 'Apr 28', count: 8 },
  { label: 'May 5',  count: 7 },
  { label: 'May 12', count: 9 },
  { label: 'May 19 (est.)', count: 3 },
];

const MOCK_VERTICALS: VerticalRow[] = [
  { vertical: 'housing',       label: 'Housing',       sessions: 14, percentOfTotal: 33, avgDuration: 52, pillVariant: 'blue'    },
  { vertical: 'food',          label: 'Food',          sessions: 9,  percentOfTotal: 21, avgDuration: 38, pillVariant: 'amber'   },
  { vertical: 'mental_health', label: 'Mental Health', sessions: 8,  percentOfTotal: 19, avgDuration: 60, pillVariant: 'purple'  },
  { vertical: 'healthcare',    label: 'Healthcare',    sessions: 7,  percentOfTotal: 17, avgDuration: 45, pillVariant: 'emerald' },
  { vertical: 'benefits',      label: 'Benefits',      sessions: 4,  percentOfTotal: 10, avgDuration: 40, pillVariant: 'orange'  },
];

const DATE_RANGE_LABELS: Record<DateRange, string> = {
  '7d':  'Last 7 Days',
  '30d': 'Last 30 Days',
  '90d': 'Last 90 Days',
  'ytd': 'Year to Date',
};

// ─── Bar chart (pure View) ────────────────────────────────────────────────────

interface BarChartProps {
  bars: WeeklyBar[];
}

function BarChart({ bars }: BarChartProps): React.JSX.Element {
  const maxCount = Math.max(...bars.map((b) => b.count), 1);

  return (
    <View style={chartStyles.root} accessibilityLabel="Session volume bar chart">
      {/* Y-axis hint */}
      <View style={chartStyles.yAxis}>
        {[maxCount, Math.round(maxCount / 2), 0].map((v) => (
          <Text key={v} style={chartStyles.yLabel}>{v}</Text>
        ))}
      </View>

      {/* Bars */}
      <View style={chartStyles.barsArea}>
        {bars.map((bar) => {
          const heightPct = maxCount > 0 ? bar.count / maxCount : 0;
          return (
            <View key={bar.label} style={chartStyles.barCol}>
              <View style={chartStyles.barTrack}>
                <View
                  style={[
                    chartStyles.bar,
                    { height: `${Math.round(heightPct * 100)}%` as unknown as number },
                  ]}
                  accessibilityLabel={`${bar.label}: ${bar.count} sessions`}
                />
              </View>
              <Text style={chartStyles.barLabel} numberOfLines={2}>{bar.label}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const chartStyles = StyleSheet.create({
  root: {
    flexDirection: 'row',
    height: 160,
    gap: spacing.sm,
    paddingTop: spacing.sm,
  } as ViewStyle,

  yAxis: {
    justifyContent: 'space-between',
    width: 28,
    paddingBottom: 32,
  } as ViewStyle,

  yLabel: {
    fontSize: 10,
    color: colors.textMuted,
    textAlign: 'right',
  } as TextStyle,

  barsArea: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
  } as ViewStyle,

  barCol: {
    flex: 1,
    alignItems: 'center',
    height: '100%',
  } as ViewStyle,

  barTrack: {
    flex: 1,
    width: '100%',
    justifyContent: 'flex-end',
    backgroundColor: colors.gray100,
    borderRadius: radius.sm,
    overflow: 'hidden',
  } as ViewStyle,

  bar: {
    width: '100%',
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    minHeight: 4,
  } as ViewStyle,

  barLabel: {
    fontSize: 9,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: 4,
    height: 28,
    lineHeight: 12,
  } as TextStyle,
});

// ─── Screen ───────────────────────────────────────────────────────────────────

export function CHWReportsScreen(): React.JSX.Element {
  const { userName } = useAuth();
  const [activeRange, setActiveRange] = useState<DateRange>('30d');

  const dateRanges = Object.keys(DATE_RANGE_LABELS) as DateRange[];

  const userInitials = (userName ?? 'CHW')
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  const content = (
    <>
      <PageHeader
        title="My Reports"
        subtitle="Personal performance metrics"
        right={
          <View style={styles.rangeRow}>
            {dateRanges.map((r) => (
              <TouchableOpacity
                key={r}
                onPress={() => setActiveRange(r)}
                style={[styles.rangeChip, activeRange === r && styles.rangeChipActive]}
                accessible
                accessibilityRole="button"
                accessibilityLabel={DATE_RANGE_LABELS[r]}
                accessibilityState={{ selected: activeRange === r }}
              >
                <Text style={[styles.rangeChipText, activeRange === r && styles.rangeChipTextActive]}>
                  {r.toUpperCase()}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        }
      />

      {/* KPI stat row */}
      <View style={styles.statRow}>
        <StatTile
          icon={<CalendarCheck size={18} color={colors.emerald700} />}
          iconBg={colors.emerald100}
          label="Sessions Completed"
          value={MOCK_STATS.sessionsCompleted}
          delta={MOCK_STATS.sessionsCompletedDelta}
          style={styles.statTile}
        />
        <StatTile
          icon={<Star size={18} color={colors.amber700} />}
          iconBg={colors.amber100}
          label="Avg Rating"
          value={MOCK_STATS.avgRating.toFixed(1)}
          delta={MOCK_STATS.avgRatingDelta}
          style={styles.statTile}
        />
        <StatTile
          icon={<DollarSign size={18} color={colors.blue700} />}
          iconBg={colors.blue100}
          label="Total Earnings"
          value={`$${MOCK_STATS.totalEarnings.toLocaleString()}`}
          delta={MOCK_STATS.totalEarningsDelta}
          style={styles.statTile}
        />
        <StatTile
          icon={<Users size={18} color={colors.purple700} />}
          iconBg={colors.purple100}
          label="Active Members"
          value={MOCK_STATS.activeMembers}
          delta={MOCK_STATS.activeMembersDelta}
          style={styles.statTile}
        />
      </View>

      {/* Body row */}
      <View style={styles.bodyRow}>
        <View style={styles.mainCol}>
          {/* Session volume chart */}
          <Card style={styles.chartCard}>
            <View style={styles.cardTitleRow}>
              <BarChart3 size={16} color={colors.textSecondary} />
              <Text style={styles.cardTitle}>Session Volume</Text>
              <Text style={styles.cardSubtitle}>{DATE_RANGE_LABELS[activeRange]}</Text>
            </View>
            <BarChart bars={MOCK_WEEKLY_BARS} />
          </Card>

          {/* Vertical breakdown table */}
          <Card style={styles.tableCard}>
            <View style={styles.cardTitleRow}>
              <Activity size={16} color={colors.textSecondary} />
              <Text style={styles.cardTitle}>Care Vertical Breakdown</Text>
            </View>

            {/* Table header */}
            <View style={[styles.tableRow, styles.tableHeaderRow]}>
              <Text style={[styles.colHeader, styles.colVertical]}>Vertical</Text>
              <Text style={[styles.colHeader, styles.colSessions]}>Sessions</Text>
              <Text style={[styles.colHeader, styles.colPct]}>% of Total</Text>
              <Text style={[styles.colHeader, styles.colDuration]}>Avg Duration</Text>
            </View>

            {MOCK_VERTICALS.map((row, idx) => (
              <View
                key={row.vertical}
                style={[styles.tableRow, idx < MOCK_VERTICALS.length - 1 && styles.tableRowDivider]}
              >
                <View style={styles.colVertical}>
                  <Pill variant={row.pillVariant} size="sm">{row.label}</Pill>
                </View>
                <Text style={[styles.cellText, styles.colSessions]}>{row.sessions}</Text>
                <View style={[styles.colPct]}>
                  <View style={styles.pctBar}>
                    <View
                      style={[
                        styles.pctFill,
                        { width: `${row.percentOfTotal}%` as unknown as number },
                      ]}
                    />
                  </View>
                  <Text style={styles.pctText}>{row.percentOfTotal}%</Text>
                </View>
                <Text style={[styles.cellText, styles.colDuration]}>{row.avgDuration} min</Text>
              </View>
            ))}
          </Card>
        </View>

        {Platform.OS === 'web' && (
          <RightRail>
            <Card style={styles.railCard}>
              <Text style={styles.railTitle}>Performance Highlights</Text>
              <View style={styles.highlightList}>
                <View style={styles.highlightItem}>
                  <TrendingUp size={14} color={colors.primary} />
                  <Text style={styles.highlightText}>
                    42 sessions completed — top 15% of CHW cohort
                  </Text>
                </View>
                <View style={styles.highlightItem}>
                  <Star size={14} color={colors.amber700} />
                  <Text style={styles.highlightText}>
                    4.8 average rating across 38 rated sessions
                  </Text>
                </View>
                <View style={styles.highlightItem}>
                  <Users size={14} color={colors.blue700} />
                  <Text style={styles.highlightText}>
                    14 active member relationships maintained
                  </Text>
                </View>
                <View style={styles.highlightItem}>
                  <TrendingDown size={14} color={colors.amber700} />
                  <Text style={styles.highlightText}>
                    No-show rate: 5% (below 8% platform avg)
                  </Text>
                </View>
              </View>
            </Card>

            <Card style={styles.railCard}>
              <Text style={styles.railTitle}>Goals This Month</Text>
              <View style={styles.goalList}>
                {[
                  { label: 'Sessions target',  current: 42, goal: 50 },
                  { label: 'New members',       current: 3,  goal: 5  },
                  { label: 'Documentation rate',current: 95, goal: 100, suffix: '%' },
                ].map((g) => (
                  <View key={g.label} style={styles.goalItem}>
                    <View style={styles.goalLabelRow}>
                      <Text style={styles.goalLabel}>{g.label}</Text>
                      <Text style={styles.goalValue}>
                        {g.current}{g.suffix ?? ''} / {g.goal}{g.suffix ?? ''}
                      </Text>
                    </View>
                    <View style={styles.goalTrack}>
                      <View
                        style={[
                          styles.goalFill,
                          {
                            width: `${Math.min(100, Math.round((g.current / g.goal) * 100))}%` as unknown as number,
                          },
                        ]}
                      />
                    </View>
                  </View>
                ))}
              </View>
            </Card>
          </RightRail>
        )}
      </View>
    </>
  );

  if (Platform.OS !== 'web') {
    return (
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        <ScrollView contentContainerStyle={styles.nativeScroll} showsVerticalScrollIndicator={false}>
          {content}
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <AppShell
      role="chw"
      activeKey="reports"
      userBlock={{ initials: userInitials, name: userName ?? 'CHW', role: 'CHW' }}
    >
      {content}
    </AppShell>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.pageBg,
  } as ViewStyle,

  nativeScroll: {
    padding: spacing.lg,
    flexGrow: 1,
  } as ViewStyle,

  rangeRow: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.md,
    overflow: 'hidden',
  } as ViewStyle,

  rangeChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    backgroundColor: colors.cardBg,
  } as ViewStyle,

  rangeChipActive: {
    backgroundColor: colors.primary,
  } as ViewStyle,

  rangeChipText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textSecondary,
  } as TextStyle,

  rangeChipTextActive: {
    color: colors.cardBg,
  } as TextStyle,

  statRow: {
    flexDirection: 'row',
    gap: spacing.lg,
    marginBottom: spacing.xl,
    flexWrap: 'wrap',
  } as ViewStyle,

  statTile: {
    flex: 1,
    minWidth: 160,
    padding: spacing.lg,
  } as ViewStyle,

  bodyRow: {
    flexDirection: 'row',
    gap: spacing.xl,
    alignItems: 'flex-start',
  } as ViewStyle,

  mainCol: {
    flex: 1,
    gap: spacing.lg,
  } as ViewStyle,

  chartCard: {
    padding: spacing.lg,
    gap: spacing.md,
  } as ViewStyle,

  cardTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  } as ViewStyle,

  cardTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary,
    flex: 1,
  } as TextStyle,

  cardSubtitle: {
    fontSize: 12,
    color: colors.textSecondary,
  } as TextStyle,

  tableCard: {
    padding: spacing.lg,
    gap: 2,
  } as ViewStyle,

  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  } as ViewStyle,

  tableHeaderRow: {
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
    paddingBottom: spacing.sm,
    marginBottom: spacing.xs,
  } as ViewStyle,

  tableRowDivider: {
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
  } as ViewStyle,

  colHeader: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textSecondary,
    textTransform: 'uppercase',
  } as TextStyle,

  colVertical: { flex: 1.5 } as ViewStyle,
  colSessions: { flex: 1,   textAlign: 'center' as const } as TextStyle,
  colPct:      { flex: 2,   flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6 } as ViewStyle,
  colDuration: { flex: 1.5, textAlign: 'right' as const } as TextStyle,

  cellText: {
    fontSize: 13,
    color: colors.textPrimary,
  } as TextStyle,

  pctBar: {
    flex: 1,
    height: 6,
    backgroundColor: colors.gray100,
    borderRadius: radius.pill,
    overflow: 'hidden',
  } as ViewStyle,

  pctFill: {
    height: '100%',
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
  } as ViewStyle,

  pctText: {
    fontSize: 12,
    color: colors.textSecondary,
    width: 34,
    textAlign: 'right',
  } as TextStyle,

  railCard: {
    padding: spacing.lg,
    gap: spacing.md,
  } as ViewStyle,

  railTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: spacing.xs,
  } as TextStyle,

  highlightList: {
    gap: spacing.sm,
  } as ViewStyle,

  highlightItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  } as ViewStyle,

  highlightText: {
    flex: 1,
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 18,
  } as TextStyle,

  goalList: {
    gap: spacing.md,
  } as ViewStyle,

  goalItem: {
    gap: spacing.xs,
  } as ViewStyle,

  goalLabelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  } as ViewStyle,

  goalLabel: {
    fontSize: 12,
    color: colors.textSecondary,
  } as TextStyle,

  goalValue: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.textPrimary,
  } as TextStyle,

  goalTrack: {
    height: 6,
    backgroundColor: colors.gray100,
    borderRadius: radius.pill,
    overflow: 'hidden',
  } as ViewStyle,

  goalFill: {
    height: '100%',
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
  } as ViewStyle,
});

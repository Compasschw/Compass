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

import React, { useState } from 'react';
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
  Star,
  DollarSign,
  Users,
  CalendarCheck,
  TrendingUp,
  Activity,
} from 'lucide-react-native';

import { AppShell, PageHeader, Card, StatTile } from '../../components/ui';
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
  pillVariant: 'emerald' | 'blue' | 'purple' | 'amber';
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
  { vertical: 'benefits',      label: 'Benefits',      sessions: 4,  percentOfTotal: 10, avgDuration: 40, pillVariant: 'amber'   },
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

      {/* 2x2 chart grid — matches mockup exactly */}
      <View style={styles.chartGrid}>
        {/* Q1: Session volume bar chart */}
        <Card style={styles.chartCard}>
          <View style={styles.cardTitleRow}>
            <Text style={styles.cardTitle}>Sessions per week</Text>
            <Text style={styles.cardSubtitle}>Bar chart · 8-week trend</Text>
          </View>
          <View style={styles.chartPlaceholder}>
            <BarChart bars={MOCK_WEEKLY_BARS} />
          </View>
        </Card>

        {/* Q2: Earnings trend — inline SVG line chart */}
        <Card style={styles.chartCard}>
          <View style={styles.cardTitleRow}>
            <Text style={styles.cardTitle}>Earnings trend</Text>
            <Text style={styles.cardSubtitle}>Line chart · since start</Text>
          </View>
          <View style={[styles.chartPlaceholder, styles.gradientBg]}>
            {Platform.OS === 'web' ? (
              // @ts-ignore — SVG renders on RN web
              <svg viewBox="0 0 300 100" style={{ width: '100%', height: 120 }}>
                {/* @ts-ignore */}
                <defs>
                  {/* @ts-ignore */}
                  <linearGradient id="earnGrad" x1="0" x2="0" y1="0" y2="1">
                    {/* @ts-ignore */}
                    <stop offset="0%" stopColor="#10b981" />
                    {/* @ts-ignore */}
                    <stop offset="100%" stopColor="#10b981" stopOpacity="0" />
                  </linearGradient>
                </defs>
                {/* @ts-ignore */}
                <polyline points="10,80 50,70 90,72 130,55 170,50 210,40 250,28 290,15" stroke="#10b981" strokeWidth="3" fill="none" />
                {/* @ts-ignore */}
                <polyline points="10,80 50,70 90,72 130,55 170,50 210,40 250,28 290,15 290,100 10,100" fill="url(#earnGrad)" opacity="0.25" />
              </svg>
            ) : (
              <View style={styles.nativeSvgFallback}>
                <TrendingUp size={32} color={colors.primary} />
                <Text style={styles.fallbackLabel}>Earnings trending up</Text>
              </View>
            )}
          </View>
        </Card>

        {/* Q3: Donut pie — top resource needs */}
        <Card style={styles.chartCard}>
          <View style={styles.cardTitleRow}>
            <Text style={styles.cardTitle}>Top resource needs served</Text>
            <Text style={styles.cardSubtitle}>Pie · this month</Text>
          </View>
          <View style={[styles.chartPlaceholder, styles.gradientBg]}>
            {Platform.OS === 'web' ? (
              <View style={styles.pieWrap}>
                {/* @ts-ignore */}
                <svg viewBox="0 0 100 100" style={{ width: 100, height: 100, flexShrink: 0 }}>
                  {/* conic-gradient approximated via SVG arcs */}
                  {/* @ts-ignore */}
                  <circle r="50" cx="50" cy="50" fill="conic-gradient(#10b981 0% 32%, #f97316 32% 56%, #f59e0b 56% 70%, #8b5cf6 70% 84%, #ef4444 84% 100%)" />
                  {/* Donut hole */}
                  {/* @ts-ignore */}
                  <circle r="30" cx="50" cy="50" fill="white" />
                </svg>
                <View style={styles.pieLegend}>
                  {[
                    { label: 'Food (32%)',          color: '#10b981' },
                    { label: 'Housing (24%)',        color: '#f97316' },
                    { label: 'Benefits (14%)',       color: '#f59e0b' },
                    { label: 'Mental Health (14%)',  color: '#8b5cf6' },
                    { label: 'Other (16%)',          color: '#ef4444' },
                  ].map((item) => (
                    <View key={item.label} style={styles.legendItem}>
                      <View style={[styles.legendDot, { backgroundColor: item.color }]} />
                      <Text style={styles.legendText}>{item.label}</Text>
                    </View>
                  ))}
                </View>
              </View>
            ) : (
              <View style={styles.nativeSvgFallback}>
                <Activity size={32} color={colors.primary} />
                <Text style={styles.fallbackLabel}>Food 32% · Housing 24%</Text>
              </View>
            )}
          </View>
        </Card>

        {/* Q4: Time-to-first-contact table */}
        <Card style={styles.chartCard}>
          <View style={styles.cardTitleRow}>
            <Text style={styles.cardTitle}>Time-to-first-contact</Text>
            <Text style={styles.cardSubtitle}>Per new member</Text>
          </View>
          <View style={styles.contactTable}>
            <View style={styles.contactTableHeader}>
              <Text style={[styles.contactCol, styles.contactColHeader]}>Member</Text>
              <Text style={[styles.contactColRight, styles.contactColHeader]}>Hours</Text>
            </View>
            {[
              { member: 'Ana Garcia',    hours: '2.1 h',  color: colors.emerald700 },
              { member: 'Juana Ramirez', hours: '1.4 h',  color: colors.emerald700 },
              { member: 'David Lopez',   hours: '3.2 h',  color: colors.emerald700 },
              { member: 'Sandra Chavez', hours: '8.7 h',  color: colors.amber700   },
              { member: 'Marcus Brown',  hours: '26.4 h', color: colors.red700     },
            ].map((row) => (
              <View key={row.member} style={styles.contactTableRow}>
                <Text style={styles.contactCol}>{row.member}</Text>
                <Text style={[styles.contactColRight, { color: row.color, fontWeight: '600' }]}>{row.hours}</Text>
              </View>
            ))}
          </View>
        </Card>
      </View>

      {/* Insights + members served row */}
      <View style={styles.insightsRow}>
        {/* AI Insights panel */}
        <Card style={[styles.insightsCard, styles.gradientBgSubtle]}>
          <View style={styles.insightsTitleRow}>
            <TrendingUp size={15} color={colors.primary} />
            <Text style={styles.insightsTitle}>Compass Insights</Text>
            <View style={styles.betaBadge}><Text style={styles.betaText}>BETA</Text></View>
          </View>
          {[
            { title: 'You respond fastest on Tuesdays', body: 'Avg response on Tue is 42 min vs 1h 56m other days. Block 2h outreach time then.' },
            { title: '92% of your housing journey members complete eligibility', body: 'Well above the 67% platform avg — your intake script is working.' },
            { title: 'Marcus B. is at risk of disengagement', body: '26h time-to-first-contact + missed last 2 follow-ups. Suggest evening text outreach.' },
          ].map((insight) => (
            <View key={insight.title} style={styles.insightItem}>
              <Text style={styles.insightItemTitle}>{insight.title}</Text>
              <Text style={styles.insightItemBody}>{insight.body}</Text>
            </View>
          ))}
        </Card>

        {/* Members served grid */}
        <Card style={styles.membersCard}>
          <Text style={styles.membersTitle}>Members served this month (12)</Text>
          <View style={styles.membersGrid}>
            {[
              { initials: 'AG', color: colors.emerald100, text: colors.emerald700, name: 'Ana'    },
              { initials: 'JR', color: colors.blue100,    text: colors.blue700,    name: 'Juana'  },
              { initials: 'DL', color: colors.purple100,  text: colors.purple700,  name: 'David'  },
              { initials: 'SC', color: colors.amber100,   text: colors.amber700,   name: 'Sandra' },
              { initials: 'MB', color: colors.red100,     text: colors.red700,     name: 'Marcus' },
              { initials: 'EC', color: colors.cyan100,    text: colors.cyan700,    name: 'Elena'  },
              { initials: 'RP', color: colors.indigo100,  text: colors.indigo700,  name: 'Roberto'},
              { initials: 'LM', color: colors.pink100,    text: colors.pink700,    name: 'Linda'  },
              { initials: 'JN', color: colors.teal100,    text: colors.teal700,    name: 'Jose'   },
              { initials: 'CM', color: colors.slate100,   text: colors.slate700,   name: 'Carmen' },
              { initials: 'RV', color: colors.amber100,   text: colors.amber700,   name: 'Rosa'   },
              { initials: '+1', color: colors.gray100,    text: colors.gray700,    name: 'more'   },
            ].map((m) => (
              <View key={m.initials} style={styles.memberAvatar}>
                <View style={[styles.avatarCircle, { backgroundColor: m.color }]}>
                  <Text style={[styles.avatarInitials, { color: m.text }]}>{m.initials}</Text>
                </View>
                <Text style={styles.avatarName}>{m.name}</Text>
              </View>
            ))}
          </View>
        </Card>
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
    padding: spacing.xl,
  } as ViewStyle,

  chartGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xl,
    marginBottom: spacing.xl,
  } as ViewStyle,

  chartCard: {
    padding: spacing.xl,
    gap: spacing.md,
    width: Platform.OS === 'web' ? 'calc(50% - 10px)' as unknown as number : '100%',
  } as ViewStyle,

  cardTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  } as ViewStyle,

  cardTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary,
  } as TextStyle,

  cardSubtitle: {
    fontSize: 11,
    color: colors.textSecondary,
  } as TextStyle,

  chartPlaceholder: {
    borderRadius: radius.lg,
    minHeight: 160,
    overflow: 'hidden',
    justifyContent: 'center',
  } as ViewStyle,

  gradientBg: {
    // linear-gradient approximated with a solid tint on native
    backgroundColor: '#ecfdf5',
    padding: spacing.md,
  } as ViewStyle,

  gradientBgSubtle: {
    backgroundColor: '#f8fdfb',
  } as ViewStyle,

  nativeSvgFallback: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    padding: spacing.xl,
  } as ViewStyle,

  fallbackLabel: {
    fontSize: 12,
    color: colors.textSecondary,
    textAlign: 'center',
  } as TextStyle,

  pieWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xl,
    justifyContent: 'center',
  } as ViewStyle,

  pieLegend: {
    gap: 6,
  } as ViewStyle,

  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  } as ViewStyle,

  legendDot: {
    width: 10,
    height: 10,
    borderRadius: 2,
  } as ViewStyle,

  legendText: {
    fontSize: 11,
    color: colors.textSecondary,
  } as TextStyle,

  contactTable: {
    gap: 0,
  } as ViewStyle,

  contactTableHeader: {
    flexDirection: 'row',
    paddingVertical: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
    marginBottom: 2,
  } as ViewStyle,

  contactTableRow: {
    flexDirection: 'row',
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
  } as ViewStyle,

  contactColHeader: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textSecondary,
    textTransform: 'uppercase',
  } as TextStyle,

  contactCol: {
    flex: 1,
    fontSize: 13,
    color: colors.textPrimary,
  } as TextStyle,

  contactColRight: {
    width: 60,
    textAlign: 'right',
    fontSize: 13,
    color: colors.textSecondary,
  } as TextStyle,

  insightsRow: {
    flexDirection: 'row',
    gap: spacing.xl,
    marginBottom: spacing.xl,
    flexWrap: 'wrap',
  } as ViewStyle,

  insightsCard: {
    padding: spacing.xl,
    gap: spacing.md,
    flex: 1,
    minWidth: Platform.OS === 'web' ? 340 : '100%',
  } as ViewStyle,

  insightsTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  } as ViewStyle,

  insightsTitle: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary,
  } as TextStyle,

  betaBadge: {
    backgroundColor: colors.emerald100,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  } as ViewStyle,

  betaText: {
    fontSize: 9,
    fontWeight: '700',
    color: colors.emerald700,
    letterSpacing: 0.6,
  } as TextStyle,

  insightItem: {
    backgroundColor: colors.cardBg,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: 3,
    borderWidth: 1,
    borderColor: colors.cardBorder,
  } as ViewStyle,

  insightItemTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary,
  } as TextStyle,

  insightItemBody: {
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 18,
  } as TextStyle,

  membersCard: {
    padding: spacing.xl,
    gap: spacing.md,
    flex: 1.4,
    minWidth: Platform.OS === 'web' ? 400 : '100%',
  } as ViewStyle,

  membersTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary,
  } as TextStyle,

  membersGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  } as ViewStyle,

  memberAvatar: {
    alignItems: 'center',
    gap: 4,
    width: 56,
  } as ViewStyle,

  avatarCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,

  avatarInitials: {
    fontSize: 13,
    fontWeight: '700',
  } as TextStyle,

  avatarName: {
    fontSize: 11,
    color: colors.textSecondary,
    textAlign: 'center',
  } as TextStyle,
});

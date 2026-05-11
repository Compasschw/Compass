/**
 * CHWJourneysScreen — Caseload journey overview for the authenticated CHW.
 *
 * Fetches all member journeys assigned to this CHW from GET /chw/journeys.
 * Each journey card shows the member name, template, progress bar, current
 * step, status, and wellness points earned.
 *
 * Falls back to static mock layout when the backend is unavailable so the
 * screen remains usable during development.
 */

import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Platform,
  ActivityIndicator,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Route,
  Users,
  CheckCircle2,
  CircleDot,
  Clock,
  XCircle,
  Pause,
  Trophy,
  TrendingUp,
  Sparkles,
} from 'lucide-react-native';

import { AppShell, PageHeader, Card, Pill, RightRail, StatTile } from '../../components/ui';
import { colors, spacing, radius } from '../../theme/tokens';
import { useAuth } from '../../context/AuthContext';
import { useChwJourneys, type MemberJourneyResponse } from '../../hooks/useApiQueries';

// ─── Types ────────────────────────────────────────────────────────────────────

type JourneyStatus = 'active' | 'paused' | 'completed' | 'abandoned';
type StepStatus = 'upcoming' | 'in_progress' | 'completed' | 'missed';
type StatusFilter = 'all' | JourneyStatus;

// ─── Mock data (static fallback when backend is unavailable) ──────────────────

// TODO: replace with real hook — this data is used only as a fallback
const MOCK_JOURNEYS: MemberJourneyResponse[] = [
  {
    id: 'jrn-001',
    memberId: 'mem-001',
    chwId: 'chw-001',
    template: {
      id: 'tmpl-001',
      slug: 'housing-stability',
      name: 'Housing Stability',
      category: 'housing',
      icon: 'home',
      isActive: true,
      steps: [],
      createdAt: '2026-01-10T00:00:00Z',
    },
    steps: [
      { id: 'step-001', memberJourneyId: 'jrn-001', templateStepId: 'ts-001', stepOrder: 1, stepName: 'Initial Assessment', stepDescription: 'Complete SDOH housing assessment', pointsOnCompletion: 100, requiredDocuments: ['assessment_form'], status: 'completed', startedAt: '2026-04-01T00:00:00Z', completedAt: '2026-04-05T00:00:00Z', dueDate: null, pointsAwarded: 100, createdAt: '2026-04-01T00:00:00Z' },
      { id: 'step-002', memberJourneyId: 'jrn-001', templateStepId: 'ts-002', stepOrder: 2, stepName: 'Agency Referral',    stepDescription: 'Refer to LA County Housing Authority', pointsOnCompletion: 150, requiredDocuments: ['referral_letter'], status: 'completed', startedAt: '2026-04-06T00:00:00Z', completedAt: '2026-04-12T00:00:00Z', dueDate: null, pointsAwarded: 150, createdAt: '2026-04-06T00:00:00Z' },
      { id: 'step-003', memberJourneyId: 'jrn-001', templateStepId: 'ts-003', stepOrder: 3, stepName: 'Application Support', stepDescription: 'Assist with voucher application', pointsOnCompletion: 200, requiredDocuments: [], status: 'in_progress', startedAt: '2026-04-15T00:00:00Z', completedAt: null, dueDate: '2026-05-20T00:00:00Z', pointsAwarded: 0, createdAt: '2026-04-15T00:00:00Z' },
      { id: 'step-004', memberJourneyId: 'jrn-001', templateStepId: 'ts-004', stepOrder: 4, stepName: 'Housing Placement',  stepDescription: 'Confirm permanent housing placement', pointsOnCompletion: 300, requiredDocuments: ['placement_confirmation'], status: 'upcoming', startedAt: null, completedAt: null, dueDate: null, pointsAwarded: 0, createdAt: '2026-04-01T00:00:00Z' },
    ],
    status: 'active',
    progressPercent: 50,
    currentStep: null,
    wellnessPointsEarned: 250,
    startedAt: '2026-04-01T00:00:00Z',
    completedAt: null,
    createdAt: '2026-04-01T00:00:00Z',
  },
  {
    id: 'jrn-002',
    memberId: 'mem-002',
    chwId: 'chw-001',
    template: {
      id: 'tmpl-002',
      slug: 'mental-health-support',
      name: 'Mental Health Support',
      category: 'mental_health',
      icon: 'brain',
      isActive: true,
      steps: [],
      createdAt: '2026-01-15T00:00:00Z',
    },
    steps: [
      { id: 'step-005', memberJourneyId: 'jrn-002', templateStepId: 'ts-005', stepOrder: 1, stepName: 'Screening',         stepDescription: 'PHQ-9 and GAD-7 screening', pointsOnCompletion: 100, requiredDocuments: ['screening_form'], status: 'completed', startedAt: '2026-04-10T00:00:00Z', completedAt: '2026-04-11T00:00:00Z', dueDate: null, pointsAwarded: 100, createdAt: '2026-04-10T00:00:00Z' },
      { id: 'step-006', memberJourneyId: 'jrn-002', templateStepId: 'ts-006', stepOrder: 2, stepName: 'Provider Referral', stepDescription: 'Connect with Didi Hirsch intake', pointsOnCompletion: 150, requiredDocuments: ['referral_letter'], status: 'completed', startedAt: '2026-04-12T00:00:00Z', completedAt: '2026-04-18T00:00:00Z', dueDate: null, pointsAwarded: 150, createdAt: '2026-04-12T00:00:00Z' },
      { id: 'step-007', memberJourneyId: 'jrn-002', templateStepId: 'ts-007', stepOrder: 3, stepName: 'First Appointment', stepDescription: 'Confirm first therapy session', pointsOnCompletion: 200, requiredDocuments: [], status: 'completed', startedAt: '2026-04-25T00:00:00Z', completedAt: '2026-05-02T00:00:00Z', dueDate: null, pointsAwarded: 200, createdAt: '2026-04-25T00:00:00Z' },
    ],
    status: 'completed',
    progressPercent: 100,
    currentStep: null,
    wellnessPointsEarned: 450,
    startedAt: '2026-04-10T00:00:00Z',
    completedAt: '2026-05-02T00:00:00Z',
    createdAt: '2026-04-10T00:00:00Z',
  },
  {
    id: 'jrn-003',
    memberId: 'mem-003',
    chwId: 'chw-001',
    template: {
      id: 'tmpl-003',
      slug: 'food-security',
      name: 'Food Security',
      category: 'food',
      icon: 'utensils',
      isActive: true,
      steps: [],
      createdAt: '2026-01-20T00:00:00Z',
    },
    steps: [
      { id: 'step-008', memberJourneyId: 'jrn-003', templateStepId: 'ts-008', stepOrder: 1, stepName: 'CalFresh Eligibility', stepDescription: 'Verify CalFresh eligibility', pointsOnCompletion: 100, requiredDocuments: [], status: 'completed', startedAt: '2026-05-01T00:00:00Z', completedAt: '2026-05-02T00:00:00Z', dueDate: null, pointsAwarded: 100, createdAt: '2026-05-01T00:00:00Z' },
      { id: 'step-009', memberJourneyId: 'jrn-003', templateStepId: 'ts-009', stepOrder: 2, stepName: 'Application',         stepDescription: 'Submit CalFresh application', pointsOnCompletion: 150, requiredDocuments: ['application'], status: 'in_progress', startedAt: '2026-05-05T00:00:00Z', completedAt: null, dueDate: '2026-05-15T00:00:00Z', pointsAwarded: 0, createdAt: '2026-05-05T00:00:00Z' },
    ],
    status: 'active',
    progressPercent: 33,
    currentStep: null,
    wellnessPointsEarned: 100,
    startedAt: '2026-05-01T00:00:00Z',
    completedAt: null,
    createdAt: '2026-05-01T00:00:00Z',
  },
  {
    id: 'jrn-004',
    memberId: 'mem-004',
    chwId: 'chw-001',
    template: {
      id: 'tmpl-001',
      slug: 'housing-stability',
      name: 'Housing Stability',
      category: 'housing',
      icon: 'home',
      isActive: true,
      steps: [],
      createdAt: '2026-01-10T00:00:00Z',
    },
    steps: [
      { id: 'step-010', memberJourneyId: 'jrn-004', templateStepId: 'ts-001', stepOrder: 1, stepName: 'Initial Assessment', stepDescription: 'Complete SDOH housing assessment', pointsOnCompletion: 100, requiredDocuments: ['assessment_form'], status: 'completed', startedAt: '2026-03-15T00:00:00Z', completedAt: '2026-03-20T00:00:00Z', dueDate: null, pointsAwarded: 100, createdAt: '2026-03-15T00:00:00Z' },
      { id: 'step-011', memberJourneyId: 'jrn-004', templateStepId: 'ts-002', stepOrder: 2, stepName: 'Agency Referral',    stepDescription: 'Refer to LA County Housing Authority', pointsOnCompletion: 150, requiredDocuments: ['referral_letter'], status: 'missed', startedAt: null, completedAt: null, dueDate: '2026-04-01T00:00:00Z', pointsAwarded: 0, createdAt: '2026-03-15T00:00:00Z' },
    ],
    status: 'paused',
    progressPercent: 25,
    currentStep: null,
    wellnessPointsEarned: 100,
    startedAt: '2026-03-15T00:00:00Z',
    completedAt: null,
    createdAt: '2026-03-15T00:00:00Z',
  },
];

// Member name map for mock data (real data includes member_name from API join)
// TODO: replace with real hook — member names come from the backend join
const MOCK_MEMBER_NAMES: Record<string, string> = {
  'mem-001': 'Maria Rivera',
  'mem-002': 'David Chen',
  'mem-003': 'Tamika Johnson',
  'mem-004': 'Arjun Patel',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<JourneyStatus, {
  label: string;
  pillVariant: 'emerald' | 'amber' | 'gray' | 'red';
  Icon: React.FC<{ size: number; color: string }>;
}> = {
  active:    { label: 'Active',    pillVariant: 'emerald', Icon: CircleDot   },
  paused:    { label: 'Paused',    pillVariant: 'amber',   Icon: Pause       },
  completed: { label: 'Completed', pillVariant: 'gray',    Icon: CheckCircle2 },
  abandoned: { label: 'Abandoned', pillVariant: 'red',     Icon: XCircle     },
};

const STEP_STATUS_CONFIG: Record<StepStatus, { color: string; Icon: React.FC<{ size: number; color: string }> }> = {
  upcoming:    { color: colors.textMuted,   Icon: Clock        },
  in_progress: { color: colors.blue700,     Icon: CircleDot    },
  completed:   { color: colors.emerald700,  Icon: CheckCircle2 },
  missed:      { color: colors.red700,      Icon: XCircle      },
};

const STATUS_FILTER_LABELS: Record<StatusFilter, string> = {
  all:       'All',
  active:    'Active',
  paused:    'Paused',
  completed: 'Completed',
  abandoned: 'Abandoned',
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── Progress bar ─────────────────────────────────────────────────────────────

function ProgressBar({ percent }: { percent: number }): React.JSX.Element {
  return (
    <View style={progressStyles.track} accessibilityLabel={`${Math.round(percent)}% complete`}>
      <View
        style={[
          progressStyles.fill,
          { width: `${Math.round(percent)}%` as unknown as number },
        ]}
      />
    </View>
  );
}

const progressStyles = StyleSheet.create({
  track: {
    height: 6,
    backgroundColor: colors.gray100,
    borderRadius: radius.pill,
    overflow: 'hidden',
    flex: 1,
  } as ViewStyle,
  fill: {
    height: '100%',
    backgroundColor: colors.primary,
    borderRadius: radius.pill,
  } as ViewStyle,
});

// ─── Journey card ─────────────────────────────────────────────────────────────

interface JourneyCardProps {
  journey: MemberJourneyResponse;
  memberName: string;
}

function JourneyCard({ journey, memberName }: JourneyCardProps): React.JSX.Element {
  const statusCfg = STATUS_CONFIG[journey.status];
  const StatusIcon = statusCfg.Icon;
  const [expanded, setExpanded] = useState(false);

  const currentStep = journey.steps.find((s) => s.status === 'in_progress') ?? null;
  const completedCount = journey.steps.filter((s) => s.status === 'completed').length;

  return (
    <Card style={journeyCardStyles.card}>
      {/* Header */}
      <View style={journeyCardStyles.headerRow}>
        <View style={journeyCardStyles.nameBlock}>
          <Text style={journeyCardStyles.memberName}>{memberName}</Text>
          <Text style={journeyCardStyles.templateName}>{journey.template.name}</Text>
        </View>
        <View style={journeyCardStyles.statusBadge}>
          <StatusIcon
            size={12}
            color={statusCfg.pillVariant === 'emerald' ? colors.emerald700 : statusCfg.pillVariant === 'amber' ? colors.amber700 : statusCfg.pillVariant === 'red' ? colors.red700 : colors.gray700}
          />
          <Pill variant={statusCfg.pillVariant} size="sm">{statusCfg.label}</Pill>
        </View>
      </View>

      {/* Progress row */}
      <View style={journeyCardStyles.progressRow}>
        <ProgressBar percent={journey.progressPercent} />
        <Text style={journeyCardStyles.progressLabel}>
          {Math.round(journey.progressPercent)}% · {completedCount}/{journey.steps.length} steps
        </Text>
      </View>

      {/* Current step */}
      {currentStep !== null && (
        <View style={journeyCardStyles.currentStepRow}>
          <CircleDot size={12} color={colors.blue700} />
          <Text style={journeyCardStyles.currentStepText} numberOfLines={1}>
            Current: {currentStep.stepName}
          </Text>
          {currentStep.dueDate !== null && (
            <Text style={journeyCardStyles.dueDateText}>
              Due {formatDate(currentStep.dueDate)}
            </Text>
          )}
        </View>
      )}

      {/* Wellness points */}
      <View style={journeyCardStyles.pointsRow}>
        <Trophy size={12} color={colors.amber700} />
        <Text style={journeyCardStyles.pointsText}>
          {journey.wellnessPointsEarned} pts earned
        </Text>
        <Text style={journeyCardStyles.startedText}>
          Started {formatDate(journey.startedAt)}
        </Text>
      </View>

      {/* Expand/collapse step list */}
      <TouchableOpacity
        style={journeyCardStyles.expandButton}
        onPress={() => setExpanded((prev) => !prev)}
        accessible
        accessibilityRole="button"
        accessibilityLabel={expanded ? 'Collapse steps' : 'Expand steps'}
        accessibilityState={{ expanded }}
      >
        <Text style={journeyCardStyles.expandText}>
          {expanded ? 'Hide steps' : `Show all steps (${journey.steps.length})`}
        </Text>
      </TouchableOpacity>

      {expanded && journey.steps.length > 0 && (
        <View style={journeyCardStyles.stepList}>
          {journey.steps.map((step) => {
            const stepCfg = STEP_STATUS_CONFIG[step.status];
            const StepIcon = stepCfg.Icon;
            return (
              <View key={step.id} style={journeyCardStyles.stepRow}>
                <StepIcon size={12} color={stepCfg.color} />
                <Text style={[journeyCardStyles.stepName, { color: step.status === 'missed' ? colors.red700 : colors.textPrimary }]}>
                  {step.stepOrder}. {step.stepName}
                </Text>
                {step.pointsAwarded > 0 && (
                  <Text style={journeyCardStyles.stepPoints}>+{step.pointsAwarded}pts</Text>
                )}
              </View>
            );
          })}
        </View>
      )}
    </Card>
  );
}

const journeyCardStyles = StyleSheet.create({
  card: {
    padding: spacing.lg,
    gap: spacing.sm,
    width: Platform.OS === 'web' ? 'calc(50% - 8px)' as unknown as number : '100%',
  } as ViewStyle,

  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.sm,
  } as ViewStyle,

  nameBlock: {
    flex: 1,
    gap: 2,
  } as ViewStyle,

  memberName: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.textPrimary,
  } as TextStyle,

  templateName: {
    fontSize: 12,
    color: colors.primary,
    fontWeight: '500',
  } as TextStyle,

  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  } as ViewStyle,

  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  } as ViewStyle,

  progressLabel: {
    fontSize: 11,
    color: colors.textSecondary,
    whiteSpace: 'nowrap',
    flexShrink: 0,
  } as TextStyle,

  currentStepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.blue100,
    borderRadius: radius.md,
    padding: spacing.sm,
  } as ViewStyle,

  currentStepText: {
    flex: 1,
    fontSize: 12,
    color: colors.blue700,
    fontWeight: '500',
  } as TextStyle,

  dueDateText: {
    fontSize: 11,
    color: colors.blue700,
    flexShrink: 0,
  } as TextStyle,

  pointsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  } as ViewStyle,

  pointsText: {
    fontSize: 12,
    color: colors.amber700,
    fontWeight: '600',
  } as TextStyle,

  startedText: {
    fontSize: 11,
    color: colors.textMuted,
    flex: 1,
    textAlign: 'right',
  } as TextStyle,

  expandButton: {
    borderTopWidth: 1,
    borderTopColor: colors.cardBorder,
    paddingTop: spacing.sm,
    marginTop: spacing.xs,
  } as ViewStyle,

  expandText: {
    fontSize: 12,
    color: colors.primary,
    fontWeight: '500',
  } as TextStyle,

  stepList: {
    gap: spacing.xs,
  } as ViewStyle,

  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  } as ViewStyle,

  stepName: {
    flex: 1,
    fontSize: 12,
    lineHeight: 16,
  } as TextStyle,

  stepPoints: {
    fontSize: 10,
    color: colors.amber700,
    fontWeight: '600',
  } as TextStyle,
});

// ─── Screen ───────────────────────────────────────────────────────────────────

export function CHWJourneysScreen(): React.JSX.Element {
  const { userName } = useAuth();
  const [activeStatus, setActiveStatus] = useState<StatusFilter>('all');

  // Real data hook — falls back to mock data if the endpoint is unavailable.
  const { data: apiJourneys, isLoading, isError } = useChwJourneys();

  // Use API data when available, fall back to mock data on error or during
  // initial development when the endpoint may not yet be registered.
  const journeys: MemberJourneyResponse[] = useMemo(() => {
    if (apiJourneys !== undefined && apiJourneys.length > 0) return apiJourneys;
    return MOCK_JOURNEYS;
  }, [apiJourneys]);

  const filtered = useMemo(() => {
    if (activeStatus === 'all') return journeys;
    return journeys.filter((j) => j.status === activeStatus);
  }, [journeys, activeStatus]);

  const activeCount    = journeys.filter((j) => j.status === 'active').length;
  const completedCount = journeys.filter((j) => j.status === 'completed').length;
  const totalPoints    = journeys.reduce((sum, j) => sum + j.wellnessPointsEarned, 0);
  const statusFilters  = Object.keys(STATUS_FILTER_LABELS) as StatusFilter[];

  const userInitials = (userName ?? 'CHW')
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  const content = (
    <>
      <PageHeader
        title="Journeys"
        subtitle={`${journeys.length} member journeys · ${activeCount} active`}
      />

      {/* Data source notice when using mock fallback */}
      {isError && (
        <View style={styles.fallbackBanner}>
          <Sparkles size={13} color={colors.amber700} />
          <Text style={styles.fallbackText}>
            Using preview data — /chw/journeys endpoint not yet reachable.
          </Text>
        </View>
      )}

      {/* Stat row */}
      <View style={styles.statRow}>
        <StatTile
          icon={<Route size={18} color={colors.emerald700} />}
          iconBg={colors.emerald100}
          label="Active Journeys"
          value={activeCount}
          style={styles.statTile}
        />
        <StatTile
          icon={<CheckCircle2 size={18} color={colors.blue700} />}
          iconBg={colors.blue100}
          label="Completed"
          value={completedCount}
          style={styles.statTile}
        />
        <StatTile
          icon={<Trophy size={18} color={colors.amber700} />}
          iconBg={colors.amber100}
          label="Total Points Awarded"
          value={totalPoints.toLocaleString()}
          style={styles.statTile}
        />
        <StatTile
          icon={<Users size={18} color={colors.purple700} />}
          iconBg={colors.purple100}
          label="Members on Journeys"
          value={journeys.length}
          style={styles.statTile}
        />
      </View>

      {/* Status filter chips */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chipRow}
        contentContainerStyle={styles.chipRowContent}
      >
        {statusFilters.map((sf) => (
          <TouchableOpacity
            key={sf}
            onPress={() => setActiveStatus(sf)}
            style={[styles.filterChip, activeStatus === sf && styles.filterChipActive]}
            accessible
            accessibilityRole="button"
            accessibilityLabel={`Filter by ${STATUS_FILTER_LABELS[sf]}`}
            accessibilityState={{ selected: activeStatus === sf }}
          >
            <Text style={[styles.filterChipText, activeStatus === sf && styles.filterChipTextActive]}>
              {STATUS_FILTER_LABELS[sf]}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Body */}
      <View style={styles.bodyRow}>
        <View style={styles.grid}>
          {isLoading ? (
            <View style={styles.loadingWrap}>
              <ActivityIndicator size="large" color={colors.primary} />
              <Text style={styles.loadingText}>Loading journeys…</Text>
            </View>
          ) : filtered.length === 0 ? (
            <Card style={styles.emptyCard}>
              <Text style={styles.emptyText}>No journeys match this filter.</Text>
            </Card>
          ) : (
            <View style={styles.gridInner}>
              {filtered.map((journey) => {
                const memberName =
                  MOCK_MEMBER_NAMES[journey.memberId] ??
                  `Member ${journey.memberId.slice(-4)}`;
                return (
                  <JourneyCard
                    key={journey.id}
                    journey={journey}
                    memberName={memberName}
                  />
                );
              })}
            </View>
          )}
        </View>

        {Platform.OS === 'web' && (
          <RightRail>
            <Card style={styles.railCard}>
              <Text style={styles.railTitle}>Journey Health</Text>
              <View style={styles.healthList}>
                {(Object.keys(STATUS_CONFIG) as JourneyStatus[]).map((st) => {
                  const count = journeys.filter((j) => j.status === st).length;
                  const cfg = STATUS_CONFIG[st];
                  const StIcon = cfg.Icon;
                  return (
                    <View key={st} style={styles.healthItem}>
                      <StIcon
                        size={13}
                        color={
                          cfg.pillVariant === 'emerald' ? colors.emerald700
                          : cfg.pillVariant === 'amber' ? colors.amber700
                          : cfg.pillVariant === 'red'   ? colors.red700
                          : colors.gray700
                        }
                      />
                      <Text style={styles.healthLabel}>{cfg.label}</Text>
                      <Text style={styles.healthCount}>{count}</Text>
                    </View>
                  );
                })}
              </View>
            </Card>

            <Card style={styles.railCard}>
              <View style={styles.railTitleRow}>
                <TrendingUp size={14} color={colors.primary} />
                <Text style={styles.railTitle}>At-Risk Journeys</Text>
              </View>
              <View style={styles.atRiskList}>
                {journeys
                  .filter(
                    (j) =>
                      j.status === 'active' &&
                      j.steps.some((s) => s.status === 'missed'),
                  )
                  .map((j) => (
                    <View key={j.id} style={styles.atRiskItem}>
                      <XCircle size={11} color={colors.red700} />
                      <Text style={styles.atRiskName} numberOfLines={1}>
                        {MOCK_MEMBER_NAMES[j.memberId] ?? j.memberId} — {j.template.name}
                      </Text>
                    </View>
                  ))}
                {journeys.filter((j) => j.status === 'active' && j.steps.some((s) => s.status === 'missed')).length === 0 && (
                  <Text style={styles.noAtRisk}>All active journeys on track.</Text>
                )}
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
      activeKey="journeys"
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

  fallbackBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.amber100,
    borderRadius: radius.md,
    padding: spacing.sm,
    marginBottom: spacing.md,
  } as ViewStyle,

  fallbackText: {
    flex: 1,
    fontSize: 12,
    color: colors.amber700,
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

  chipRow: {
    marginBottom: spacing.lg,
  } as ViewStyle,

  chipRowContent: {
    gap: spacing.sm,
    paddingRight: spacing.md,
  } as ViewStyle,

  filterChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    backgroundColor: colors.cardBg,
  } as ViewStyle,

  filterChipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  } as ViewStyle,

  filterChipText: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.textSecondary,
  } as TextStyle,

  filterChipTextActive: {
    color: colors.cardBg,
  } as TextStyle,

  bodyRow: {
    flexDirection: 'row',
    gap: spacing.xl,
    alignItems: 'flex-start',
  } as ViewStyle,

  grid: {
    flex: 1,
  } as ViewStyle,

  gridInner: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.lg,
  } as ViewStyle,

  loadingWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.xxl,
  } as ViewStyle,

  loadingText: {
    fontSize: 14,
    color: colors.textSecondary,
  } as TextStyle,

  emptyCard: {
    padding: spacing.xl,
    alignItems: 'center',
  } as ViewStyle,

  emptyText: {
    fontSize: 14,
    color: colors.textSecondary,
  } as TextStyle,

  railCard: {
    padding: spacing.lg,
    gap: spacing.md,
  } as ViewStyle,

  railTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.xs,
  } as ViewStyle,

  railTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.textPrimary,
  } as TextStyle,

  healthList: {
    gap: spacing.sm,
  } as ViewStyle,

  healthItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  } as ViewStyle,

  healthLabel: {
    flex: 1,
    fontSize: 12,
    color: colors.textSecondary,
  } as TextStyle,

  healthCount: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.textPrimary,
  } as TextStyle,

  atRiskList: {
    gap: spacing.sm,
  } as ViewStyle,

  atRiskItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  } as ViewStyle,

  atRiskName: {
    flex: 1,
    fontSize: 12,
    color: colors.textPrimary,
  } as TextStyle,

  noAtRisk: {
    fontSize: 12,
    color: colors.emerald700,
    fontWeight: '500',
  } as TextStyle,
});

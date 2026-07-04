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
  XCircle,
  Pause,
  Trophy,
  TrendingUp,
  Sparkles,
  ChevronDown,
  ChevronUp,
  Circle,
} from 'lucide-react-native';

import { AppShell, EmptyState, PageHeader, Card, Pill, RightRail, StatTile } from '../../components/ui';
import { colors, spacing, radius } from '../../theme/tokens';
import { useAuth } from '../../context/AuthContext';
import {
  useChwJourneys,
  useChwJourneyDetail,
  useUpdateJourneyStep,
  type MemberJourneyResponse,
  type MemberJourneyStepResponse,
} from '../../hooks/useApiQueries';
import { PressableMember } from '../../components/shared/PressableMember';
import { POINTS_ENABLED } from '../../constants/featureFlags';

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

/** Returns the label character for a step pill: ✓ completed, ● in_progress, ⚠ missed, blank for upcoming */
function stepPillLabel(status: StepStatus): string {
  switch (status) {
    case 'completed':   return '✓ ';
    case 'in_progress': return '● ';
    case 'missed':      return '⚠ ';
    default:            return '';
  }
}

function stepPillColors(status: StepStatus): { bg: string; text: string } {
  switch (status) {
    case 'completed':   return { bg: colors.emerald100, text: colors.emerald700 };
    case 'in_progress': return { bg: colors.amber100,   text: colors.amber700   };
    case 'missed':      return { bg: colors.red100,     text: colors.red700     };
    default:            return { bg: colors.gray100,    text: colors.textSecondary };
  }
}

interface JourneyCardProps {
  journey: MemberJourneyResponse;
  memberName: string;
  /** When true, renders with amber border/bg to indicate stalled status */
  stalled?: boolean;
}

/** Per-step icon for the expanded step list. */
function StepStatusIcon({ status }: { status: StepStatus }): React.JSX.Element {
  switch (status) {
    case 'completed':   return <CheckCircle2 size={18} color={colors.emerald700} />;
    case 'in_progress': return <CircleDot size={18} color={colors.amber700} />;
    case 'missed':      return <XCircle size={18} color={colors.red700} />;
    default:            return <Circle size={18} color={colors.textSecondary} />;
  }
}

interface StepRowProps {
  step: MemberJourneyStepResponse;
  /** True when this is the member's current position on the journey. */
  isCurrent: boolean;
  /** True while any step mutation on this journey is in flight. */
  busy: boolean;
  onComplete: (step: MemberJourneyStepResponse) => void;
}

/** A single expanded step row: status icon, name/description, points, reward action. */
function StepRow({ step, isCurrent, busy, onComplete }: StepRowProps): React.JSX.Element {
  const isCompleted = step.status === 'completed';
  return (
    <View style={[stepStyles.row, isCurrent && stepStyles.rowCurrent]}>
      <StepStatusIcon status={step.status} />
      <View style={stepStyles.body}>
        <View style={stepStyles.titleRow}>
          <Text style={[stepStyles.name, isCurrent && stepStyles.nameCurrent]} numberOfLines={2}>
            {step.stepName}
          </Text>
          {isCurrent && (
            <View style={stepStyles.currentBadge}>
              <Text style={stepStyles.currentBadgeText}>Current</Text>
            </View>
          )}
        </View>
        {step.stepDescription ? (
          <Text style={stepStyles.description} numberOfLines={2}>
            {step.stepDescription}
          </Text>
        ) : null}
      </View>
      <View style={stepStyles.action}>
        {isCompleted ? (
          <View style={stepStyles.awardedPill}>
            {POINTS_ENABLED ? (
              <>
                <Trophy size={11} color={colors.emerald700} />
                <Text style={stepStyles.awardedText}>{step.pointsAwarded} pts</Text>
              </>
            ) : (
              <>
                <CheckCircle2 size={11} color={colors.emerald700} />
                <Text style={stepStyles.awardedText}>Completed</Text>
              </>
            )}
          </View>
        ) : (
          <TouchableOpacity
            style={[stepStyles.rewardBtn, busy && stepStyles.rewardBtnDisabled]}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={
              POINTS_ENABLED
                ? `Mark ${step.stepName} complete and award ${step.pointsOnCompletion} points`
                : `Mark ${step.stepName} complete`
            }
            onPress={() => onComplete(step)}
          >
            <CheckCircle2 size={12} color="#FFFFFF" />
            <Text style={stepStyles.rewardBtnText}>
              {POINTS_ENABLED
                ? `Complete · +${step.pointsOnCompletion} pts`
                : 'Mark Complete'}
            </Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

function JourneyCard({ journey, memberName, stalled = false }: JourneyCardProps): React.JSX.Element {
  const hasMissedStep = journey.steps.some((s) => s.status === 'missed');
  const [expanded, setExpanded] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Only fetch full step detail once the card is expanded — keeps the list light.
  const detail = useChwJourneyDetail(journey.id, expanded);
  const updateStep = useUpdateJourneyStep();

  const steps = detail.data?.steps ?? [];
  const currentStepId = detail.data?.currentStep?.id ?? null;

  const handleComplete = (step: MemberJourneyStepResponse) => {
    setErrorMsg(null);
    updateStep.mutate(
      { journeyId: journey.id, stepId: step.templateStepId, status: 'completed' },
      {
        onError: () =>
          setErrorMsg(`Could not award "${step.stepName}". Please try again.`),
      },
    );
  };

  return (
    <Card style={[journeyCardStyles.card, stalled && journeyCardStyles.stalledCard]}>
      {/* Header: tap to expand/collapse the step detail */}
      <TouchableOpacity
        style={journeyCardStyles.headerRow}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${expanded ? 'Collapse' : 'Expand'} ${memberName}'s ${journey.template.name} journey`}
        onPress={() => setExpanded((v) => !v)}
      >
        <View style={[journeyCardStyles.iconCircle, journeyCardStyles[`iconBg_${journey.template.category}` as keyof typeof journeyCardStyles] ?? journeyCardStyles.iconBg_default]}>
          <Route size={18} color={colors.emerald700} />
        </View>
        <View style={journeyCardStyles.nameBlock}>
          <View style={journeyCardStyles.memberNameRow}>
            <PressableMember memberId={journey.memberId} displayName={memberName}>
              <Text style={[journeyCardStyles.memberName, journeyCardStyles.memberNameLink]}>
                {memberName}
              </Text>
            </PressableMember>
            <Text style={journeyCardStyles.memberName}>
              {' · '}{journey.template.name}
            </Text>
          </View>
          {stalled ? (
            <Text style={journeyCardStyles.stalledSubtitle}>
              {hasMissedStep ? 'Missed step — needs attention' : 'Paused · no movement'}
            </Text>
          ) : journey.currentStepName ? (
            <Text style={journeyCardStyles.currentStepSubtitle}>
              Current: {journey.currentStepName}
            </Text>
          ) : null}
        </View>
        <View style={[journeyCardStyles.pctBadge, { backgroundColor: colors.emerald100 }]}>
          <Text style={journeyCardStyles.pctBadgeText}>
            {Math.round(journey.progressPercent)}%
          </Text>
        </View>
        {expanded ? (
          <ChevronUp size={18} color={colors.textSecondary} />
        ) : (
          <ChevronDown size={18} color={colors.textSecondary} />
        )}
      </TouchableOpacity>

      {/* Horizontal progress bar */}
      <ProgressBar percent={journey.progressPercent} />

      {/* Step pills row (collapsed summary, only when detail is loaded) */}
      {steps.length > 0 && (
        <View style={journeyCardStyles.stepPills}>
          {steps.map((step) => {
            const { bg, text } = stepPillColors(step.status);
            return (
              <View key={step.id} style={[journeyCardStyles.stepPill, { backgroundColor: bg }]}>
                <Text style={[journeyCardStyles.stepPillText, { color: text }]}>
                  {stepPillLabel(step.status)}{step.stepName}
                </Text>
              </View>
            );
          })}
        </View>
      )}

      {/* Expanded step detail + reward actions */}
      {expanded && (
        <View style={journeyCardStyles.expandedPanel}>
          {detail.isLoading ? (
            <ActivityIndicator color={colors.emerald700} style={{ marginVertical: spacing.md }} />
          ) : detail.isError ? (
            <Text style={stepStyles.errorText}>
              Could not load steps. Pull to refresh or try again.
            </Text>
          ) : steps.length === 0 ? (
            <Text style={stepStyles.emptyText}>This journey has no steps yet.</Text>
          ) : (
            <>
              {steps.map((step) => (
                <StepRow
                  key={step.id}
                  step={step}
                  isCurrent={step.id === currentStepId}
                  busy={updateStep.isPending}
                  onComplete={handleComplete}
                />
              ))}
              {errorMsg ? <Text style={stepStyles.errorText}>{errorMsg}</Text> : null}
            </>
          )}
        </View>
      )}

      {/* Points + started date (points gated by POINTS_ENABLED) */}
      <View style={journeyCardStyles.pointsRow}>
        {POINTS_ENABLED && (
          <>
            <Trophy size={12} color={colors.amber700} />
            <Text style={journeyCardStyles.pointsText}>
              {journey.wellnessPointsEarned} pts earned
            </Text>
          </>
        )}
        <Text style={journeyCardStyles.startedText}>
          Started {formatDate(journey.startedAt)}
        </Text>
      </View>
    </Card>
  );
}

const stepStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.gray100,
  } as ViewStyle,
  rowCurrent: {
    backgroundColor: colors.amber100,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    borderBottomColor: 'transparent',
  } as ViewStyle,
  body: {
    flex: 1,
    gap: 2,
  } as ViewStyle,
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flexWrap: 'wrap',
  } as ViewStyle,
  name: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary,
  } as TextStyle,
  nameCurrent: {
    color: colors.amber700,
  } as TextStyle,
  currentBadge: {
    backgroundColor: colors.amber700,
    borderRadius: radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 1,
  } as ViewStyle,
  currentBadgeText: {
    fontSize: 9,
    fontWeight: '700',
    color: '#FFFFFF',
    textTransform: 'uppercase',
  } as TextStyle,
  description: {
    fontSize: 11,
    color: colors.textSecondary,
  } as TextStyle,
  action: {
    flexShrink: 0,
  } as ViewStyle,
  rewardBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.emerald700,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  } as ViewStyle,
  rewardBtnDisabled: {
    opacity: 0.5,
  } as ViewStyle,
  rewardBtnText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#FFFFFF',
  } as TextStyle,
  awardedPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.emerald100,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  } as ViewStyle,
  awardedText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.emerald700,
  } as TextStyle,
  errorText: {
    fontSize: 12,
    color: colors.red700,
    marginTop: spacing.sm,
  } as TextStyle,
  emptyText: {
    fontSize: 12,
    color: colors.textSecondary,
    marginVertical: spacing.sm,
  } as TextStyle,
});

const journeyCardStyles = StyleSheet.create({
  card: {
    padding: spacing.xl,
    gap: spacing.sm,
    width: Platform.OS === 'web' ? 'calc(50% - 8px)' as unknown as number : '100%',
  } as ViewStyle,

  stalledCard: {
    borderColor: '#fcd34d',
    backgroundColor: 'rgba(254,243,199,0.2)',
  } as ViewStyle,

  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
  } as ViewStyle,

  iconCircle: {
    width: 44,
    height: 44,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,

  iconBg_housing:      { backgroundColor: colors.red100     } as ViewStyle,
  iconBg_food:         { backgroundColor: colors.orange100   } as ViewStyle,
  iconBg_mental_health:{ backgroundColor: colors.purple100   } as ViewStyle,
  iconBg_healthcare:   { backgroundColor: colors.emerald100  } as ViewStyle,
  iconBg_benefits:     { backgroundColor: colors.emerald100  } as ViewStyle,
  iconBg_default:      { backgroundColor: colors.emerald100  } as ViewStyle,

  nameBlock: {
    flex: 1,
    gap: 2,
  } as ViewStyle,

  memberNameRow: {
    flexDirection: 'row',
    alignItems:    'baseline',
    flexWrap:      'wrap',
  } as ViewStyle,

  memberName: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary,
    lineHeight: 20,
  } as TextStyle,

  memberNameLink: {
    textDecorationLine: 'underline',
    textDecorationStyle: 'dotted',
  } as TextStyle,

  stalledSubtitle: {
    fontSize: 11,
    color: colors.amber700,
    fontWeight: '500',
  } as TextStyle,

  currentStepSubtitle: {
    fontSize: 11,
    color: colors.textSecondary,
    fontWeight: '500',
  } as TextStyle,

  expandedPanel: {
    marginTop: spacing.xs,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.gray100,
    gap: 2,
  } as ViewStyle,

  pctBadge: {
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  } as ViewStyle,

  pctBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.emerald700,
  } as TextStyle,

  stepPills: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginTop: spacing.xs,
  } as ViewStyle,

  stepPill: {
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  } as ViewStyle,

  stepPillText: {
    fontSize: 11,
    fontWeight: '500',
  } as TextStyle,

  pointsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderTopWidth: 1,
    borderTopColor: colors.cardBorder,
    paddingTop: spacing.sm,
    marginTop: spacing.xs,
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
});

// ─── Screen ───────────────────────────────────────────────────────────────────

export function CHWJourneysScreen(): React.JSX.Element {
  const { userName } = useAuth();
  const [activeStatus, setActiveStatus] = useState<StatusFilter>('all');

  // Real data hook — falls back to mock data if the endpoint is unavailable.
  const { data: apiJourneys, isLoading, isError } = useChwJourneys();

  // Show the REAL caseload journeys whenever the query succeeded — including an
  // empty list (so a CHW with no journeys sees the true empty state rather than
  // fake demo names). Only fall back to mock data when the endpoint itself is
  // unreachable (isError), which also surfaces the "preview data" banner above.
  const journeys: MemberJourneyResponse[] = useMemo(() => {
    if (apiJourneys !== undefined) return apiJourneys;
    if (isError) return MOCK_JOURNEYS;
    return [];
  }, [apiJourneys, isError]);

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
              <EmptyState
                icon={Route}
                title="No journeys found"
                body="No journeys match this filter. Try a different status or check back after assigning a journey."
              />
            </Card>
          ) : (() => {
            const activeJourneys  = filtered.filter((j) => j.status === 'active' && !j.steps.some((s) => s.status === 'missed'));
            const stalledJourneys = filtered.filter((j) => j.status === 'paused' || (j.status === 'active' && j.steps.some((s) => s.status === 'missed')));
            const otherJourneys   = filtered.filter((j) => j.status === 'completed' || j.status === 'abandoned');

            return (
              <View style={styles.sectionsWrap}>
                {activeJourneys.length > 0 && (
                  <>
                    <Text style={styles.sectionHead}>In Progress</Text>
                    <View style={styles.gridInner}>
                      {activeJourneys.map((journey) => {
                        const memberName = journey.memberName ?? MOCK_MEMBER_NAMES[journey.memberId] ?? `Member ${journey.memberId.slice(-4)}`;
                        return <JourneyCard key={journey.id} journey={journey} memberName={memberName} />;
                      })}
                    </View>
                  </>
                )}

                {stalledJourneys.length > 0 && (
                  <>
                    <Text style={[styles.sectionHead, styles.stalledHead]}>Stalled — need your attention</Text>
                    <View style={styles.gridInner}>
                      {stalledJourneys.map((journey) => {
                        const memberName = journey.memberName ?? MOCK_MEMBER_NAMES[journey.memberId] ?? `Member ${journey.memberId.slice(-4)}`;
                        return <JourneyCard key={journey.id} journey={journey} memberName={memberName} stalled />;
                      })}
                    </View>
                  </>
                )}

                {otherJourneys.length > 0 && (
                  <>
                    <Text style={styles.sectionHead}>Completed / Abandoned</Text>
                    <View style={styles.gridInner}>
                      {otherJourneys.map((journey) => {
                        const memberName = journey.memberName ?? MOCK_MEMBER_NAMES[journey.memberId] ?? `Member ${journey.memberId.slice(-4)}`;
                        return <JourneyCard key={journey.id} journey={journey} memberName={memberName} />;
                      })}
                    </View>
                  </>
                )}
              </View>
            );
          })()}
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
                        {j.memberName ?? MOCK_MEMBER_NAMES[j.memberId] ?? j.memberId} — {j.template.name}
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
    flexGrow: 0,
    flexShrink: 0,
  } as ViewStyle,

  chipRowContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingRight: spacing.md,
  } as ViewStyle,

  filterChip: {
    alignSelf: 'flex-start',
    flexShrink: 0,
    // mockup: filter-btn — px-3.5 py-1.5 rounded-10 (14px h / 7px v / r-10)
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    backgroundColor: colors.cardBg,
  } as ViewStyle,

  filterChipActive: {
    backgroundColor: '#ecfdf5',
    borderColor: '#a7f3d0',
  } as ViewStyle,

  filterChipText: {
    // mockup: font-size 13px / font-weight 500
    fontSize: 13,
    fontWeight: '500',
    color: colors.textSecondary,
  } as TextStyle,

  filterChipTextActive: {
    color: '#065f46',
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

  sectionsWrap: {
    gap: spacing.md,
  } as ViewStyle,

  sectionHead: {
    // mockup: text-sm font-semibold text-gray-700 uppercase tracking-wide = 14px/600
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: spacing.xs,
    marginTop: spacing.sm,
  } as TextStyle,

  stalledHead: {
    color: colors.amber700,
  } as TextStyle,

  emptyCard: {
    padding: spacing.xl,
    alignItems: 'center',
  } as ViewStyle,

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

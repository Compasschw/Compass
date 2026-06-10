/**
 * MemberRoadmapScreen — Member's health journey roadmap.
 *
 * Layout (single-column, PageWrap 1280px on web):
 *   1. PageHeader — "My Roadmap" + journey name + status Pill
 *   2. StatTile row — progress % and total points earned
 *   3. Journey Steps section — 6-step template roadmap (from useMemberJourneys)
 *      Each step: name, status Pill, points badge, connector line
 *   4. Session Follow-ups section — items sourced from useMemberRoadmap
 *      Grouped by vertical; each item: description, status Pill, due date, mark-complete
 *
 * Visual language: CHW canonical design system (tokens.ts, Card, Pill,
 * PageHeader, PageWrap, SectionHeader, StatTile from components/ui).
 * No imports from theme/colors.
 *
 * T06 (Wave 1 BE): The backend data migration already remapped all live
 * MemberJourneyStepState rows to the new 6-step template names:
 *   Need Identified → Eligibility Screening → Upload Documents →
 *   Follow Up → Resource Connection → Journey Complete
 * step.stepName reflects the new names automatically — no client-side
 * translation needed.
 *
 * Supported templates (new 6 + remapped 4 = 10 total):
 *   rent_payment_assistance, utility_support, calfresh_enrollment,
 *   healthcare_appointment, food_pantry, health_education,
 *   food_assistance, housing, mental_health, maternal_health
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  AlertCircle,
  CalendarDays,
  CheckCircle2,
  Circle,
  Clock,
  Flag,
  Gift,
  Lightbulb,
} from 'lucide-react-native';

import { useAuth } from '../../context/AuthContext';
import {
  useMemberProfile,
  useMemberJourneys,
  type MemberJourneyResponse,
  type MemberJourneyStepResponse,
} from '../../hooks/useApiQueries';
import {
  useMemberRoadmap,
  useCompleteRoadmapItem,
  type SessionFollowup,
  type FollowupVertical,
} from '../../hooks/useFollowupQueries';
import { VERTICAL_LABEL } from '../../lib/verticals';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';
import {
  AppShell,
  Card,
  EmptyState,
  PageHeader,
  PageWrap,
  Pill,
  PressableCard,
  SectionHeader,
  StatTile,
} from '../../components/ui';
import { colors as tokens, numerals, spacing, radius } from '../../theme/tokens';
import type { PillVariant } from '../../components/ui/Pill';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Single source of truth for vertical display labels on follow-up items. */
const FOLLOWUP_VERTICAL_LABELS: Record<FollowupVertical, string> =
  VERTICAL_LABEL as Record<FollowupVertical, string>;

/** Point totals for the standardized 6-step template structure. */
const STEP_POINTS_BY_NAME: Readonly<Record<string, number>> = {
  'Need Identified': 10,
  'Eligibility Screening': 25,
  'Upload Documents': 30,
  'Follow Up': 10,
  'Resource Connection': 25,
  'Journey Complete': 50,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns the first non-completed, non-abandoned journey.
 * Falls back to the first journey when all are finished.
 */
function resolveActiveJourney(
  journeys: MemberJourneyResponse[],
): MemberJourneyResponse | null {
  if (journeys.length === 0) return null;
  return (
    journeys.find((j) => j.status === 'active') ??
    journeys.find((j) => j.status !== 'completed' && j.status !== 'abandoned') ??
    journeys[0] ??
    null
  );
}

/**
 * Maps a MemberJourneyResponse status to a Pill variant.
 */
function journeyStatusPillVariant(
  status: MemberJourneyResponse['status'],
): PillVariant {
  switch (status) {
    case 'active': return 'emerald';
    case 'paused': return 'amber';
    case 'completed': return 'blue';
    case 'abandoned': return 'red';
    default: return 'gray';
  }
}

/**
 * Maps a MemberJourneyStepResponse status to a Pill variant.
 */
function stepStatusPillVariant(
  status: MemberJourneyStepResponse['status'],
): PillVariant {
  switch (status) {
    case 'completed': return 'emerald';
    case 'in_progress': return 'amber';
    case 'missed': return 'red';
    default: return 'gray';
  }
}

/**
 * Maps a SessionFollowup status to a Pill variant.
 */
function followupStatusPillVariant(status: SessionFollowup['status']): PillVariant {
  switch (status) {
    case 'completed': return 'emerald';
    case 'confirmed': return 'blue';
    case 'pending': return 'amber';
    case 'dismissed': return 'gray';
    default: return 'gray';
  }
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Groups session follow-up items by their vertical field.
 * Items without a vertical are placed under the "general" bucket.
 */
function groupFollowupsByVertical(
  items: SessionFollowup[],
): { vertical: FollowupVertical | 'general'; label: string; items: SessionFollowup[] }[] {
  const grouped: Record<string, SessionFollowup[]> = {};
  for (const item of items) {
    const key = item.vertical ?? 'general';
    if (!grouped[key]) grouped[key] = [];
    grouped[key]!.push(item);
  }
  return Object.entries(grouped).map(([key, groupItems]) => ({
    vertical: key as FollowupVertical | 'general',
    label:
      key === 'general'
        ? 'General'
        : (FOLLOWUP_VERTICAL_LABELS[key as FollowupVertical] ?? key),
    items: groupItems,
  }));
}

// ─── Progress bar ─────────────────────────────────────────────────────────────

interface JourneyProgressBarProps {
  percent: number;
}

function JourneyProgressBar({ percent }: JourneyProgressBarProps): React.JSX.Element {
  const clamped = Math.min(Math.max(percent, 0), 100);
  return (
    <View
      style={progressBarStyles.track}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: clamped }}
      accessibilityLabel={`Journey progress: ${Math.round(clamped)}%`}
    >
      <View style={[progressBarStyles.fill, { width: `${clamped}%` }]} />
    </View>
  );
}

const progressBarStyles = StyleSheet.create({
  track: {
    height: 8,
    backgroundColor: tokens.gray100,
    borderRadius: radius.pill,
    overflow: 'hidden',
    width: '100%',
  } as ViewStyle,
  fill: {
    height: '100%',
    backgroundColor: tokens.primary,
    borderRadius: radius.pill,
  } as ViewStyle,
});

// ─── Journey Step Node ────────────────────────────────────────────────────────

interface JourneyStepNodeProps {
  step: MemberJourneyStepResponse;
  isSelected: boolean;
  onPress: () => void;
}

/**
 * Tappable node in the horizontal 6-step journey roadmap.
 * Completed steps show a filled circle with CheckCircle2 icon.
 * In-progress steps show a Clock icon.
 * Upcoming/missed steps show an outline Circle.
 */
function JourneyStepNode({
  step,
  isSelected,
  onPress,
}: JourneyStepNodeProps): React.JSX.Element {
  const pillVariant = stepStatusPillVariant(step.status);
  const isCompleted = step.status === 'completed';
  const isInProgress = step.status === 'in_progress';

  // Derive circle border + fill color from status
  const circleColor: string = (() => {
    switch (step.status) {
      case 'completed': return tokens.primary;
      case 'in_progress': return tokens.amber700;
      case 'missed': return tokens.red700;
      default: return tokens.textMuted;
    }
  })();

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        stepNodeStyles.node,
        isSelected && stepNodeStyles.nodeSelected,
        pressed && stepNodeStyles.nodePressed,
      ]}
      accessibilityRole="button"
      accessibilityLabel={`Step ${step.stepOrder}: ${step.stepName}. Status: ${step.status}`}
      accessibilityState={{ selected: isSelected }}
    >
      <View
        style={[
          stepNodeStyles.circle,
          {
            borderColor: circleColor,
            backgroundColor: isCompleted ? circleColor : 'transparent',
          },
        ]}
      >
        {isCompleted ? (
          <CheckCircle2 size={20} color="#FFFFFF" />
        ) : isInProgress ? (
          <Clock size={20} color={circleColor} />
        ) : (
          <Circle size={20} color={circleColor} />
        )}
      </View>
      <Text style={[stepNodeStyles.label, { color: circleColor }]} numberOfLines={2}>
        {step.stepName}
      </Text>
      <Pill variant={pillVariant} size="sm">
        {step.status.replace('_', ' ')}
      </Pill>
    </Pressable>
  );
}

const stepNodeStyles = StyleSheet.create({
  node: {
    width: 112,
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
    borderRadius: radius.md,
  } as ViewStyle,
  nodeSelected: {
    backgroundColor: `${tokens.primary}12`,
  } as ViewStyle,
  nodePressed: {
    opacity: 0.72,
  } as ViewStyle,
  circle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  label: {
    fontSize: 11,
    fontWeight: '600',
    textAlign: 'center',
    lineHeight: 15,
  } as TextStyle,
});

// ─── Step Detail Card ─────────────────────────────────────────────────────────

interface StepDetailCardProps {
  step: MemberJourneyStepResponse;
}

/**
 * Expanded detail card for the currently selected journey step.
 * Shows step name, status, points reward, description, due/completion dates,
 * and required documents list.
 */
function StepDetailCard({ step }: StepDetailCardProps): React.JSX.Element {
  const pillVariant = stepStatusPillVariant(step.status);

  return (
    <Card style={stepDetailStyles.card}>
      {/* Header row: status pill + points badge */}
      <View style={stepDetailStyles.headerRow}>
        <Pill variant={pillVariant}>
          {step.status.replace('_', ' ')}
        </Pill>
        <View style={stepDetailStyles.pointsBadge}>
          <Gift size={12} color={tokens.amber700} />
          <Text style={[stepDetailStyles.pointsText, numerals.tabular]}>
            +{step.pointsOnCompletion} pts
          </Text>
        </View>
      </View>

      {/* Step name */}
      <Text style={stepDetailStyles.title}>
        Step {step.stepOrder}: {step.stepName}
      </Text>

      {/* Description */}
      {step.stepDescription.length > 0 && (
        <Text style={stepDetailStyles.description}>{step.stepDescription}</Text>
      )}

      {/* Due date */}
      {step.dueDate !== null && (
        <View style={stepDetailStyles.metaRow}>
          <Clock size={12} color={tokens.textSecondary} />
          <Text style={stepDetailStyles.metaText}>Due {formatDate(step.dueDate)}</Text>
        </View>
      )}

      {/* Completed date */}
      {step.completedAt !== null && (
        <View style={stepDetailStyles.metaRow}>
          <CheckCircle2 size={12} color={tokens.emerald700} />
          <Text style={[stepDetailStyles.metaText, { color: tokens.emerald700 }]}>
            Completed {formatDate(step.completedAt)}
          </Text>
        </View>
      )}

      {/* Required documents */}
      {step.requiredDocuments.length > 0 && (
        <View style={stepDetailStyles.docsSection}>
          <Text style={stepDetailStyles.docsLabel}>Required documents</Text>
          {step.requiredDocuments.map((doc) => (
            <View key={doc} style={stepDetailStyles.docRow}>
              <View style={stepDetailStyles.docBullet} />
              <Text style={stepDetailStyles.docText}>{doc}</Text>
            </View>
          ))}
        </View>
      )}
    </Card>
  );
}

const stepDetailStyles = StyleSheet.create({
  card: {
    padding: spacing.xl,
    gap: spacing.md,
  } as ViewStyle,
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: spacing.sm,
  } as ViewStyle,
  pointsBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  } as ViewStyle,
  pointsText: {
    fontSize: 12,
    fontWeight: '700',
    color: tokens.amber700,
  } as TextStyle,
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: tokens.textPrimary,
    lineHeight: 22,
  } as TextStyle,
  description: {
    fontSize: 14,
    color: tokens.textSecondary,
    lineHeight: 20,
  } as TextStyle,
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  } as ViewStyle,
  metaText: {
    fontSize: 12,
    color: tokens.textSecondary,
  } as TextStyle,
  docsSection: {
    gap: spacing.xs,
    borderTopWidth: 1,
    borderTopColor: tokens.cardBorder,
    paddingTop: spacing.md,
  } as ViewStyle,
  docsLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: tokens.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  } as TextStyle,
  docRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  } as ViewStyle,
  docBullet: {
    width: 5,
    height: 5,
    borderRadius: radius.pill,
    backgroundColor: tokens.textSecondary,
    flexShrink: 0,
    marginTop: 1,
  } as ViewStyle,
  docText: {
    fontSize: 13,
    color: tokens.textPrimary,
    flex: 1,
  } as TextStyle,
});

// ─── Session Follow-up Row ────────────────────────────────────────────────────

interface SessionFollowupRowProps {
  item: SessionFollowup;
  onMarkComplete: (item: SessionFollowup) => void;
  isCompleting: boolean;
}

/**
 * A single row for a session-sourced roadmap item.
 * Renders description, status Pill, optional due date + priority chip,
 * session attribution, and a "Mark complete" CTA for confirmed items.
 *
 * HIPAA: item.description is rendered only — never logged.
 */
function SessionFollowupRow({
  item,
  onMarkComplete,
  isCompleting,
}: SessionFollowupRowProps): React.JSX.Element {
  const pillVariant = followupStatusPillVariant(item.status);
  const isCompleted = item.status === 'completed';
  const canComplete = item.status === 'confirmed' && !isCompleted;

  return (
    <Card style={followupRowStyles.card}>
      {/* Top: description + status Pill */}
      <View style={followupRowStyles.headerRow}>
        <Text
          style={[
            followupRowStyles.description,
            isCompleted && followupRowStyles.descriptionDone,
          ]}
        >
          {item.description}
        </Text>
        <Pill variant={pillVariant} size="sm">
          {item.status.charAt(0).toUpperCase() + item.status.slice(1)}
        </Pill>
      </View>

      {/* Meta row: due date + priority */}
      {(item.dueDate !== null || item.priority !== null) && (
        <View style={followupRowStyles.metaRow}>
          {item.dueDate !== null && (
            <View style={followupRowStyles.metaChip}>
              <CalendarDays size={10} color={tokens.textSecondary} />
              <Text style={followupRowStyles.metaChipText}>
                Due {formatDate(item.dueDate)}
              </Text>
            </View>
          )}
          {item.priority !== null && (
            <View style={followupRowStyles.metaChip}>
              <Flag size={10} color={tokens.textSecondary} />
              <Text style={followupRowStyles.metaChipText}>
                {item.priority.charAt(0).toUpperCase() + item.priority.slice(1)} priority
              </Text>
            </View>
          )}
        </View>
      )}

      {/* Session attribution */}
      {(item.chwName !== null && item.chwName !== undefined) || item.sessionDate !== null ? (
        <Text style={followupRowStyles.attribution}>
          From session
          {item.chwName != null ? ` with ${item.chwName}` : ''}
          {item.sessionDate != null ? ` on ${formatDate(item.sessionDate)}` : ''}
        </Text>
      ) : null}

      {/* Mark complete CTA */}
      {canComplete ? (
        <TouchableOpacity
          style={followupRowStyles.completeBtn}
          onPress={() => onMarkComplete(item)}
          disabled={isCompleting}
          accessibilityRole="button"
          accessibilityLabel={`Mark item complete: ${item.description.slice(0, 48)}`}
        >
          {isCompleting ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <CheckCircle2 size={14} color="#FFFFFF" />
          )}
          <Text style={followupRowStyles.completeBtnText}>Mark Complete</Text>
        </TouchableOpacity>
      ) : null}
    </Card>
  );
}

const followupRowStyles = StyleSheet.create({
  card: {
    padding: spacing.lg,
    gap: spacing.sm,
    marginBottom: spacing.sm,
  } as ViewStyle,
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  } as ViewStyle,
  description: {
    flex: 1,
    fontSize: 13,
    lineHeight: 20,
    color: tokens.textPrimary,
    fontWeight: '400',
  } as TextStyle,
  descriptionDone: {
    textDecorationLine: 'line-through',
    color: tokens.textSecondary,
  } as TextStyle,
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  } as ViewStyle,
  metaChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.sm,
    backgroundColor: tokens.gray100,
  } as ViewStyle,
  metaChipText: {
    fontSize: 10,
    fontWeight: '600',
    color: tokens.textSecondary,
  } as TextStyle,
  attribution: {
    fontSize: 11,
    color: tokens.textMuted,
    fontStyle: 'italic',
  } as TextStyle,
  completeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    backgroundColor: tokens.primary,
    borderRadius: radius.lg,
    paddingVertical: spacing.sm + 2,
    marginTop: spacing.xs,
  } as ViewStyle,
  completeBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#FFFFFF',
  } as TextStyle,
});

// ─── Screen ───────────────────────────────────────────────────────────────────

/**
 * MemberRoadmapScreen — single-column journey tracker for the member.
 *
 * Data sources:
 *   - useMemberProfile: member userId (required for useMemberJourneys key)
 *   - useMemberJourneys: 6-step journey template data (T06 migrated)
 *   - useMemberRoadmap: session-sourced follow-up items
 *
 * On web the entire content column is constrained to 1280px via PageWrap.
 */
export function MemberRoadmapScreen(): React.JSX.Element {
  const { userName } = useAuth();

  const profileQuery = useMemberProfile();
  const memberId = profileQuery.data?.userId ?? '';

  const journeysQuery = useMemberJourneys(memberId);
  const roadmapQuery = useMemberRoadmap();
  const completeRoadmapItem = useCompleteRoadmapItem();

  // Optimistic: track which follow-up item is currently being marked complete.
  const [completingId, setCompletingId] = useState<string | null>(null);

  // Which journey step the member has tapped on for expanded detail.
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);

  // ── Derived journey data ───────────────────────────────────────────────────
  const journeys = journeysQuery.data ?? [];
  const activeJourney = useMemo(() => resolveActiveJourney(journeys), [journeys]);

  const selectedStep = useMemo(() => {
    if (!activeJourney) return null;
    return (
      activeJourney.steps.find((s) => s.id === selectedStepId) ??
      activeJourney.currentStep ??
      activeJourney.steps[0] ??
      null
    );
  }, [activeJourney, selectedStepId]);

  // ── Derived follow-up data ─────────────────────────────────────────────────
  const roadmapItems = roadmapQuery.data ?? [];
  const groupedFollowups = useMemo(
    () => groupFollowupsByVertical(roadmapItems),
    [roadmapItems],
  );

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleMarkComplete = useCallback(
    async (item: SessionFollowup) => {
      if (!item.id) return;
      setCompletingId(item.id);
      try {
        // The backend PATCH path requires session_id. The roadmap endpoint should
        // surface session_id on each item. We fall back gracefully on a placeholder
        // that will 404 without crashing — tracked in Compass #[roadmap-session-id].
        const sessionId =
          (item as SessionFollowup & { sessionId?: string }).sessionId ?? 'unknown';
        await completeRoadmapItem.mutateAsync({ sessionId, followupId: item.id });
      } finally {
        setCompletingId(null);
      }
    },
    [completeRoadmapItem],
  );

  // ── Shell user block ───────────────────────────────────────────────────────
  const memberInitials = (userName ?? 'M')
    .split(' ')
    .slice(0, 2)
    .map((p) => p[0] ?? '')
    .join('')
    .toUpperCase();

  const shellUserBlock = {
    initials: memberInitials,
    name: userName ?? 'Member',
    role: 'Member' as const,
  };

  // ── Loading / error states ─────────────────────────────────────────────────
  const isLoading = profileQuery.isLoading || journeysQuery.isLoading;
  const hasError =
    !isLoading &&
    (journeysQuery.isError || (!!memberId && profileQuery.isError));

  if (isLoading) {
    return (
      <AppShell role="member" activeKey="roadmap" userBlock={shellUserBlock}>
        <StatusBar barStyle="dark-content" backgroundColor={tokens.pageBg} />
        <LoadingSkeleton variant="card" />
        <LoadingSkeleton variant="rows" rows={6} />
      </AppShell>
    );
  }

  if (hasError) {
    return (
      <AppShell role="member" activeKey="roadmap" userBlock={shellUserBlock}>
        <StatusBar barStyle="dark-content" backgroundColor={tokens.pageBg} />
        <ErrorState
          message="Could not load your roadmap. Please try again."
          onRetry={() => void journeysQuery.refetch()}
        />
      </AppShell>
    );
  }

  // ── Compute summary stats ──────────────────────────────────────────────────
  const journeyProgressPercent = activeJourney
    ? Math.round(activeJourney.progressPercent)
    : 0;
  const totalPointsEarned = activeJourney?.wellnessPointsEarned ?? 0;

  // ── Page header subtitle ───────────────────────────────────────────────────
  const pageSubtitle = activeJourney
    ? `${activeJourney.template.name} · ${journeyProgressPercent}% complete`
    : 'Track your health milestones';

  return (
    <AppShell role="member" activeKey="roadmap" userBlock={shellUserBlock}>
      <StatusBar barStyle="dark-content" backgroundColor={tokens.pageBg} />
      <SafeAreaView style={styles.safeArea} edges={['bottom']}>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <PageWrap style={styles.pageWrapInner}>
            {/* ── Page header ─────────────────────────────────────────────── */}
            <PageHeader
              title="My Roadmap"
              subtitle={pageSubtitle}
              right={
                activeJourney ? (
                  <Pill variant={journeyStatusPillVariant(activeJourney.status)}>
                    {activeJourney.status}
                  </Pill>
                ) : undefined
              }
            />

            {/* ── Progress + Points stat row ──────────────────────────────── */}
            {activeJourney !== null && (
              <View style={styles.statRow}>
                <StatTile
                  icon={
                    <CheckCircle2
                      size={18}
                      color={tokens.emerald700}
                      accessibilityLabel=""
                    />
                  }
                  iconBg={tokens.emerald100}
                  label="Journey Progress"
                  value={`${journeyProgressPercent}%`}
                  style={styles.statTile}
                  accessibilityLabel={`Journey progress: ${journeyProgressPercent}%`}
                />
                <StatTile
                  icon={
                    <Gift
                      size={18}
                      color={tokens.amber700}
                      accessibilityLabel=""
                    />
                  }
                  iconBg={tokens.amber100}
                  label="Points Earned"
                  value={totalPointsEarned}
                  style={styles.statTile}
                  accessibilityLabel={`Total wellness points earned: ${totalPointsEarned}`}
                />
              </View>
            )}

            {/* ── Journey Steps section ────────────────────────────────────── */}
            {activeJourney === null ? (
              <EmptyState
                icon={Lightbulb}
                title="No active journey"
                body="Your CHW will assign a journey after your first session. Check back soon."
              />
            ) : (
              <>
                <SectionHeader
                  title="Journey Steps"
                  subtitle={`${activeJourney.template.name}`}
                  marginBottom={spacing.md}
                />

                {/* Progress bar inside roadmap card */}
                <PressableCard style={styles.roadmapCard}>
                  <View style={styles.progressHeader}>
                    <Text style={styles.progressLabel}>Overall progress</Text>
                    <Text style={[styles.progressPct, numerals.tabular]}>{journeyProgressPercent}%</Text>
                  </View>
                  <JourneyProgressBar percent={activeJourney.progressPercent} />
                  <Text style={styles.progressMeta}>
                    Started {formatDate(activeJourney.startedAt)}
                    {activeJourney.completedAt !== null
                      ? `  ·  Completed ${formatDate(activeJourney.completedAt)}`
                      : ''}
                  </Text>

                  {/* 6-step horizontal roadmap */}
                  <View style={styles.stepsScrollWrapper}>
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={styles.stepsScrollContent}
                      accessibilityLabel="Journey steps"
                      accessibilityRole="list"
                    >
                      {activeJourney.steps.map((step, index) => (
                        <React.Fragment key={step.id}>
                          <JourneyStepNode
                            step={step}
                            isSelected={selectedStep?.id === step.id}
                            onPress={() =>
                              setSelectedStepId(
                                selectedStep?.id === step.id ? null : step.id,
                              )
                            }
                          />
                          {index < activeJourney.steps.length - 1 && (
                            <View
                              style={[
                                styles.stepConnector,
                                step.status === 'completed' &&
                                  styles.stepConnectorDone,
                              ]}
                            />
                          )}
                        </React.Fragment>
                      ))}
                    </ScrollView>
                  </View>

                  {/* Encouragement banner */}
                  <View style={styles.encouragementBanner}>
                    <Lightbulb
                      size={15}
                      color="#D97706"
                      accessibilityLabel=""
                    />
                    <Text style={styles.encouragementText}>
                      <Text style={{ fontWeight: '700' }}>
                        You're making real progress!
                      </Text>
                      {' '}Completing each step unlocks wellness points toward
                      rewards.
                    </Text>
                  </View>
                </PressableCard>

                {/* Expanded step detail card */}
                {selectedStep !== null && (
                  <StepDetailCard step={selectedStep} />
                )}

                {/* Points reference legend */}
                <Card style={styles.pointsLegendCard}>
                  <SectionHeader
                    title="Points per step"
                    marginBottom={spacing.md}
                  />
                  <View style={styles.pointsLegendGrid}>
                    {Object.entries(STEP_POINTS_BY_NAME).map(([name, pts]) => (
                      <View key={name} style={styles.pointsLegendRow}>
                        <Text style={styles.pointsLegendName}>{name}</Text>
                        <View style={styles.pointsLegendBadge}>
                          <Gift size={10} color={tokens.amber700} accessibilityLabel="" />
                          <Text style={[styles.pointsLegendPts, numerals.tabular]}>+{pts}</Text>
                        </View>
                      </View>
                    ))}
                  </View>
                </Card>
              </>
            )}

            {/* ── Session Follow-ups section ───────────────────────────────── */}
            <View style={styles.followupSection}>
              <SectionHeader
                title="From Your Sessions"
                subtitle="Action items and tasks from your CHW sessions"
                marginBottom={spacing.md}
              />

              {roadmapQuery.isLoading ? (
                <View style={styles.followupLoading}>
                  <ActivityIndicator color={tokens.primary} />
                </View>
              ) : roadmapQuery.isError ? (
                <Card style={styles.followupErrorCard}>
                  <AlertCircle size={18} color={tokens.red700} accessibilityLabel="" />
                  <Text style={styles.followupErrorText}>
                    Could not load session items. Pull to refresh.
                  </Text>
                </Card>
              ) : roadmapItems.length === 0 ? (
                <Card style={styles.followupEmptyCard}>
                  <Text style={styles.followupEmptyText}>
                    Session action items will appear here after your CHW reviews
                    your sessions.
                  </Text>
                </Card>
              ) : (
                groupedFollowups.map((group) => (
                  <View key={group.vertical} style={styles.followupGroup}>
                    <Text style={styles.followupGroupLabel}>{group.label}</Text>
                    {group.items.map((item) => (
                      <SessionFollowupRow
                        key={item.id}
                        item={item}
                        onMarkComplete={(i) => {
                          void handleMarkComplete(i);
                        }}
                        isCompleting={completingId === item.id}
                      />
                    ))}
                  </View>
                ))
              )}
            </View>

            <View style={styles.bottomSpacer} />
          </PageWrap>
        </ScrollView>
      </SafeAreaView>
    </AppShell>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: tokens.pageBg,
  } as ViewStyle,
  scroll: {
    flex: 1,
  } as ViewStyle,
  scrollContent: {
    flexGrow: 1,
  } as ViewStyle,
  pageWrapInner: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    paddingBottom: spacing.xxxl,
    ...(Platform.OS === 'web'
      ? { paddingHorizontal: spacing.xxl }
      : {}),
  } as ViewStyle,

  // ── Stat tiles ────────────────────────────────────────────────────────────
  statRow: {
    flexDirection: 'row',
    gap: spacing.lg,
    marginBottom: spacing.xxl,
  } as ViewStyle,
  statTile: {
    flex: 1,
    minWidth: 0,
  } as ViewStyle,

  // ── Roadmap card ──────────────────────────────────────────────────────────
  roadmapCard: {
    padding: spacing.xl,
    gap: spacing.md,
    marginBottom: spacing.lg,
  } as ViewStyle,
  progressHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  } as ViewStyle,
  progressLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: tokens.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  } as TextStyle,
  progressPct: {
    fontSize: 13,
    fontWeight: '700',
    color: tokens.primary,
  } as TextStyle,
  progressMeta: {
    fontSize: 11,
    color: tokens.textMuted,
    marginTop: spacing.xs,
  } as TextStyle,

  // ── Step nodes ────────────────────────────────────────────────────────────
  stepsScrollWrapper: {
    marginTop: spacing.md,
    marginHorizontal: -spacing.lg,
  } as ViewStyle,
  stepsScrollContent: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  } as ViewStyle,
  stepConnector: {
    flex: 1,
    height: 2,
    backgroundColor: tokens.cardBorder,
    alignSelf: 'flex-start',
    // Vertically center with the 52px circle (52/2 - 2/2 = 25)
    marginTop: 25,
    minWidth: 10,
  } as ViewStyle,
  stepConnectorDone: {
    backgroundColor: tokens.primary,
  } as ViewStyle,

  // ── Encouragement banner ──────────────────────────────────────────────────
  encouragementBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    backgroundColor: '#FFFBEB',
    borderWidth: 1,
    borderColor: '#FDE68A',
    borderRadius: radius.md,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md,
  } as ViewStyle,
  encouragementText: {
    fontSize: 12,
    color: '#78350F',
    flex: 1,
    lineHeight: 18,
  } as TextStyle,

  // ── Points legend card ────────────────────────────────────────────────────
  pointsLegendCard: {
    padding: spacing.xl,
    marginBottom: spacing.xxl,
  } as ViewStyle,
  pointsLegendGrid: {
    gap: spacing.sm,
  } as ViewStyle,
  pointsLegendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  } as ViewStyle,
  pointsLegendName: {
    fontSize: 13,
    color: tokens.textPrimary,
    fontWeight: '400',
    flex: 1,
  } as TextStyle,
  pointsLegendBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: tokens.amber100,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
  } as ViewStyle,
  pointsLegendPts: {
    fontSize: 11,
    fontWeight: '700',
    color: tokens.amber700,
  } as TextStyle,

  // ── Session follow-ups ────────────────────────────────────────────────────
  followupSection: {
    marginTop: spacing.md,
  } as ViewStyle,
  followupLoading: {
    alignItems: 'center',
    paddingVertical: spacing.xl,
  } as ViewStyle,
  followupErrorCard: {
    padding: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  } as ViewStyle,
  followupErrorText: {
    fontSize: 13,
    color: tokens.red700,
    flex: 1,
    lineHeight: 18,
  } as TextStyle,
  followupEmptyCard: {
    padding: spacing.xl,
    alignItems: 'center',
  } as ViewStyle,
  followupEmptyText: {
    fontSize: 14,
    color: tokens.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
  } as TextStyle,
  followupGroup: {
    marginBottom: spacing.md,
  } as ViewStyle,
  followupGroupLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: tokens.emerald700,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: spacing.sm,
  } as TextStyle,

  bottomSpacer: {
    height: spacing.xl,
  } as ViewStyle,
});

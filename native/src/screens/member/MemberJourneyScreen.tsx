/**
 * MemberJourneyScreen — focused view of the member's active health journey.
 *
 * Data source: useMemberJourneys (GET /members/{id}/journeys).
 * The "active journey" defaults to the first non-completed, non-abandoned
 * entry returned by the API.
 *
 * Layout:
 *   - PageHeader: journey name + status pill
 *   - Horizontal step roadmap (scroll-locked on native, flex-wrap on web)
 *   - Current step detail card (description, required documents, points)
 *   - Right rail (web): other journeys list
 */

import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import type { DrawerScreenProps } from '@react-navigation/drawer';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { MemberTabParamList } from '../../navigation/MemberTabNavigator';
import {
  CheckCircle2,
  Circle,
  Clock,
  FileText,
  Gift,
  Lightbulb,
  Route,
} from 'lucide-react-native';

import { useAuth } from '../../context/AuthContext';
import {
  useMemberProfile,
  useMemberJourneys,
  type MemberJourneyResponse,
  type MemberJourneyStepResponse,
} from '../../hooks/useApiQueries';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';
import {
  AppShell,
  PageHeader,
  Card,
  Pill,
  RightRail,
} from '../../components/ui';
import { colors as tokens } from '../../theme/tokens';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns the first journey that is active or in-progress.
 * Falls back to the first journey if none qualify.
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

function stepStatusColor(status: MemberJourneyStepResponse['status']): string {
  switch (status) {
    case 'completed': return tokens.emerald700;
    case 'in_progress': return tokens.amber700;
    case 'missed': return tokens.red700;
    default: return tokens.textSecondary;
  }
}

function journeyStatusPillVariant(
  status: MemberJourneyResponse['status'],
): import('../../components/ui/Pill').PillVariant {
  switch (status) {
    case 'active': return 'emerald';
    case 'paused': return 'amber';
    case 'completed': return 'blue';
    case 'abandoned': return 'red';
    default: return 'gray';
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface StepNodeProps {
  step: MemberJourneyStepResponse;
  isSelected: boolean;
  onPress: () => void;
}

/**
 * Single node in the horizontal step roadmap.
 * Completed steps show a filled circle; in-progress = amber; others = gray.
 */
function StepNode({ step, isSelected, onPress }: StepNodeProps): React.JSX.Element {
  const color = stepStatusColor(step.status);
  const isCompleted = step.status === 'completed';

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        sn.node,
        isSelected && sn.nodeSelected,
        pressed && { opacity: 0.75 },
      ]}
      accessibilityRole="button"
      accessibilityLabel={`Step ${step.stepOrder}: ${step.stepName}. Status: ${step.status}`}
      accessibilityState={{ selected: isSelected }}
    >
      <View style={[sn.circle, { borderColor: color, backgroundColor: isCompleted ? color : 'transparent' }]}>
        {isCompleted ? (
          <CheckCircle2 size={22} color="#FFFFFF" />
        ) : step.status === 'in_progress' ? (
          <Clock size={22} color={color} />
        ) : (
          <Circle size={22} color={color} />
        )}
      </View>
      <Text style={[sn.label, { color }]} numberOfLines={2}>{step.stepName}</Text>
    </Pressable>
  );
}

const sn = StyleSheet.create({
  node: {
    // w-32 = 128px from mockup
    width: 128,
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    borderRadius: 10,
  },
  nodeSelected: {
    backgroundColor: `${tokens.primary}10`,
  },
  circle: {
    // step-circle: 56×56 from mockup
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
    lineHeight: 16,
  } as TextStyle,
});

interface StepDetailCardProps {
  step: MemberJourneyStepResponse;
}

function StepDetailCard({ step }: StepDetailCardProps): React.JSX.Element {
  const color = stepStatusColor(step.status);
  return (
    <Card style={sd.card}>
      <View style={sd.headerRow}>
        <View style={[sd.badge, { backgroundColor: `${color}18` }]}>
          <Text style={[sd.badgeText, { color }]}>{step.status.replace('_', ' ')}</Text>
        </View>
        <View style={sd.pointsBadge}>
          <Gift size={12} color={tokens.amber700} />
          <Text style={sd.pointsText}>+{step.pointsOnCompletion} pts on completion</Text>
        </View>
      </View>

      <Text style={sd.title}>Step {step.stepOrder}: {step.stepName}</Text>
      <Text style={sd.description}>{step.stepDescription}</Text>

      {step.dueDate !== null && (
        <View style={sd.metaRow}>
          <Clock size={12} color={tokens.textSecondary} />
          <Text style={sd.metaText}>Due {formatDate(step.dueDate)}</Text>
        </View>
      )}
      {step.completedAt !== null && (
        <View style={sd.metaRow}>
          <CheckCircle2 size={12} color={tokens.emerald700} />
          <Text style={[sd.metaText, { color: tokens.emerald700 }]}>
            Completed {formatDate(step.completedAt)}
          </Text>
        </View>
      )}

      {step.requiredDocuments.length > 0 && (
        <View style={sd.docsSection}>
          <Text style={sd.docsLabel}>Required documents</Text>
          {step.requiredDocuments.map((doc) => (
            <View key={doc} style={sd.docRow}>
              <FileText size={12} color={tokens.textSecondary} />
              <Text style={sd.docText}>{doc}</Text>
            </View>
          ))}
        </View>
      )}
    </Card>
  );
}

const sd = StyleSheet.create({
  card: {
    padding: 20,
    gap: 12,
    marginBottom: 16,
  } as ViewStyle,
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
  } as ViewStyle,
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 999,
  } as ViewStyle,
  badgeText: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'capitalize',
  } as TextStyle,
  pointsBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  } as ViewStyle,
  pointsText: {
    fontSize: 11,
    color: tokens.amber700,
    fontWeight: '600',
  } as TextStyle,
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: tokens.textPrimary,
    lineHeight: 24,
  } as TextStyle,
  description: {
    fontSize: 14,
    color: tokens.textSecondary,
    lineHeight: 20,
  } as TextStyle,
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  } as ViewStyle,
  metaText: {
    fontSize: 12,
    color: tokens.textSecondary,
  } as TextStyle,
  docsSection: {
    gap: 6,
    borderTopWidth: 1,
    borderTopColor: tokens.cardBorder,
    paddingTop: 12,
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
    gap: 6,
  } as ViewStyle,
  docText: {
    fontSize: 13,
    color: tokens.textPrimary,
  } as TextStyle,
});

interface OtherJourneyRowProps {
  journey: MemberJourneyResponse;
  isActive: boolean;
  onPress: () => void;
}

function OtherJourneyRow({ journey, isActive, onPress }: OtherJourneyRowProps): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        oj.row,
        isActive && oj.rowActive,
        pressed && { opacity: 0.75 },
      ]}
      accessibilityRole="button"
      accessibilityLabel={`Switch to journey: ${journey.template.name}`}
    >
      <Text style={oj.icon}>{journey.template.icon}</Text>
      <View style={{ flex: 1 }}>
        <Text style={oj.name} numberOfLines={1}>{journey.template.name}</Text>
        <Text style={oj.progress}>{Math.round(journey.progressPercent)}% complete</Text>
      </View>
      <Pill variant={journeyStatusPillVariant(journey.status)} size="sm">
        {journey.status}
      </Pill>
    </Pressable>
  );
}

const oj = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
  } as ViewStyle,
  rowActive: {
    backgroundColor: `${tokens.primary}10`,
  } as ViewStyle,
  icon: {
    fontSize: 20,
    width: 28,
    textAlign: 'center',
  } as TextStyle,
  name: {
    fontSize: 13,
    fontWeight: '600',
    color: tokens.textPrimary,
  } as TextStyle,
  progress: {
    fontSize: 11,
    color: tokens.textSecondary,
  } as TextStyle,
});

// ─── Progress bar ─────────────────────────────────────────────────────────────

function ProgressBar({ percent }: { percent: number }): React.JSX.Element {
  return (
    <View style={pb.track} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: percent }}>
      <View style={[pb.fill, { width: `${Math.min(percent, 100)}%` }]} />
    </View>
  );
}

const pb = StyleSheet.create({
  track: {
    height: 8,
    backgroundColor: tokens.gray100,
    borderRadius: 4,
    overflow: 'hidden',
  } as ViewStyle,
  fill: {
    height: '100%',
    backgroundColor: tokens.primary,
    borderRadius: 4,
  } as ViewStyle,
});

// ─── Route prop type ─────────────────────────────────────────────────────────

/**
 * Accept route props from both navigators (bottom tabs on native, drawer on
 * web). The `focusJourneyId` param is optional — callers that navigate without
 * params continue to work as before.
 */
type MemberJourneyScreenProps =
  | Partial<BottomTabScreenProps<MemberTabParamList, 'MemberJourney'>>
  | Partial<DrawerScreenProps<MemberTabParamList, 'MemberJourney'>>;

// ─── Screen ───────────────────────────────────────────────────────────────────

export function MemberJourneyScreen(props: MemberJourneyScreenProps): React.JSX.Element {
  // Extract focusJourneyId from route params if present.
  const focusJourneyId =
    (props as Partial<BottomTabScreenProps<MemberTabParamList, 'MemberJourney'>>)
      ?.route?.params?.focusJourneyId ?? null;

  const { userName } = useAuth();
  const profileQuery = useMemberProfile();
  // MemberJourney.member_id is FK to users.id, not members.id.
  // Pass the User UUID (profile.userId), not the Members table PK (profile.id),
  // or the API call returns 403 (member auth check) and zero rows.
  const memberId = profileQuery.data?.userId ?? '';

  const memberInitials = (userName ?? 'M')
    .split(' ')
    .slice(0, 2)
    .map((p) => p[0] ?? '')
    .join('')
    .toUpperCase();

  const journeysQuery = useMemberJourneys(memberId);

  const journeys = journeysQuery.data ?? [];
  const defaultActive = useMemo(() => resolveActiveJourney(journeys), [journeys]);

  // Seed selectedJourneyId from focusJourneyId on first meaningful data load.
  // If the focused journey id is valid, use it; otherwise fall back to the
  // default active journey. This ensures a tap from MemberHomeScreen
  // immediately highlights the correct journey without an extra useState effect.
  const [selectedJourneyId, setSelectedJourneyId] = useState<string | null>(
    () => focusJourneyId,
  );

  const selectedJourney =
    journeys.find((j) => j.id === (selectedJourneyId ?? focusJourneyId)) ??
    defaultActive;

  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const selectedStep = useMemo(() => {
    if (!selectedJourney) return null;
    return (
      selectedJourney.steps.find((s) => s.id === selectedStepId) ??
      selectedJourney.currentStep ??
      selectedJourney.steps[0] ??
      null
    );
  }, [selectedJourney, selectedStepId]);

  const shellUserBlock = {
    initials: memberInitials,
    name: userName ?? 'Member',
    role: 'Member' as const,
  };

  const isLoading = profileQuery.isLoading || journeysQuery.isLoading;
  const hasError = !isLoading && (journeysQuery.error !== null);

  if (isLoading) {
    return (
      <AppShell role="member" activeKey="journey" userBlock={shellUserBlock}>
        <StatusBar barStyle="dark-content" backgroundColor={tokens.pageBg} />
        <LoadingSkeleton variant="card" />
        <LoadingSkeleton variant="rows" rows={4} />
      </AppShell>
    );
  }

  if (hasError) {
    return (
      <AppShell role="member" activeKey="journey" userBlock={shellUserBlock}>
        <StatusBar barStyle="dark-content" backgroundColor={tokens.pageBg} />
        <ErrorState
          message="Could not load your journeys. Please try again."
          onRetry={() => void journeysQuery.refetch()}
        />
      </AppShell>
    );
  }

  if (journeys.length === 0 || !selectedJourney) {
    return (
      <AppShell role="member" activeKey="journey" userBlock={shellUserBlock}>
        <StatusBar barStyle="dark-content" backgroundColor={tokens.pageBg} />
        <PageHeader title="My Journey" subtitle="Track your health milestones" />
        <Card style={styles.emptyCard}>
          <Route size={32} color={tokens.textMuted} />
          <Text style={styles.emptyTitle}>No journey yet</Text>
          <Text style={styles.emptySub}>
            Your CHW will assign a journey when your sessions begin. Check back after your
            first session.
          </Text>
        </Card>
      </AppShell>
    );
  }

  const otherJourneys = journeys.filter((j) => j.id !== selectedJourney.id);

  return (
    <AppShell role="member" activeKey="journey" userBlock={shellUserBlock}>
      <StatusBar barStyle="dark-content" backgroundColor={tokens.pageBg} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.pageWrap}>
          <PageHeader
            title={selectedJourney.template.name}
            subtitle={`${Math.round(selectedJourney.progressPercent)}% complete · ${selectedJourney.wellnessPointsEarned} pts earned`}
            right={
              <Pill variant={journeyStatusPillVariant(selectedJourney.status)}>
                {selectedJourney.status}
              </Pill>
            }
          />

          <View style={styles.body}>
            {/* Main column */}
            <View style={styles.mainCol}>
              {/* Progress bar */}
              <Card style={styles.progressCard}>
                <View style={styles.progressHeader}>
                  <Text style={styles.progressLabel}>Overall Progress</Text>
                  <Text style={styles.progressPct}>{Math.round(selectedJourney.progressPercent)}%</Text>
                </View>
                <ProgressBar percent={selectedJourney.progressPercent} />
                <Text style={styles.progressMeta}>
                  Started {formatDate(selectedJourney.startedAt)}
                  {selectedJourney.completedAt !== null
                    ? `  ·  Completed ${formatDate(selectedJourney.completedAt)}`
                    : ''}
                </Text>
              </Card>

              {/* Horizontal step roadmap */}
              <Card style={styles.roadmapCard}>
                <Text style={styles.sectionLabel}>ROADMAP</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.roadmapScroll}
                >
                  {selectedJourney.steps.map((step, index) => (
                    <React.Fragment key={step.id}>
                      <StepNode
                        step={step}
                        isSelected={selectedStep?.id === step.id}
                        onPress={() => setSelectedStepId(step.id)}
                      />
                      {index < selectedJourney.steps.length - 1 && (
                        <View style={styles.connectorLine} />
                      )}
                    </React.Fragment>
                  ))}
                </ScrollView>

                {/* Encouragement banner */}
                <View style={styles.encouragementBanner}>
                  <Lightbulb size={16} color="#D97706" />
                  <Text style={styles.encouragementText}>
                    <Text style={{ fontWeight: '700' }}>You're making real progress!</Text>
                    {' '}Keep going — your next step unlocks more wellness points.
                  </Text>
                </View>
              </Card>

              {/* Current step detail */}
              {selectedStep !== null && (
                <StepDetailCard step={selectedStep} />
              )}
            </View>

            {/* Right rail — other journeys + journey rewards */}
            <RightRail width={260}>
              {otherJourneys.length > 0 && (
                <Card style={styles.railCard}>
                  <Text style={styles.sectionLabel}>OTHER JOURNEYS</Text>
                  {otherJourneys.map((j) => (
                    <OtherJourneyRow
                      key={j.id}
                      journey={j}
                      isActive={selectedJourney.id === j.id}
                      onPress={() => {
                        setSelectedJourneyId(j.id);
                        setSelectedStepId(null);
                      }}
                    />
                  ))}
                </Card>
              )}

              {/* Journey Rewards */}
              <Card style={styles.rewardsRailCard}>
                <View style={styles.rewardsRailHeader}>
                  <Gift size={16} color={tokens.emerald700} />
                  <Text style={styles.rewardsRailTitle}>Journey rewards</Text>
                </View>
                <Text style={styles.rewardsRailBody}>
                  Finish this journey to unlock{' '}
                  <Text style={{ fontWeight: '700' }}>+50 wellness points</Text>
                  {' '}→ $25 grocery gift card.
                </Text>
              </Card>
            </RightRail>
          </View>
        </View>
      </ScrollView>
    </AppShell>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  scrollContent: { flexGrow: 1 },
  pageWrap: {
    // p-8 = 32px from mockup
    paddingHorizontal: 32,
    paddingTop: 24,
    paddingBottom: 32,
    maxWidth: 1100,
    width: '100%',
    alignSelf: 'center',
  } as ViewStyle,
  body: {
    flexDirection: 'row',
    gap: 20,
    alignItems: 'flex-start',
  } as ViewStyle,
  mainCol: {
    flex: 1,
    minWidth: 0,
  } as ViewStyle,
  progressCard: {
    padding: 16,
    gap: 8,
    marginBottom: 16,
  } as ViewStyle,
  progressHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  } as ViewStyle,
  progressLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: tokens.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  } as TextStyle,
  progressPct: {
    fontSize: 14,
    fontWeight: '700',
    color: tokens.primary,
  } as TextStyle,
  progressMeta: {
    fontSize: 11,
    color: tokens.textMuted,
  } as TextStyle,
  roadmapCard: {
    padding: 16,
    marginBottom: 16,
  } as ViewStyle,
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: tokens.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 12,
  } as TextStyle,
  roadmapScroll: {
    flexDirection: 'row',
    // keep top-aligned so the connector line aligns with circle centers
    alignItems: 'flex-start',
    paddingBottom: 8,
    paddingTop: 4,
  } as ViewStyle,
  connectorLine: {
    // flex: 1 fills the space between nodes, matching mock's step-line flex:1
    flex: 1,
    height: 3,
    backgroundColor: tokens.cardBorder,
    alignSelf: 'flex-start',
    // center vertically in the 56px circle: 56/2 - 3/2 ≈ 26px from top of node
    marginTop: 26,
    minWidth: 16,
  } as ViewStyle,
  railCard: {
    padding: 16,
    marginBottom: 12,
  } as ViewStyle,

  rewardsRailCard: {
    padding: 16,
    backgroundColor: '#F0FDF4',
    gap: 8,
  } as ViewStyle,
  rewardsRailHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  } as ViewStyle,
  rewardsRailTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: tokens.textPrimary,
  } as TextStyle,
  rewardsRailBody: {
    fontSize: 13,
    color: tokens.textSecondary,
    lineHeight: 18,
  } as TextStyle,

  encouragementBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 12,
    backgroundColor: '#FFFBEB',
    borderWidth: 1,
    borderColor: '#FDE68A',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
  } as ViewStyle,
  encouragementText: {
    fontSize: 13,
    color: '#78350F',
    flex: 1,
    lineHeight: 18,
  } as TextStyle,
  emptyCard: {
    padding: 32,
    alignItems: 'center',
    gap: 12,
  } as ViewStyle,
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: tokens.textPrimary,
  } as TextStyle,
  emptySub: {
    fontSize: 14,
    color: tokens.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 320,
  } as TextStyle,
});

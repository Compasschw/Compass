/**
 * MemberHomeScreen — Landing page for community members.
 *
 * Shows:
 * - Personalised greeting using auth userName
 * - Stat cards: Rewards points, Upcoming Sessions, Active Goals
 * - My Goals section with goal cards or empty state
 * - CTA card to find a CHW
 * - Upcoming sessions list
 */

import React, { useCallback } from 'react';
import {
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  ArrowRight,
  CalendarCheck,
  Gift,
  Map,
} from 'lucide-react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';

import { useAuth } from '../../context/AuthContext';
import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import {
  goals,
  verticalLabels,
  type Goal,
  type Vertical,
} from '../../data/mock';
import {
  useSessions,
  useMemberProfile,
  type SessionData,
} from '../../hooks/useApiQueries';
import { useRefreshControl } from '../../hooks/useRefreshControl';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';
import type { MemberTabParamList } from '../../navigation/MemberTabNavigator';

// ─── Types ────────────────────────────────────────────────────────────────────

interface MemberHomeScreenProps {
  navigation: BottomTabNavigationProp<MemberTabParamList, 'Home'>;
}

const verticalEmoji: Record<Vertical, string> = {
  housing: '🏠',
  rehab: '💪',
  food: '🛒',
  mental_health: '🧠',
  healthcare: '🏥',
};

const statusColorMap: Record<string, string> = {
  on_track: colors.secondary,
  almost_done: colors.compassGold,
  completed: colors.primary,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatScheduledDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function statusLabel(status: string): string {
  switch (status) {
    case 'on_track': return 'On track';
    case 'almost_done': return 'Almost done';
    case 'completed': return 'Completed';
    default: return status;
  }
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  subtext?: string;
  iconBg: string;
}

function StatCard({ icon, label, value, subtext, iconBg }: StatCardProps): React.JSX.Element {
  return (
    <View style={styles.statCard}>
      <View style={[styles.statIconContainer, { backgroundColor: iconBg }]}>
        {icon}
      </View>
      <Text style={styles.statValue}>{value}</Text>
      {subtext ? (
        <Text style={styles.statSubtext}>{subtext}</Text>
      ) : null}
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

interface GoalCardProps {
  goal: Goal;
}

function GoalCard({ goal }: GoalCardProps): React.JSX.Element {
  const statusColor = statusColorMap[goal.status] ?? colors.mutedForeground;

  return (
    <View style={styles.goalCard} accessibilityRole="none">
      <View style={styles.goalCardRow}>
        <Text style={styles.goalEmoji} accessibilityElementsHidden>{goal.emoji}</Text>
        <View style={styles.goalCardContent}>
          <View style={styles.goalCardHeader}>
            <Text style={styles.goalTitle} numberOfLines={1}>{goal.title}</Text>
            <View style={[styles.verticalBadge, { backgroundColor: `${colors.secondary}20` }]}>
              <Text style={[styles.verticalBadgeText, { color: colors.secondary }]}>
                {verticalLabels[goal.category]}
              </Text>
            </View>
          </View>
          <Text style={styles.goalMeta}>
            {goal.sessionsCompleted > 0
              ? `${goal.sessionsCompleted} session${goal.sessionsCompleted !== 1 ? 's' : ''} completed · `
              : 'Just getting started · '}
            <Text style={[styles.goalStatus, { color: statusColor }]}>
              {statusLabel(goal.status)}
            </Text>
          </Text>
          {/* Progress bar */}
          <View style={styles.progressRow}>
            <Text style={styles.progressLabel}>Progress</Text>
            <Text style={styles.progressPct}>{goal.progress}%</Text>
          </View>
          <View
            style={styles.progressTrack}
            accessibilityRole="progressbar"
            accessibilityValue={{ min: 0, max: 100, now: goal.progress }}
            accessibilityLabel={`${goal.title} progress: ${goal.progress}%`}
          >
            <View style={[styles.progressFill, { width: `${goal.progress}%` }]} />
          </View>
        </View>
      </View>
    </View>
  );
}

interface UpcomingSessionRowProps {
  session: SessionData;
}

function UpcomingSessionRow({ session }: UpcomingSessionRowProps): React.JSX.Element {
  const emoji = verticalEmoji[session.vertical as Vertical] ?? '📅';
  return (
    <View style={styles.sessionRow}>
      <View style={styles.sessionIconContainer}>
        <Text style={styles.sessionEmoji} accessibilityElementsHidden>{emoji}</Text>
      </View>
      <View style={styles.sessionInfo}>
        <Text style={styles.sessionChwName} numberOfLines={1}>{session.chwName ?? 'CHW'}</Text>
        <Text style={styles.sessionDate}>{formatScheduledDate(session.scheduledAt)}</Text>
      </View>
      <View style={styles.scheduledBadge}>
        <Text style={styles.scheduledBadgeText}>Scheduled</Text>
      </View>
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export function MemberHomeScreen({ navigation }: MemberHomeScreenProps): React.JSX.Element {
  const { userName } = useAuth();

  const sessionsQuery = useSessions();
  const profileQuery = useMemberProfile();
  const refresh = useRefreshControl([sessionsQuery.refetch, profileQuery.refetch]);

  const allSessions = sessionsQuery.data ?? [];
  const profile = profileQuery.data;

  const firstName = (userName ?? profile?.userId ?? 'there').split(' ')[0];
  const rewardsBalance = profile?.rewardsBalance ?? 0;

  const upcomingSessions = allSessions.filter((s) => s.status === 'scheduled');
  // Goals endpoint not available — keep mock data
  const activeGoals = goals;

  const handleFindCHW = useCallback(() => {
    navigation.navigate('FindCHW');
  }, [navigation]);

  const isLoading = sessionsQuery.isLoading || profileQuery.isLoading;
  const hasError = !isLoading && (sessionsQuery.error !== null || profileQuery.error !== null);

  const handleRetry = useCallback(() => {
    void sessionsQuery.refetch();
    void profileQuery.refetch();
  }, [sessionsQuery, profileQuery]);

  if (isLoading) {
    return (
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        <StatusBar barStyle="dark-content" backgroundColor={colors.background} />
        <View style={{ flex: 1, padding: 16, paddingTop: 20 }}>
          <LoadingSkeleton variant="stat-grid" />
          <LoadingSkeleton variant="rows" rows={3} />
        </View>
      </SafeAreaView>
    );
  }

  if (hasError) {
    return (
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        <StatusBar barStyle="dark-content" backgroundColor={colors.background} />
        <ErrorState
          message="Could not load your home data. Please try again."
          onRetry={handleRetry}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <StatusBar barStyle="dark-content" backgroundColor={colors.background} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={refresh.control}
      >
        {/* Greeting */}
        <View style={styles.greetingSection}>
          <Text style={styles.greeting}>
            Hello, <Text style={styles.greetingAccent}>{firstName}</Text>
          </Text>
          <Text style={styles.greetingSub}>
            Let's keep making progress on your health goals today.
          </Text>
        </View>

        {/* Stat cards */}
        <View style={styles.statRow}>
          <StatCard
            icon={<Gift color={colors.primary} size={18} />}
            label="Rewards"
            value={rewardsBalance}
            subtext="pts"
            iconBg={`${colors.primary}15`}
          />
          <StatCard
            icon={<CalendarCheck color={colors.secondary} size={18} />}
            label="Upcoming"
            value={upcomingSessions.length}
            subtext="Sessions"
            iconBg={`${colors.secondary}15`}
          />
          <StatCard
            icon={<Map color={colors.primary} size={18} />}
            label="Goals"
            value={activeGoals.length}
            subtext="Active"
            iconBg={`${colors.primary}15`}
          />
        </View>

        {/* My Goals */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>My Goals</Text>
            <Pressable
              onPress={() => navigation.navigate('Roadmap')}
              accessibilityRole="button"
              accessibilityLabel="View full roadmap"
              hitSlop={8}
            >
              <View style={styles.linkRow}>
                <Text style={styles.linkText}>Full roadmap</Text>
                <ArrowRight color={colors.primary} size={13} />
              </View>
            </Pressable>
          </View>

          {activeGoals.length === 0 ? (
            <View style={styles.emptyState}>
              <Map color={colors.mutedForeground} size={24} />
              <Text style={styles.emptyStateTitle}>No goals yet</Text>
              <Text style={styles.emptyStateSub}>
                Work with a CHW to set personalized health goals.
              </Text>
            </View>
          ) : (
            <View style={styles.goalList}>
              {activeGoals.map((goal) => (
                <GoalCard key={goal.id} goal={goal} />
              ))}
            </View>
          )}
        </View>

        {/* CTA to find CHW */}
        <Pressable
          onPress={handleFindCHW}
          style={({ pressed }) => [styles.ctaCard, pressed && styles.ctaCardPressed]}
          accessibilityRole="button"
          accessibilityLabel="Find a Community Health Worker"
        >
          <View style={styles.ctaContent}>
            <Text style={styles.ctaTitle}>Need help with a new goal?</Text>
            <Text style={styles.ctaSub}>Find a Community Health Worker near you.</Text>
          </View>
          <View style={styles.ctaButton}>
            <Text style={styles.ctaButtonText}>Find CHW</Text>
            <ArrowRight color={colors.primary} size={13} />
          </View>
        </Pressable>

        {/* Upcoming sessions */}
        {upcomingSessions.length > 0 && (
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>Upcoming Sessions</Text>
            </View>
            {upcomingSessions.map((session, idx) => (
              <React.Fragment key={session.id}>
                <UpcomingSessionRow session={session} />
                {idx < upcomingSessions.length - 1 && <View style={styles.divider} />}
              </React.Fragment>
            ))}
          </View>
        )}

        <View style={styles.bottomPadding} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#F4F1ED',
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingTop: 20,
  },

  // Greeting
  greetingSection: {
    marginBottom: 20,
  },
  greeting: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 24,
    lineHeight: 30,
    color: '#1E3320',
  },
  greetingAccent: {
    color: '#7A9F5A',
  },
  greetingSub: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 16,
    lineHeight: 24,
    color: '#6B7A6B',
    marginTop: 4,
  },

  // Stat row
  statRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 20,
  },
  statCard: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 12,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    alignItems: 'center',
    gap: 4,
    shadowColor: '#3D5A3E',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 24,
    elevation: 3,
  },
  statIconContainer: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
    backgroundColor: '#3D5A3E15',
  },
  statValue: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 24,
    lineHeight: 30,
    color: '#1E3320',
  },
  statSubtext: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    letterSpacing: 1,
    color: '#7A9F5A',
  },
  statLabel: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#6B7A6B',
  },

  // Card
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    marginBottom: 16,
    overflow: 'hidden',
    shadowColor: '#3D5A3E',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 24,
    elevation: 3,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#DDD6CC',
  },
  cardTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    lineHeight: 22,
    color: '#1E3320',
  },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  linkText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#3D5A3E',
  },

  // Goals
  goalList: {
    padding: 12,
    gap: 10,
  },
  goalCard: {
    backgroundColor: '#E5DFD6',
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: '#DDD6CC',
  },
  goalCardRow: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'flex-start',
  },
  goalEmoji: {
    fontSize: 28,
    lineHeight: 34,
  },
  goalCardContent: {
    flex: 1,
  },
  goalCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 8,
    marginBottom: 4,
  },
  goalTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
    lineHeight: 20,
    color: '#1E3320',
    flex: 1,
  },
  verticalBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  verticalBadgeText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 10,
  },
  goalMeta: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    letterSpacing: 1,
    color: '#6B7A6B',
    marginBottom: 8,
  },
  goalStatus: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
  },
  progressRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  progressLabel: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#6B7A6B',
  },
  progressPct: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 11,
    color: '#1E3320',
  },
  progressTrack: {
    height: 6,
    backgroundColor: '#DDD6CC',
    borderRadius: 999,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#3D5A3E',
    borderRadius: 999,
  },

  // Empty state
  emptyState: {
    padding: 32,
    alignItems: 'center',
    gap: 8,
  },
  emptyStateTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    lineHeight: 22,
    color: '#1E3320',
  },
  emptyStateSub: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#6B7A6B',
    textAlign: 'center',
  },

  // CTA card
  ctaCard: {
    backgroundColor: '#3D5A3E',
    borderRadius: 16,
    padding: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    marginBottom: 16,
  },
  ctaCardPressed: {
    opacity: 0.9,
  },
  ctaContent: {
    flex: 1,
  },
  ctaTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    lineHeight: 22,
    color: '#FFFFFF',
  },
  ctaSub: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: 'rgba(255,255,255,0.7)',
    marginTop: 2,
  },
  ctaButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 12,
  },
  ctaButtonText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#3D5A3E',
  },

  // Sessions
  sessionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#DDD6CC',
  },
  sessionIconContainer: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: '#3D5A3E15',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sessionEmoji: {
    fontSize: 18,
  },
  sessionInfo: {
    flex: 1,
  },
  sessionChwName: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
    lineHeight: 20,
    color: '#1E3320',
  },
  sessionDate: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    letterSpacing: 1,
    color: '#6B7A6B',
    marginTop: 1,
  },
  scheduledBadge: {
    backgroundColor: '#7A9F5A20',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 100,
  },
  scheduledBadgeText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    color: '#7A9F5A',
  },
  divider: {
    height: 1,
    backgroundColor: '#DDD6CC',
    marginHorizontal: 16,
  },

  bottomPadding: {
    height: 24,
  },
});

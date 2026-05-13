/**
 * MemberHomeScreen — dashboard home for community members.
 *
 * Re-skinned to the new AppShell layout (feat/ui-revamp).
 * All existing data hooks, sub-components, and navigation callbacks are preserved.
 *
 * Layout (new):
 *   - AppShell wrapper (sidebar on web, passthrough on native)
 *   - PageHeader: greeting + subtitle
 *   - 2×2 StatTile grid (Rewards · Upcoming · Active Goals · Open Requests)
 *   - Secondary stat row (Completed sessions)
 *   - "Your CHW is available" hero card (mocked until /members/me/chw lands)
 *   - My Goals card with roadmap link
 *   - Find CHW CTA card
 *   - Upcoming sessions card
 *
 * Data sources (all real APIs — unchanged from original):
 *   - useMemberProfile  → rewards balance, profile name fallback
 *   - useSessions       → upcoming + completed session counts
 *   - useMemberRoadmap  → active goals count + preview rows
 *   - useRequests       → open (unmatched) request count
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  ArrowRight,
  CalendarCheck,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  Gift,
  ListChecks,
  Map,
  MessageSquare,
  Phone,
  Square,
  CheckSquare,
  Target,
  Trophy,
} from 'lucide-react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';

import { useAuth } from '../../context/AuthContext';
import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import {
  verticalLabels,
  type Goal,
  type Vertical,
} from '../../data/mock';
import {
  useSessions,
  useMemberProfile,
  useRequests,
  type SessionData,
} from '../../hooks/useApiQueries';
import { AppShell, PageHeader, Card, StatTile, Pill } from '../../components/ui';
import { colors as tokens } from '../../theme/tokens';
import { useMemberRoadmap } from '../../hooks/useFollowupQueries';
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
  /** When set, the card becomes pressable */
  onPress?: () => void;
  accessibilityLabel?: string;
  /**
   * Layout variant. `half` = 47% width (used inside a 2×2 grid with
   * flexWrap). `full` = flex:1 (used inside a single-row layout).
   * Defaults to `full` so existing call sites stay backwards-compatible.
   */
  variant?: 'half' | 'full';
}

function StatCard({
  icon,
  label,
  value,
  subtext,
  iconBg,
  onPress,
  accessibilityLabel,
  variant = 'full',
}: StatCardProps): React.JSX.Element {
  const cardStyle =
    variant === 'half' ? styles.statCardHalf : styles.statCard;
  const body = (
    <>
      <View style={[styles.statIconContainer, { backgroundColor: iconBg }]}>
        {icon}
      </View>
      <Text style={styles.statValue}>{value}</Text>
      {subtext ? (
        <Text style={styles.statSubtext}>{subtext}</Text>
      ) : null}
      <Text style={styles.statLabel}>{label}</Text>
    </>
  );

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [cardStyle, pressed && { opacity: 0.85 }]}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
      >
        {body}
      </Pressable>
    );
  }

  return <View style={cardStyle}>{body}</View>;
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

/**
 * Mocked per-session action items (JT Figma feedback: "Session Notes / To Do
 * list for each session / Selectable"). Stable per session id so the same
 * session shows the same list. Replace with backend-driven items when a
 * `/sessions/:id/action_items` endpoint ships.
 *
 * TODO(backend): expose session.action_items as
 *   { id: string; label: string; completed: boolean }[]
 */
function mockActionItems(sessionId: string): string[] {
  const pool = [
    'Bring photo ID and proof of address',
    'Have your Medi-Cal card or BIC number ready',
    'Write down 2-3 questions you want answered',
    'List medications you currently take',
    'Note any recent provider visits',
    'Share insurance plan details if you have them',
    'Have a pen and paper nearby for notes',
  ];
  const sum = sessionId.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  // Deterministic 3-item pick from the pool
  const start = sum % pool.length;
  return [pool[start], pool[(start + 2) % pool.length], pool[(start + 4) % pool.length]];
}

function UpcomingSessionRow({ session }: UpcomingSessionRowProps): React.JSX.Element {
  const emoji = verticalEmoji[session.vertical as Vertical] ?? '📅';
  const [expanded, setExpanded] = useState(false);
  const [checkedItems, setCheckedItems] = useState<Set<number>>(new Set());

  const items = useMemo(() => mockActionItems(session.id), [session.id]);
  const completedCount = checkedItems.size;
  const totalCount = items.length;

  const toggleItem = useCallback((idx: number) => {
    setCheckedItems((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }, []);

  return (
    <View>
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

      {/* Action-items toggle row — JT Figma feedback */}
      <Pressable
        onPress={() => setExpanded((p) => !p)}
        style={({ pressed }) => [styles.todoToggle, pressed && { opacity: 0.7 }]}
        accessibilityRole="button"
        accessibilityLabel={
          expanded
            ? `Hide action items (${completedCount} of ${totalCount} done)`
            : `Show action items (${completedCount} of ${totalCount} done)`
        }
        accessibilityState={{ expanded }}
      >
        <ListChecks size={14} color={colors.primary} />
        <Text style={styles.todoToggleText}>
          Prep checklist · {completedCount}/{totalCount}
        </Text>
        {expanded
          ? <ChevronUp size={14} color={colors.mutedForeground} />
          : <ChevronDown size={14} color={colors.mutedForeground} />}
      </Pressable>

      {expanded && (
        <View style={styles.todoList}>
          {items.map((label, idx) => {
            const checked = checkedItems.has(idx);
            return (
              <Pressable
                key={idx}
                onPress={() => toggleItem(idx)}
                style={({ pressed }) => [styles.todoItem, pressed && { opacity: 0.7 }]}
                accessibilityRole="checkbox"
                accessibilityState={{ checked }}
                accessibilityLabel={label}
              >
                {checked
                  ? <CheckSquare size={16} color={colors.primary} />
                  : <Square size={16} color={colors.mutedForeground} />}
                <Text
                  style={[
                    styles.todoItemText,
                    checked && styles.todoItemTextDone,
                  ]}
                >
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export function MemberHomeScreen({ navigation }: MemberHomeScreenProps): React.JSX.Element {
  const { userName } = useAuth();

  const sessionsQuery = useSessions();
  const profileQuery = useMemberProfile();
  const roadmapQuery = useMemberRoadmap();
  const requestsQuery = useRequests();
  const refresh = useRefreshControl([
    sessionsQuery.refetch,
    profileQuery.refetch,
    roadmapQuery.refetch,
    requestsQuery.refetch,
  ]);

  const allSessions = sessionsQuery.data ?? [];
  const profile = profileQuery.data;
  const roadmap = roadmapQuery.data ?? [];
  const allRequests = requestsQuery.data ?? [];

  const firstName = (userName ?? profile?.userId ?? 'there').split(' ')[0];
  const rewardsBalance = profile?.rewardsBalance ?? 0;

  // Upcoming = scheduled AND not in the past. Stale seed sessions (e.g. a Dec 31
  // session viewed in April) would otherwise render as "upcoming" and look broken.
  const nowMs = Date.now();
  const upcomingSessions = allSessions.filter(
    (s) => s.status === 'scheduled' && new Date(s.scheduledAt).getTime() >= nowMs,
  );
  const completedSessionsCount = allSessions.filter((s) => s.status === 'completed').length;

  // Active goals = roadmap items NOT yet completed. Aggregated from
  // SessionFollowup rows where show_on_roadmap=True for this member.
  // Empty until the LLM extracts followups OR the member self-adds a goal.
  const activeRoadmapItems = roadmap.filter(
    (item) => item.status !== 'completed' && item.status !== 'dismissed',
  );

  // Open requests = ones the member submitted that haven't been picked up
  // by a CHW yet. Drives the "Awaiting CHW" stat tile.
  const openRequestsCount = allRequests.filter(
    (r) => r.status === 'open',
  ).length;

  // Legacy seed-data goals (Goal[]) replaced by real SessionFollowup roadmap
  // rows. Kept the variable name so the existing "My Goals" empty-state copy
  // still compiles; it just renders [] when the member has no roadmap yet.
  const activeGoals: Goal[] = [];

  const handleFindCHW = useCallback(() => {
    navigation.navigate('FindCHW');
  }, [navigation]);

  const handleOpenRewards = useCallback(() => {
    // Navigates within the nested HomeStack (registered in MemberTabNavigator)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (navigation as any).navigate('Rewards');
  }, [navigation]);

  const handleOpenSessions = useCallback(() => {
    navigation.navigate('Sessions');
  }, [navigation]);

  const handleOpenRoadmap = useCallback(() => {
    navigation.navigate('Roadmap');
  }, [navigation]);

  const isLoading =
    sessionsQuery.isLoading ||
    profileQuery.isLoading ||
    roadmapQuery.isLoading ||
    requestsQuery.isLoading;
  // Only block render on a HARD error (sessions or profile). Roadmap and
  // requests degrade gracefully to empty arrays; their network errors get
  // logged but shouldn't tombstone the whole dashboard.
  const hasError =
    !isLoading && (sessionsQuery.error !== null || profileQuery.error !== null);

  const handleRetry = useCallback(() => {
    void sessionsQuery.refetch();
    void profileQuery.refetch();
    void roadmapQuery.refetch();
    void requestsQuery.refetch();
  }, [sessionsQuery, profileQuery, roadmapQuery, requestsQuery]);

  // Derive initials for userBlock sidebar avatar
  const memberInitials = (userName ?? profile?.name ?? 'M')
    .split(' ')
    .slice(0, 2)
    .map((p) => p[0] ?? '')
    .join('')
    .toUpperCase();

  if (isLoading) {
    return (
      <AppShell
        role="member"
        activeKey="home"
        userBlock={{ initials: memberInitials, name: userName ?? 'Member', role: 'Member' }}
      >
        <StatusBar barStyle="dark-content" backgroundColor={colors.background} />
        <View style={styles.pageWrap}>
          <LoadingSkeleton variant="stat-grid" />
          <LoadingSkeleton variant="rows" rows={3} />
        </View>
      </AppShell>
    );
  }

  if (hasError) {
    return (
      <AppShell
        role="member"
        activeKey="home"
        userBlock={{ initials: memberInitials, name: userName ?? 'Member', role: 'Member' }}
      >
        <StatusBar barStyle="dark-content" backgroundColor={colors.background} />
        <ErrorState
          message="Could not load your home data. Please try again."
          onRetry={handleRetry}
        />
      </AppShell>
    );
  }

  const hourOfDay = new Date().getHours();
  const greeting =
    hourOfDay < 12 ? 'Good morning' : hourOfDay < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <AppShell
      role="member"
      activeKey="home"
      userBlock={{ initials: memberInitials, name: userName ?? 'Member', role: 'Member' }}
      badges={{ wellnessPoints: rewardsBalance }}
    >
      <StatusBar barStyle="dark-content" backgroundColor={colors.background} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={refresh.control}
      >
        <View style={styles.pageWrap}>

        <PageHeader
          title={`${greeting}, ${firstName} 👋`}
          subtitle="Here's what's happening today"
        />

        {/* Hero CHW card */}
        <Card style={styles.heroCard}>
          <View style={styles.heroRow}>
            <View style={styles.heroAvatarWrap}>
              <View style={styles.heroAvatar}>
                <Text style={styles.heroAvatarText}>MS</Text>
              </View>
              <View style={styles.heroOnlineDot} />
            </View>
            <View style={styles.heroInfo}>
              <Text style={styles.heroChwLabel}>Your CHW</Text>
              <Text style={styles.heroChwTitle}>Maria is available now</Text>
              <Text style={styles.heroChwSub}>Usually responds in under 2 hours · English &amp; Spanish</Text>
            </View>
          </View>
          <View style={styles.heroActions}>
            <Pressable
              onPress={handleOpenSessions}
              style={styles.heroPrimaryBtn}
              accessibilityRole="button"
              accessibilityLabel="Send a message to Maria"
            >
              <MessageSquare size={16} color="#FFFFFF" />
              <Text style={styles.heroPrimaryBtnText}>Send a message</Text>
            </Pressable>
            <Pressable
              onPress={handleOpenSessions}
              style={styles.heroSecondaryBtn}
              accessibilityRole="button"
              accessibilityLabel="Schedule a call with Maria"
            >
              <Phone size={16} color="#3D5A3E" />
              <Text style={styles.heroSecondaryBtnText}>Schedule a call</Text>
            </Pressable>
          </View>
        </Card>

        {/* Stat grid — 2×2 */}
        <View style={styles.statGrid}>
          <View style={styles.statTileWrap}>
            <StatTile
              icon={<Gift color={tokens.emerald700} size={18} />}
              iconBg={tokens.emerald100}
              label="Wellness Points"
              value={rewardsBalance.toLocaleString()}
              delta="Points earned"
              style={styles.statTile}
              onPress={handleOpenRewards}
            />
          </View>
          <View style={styles.statTileWrap}>
            <StatTile
              icon={<CalendarCheck color={tokens.blue700} size={18} />}
              iconBg={tokens.blue100}
              label="Upcoming"
              value={upcomingSessions.length}
              delta={upcomingSessions.length === 1 ? 'Session' : 'Sessions'}
              deltaColor={tokens.blue700}
              style={styles.statTile}
              onPress={handleOpenSessions}
            />
          </View>
          <View style={styles.statTileWrap}>
            <StatTile
              icon={<Target color={tokens.amber700} size={18} />}
              iconBg={tokens.amber100}
              label="Active Goals"
              value={activeRoadmapItems.length}
              delta="On your roadmap"
              deltaColor={tokens.amber700}
              style={styles.statTile}
              onPress={handleOpenRoadmap}
            />
          </View>
          <View style={styles.statTileWrap}>
            <StatTile
              icon={<ClipboardList color={tokens.purple700} size={18} />}
              iconBg={tokens.purple100}
              label="Open Requests"
              value={openRequestsCount}
              delta="Awaiting CHW"
              deltaColor={tokens.purple700}
              style={styles.statTile}
              onPress={handleFindCHW}
            />
          </View>
        </View>

        {/* Secondary stat row — completed sessions */}
        <View style={styles.statRow}>
          <StatTile
            icon={<CheckCircle2 color={tokens.emerald700} size={18} />}
            iconBg={tokens.emerald100}
            label="Completed Sessions"
            value={completedSessionsCount}
            delta={completedSessionsCount === 1 ? 'Session all-time' : 'Sessions all-time'}
            style={{ flex: 1 }}
          />
        </View>

        {/* Your Journeys */}
        <Text style={styles.sectionHeading}>Your Journeys</Text>
        <View style={styles.journeyRow}>
          <Pressable
            onPress={handleOpenRoadmap}
            style={({ pressed }) => [styles.journeyCard, pressed && { opacity: 0.85 }]}
            accessibilityRole="button"
            accessibilityLabel="Food Assistance journey, 60% complete"
          >
            <View style={styles.journeyCardHeader}>
              <View style={[styles.journeyIconCircle, { backgroundColor: '#FED7AA' }]}>
                <Text style={styles.journeyIconEmoji}>🍽️</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.journeyCardTitle}>Food Assistance</Text>
                <Text style={styles.journeyCardSub}>CalFresh enrollment</Text>
              </View>
              <View style={styles.journeyPill}>
                <Text style={styles.journeyPillText}>60%</Text>
              </View>
            </View>
            <View style={styles.journeyProgressTrack}>
              <View style={[styles.journeyProgressFill, { width: '60%' }]} />
            </View>
          </Pressable>

          <Pressable
            onPress={handleOpenRoadmap}
            style={({ pressed }) => [styles.journeyCard, pressed && { opacity: 0.85 }]}
            accessibilityRole="button"
            accessibilityLabel="Mental Health journey, 80% complete"
          >
            <View style={styles.journeyCardHeader}>
              <View style={[styles.journeyIconCircle, { backgroundColor: '#E9D5FF' }]}>
                <Text style={styles.journeyIconEmoji}>🧠</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.journeyCardTitle}>Mental Health</Text>
                <Text style={styles.journeyCardSub}>Behavioral health referral</Text>
              </View>
              <View style={styles.journeyPill}>
                <Text style={styles.journeyPillText}>80%</Text>
              </View>
            </View>
            <View style={styles.journeyProgressTrack}>
              <View style={[styles.journeyProgressFill, { width: '80%' }]} />
            </View>
          </Pressable>
        </View>

        {/* Recent activity */}
        <Text style={styles.sectionHeading}>Recent activity</Text>
        <Card style={styles.activityCard}>
          {[
            { icon: <MessageSquare size={16} color="#2563EB" />, text: 'Maria sent you a message', time: '1h ago' },
            { icon: <Trophy size={16} color="#D97706" />, text: 'You earned +25 pts for Eligibility Screening', time: '2d ago' },
            { icon: <CalendarCheck size={16} color="#059669" />, text: 'Your appointment Mon was confirmed', time: '3d ago' },
          ].map((item, idx) => (
            <View
              key={idx}
              style={[styles.activityRow, idx > 0 && { borderTopWidth: 1, borderTopColor: '#F3F4F6' }]}
            >
              {item.icon}
              <Text style={styles.activityText}>{item.text}</Text>
              <Text style={styles.activityTime}>{item.time}</Text>
            </View>
          ))}
        </Card>

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
          <Card style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>Upcoming Sessions</Text>
            </View>
            {upcomingSessions.map((session, idx) => (
              <React.Fragment key={session.id}>
                <UpcomingSessionRow session={session} />
                {idx < upcomingSessions.length - 1 && <View style={styles.divider} />}
              </React.Fragment>
            ))}
          </Card>
        )}

        <View style={styles.bottomPadding} />
        </View>
      </ScrollView>
    </AppShell>
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
    flexGrow: 1,
    alignItems: 'center',
  },
  // 1100 px — matches full-width layout used by Messages/Settings and mockup.
  pageWrap: {
    width: '100%',
    maxWidth: 1100,
    alignSelf: 'center',
    paddingHorizontal: 24,
    paddingTop: 24,
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
  // StatTile half-width wrapper: 47% keeps the 10px gap without overflow.
  statTileWrap: {
    width: '47%',
  },
  // StatTile itself occupies full width of its wrapper.
  statTile: {
    width: '100%',
  } as import('react-native').ViewStyle,
  // 2×2 stat grid — mirrors the CHW dashboard's stat grid layout.
  statGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    rowGap: 10,
    marginBottom: 10,
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
  // 2×2-grid variant — fixed width so flexWrap: 'wrap' on the parent
  // breaks the row into pairs. 47% (vs 50%) leaves room for the 10px
  // gap between cards. Mirrors CHW dashboard's statCard width.
  statCardHalf: {
    width: '47%',
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

  // Per-session prep checklist
  todoToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: 20,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: `${colors.primary}10`,
    borderWidth: 1,
    borderColor: `${colors.primary}30`,
  },
  todoToggleText: {
    flex: 1,
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    color: colors.primary,
  },
  todoList: {
    marginHorizontal: 20,
    marginBottom: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#DDD6CC',
    gap: 8,
  },
  todoItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 4,
  },
  todoItemText: {
    flex: 1,
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: '#1E3320',
    lineHeight: 18,
  },
  todoItemTextDone: {
    color: '#9CA3AF',
    textDecorationLine: 'line-through',
  },

  bottomPadding: {
    height: 24,
  },

  // ── Hero CHW card ────────────────────────────────────────────────────────────
  heroCard: {
    backgroundColor: '#F0FDF4',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#BBF7D0',
    padding: 20,
    marginBottom: 20,
    gap: 14,
  },
  heroRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  heroAvatarWrap: {
    position: 'relative',
  },
  heroAvatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#059669',
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroAvatarText: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 20,
    color: '#FFFFFF',
  },
  heroOnlineDot: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#10B981',
    borderWidth: 2,
    borderColor: '#FFFFFF',
  },
  heroInfo: {
    flex: 1,
    gap: 2,
  },
  heroChwLabel: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 11,
    color: '#059669',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  heroChwTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 18,
    color: '#1E3320',
    lineHeight: 24,
  },
  heroChwSub: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: '#6B7280',
    lineHeight: 16,
  },
  heroActions: {
    flexDirection: 'row',
    gap: 10,
  },
  heroPrimaryBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    // emerald-600 (#059669) matching mockup — distinct from sidebar #3D5A3E forest green
    backgroundColor: '#059669',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  heroPrimaryBtnText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#FFFFFF',
  },
  heroSecondaryBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    borderWidth: 1,
    borderColor: '#BBF7D0',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#FFFFFF',
  },
  heroSecondaryBtnText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#059669',
  },

  // ── Section heading ──────────────────────────────────────────────────────────
  sectionHeading: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: '#374151',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 12,
    marginTop: 8,
  },

  // ── Journey cards row ────────────────────────────────────────────────────────
  journeyRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 20,
  },
  journeyCard: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    padding: 20,
    gap: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 1,
  },
  journeyCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  journeyIconCircle: {
    // 44px = w-11 from mockup
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  journeyIconEmoji: {
    fontSize: 20,
  },
  journeyCardTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 15,
    color: '#111827',
  },
  journeyCardSub: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: '#6B7280',
  },
  journeyPill: {
    // pill: rounded-full, bg-emerald-100, text-emerald-700, px-10 py-4 12px 500
    backgroundColor: '#D1FAE5',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  journeyPillText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    color: '#047857',
  },
  journeyProgressTrack: {
    height: 8,
    backgroundColor: '#F3F4F6',
    borderRadius: 999,
    overflow: 'hidden',
  },
  journeyProgressFill: {
    height: '100%',
    backgroundColor: '#059669',
    borderRadius: 999,
  },

  // ── Recent activity ──────────────────────────────────────────────────────────
  activityCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#F1F5F4',
    marginBottom: 16,
    overflow: 'hidden',
    // subtle shadow matching mockup card definition
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 1,
  },
  activityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    // mock: px-3 py-3 = 12px horizontal, 12px vertical
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  activityText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#374151',
    flex: 1,
  },
  activityTime: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: '#9CA3AF',
  },
});

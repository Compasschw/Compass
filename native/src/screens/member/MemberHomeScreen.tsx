/**
 * MemberHomeScreen — dashboard home for community members.
 *
 * T18: Re-skinned to the shared CHW visual language (white cards, green
 * accents, clean SaaS layout, dashboard tiles). Renders exclusively through
 * shared primitives from `components/ui` and design tokens from `theme/tokens`.
 *
 * Layout:
 *   - AppShell wrapper (sidebar on web, passthrough on native)
 *   - PageWrap (1280px max-width on web — matches CHW dashboard breakpoint)
 *   - PageHeader: greeting + subtitle
 *   - "Your CHW" hero card (CHW photo + name + Message/Call CTAs)  ← hero
 *   - 2×2 StatTile grid (Rewards · Upcoming · Active Goals · Open Requests)
 *   - Secondary stat row (Completed sessions)
 *   - Your Journeys section (progress cards)
 *   - Recent Activity section
 *   - Find CHW CTA card
 *   - Upcoming sessions card
 *
 * Data sources (all real APIs — unchanged):
 *   - useMemberProfile  → rewards balance, profile name fallback
 *   - useSessions       → upcoming + completed session counts
 *   - useMemberRoadmap  → active goals count + preview rows
 *   - useRequests       → open (unmatched) request count
 *
 * Token rules (T18):
 *   - All colours from `theme/tokens` only; `theme/colors` removed entirely.
 *   - PageWrap provides 1280px web cap.
 *   - SectionHeader replaces all inline `sectionHeading` Text nodes.
 *   - Card, StatTile, PageHeader, Pill from `components/ui`.
 */

import React, { useCallback, useMemo } from 'react';
import {
  Platform,
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
  ClipboardList,
  Gift,
  Hand,
  HeartPulse,
  Home,
  ListChecks,
  MessageSquare,
  Phone,
  Route,
  ShoppingBasket,
  Stethoscope,
  Target,
} from 'lucide-react-native';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { CompositeScreenProps } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import { useAuth } from '../../context/AuthContext';
import { colors as tokens, numerals, spacing, radius } from '../../theme/tokens';
import { fonts } from '../../theme/typography';
import {
  verticalLabels,
  type Vertical,
} from '../../data/mock';
import {
  useSessions,
  useMemberProfile,
  useMemberJourneys,
  useRequests,
  type MemberJourneyResponse,
  type SessionData,
} from '../../hooks/useApiQueries';
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
  StaggerList,
} from '../../components/ui';
import type { PillVariant } from '../../components/ui/Pill';
import { useMemberRoadmap } from '../../hooks/useFollowupQueries';
import { useRefreshControl } from '../../hooks/useRefreshControl';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';
import type {
  MemberHomeStackParamList,
  MemberTabParamList,
} from '../../navigation/MemberTabNavigator';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Screen props for MemberHomeScreen as registered at `HomeMain` inside the
 * Home tab's nested native stack. The composite type exposes both the stack's
 * own routes and the parent tab navigator's routes (FindCHW, Sessions, …).
 */
type MemberHomeScreenProps = CompositeScreenProps<
  NativeStackScreenProps<MemberHomeStackParamList, 'HomeMain'>,
  BottomTabScreenProps<MemberTabParamList>
>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns a short human-readable date string for a scheduled session.
 */
function formatScheduledDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Returns a relative timestamp string (e.g. "14m ago", "3h ago", "yesterday").
 * Same contract as the CHWDashboardScreen helper.
 */
function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(diff / 3_600_000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(diff / 86_400_000);
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

/**
 * Derives a time-of-day greeting string from the current hour.
 */
function deriveGreeting(hourOfDay: number): string {
  if (hourOfDay < 12) return 'Good morning';
  if (hourOfDay < 17) return 'Good afternoon';
  return 'Good evening';
}

// ─── Journey category icon/color mapping ──────────────────────────────────────

/**
 * Colour tokens for a journey category tile.
 * `pillVariant` must be a valid PillVariant — limited to the 6 canonical tokens.
 */
interface JourneyCategoryTokens {
  iconBg: string;
  iconColor: string;
  pillVariant: PillVariant;
  Icon: React.ComponentType<{ size: number; color: string; strokeWidth?: number }>;
}

/**
 * Maps a journey template slug to an icon component and colour tokens.
 * Falls back to a neutral Route icon when the slug is unrecognised.
 */
function resolveJourneyCategoryTokens(slug: string): JourneyCategoryTokens {
  if (
    slug === 'food_assistance' ||
    slug === 'calfresh_enrollment' ||
    slug === 'food_pantry'
  ) {
    return {
      iconBg: tokens.orange100,
      iconColor: tokens.orange700,
      pillVariant: 'amber',
      Icon: ShoppingBasket,
    };
  }
  if (slug === 'mental_health') {
    return {
      iconBg: tokens.purple100,
      iconColor: tokens.purple700,
      pillVariant: 'purple',
      Icon: HeartPulse,
    };
  }
  if (
    slug === 'housing' ||
    slug === 'rent_payment_assistance' ||
    slug === 'utility_support'
  ) {
    return {
      iconBg: tokens.blue100,
      iconColor: tokens.blue700,
      pillVariant: 'blue',
      Icon: Home,
    };
  }
  if (
    slug === 'maternal_health' ||
    slug === 'healthcare_appointment' ||
    slug === 'health_education'
  ) {
    return {
      iconBg: tokens.emerald100,
      iconColor: tokens.emerald700,
      pillVariant: 'emerald',
      Icon: Stethoscope,
    };
  }
  // Fallback
  return {
    iconBg: tokens.gray100,
    iconColor: tokens.gray700,
    pillVariant: 'gray',
    Icon: Route,
  };
}

/**
 * Derives the journey card subtitle from the current step.
 * If the member is on the last step, returns a "Almost done" nudge string.
 */
function resolveJourneySubtitle(journey: MemberJourneyResponse): string {
  const lastStepOrder = journey.steps.length;
  const currentStep = journey.currentStep ?? journey.steps[0] ?? null;

  if (!currentStep) return '';

  if (currentStep.stepOrder >= lastStepOrder) {
    return 'Almost done — Journey Complete coming up';
  }

  return currentStep.stepName;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

// ─── VerticalIcon map — lucide icons replacing emoji ──────────────────────────

/**
 * Returns the appropriate lucide icon for a given care vertical.
 * Each icon is sized at 20px with strokeWidth 2 and a token-derived colour.
 */
function VerticalIcon({ vertical }: { vertical: Vertical }): React.JSX.Element {
  switch (vertical) {
    case 'housing':
      return <Home size={20} color={tokens.primary} strokeWidth={2} accessibilityLabel="Housing vertical" />;
    case 'rehab':
      return <HeartPulse size={20} color={tokens.purple700} strokeWidth={2} accessibilityLabel="Rehab vertical" />;
    case 'food':
      return <ShoppingBasket size={20} color={tokens.orange700} strokeWidth={2} accessibilityLabel="Food vertical" />;
    case 'mental_health':
      return <HeartPulse size={20} color={tokens.purple700} strokeWidth={2} accessibilityLabel="Mental health vertical" />;
    case 'healthcare':
      return <ClipboardList size={20} color={tokens.primary} strokeWidth={2} accessibilityLabel="Healthcare vertical" />;
    default:
      return <ClipboardList size={20} color={tokens.primary} strokeWidth={2} />;
  }
}

// ─── UpcomingSessionRow ───────────────────────────────────────────────────────

interface UpcomingSessionRowProps {
  session: SessionData;
}

/**
 * Single upcoming-session row.
 *
 * The prep-checklist panel previously shown here used `mockActionItems()` —
 * a fake hash-based generator. There is no `/sessions/:id/action_items`
 * backend endpoint yet, so the panel is replaced with a clean empty state
 * that tells the member their CHW will add items. Remove this note and wire
 * real data once the endpoint ships.
 */
function UpcomingSessionRow({ session }: UpcomingSessionRowProps): React.JSX.Element {
  return (
    <View>
      {/* Session info row */}
      <View style={styles.sessionRow}>
        <View style={styles.sessionIconContainer}>
          <VerticalIcon vertical={(session.vertical as Vertical) ?? 'healthcare'} />
        </View>
        <View style={styles.sessionInfo}>
          <Text style={styles.sessionChwName} numberOfLines={1}>
            {session.chwName ?? 'CHW'}
          </Text>
          <Text style={styles.sessionDate}>{formatScheduledDate(session.scheduledAt)}</Text>
        </View>
        <Pill variant="blue" size="sm">Scheduled</Pill>
      </View>

      {/* Prep-checklist empty state — no action_items endpoint yet */}
      <View
        style={styles.todoEmpty}
        accessibilityLabel="No prep items yet"
      >
        <ListChecks size={14} color={tokens.textMuted} />
        <Text style={styles.todoEmptyText}>
          Your CHW will add prep items before your session.
        </Text>
      </View>
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export function MemberHomeScreen({ navigation }: MemberHomeScreenProps): React.JSX.Element {
  const { userName } = useAuth();

  const sessionsQuery = useSessions();
  const profileQuery  = useMemberProfile();
  const roadmapQuery  = useMemberRoadmap();
  const requestsQuery = useRequests();

  // useMemberJourneys requires the member's User UUID (not the Members row PK).
  // We wait for profileQuery to resolve before enabling it, so memberId is '':
  // useMemberJourneys guards on enabled: !!memberId internally.
  const memberId = profileQuery.data?.userId ?? '';
  const journeysQuery = useMemberJourneys(memberId);

  const refresh = useRefreshControl([
    sessionsQuery.refetch,
    profileQuery.refetch,
    roadmapQuery.refetch,
    requestsQuery.refetch,
    journeysQuery.refetch,
  ]);

  const allSessions  = sessionsQuery.data ?? [];
  const profile      = profileQuery.data;
  const roadmap      = roadmapQuery.data ?? [];
  const allRequests  = requestsQuery.data ?? [];

  // ── Assigned CHW — derived from sessions (most-recent session with a chwName).
  // Sessions carry `chwName` and `chwId` joined server-side. A member with no
  // sessions yet has no assigned CHW; we render a placeholder in that case.
  const assignedCHW = useMemo<{ name: string; chwId: string } | null>(() => {
    const sessionWithCHW = [...allSessions]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .find((s) => !!s.chwName && !!s.chwId);
    if (!sessionWithCHW) return null;
    return { name: sessionWithCHW.chwName!, chwId: sessionWithCHW.chwId };
  }, [allSessions]);

  const firstName      = (userName ?? profile?.userId ?? 'there').split(' ')[0];
  const rewardsBalance = profile?.rewardsBalance ?? 0;

  // Upcoming = scheduled AND not in the past. Stale seed sessions (e.g. a Dec 31
  // session viewed in April) would otherwise render as "upcoming" and look broken.
  const nowMs = Date.now();
  const upcomingSessions = allSessions.filter(
    (s) => s.status === 'scheduled' && new Date(s.scheduledAt).getTime() >= nowMs,
  );
  const completedSessionsCount = allSessions.filter((s) => s.status === 'completed').length;

  // Active goals = roadmap items NOT yet completed or dismissed.
  const activeRoadmapItems = roadmap.filter(
    (item) => item.status !== 'completed' && item.status !== 'dismissed',
  );

  // Open requests = member-submitted, not yet picked up by a CHW.
  const openRequestsCount = allRequests.filter((r) => r.status === 'open').length;

  // Active journeys for the Your Journeys section.
  const allJourneys   = journeysQuery.data ?? [];
  const activeJourneys = allJourneys.filter((j) => j.status === 'active');

  // Recent Activity — derived from data already loaded (sessions + requests),
  // newest first, capped at 4. The section hides entirely when empty so a
  // brand-new member never sees placeholder content.
  const recentActivity = useMemo(() => {
    interface ActivityItem {
      key: string;
      icon: React.JSX.Element;
      text: string;
      timestamp: string;
    }
    const items: ActivityItem[] = [];

    for (const s of allSessions) {
      const chwLabel = s.chwName ?? 'your CHW';
      if (s.status === 'completed') {
        items.push({
          key: `session-completed-${s.id}`,
          icon: <CheckCircle2 size={16} color={tokens.emerald700} />,
          text: `Session with ${chwLabel} completed`,
          timestamp: s.endedAt ?? s.scheduledAt,
        });
      } else if (s.status === 'scheduled') {
        items.push({
          key: `session-scheduled-${s.id}`,
          icon: <CalendarCheck size={16} color={tokens.blue700} />,
          text: `Session with ${chwLabel} scheduled for ${formatScheduledDate(s.scheduledAt)}`,
          timestamp: s.createdAt,
        });
      }
    }

    for (const r of allRequests) {
      const verticalLabel =
        verticalLabels[r.vertical as Vertical] ?? 'support';
      items.push({
        key: `request-${r.id}`,
        icon: <Hand size={16} color={tokens.amber700} />,
        text:
          r.status === 'open'
            ? `You requested help with ${verticalLabel}`
            : `Your ${verticalLabel} request was picked up by a CHW`,
        timestamp: r.createdAt,
      });
    }

    return items
      .filter((item) => !Number.isNaN(new Date(item.timestamp).getTime()))
      .sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      )
      .slice(0, 4);
  }, [allSessions, allRequests]);

  // ─── Navigation callbacks ──────────────────────────────────────────────────

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
    navigation.navigate('MemberJourney');
  }, [navigation]);

  const handleOpenJourney = useCallback(
    (focusJourneyId: string) => {
      navigation.navigate('MemberJourney', { focusJourneyId });
    },
    [navigation],
  );

  // ─── Loading / error guards ────────────────────────────────────────────────

  const isLoading =
    sessionsQuery.isLoading ||
    profileQuery.isLoading ||
    roadmapQuery.isLoading ||
    requestsQuery.isLoading;

  // journeysQuery loading is tracked separately so the journey section can
  // render its own skeleton without blocking the full page.
  const journeysLoading = journeysQuery.isLoading;

  // Only hard-error on sessions or profile. Roadmap and requests degrade
  // gracefully to empty arrays so partial-load never tombstones the screen.
  const hasError =
    !isLoading && (sessionsQuery.error !== null || profileQuery.error !== null);

  const handleRetry = useCallback(() => {
    void sessionsQuery.refetch();
    void profileQuery.refetch();
    void roadmapQuery.refetch();
    void requestsQuery.refetch();
  }, [sessionsQuery, profileQuery, roadmapQuery, requestsQuery]);

  // Sidebar avatar initials
  const memberInitials = (userName ?? profile?.name ?? 'M')
    .split(' ')
    .slice(0, 2)
    .map((part) => part[0] ?? '')
    .join('')
    .toUpperCase();

  const shellProps = {
    role: 'member' as const,
    activeKey: 'home',
    userBlock: { initials: memberInitials, name: userName ?? 'Member', role: 'Member' },
    badges: { wellnessPoints: rewardsBalance },
  };

  // ─── Loading state ─────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <AppShell {...shellProps}>
        <StatusBar barStyle="dark-content" backgroundColor={tokens.pageBg} />
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <PageWrap style={styles.pageWrapInner}>
            <LoadingSkeleton variant="stat-grid" />
            <LoadingSkeleton variant="rows" rows={3} />
          </PageWrap>
        </ScrollView>
      </AppShell>
    );
  }

  // ─── Error state ───────────────────────────────────────────────────────────

  if (hasError) {
    return (
      <AppShell {...shellProps}>
        <StatusBar barStyle="dark-content" backgroundColor={tokens.pageBg} />
        <ErrorState
          message="Could not load your home data. Please try again."
          onRetry={handleRetry}
        />
      </AppShell>
    );
  }

  // ─── Happy path ────────────────────────────────────────────────────────────

  const greeting = deriveGreeting(new Date().getHours());

  return (
    <AppShell {...shellProps}>
      <StatusBar barStyle="dark-content" backgroundColor={tokens.pageBg} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={refresh.control}
      >
        <PageWrap style={styles.pageWrapInner}>

          {/* ── Page title ──────────────────────────────────────────────── */}
          <PageHeader
            title={`${greeting}, ${firstName}`}
            subtitle="Here's what's happening today"
            right={
              <Hand
                size={22}
                color={tokens.primary}
                strokeWidth={2}
                accessibilityLabel="greeting wave"
              />
            }
          />

          {/* ── Your CHW hero card ───────────────────────────────────────
           *  Member-specific content: CHW initials derived from real session
           *  data, CHW name, and primary Message / Schedule CTAs.
           *  No fabricated availability or response-time text — only what the
           *  backend provides.
           *  When no CHW is assigned yet a sensible placeholder is shown.
           */}
          {assignedCHW !== null ? (
            <Card style={styles.heroCard}>
              <View style={styles.heroRow}>
                {/* Avatar — initials from real CHW name */}
                <View style={styles.heroAvatarWrap}>
                  <View style={styles.heroAvatar}>
                    <Text style={styles.heroAvatarText}>
                      {assignedCHW.name
                        .split(' ')
                        .slice(0, 2)
                        .map((p) => p[0] ?? '')
                        .join('')
                        .toUpperCase()}
                    </Text>
                  </View>
                </View>

                {/* CHW identity — name only; no fabricated availability text */}
                <View style={styles.heroInfo}>
                  <Text style={styles.heroChwLabel}>Your CHW</Text>
                  <Text style={styles.heroChwTitle}>{assignedCHW.name}</Text>
                </View>
              </View>

              {/* Action buttons */}
              <View style={styles.heroActions}>
                <Pressable
                  onPress={handleOpenSessions}
                  style={({ pressed }) => [
                    styles.heroPrimaryBtn,
                    pressed && { opacity: 0.85 },
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={`Send a message to ${assignedCHW.name}`}
                >
                  <MessageSquare size={16} color="#FFFFFF" />
                  <Text style={styles.heroPrimaryBtnText}>Send a message</Text>
                </Pressable>

                <Pressable
                  onPress={handleOpenSessions}
                  style={({ pressed }) => [
                    styles.heroSecondaryBtn,
                    pressed && { opacity: 0.85 },
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={`Schedule a call with ${assignedCHW.name}`}
                >
                  <Phone size={16} color={tokens.primary} />
                  <Text style={styles.heroSecondaryBtnText}>Schedule a call</Text>
                </Pressable>
              </View>
            </Card>
          ) : (
            <Card style={styles.heroCard}>
              <View style={styles.heroRow}>
                <View style={styles.heroAvatarWrap}>
                  <View style={[styles.heroAvatar, { backgroundColor: tokens.gray100 }]}>
                    <MessageSquare size={22} color={tokens.textSecondary} />
                  </View>
                </View>
                <View style={styles.heroInfo}>
                  <Text style={styles.heroChwLabel}>Your CHW</Text>
                  <Text style={[styles.heroChwTitle, { color: tokens.textSecondary }]}>
                    You haven't been matched with a CHW yet
                  </Text>
                </View>
              </View>
              <View style={styles.heroActions}>
                <Pressable
                  onPress={handleFindCHW}
                  style={({ pressed }) => [
                    styles.heroPrimaryBtn,
                    pressed && { opacity: 0.85 },
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="Find a Community Health Worker"
                >
                  <MessageSquare size={16} color="#FFFFFF" />
                  <Text style={styles.heroPrimaryBtnText}>Find a CHW</Text>
                </Pressable>
              </View>
            </Card>
          )}

          {/* ── KPI stat grid (2×2) ─────────────────────────────────────
           *  Mirror of CHWDashboard's KPI row — same tile pattern, member
           *  content: Rewards, Upcoming sessions, Active Goals, Open Requests.
           */}
          <View style={styles.statGrid}>
            <StaggerList delayMs={50} durationMs={240}>
              <StatTile
                icon={<Gift color={tokens.emerald700} size={18} />}
                iconBg={tokens.emerald100}
                label="Wellness Points"
                value={rewardsBalance.toLocaleString()}
                delta="Points earned"
                style={styles.statGridTile}
                onPress={handleOpenRewards}
                accessibilityLabel={`Wellness Points: ${rewardsBalance.toLocaleString()}`}
              />
              <StatTile
                icon={<CalendarCheck color={tokens.blue700} size={18} />}
                iconBg={tokens.blue100}
                label="Upcoming"
                value={upcomingSessions.length}
                delta={upcomingSessions.length === 1 ? 'Session' : 'Sessions'}
                deltaColor={tokens.blue700}
                style={styles.statGridTile}
                onPress={handleOpenSessions}
                accessibilityLabel={`Upcoming sessions: ${upcomingSessions.length}`}
              />
              <StatTile
                icon={<Target color={tokens.amber700} size={18} />}
                iconBg={tokens.amber100}
                label="Active Goals"
                value={activeRoadmapItems.length}
                delta="On your roadmap"
                deltaColor={tokens.amber700}
                style={styles.statGridTile}
                onPress={handleOpenRoadmap}
                accessibilityLabel={`Active goals: ${activeRoadmapItems.length}`}
              />
              <StatTile
                icon={<ClipboardList color={tokens.purple700} size={18} />}
                iconBg={tokens.purple100}
                label="Open Requests"
                value={openRequestsCount}
                delta="Awaiting CHW"
                deltaColor={tokens.purple700}
                style={styles.statGridTile}
                onPress={handleFindCHW}
                accessibilityLabel={`Open requests: ${openRequestsCount}`}
              />
            </StaggerList>
          </View>

          {/* ── Secondary stat row — completed sessions ──────────────── */}
          <View style={styles.statRow}>
            <StatTile
              icon={<CheckCircle2 color={tokens.emerald700} size={18} />}
              iconBg={tokens.emerald100}
              label="Completed Sessions"
              value={completedSessionsCount}
              delta={completedSessionsCount === 1 ? 'Session all-time' : 'Sessions all-time'}
              style={{ flex: 1 }}
              accessibilityLabel={`Completed sessions: ${completedSessionsCount}`}
            />
          </View>

          {/* ── Your Journeys ────────────────────────────────────────────
           *  Live data from useMemberJourneys. Filtered to status==='active'.
           *  Each card navigates to MemberJourneyScreen with focusJourneyId.
           */}
          <SectionHeader
            title="Your Journeys"
            right={
              <Pressable
                onPress={() => navigation.navigate('MemberJourney', undefined)}
                accessibilityRole="link"
                accessibilityLabel="View all journeys"
              >
                <Text style={styles.viewAllLink}>View all →</Text>
              </Pressable>
            }
            marginBottom={spacing.md}
          />

          {/* Loading state — skeleton cards at journey card dimensions */}
          {journeysLoading && (
            <View style={styles.journeyRow}>
              <View style={[styles.journeyCard, styles.journeySkeletonCard]} />
              <View style={[styles.journeyCard, styles.journeySkeletonCard]} />
            </View>
          )}

          {/* Empty state — member has no active journeys */}
          {!journeysLoading && activeJourneys.length === 0 && (
            <EmptyState
              icon={Route}
              title="No journeys yet"
              body={"Your CHW will assign one after your first session"}
              style={styles.journeyEmptyState}
            />
          )}

          {/* Live journey cards */}
          {!journeysLoading && activeJourneys.length > 0 && (
            <View style={styles.journeyRow}>
              {activeJourneys.map((journey) => {
                const progressPct = Math.round(journey.progressPercent);
                const categoryTokens = resolveJourneyCategoryTokens(
                  journey.template.slug,
                );
                const subtitle = resolveJourneySubtitle(journey);
                const { iconBg, iconColor, pillVariant, Icon: CategoryIcon } =
                  categoryTokens;

                return (
                  <PressableCard
                    key={journey.id}
                    onPress={() => handleOpenJourney(journey.id)}
                    style={styles.journeyCard}
                    accessibilityLabel={`${journey.template.name}, ${progressPct}% complete, tap to view journey roadmap`}
                  >
                    <View style={styles.journeyCardHeader}>
                      {/* Category icon tile — 56×56, rounded 12 */}
                      <View
                        style={[
                          styles.journeyIconCircle,
                          { backgroundColor: iconBg },
                        ]}
                      >
                        <CategoryIcon
                          size={22}
                          color={iconColor}
                          strokeWidth={2}
                        />
                      </View>

                      {/* Title + current step subtitle */}
                      <View style={styles.journeyCardText}>
                        <Text style={styles.journeyCardTitle} numberOfLines={1}>
                          {journey.template.name}
                        </Text>
                        {subtitle.length > 0 && (
                          <Text style={styles.journeyCardSub} numberOfLines={1}>
                            {subtitle}
                          </Text>
                        )}
                      </View>

                      {/* Progress % chip — colour family matches icon tile.
                       *  Nested Text carries tabular-nums so digit widths
                       *  stay stable across values like 9% → 100%. */}
                      <Pill variant={pillVariant} size="sm">
                        <Text style={numerals.tabular}>{progressPct}%</Text>
                      </Pill>
                    </View>

                    {/* Progress bar — emerald primary fill on gray track */}
                    <View
                      style={styles.journeyProgressTrack}
                      accessibilityRole="progressbar"
                      accessibilityValue={{ min: 0, max: 100, now: progressPct }}
                    >
                      <View
                        style={[
                          styles.journeyProgressFill,
                          { width: `${progressPct}%` },
                        ]}
                      />
                    </View>
                  </PressableCard>
                );
              })}
            </View>
          )}

          {/* ── Recent Activity ──────────────────────────────────────────
           *  Derived from the member's real sessions + requests (see
           *  recentActivity memo). Hidden entirely when there is nothing
           *  to show. Icon colours use semantic tokens — not legacy palette.
           */}
          {recentActivity.length > 0 && (
            <>
              <SectionHeader title="Recent Activity" marginBottom={spacing.md} />
              <Card style={styles.activityCard}>
                {recentActivity.map((item, idx) => (
                  <View
                    key={item.key}
                    style={[
                      styles.activityRow,
                      idx > 0 && { borderTopWidth: 1, borderTopColor: tokens.gray100 },
                    ]}
                  >
                    {item.icon}
                    <Text style={styles.activityText} numberOfLines={1}>
                      {item.text}
                    </Text>
                    <Text style={styles.activityTime}>{relativeTime(item.timestamp)}</Text>
                  </View>
                ))}
              </Card>
            </>
          )}

          {/* ── Find CHW CTA card ────────────────────────────────────────
           *  Solid green action strip — same pattern as CHW dashboard CTAs.
           */}
          <Pressable
            onPress={handleFindCHW}
            style={({ pressed }) => [styles.ctaCard, pressed && { opacity: 0.9 }]}
            accessibilityRole="button"
            accessibilityLabel="Find a Community Health Worker"
          >
            <View style={styles.ctaContent}>
              <Text style={styles.ctaTitle}>Need help with a new goal?</Text>
              <Text style={styles.ctaSub}>Find a Community Health Worker near you.</Text>
            </View>
            <View style={styles.ctaButton}>
              <Text style={styles.ctaButtonText}>Find CHW</Text>
              <ArrowRight color={tokens.primary} size={13} />
            </View>
          </Pressable>

          {/* ── Upcoming Sessions card ───────────────────────────────────
           *  Hidden when the member has no upcoming sessions.
           */}
          {upcomingSessions.length > 0 && (
            <Card style={styles.sessionsCard}>
              <View style={styles.sessionsCardHeader}>
                <SectionHeader
                  title="Upcoming Sessions"
                  marginBottom={0}
                  style={{ flex: 1 }}
                />
              </View>
              {upcomingSessions.map((session, idx) => (
                <React.Fragment key={session.id}>
                  <UpcomingSessionRow session={session} />
                  {idx < upcomingSessions.length - 1 && (
                    <View style={styles.divider} />
                  )}
                </React.Fragment>
              ))}
            </Card>
          )}

          <View style={styles.bottomPadding} />
        </PageWrap>
      </ScrollView>
    </AppShell>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
//
// All colour values sourced from `tokens` (theme/tokens.ts).
// No raw hex literals unless there is no token equivalent (avatar bg, online
// dot which are component-specific one-offs).

const styles = StyleSheet.create({
  // ── Shell ──────────────────────────────────────────────────────────────────

  scroll: {
    flex: 1,
  } as import('react-native').ViewStyle,

  scrollContent: {
    flexGrow: 1,
    // On web AppShell owns horizontal padding via mainContent; on native we
    // center the PageWrap ourselves.
    ...(Platform.OS !== 'web' ? { alignItems: 'center' } : {}),
  } as import('react-native').ViewStyle,

  // PageWrap inner padding — PageWrap already constrains to 1280px on web.
  pageWrapInner: {
    paddingHorizontal: spacing.xxl,
    paddingTop: spacing.xxl,
  } as import('react-native').ViewStyle,

  // ── Hero CHW card ──────────────────────────────────────────────────────────

  heroCard: {
    // Light emerald tint to distinguish this from plain white cards.
    backgroundColor: '#F0FDF4',
    borderColor: '#BBF7D0',
    padding: spacing.xl,
    marginBottom: spacing.xxl,
    gap: spacing.md,
  } as import('react-native').ViewStyle,

  heroRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
  } as import('react-native').ViewStyle,

  heroAvatarWrap: {
    position: 'relative',
  } as import('react-native').ViewStyle,

  heroAvatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: tokens.emerald500,
    alignItems: 'center',
    justifyContent: 'center',
  } as import('react-native').ViewStyle,

  heroAvatarText: {
    fontFamily: fonts.display,
    fontSize: 20,
    color: '#FFFFFF',
  } as import('react-native').TextStyle,

  heroOnlineDot: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 14,
    height: 14,
    borderRadius: radius.pill,
    backgroundColor: tokens.emerald500,
    borderWidth: 2,
    borderColor: '#FFFFFF',
  } as import('react-native').ViewStyle,

  heroInfo: {
    flex: 1,
    gap: 2,
  } as import('react-native').ViewStyle,

  heroChwLabel: {
    fontFamily: fonts.bodySemibold,
    fontSize: 11,
    color: tokens.primary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  } as import('react-native').TextStyle,

  heroChwTitle: {
    fontFamily: fonts.display,
    fontSize: 18,
    color: tokens.textPrimary,
    lineHeight: 24,
  } as import('react-native').TextStyle,

  heroChwSub: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: tokens.textSecondary,
    lineHeight: 16,
  } as import('react-native').TextStyle,

  heroActions: {
    flexDirection: 'row',
    gap: spacing.sm,
  } as import('react-native').ViewStyle,

  heroPrimaryBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    backgroundColor: tokens.primary,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
  } as import('react-native').ViewStyle,

  heroPrimaryBtnText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 14,
    color: '#FFFFFF',
  } as import('react-native').TextStyle,

  heroSecondaryBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    borderWidth: 1,
    borderColor: '#BBF7D0',
    borderRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
    backgroundColor: '#FFFFFF',
  } as import('react-native').ViewStyle,

  heroSecondaryBtnText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 14,
    color: tokens.primary,
  } as import('react-native').TextStyle,

  // ── Stat grid (2×2) ───────────────────────────────────────────────────────
  //
  // Pattern: flexWrap:'wrap' + minWidth/flexBasis:'48%' + flexGrow:1
  // mirrors CHWDashboardScreen's KPI row exactly.

  statGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    marginBottom: spacing.md,
  } as import('react-native').ViewStyle,

  statGridTile: {
    minWidth: '48%',
    flexBasis: '48%',
    flexGrow: 1,
  } as import('react-native').ViewStyle,

  statRow: {
    flexDirection: 'row',
    gap: spacing.md,
    marginBottom: spacing.xxl,
  } as import('react-native').ViewStyle,

  // ── View all link ──────────────────────────────────────────────────────────

  viewAllLink: {
    fontFamily: fonts.bodySemibold,
    fontSize: 13,
    color: tokens.primary,
  } as import('react-native').TextStyle,

  // ── Journey cards row ──────────────────────────────────────────────────────

  journeyRow: {
    flexDirection: 'row',
    gap: spacing.md,
    marginBottom: spacing.xxl,
  } as import('react-native').ViewStyle,

  journeyCard: {
    flex: 1,
    backgroundColor: tokens.cardBg,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    padding: spacing.xl,
    gap: spacing.md,
    // matches tokens.shadows.card — inlined to avoid spread in StyleSheet
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 1,
  } as import('react-native').ViewStyle,

  journeyCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  } as import('react-native').ViewStyle,

  journeyIconCircle: {
    width: 56,
    height: 56,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  } as import('react-native').ViewStyle,

  journeySkeletonCard: {
    // Approximate journey card height — same padding + icon row + progress bar
    height: 112,
    backgroundColor: tokens.gray100,
    opacity: 0.6,
  } as import('react-native').ViewStyle,

  journeyEmptyState: {
    marginBottom: spacing.xxl,
  } as import('react-native').ViewStyle,

  journeyCardText: {
    flex: 1,
    gap: 2,
  } as import('react-native').ViewStyle,

  journeyCardTitle: {
    fontFamily: fonts.display,
    fontSize: 15,
    color: tokens.textPrimary,
    lineHeight: 20,
  } as import('react-native').TextStyle,

  journeyCardSub: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: tokens.textSecondary,
  } as import('react-native').TextStyle,

  journeyProgressTrack: {
    height: 8,
    backgroundColor: tokens.gray100,
    borderRadius: radius.pill,
    overflow: 'hidden',
  } as import('react-native').ViewStyle,

  journeyProgressFill: {
    height: '100%',
    backgroundColor: tokens.primary,
    borderRadius: radius.pill,
  } as import('react-native').ViewStyle,

  // ── Recent activity ────────────────────────────────────────────────────────

  activityCard: {
    marginBottom: spacing.lg,
    overflow: 'hidden',
  } as import('react-native').ViewStyle,

  activityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  } as import('react-native').ViewStyle,

  activityText: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: tokens.gray700,
    flex: 1,
  } as import('react-native').TextStyle,

  activityTime: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: tokens.textMuted,
  } as import('react-native').TextStyle,

  // ── Find CHW CTA strip ─────────────────────────────────────────────────────

  ctaCard: {
    backgroundColor: tokens.primary,
    borderRadius: radius.xl,
    padding: spacing.lg + 2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    marginBottom: spacing.lg,
  } as import('react-native').ViewStyle,

  ctaContent: {
    flex: 1,
  } as import('react-native').ViewStyle,

  ctaTitle: {
    fontFamily: fonts.display,
    fontSize: 16,
    lineHeight: 22,
    color: '#FFFFFF',
  } as import('react-native').TextStyle,

  ctaSub: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: 'rgba(255,255,255,0.75)',
    marginTop: 2,
  } as import('react-native').TextStyle,

  ctaButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.lg,
  } as import('react-native').ViewStyle,

  ctaButtonText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 14,
    color: tokens.primary,
  } as import('react-native').TextStyle,

  // ── Upcoming sessions card ─────────────────────────────────────────────────

  sessionsCard: {
    marginBottom: spacing.lg,
    overflow: 'hidden',
  } as import('react-native').ViewStyle,

  sessionsCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: tokens.cardBorder,
  } as import('react-native').ViewStyle,

  // ── Session row ────────────────────────────────────────────────────────────

  sessionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg,
    gap: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: tokens.cardBorder,
  } as import('react-native').ViewStyle,

  sessionIconContainer: {
    width: 44,
    height: 44,
    borderRadius: radius.lg,
    // 15% opacity emerald for icon badge bg
    backgroundColor: `${tokens.primary}26`,
    alignItems: 'center',
    justifyContent: 'center',
  } as import('react-native').ViewStyle,

  sessionInfo: {
    flex: 1,
  } as import('react-native').ViewStyle,

  sessionChwName: {
    fontFamily: fonts.display,
    fontSize: 14,
    lineHeight: 20,
    color: tokens.textPrimary,
  } as import('react-native').TextStyle,

  sessionDate: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: tokens.textSecondary,
    marginTop: 1,
  } as import('react-native').TextStyle,

  divider: {
    height: 1,
    backgroundColor: tokens.cardBorder,
    marginHorizontal: spacing.lg,
  } as import('react-native').ViewStyle,

  // ── Prep-checklist empty state ────────────────────────────────────────────

  todoEmpty: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: spacing.xl,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    backgroundColor: tokens.cardBg,
  } as import('react-native').ViewStyle,

  todoEmptyText: {
    flex: 1,
    fontFamily: fonts.body,
    fontSize: 12,
    color: tokens.textMuted,
    lineHeight: 16,
  } as import('react-native').TextStyle,

  // ── Bottom padding ─────────────────────────────────────────────────────────

  bottomPadding: {
    height: spacing.xxl,
  } as import('react-native').ViewStyle,
});

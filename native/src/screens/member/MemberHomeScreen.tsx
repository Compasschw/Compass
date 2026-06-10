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

import React, { useCallback, useMemo, useState } from 'react';
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
  ChevronDown,
  ChevronUp,
  ClipboardList,
  Gift,
  Hand,
  HeartPulse,
  Home,
  ListChecks,
  MessageSquare,
  Phone,
  ShoppingBasket,
  Square,
  CheckSquare,
  Target,
  Trophy,
} from 'lucide-react-native';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';

import { useAuth } from '../../context/AuthContext';
import { colors as tokens, spacing, radius } from '../../theme/tokens';
import { fonts } from '../../theme/typography';
import {
  verticalLabels,
  type Vertical,
} from '../../data/mock';
import {
  useSessions,
  useMemberProfile,
  useRequests,
  type SessionData,
} from '../../hooks/useApiQueries';
import {
  AppShell,
  Card,
  PageHeader,
  PageWrap,
  Pill,
  PressableCard,
  SectionHeader,
  StatTile,
  StaggerList,
} from '../../components/ui';
import { useMemberRoadmap } from '../../hooks/useFollowupQueries';
import { useRefreshControl } from '../../hooks/useRefreshControl';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';
import type { MemberTabParamList } from '../../navigation/MemberTabNavigator';

// ─── Types ────────────────────────────────────────────────────────────────────

interface MemberHomeScreenProps {
  navigation: BottomTabNavigationProp<MemberTabParamList, 'Home'>;
}

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
 * Derives a time-of-day greeting string from the current hour.
 */
function deriveGreeting(hourOfDay: number): string {
  if (hourOfDay < 12) return 'Good morning';
  if (hourOfDay < 17) return 'Good afternoon';
  return 'Good evening';
}

// ─── Sub-components ───────────────────────────────────────────────────────────

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
  const charSum = sessionId.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  // Deterministic 3-item pick from the pool based on session id hash.
  const start = charSum % pool.length;
  return [
    pool[start],
    pool[(start + 2) % pool.length],
    pool[(start + 4) % pool.length],
  ];
}

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
 * Single upcoming-session row with a collapsible prep-checklist panel.
 * The "Scheduled" badge now uses the shared Pill primitive (blue variant).
 */
function UpcomingSessionRow({ session }: UpcomingSessionRowProps): React.JSX.Element {
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

      {/* Prep-checklist toggle */}
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
        <ListChecks size={14} color={tokens.primary} />
        <Text style={styles.todoToggleText}>
          Prep checklist · {completedCount}/{totalCount}
        </Text>
        {expanded
          ? <ChevronUp size={14} color={tokens.textMuted} />
          : <ChevronDown size={14} color={tokens.textMuted} />}
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
                  ? <CheckSquare size={16} color={tokens.primary} />
                  : <Square size={16} color={tokens.textMuted} />}
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
  const profileQuery  = useMemberProfile();
  const roadmapQuery  = useMemberRoadmap();
  const requestsQuery = useRequests();

  const refresh = useRefreshControl([
    sessionsQuery.refetch,
    profileQuery.refetch,
    roadmapQuery.refetch,
    requestsQuery.refetch,
  ]);

  const allSessions  = sessionsQuery.data ?? [];
  const profile      = profileQuery.data;
  const roadmap      = roadmapQuery.data ?? [];
  const allRequests  = requestsQuery.data ?? [];

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
    navigation.navigate('Roadmap');
  }, [navigation]);

  // ─── Loading / error guards ────────────────────────────────────────────────

  const isLoading =
    sessionsQuery.isLoading ||
    profileQuery.isLoading ||
    roadmapQuery.isLoading ||
    requestsQuery.isLoading;

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
           *  Member-specific content: photo/initials, name, availability
           *  message, and primary Call / Message CTAs.
           */}
          <Card style={styles.heroCard}>
            <View style={styles.heroRow}>
              {/* Avatar + online indicator */}
              <View style={styles.heroAvatarWrap}>
                <View style={styles.heroAvatar}>
                  <Text style={styles.heroAvatarText}>MS</Text>
                </View>
                <View style={styles.heroOnlineDot} />
              </View>

              {/* CHW identity */}
              <View style={styles.heroInfo}>
                <Text style={styles.heroChwLabel}>Your CHW</Text>
                <Text style={styles.heroChwTitle}>Maria is available now</Text>
                <Text style={styles.heroChwSub}>
                  Usually responds in under 2 hours · English &amp; Spanish
                </Text>
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
                accessibilityLabel="Send a message to your CHW"
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
                accessibilityLabel="Schedule a call with your CHW"
              >
                <Phone size={16} color={tokens.primary} />
                <Text style={styles.heroSecondaryBtnText}>Schedule a call</Text>
              </Pressable>
            </View>
          </Card>

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
           *  Static journey cards until the active roadmap items surface
           *  a live journey list. Progress bars use emerald token.
           */}
          <SectionHeader
            title="Your Journeys"
            right={
              <Pressable
                onPress={handleOpenRoadmap}
                accessibilityRole="link"
                accessibilityLabel="View all journeys"
              >
                <Text style={styles.viewAllLink}>View all →</Text>
              </Pressable>
            }
            marginBottom={spacing.md}
          />
          <View style={styles.journeyRow}>
            {/* Food Assistance */}
            <PressableCard
              onPress={handleOpenRoadmap}
              style={styles.journeyCard}
              accessibilityLabel="Food Assistance journey, 60% complete"
            >
              <View style={styles.journeyCardHeader}>
                <View style={[styles.journeyIconCircle, { backgroundColor: '#FED7AA' }]}>
                  <ShoppingBasket
                    size={22}
                    color={tokens.orange700}
                    strokeWidth={2}
                    accessibilityLabel="food assistance category"
                  />
                </View>
                <View style={styles.journeyCardText}>
                  <Text style={styles.journeyCardTitle}>Food Assistance</Text>
                  <Text style={styles.journeyCardSub}>CalFresh enrollment</Text>
                </View>
                <Pill variant="emerald" size="sm">60%</Pill>
              </View>
              <View
                style={styles.journeyProgressTrack}
                accessibilityRole="progressbar"
                accessibilityValue={{ min: 0, max: 100, now: 60 }}
              >
                <View style={[styles.journeyProgressFill, { width: '60%' }]} />
              </View>
            </PressableCard>

            {/* Mental Health */}
            <PressableCard
              onPress={handleOpenRoadmap}
              style={styles.journeyCard}
              accessibilityLabel="Mental Health journey, 80% complete"
            >
              <View style={styles.journeyCardHeader}>
                <View style={[styles.journeyIconCircle, { backgroundColor: '#E9D5FF' }]}>
                  <HeartPulse
                    size={22}
                    color={tokens.purple700}
                    strokeWidth={2}
                    accessibilityLabel="mental health category"
                  />
                </View>
                <View style={styles.journeyCardText}>
                  <Text style={styles.journeyCardTitle}>Mental Health</Text>
                  <Text style={styles.journeyCardSub}>Behavioral health referral</Text>
                </View>
                <Pill variant="purple" size="sm">80%</Pill>
              </View>
              <View
                style={styles.journeyProgressTrack}
                accessibilityRole="progressbar"
                accessibilityValue={{ min: 0, max: 100, now: 80 }}
              >
                <View style={[styles.journeyProgressFill, { width: '80%' }]} />
              </View>
            </PressableCard>
          </View>

          {/* ── Recent Activity ──────────────────────────────────────────
           *  Static feed; wire to a real activity endpoint when available.
           *  Icon colours use semantic tokens — not legacy palette.
           */}
          <SectionHeader title="Recent Activity" marginBottom={spacing.md} />
          <Card style={styles.activityCard}>
            {[
              {
                icon: <MessageSquare size={16} color={tokens.blue700} />,
                text: 'Maria sent you a message',
                time: '1h ago',
              },
              {
                icon: <Trophy size={16} color={tokens.amber700} />,
                text: 'You earned +25 pts for Eligibility Screening',
                time: '2d ago',
              },
              {
                icon: <CalendarCheck size={16} color={tokens.emerald700} />,
                text: 'Your appointment Mon was confirmed',
                time: '3d ago',
              },
            ].map((item, idx) => (
              <View
                key={idx}
                style={[
                  styles.activityRow,
                  idx > 0 && { borderTopWidth: 1, borderTopColor: tokens.gray100 },
                ]}
              >
                {item.icon}
                <Text style={styles.activityText}>{item.text}</Text>
                <Text style={styles.activityTime}>{item.time}</Text>
              </View>
            ))}
          </Card>

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
    width: 44,
    height: 44,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
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

  // ── Prep-checklist toggle ──────────────────────────────────────────────────

  todoToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: spacing.xl,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: `${tokens.primary}10`,
    borderWidth: 1,
    borderColor: `${tokens.primary}30`,
  } as import('react-native').ViewStyle,

  todoToggleText: {
    flex: 1,
    fontFamily: fonts.bodySemibold,
    fontSize: 12,
    color: tokens.primary,
  } as import('react-native').TextStyle,

  todoList: {
    marginHorizontal: spacing.xl,
    marginBottom: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    borderRadius: radius.md,
    backgroundColor: tokens.cardBg,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    gap: spacing.sm,
  } as import('react-native').ViewStyle,

  todoItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    paddingVertical: 4,
  } as import('react-native').ViewStyle,

  todoItemText: {
    flex: 1,
    fontFamily: fonts.body,
    fontSize: 13,
    color: tokens.textPrimary,
    lineHeight: 18,
  } as import('react-native').TextStyle,

  todoItemTextDone: {
    color: tokens.textMuted,
    textDecorationLine: 'line-through',
  } as import('react-native').TextStyle,

  // ── Bottom padding ─────────────────────────────────────────────────────────

  bottomPadding: {
    height: spacing.xxl,
  } as import('react-native').ViewStyle,
});

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
  CalendarCheck,
  CheckCircle2,
  ClipboardList,
  Gift,
  Hand,
  HeartPulse,
  Bus,
  Briefcase,
  Home,
  Lightbulb,
  ListChecks,
  MessageSquare,
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
  useAssignedCHW,
  useChangePassword,
  useTestimonialPrompt,
  useSubmitTestimonial,
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
import { countAwaitingChw } from './memberDashboard';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';
import { PromptDialog, type PromptDialogField } from '../../components/shared/PromptDialog';
import { ApiError } from '../../api/client';
import type {
  MemberHomeStackParamList,
  MemberTabParamList,
} from '../../navigation/MemberTabNavigator';
import {
  MemberPendingRequestsList,
  selectMemberPendingRequests,
} from './MemberPendingRequestsList';

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
    // Grandfathered — includes the legacy 'housing' canonical-journey slug
    // (see journey_reconciler.py _LABEL_TO_SLUG) alongside the pre-existing
    // sub-pathway slugs so an existing Housing journey keeps its icon/colour.
    return {
      iconBg: tokens.blue100,
      iconColor: tokens.blue700,
      pillVariant: 'blue',
      Icon: Home,
    };
  }
  if (slug === 'utilities') {
    // New canonical-journey slug (journey_reconciler.py _LABEL_TO_SLUG),
    // created on demand when a member's resource needs include 'utilities'.
    return {
      iconBg: tokens.amber100,
      iconColor: tokens.amber700,
      pillVariant: 'amber',
      Icon: Lightbulb,
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
      // Grandfathered — historical rows still render the Home icon.
      return <Home size={20} color={tokens.primary} strokeWidth={2} accessibilityLabel="Housing vertical" />;
    case 'utilities':
      return <Lightbulb size={20} color={tokens.primary} strokeWidth={2} accessibilityLabel="Utilities vertical" />;
    case 'transportation':
      return <Bus size={20} color={tokens.primary} strokeWidth={2} accessibilityLabel="Transportation vertical" />;
    case 'food':
      return <ShoppingBasket size={20} color={tokens.orange700} strokeWidth={2} accessibilityLabel="Food vertical" />;
    case 'mental_health':
      return <HeartPulse size={20} color={tokens.purple700} strokeWidth={2} accessibilityLabel="Mental health vertical" />;
    case 'healthcare':
      return <ClipboardList size={20} color={tokens.primary} strokeWidth={2} accessibilityLabel="Healthcare vertical" />;
    case 'employment':
      return <Briefcase size={20} color={tokens.primary} strokeWidth={2} accessibilityLabel="Employment vertical" />;
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

// ─── Epic B2: post-session rating prompt — session-scoped "Maybe later" ──────
//
// Module-level (not component state, not persisted storage): "Maybe later"
// dismisses the CURRENT app session's copy of the prompt only. This is a
// deliberate product choice (see prompt task spec) — a rating nudge that's
// permanently suppressed after one dismissal would mean a member who taps
// "Maybe later" in a rush never gets asked again, even for a LATER session.
// Re-opening the app (fresh JS module load / cold start) clears this set, so
// the prompt can resurface next visit. This mirrors no other gate in this
// screen (G2's password gate is mandatory/non-dismissable; Epic M's pending-
// requests widget has no dismiss action) — it is intentionally the ONLY
// "soft dismiss" pattern here, scoped narrowly to this one feature.
const dismissedTestimonialPromptSessionIds = new Set<string>();

// ─── Screen ───────────────────────────────────────────────────────────────────

export function MemberHomeScreen({ navigation }: MemberHomeScreenProps): React.JSX.Element {
  const { userName } = useAuth();

  const sessionsQuery     = useSessions();
  const profileQuery      = useMemberProfile();
  const roadmapQuery      = useMemberRoadmap();
  const requestsQuery     = useRequests();
  const assignedCHWQuery  = useAssignedCHW();

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
    assignedCHWQuery.refetch,
  ]);

  // ── Mandatory first-login password change (Epic G2) ─────────────────────
  // A CHW-created member is handed a temp password out-of-band and must
  // replace it before continuing. `mustChangePassword` comes straight off
  // the member-profile bootstrap (GET /member/profile) — self-registered
  // members (who chose their own password) never see this. No `onCancel` is
  // passed to PromptDialog below, so it's a mandatory, non-dismissable gate.
  const changePasswordMutation = useChangePassword();
  const [passwordFields, setPasswordFields] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });
  const [passwordFormError, setPasswordFormError] = useState<string | null>(null);
  const [passwordFieldErrors, setPasswordFieldErrors] = useState<Record<string, string | null>>({});

  const mustChangePassword = Boolean(profileQuery.data?.mustChangePassword);

  const handlePasswordFieldChange = useCallback((key: string, value: string) => {
    setPasswordFields((prev) => ({ ...prev, [key]: value }));
    // Clear any stale error on this field as soon as the member edits it.
    setPasswordFieldErrors((prev) => (prev[key] ? { ...prev, [key]: null } : prev));
    setPasswordFormError(null);
  }, []);

  const handleChangePasswordConfirm = useCallback(() => {
    const { currentPassword, newPassword, confirmPassword } = passwordFields;
    setPasswordFormError(null);

    if (!currentPassword || !newPassword || !confirmPassword) {
      setPasswordFormError('Please fill in all fields.');
      return;
    }
    if (newPassword.length < 8) {
      setPasswordFieldErrors({ newPassword: 'Must be at least 8 characters.' });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordFieldErrors({ confirmPassword: 'Passwords do not match.' });
      return;
    }
    setPasswordFieldErrors({});

    changePasswordMutation.mutate(
      { currentPassword, newPassword },
      {
        onSuccess: () => {
          setPasswordFields({ currentPassword: '', newPassword: '', confirmPassword: '' });
          setPasswordFormError(null);
          setPasswordFieldErrors({});
          // Belt-and-suspenders: useChangePassword already invalidates the
          // memberProfile query, but an explicit refetch here means the
          // dialog closes on THIS render pass rather than waiting for the
          // invalidation's background refetch to resolve.
          void profileQuery.refetch();
        },
        onError: (err: unknown) => {
          // Do not let a transient failure (or any exception shape) crash
          // this screen — always resolve to an inline, dismiss-free message
          // so the member can simply retry.
          if (err instanceof ApiError && err.status === 401) {
            setPasswordFieldErrors({ currentPassword: 'Current password is incorrect.' });
            return;
          }
          if (err instanceof ApiError && err.status === 422) {
            setPasswordFieldErrors({ newPassword: 'Password must be at least 8 characters.' });
            return;
          }
          setPasswordFormError(
            err instanceof Error && err.message
              ? err.message
              : 'Could not update your password. Please try again.',
          );
        },
      },
    );
  }, [passwordFields, changePasswordMutation, profileQuery]);

  const passwordPromptFields: PromptDialogField[] = useMemo(
    () => [
      {
        key: 'currentPassword',
        label: 'Current (temporary) password',
        secureTextEntry: true,
        autoComplete: 'current-password',
        errorText: passwordFieldErrors.currentPassword ?? null,
      },
      {
        key: 'newPassword',
        label: 'New password',
        placeholder: 'At least 8 characters',
        secureTextEntry: true,
        autoComplete: 'new-password',
        errorText: passwordFieldErrors.newPassword ?? null,
      },
      {
        key: 'confirmPassword',
        label: 'Confirm new password',
        secureTextEntry: true,
        autoComplete: 'new-password',
        errorText: passwordFieldErrors.confirmPassword ?? null,
      },
    ],
    [passwordFieldErrors],
  );

  // ── Post-session star-rating prompt (Epic B2) ────────────────────────────
  // GET /testimonials/prompts surfaces the member's single most-recent
  // completed-but-unrated session (backend caps staleness at 14 days and
  // returns at most one). This prompt is a DISMISSABLE overlay (onCancel is
  // supplied to PromptDialog below) — unlike G2's mandatory password gate,
  // "Maybe later" always lets the member continue. It is shown ONLY when
  // the G2 gate is not showing (see the `showTestimonialPrompt` derivation
  // near the render below) — the two modals must never stack.
  const testimonialPromptQuery = useTestimonialPrompt();
  const submitTestimonialMutation = useSubmitTestimonial();
  const [ratingFields, setRatingFields] = useState({ rating: '', text: '' });
  const [ratingFormError, setRatingFormError] = useState<string | null>(null);
  // Locally track the id of the session most recently dismissed via "Maybe
  // later", so the dialog closes immediately without waiting on a refetch.
  // Keyed by session id (not a plain boolean) so if the prompts query later
  // resolves to a DIFFERENT session (e.g. after this one's testimonial is
  // submitted through another path), the new session is still offered —
  // the source of truth for "don't show THIS session again this app
  // session" remains the module-level Set above.
  const [lastDismissedSessionId, setLastDismissedSessionId] = useState<string | null>(null);

  const handleRatingFieldChange = useCallback((key: string, value: string) => {
    setRatingFields((prev) => ({ ...prev, [key]: value }));
    setRatingFormError(null);
  }, []);

  const activePromptSessionId = testimonialPromptQuery.data?.sessionId ?? null;

  const handleSubmitRating = useCallback(() => {
    if (!activePromptSessionId) return;
    const ratingValue = Number(ratingFields.rating);
    if (!ratingValue || ratingValue < 1 || ratingValue > 5) {
      setRatingFormError('Please select a star rating.');
      return;
    }
    setRatingFormError(null);

    submitTestimonialMutation.mutate(
      {
        sessionId: activePromptSessionId,
        payload: {
          rating: ratingValue,
          text: ratingFields.text.trim().length > 0 ? ratingFields.text.trim() : null,
        },
      },
      {
        onSuccess: () => {
          setRatingFields({ rating: '', text: '' });
          setRatingFormError(null);
        },
        onError: (err: unknown) => {
          // Non-blocking inline error — the member can retry or dismiss via
          // "Maybe later"; a transient failure here must never crash the
          // screen or block the rest of the dashboard.
          setRatingFormError(
            err instanceof ApiError && err.message
              ? err.message
              : 'Could not submit your rating. Please try again.',
          );
        },
      },
    );
  }, [activePromptSessionId, ratingFields, submitTestimonialMutation]);

  const handleDismissRatingPrompt = useCallback(() => {
    if (activePromptSessionId) {
      dismissedTestimonialPromptSessionIds.add(activePromptSessionId);
      setLastDismissedSessionId(activePromptSessionId);
    }
    setRatingFields({ rating: '', text: '' });
    setRatingFormError(null);
  }, [activePromptSessionId]);

  const ratingPromptFields: PromptDialogField[] = useMemo(
    () => [
      { key: 'rating', label: 'Your rating', type: 'star' as const },
      {
        key: 'text',
        label: 'Tell us more (optional)',
        placeholder: 'What went well? Anything we could improve?',
        multiline: true,
        maxLength: 120,
      },
    ],
    [],
  );

  const allSessions  = sessionsQuery.data ?? [];
  const profile      = profileQuery.data;
  const roadmap      = roadmapQuery.data ?? [];
  const allRequests  = requestsQuery.data ?? [];

  // CHW-proposed sessions awaiting this member's approval → dashboard widget.
  // See MemberPendingRequestsList's module docstring for the proposedBy
  // filter (excludes legacy null/undefined rows — opposite of the CHW side).
  const pendingRequests = useMemo(
    () => selectMemberPendingRequests(allSessions),
    [allSessions],
  );

  // ── Assigned CHW (Epic G1 fix) ───────────────────────────────────────────
  // Primary source: GET /member/chw, which reads ServiceRequest.matched_chw_id
  // — the SAME relationship column create_chw_member writes. This is
  // authoritative regardless of session history, so a CHW-created member with
  // zero sessions yet still shows as matched.
  //
  // Fallback: the OLD session-derived heuristic (most-recent session with a
  // chwName/chwId), kept only for defensive coverage of an edge case the
  // backend endpoint shouldn't be able to produce (a session exists with CHW
  // info but no matched ServiceRequest links them) — never expected in
  // practice, but cheap insurance against a false "not matched" regression.
  const sessionDerivedCHW = useMemo<{ name: string; chwId: string } | null>(() => {
    const sessionWithCHW = [...allSessions]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .find((s) => !!s.chwName && !!s.chwId);
    if (!sessionWithCHW) return null;
    return { name: sessionWithCHW.chwName!, chwId: sessionWithCHW.chwId };
  }, [allSessions]);

  const assignedCHW = useMemo<{ name: string; chwId: string } | null>(() => {
    if (assignedCHWQuery.data) {
      return { name: assignedCHWQuery.data.name, chwId: assignedCHWQuery.data.id };
    }
    return sessionDerivedCHW;
  }, [assignedCHWQuery.data, sessionDerivedCHW]);

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

  // "Awaiting CHW" — pending-approval sessions + open service requests. See
  // countAwaitingChw for why (keeps this tile in sync with the Appointments page).
  const openRequestsCount = countAwaitingChw(allSessions, allRequests);

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

  // The member's Appointments page is the 'Calendar' route (MemberCalendarScreen,
  // titled "Appointments"). The Upcoming and "Awaiting CHW" tiles both point
  // here — that's where a member's upcoming + pending-approval sessions live.
  const handleOpenAppointments = useCallback(() => {
    navigation.navigate('Calendar');
  }, [navigation]);

  // "Schedule a session" → the Appointments page and auto-open the schedule
  // modal, so the member lands directly in the booking flow (not just the tab).
  const handleScheduleSession = useCallback(() => {
    navigation.navigate('Calendar', { openSchedule: true });
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

  // ── Prompt-stacking rule (Epic B2) ───────────────────────────────────────
  // The G2 password gate ALWAYS wins — a CHW-created member must set their
  // password before anything else, so the rating prompt is only offered
  // once that gate is clear. Also gated on: a prompt session actually being
  // returned by the backend, and that session id not having been dismissed
  // via "Maybe later" earlier in THIS app session (module-level Set, cleared
  // on reload — see its docstring above). These two modals must never
  // render at the same time.
  const showTestimonialPrompt =
    !mustChangePassword &&
    activePromptSessionId !== null &&
    activePromptSessionId !== lastDismissedSessionId &&
    !dismissedTestimonialPromptSessionIds.has(activePromptSessionId);

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
    <>
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

          <MemberPendingRequestsList requests={pendingRequests} />

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
                  onPress={handleScheduleSession}
                  style={({ pressed }) => [
                    styles.heroSecondaryBtn,
                    pressed && { opacity: 0.85 },
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={`Schedule a session with ${assignedCHW.name}`}
                >
                  <CalendarCheck size={16} color={tokens.primary} />
                  <Text style={styles.heroSecondaryBtnText}>Schedule a session</Text>
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
              {/* Temporarily removed 2026-07 (restore for the rewards feature).
                  handleOpenRewards + rewardsBalance are kept for restoration.
              <StatTile
                icon={<Gift color={tokens.emerald700} size={18} />}
                iconBg={tokens.emerald100}
                label="Wellness Points"
                value={rewardsBalance.toLocaleString()}
                delta="Points earned"
                style={styles.statGridTile}
                onPress={handleOpenRewards}
                accessibilityLabel={`Wellness Points: ${rewardsBalance.toLocaleString()}`}
              /> */}
              <StatTile
                icon={<CalendarCheck color={tokens.blue700} size={18} />}
                iconBg={tokens.blue100}
                label="Upcoming"
                value={upcomingSessions.length}
                delta={upcomingSessions.length === 1 ? 'Session' : 'Sessions'}
                deltaColor={tokens.blue700}
                style={styles.statGridTile}
                onPress={handleOpenAppointments}
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
                onPress={handleOpenAppointments}
                accessibilityLabel={`Open requests: ${openRequestsCount}`}
              />
              <StatTile
                icon={<CheckCircle2 color={tokens.emerald700} size={18} />}
                iconBg={tokens.emerald100}
                label="Completed Sessions"
                value={completedSessionsCount}
                delta={completedSessionsCount === 1 ? 'Session all-time' : 'Sessions all-time'}
                deltaColor={tokens.emerald700}
                style={styles.statGridTile}
                accessibilityLabel={`Completed sessions: ${completedSessionsCount}`}
              />
            </StaggerList>
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

    {/* ── Mandatory first-login password change (Epic G2) ─────────────────
     *  Rendered as a sibling (not nested) so it portals above AppShell on
     *  web the same way AppDialogProvider's alerts do. No onCancel — a
     *  CHW-created member cannot dismiss this without changing their
     *  temporary password.
     */}
    <PromptDialog
      visible={mustChangePassword}
      title="Set your password"
      message="For your security, please set a password only you know before continuing."
      fields={passwordPromptFields}
      values={passwordFields}
      onChangeValue={handlePasswordFieldChange}
      onConfirm={handleChangePasswordConfirm}
      confirmLabel="Update password"
      submitting={changePasswordMutation.isPending}
      errorText={passwordFormError}
      testID="first-login-password-prompt"
    />

    {/* ── Post-session star-rating prompt (Epic B2) ────────────────────────
     *  Dismissable (onCancel supplied) — "Maybe later" always closes this
     *  without submitting. Only ever rendered when the G2 password gate is
     *  NOT showing (see `showTestimonialPrompt` above) so the two modals
     *  never stack. Uses the SAME PromptDialog component + POST
     *  /sessions/{id}/testimonials endpoint as the pre-existing
     *  RateChwModal self-serve flow — this is just a second, proactive
     *  entry point into the identical backend contract (source stays
     *  'session', rating stays required).
     */}
    {testimonialPromptQuery.data ? (
      <PromptDialog
        visible={showTestimonialPrompt}
        title={`How was your session with ${testimonialPromptQuery.data.chwName}?`}
        fields={ratingPromptFields}
        values={ratingFields}
        onChangeValue={handleRatingFieldChange}
        onConfirm={handleSubmitRating}
        onCancel={handleDismissRatingPrompt}
        confirmLabel="Submit"
        cancelLabel="Maybe later"
        submitting={submitTestimonialMutation.isPending}
        errorText={ratingFormError}
        testID="testimonial-rating-prompt"
      />
    ) : null}
    </>
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
    // flex:1 → all KPI tiles share the row equally (single evenly-spaced row of
    // 4: Upcoming · Active Goals · Open Requests · Completed Sessions).
    flex: 1,
    minWidth: 0,
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

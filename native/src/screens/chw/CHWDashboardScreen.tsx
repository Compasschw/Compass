/**
 * CHWDashboardScreen — Rewritten to match dashboard.html 1:1 visually,
 * with every visible data point wired to live backend hooks.
 *
 * Layout:
 *   - Full-width page (maxWidth 1280 on web, no artificial 560px cap)
 *   - Page header row: greeting + subtitle + search + "Add New Member" button
 *   - KPI row: 4 tiles (sessions today, overdue follow-ups, messages, earnings)
 *   - Mid row: Today's Schedule (full-width)
 *   - Bottom row: Weekly Snapshot (5/12) + Recent Activity (7/12)
 *
 * Data wiring:
 *   - Sessions today      → useSessions()  filtered to today's date
 *   - Overdue follow-ups  → useRequests()  status='matched' > 48h ago
 *   - Messages awaiting   → useSessions()  heuristic: in_progress count
 *   - Earnings this week  → useChwClaims() sum grossAmount current ISO week
 *   - Today's schedule    → useSessions()  today's scheduled sessions, sorted
 *   - Weekly snapshot     → useSessions()  + useChwClaims() this-week counts
 *   - Recent activity     → useSessions()  + useChwClaims() + useRequests() merged
 *   - Active member count → useChwMembers() total length (best available proxy)
 *
 * Primitives: AppShell (role="chw"), PageHeader, Card, StatTile, Pill.
 * StatTile does not support a coloured badge pill in its top-right slot natively
 * (the `delta` prop renders inline plain text). The mockup pill is reproduced by
 * passing the text through `delta` which StatTile already renders as a pill-shaped
 * chip — this is a perfect match. No primitive was modified.
 */

import React, { useMemo, useCallback, useState, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Platform,
  useWindowDimensions,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import {
  CalendarCheck,
  AlertTriangle,
  Hand,
  MessageSquare,
  DollarSign,
  CheckCircle2,
  ClipboardList,
  Search,
  UserPlus,
  X,
} from 'lucide-react-native';

import { colors as tokens, spacing, radius, numerals } from '../../theme/tokens';
import { useAuth } from '../../context/AuthContext';
import {
  useSessions,
  useRequests,
  useChwEarnings,
  useChwClaims,
  useChwMembers,
  useCHWIntake,
  useChwProfile,
  useTestimonialSummary,
  useChwChecklist,
  useChwDashboardStats,
  type SessionData,
  type ServiceRequestData,
  type ChwClaim,
  type MembersRosterItem,
} from '../../hooks/useApiQueries';
import { useRefreshControl } from '../../hooks/useRefreshControl';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';
import { PressableMember } from '../../components/shared/PressableMember';
import { AddMemberModal } from './AddMemberModal';

import {
  AppShell,
  Card,
  StatTile,
  Pill,
  PressableCard,
  StaggerList,
} from '../../components/ui';

// ─── Avatar palette (deterministic by initials, matches CHWMembersScreen) ────

const AVATAR_PALETTES = [
  { bg: tokens.emerald100, text: tokens.emerald700 },
  { bg: tokens.blue100,    text: tokens.blue700    },
  { bg: tokens.purple100,  text: tokens.purple700  },
  { bg: tokens.amber100,   text: tokens.amber700   },
  { bg: '#fce7f3',         text: '#be185d'         }, // pink
  { bg: '#cffafe',         text: '#0e7490'         }, // cyan
] as const;

/**
 * Returns a deterministic avatar background + text colour from the member name
 * so the same name always gets the same colour across renders.
 */
function avatarPalette(name: string): { bg: string; text: string } {
  const sum = (name ?? '').split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return AVATAR_PALETTES[sum % AVATAR_PALETTES.length]!;
}

/**
 * Returns up to 2 uppercase initials from a display name.
 */
function initials(name: string): string {
  return (name ?? '')
    .split(' ')
    .filter(Boolean)
    .map((n) => n[0] ?? '')
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

// ─── Session mode labels ──────────────────────────────────────────────────────

const MODE_LABELS: Record<string, string> = {
  in_person: 'in person',
  virtual:   'video',
  phone:     'phone',
};

// ─── Date / time helpers ──────────────────────────────────────────────────────

/** ISO date-string start/end of today. */
function todayBounds(): { start: number; end: number } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const end   = start + 86_400_000; // +24 h
  return { start, end };
}

/** Returns the Monday (00:00:00) of the ISO week containing `date`. */
function isoWeekStart(date: Date): number {
  const d    = new Date(date);
  const day  = d.getDay(); // 0 = Sun, 1 = Mon …
  const diff = day === 0 ? -6 : 1 - day; // shift so Monday = 0
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Formats an ISO scheduledAt string into two separate parts suitable for the
 * time-stack column: { time: "10:00", meridiem: "AM" }.
 */
function formatTimeStack(iso: string): { time: string; meridiem: string } {
  const d = new Date(iso);
  const hours   = d.getHours();
  const minutes = d.getMinutes().toString().padStart(2, '0');
  const meridiem = hours < 12 ? 'AM' : 'PM';
  const h12     = hours % 12 === 0 ? 12 : hours % 12;
  return { time: `${h12}:${minutes}`, meridiem };
}

/**
 * Returns a "time remaining" label relative to now.
 * E.g. "In 1h", "3h 30m", "Now", "Overdue".
 */
function timeRemainingLabel(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff < 0) return 'Now';
  const totalMin = Math.round(diff / 60_000);
  if (totalMin < 60) return `In ${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  const mins  = totalMin % 60;
  return mins === 0 ? `${hours}h` : `${hours}h ${mins}m`;
}

/**
 * Returns true when the session starts within the next 30 minutes.
 * The "Start →" button is shown in that window; otherwise "Prep →".
 */
function isStartingSoon(iso: string): boolean {
  const diff = new Date(iso).getTime() - Date.now();
  return diff >= 0 && diff <= 30 * 60_000;
}

/**
 * Returns a relative timestamp string (e.g. "14m ago", "3h ago", "yesterday").
 */
function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins  = Math.round(diff / 60_000);
  if (mins < 60)  return `${mins}m ago`;
  const hours = Math.round(diff / 3_600_000);
  if (hours < 24) return `${hours}h ago`;
  const days  = Math.round(diff / 86_400_000);
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

/**
 * Returns gross earnings in a currency format.
 */
function formatCurrency(amount: number): string {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

// ─── Day-of-week greeting ─────────────────────────────────────────────────────

/**
 * Returns a time-of-day greeting string without an emoji suffix.
 * The Hand icon is rendered separately at the call site for a11y and consistency.
 */
function morningGreeting(firstName: string): string {
  const hour = new Date().getHours();
  if (hour < 12) return `Good morning, ${firstName}`;
  if (hour < 17) return `Good afternoon, ${firstName}`;
  return `Good evening, ${firstName}`;
}

/**
 * Formats today's date as "Sunday, May 10" (locale-neutral long format).
 */
function formatTodayLabel(): string {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month:   'long',
    day:     'numeric',
  });
}

// ─── Activity feed item ───────────────────────────────────────────────────────

interface ActivityItem {
  id:          string;
  type:        'session_completed' | 'claim_paid' | 'request_matched';
  memberName?: string;
  description: string;
  timestamp:   string;
}

/**
 * Merges sessions, claims, and requests into a unified activity feed sorted
 * most-recent-first, capped at 6 items.
 */
function buildActivityFeed(
  sessions:  SessionData[],
  claims:    ChwClaim[],
  requests:  ServiceRequestData[],
): ActivityItem[] {
  const items: ActivityItem[] = [];

  // Completed sessions
  for (const s of sessions) {
    if (s.status === 'completed') {
      items.push({
        id:          `sess-${s.id}`,
        type:        'session_completed',
        memberName:  s.memberName,
        description: 'completed a session',
        timestamp:   s.endedAt ?? s.createdAt,
      });
    }
  }

  // Paid claims
  for (const c of claims) {
    if (c.status === 'paid' && c.paidAt != null) {
      items.push({
        id:          `claim-${c.id}`,
        type:        'claim_paid',
        description: `Payout of ${formatCurrency(c.netPayout)} deposited`,
        timestamp:   c.paidAt,
      });
    }
  }

  // Recently matched requests
  for (const r of requests) {
    if (r.status === 'matched') {
      items.push({
        id:          `req-${r.id}`,
        type:        'request_matched',
        memberName:  r.memberName,
        description: 'was matched to a new request',
        timestamp:   r.createdAt,
      });
    }
  }

  // Sort newest-first, limit to 6
  return items
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 6);
}

// ─── Sub-components ───────────────────────────────────────────────────────────

/** Avatar circle (36×36) with deterministic palette. */
function Avatar({ name }: { name: string }): React.JSX.Element {
  const { bg, text } = avatarPalette(name);
  return (
    <View style={[styles.avatar, { backgroundColor: bg }]}>
      <Text style={[styles.avatarText, { color: text }]}>{initials(name)}</Text>
    </View>
  );
}

/** One row in the Today's Schedule list. */
function ScheduleRow({
  session,
  onPress,
}: {
  session: SessionData;
  onPress: () => void;
}): React.JSX.Element {
  const { time, meridiem } = formatTimeStack(session.scheduledAt);
  const remaining           = timeRemainingLabel(session.scheduledAt);
  const startSoon           = isStartingSoon(session.scheduledAt);
  const name                = session.memberName ?? '—';

  return (
    <PressableCard
      onPress={onPress}
      style={styles.scheduleRow}
      accessibilityLabel={`Session with ${name} at ${time} ${meridiem}`}
    >
      {/* Time stack */}
      <View style={styles.timeStack}>
        <Text style={[styles.timeText, numerals.tabular]}>{time}</Text>
        <Text style={[styles.timeAm, numerals.tabular]}>{meridiem}</Text>
      </View>

      {/* Avatar — taps to MemberProfile (RN's deepest-pressable wins inside the row's TouchableOpacity).
          Epic S: "Back to Dashboard" origin params via PressableMember's
          optional backLabel/backTo (replaces the local DashboardMemberLink
          duplicate — Epic S follow-up). */}
      <PressableMember
        memberId={session.memberId ?? ''}
        displayName={name}
        enabled={!!session.memberId}
        backLabel="Dashboard"
        backTo="DashboardStack"
      >
        <Avatar name={name} />
      </PressableMember>

      {/* Info — only the member name is pressable; subtitle is informational. */}
      <View style={styles.scheduleInfo}>
        <PressableMember
          memberId={session.memberId ?? ''}
          displayName={name}
          enabled={!!session.memberId}
          backLabel="Dashboard"
          backTo="DashboardStack"
        >
          <Text style={styles.scheduleNameText}>{name}</Text>
        </PressableMember>
        <Text style={styles.scheduleMetaText}>
          {session.vertical}
          {session.mode != null ? ` · ${MODE_LABELS[session.mode] ?? session.mode}` : ''}
        </Text>
      </View>

      {/* Time pill */}
      <Pill variant={startSoon ? 'emerald' : 'gray'} size="sm">
        {remaining}
      </Pill>

      {/* Action button */}
      <TouchableOpacity
        style={[styles.scheduleAction, startSoon ? styles.scheduleActionStart : styles.scheduleActionPrep]}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={startSoon ? 'Start session' : 'Prepare for session'}
      >
        <Text style={[styles.scheduleActionText, startSoon ? styles.scheduleActionTextStart : styles.scheduleActionTextPrep]}>
          {startSoon ? 'Start →' : 'Prep →'}
        </Text>
      </TouchableOpacity>
    </PressableCard>
  );
}

/** One row in the Weekly Snapshot 2×2 grid. */
function SnapshotBox({
  label,
  value,
  delta,
  deltaColor,
}: {
  label:       string;
  value:       string;
  delta:       string;
  deltaColor?: string;
}): React.JSX.Element {
  return (
    <View style={styles.snapshotBox}>
      <Text style={styles.snapshotLabel}>{label}</Text>
      <Text style={[styles.snapshotValue, numerals.tabular]}>{value}</Text>
      <Text style={[styles.snapshotDelta, { color: deltaColor ?? tokens.emerald700 }]}>{delta}</Text>
    </View>
  );
}

/** One row in the Recent Activity list. */
function ActivityRow({ item }: { item: ActivityItem }): React.JSX.Element {
  let icon: React.ReactNode;
  switch (item.type) {
    case 'session_completed':
      icon = <CheckCircle2 size={16} color={tokens.emerald700} />;
      break;
    case 'claim_paid':
      icon = <DollarSign size={16} color={tokens.emerald700} />;
      break;
    case 'request_matched':
      icon = <ClipboardList size={16} color={tokens.amber700} />;
      break;
  }

  return (
    <View style={styles.activityRow}>
      <View style={styles.activityIconWrap}>{icon}</View>
      <Text style={styles.activityText} numberOfLines={1}>
        {item.memberName != null && (
          <Text style={styles.activityBold}>{item.memberName} </Text>
        )}
        {item.description}
      </Text>
      <Text style={[styles.activityTime, numerals.tabular]}>{relativeTime(item.timestamp)}</Text>
    </View>
  );
}

// ─── Compliance banner (Epic D) ─────────────────────────────────────────────
//
// Shown when the CHW's compliance checklist (GET /credentials/checklist) is
// incomplete. Dismissible for the current day only — persisted in
// AsyncStorage as an ISO date string; the banner reappears automatically on
// the next calendar day (or next app open on a new day) even if dismissed
// today, so an incomplete CHW is nudged repeatedly rather than only once
// ever. This mirrors the "reappears next day" behavior called out in the
// epic without needing a backend-tracked dismissal state.

const COMPLIANCE_BANNER_DISMISSED_KEY = 'chw_compliance_banner_dismissed_date';

/** Plain-language label for each machine-readable missing-requirement code
 * (mirrors app.services.chw_compliance's code list). */
const MISSING_ITEM_LABELS: Record<string, string> = {
  profile_incomplete: 'Complete your profile (name, phone, ZIP code)',
  bio_missing_or_too_long: 'Add a short bio (120 characters or fewer)',
  hipaa_training: 'Upload your HIPAA training certificate',
  professional_service_agreement: 'Sign and upload your Professional Service Agreement',
  liability_insurance: 'Upload your professional liability insurance',
  chw_certification: 'Upload your CHW certification',
  background_check: 'Your background check is still in review',
};

function missingItemLabel(code: string): string {
  return MISSING_ITEM_LABELS[code] ?? code;
}

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

interface ComplianceBannerProps {
  missing: string[];
  onOpenProfile: () => void;
}

function ComplianceBanner({ missing, onOpenProfile }: ComplianceBannerProps): React.JSX.Element | null {
  const [dismissedToday, setDismissedToday] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void AsyncStorage.getItem(COMPLIANCE_BANNER_DISMISSED_KEY).then((stored) => {
      if (!cancelled) setDismissedToday(stored === todayDateString());
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleDismiss = useCallback(() => {
    setDismissedToday(true);
    void AsyncStorage.setItem(COMPLIANCE_BANNER_DISMISSED_KEY, todayDateString());
  }, []);

  if (missing.length === 0 || dismissedToday) return null;

  return (
    <View style={styles.complianceBanner} accessibilityRole="alert">
      <View style={styles.complianceBannerIconWrap}>
        <AlertTriangle size={18} color={tokens.amber700} />
      </View>
      <View style={styles.complianceBannerBody}>
        <Text style={styles.complianceBannerTitle}>Finish your compliance checklist</Text>
        <Text style={styles.complianceBannerText}>
          {missing.map(missingItemLabel).join(' · ')}
        </Text>
        <TouchableOpacity
          onPress={onOpenProfile}
          accessibilityRole="button"
          accessibilityLabel="Go to compliance checklist"
        >
          <Text style={styles.complianceBannerLink}>Go to Profile</Text>
        </TouchableOpacity>
      </View>
      <TouchableOpacity
        onPress={handleDismiss}
        accessibilityRole="button"
        accessibilityLabel="Dismiss compliance reminder for today"
        style={styles.complianceBannerDismiss}
      >
        <X size={16} color={tokens.textSecondary} />
      </TouchableOpacity>
    </View>
  );
}

// ─── New-member alert (QA batch #12) ────────────────────────────────────────
//
// One card per roster member whose account was created within the last 48h,
// derived entirely client-side from useChwMembers() — no new backend field.
// Each is independently dismissible; dismissal is keyed by member id and
// persisted in AsyncStorage so it survives app restarts but a DIFFERENT new
// member still gets its own alert. Unlike the compliance banner (which
// reappears daily on purpose), a dismissed new-member alert stays dismissed
// — the "new" signal is inherently one-time, not a recurring nudge.

const NEW_MEMBER_ALERT_WINDOW_MS = 48 * 60 * 60 * 1000; // 48 hours
const NEW_MEMBER_ALERT_DISMISSED_KEY_PREFIX = 'chw_new_member_alert_dismissed_';

/** Roster members created within the last 48h, newest first. */
function selectRecentlyCreatedMembers(
  members: MembersRosterItem[] | undefined,
  now: Date,
): MembersRosterItem[] {
  if (!members || members.length === 0) return [];
  const cutoff = now.getTime() - NEW_MEMBER_ALERT_WINDOW_MS;
  return members
    .filter((m) => {
      const createdMs = new Date(m.createdAt).getTime();
      return Number.isFinite(createdMs) && createdMs >= cutoff;
    })
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

interface NewMemberAlertProps {
  member: MembersRosterItem;
  onOpenMember: (memberId: string) => void;
  onDismiss: (memberId: string) => void;
}

function NewMemberAlert({ member, onOpenMember, onDismiss }: NewMemberAlertProps): React.JSX.Element {
  return (
    <View style={styles.newMemberAlert} accessibilityRole="alert">
      <View style={styles.newMemberAlertIconWrap}>
        <UserPlus size={18} color={tokens.blue700} />
      </View>
      <View style={styles.complianceBannerBody}>
        <Text style={styles.newMemberAlertTitle}>New member account created</Text>
        <Text style={styles.newMemberAlertText}>{member.displayName}</Text>
        <TouchableOpacity
          onPress={() => onOpenMember(member.id)}
          accessibilityRole="button"
          accessibilityLabel={`View ${member.displayName}'s profile`}
        >
          <Text style={styles.newMemberAlertLink}>View member</Text>
        </TouchableOpacity>
      </View>
      <TouchableOpacity
        onPress={() => onDismiss(member.id)}
        accessibilityRole="button"
        accessibilityLabel={`Dismiss new member alert for ${member.displayName}`}
        style={styles.complianceBannerDismiss}
      >
        <X size={16} color={tokens.textSecondary} />
      </TouchableOpacity>
    </View>
  );
}

// ─── Pending session-requests banner (QA-batch #24) ──────────────────────────
//
// Amber alert surfacing member-proposed pending session requests directly on
// the Dashboard — previously only visible/actionable on the Appointments tab.
// Reuses the compliance-banner amber styling convention for visual
// consistency. No dismiss control (unlike ComplianceBanner/NewMemberAlert):
// the count is live and actionable, and hides itself entirely at 0.

interface PendingSessionRequestsBannerProps {
  count: number;
  onReview: () => void;
}

function PendingSessionRequestsBanner({
  count,
  onReview,
}: PendingSessionRequestsBannerProps): React.JSX.Element | null {
  if (count <= 0) return null;

  return (
    <View style={styles.complianceBanner} accessibilityRole="alert">
      <View style={styles.complianceBannerIconWrap}>
        <CalendarCheck size={18} color={tokens.amber700} />
      </View>
      <View style={styles.complianceBannerBody}>
        <Text style={styles.complianceBannerTitle}>
          {count} session request{count === 1 ? '' : 's'} from members awaiting your confirmation
        </Text>
        <TouchableOpacity
          onPress={onReview}
          accessibilityRole="button"
          accessibilityLabel="Review pending session requests"
        >
          <Text style={styles.complianceBannerLink}>Review</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── AlertsSection ───────────────────────────────────────────────────────────
//
// Stacks all dashboard alert cards vertically with a consistent gap — no
// overlap, arbitrary count. Currently: the compliance banner (re-parented,
// same dismiss/reappear behavior as before) + one NewMemberAlert per
// recently-created roster member. Renders nothing (no wrapper element) when
// there is nothing to show, so it never affects layout when empty.

interface AlertsSectionProps {
  missing: string[];
  onOpenProfile: () => void;
  recentMembers: MembersRosterItem[];
  onOpenMember: (memberId: string) => void;
}

function AlertsSection({
  missing,
  onOpenProfile,
  recentMembers,
  onOpenMember,
}: AlertsSectionProps): React.JSX.Element | null {
  const [dismissedMemberIds, setDismissedMemberIds] = useState<Set<string> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        recentMembers.map(async (m) => {
          const stored = await AsyncStorage.getItem(
            `${NEW_MEMBER_ALERT_DISMISSED_KEY_PREFIX}${m.id}`,
          );
          return [m.id, stored === '1'] as const;
        }),
      );
      if (cancelled) return;
      setDismissedMemberIds(new Set(entries.filter(([, dismissed]) => dismissed).map(([id]) => id)));
      // recentMembers is derived fresh each render from live query data —
      // re-keying on its member ids (not the array reference) avoids
      // re-fetching AsyncStorage on every unrelated re-render.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    })();
    return () => {
      cancelled = true;
    };
  }, [recentMembers.map((m) => m.id).join(',')]);

  const handleDismissMember = useCallback((memberId: string) => {
    setDismissedMemberIds((prev) => {
      const next = new Set(prev ?? []);
      next.add(memberId);
      return next;
    });
    void AsyncStorage.setItem(`${NEW_MEMBER_ALERT_DISMISSED_KEY_PREFIX}${memberId}`, '1');
  }, []);

  const visibleNewMemberAlerts = recentMembers.filter(
    (m) => !(dismissedMemberIds?.has(m.id) ?? false),
  );

  if (missing.length === 0 && visibleNewMemberAlerts.length === 0) return null;

  return (
    <View style={styles.alertsSection}>
      <ComplianceBanner missing={missing} onOpenProfile={onOpenProfile} />
      {visibleNewMemberAlerts.map((member) => (
        <NewMemberAlert
          key={member.id}
          member={member}
          onOpenMember={onOpenMember}
          onDismiss={handleDismissMember}
        />
      ))}
    </View>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function CHWDashboardScreen(): React.JSX.Element {
  const { userName } = useAuth();
  const { width: windowWidth } = useWindowDimensions();
  // Stack the two bottom panels vertically when the window is narrow/split.
  const stackBottom = Platform.OS === 'web' && windowWidth < 1024;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const navigation = useNavigation<any>();

  // Controls the "Add New Member" onboarding dialog opened from the header.
  const [addMemberOpen, setAddMemberOpen] = useState(false);

  const firstName  = userName?.split(' ')[0] ?? 'there';
  const greeting   = morningGreeting(firstName);
  const todayLabel = formatTodayLabel();

  const userInitials = useMemo(() => {
    if (!userName) return 'CW';
    return userName.split(' ').map((n) => n[0] ?? '').join('').toUpperCase().slice(0, 2);
  }, [userName]);

  // ── Data hooks ───────────────────────────────────────────────────────────────
  const sessionsQuery = useSessions();
  const requestsQuery = useRequests();
  const earningsQuery = useChwEarnings();
  const claimsQuery   = useChwClaims();
  const membersQuery  = useChwMembers();
  // intake banner — keep so the incomplete-intake nudge still renders
  const intakeQuery   = useCHWIntake();
  // Own CHW profile — needed to resolve the userId for the rating-summary
  // lookup below (the testimonials endpoint is keyed by CHW user UUID).
  const chwProfileQuery = useChwProfile();
  // Real "member satisfaction" — avg + count of this CHW's APPROVED
  // Testimonial rows. Replaces the previous hardcoded "4.9" SnapshotBox.
  const testimonialSummaryQuery = useTestimonialSummary(chwProfileQuery.data?.userId ?? '');
  // Compliance checklist (Epic D) — drives the "Finish your compliance
  // checklist" banner below the greeting row.
  const checklistQuery = useChwChecklist();
  // QA-batch #15/#24/#25: the single accurate source for the "Completed
  // Sessions" tile, the member-request alert banner, and the (AppShell-
  // rendered) Appointments sidebar badge.
  const dashboardStatsQuery = useChwDashboardStats();

  // QA batch #2 (Wave-2 B1): Add New Member is disabled only when the
  // backend gate is actually live (`gateEnabled`) AND this CHW currently
  // fails the checklist (`canWork === false`). When the flag is off, or the
  // CHW is compliant, behavior is unchanged — matches the backend's
  // identical flag-conditional 403 on POST /chw/members.
  const isAddMemberGated =
    checklistQuery.data?.gateEnabled === true && checklistQuery.data?.canWork === false;

  // QA batch #12: roster members created within the last 48h — drives one
  // dismissible NewMemberAlert per member in the AlertsSection below.
  const recentlyCreatedMembers = useMemo(
    () => selectRecentlyCreatedMembers(membersQuery.data, new Date()),
    [membersQuery.data],
  );

  const handleOpenMemberFromAlert = useCallback(
    (memberId: string) => {
      (navigation as { navigate: (screen: string, params?: unknown) => void }).navigate(
        'SessionsStack',
        {
          screen: 'MemberProfile',
          params: { memberId, backLabel: 'Dashboard', backTo: 'DashboardStack' },
        },
      );
    },
    [navigation],
  );

  const isLoading =
    sessionsQuery.isLoading ||
    requestsQuery.isLoading ||
    earningsQuery.isLoading;

  const queryError =
    sessionsQuery.error ?? requestsQuery.error ?? earningsQuery.error;

  const handleRetry = useCallback(() => {
    void sessionsQuery.refetch();
    void requestsQuery.refetch();
    void earningsQuery.refetch();
    void claimsQuery.refetch();
    void membersQuery.refetch();
    void chwProfileQuery.refetch();
    void testimonialSummaryQuery.refetch();
    void dashboardStatsQuery.refetch();
  }, [
    sessionsQuery,
    requestsQuery,
    earningsQuery,
    claimsQuery,
    membersQuery,
    chwProfileQuery,
    testimonialSummaryQuery,
    dashboardStatsQuery,
  ]);

  const refresh = useRefreshControl([
    sessionsQuery.refetch,
    requestsQuery.refetch,
    earningsQuery.refetch,
    claimsQuery.refetch,
    membersQuery.refetch,
    intakeQuery.refetch,
    chwProfileQuery.refetch,
    testimonialSummaryQuery.refetch,
    dashboardStatsQuery.refetch,
  ]);

  const allSessions  = sessionsQuery.data  ?? [];
  const allRequests  = requestsQuery.data  ?? [];
  const allClaims    = claimsQuery.data    ?? [];
  const earnings     = earningsQuery.data;
  const memberCount  = membersQuery.data?.length ?? 0;

  // ── KPI derivations ──────────────────────────────────────────────────────────

  const { start: dayStart, end: dayEnd } = todayBounds();

  /** Sessions today: any status, scheduled within today's date window. */
  const todaySessions = useMemo<SessionData[]>(() => {
    return allSessions
      .filter((s) => {
        const t = new Date(s.scheduledAt).getTime();
        return t >= dayStart && t < dayEnd;
      })
      .sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());
  }, [allSessions, dayStart, dayEnd]);

  const sessionsTodayCount = todaySessions.length;

  /**
   * QA-batch #15: "Completed Sessions" tile values — all-time count of
   * sessions with status === 'completed' (documentation submitted), plus
   * today's slice for the "+N today" pill. Sourced from GET
   * /chw/dashboard/stats (not derived from `allSessions`, which is capped at
   * 50 rows by default and would silently under-count for an active CHW).
   */
  const completedSessionsTotal = dashboardStatsQuery.data?.completedSessionsTotal ?? 0;
  const completedSessionsToday = dashboardStatsQuery.data?.completedSessionsToday ?? 0;

  /**
   * QA-batch #24/#25: member-proposed pending session requests awaiting this
   * CHW's confirm/decline — drives the Dashboard alert banner and (via
   * AppShell) the Appointments sidebar badge.
   */
  const pendingMemberRequests = dashboardStatsQuery.data?.pendingMemberRequests ?? 0;

  /**
   * Overdue follow-ups: matched requests older than 48h.
   * TODO: wire when /chw/dashboard/stats ships with an explicit overdue count.
   */
  const overdueFollowupsCount = useMemo<number>(() => {
    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
    return allRequests.filter(
      (r) => r.status === 'matched' && new Date(r.createdAt).getTime() < cutoff,
    ).length;
  }, [allRequests]);

  /**
   * Messages awaiting reply: sessions currently in_progress.
   * These are the best available proxy for "unread" until a dedicated
   * unread-count endpoint ships.
   * TODO: wire when /chw/messages/unread ships.
   */
  const messagesAwaitingCount = useMemo<number>(() => {
    return allSessions.filter((s) => s.status === 'in_progress').length;
  }, [allSessions]);

  // ── Today's schedule ─────────────────────────────────────────────────────────

  /** Today's scheduled (not yet started/completed) sessions, ascending. */
  const scheduleRows = useMemo<SessionData[]>(() => {
    return todaySessions.filter((s) => s.status === 'scheduled');
  }, [todaySessions]);

  // ── Weekly snapshot ──────────────────────────────────────────────────────────

  const weekStart = useMemo(() => isoWeekStart(new Date()), []);

  /** Sessions completed this ISO week. */
  const sessionsCompletedThisWeek = useMemo<number>(() => {
    return allSessions.filter(
      (s) => s.status === 'completed' && new Date(s.endedAt ?? s.scheduledAt).getTime() >= weekStart,
    ).length;
  }, [allSessions, weekStart]);

  /**
   * Total units billed this week (from claims).
   * Falls back to earnings.sessionsThisWeek when claims are unavailable.
   */
  const unitsBilledThisWeek = useMemo<number>(() => {
    const fromClaims = allClaims
      .filter((c) => {
        const d = c.serviceDate ?? c.createdAt;
        return d != null && new Date(d).getTime() >= weekStart;
      })
      .reduce((sum, c) => sum + (c.units ?? 0), 0);
    return fromClaims > 0 ? fromClaims : 0;
  }, [allClaims, weekStart]);

  /**
   * Real member satisfaction — avg + count of ALL this CHW's member
   * post-session ratings (GET /chws/{chw_id}/testimonials/summary,
   * all_ratings_avg / all_ratings_count — QA-batch #16). Deliberately NOT
   * approval-gated: this is the CHW's own private Dashboard, so a rating a
   * member just submitted shows up immediately rather than waiting on admin
   * moderation (which only gates PUBLIC display of testimonial text). Never
   * fabricated: the SnapshotBox below falls back to an explicit "No ratings
   * yet" state when allRatingsCount is 0.
   */
  const memberSatisfactionRatingAvg = testimonialSummaryQuery.data?.allRatingsAvg ?? null;
  const memberSatisfactionRatingCount = testimonialSummaryQuery.data?.allRatingsCount ?? 0;
  const hasMemberSatisfactionRatings =
    memberSatisfactionRatingCount > 0 && memberSatisfactionRatingAvg != null;

  // ── Recent activity ──────────────────────────────────────────────────────────

  const activityFeed = useMemo<ActivityItem[]>(
    () => buildActivityFeed(allSessions, allClaims, allRequests),
    [allSessions, allClaims, allRequests],
  );

  // ── Loading / error guards ───────────────────────────────────────────────────

  if (isLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.contentNative}>
          <View style={styles.pageWrapNative}>
            <LoadingSkeleton variant="stat-grid" />
            <LoadingSkeleton variant="rows" rows={3} />
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (queryError) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <ErrorState message="Failed to load dashboard" onRetry={handleRetry} />
      </SafeAreaView>
    );
  }

  // ── Subtitle for page header ─────────────────────────────────────────────────

  const headerSubtitle = [
    todayLabel,
    memberCount > 0 ? `${memberCount} active members` : null,
    sessionsTodayCount > 0 ? `${sessionsTodayCount} sessions today` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  // ── Screen content ───────────────────────────────────────────────────────────

  const screenContent = (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={Platform.OS === 'web' ? styles.contentWeb : styles.contentNative}
      showsVerticalScrollIndicator={false}
      refreshControl={refresh.control}
    >
      <View style={Platform.OS === 'web' ? styles.pageWrapWeb : styles.pageWrapNative}>

        {/* ── Page header ─────────────────────────────────────────────────── */}
        {/* Greeting row: title + Hand icon inline, followed by the existing
            right-slot controls (search + Add Member button).               */}
        <View style={styles.greetingRow}>
          <View style={styles.greetingTitleBlock}>
            <View style={styles.greetingTitleInner}>
              <Text style={styles.greetingTitle} accessibilityRole="header">
                {greeting}
              </Text>
              <Hand
                size={22}
                color={tokens.primary}
                strokeWidth={2}
                accessibilityLabel="greeting wave"
              />
            </View>
            {headerSubtitle.length > 0 && (
              <Text style={styles.greetingSubtitle}>{headerSubtitle}</Text>
            )}
          </View>

          <View style={styles.headerRight}>
            {/* Search input — web-only visual */}
            {Platform.OS === 'web' && (
              <View style={styles.searchWrap}>
                <Search size={14} color={tokens.textSecondary} style={styles.searchIcon} />
                <TextInput
                  style={styles.searchInput}
                  placeholder="Search members"
                  placeholderTextColor={tokens.textSecondary}
                  accessibilityLabel="Search"
                />
              </View>
            )}

            {/* Add New Member */}
            <PressableCard
              onPress={() => setAddMemberOpen(true)}
              disabled={isAddMemberGated}
              style={[styles.newSessionBtn, isAddMemberGated && styles.newSessionBtnDisabled]}
              accessibilityLabel={
                isAddMemberGated
                  ? 'Add a new member (disabled until your compliance checklist is complete)'
                  : 'Add a new member'
              }
            >
              <UserPlus size={14} color="#fff" />
              <Text style={styles.newSessionText}>Add New Member</Text>
            </PressableCard>
          </View>
        </View>

        {/* ── Alerts (QA batch #12): compliance banner + new-member alerts ── */}
        {checklistQuery.data != null && (
          <AlertsSection
            missing={checklistQuery.data.missing}
            onOpenProfile={() => navigation.navigate('Profile' as never)}
            recentMembers={recentlyCreatedMembers}
            onOpenMember={handleOpenMemberFromAlert}
          />
        )}

        {/* ── Pending session-requests banner (QA batch #24) ─────────────── */}
        <PendingSessionRequestsBanner
          count={pendingMemberRequests}
          onReview={() => navigation.navigate('Calendar' as never)}
        />

        {/* ── KPI row — 4 tiles ───────────────────────────────────────────── */}
        {/* StaggerList cascades the 4 stat tiles in on initial mount. */}
        <View style={styles.kpiRow}>
          <StaggerList delayMs={50} durationMs={240}>
            {/* 1. Completed Sessions — QA-batch #15: all-time count of
                documented+submitted sessions, not "any status scheduled
                today". The "+N today" pill still surfaces today's slice. */}
            <StatTile
              icon={<CalendarCheck size={18} color={tokens.emerald700} />}
              iconBg={tokens.emerald100}
              label="Completed Sessions"
              value={completedSessionsTotal}
              delta={completedSessionsToday > 0 ? `+${completedSessionsToday} today` : 'none today'}
              deltaColor={tokens.emerald700}
              deltaBg="#ecfdf5"
              style={styles.kpiTile}
              onPress={() => navigation.navigate('Calendar' as never)}
            />

            {/* 2. Overdue follow-ups */}
            <StatTile
              icon={<AlertTriangle size={18} color={tokens.amber700} />}
              iconBg={tokens.amber100}
              label="Overdue follow-ups"
              value={overdueFollowupsCount}
              delta="action needed"
              deltaColor={tokens.amber700}
              deltaBg="#fffbeb"
              style={styles.kpiTile}
              // Overdue follow-ups → the current Members page (CHWMembersScreen).
              // 'Requests' is the superseded "old Members" screen (CHWRequestsScreen).
              onPress={() => navigation.navigate('CHWMembers' as never)}
            />

            {/* 3. Messages awaiting reply
                Heuristic: in_progress session count.
                TODO: wire to /chw/messages/unread when that endpoint ships. */}
            <StatTile
              icon={<MessageSquare size={18} color={tokens.blue700} />}
              iconBg={tokens.blue100}
              label="Messages awaiting reply"
              value={messagesAwaitingCount}
              delta={messagesAwaitingCount > 0 ? `${messagesAwaitingCount} unread` : 'no unread'}
              deltaColor={tokens.blue700}
              deltaBg="#eff6ff"
              style={styles.kpiTile}
              onPress={() => navigation.navigate('SessionsStack' as never, { screen: 'Messages' } as never)}
            />

            {/* 4. Earnings — QA-batch #14: real, server-computed all-time
                gross earnings (GET /chw/earnings.total_earned_all_time), not
                a client-side weekly sum with a silent this_month fallback. */}
            <StatTile
              icon={<DollarSign size={18} color={tokens.purple700} />}
              iconBg={tokens.purple100}
              label="Earnings"
              value={formatCurrency(earnings?.totalEarnedAllTime ?? 0)}
              delta={earnings?.pendingPayout != null && earnings.pendingPayout > 0
                ? `${formatCurrency(earnings.pendingPayout)} pending`
                : undefined}
              deltaColor={tokens.emerald700}
              deltaBg="#ecfdf5"
              style={styles.kpiTile}
              onPress={() => navigation.navigate('EarningsStack' as never)}
            />
          </StaggerList>
        </View>

        {/* ── Mid row: Today's Schedule (full-width) ──────────────────────── */}
        <View style={styles.midRow}>

          {/* Today's Schedule — spans the full row */}
          <Card style={[styles.midFull, styles.card]}>
            <View style={styles.cardHeaderRow}>
              <Text style={styles.cardTitle}>Today's Schedule</Text>
              <TouchableOpacity
                onPress={() => navigation.navigate('Calendar' as never)}
                accessibilityRole="link"
                accessibilityLabel="View all sessions"
              >
                <Text style={styles.viewAllLink}>View all →</Text>
              </TouchableOpacity>
            </View>

            {scheduleRows.length === 0 ? (
              <Text style={styles.emptyText}>No sessions scheduled today.</Text>
            ) : (
              <View style={styles.scheduleList}>
                {scheduleRows.map((session) => (
                  <ScheduleRow
                    key={session.id}
                    session={session}
                    onPress={() =>
                      // Route to the member's Messages thread so the CHW can
                      // prep (Care Status, Session Focus, journey rail) and
                      // start the session there when the scheduled time hits.
                      // No autoCall — prepping shouldn't auto-dial the member.
                      navigation.navigate('SessionsStack', {
                        screen: 'Messages',
                        params: { memberId: session.memberId },
                      } as never)
                    }
                  />
                ))}
              </View>
            )}
          </Card>
        </View>

        {/* ── Bottom row: Weekly Snapshot (5/12) + Recent Activity (7/12) ── */}
        <View style={[styles.bottomRow, stackBottom && styles.bottomRowStacked]}>

          {/* Weekly Snapshot */}
          <Card style={[styles.bottomLeft, styles.card, stackBottom && styles.panelStacked]}>
            <Text style={[styles.cardTitle, { marginBottom: spacing.md }]}>Weekly snapshot</Text>
            <View style={styles.snapshotGrid}>
              <SnapshotBox
                label="Sessions completed"
                value={String(sessionsCompletedThisWeek)}
                delta={`+${sessionsCompletedThisWeek} vs last week`}
              />
              <SnapshotBox
                label="Units billed"
                value={unitsBilledThisWeek > 0 ? String(unitsBilledThisWeek) : '—'}
                delta={unitsBilledThisWeek > 0 ? 'this week' : 'no data yet'}
              />
              {/* Avg response time — no endpoint available yet.
                  TODO: wire when /chw/stats/avg_response ships. */}
              <SnapshotBox
                label="Avg response time"
                value="—"
                delta="v2 feature"
                deltaColor={tokens.textSecondary}
              />
              {/* Member satisfaction — real avg + count of ALL post-session
                  ratings for this CHW (QA-batch #16: not approval-gated —
                  this is the CHW's own private view). Never a fabricated
                  number: shows "No ratings yet" until the CHW has at least
                  one rating. */}
              <SnapshotBox
                label="Member satisfaction"
                value={hasMemberSatisfactionRatings ? memberSatisfactionRatingAvg!.toFixed(1) : '—'}
                delta={
                  hasMemberSatisfactionRatings
                    ? `${memberSatisfactionRatingCount} review${memberSatisfactionRatingCount === 1 ? '' : 's'}`
                    : 'No ratings yet'
                }
                deltaColor={hasMemberSatisfactionRatings ? undefined : tokens.textSecondary}
              />
            </View>
          </Card>

          {/* Recent Activity */}
          <Card style={[styles.bottomRight, styles.card, stackBottom && styles.panelStacked]}>
            <View style={styles.cardHeaderRow}>
              <Text style={styles.cardTitle}>Recent activity</Text>
              <TouchableOpacity
                onPress={() => navigation.navigate('SessionsStack' as never, { screen: 'Messages' } as never)}
                accessibilityRole="link"
                accessibilityLabel="Open full activity feed"
              >
                <Text style={styles.viewAllLink}>Open feed →</Text>
              </TouchableOpacity>
            </View>

            {activityFeed.length === 0 ? (
              <Text style={styles.emptyText}>No recent activity.</Text>
            ) : (
              <View>
                {activityFeed.map((item) => (
                  <ActivityRow key={item.id} item={item} />
                ))}
              </View>
            )}
          </Card>
        </View>

      </View>
    </ScrollView>
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <AppShell
        role="chw"
        activeKey="dashboard"
        userBlock={{ initials: userInitials, name: userName ?? 'CHW', role: 'CHW' }}
      >
        {screenContent}
      </AppShell>
      <AddMemberModal
        visible={addMemberOpen}
        onClose={() => setAddMemberOpen(false)}
      />
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: tokens.pageBg,
  } as ViewStyle,

  scroll: {
    flex: 1,
  } as ViewStyle,

  // Native scroll content — centred, standard padding
  contentNative: {
    flexGrow: 1,
    alignItems: 'center',
  } as ViewStyle,

  // Web scroll content — full-width, no cap
  contentWeb: {
    flexGrow: 1,
  } as ViewStyle,

  // Native page wrap
  pageWrapNative: {
    width: '100%',
    padding: spacing.xl,
    paddingBottom: 48,
  } as ViewStyle,

  // Web page wrap — fills the entire main content area (no max-width cap).
  // The mock visually fills its viewport because that viewport is the
  // dashboard's natural size; on a 2400+ px display the cap was leaving a
  // dead band on the right. Removing maxWidth makes the dashboard expand
  // edge-to-edge inside AppShell, matching what the user sees in the mock.
  //
  // paddingTop is intentionally omitted: AppShell's mainContent already
  // provides 32px of top padding. Adding it here doubled the gap above the
  // greeting title vs. other screens (Members etc.) that don't own a nested
  // ScrollView. Horizontal padding and paddingBottom are kept as-is.
  pageWrapWeb: {
    width: '100%',
    alignSelf: 'stretch',
    paddingHorizontal: spacing.xxxl,
    paddingBottom: 48,
  } as ViewStyle,

  // ── Greeting row (replaces PageHeader for the greeting + Hand icon) ─────────
  greetingRow: {
    flexDirection:  'row',
    alignItems:     'center',
    justifyContent: 'space-between',
    marginBottom:   spacing.xxl,
    gap:            spacing.md,
  } as ViewStyle,

  greetingTitleBlock: {
    flex: 1,
    gap:  4,
  } as ViewStyle,

  greetingTitleInner: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           8,
  } as ViewStyle,

  greetingTitle: {
    fontSize:   24,
    fontWeight: '700',
    color:      '#111827',
    lineHeight: 30,
  } as TextStyle,

  greetingSubtitle: {
    fontSize:   14,
    fontWeight: '400',
    color:      '#6b7280',
    lineHeight: 20,
    marginTop:  4,
  } as TextStyle,

  // ── Header right slot ──────────────────────────────────────────────────────
  headerRight: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           spacing.md,
  } as ViewStyle,

  searchWrap: {
    flexDirection:   'row',
    alignItems:      'center',
    gap:             8,
    backgroundColor: '#fff',
    borderWidth:     1,
    borderColor:     '#e5e7eb',
    borderRadius:    radius.lg,
    paddingHorizontal: 12,
    paddingVertical: 8,
    width:           288,
  } as ViewStyle,

  // The Search icon sits to the left of the input text; on web React Native
  // doesn't support css `position: absolute` reliably inside a TextInput, so
  // we put the icon as a flex sibling instead.
  searchIcon: {} as ViewStyle,

  searchInput: {
    flex:            1,
    fontSize:        14,
    color:           tokens.textPrimary,
    // Remove default outline on web
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  } as TextStyle,

  newSessionBtn: {
    flexDirection:   'row',
    alignItems:      'center',
    gap:             6,
    backgroundColor: '#16a34a', // emerald-600 — overrides PressableCard white default
    borderRadius:    radius.lg,
    borderWidth:     0,
    paddingHorizontal: spacing.lg,
    paddingVertical:   spacing.sm + 2,
  } as ViewStyle,

  // QA batch #2: Add New Member button when the compliance work gate is
  // live and this CHW currently fails the checklist. PressableCard's own
  // `disabled` styling (opacity 0.5) already applies on top of this, so
  // this just prevents any further hover/press affordance from reading as
  // interactive.
  newSessionBtnDisabled: {
    backgroundColor: '#9CA3AF', // gray-400 — de-emphasized vs. the emerald active state
  } as ViewStyle,

  newSessionText: {
    fontSize:   14,
    fontWeight: '600',
    color:      '#fff',
  } as TextStyle,

  // ── Compliance banner (Epic D) ────────────────────────────────────────────
  // QA batch #12: alerts are now stacked by the AlertsSection wrapper below,
  // which owns the bottom margin for the whole stack — individual alert
  // cards (this one + newMemberAlert) no longer set their own marginBottom
  // to avoid a double gap.
  alertsSection: {
    gap:          spacing.md,
    marginBottom: spacing.xxl,
  } as ViewStyle,

  complianceBanner: {
    flexDirection:     'row',
    alignItems:        'flex-start',
    gap:               spacing.md,
    backgroundColor:   '#FFFBEB',
    borderWidth:       1,
    borderColor:       '#FDE68A',
    borderRadius:      radius.lg,
    padding:           spacing.md,
  } as ViewStyle,
  complianceBannerIconWrap: {
    marginTop: 2,
  } as ViewStyle,
  complianceBannerBody: {
    flex: 1,
    gap:  4,
  } as ViewStyle,
  complianceBannerTitle: {
    fontSize:   14,
    fontWeight: '700',
    color:      '#92400E',
  } as TextStyle,
  complianceBannerText: {
    fontSize:   12,
    color:      '#92400E',
    lineHeight: 17,
  } as TextStyle,
  complianceBannerLink: {
    fontSize:   12,
    fontWeight: '700',
    color:      '#B45309',
    marginTop:  2,
  } as TextStyle,
  complianceBannerDismiss: {
    padding: 4,
  } as ViewStyle,

  // ── New-member alert (QA batch #12) ───────────────────────────────────────
  newMemberAlert: {
    flexDirection:   'row',
    alignItems:      'flex-start',
    gap:             spacing.md,
    backgroundColor: tokens.blue100,
    borderWidth:     1,
    borderColor:     '#BFDBFE',
    borderRadius:    radius.lg,
    padding:         spacing.md,
  } as ViewStyle,
  newMemberAlertIconWrap: {
    marginTop: 2,
  } as ViewStyle,
  newMemberAlertTitle: {
    fontSize:   14,
    fontWeight: '700',
    color:      tokens.blue700,
  } as TextStyle,
  newMemberAlertText: {
    fontSize:   12,
    color:      tokens.blue700,
    lineHeight: 17,
  } as TextStyle,
  newMemberAlertLink: {
    fontSize:   12,
    fontWeight: '700',
    color:      tokens.blue700,
    marginTop:  2,
  } as TextStyle,

  // ── KPI row ────────────────────────────────────────────────────────────────
  kpiRow: {
    flexDirection: 'row',
    flexWrap:      'wrap',
    gap:           spacing.lg,
    marginBottom:  spacing.xxl,
  } as ViewStyle,

  kpiTile: {
    // Force 2 tiles per row instead of 4 — minWidth at 48% means after the
    // first two fit (48 + 48 + gap), the next two wrap onto a second row.
    // Each tile ends up roughly twice as wide as the old 4-up layout.
    minWidth:  '48%' as unknown as number,
    flexBasis: '48%' as unknown as number,
    flexGrow:  1,
  } as ViewStyle,

  // ── Mid row (schedule — full width) ───────────────────────────────────────
  midRow: {
    flexDirection: 'row',
    gap:           spacing.xxl,
    marginBottom:  spacing.xxl,
  } as ViewStyle,

  midFull: {
    // Single card that spans the entire row
    flex: 1,
  } as ViewStyle,

  // ── Bottom row (snapshot + activity) ─────────────────────────────────────
  bottomRow: {
    flexDirection: Platform.OS === 'web' ? 'row' : 'column',
    gap:           spacing.xxl,
  } as ViewStyle,

  bottomLeft: {
    // col-span-5 out of 12
    flex: Platform.OS === 'web' ? 5 : undefined,
  } as ViewStyle,

  bottomRight: {
    // col-span-7 out of 12
    flex: Platform.OS === 'web' ? 7 : undefined,
  } as ViewStyle,

  // Narrow/split web: stack the two panels full-width instead of side by side.
  bottomRowStacked: {
    flexDirection: 'column',
  } as ViewStyle,
  panelStacked: {
    flexGrow: 0,
    flexBasis: 'auto',
    width: '100%',
  } as ViewStyle,

  // ── Shared card padding ────────────────────────────────────────────────────
  card: {
    padding: spacing.xl,
  } as ViewStyle,

  // ── Card header row (title + link on same line) ────────────────────────────
  cardHeaderRow: {
    flexDirection:  'row',
    alignItems:     'center',
    justifyContent: 'space-between',
    marginBottom:   spacing.lg,
  } as ViewStyle,

  cardTitle: {
    fontSize:   16,
    fontWeight: '600',
    color:      '#111827',
  } as TextStyle,

  viewAllLink: {
    fontSize:   13,
    fontWeight: '600',
    color:      '#16a34a',
  } as TextStyle,

  // ── Today's Schedule ───────────────────────────────────────────────────────
  scheduleList: {
    gap: 2,
  } as ViewStyle,

  scheduleRow: {
    flexDirection:  'row',
    alignItems:     'center',
    gap:            spacing.md,
    padding:        spacing.md,
    borderRadius:   radius.md,
  } as ViewStyle,

  timeStack: {
    width:     44,
    alignItems: 'center',
    flexShrink: 0,
  } as ViewStyle,

  timeText: {
    fontSize:   11,
    fontWeight: '400',
    color:      '#6b7280',
    lineHeight: 16,
  } as TextStyle,

  timeAm: {
    fontSize:   11,
    fontWeight: '400',
    color:      tokens.textMuted,
    lineHeight: 14,
  } as TextStyle,

  // Avatar circle — 36×36 matches mockup spec exactly
  avatar: {
    width:          36,
    height:         36,
    borderRadius:   999,
    alignItems:     'center',
    justifyContent: 'center',
    flexShrink:     0,
  } as ViewStyle,

  avatarText: {
    fontSize:   13,
    fontWeight: '700',
  } as TextStyle,

  scheduleInfo: {
    flex: 1,
    gap:  2,
  } as ViewStyle,

  scheduleNameText: {
    fontSize:   14,
    fontWeight: '600',
    color:      '#111827',
  } as TextStyle,

  scheduleMetaText: {
    fontSize:  11,
    fontWeight: '400',
    color:     '#6b7280',
  } as TextStyle,

  scheduleAction: {
    paddingHorizontal: 10,
    paddingVertical:    6,
    borderRadius:      radius.sm,
    borderWidth:       1,
  } as ViewStyle,

  scheduleActionStart: {
    backgroundColor: '#16a34a',
    borderColor:     '#16a34a',
  } as ViewStyle,

  scheduleActionPrep: {
    backgroundColor: '#fff',
    borderColor:     '#e5e7eb',
  } as ViewStyle,

  scheduleActionText: {
    fontSize:   11,
    fontWeight: '600',
  } as TextStyle,

  scheduleActionTextStart: {
    color: '#fff',
  } as TextStyle,

  scheduleActionTextPrep: {
    color: '#374151',
  } as TextStyle,

  // ── Weekly snapshot 2×2 grid ───────────────────────────────────────────────
  snapshotGrid: {
    flexDirection: 'row',
    flexWrap:      'wrap',
    gap:           spacing.md,
  } as ViewStyle,

  snapshotBox: {
    // ~48% width ensures 2 columns with the gap
    width:         '48%',
    backgroundColor: '#f9fafb',
    borderRadius:  radius.lg,
    padding:       spacing.md,
  } as ViewStyle,

  snapshotLabel: {
    fontSize:   12,
    fontWeight: '400',
    color:      '#6b7280',
  } as TextStyle,

  snapshotValue: {
    fontSize:   24,
    fontWeight: '700',
    color:      '#111827',
    marginTop:  4,
  } as TextStyle,

  snapshotDelta: {
    fontSize:   12,
    fontWeight: '400',
    color:      tokens.emerald700,
    marginTop:  4,
  } as TextStyle,

  // ── Recent activity ────────────────────────────────────────────────────────
  activityRow: {
    flexDirection:   'row',
    alignItems:      'center',
    gap:             spacing.md,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  } as ViewStyle,

  activityIconWrap: {
    width:          24,
    alignItems:     'center',
    justifyContent: 'center',
    flexShrink:     0,
  } as ViewStyle,

  activityText: {
    flex:       1,
    fontSize:   14,
    fontWeight: '400',
    color:      '#374151',
  } as TextStyle,

  activityBold: {
    fontWeight: '700',
    color:      '#111827',
  } as TextStyle,

  activityTime: {
    fontSize:   12,
    fontWeight: '400',
    color:      tokens.textMuted,
    flexShrink: 0,
  } as TextStyle,

  // ── Shared ────────────────────────────────────────────────────────────────
  emptyText: {
    fontSize:   14,
    fontWeight: '400',
    color:      '#6b7280',
    textAlign:  'center',
    paddingVertical: 8,
  } as TextStyle,
});

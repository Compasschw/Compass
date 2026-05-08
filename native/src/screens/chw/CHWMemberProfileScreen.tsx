/**
 * CHWMemberProfileScreen — Full member context view for CHW/admin users.
 *
 * Shows the assigned CHW (or admin) a complete picture of a member:
 *   - Contact info and quick-action buttons (Call/Text — disabled, Call Center descoped)
 *   - About section: address, languages, MCO, ECM flag, need-category chips
 *   - Billable Units mini-card (today + year caps, red when near cap)
 *   - Latest Assessment placeholder (parallel agent builds the real data)
 *   - Session history (with this CHW): chronological list, View button
 *   - Open Goals & Follow-ups from session_followups
 *   - Consent section: which types are granted
 *
 * Access gate:
 *   - CHW: backend returns 403 when no active relationship (session or accepted
 *     request) exists. Renders a clear "no access" empty state — not a generic error.
 *   - Admin: unrestricted access to any member profile.
 *
 * Navigation entry points:
 *   - CHWSessionsScreen: tap member name → pushes MemberProfile
 *   - CHWRequestsScreen: "View Member Profile" on accepted cards → pushes MemberProfile
 *   - SessionChat header: member name link → pushes MemberProfile (future)
 *
 * Route param: { memberId: string }
 *
 * HIPAA minimum-necessary (45 CFR §164.514(d)):
 *   medi_cal_id, insurance_provider, session notes from other CHWs, and
 *   transcripts are explicitly NOT rendered.
 */

import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  ArrowLeft,
  Calendar,
  CheckCircle,
  Clock,
  Globe,
  Heart,
  MapPin,
  MessageSquare,
  Phone,
  ShieldCheck,
  ShieldOff,
  ShieldX,
  Sparkles,
  User,
  XCircle,
} from 'lucide-react-native';
import { useQuery } from '@tanstack/react-query';

import { colors } from '../../theme/colors';
import { fonts } from '../../theme/typography';
import { api } from '../../api/client';
import { transformKeys } from '../../utils/caseTransform';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import type { CHWSessionsStackParamList } from '../../navigation/CHWTabNavigator';

// ─── Navigation types ─────────────────────────────────────────────────────────

type MemberProfileRouteProp = RouteProp<CHWSessionsStackParamList, 'MemberProfile'>;
type MemberProfileNavProp = NativeStackNavigationProp<
  CHWSessionsStackParamList,
  'MemberProfile'
>;

// ─── API types ────────────────────────────────────────────────────────────────

interface BillingUnitsData {
  todayUsed: number;
  todayRemaining: number;
  yearlyUsed: number;
  yearlyRemaining: number;
}

interface OpenGoalItem {
  text: string;
  dueDate: string | null;
}

interface OpenFollowupItem {
  text: string;
  dueDate: string | null;
}

interface ConsentStatusData {
  aiTranscription: 'granted' | 'denied' | 'none';
  sessionRecording: 'granted' | 'denied' | 'none';
}

interface RecentSessionItem {
  id: string;
  status: string;
  mode: string;
  scheduledAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMinutes: number | null;
  unitsBilled: number | null;
}

interface CHWMemberProfileDetail {
  id: string;
  firstName: string;
  lastName: string;
  phoneE164: string | null;
  email: string | null;
  primaryLanguage: string;
  additionalLanguages: string[];
  address: string | null;
  city: string | null;
  zipCode: string | null;
  mco: string | null;
  ecmEligible: boolean;
  primaryCategories: string[];
  billingUnits: BillingUnitsData;
  sessionCount: number;
  lastSessionAt: string | null;
  openGoals: OpenGoalItem[];
  openFollowups: OpenFollowupItem[];
  consentStatus: ConsentStatusData;
  recentSessions: RecentSessionItem[];
}

// ─── Assessment stub type (parallel agent owns the real shape) ────────────────

interface AssessmentLatest {
  completedAt: string;
  responseCounts: Record<string, number>;
}

// ─── Query keys ───────────────────────────────────────────────────────────────

const memberDetailKey = (memberId: string) =>
  ['chw', 'members', memberId, 'detail'] as const;

const assessmentLatestKey = (memberId: string) =>
  ['chw', 'members', memberId, 'assessments', 'latest'] as const;

// ─── Query hooks ──────────────────────────────────────────────────────────────

function useMemberDetail(memberId: string) {
  return useQuery({
    queryKey: memberDetailKey(memberId),
    queryFn: async (): Promise<CHWMemberProfileDetail> => {
      const raw = await api<unknown>(`/chw/members/${memberId}`);
      return transformKeys<CHWMemberProfileDetail>(raw);
    },
    enabled: memberId.length > 0,
    staleTime: 60_000,
    retry: (failureCount, error: unknown) => {
      // Never retry a 403 — the relationship gate is intentional.
      if (
        error != null &&
        typeof error === 'object' &&
        'status' in error &&
        (error as { status: number }).status === 403
      ) {
        return false;
      }
      return failureCount < 2;
    },
  });
}

function useAssessmentLatest(memberId: string) {
  return useQuery({
    queryKey: assessmentLatestKey(memberId),
    queryFn: async (): Promise<AssessmentLatest | null> => {
      try {
        const raw = await api<unknown>(
          `/chw/members/${memberId}/assessments/latest`,
        );
        return transformKeys<AssessmentLatest>(raw);
      } catch (err: unknown) {
        // 404 is expected until the parallel agent's branch lands — degrade gracefully.
        if (
          err != null &&
          typeof err === 'object' &&
          'status' in err &&
          (err as { status: number }).status === 404
        ) {
          return null;
        }
        throw err;
      }
    },
    enabled: memberId.length > 0,
    staleTime: 120_000,
    retry: false, // Don't retry — 404 is the expected state until parallel branch lands
  });
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_UNITS_PER_DAY = 4;
const MAX_UNITS_PER_YEAR = 10;

/** Threshold at which billing unit counts render in warning red. */
const CAP_WARNING_THRESHOLD_DAY = 1;
const CAP_WARNING_THRESHOLD_YEAR = 2;

const SESSION_STATUS_LABELS: Record<string, string> = {
  scheduled: 'Scheduled',
  in_progress: 'In Progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

const SESSION_MODE_LABELS: Record<string, string> = {
  in_person: 'In Person',
  virtual: 'Video',
  phone: 'Phone',
};

const CATEGORY_LABELS: Record<string, string> = {
  housing: 'Housing',
  food: 'Food Security',
  mental_health: 'Mental Health',
  rehab: 'Rehab',
  healthcare: 'Healthcare',
};

const CATEGORY_COLORS: Record<string, string> = {
  housing: '#7C3AED',
  food: '#D97706',
  mental_health: '#0EA5E9',
  rehab: '#059669',
  healthcare: '#DC2626',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getInitials(firstName: string, lastName: string): string {
  return `${firstName[0] ?? ''}${lastName[0] ?? ''}`.toUpperCase() || '?';
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatDueDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface InfoRowProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  placeholder?: boolean;
}

function InfoRow({
  icon,
  label,
  value,
  placeholder = false,
}: InfoRowProps): React.JSX.Element {
  return (
    <View style={infoRowStyles.container}>
      <View style={infoRowStyles.iconBox}>{icon}</View>
      <View style={infoRowStyles.textBox}>
        <Text style={infoRowStyles.label}>{label}</Text>
        <Text
          style={[infoRowStyles.value, placeholder && infoRowStyles.valuePlaceholder]}
        >
          {value}
        </Text>
      </View>
    </View>
  );
}

const infoRowStyles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: '#E5DFD6',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
    marginBottom: 8,
  },
  iconBox: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: '#3D5A3E15',
    alignItems: 'center',
    justifyContent: 'center',
  },
  textBox: { flex: 1 },
  label: {
    fontFamily: fonts.bodySemibold,
    fontSize: 10,
    color: '#6B7280',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 1,
  },
  value: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#1E3320',
  },
  valuePlaceholder: {
    color: '#A0A6AB',
    fontStyle: 'italic',
  },
});

interface SectionCardProps {
  title: string;
  children: React.ReactNode;
  /** Optional trailing element in the title row (e.g. a count badge). */
  titleRight?: React.ReactNode;
}

function SectionCard({
  title,
  children,
  titleRight,
}: SectionCardProps): React.JSX.Element {
  return (
    <View style={sectionCardStyles.container}>
      <View style={sectionCardStyles.titleRow}>
        <Text style={sectionCardStyles.title}>{title}</Text>
        {titleRight}
      </View>
      <View style={sectionCardStyles.body}>{children}</View>
    </View>
  );
}

const sectionCardStyles = StyleSheet.create({
  container: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    marginBottom: 16,
    overflow: 'hidden',
    ...Platform.select({
      ios: {
        shadowColor: '#3D5A3E',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.08,
        shadowRadius: 24,
      },
      android: { elevation: 3 },
    }),
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 6,
  },
  title: {
    fontFamily: fonts.bodySemibold,
    fontSize: 12,
    color: '#6B7280',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  body: {
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
});

function EmptySectionState({
  message,
}: {
  message: string;
}): React.JSX.Element {
  return (
    <View style={emptyStyles.container}>
      <Text style={emptyStyles.text}>{message}</Text>
    </View>
  );
}

const emptyStyles = StyleSheet.create({
  container: {
    alignItems: 'center',
    paddingVertical: 16,
  },
  text: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: '#A0A6AB',
    fontStyle: 'italic',
  },
});

// ─── BillingUnitsCard ─────────────────────────────────────────────────────────

interface BillingUnitsCardProps {
  units: BillingUnitsData;
}

function BillingUnitsCard({ units }: BillingUnitsCardProps): React.JSX.Element {
  const todayAtCap = units.todayRemaining <= CAP_WARNING_THRESHOLD_DAY;
  const yearAtCap = units.yearlyRemaining <= CAP_WARNING_THRESHOLD_YEAR;

  return (
    <View style={billingStyles.card}>
      {/* Today */}
      <View style={billingStyles.halfBlock}>
        <Text style={billingStyles.periodLabel}>Today</Text>
        <View style={billingStyles.barTrack}>
          <View
            style={[
              billingStyles.barFill,
              {
                width: `${(units.todayUsed / MAX_UNITS_PER_DAY) * 100}%` as `${number}%`,
                backgroundColor: todayAtCap ? '#DC2626' : colors.primary,
              },
            ]}
          />
        </View>
        <View style={billingStyles.statsRow}>
          <Text
            style={[
              billingStyles.usedLabel,
              todayAtCap && billingStyles.usedLabelDanger,
            ]}
          >
            {units.todayUsed} used
          </Text>
          <Text style={billingStyles.remainingLabel}>
            {units.todayRemaining} left
          </Text>
        </View>
      </View>

      <View style={billingStyles.verticalDivider} />

      {/* This year */}
      <View style={billingStyles.halfBlock}>
        <Text style={billingStyles.periodLabel}>This Year</Text>
        <View style={billingStyles.barTrack}>
          <View
            style={[
              billingStyles.barFill,
              {
                width: `${(units.yearlyUsed / MAX_UNITS_PER_YEAR) * 100}%` as `${number}%`,
                backgroundColor: yearAtCap ? '#DC2626' : colors.primary,
              },
            ]}
          />
        </View>
        <View style={billingStyles.statsRow}>
          <Text
            style={[
              billingStyles.usedLabel,
              yearAtCap && billingStyles.usedLabelDanger,
            ]}
          >
            {units.yearlyUsed} used
          </Text>
          <Text style={billingStyles.remainingLabel}>
            {units.yearlyRemaining} left
          </Text>
        </View>
      </View>
    </View>
  );
}

const billingStyles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: '#F4F1ED',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    overflow: 'hidden',
  },
  halfBlock: {
    flex: 1,
    padding: 12,
    gap: 8,
  },
  verticalDivider: {
    width: 1,
    backgroundColor: '#DDD6CC',
  },
  periodLabel: {
    fontFamily: fonts.bodySemibold,
    fontSize: 10,
    color: '#6B7280',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  barTrack: {
    height: 6,
    backgroundColor: '#DDD6CC',
    borderRadius: 3,
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    borderRadius: 3,
  },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  usedLabel: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 13,
    color: '#1E3320',
  },
  usedLabelDanger: {
    color: '#DC2626',
  },
  remainingLabel: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: '#6B7280',
  },
});

// ─── AssessmentSection ────────────────────────────────────────────────────────
// Placeholder section — parallel agent owns the real assessment rendering.

interface AssessmentSectionProps {
  memberId: string;
}

function AssessmentSection({ memberId }: AssessmentSectionProps): React.JSX.Element {
  const { data: assessment, isLoading } = useAssessmentLatest(memberId);

  return (
    <SectionCard
      title="Latest Assessment"
      titleRight={
        <View style={assessmentStyles.badge}>
          <Sparkles size={10} color={colors.secondary} />
          <Text style={assessmentStyles.badgeText}>Beta</Text>
        </View>
      }
    >
      {isLoading ? (
        <View style={assessmentStyles.loadingRow}>
          <ActivityIndicator size="small" color={colors.mutedForeground} />
          <Text style={assessmentStyles.loadingText}>Loading assessment...</Text>
        </View>
      ) : assessment ? (
        <View style={assessmentStyles.present}>
          <View style={assessmentStyles.metaRow}>
            <Calendar size={14} color={colors.primary} />
            <Text style={assessmentStyles.completedAt}>
              Completed {formatDate(assessment.completedAt)}
            </Text>
          </View>
          {Object.entries(assessment.responseCounts).map(([category, count]) => (
            <View key={category} style={assessmentStyles.categoryRow}>
              <Text style={assessmentStyles.categoryLabel}>{category}</Text>
              <Text style={assessmentStyles.categoryCount}>{count} responses</Text>
            </View>
          ))}
        </View>
      ) : (
        <EmptySectionState message="No assessment recorded yet." />
      )}
    </SectionCard>
  );
}

const assessmentStyles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.secondary + '20',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 100,
  },
  badgeText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 10,
    color: colors.secondary,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 12,
  },
  loadingText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: colors.mutedForeground,
  },
  present: {
    gap: 8,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  completedAt: {
    fontFamily: fonts.bodySemibold,
    fontSize: 13,
    color: '#1E3320',
  },
  categoryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#F4F1ED',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  categoryLabel: {
    fontFamily: fonts.bodySemibold,
    fontSize: 12,
    color: '#1E3320',
    textTransform: 'capitalize',
  },
  categoryCount: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: '#6B7280',
  },
});

// ─── SessionHistoryItem ───────────────────────────────────────────────────────

interface SessionHistoryItemProps {
  session: RecentSessionItem;
  onView: (sessionId: string) => void;
}

function SessionHistoryItem({
  session,
  onView,
}: SessionHistoryItemProps): React.JSX.Element {
  const statusLabel = SESSION_STATUS_LABELS[session.status] ?? session.status;
  const modeLabel = SESSION_MODE_LABELS[session.mode] ?? session.mode;
  const isCompleted = session.status === 'completed';

  const statusColor =
    session.status === 'in_progress'
      ? colors.compassGold
      : session.status === 'completed'
      ? colors.primary
      : session.status === 'cancelled'
      ? colors.mutedForeground
      : colors.secondary;

  return (
    <View style={sessionItemStyles.container}>
      <View style={sessionItemStyles.left}>
        {/* Date */}
        <Text style={sessionItemStyles.date}>
          {formatDateTime(session.scheduledAt ?? session.startedAt)}
        </Text>
        {/* Mode + status */}
        <View style={sessionItemStyles.badgeRow}>
          <View style={sessionItemStyles.modeBadge}>
            <Text style={sessionItemStyles.modeText}>{modeLabel}</Text>
          </View>
          <View
            style={[
              sessionItemStyles.statusBadge,
              { backgroundColor: statusColor + '18' },
            ]}
          >
            <Text
              style={[sessionItemStyles.statusText, { color: statusColor }]}
            >
              {statusLabel}
            </Text>
          </View>
        </View>
        {/* Duration + units for completed sessions */}
        {isCompleted && (
          <View style={sessionItemStyles.statsRow}>
            {session.durationMinutes != null && (
              <View style={sessionItemStyles.statChip}>
                <Clock size={10} color={colors.mutedForeground} />
                <Text style={sessionItemStyles.statText}>
                  {session.durationMinutes} min
                </Text>
              </View>
            )}
            {session.unitsBilled != null && (
              <View style={sessionItemStyles.statChip}>
                <Text style={sessionItemStyles.statText}>
                  {session.unitsBilled} unit{session.unitsBilled !== 1 ? 's' : ''}
                </Text>
              </View>
            )}
          </View>
        )}
      </View>
      <TouchableOpacity
        style={sessionItemStyles.viewBtn}
        onPress={() => onView(session.id)}
        accessibilityRole="button"
        accessibilityLabel={`View session from ${formatDateTime(session.scheduledAt)}`}
      >
        <Text style={sessionItemStyles.viewBtnText}>View</Text>
      </TouchableOpacity>
    </View>
  );
}

const sessionItemStyles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#DDD6CC',
    gap: 10,
  },
  left: {
    flex: 1,
    gap: 4,
  },
  date: {
    fontFamily: fonts.bodySemibold,
    fontSize: 13,
    color: '#1E3320',
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  modeBadge: {
    backgroundColor: '#F4F1ED',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: '#DDD6CC',
  },
  modeText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#6B7280',
  },
  statusBadge: {
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  statusText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 11,
  },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: '#F4F1ED',
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  statText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: colors.mutedForeground,
  },
  viewBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: colors.primary + '15',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.primary + '40',
    flexShrink: 0,
  },
  viewBtnText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 12,
    color: colors.primary,
  },
});

// ─── GoalItem / FollowupItem ──────────────────────────────────────────────────

interface ActionItemProps {
  text: string;
  dueDate: string | null;
}

function ActionItem({ text, dueDate }: ActionItemProps): React.JSX.Element {
  const due = formatDueDate(dueDate);
  const isOverdue =
    dueDate != null && new Date(dueDate) < new Date();

  return (
    <View style={actionItemStyles.container}>
      <View style={actionItemStyles.bullet} />
      <View style={actionItemStyles.content}>
        <Text style={actionItemStyles.text}>{text}</Text>
        {due && (
          <Text
            style={[
              actionItemStyles.due,
              isOverdue && actionItemStyles.dueOverdue,
            ]}
          >
            Due {due}
            {isOverdue ? ' · Overdue' : ''}
          </Text>
        )}
      </View>
    </View>
  );
}

const actionItemStyles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#DDD6CC',
  },
  bullet: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.primary,
    marginTop: 6,
    flexShrink: 0,
  },
  content: {
    flex: 1,
    gap: 2,
  },
  text: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: '#1E3320',
    lineHeight: 20,
  },
  due: {
    fontFamily: fonts.bodySemibold,
    fontSize: 11,
    color: colors.mutedForeground,
  },
  dueOverdue: {
    color: '#DC2626',
  },
});

// ─── ConsentStatusRow ─────────────────────────────────────────────────────────

type ConsentValue = 'granted' | 'denied' | 'none';

interface ConsentRowProps {
  label: string;
  value: ConsentValue;
}

function ConsentRow({ label, value }: ConsentRowProps): React.JSX.Element {
  const consentMeta: Record<ConsentValue, { icon: React.ReactNode; text: string; color: string }> = {
    granted: {
      icon: <ShieldCheck size={16} color="#16A34A" />,
      text: 'Granted',
      color: '#16A34A',
    },
    denied: {
      icon: <ShieldX size={16} color="#DC2626" />,
      text: 'Denied',
      color: '#DC2626',
    },
    none: {
      icon: <ShieldOff size={16} color="#A0A6AB" />,
      text: 'Not asked',
      color: '#A0A6AB',
    },
  };
  const meta = consentMeta[value];

  return (
    <View style={consentRowStyles.container}>
      <Text style={consentRowStyles.label}>{label}</Text>
      <View style={consentRowStyles.right}>
        {meta.icon}
        <Text style={[consentRowStyles.value, { color: meta.color }]}>
          {meta.text}
        </Text>
      </View>
    </View>
  );
}

const consentRowStyles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#DDD6CC',
  },
  label: {
    fontFamily: fonts.bodySemibold,
    fontSize: 13,
    color: '#1E3320',
    flex: 1,
  },
  right: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  value: {
    fontFamily: fonts.bodySemibold,
    fontSize: 13,
  },
});

// ─── Main screen component ────────────────────────────────────────────────────

/**
 * CHWMemberProfileScreen
 *
 * Route params: { memberId: string }
 */
export function CHWMemberProfileScreen(): React.JSX.Element {
  const route = useRoute<MemberProfileRouteProp>();
  const navigation = useNavigation<MemberProfileNavProp>();
  const { memberId } = route.params;

  const { data: profile, isLoading, error } = useMemberDetail(memberId);

  // ── Navigate to session detail ───────────────────────────────────────────────
  const handleViewSession = useCallback(
    (sessionId: string): void => {
      navigation.navigate('SessionReview', {
        sessionId,
        memberName: profile
          ? `${profile.firstName} ${profile.lastName}`
          : 'Member',
        memberId,
      });
    },
    [navigation, profile, memberId],
  );

  // ── Call / text button handlers (disabled — Call Center descoped) ────────────
  const handleCallPress = useCallback((): void => {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.alert(
        'Direct calling is coming soon. Use the masked call button within an active session.',
      );
    } else {
      Alert.alert(
        'Coming Soon',
        'Direct calling will be available when the Call Center feature launches.',
      );
    }
  }, []);

  const handleTextPress = useCallback((): void => {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.alert('Texting is coming soon.');
    } else {
      Alert.alert('Coming Soon', 'Texting will be available in an upcoming release.');
    }
  }, []);

  // ── Loading skeleton ─────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <SafeAreaView style={s.safeArea} edges={['top']}>
        <StatusBar barStyle="dark-content" backgroundColor={colors.background} />
        <View style={s.header}>
          <TouchableOpacity
            style={s.backBtn}
            onPress={() => navigation.goBack()}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <ArrowLeft size={20} color={colors.foreground} />
          </TouchableOpacity>
          <Text style={s.headerTitle}>Member Profile</Text>
          <View style={{ width: 40 }} />
        </View>
        <View style={s.pageWrap}>
          <LoadingSkeleton variant="card" />
          <LoadingSkeleton variant="rows" rows={5} />
        </View>
      </SafeAreaView>
    );
  }

  // ── 403 / access denied state ────────────────────────────────────────────────
  // 403 is the backend correctly enforcing the relationship gate — not an error.

  const is403 =
    error != null &&
    typeof error === 'object' &&
    'status' in error &&
    (error as { status: number }).status === 403;

  if (is403 || (error != null && !profile)) {
    return (
      <SafeAreaView style={s.safeArea} edges={['top']}>
        <StatusBar barStyle="dark-content" backgroundColor={colors.background} />
        <View style={s.header}>
          <TouchableOpacity
            style={s.backBtn}
            onPress={() => navigation.goBack()}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <ArrowLeft size={20} color={colors.foreground} />
          </TouchableOpacity>
          <Text style={s.headerTitle}>Member Profile</Text>
          <View style={{ width: 40 }} />
        </View>
        <View style={s.emptyState}>
          <View style={s.emptyIconCircle}>
            <ShieldOff size={28} color={colors.mutedForeground} />
          </View>
          <Text style={s.emptyTitle}>
            {is403 ? 'Profile not accessible' : 'Could not load profile'}
          </Text>
          <Text style={s.emptySubtext}>
            {is403
              ? "You don't have access to this member's profile yet. An active session or accepted request with this member is required."
              : 'Check your connection and try again.'}
          </Text>
          <TouchableOpacity
            style={s.backButton}
            onPress={() => navigation.goBack()}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Text style={s.backButtonText}>Go Back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (!profile) return <></>;

  const initials = getInitials(profile.firstName, profile.lastName);
  const displayName = `${profile.firstName} ${profile.lastName}`.trim();

  return (
    <SafeAreaView style={s.safeArea} edges={['top']}>
      <StatusBar barStyle="dark-content" backgroundColor={colors.background} />

      {/* ── Screen header ── */}
      <View style={s.header}>
        <TouchableOpacity
          style={s.backBtn}
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <ArrowLeft size={20} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={s.headerTitle} numberOfLines={1}>
          Member Profile
        </Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={s.pageWrap}>

          {/* ── Hero — avatar, name, language badge ── */}
          <View style={s.bannerContainer}>
            <View style={s.banner} />
            <View style={s.heroSection}>
              <View style={s.avatarWrapper}>
                <View style={s.avatar}>
                  <Text style={s.avatarText}>{initials}</Text>
                </View>
              </View>
              <Text style={s.displayName}>{displayName}</Text>
              <View style={s.heroBadgesRow}>
                {/* Primary language */}
                <View style={s.languageBadge}>
                  <Globe size={11} color="#3D5A3E" />
                  <Text style={s.languageBadgeText}>{profile.primaryLanguage}</Text>
                </View>
                {/* ECM eligibility flag */}
                {profile.ecmEligible && (
                  <View style={s.ecmBadge}>
                    <CheckCircle size={11} color="#1D4ED8" />
                    <Text style={s.ecmBadgeText}>ECM Eligible</Text>
                  </View>
                )}
              </View>
            </View>
          </View>

          {/* ── Quick actions (Call Center descoped — disabled with tooltip) ── */}
          <View style={s.actionRow} accessibilityRole="group" accessibilityLabel="Quick actions">
            <TouchableOpacity
              style={[s.actionBtn, s.actionBtnDisabled]}
              onPress={handleCallPress}
              accessibilityRole="button"
              accessibilityLabel="Call member — coming soon"
              accessibilityHint="Direct calling is not yet available"
            >
              <Phone size={16} color="#94A3B8" />
              <Text style={s.actionBtnDisabledText}>Call</Text>
              <View style={s.comingSoonPill}>
                <Text style={s.comingSoonText}>Soon</Text>
              </View>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.actionBtn, s.actionBtnDisabled]}
              onPress={handleTextPress}
              accessibilityRole="button"
              accessibilityLabel="Text member — coming soon"
              accessibilityHint="Texting is not yet available"
            >
              <MessageSquare size={16} color="#94A3B8" />
              <Text style={s.actionBtnDisabledText}>Text</Text>
              <View style={s.comingSoonPill}>
                <Text style={s.comingSoonText}>Soon</Text>
              </View>
            </TouchableOpacity>
          </View>

          {/* ── About ── */}
          <SectionCard title="About">
            {/* Contact */}
            <InfoRow
              icon={<Phone size={16} color={colors.primary} />}
              label="Phone"
              value={profile.phoneE164 ?? 'Not provided'}
              placeholder={!profile.phoneE164}
            />
            {profile.email ? (
              <InfoRow
                icon={<User size={16} color={colors.primary} />}
                label="Email"
                value={profile.email}
              />
            ) : null}

            {/* Location */}
            <InfoRow
              icon={<MapPin size={16} color={colors.primary} />}
              label={profile.address ? 'Address' : 'ZIP Code'}
              value={
                profile.address
                  ? [profile.address, profile.city, profile.zipCode]
                      .filter(Boolean)
                      .join(', ')
                  : profile.zipCode
                  ? `ZIP ${profile.zipCode}`
                  : 'Not provided'
              }
              placeholder={!profile.address && !profile.zipCode}
            />

            {/* Languages */}
            <InfoRow
              icon={<Globe size={16} color={colors.primary} />}
              label={
                profile.additionalLanguages.length > 0
                  ? 'Languages'
                  : 'Primary Language'
              }
              value={
                [profile.primaryLanguage, ...profile.additionalLanguages].join(', ')
              }
            />

            {/* MCO */}
            <InfoRow
              icon={<Heart size={16} color={colors.primary} />}
              label="MCO / Insurance"
              value={profile.mco ?? 'Not provided'}
              placeholder={!profile.mco}
            />

            {/* Need categories as chips */}
            {profile.primaryCategories.length > 0 && (
              <View style={s.categoriesBlock}>
                <Text style={s.categoriesLabel}>Need Categories</Text>
                <View style={s.chipsRow}>
                  {profile.primaryCategories.map((cat) => {
                    const color = CATEGORY_COLORS[cat] ?? colors.primary;
                    const label = CATEGORY_LABELS[cat] ?? cat;
                    return (
                      <View
                        key={cat}
                        style={[s.chip, { backgroundColor: color + '18' }]}
                      >
                        <Text style={[s.chipText, { color }]}>{label}</Text>
                      </View>
                    );
                  })}
                </View>
              </View>
            )}
          </SectionCard>

          {/* ── Billable Units ── */}
          <SectionCard
            title="Billable Units (Medi-Cal)"
            titleRight={
              <Text style={s.billingCapNote}>
                {MAX_UNITS_PER_DAY}/day · {MAX_UNITS_PER_YEAR}/year cap
              </Text>
            }
          >
            <BillingUnitsCard units={profile.billingUnits} />
          </SectionCard>

          {/* ── Latest Assessment (placeholder) ── */}
          <AssessmentSection memberId={memberId} />

          {/* ── Session History ── */}
          <SectionCard
            title="Sessions"
            titleRight={
              profile.sessionCount > 0 ? (
                <View style={s.countBadge}>
                  <Text style={s.countBadgeText}>{profile.sessionCount} completed</Text>
                </View>
              ) : undefined
            }
          >
            {profile.recentSessions.length > 0 ? (
              <>
                {profile.recentSessions.map((session, index) => (
                  <View
                    key={session.id}
                    style={
                      index === profile.recentSessions.length - 1
                        ? s.sessionItemLast
                        : undefined
                    }
                  >
                    <SessionHistoryItem
                      session={session}
                      onView={handleViewSession}
                    />
                  </View>
                ))}
              </>
            ) : (
              <EmptySectionState message="No sessions with this member yet." />
            )}
          </SectionCard>

          {/* ── Open Goals & Follow-ups ── */}
          <SectionCard
            title="Open Goals & Follow-ups"
            titleRight={
              profile.openGoals.length + profile.openFollowups.length > 0 ? (
                <View style={s.countBadge}>
                  <Text style={s.countBadgeText}>
                    {profile.openGoals.length + profile.openFollowups.length} open
                  </Text>
                </View>
              ) : undefined
            }
          >
            {profile.openGoals.length === 0 && profile.openFollowups.length === 0 ? (
              <EmptySectionState message="No open goals or follow-ups." />
            ) : (
              <>
                {/* Goals subsection */}
                {profile.openGoals.length > 0 && (
                  <>
                    <Text style={s.subSectionLabel}>Goals</Text>
                    {profile.openGoals.map((goal, i) => (
                      <ActionItem
                        key={`goal-${i}`}
                        text={goal.text}
                        dueDate={goal.dueDate}
                      />
                    ))}
                  </>
                )}

                {/* Follow-ups subsection */}
                {profile.openFollowups.length > 0 && (
                  <>
                    <Text
                      style={[
                        s.subSectionLabel,
                        profile.openGoals.length > 0 && { marginTop: 12 },
                      ]}
                    >
                      Follow-ups
                    </Text>
                    {profile.openFollowups.map((fu, i) => (
                      <ActionItem
                        key={`fu-${i}`}
                        text={fu.text}
                        dueDate={fu.dueDate}
                      />
                    ))}
                  </>
                )}
              </>
            )}
          </SectionCard>

          {/* ── Consent ── */}
          <SectionCard title="Consent">
            <ConsentRow
              label="AI Transcription"
              value={profile.consentStatus.aiTranscription}
            />
            <View style={s.consentLastRow}>
              <ConsentRow
                label="Session Recording"
                value={profile.consentStatus.sessionRecording}
              />
            </View>
          </SectionCard>

          {/* ── HIPAA disclosure notice ── */}
          <View style={s.hipaaNotice}>
            <Text style={s.hipaaNoticeText}>
              This view shows only the information needed for care delivery.
              Member identifiers, insurance details, notes from other CHWs, and
              session transcripts are not displayed (HIPAA minimum necessary —
              45 CFR §164.514(d)).
            </Text>
          </View>

          <View style={{ height: 40 }} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#F4F1ED',
  },

  // ── Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: '#F4F1ED',
    borderBottomWidth: 1,
    borderBottomColor: '#DDD6CC',
  },
  headerTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 18,
    color: '#1E3320',
    flex: 1,
    textAlign: 'center',
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#DDD6CC',
    alignItems: 'center',
    justifyContent: 'center',
  },

  // ── Scroll
  scroll: { flex: 1 },
  scrollContent: {
    flexGrow: 1,
    alignItems: 'center',
  },
  pageWrap: {
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingTop: 0,
  },

  // ── Hero
  bannerContainer: {
    marginHorizontal: -16,
  },
  banner: {
    height: 80,
    backgroundColor: '#3D5A3E',
  },
  heroSection: {
    alignItems: 'center',
    marginBottom: 20,
    paddingHorizontal: 16,
    gap: 6,
  },
  avatarWrapper: {
    marginTop: -40,
    marginBottom: 4,
  },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#3D5A3E18',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 4,
    borderColor: '#FFFFFF',
    ...Platform.select({
      ios: {
        shadowColor: '#3D5A3E',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.18,
        shadowRadius: 12,
      },
      android: { elevation: 4 },
    }),
  },
  avatarText: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 24,
    color: '#3D5A3E',
  },
  displayName: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 20,
    color: '#1E3320',
  },
  heroBadgesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  languageBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#3D5A3E20',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 100,
  },
  languageBadgeText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 12,
    color: '#3D5A3E',
  },
  ecmBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#1D4ED810',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 100,
    borderWidth: 1,
    borderColor: '#1D4ED840',
  },
  ecmBadgeText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 12,
    color: '#1D4ED8',
  },

  // ── Quick action buttons
  actionRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 20,
  },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingVertical: 13,
    borderRadius: 13,
  },
  actionBtnDisabled: {
    backgroundColor: '#F1F5F9',
    borderWidth: 1,
    borderColor: '#DDD6CC',
  },
  actionBtnDisabledText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 14,
    color: '#94A3B8',
  },
  comingSoonPill: {
    backgroundColor: '#E2E8F0',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 100,
  },
  comingSoonText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 9,
    color: '#64748B',
    letterSpacing: 0.3,
  },

  // ── Category chips
  categoriesBlock: {
    marginTop: 4,
    marginBottom: 4,
  },
  categoriesLabel: {
    fontFamily: fonts.bodySemibold,
    fontSize: 10,
    color: '#6B7280',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 8,
  },
  chipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
  },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 100,
  },
  chipText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 12,
  },

  // ── Billing caption
  billingCapNote: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 10,
    color: colors.mutedForeground,
  },

  // ── Session last item (remove bottom border)
  sessionItemLast: {
    // intentionally empty — the inner item's borderBottom is always rendered;
    // the section card body padding handles the visual spacing.
  },

  // ── Goals subsection label
  subSectionLabel: {
    fontFamily: fonts.bodySemibold,
    fontSize: 11,
    color: '#6B7280',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 2,
  },

  // ── Consent last row (no bottom border)
  consentLastRow: {
    // last row — border removed via ConsentRow's internal border logic
  },

  // ── Shared count badge
  countBadge: {
    backgroundColor: colors.primary + '15',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 100,
  },
  countBadgeText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 10,
    color: colors.primary,
  },

  // ── HIPAA notice
  hipaaNotice: {
    backgroundColor: '#F4F1ED',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 8,
  },
  hipaaNoticeText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#6B7280',
    lineHeight: 17,
    textAlign: 'center',
  },

  // ── Access denied / error state
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
    gap: 14,
  },
  emptyIconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#3D5A3E15',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 18,
    color: '#1E3320',
    textAlign: 'center',
  },
  emptySubtext: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#6B7280',
    textAlign: 'center',
    maxWidth: 300,
    lineHeight: 22,
  },
  backButton: {
    backgroundColor: '#3D5A3E',
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 12,
    marginTop: 4,
  },
  backButtonText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 14,
    color: '#FFFFFF',
  },
});

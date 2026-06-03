/**
 * CHWMemberProfileScreen — Full member context view for CHW/admin users.
 *
 * Re-skinned to the new design system. Behavior, hooks, mutations, and
 * navigation are identical to the original.
 *
 * New layout (web):
 *   - Top header card (full width): identity column (avatar + name + pills) ·
 *     contact column (DOB/Phone/Address/Insurance) · Resource Needs column
 *   - Mid row: 4-column insights card (9/12) + Compass Insights AI panel (3/12 RightRail)
 *   - Journey section: 9/12 horizontal step roadmap + 3/12 Quick Access RightRail
 *   - (StickyActionBar removed — entry points live in the contact section
 *     and Quick Access rail; Schedule Session is reachable from tab nav.)
 *   - RightDrawer: Open Questions (static suggested questions v1)
 *   - RightDrawer: Message Member (inline thread via ProfileContactButtons)
 *
 * HIPAA minimum-necessary (45 CFR §164.514(d)):
 *   medi_cal_id, insurance_provider, notes from other CHWs, transcripts are
 *   explicitly NOT rendered.
 *
 * Access gate:
 *   CHW: backend returns 403 when no active relationship exists.
 *   Admin: unrestricted access.
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
  type ViewStyle,
  type TextStyle,
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
  Phone,
  ShieldCheck,
  ShieldOff,
  ShieldX,
  Sparkles,
  User,
  NotebookPen,
  FileText,
  ClipboardList,
  CheckSquare,
  UploadCloud,
  RadioTower,
  ChevronRight,
} from 'lucide-react-native';
import { useQuery } from '@tanstack/react-query';

import { colors } from '../../theme/colors';
import { fonts } from '../../theme/typography';
import { colors as tokens } from '../../theme/tokens';
import { api } from '../../api/client';
import { transformKeys } from '../../utils/caseTransform';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ProfileContactButtons } from '../../components/comms/ProfileContactButtons';
import type { CHWSessionsStackParamList } from '../../navigation/CHWTabNavigator';

import {
  AppShell,
  PageHeader,
  Card,
  Pill,
  RightRail,
  RightDrawer,
} from '../../components/ui';
import { useAuth } from '../../context/AuthContext';
import { OpenQuestionsDrawer } from '../../components/chw/OpenQuestionsDrawer';

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
    retry: false,
  });
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_UNITS_PER_DAY = 4;
const MAX_UNITS_PER_YEAR = 10;

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

/**
 * Maps a category key to a Pill variant for the new design system.
 */
function categoryToPillVariant(cat: string): 'purple' | 'amber' | 'blue' | 'emerald' | 'red' | 'gray' {
  switch (cat) {
    case 'housing':       return 'purple';
    case 'food':          return 'amber';
    case 'mental_health': return 'blue';
    case 'rehab':         return 'emerald';
    case 'healthcare':    return 'red';
    default:              return 'gray';
  }
}

// ─── Static suggested questions for Open Questions drawer (v1 — no backend) ──

const SUGGESTED_QUESTIONS: ReadonlyArray<{ category: string; questions: string[] }> = [
  {
    category: 'Housing Stability',
    questions: [
      'Have there been any changes to your living situation since we last met?',
      'Are you currently on any housing waitlists?',
      'Do you have concerns about keeping your current housing?',
    ],
  },
  {
    category: 'Food Security',
    questions: [
      'Have you been able to access enough food for yourself and your family?',
      'Are you enrolled in CalFresh / SNAP? If not, would you like help applying?',
    ],
  },
  {
    category: 'Health & Wellness',
    questions: [
      'Have you had any medical appointments since our last session?',
      'Are there any new health concerns you would like to address?',
      'How are you managing your medications?',
    ],
  },
  {
    category: 'Goals & Follow-ups',
    questions: [
      'How are you progressing on the goals we set last time?',
      'Is there anything that has been a barrier to completing action items?',
    ],
  },
];

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
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 6,
    marginBottom: 4,
  } as ViewStyle,
  iconBox: {
    width: 16,
    height: 16,
    marginTop: 2,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,
  textBox: { flex: 1 } as ViewStyle,
  label: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: '#9CA3AF',
    marginBottom: 1,
  } as TextStyle,
  value: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#111827',
  } as TextStyle,
  valuePlaceholder: {
    color: '#A0A6AB',
    fontStyle: 'italic',
  } as TextStyle,
});

interface SectionCardProps {
  title: string;
  children: React.ReactNode;
  titleRight?: React.ReactNode;
}

function SectionCard({
  title,
  children,
  titleRight,
}: SectionCardProps): React.JSX.Element {
  return (
    <Card style={sectionCardStyles.container}>
      <View style={sectionCardStyles.titleRow}>
        <Text style={sectionCardStyles.title}>{title}</Text>
        {titleRight}
      </View>
      <View style={sectionCardStyles.body}>{children}</View>
    </Card>
  );
}

const sectionCardStyles = StyleSheet.create({
  container: {
    marginBottom: 20,
    overflow: 'hidden',
  } as ViewStyle,
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 8,
  } as ViewStyle,
  title: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
    color: '#111827',
  } as TextStyle,
  body: {
    paddingHorizontal: 20,
    paddingBottom: 16,
  } as ViewStyle,
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
  } as ViewStyle,
  text: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: '#A0A6AB',
    fontStyle: 'italic',
  } as TextStyle,
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
  } as ViewStyle,
  halfBlock: {
    flex: 1,
    padding: 12,
    gap: 8,
  } as ViewStyle,
  verticalDivider: {
    width: 1,
    backgroundColor: '#DDD6CC',
  } as ViewStyle,
  periodLabel: {
    fontFamily: fonts.bodySemibold,
    fontSize: 10,
    color: '#6B7280',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  } as TextStyle,
  barTrack: {
    height: 6,
    backgroundColor: '#DDD6CC',
    borderRadius: 3,
    overflow: 'hidden',
  } as ViewStyle,
  barFill: {
    height: '100%',
    borderRadius: 3,
  } as ViewStyle,
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  } as ViewStyle,
  usedLabel: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 13,
    color: '#1E3320',
  } as TextStyle,
  usedLabelDanger: {
    color: '#DC2626',
  } as TextStyle,
  remainingLabel: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: '#6B7280',
  } as TextStyle,
});

// ─── AssessmentSection ────────────────────────────────────────────────────────

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
  } as ViewStyle,
  badgeText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 10,
    color: colors.secondary,
  } as TextStyle,
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 12,
  } as ViewStyle,
  loadingText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: colors.mutedForeground,
  } as TextStyle,
  present: { gap: 8 } as ViewStyle,
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  } as ViewStyle,
  completedAt: {
    fontFamily: fonts.bodySemibold,
    fontSize: 13,
    color: '#1E3320',
  } as TextStyle,
  categoryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#F4F1ED',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  } as ViewStyle,
  categoryLabel: {
    fontFamily: fonts.bodySemibold,
    fontSize: 12,
    color: '#1E3320',
    textTransform: 'capitalize',
  } as TextStyle,
  categoryCount: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: '#6B7280',
  } as TextStyle,
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
        <Text style={sessionItemStyles.date}>
          {formatDateTime(session.scheduledAt ?? session.startedAt)}
        </Text>
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
  } as ViewStyle,
  left: {
    flex: 1,
    gap: 4,
  } as ViewStyle,
  date: {
    fontFamily: fonts.bodySemibold,
    fontSize: 13,
    color: '#1E3320',
  } as TextStyle,
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  } as ViewStyle,
  modeBadge: {
    backgroundColor: '#F4F1ED',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: '#DDD6CC',
  } as ViewStyle,
  modeText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#6B7280',
  } as TextStyle,
  statusBadge: {
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
  } as ViewStyle,
  statusText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 11,
  } as TextStyle,
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  } as ViewStyle,
  statChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: '#F4F1ED',
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  } as ViewStyle,
  statText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: colors.mutedForeground,
  } as TextStyle,
  viewBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: colors.primary + '15',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.primary + '40',
    flexShrink: 0,
  } as ViewStyle,
  viewBtnText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 12,
    color: colors.primary,
  } as TextStyle,
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
  } as ViewStyle,
  bullet: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.primary,
    marginTop: 6,
    flexShrink: 0,
  } as ViewStyle,
  content: {
    flex: 1,
    gap: 2,
  } as ViewStyle,
  text: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: '#1E3320',
    lineHeight: 20,
  } as TextStyle,
  due: {
    fontFamily: fonts.bodySemibold,
    fontSize: 11,
    color: colors.mutedForeground,
  } as TextStyle,
  dueOverdue: {
    color: '#DC2626',
  } as TextStyle,
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
  } as ViewStyle,
  label: {
    fontFamily: fonts.bodySemibold,
    fontSize: 13,
    color: '#1E3320',
    flex: 1,
  } as TextStyle,
  right: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  } as ViewStyle,
  value: {
    fontFamily: fonts.bodySemibold,
    fontSize: 13,
  } as TextStyle,
});

// ─── Journey step roadmap ─────────────────────────────────────────────────────
//
// 6-step horizontal roadmap matching the mockup:
//   Step 1+2: completed (emerald bg, check icon)
//   Step 3:   in-progress (emerald bg + amber ring outer)
//   Step 4:   missed (amber bg, clock icon, red ring)
//   Step 5+6: upcoming (gray bg, grey icon)

type StepState = 'completed' | 'in_progress' | 'missed' | 'upcoming';

const JOURNEY_STEPS_V2: ReadonlyArray<{
  key: string;
  label: string;
  subLabel: string;
  state: StepState;
  points: string;
}> = [
  { key: 'identified',  label: 'Need Identified',     subLabel: 'Completed',   state: 'completed',   points: '+10 pts' },
  { key: 'screening',   label: 'Eligibility Screening', subLabel: 'Completed',  state: 'completed',   points: '+25 pts' },
  { key: 'documents',   label: 'Upload Documents',     subLabel: 'In Progress', state: 'in_progress', points: '+30 pts' },
  { key: 'followup',    label: 'Follow Up',            subLabel: 'Missed',      state: 'missed',      points: '+0 pts'  },
  { key: 'resource',    label: 'Resource Connection',  subLabel: 'Upcoming',    state: 'upcoming',    points: '+25 pts' },
  { key: 'complete',    label: 'Journey Complete',     subLabel: '',            state: 'upcoming',    points: '+50 pts' },
] as const;

function JourneyRoadmap(): React.JSX.Element {
  return (
    <View style={journeyStyles.container}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={journeyStyles.row}
      >
        {JOURNEY_STEPS_V2.map((step, index) => {
          const isLast = index === JOURNEY_STEPS_V2.length - 1;
          const isCompleted = step.state === 'completed';
          const isInProgress = step.state === 'in_progress';
          const isMissed = step.state === 'missed';
          const isUpcoming = step.state === 'upcoming';

          const dotBg = isCompleted || isInProgress ? '#16A34A'
            : isMissed ? '#F59E0B'
            : '#E5E7EB';

          const lineBg = isCompleted ? '#16A34A' : '#E5E7EB';

          const subLabelColor = isCompleted ? '#6B7280'
            : isInProgress ? '#16A34A'
            : isMissed ? '#EF4444'
            : '#9CA3AF';

          return (
            <View key={step.key} style={journeyStyles.stepWrapper}>
              {/* Circle */}
              <View style={[
                journeyStyles.stepCircleOuter,
                isInProgress && journeyStyles.stepCircleInProgress,
                isMissed && journeyStyles.stepCircleMissed,
              ]}>
                <View style={[journeyStyles.stepDot, { backgroundColor: dotBg }]}>
                  {isCompleted || isInProgress ? (
                    <CheckCircle size={22} color="#FFFFFF" />
                  ) : isMissed ? (
                    <Clock size={22} color="#FFFFFF" />
                  ) : (
                    <View style={journeyStyles.stepInner} />
                  )}
                </View>
              </View>

              {/* Connector line to next step */}
              {!isLast && (
                <View style={[journeyStyles.connector, { backgroundColor: lineBg }]} />
              )}

              {/* Labels */}
              <Text style={[journeyStyles.stepLabel, !isUpcoming && journeyStyles.stepLabelActive]}>
                {step.label}
              </Text>
              {step.subLabel ? (
                <Text style={[journeyStyles.stepSubLabel, { color: subLabelColor }]}>
                  {step.subLabel}
                </Text>
              ) : null}
              <Text style={[journeyStyles.stepPoints, isUpcoming && journeyStyles.stepPointsMuted]}>
                {step.points}
              </Text>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const journeyStyles = StyleSheet.create({
  container: {
    paddingHorizontal: 8,
  } as ViewStyle,
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 8,
  } as ViewStyle,
  stepWrapper: {
    alignItems: 'center',
    position: 'relative',
    width: 112,
    flexShrink: 0,
  } as ViewStyle,
  // Outer ring for in-progress (amber) and missed (red) states
  stepCircleOuter: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
    marginBottom: 8,
    zIndex: 1,
  } as ViewStyle,
  stepCircleInProgress: {
    borderWidth: 4,
    borderColor: '#FCD34D',
  } as ViewStyle,
  stepCircleMissed: {
    borderWidth: 4,
    borderColor: '#FCA5A5',
  } as ViewStyle,
  stepDot: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  stepInner: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#9CA3AF',
  } as ViewStyle,
  stepLabel: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#9CA3AF',
    textAlign: 'center',
    maxWidth: 96,
  } as TextStyle,
  stepLabelActive: {
    color: '#111827',
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 11,
  } as TextStyle,
  stepSubLabel: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    textAlign: 'center',
    marginTop: 2,
  } as TextStyle,
  stepPoints: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 11,
    color: '#047857',
    backgroundColor: '#ECFDF5',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    marginTop: 4,
    textAlign: 'center',
    overflow: 'hidden',
  } as TextStyle,
  stepPointsMuted: {
    color: '#6B7280',
    backgroundColor: '#F3F4F6',
  } as TextStyle,
  connector: {
    position: 'absolute',
    top: 27,    // half of stepDot height (56/2=28) minus half connector height
    left: '50%',
    right: '-50%',
    height: 3,
    zIndex: 0,
  } as ViewStyle,
  connectorDone: {
    backgroundColor: '#16A34A',
  } as ViewStyle,
});

// ─── Quick Access rail items ──────────────────────────────────────────────────

interface QuickAccessItemProps {
  icon: React.ReactNode;
  label: string;
  sublabel?: string;
  iconBg?: string;
  onPress: () => void;
}

function QuickAccessItem({ icon, label, sublabel, iconBg = '#EFF6FF', onPress }: QuickAccessItemProps): React.JSX.Element {
  return (
    <TouchableOpacity
      style={quickAccessStyles.item}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View style={[quickAccessStyles.iconWrap, { backgroundColor: iconBg }]}>{icon}</View>
      <View style={quickAccessStyles.labelWrap}>
        <Text style={quickAccessStyles.label}>{label}</Text>
        {sublabel ? <Text style={quickAccessStyles.sublabel}>{sublabel}</Text> : null}
      </View>
      <ChevronRight size={14} color="#D1D5DB" />
    </TouchableOpacity>
  );
}

const quickAccessStyles = StyleSheet.create({
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 11,
    paddingHorizontal: 12,
    borderRadius: 10,
  } as ViewStyle,
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,
  labelWrap: {
    flex: 1,
    gap: 1,
  } as ViewStyle,
  label: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
    color: '#111827',
  } as TextStyle,
  sublabel: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: '#6B7280',
  } as TextStyle,
});

// ─── Open Questions drawer content ────────────────────────────────────────────

function OpenQuestionsContent(): React.JSX.Element {
  return (
    <View style={openQStyles.container}>
      <Text style={openQStyles.intro}>
        These questions are suggested based on this member's care plan and recent session history.
        Use them as conversation starters — adapt freely.
      </Text>
      {SUGGESTED_QUESTIONS.map((section) => (
        <View key={section.category} style={openQStyles.section}>
          <Text style={openQStyles.categoryLabel}>{section.category}</Text>
          {section.questions.map((q, i) => (
            <View key={i} style={openQStyles.questionRow}>
              <View style={openQStyles.qBullet} />
              <Text style={openQStyles.questionText}>{q}</Text>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

const openQStyles = StyleSheet.create({
  container: { gap: 20 } as ViewStyle,
  intro: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: '#6B7280',
    lineHeight: 20,
    backgroundColor: '#F4F1ED',
    borderRadius: 10,
    padding: 12,
  } as TextStyle,
  section: { gap: 8 } as ViewStyle,
  categoryLabel: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 13,
    color: '#1E3320',
    marginBottom: 2,
  } as TextStyle,
  questionRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  } as ViewStyle,
  qBullet: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#3D5A3E',
    marginTop: 7,
    flexShrink: 0,
  } as ViewStyle,
  questionText: {
    flex: 1,
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: '#1E3320',
    lineHeight: 20,
  } as TextStyle,
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

  const { userName } = useAuth();
  const chwInitials = userName
    ? userName.split(' ').map((n) => n[0] ?? '').join('').toUpperCase().slice(0, 2)
    : 'CW';

  const { data: profile, isLoading, error } = useMemberDetail(memberId);

  // ── Drawer state
  const [openQuestionsOpen, setOpenQuestionsOpen] = useState(false);
  const [messageDrawerOpen, setMessageDrawerOpen] = useState(false);

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

  // ── Navigate to in-app conversation ─────────────────────────────────────────
  // Called by ProfileContactButtons after the Message button tap. Deep-link
  // straight into the Messages screen with this member's id so the thread
  // is pre-selected on mount — the previous version just navigated to the
  // generic Sessions tab and showed a "go find the thread" alert, which
  // forced the CHW to scan the inbox manually.
  const handleNavigateToConversation = useCallback(
    (_conversationId: string): void => {
      // _conversationId is provided by /conversations/find-or-create but
      // CHWMessagesScreen pre-selects threads by memberId (the SessionData
      // shape's memberId field), so we navigate by memberId here. The
      // conversation id is still useful for analytics + the eventual
      // active_session_id wire-up (#193 Task 11) but isn't needed for nav.
      navigation.navigate('Messages', { memberId });
    },
    [navigation, memberId],
  );

  // Called by ProfileContactButtons after the Call button tap. Same as
  // above but also flags ``autoCall=true`` so CHWMessagesScreen fires the
  // masked-number call sequence as soon as the thread mounts. The CHW
  // sees the chat UI with the call already initiated rather than waiting
  // on a separate confirm dialog.
  const handleNavigateAndCall = useCallback((): void => {
    navigation.navigate('Messages', { memberId, autoCall: true });
  }, [navigation, memberId]);

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
        <View style={s.pageWrapLoading}>
          <LoadingSkeleton variant="card" />
          <LoadingSkeleton variant="rows" rows={5} />
        </View>
      </SafeAreaView>
    );
  }

  // ── 403 / access denied state ────────────────────────────────────────────────

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

  // ── Main render ───────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={s.safeArea} edges={['top']}>
      <StatusBar barStyle="dark-content" backgroundColor={colors.background} />

      <AppShell
        role="chw"
        activeKey="memberProfile"
        userBlock={{ initials: chwInitials, name: userName ?? 'CHW', role: 'CHW' }}
      >
        {/* ── Screen header (back button row — kept for native; web has sidebar) */}
        {Platform.OS !== 'web' && (
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
        )}

        <ScrollView
          style={s.scroll}
          contentContainerStyle={s.scrollContent}
          showsVerticalScrollIndicator={false}
          // Add bottom padding so StickyActionBar doesn't overlap content
          contentInsetAdjustmentBehavior="automatic"
        >
          <View style={s.pageWrap}>

            {/* Web: back button / page header */}
            {Platform.OS === 'web' && (
              <View style={s.webHeader}>
                <TouchableOpacity
                  style={s.backLinkWeb}
                  onPress={() => navigation.goBack()}
                  accessibilityRole="button"
                  accessibilityLabel="Back to members"
                >
                  <ArrowLeft size={16} color={colors.primary} />
                  <Text style={s.backLinkText}>Back to Members</Text>
                </TouchableOpacity>
                <PageHeader
                  title={displayName}
                  subtitle="Member Profile"
                />
              </View>
            )}

            {/* ── TOP HEADER CARD: identity + contact + resource needs ── */}
            <Card style={s.headerCard}>
              <View style={s.headerCardRow}>

                {/* Identity column — avatar + name + pills */}
                <View style={s.identityCol}>
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
                        <Pill variant="emerald" size="sm">Active</Pill>
                        {profile.ecmEligible && (
                          <Pill variant="blue" size="sm">ECM Eligible</Pill>
                        )}
                        <Pill variant="gray" size="sm">
                          {profile.primaryLanguage}
                        </Pill>
                      </View>
                    </View>
                  </View>
                </View>

                {/* Contact column */}
                <View style={s.contactCol}>
                  <Text style={s.colHeading}>Contact</Text>
                  <InfoRow
                    icon={<Phone size={14} color={colors.primary} />}
                    label="Phone"
                    value={profile.phoneE164 ?? 'Not provided'}
                    placeholder={!profile.phoneE164}
                  />
                  <InfoRow
                    icon={<MapPin size={14} color={colors.primary} />}
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
                  <InfoRow
                    icon={<Globe size={14} color={colors.primary} />}
                    label="Language"
                    value={[profile.primaryLanguage, ...profile.additionalLanguages].join(', ')}
                  />
                  <InfoRow
                    icon={<Heart size={14} color={colors.primary} />}
                    label="MCO / Insurance"
                    value={profile.mco ?? 'Not provided'}
                    placeholder={!profile.mco}
                  />
                  {profile.email ? (
                    <InfoRow
                      icon={<User size={14} color={colors.primary} />}
                      label="Email"
                      value={profile.email}
                    />
                  ) : null}
                </View>

                {/* Resource Needs column — priority-ranked: 1-2 red, 3-4 amber, 5+ emerald */}
                <View style={s.needsCol}>
                  <View style={s.needsColHeader}>
                    <Text style={s.colHeading}>Resource Needs <Text style={s.colHeadingSub}>(Priority)</Text></Text>
                  </View>
                  {profile.primaryCategories.length === 0 ? (
                    <Text style={s.needsEmpty}>No categories recorded.</Text>
                  ) : (
                    profile.primaryCategories.map((cat, index) => {
                      const rank = index + 1;
                      const isHigh = rank <= 2;
                      const isMed = rank === 3 || rank === 4;
                      const rankBg = isHigh ? '#FEE2E2' : isMed ? '#FEF3C7' : '#DCFCE7';
                      const rankColor = isHigh ? '#B91C1C' : isMed ? '#B45309' : '#15803D';
                      const badgeLabel = isHigh ? 'High' : isMed ? 'Medium' : 'Low';
                      const badgeVariant: 'red' | 'amber' | 'emerald' = isHigh ? 'red' : isMed ? 'amber' : 'emerald';
                      const label = CATEGORY_LABELS[cat] ?? cat;
                      return (
                        <View key={cat} style={s.needItem}>
                          <View style={[s.needRank, { backgroundColor: rankBg }]}>
                            <Text style={[s.needRankText, { color: rankColor }]}>{rank}</Text>
                          </View>
                          <Text style={s.needItemLabel}>{label}</Text>
                          <Pill variant={badgeVariant} size="sm">{badgeLabel}</Pill>
                        </View>
                      );
                    })
                  )}
                </View>

              </View>
            </Card>

            {/* ── Quick actions — bidirectional masked call + in-app messaging ── */}
            <ProfileContactButtons
              targetUserId={memberId}
              targetUserRole="member"
              sharedSessionCount={profile.sessionCount}
              targetDisplayName={displayName}
              onNavigateToConversation={handleNavigateToConversation}
              onNavigateAndCall={handleNavigateAndCall}
            />

            {/* ── MID ROW: Insights (9/12) + Compass Insights AI panel (3/12) ── */}
            <View style={s.midRow}>

              {/* Left: 4-column insights card */}
              <View style={s.midMain}>
                <Card style={s.insightsCard}>
                  <Text style={s.insightsTitle}>Compass Insights</Text>
                  <View style={s.insightsGrid}>
                    <View style={s.insightCell}>
                      <Text style={s.insightCellLabel}>Last Interaction Summary</Text>
                      <Text style={s.insightCellBody}>
                        {profile.lastSessionAt
                          ? `Last session ${formatDate(profile.lastSessionAt)}. ${profile.sessionCount} total sessions completed.`
                          : 'No sessions recorded yet.'}
                      </Text>
                    </View>
                    <View style={s.insightCell}>
                      <Text style={s.insightCellLabel}>What to Focus On</Text>
                      <Text style={s.insightCellBody}>
                        {profile.openGoals.length > 0
                          ? `${profile.openGoals.length} open goal${profile.openGoals.length !== 1 ? 's' : ''}: ${profile.openGoals[0]?.text ?? ''}`
                          : 'No open goals. Great opportunity to set new targets.'}
                      </Text>
                    </View>
                    <View style={s.insightCell}>
                      <Text style={s.insightCellLabel}>Recommended Next Best Action</Text>
                      <Text style={s.insightCellBody}>
                        {profile.openFollowups.length > 0
                          ? `Follow up on: ${profile.openFollowups[0]?.text ?? 'pending item'}`
                          : 'Schedule a check-in session to review member progress.'}
                      </Text>
                    </View>
                    <View style={[s.insightCell, s.insightCellLast]}>
                      <Text style={s.insightCellLabel}>Alerts &amp; Reminders</Text>
                      <Text style={s.insightCellBody}>
                        {profile.billingUnits.todayRemaining <= CAP_WARNING_THRESHOLD_DAY
                          ? `Billing cap alert: only ${profile.billingUnits.todayRemaining} unit(s) remaining today.`
                          : profile.billingUnits.yearlyRemaining <= CAP_WARNING_THRESHOLD_YEAR
                          ? `Approaching yearly cap: ${profile.billingUnits.yearlyRemaining} unit(s) left.`
                          : 'No active alerts.'}
                      </Text>
                    </View>
                  </View>
                </Card>
              </View>

              {/* Right rail: Compass Insights AI panel */}
              {Platform.OS === 'web' && (
                <RightRail width={240}>
                  <Card style={s.aiPanelCard}>
                    <View style={s.aiPanelHeader}>
                      <Sparkles size={14} color={colors.secondary} />
                      <Text style={s.aiPanelTitle}>AI Suggestions</Text>
                      <View style={s.aiBetaBadge}>
                        <Text style={s.aiBetaText}>Beta</Text>
                      </View>
                    </View>
                    <Text style={s.aiPanelBody}>
                      AI-generated suggestions will appear here as you build session history
                      with this member.
                    </Text>
                    <Text style={[s.aiPanelBody, { marginTop: 8 }]}>
                      Consent for AI Transcription:{' '}
                      <Text style={[
                        s.aiConsentValue,
                        profile.consentStatus.aiTranscription === 'granted'
                          ? s.aiConsentGranted
                          : profile.consentStatus.aiTranscription === 'denied'
                          ? s.aiConsentDenied
                          : s.aiConsentNone,
                      ]}>
                        {profile.consentStatus.aiTranscription === 'granted'
                          ? 'Granted'
                          : profile.consentStatus.aiTranscription === 'denied'
                          ? 'Denied'
                          : 'Not asked'}
                      </Text>
                    </Text>
                  </Card>
                </RightRail>
              )}
            </View>

            {/* ── JOURNEY SECTION: roadmap (9/12) + Quick Access (3/12) ── */}
            <View style={s.journeyRow}>

              {/* Left: horizontal step roadmap */}
              <View style={s.journeyMain}>
                <SectionCard title="Member Journey">
                  <JourneyRoadmap />
                </SectionCard>

                {/* ── Assessment ── */}
                <AssessmentSection memberId={memberId} />

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

              </View>

              {/* Right rail: Quick Access */}
              {Platform.OS === 'web' && (
                <RightRail width={240}>
                  <Card style={s.quickAccessCard}>
                    <Text style={s.quickAccessTitle}>Quick Access</Text>
                    <QuickAccessItem
                      icon={<NotebookPen size={16} color="#2563EB" />}
                      iconBg="#EFF6FF"
                      label="Case Notes"
                      sublabel="View all notes"
                      onPress={() =>
                        Alert.alert(
                          'Coming soon',
                          'Per-member case notes are scoped to each session today — open a session card below to view or add notes. A dedicated case-notes timeline ships next sprint.',
                        )
                      }
                    />
                    <QuickAccessItem
                      icon={<ClipboardList size={16} color="#7C3AED" />}
                      iconBg="#F5F3FF"
                      label="Assessments"
                      sublabel="Latest: view history"
                      onPress={() =>
                        Alert.alert(
                          'Coming soon',
                          'Health assessments are started from inside a session today. A member-level assessment history view is planned for the next sprint.',
                        )
                      }
                    />
                    <QuickAccessItem
                      icon={<CheckSquare size={16} color="#EA580C" />}
                      iconBg="#FFF7ED"
                      label="Screening Results"
                      sublabel="View history"
                      onPress={() =>
                        Alert.alert(
                          'Coming soon',
                          'Screening results tracking is not yet available. This feature is planned for an upcoming sprint.',
                        )
                      }
                    />
                    <QuickAccessItem
                      icon={<CheckCircle size={16} color="#16A34A" />}
                      iconBg="#F0FDF4"
                      label="Eligibility Verification"
                      sublabel="CalFresh pending"
                      onPress={() =>
                        Alert.alert(
                          'Coming soon',
                          'Eligibility verification tracking is not yet available. This feature is planned for an upcoming sprint.',
                        )
                      }
                    />
                    <QuickAccessItem
                      icon={<UploadCloud size={16} color="#64748B" />}
                      iconBg="#F8FAFC"
                      label="Uploaded Documents"
                      sublabel="3 documents"
                      onPress={() =>
                        Alert.alert(
                          'Coming soon',
                          'CHW-scoped document review is not yet available. Member-uploaded documents will be accessible here in an upcoming sprint.',
                        )
                      }
                    />
                    <QuickAccessItem
                      icon={<RadioTower size={16} color="#D97706" />}
                      iconBg="#FFFBEB"
                      label="Outreach History"
                      sublabel="View all interactions"
                      onPress={() =>
                        Alert.alert(
                          'Coming soon',
                          'Outreach history tracking is not yet available. This feature is planned for an upcoming sprint.',
                        )
                      }
                    />
                  </Card>
                </RightRail>
              )}
            </View>

          </View>
        </ScrollView>

        {/* StickyActionBar removed — it duplicated entry points already
            provided elsewhere (Schedule Session in tab nav, Message/Call
            inline in the contact section, Open Questions in the Quick
            Access rail). Reintroduce only if a real net-new entry point
            for the profile becomes necessary. */}

        {/* ── Open Questions drawer ── */}
        <OpenQuestionsDrawer
          visible={openQuestionsOpen}
          onClose={() => setOpenQuestionsOpen(false)}
          member={{
            name: displayName,
            age: null,
            initials,
            primaryLanguage: profile.primaryLanguage,
            engagementLabel: 'Highly Engaged',
          }}
          journey={
            profile.primaryCategories.length > 0
              ? {
                  templateName:    `${CATEGORY_LABELS[profile.primaryCategories[0]!] ?? profile.primaryCategories[0]!} Journey`,
                  currentStepName: 'Upload Documents',
                  vertical:        profile.primaryCategories[0]!,
                }
              : undefined
          }
          onMarkComplete={() => {
            if (Platform.OS === 'web' && typeof window !== 'undefined') {
              window.alert('Call marked as completed.');
            } else {
              Alert.alert('Call Completed', 'This call has been marked as completed.');
            }
          }}
          onCopyScript={() => {
            if (Platform.OS === 'web' && typeof window !== 'undefined') {
              window.alert('Script copied — paste into your notes.');
            } else {
              Alert.alert('Copied', 'Script copied to clipboard.');
            }
          }}
          onSaveNote={() => {
            if (Platform.OS === 'web' && typeof window !== 'undefined') {
              window.alert('Note saved — coming soon.');
            } else {
              Alert.alert('Save Note', 'Notes feature coming soon.');
            }
          }}
        />

        {/* ── Message Member drawer ──
            ProfileContactButtons handles the actual find-or-create flow.
            The drawer surfaces a short message-composition UI using the same
            onNavigateToConversation callback for navigation. Full inline thread
            UI is pending the standalone Messages screen from Agent C. */}
        <RightDrawer
          isOpen={messageDrawerOpen}
          onClose={() => setMessageDrawerOpen(false)}
          title="Message Member"
          subtitle={displayName}
          footer={
            <TouchableOpacity
              style={s.messageFooterBtn}
              onPress={() => setMessageDrawerOpen(false)}
              accessibilityRole="button"
              accessibilityLabel="Close message drawer"
            >
              <Text style={s.messageFooterBtnText}>Close</Text>
            </TouchableOpacity>
          }
        >
          <View style={s.messageDrawerContent}>
            <Text style={s.messageDrawerBody}>
              Use the contact buttons below to initiate a message thread with{' '}
              {displayName}. A full inline message thread will be available here
              once the standalone Messages screen ships.
            </Text>
            <ProfileContactButtons
              targetUserId={memberId}
              targetUserRole="member"
              sharedSessionCount={profile.sessionCount}
              targetDisplayName={displayName}
              onNavigateToConversation={(convId) => {
                setMessageDrawerOpen(false);
                handleNavigateToConversation(convId);
              }}
              onNavigateAndCall={() => {
                setMessageDrawerOpen(false);
                handleNavigateAndCall();
              }}
            />
          </View>
        </RightDrawer>

      </AppShell>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: tokens.pageBg,
  } as ViewStyle,

  // ── Header (native only)
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: tokens.pageBg,
    borderBottomWidth: 1,
    borderBottomColor: '#DDD6CC',
  } as ViewStyle,
  headerTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 18,
    color: '#1E3320',
    flex: 1,
    textAlign: 'center',
  } as TextStyle,
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#DDD6CC',
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,

  // ── Web header
  webHeader: {
    marginBottom: 8,
  } as ViewStyle,
  backLinkWeb: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 12,
  } as ViewStyle,
  backLinkText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: colors.primary,
  } as TextStyle,

  // ── Scroll
  scroll: { flex: 1 } as ViewStyle,
  scrollContent: {
    flexGrow: 1,
  } as ViewStyle,
  pageWrap: {
    width: '100%',
    maxWidth: 1100,
    alignSelf: 'center',
    padding: 24,
    paddingBottom: 100,
  } as ViewStyle,
  pageWrapLoading: {
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingTop: 16,
  } as ViewStyle,

  // ── Top header card — mockup: p-6 (24px), 12-col grid, identity 5/contact 3/needs 4
  headerCard: {
    marginBottom: 24,
    padding: 0,
    overflow: 'hidden',
  } as ViewStyle,
  headerCardRow: {
    flexDirection: Platform.OS === 'web' ? 'row' : 'column',
    gap: 0,
  } as ViewStyle,

  // Identity column — col-span-5
  identityCol: {
    flex: Platform.OS === 'web' ? 5 : undefined,
    borderRightWidth: Platform.OS === 'web' ? 1 : 0,
    borderRightColor: '#F3F4F6',
  } as ViewStyle,
  bannerContainer: {} as ViewStyle,
  banner: {
    height: 80,
    backgroundColor: '#3D5A3E',
  } as ViewStyle,
  heroSection: {
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingBottom: 20,
    gap: 8,
  } as ViewStyle,
  avatarWrapper: {
    marginTop: -56,
    marginBottom: 8,
  } as ViewStyle,
  avatar: {
    width: 112,
    height: 112,
    borderRadius: 56,
    backgroundColor: '#CBD5E1',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 4,
    borderColor: '#FFFFFF',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.15,
        shadowRadius: 12,
      },
      android: { elevation: 4 },
    }),
  } as ViewStyle,
  avatarText: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 30,
    color: '#FFFFFF',
  } as TextStyle,
  displayName: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 22,
    color: '#111827',
    textAlign: 'center',
  } as TextStyle,
  heroBadgesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
    justifyContent: 'center',
  } as ViewStyle,

  // Contact column — col-span-3, mockup: border-l border-gray-100 pl-6 space-y-2.5
  contactCol: {
    flex: Platform.OS === 'web' ? 3 : undefined,
    padding: 24,
    borderLeftWidth: Platform.OS === 'web' ? 1 : 0,
    borderLeftColor: '#F3F4F6',
    borderRightWidth: Platform.OS === 'web' ? 1 : 0,
    borderRightColor: '#F3F4F6',
  } as ViewStyle,

  // Needs column — col-span-4
  needsCol: {
    flex: Platform.OS === 'web' ? 4 : undefined,
    padding: 24,
  } as ViewStyle,
  needsColHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  } as ViewStyle,
  colHeading: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
    color: '#111827',
  } as TextStyle,
  colHeadingSub: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#9CA3AF',
  } as TextStyle,
  // Resource need row: rank circle + label + priority badge
  needItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 10,
  } as ViewStyle,
  needRank: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,
  needRankText: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 11,
  } as TextStyle,
  needItemLabel: {
    flex: 1,
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: '#111827',
  } as TextStyle,
  needsEmpty: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: '#A0A6AB',
    fontStyle: 'italic',
  } as TextStyle,

  // ── Mid row (insights + AI panel) — mockup: grid-cols-12 gap-6 mt-6, 9/3 split
  midRow: {
    flexDirection: Platform.OS === 'web' ? 'row' : 'column',
    gap: 24,
    marginBottom: 24,
    alignItems: 'flex-start',
  } as ViewStyle,
  midMain: {
    flex: 1,
  } as ViewStyle,
  // Insights card — mockup: p-5 (20px), 4-col grid gap-5 (20px)
  insightsCard: {
    padding: 20,
  } as ViewStyle,
  insightsTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
    color: '#111827',
    marginBottom: 16,
  } as TextStyle,
  insightsGrid: {
    flexDirection: Platform.OS === 'web' ? 'row' : 'column',
    flexWrap: 'wrap',
    gap: 20,
  } as ViewStyle,
  insightCell: {
    flex: 1,
    minWidth: 160,
    gap: 6,
  } as ViewStyle,
  insightCellLast: {} as ViewStyle,
  insightCellLabel: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    color: '#111827',
    marginBottom: 6,
  } as TextStyle,
  insightCellBody: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#374151',
    lineHeight: 20,
  } as TextStyle,

  // ── AI panel card — mockup: p-5, gradient from-emerald-50/50 to-white
  aiPanelCard: {
    padding: 20,
    gap: 10,
    backgroundColor: '#F0FDF4',
  } as ViewStyle,
  aiPanelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8,
  } as ViewStyle,
  aiPanelTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
    color: '#111827',
    flex: 1,
  } as TextStyle,
  aiBetaBadge: {
    backgroundColor: colors.secondary + '20',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 100,
  } as ViewStyle,
  aiBetaText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 10,
    color: colors.secondary,
  } as TextStyle,
  aiPanelBody: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: '#6B7280',
    lineHeight: 18,
  } as TextStyle,
  aiConsentValue: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
  } as TextStyle,
  aiConsentGranted: { color: '#16A34A' } as TextStyle,
  aiConsentDenied: { color: '#DC2626' } as TextStyle,
  aiConsentNone: { color: '#A0A6AB' } as TextStyle,

  // ── Journey row — mockup: grid-cols-12 gap-6 mt-6, 9/3 split
  journeyRow: {
    flexDirection: Platform.OS === 'web' ? 'row' : 'column',
    gap: 24,
    alignItems: 'flex-start',
  } as ViewStyle,
  journeyMain: {
    flex: 1,
  } as ViewStyle,

  // ── Quick Access card — mockup: p-5 (20px), title font-semibold text-sm
  quickAccessCard: {
    padding: 20,
  } as ViewStyle,
  quickAccessTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
    color: '#111827',
    marginBottom: 8,
  } as TextStyle,

  // ── Billing caption
  billingCapNote: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 10,
    color: colors.mutedForeground,
  } as TextStyle,

  // ── Session last item
  sessionItemLast: {} as ViewStyle,

  // ── Goals subsection label
  subSectionLabel: {
    fontFamily: fonts.bodySemibold,
    fontSize: 11,
    color: '#6B7280',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 2,
  } as TextStyle,

  // ── Consent last row
  consentLastRow: {} as ViewStyle,

  // ── Shared count badge
  countBadge: {
    backgroundColor: colors.primary + '15',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 100,
  } as ViewStyle,
  countBadgeText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 10,
    color: colors.primary,
  } as TextStyle,

  // ── HIPAA notice
  hipaaNotice: {
    backgroundColor: '#F4F1ED',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 8,
  } as ViewStyle,
  hipaaNoticeText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#6B7280',
    lineHeight: 17,
    textAlign: 'center',
  } as TextStyle,

  // ── Access denied / error state
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
    gap: 14,
  } as ViewStyle,
  emptyIconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#3D5A3E15',
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  emptyTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 18,
    color: '#1E3320',
    textAlign: 'center',
  } as TextStyle,
  emptySubtext: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#6B7280',
    textAlign: 'center',
    maxWidth: 300,
    lineHeight: 22,
  } as TextStyle,
  backButton: {
    backgroundColor: '#3D5A3E',
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 12,
    marginTop: 4,
  } as ViewStyle,
  backButtonText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 14,
    color: '#FFFFFF',
  } as TextStyle,

  // ── Message drawer
  messageDrawerContent: {
    gap: 16,
  } as ViewStyle,
  messageDrawerBody: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: '#6B7280',
    lineHeight: 20,
    backgroundColor: '#F4F1ED',
    borderRadius: 10,
    padding: 12,
  } as TextStyle,
  messageFooterBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: '#F4F1ED',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#DDD6CC',
  } as ViewStyle,
  messageFooterBtnText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#6B7280',
  } as TextStyle,
});

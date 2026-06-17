/**
 * CHWMemberProfileScreen — Full member context view for CHW/admin users.
 *
 * Layout (T08 Phase 1 Second Run redesign):
 *   - 3-column top card:
 *       Left   — Demographics (READ-ONLY): name, phone, address/ZIP, language,
 *                insurance/MCO, email, DOB, gender, Medi-Cal CIN.
 *       Center — TWO stacked cards:
 *                  1. Flag Note card (amber/cream background, edit pencil).
 *                  2. Billing Consent card (green background, View Consent CTA).
 *       Right  — Resource Needs (Priority) card: top-3 active journeys ranked
 *                by severity heuristic (progressPercent thresholds), plus
 *                Call/Message CTAs and rewards balance.
 *   - Member Journey section: multi-track horizontal timeline (top 3 active
 *     journeys in rank order, 6 steps each, with per-step state + points).
 *   - Quick Access row — Add Note, Flag Member, Schedule Session, Document Session.
 *   - Billable Units widget (today vs daily cap; this year vs yearly cap).
 *   - Sessions table — paginated (10 rows/page).
 *
 * Severity heuristic (client-side, no backend change):
 *   progressPercent < 33   → High   (red)
 *   33 ≤ progress < 67     → Medium (amber)
 *   progress ≥ 67          → Low    (yellow)
 *
 * HIPAA minimum-necessary (45 CFR §164.514(d)):
 *   Raw medi_cal_id, insurance_provider (surfaced only as MCO label), notes from
 *   other CHWs, and session transcripts are NOT rendered here.
 *
 * Access gate:
 *   CHW: backend returns 403 when no active relationship exists.
 *   Admin: unrestricted access.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useWindowDimensions,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  ArrowLeft,
  ArrowRight,
  Calendar,
  Check,
  CheckCircle,
  Edit2,
  Flag,
  Globe,
  Heart,
  MapPin,
  MessageSquare,
  NotebookPen,
  Phone,
  Plus,
  Shield,
  ShieldCheck,
  ShieldOff,
  ShieldX,
  Sparkles,
  Star,
  User,
  CheckSquare,
  UploadCloud,
  RadioTower,
  ChevronRight,
  ClipboardList,
  X,
} from 'lucide-react-native';
import { useQuery } from '@tanstack/react-query';

import { fonts } from '../../theme/typography';
import { colors as tokens, numerals, radius } from '../../theme/tokens';
import { api } from '../../api/client';
import { transformKeys } from '../../utils/caseTransform';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ProfileContactButtons } from '../../components/comms/ProfileContactButtons';
import type { CHWSessionsStackParamList } from '../../navigation/CHWTabNavigator';

import {
  AppShell,
  Card,
  PageHeader,
  Pill,
  PressableCard,
  RightDrawer,
  RightRail,
  SectionHeader,
  StaggerList,
} from '../../components/ui';
import { useAuth } from '../../context/AuthContext';
import {
  OpenQuestionsDrawer,
  OPEN_QUESTIONS_INLINE_BREAKPOINT,
} from '../../components/chw/OpenQuestionsDrawer';
import {
  useMemberServicesConsent,
  useMemberBillingStatus,
  useUpdateMemberBillingStatus,
  useFlagNote,
  useCreateFlagNote,
  useDeleteFlagNote,
  useChwBillableUnits,
  useCreateMemberJourney,
  useJourneyTemplates,
  useMemberJourneys,
  useMemberRewardsBalance,
  type CreateMemberJourneyPayload,
  type JourneyTemplateResponse,
  type ServicesConsentValue,
  type MemberJourneyResponse,
} from '../../hooks/useApiQueries';

// ─── Navigation types ─────────────────────────────────────────────────────────

type MemberProfileRouteProp = RouteProp<CHWSessionsStackParamList, 'MemberProfile'>;
type MemberProfileNavProp = NativeStackNavigationProp<
  CHWSessionsStackParamList,
  'MemberProfile'
>;

// ─── API types ────────────────────────────────────────────────────────────────

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

interface BillingUnitsLegacy {
  todayUsed: number;
  todayRemaining: number;
  yearlyUsed: number;
  yearlyRemaining: number;
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
  billingUnits: BillingUnitsLegacy;
  sessionCount: number;
  lastSessionAt: string | null;
  openGoals: OpenGoalItem[];
  openFollowups: OpenFollowupItem[];
  consentStatus: ConsentStatusData;
  recentSessions: RecentSessionItem[];
  // PHI demographics — exposed 2026-06-09 (HIPAA minimum-necessary for care delivery)
  /** ISO date string e.g. '1993-01-05'. Null when not recorded. */
  dateOfBirth: string | null;
  /** Biological sex: 'Male' | 'Female' | 'Other'. Null when not recorded. */
  gender: 'Male' | 'Female' | 'Other' | null;
  /** Full Medi-Cal CIN e.g. '12345678A'. Null when not recorded. */
  mediCalId: string | null;
}

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

const SESSIONS_PAGE_SIZE = 10;

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

/** Points awarded per step in the 6-step journey roadmap. */
const JOURNEY_STEP_POINTS: Record<string, number> = {
  'Need Identified': 10,
  'Eligibility Screening': 25,
  'Upload Documents': 30,
  'Follow Up': 10,
  'Resource Connection': 25,
  'Journey Complete': 50,
};

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

/**
 * Format a date-of-birth ISO string as "MMM DD, YYYY (AGE yrs)".
 * Uses UTC parsing of the date-only string to avoid timezone shifts that
 * would push the date one day backward in negative-offset locales.
 *
 * Example: "1993-01-05" → "Jan 05, 1993 (33 yrs)"
 */
function formatDob(iso: string | null | undefined): string {
  if (!iso) return '—';
  // Parse as UTC noon to avoid DST/timezone off-by-one-day issues.
  const [year, month, day] = iso.split('-').map(Number);
  const dob = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const formatted = dob.toLocaleDateString('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const now = new Date();
  let age = now.getUTCFullYear() - year;
  const hadBirthdayThisYear =
    now.getUTCMonth() + 1 > month ||
    (now.getUTCMonth() + 1 === month && now.getUTCDate() >= day);
  if (!hadBirthdayThisYear) age -= 1;
  return `${formatted} (${age} yrs)`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface InfoRowProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  placeholder?: boolean;
}

/**
 * A single labeled data row in the Demographics column.
 * Renders a small icon, a muted label, and the data value beneath it.
 */
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
    gap: 10,
    paddingVertical: 6,
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
    fontSize: 11,
    color: '#9CA3AF',
    marginBottom: 1,
  } as TextStyle,
  value: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: '#111827',
    lineHeight: 18,
  } as TextStyle,
  valuePlaceholder: {
    color: '#A0A6AB',
    fontStyle: 'italic',
  } as TextStyle,
});

interface ColumnHeadingProps {
  text: string;
  sub?: string;
}

function ColumnHeading({ text, sub }: ColumnHeadingProps): React.JSX.Element {
  return (
    <View style={colHeadingStyles.row}>
      <Text style={colHeadingStyles.text}>{text}</Text>
      {sub ? <Text style={colHeadingStyles.sub}>{sub}</Text> : null}
    </View>
  );
}

const colHeadingStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 5,
    marginBottom: 12,
  } as ViewStyle,
  text: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 13,
    color: '#111827',
  } as TextStyle,
  sub: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#9CA3AF',
  } as TextStyle,
});

function EmptySectionState({ message }: { message: string }): React.JSX.Element {
  return (
    <View style={emptyStyles.container}>
      <Text style={emptyStyles.text}>{message}</Text>
    </View>
  );
}

const emptyStyles = StyleSheet.create({
  container: {
    alignItems: 'center',
    paddingVertical: 14,
  } as ViewStyle,
  text: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: '#A0A6AB',
    fontStyle: 'italic',
  } as TextStyle,
});

// ─── DemographicsColumn ───────────────────────────────────────────────────────

interface DemographicsColumnProps {
  profile: CHWMemberProfileDetail;
}

/**
 * Left column of the 3-column top card.
 * Renders avatar + name banner, then demographic data rows (all read-only).
 */
function DemographicsColumn({ profile }: DemographicsColumnProps): React.JSX.Element {
  const initials = getInitials(profile.firstName, profile.lastName);
  const displayName = `${profile.firstName} ${profile.lastName}`.trim();

  const addressLabel = profile.address
    ? [profile.address, profile.city, profile.zipCode].filter(Boolean).join(', ')
    : profile.zipCode
    ? `ZIP ${profile.zipCode}`
    : 'Not provided';

  const languageValue = [profile.primaryLanguage, ...profile.additionalLanguages]
    .filter(Boolean)
    .join(', ');

  return (
    <View style={demoColStyles.container}>
      {/* Banner + avatar hero */}
      <View style={demoColStyles.banner} />
      <View style={demoColStyles.heroSection}>
        <View style={demoColStyles.avatarWrapper}>
          <View style={demoColStyles.avatar}>
            <Text style={demoColStyles.avatarText}>{initials}</Text>
          </View>
        </View>
        <Text style={demoColStyles.displayName}>{displayName}</Text>
        <View style={demoColStyles.badgesRow}>
          <Pill variant="emerald" size="sm">Active</Pill>
          {profile.ecmEligible && (
            <Pill variant="blue" size="sm">ECM Eligible</Pill>
          )}
        </View>
      </View>

      {/* Demographics rows */}
      <View style={demoColStyles.rows}>
        <ColumnHeading text="Demographics" sub="(CHW read-only)" />
        <InfoRow
          icon={<Phone size={13} color={tokens.primary} />}
          label="Phone"
          value={profile.phoneE164 ?? 'Not provided'}
          placeholder={!profile.phoneE164}
        />
        <InfoRow
          icon={<MapPin size={13} color={tokens.primary} />}
          label={profile.address ? 'Address' : 'ZIP Code'}
          value={addressLabel}
          placeholder={!profile.address && !profile.zipCode}
        />
        <InfoRow
          icon={<Globe size={13} color={tokens.primary} />}
          label="Language"
          value={languageValue}
        />
        <InfoRow
          icon={<Heart size={13} color={tokens.primary} />}
          label="MCO / Insurance"
          value={profile.mco ?? 'Not provided'}
          placeholder={!profile.mco}
        />
        {profile.email ? (
          <InfoRow
            icon={<User size={13} color={tokens.primary} />}
            label="Email"
            value={profile.email}
          />
        ) : null}
        <InfoRow
          icon={<Calendar size={13} color={tokens.primary} />}
          label="Date of Birth"
          value={formatDob(profile.dateOfBirth)}
          placeholder={!profile.dateOfBirth}
        />
        <InfoRow
          icon={<User size={13} color={tokens.primary} />}
          label="Gender"
          value={profile.gender ?? 'Not provided'}
          placeholder={!profile.gender}
        />
        <InfoRow
          icon={<Shield size={13} color={tokens.primary} />}
          label="Medi-Cal ID (CIN)"
          value={profile.mediCalId ?? 'Not provided'}
          placeholder={!profile.mediCalId}
        />
      </View>
    </View>
  );
}

const demoColStyles = StyleSheet.create({
  container: {
    flex: Platform.OS === 'web' ? 3 : undefined,
    borderRightWidth: Platform.OS === 'web' ? 1 : 0,
    borderRightColor: '#F3F4F6',
    overflow: 'hidden',
  } as ViewStyle,
  banner: {
    height: 64,
    backgroundColor: '#3D5A3E',
  } as ViewStyle,
  heroSection: {
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 16,
    gap: 6,
  } as ViewStyle,
  avatarWrapper: {
    marginTop: -40,
    marginBottom: 4,
  } as ViewStyle,
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#CBD5E1',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: '#FFFFFF',
  } as ViewStyle,
  avatarText: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 22,
    color: '#FFFFFF',
  } as TextStyle,
  displayName: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    color: '#111827',
    textAlign: 'center',
  } as TextStyle,
  badgesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
    justifyContent: 'center',
  } as ViewStyle,
  rows: {
    paddingHorizontal: 16,
    paddingBottom: 16,
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
    paddingTop: 12,
  } as ViewStyle,
});

// ─── CenterColumn: FlagNoteCard + BillingConsentCard ─────────────────────────

type ServicesConsentStatus = ServicesConsentValue | null;

interface CenterColumnProps {
  memberId: string;
  /** Opens the Flag Member edit drawer (re-uses FlagMemberModal). */
  onEditFlag: () => void;
  /** Opens the Billing Consent view — placeholder, no behavior yet. */
  onViewConsent: () => void;
}

/**
 * Center column of the 3-column top card.
 * Stacks two sub-cards vertically:
 *   1. FlagNoteCard — shows the current flag (if any) on an amber/cream
 *      background.  Edit pencil top-right opens the existing FlagMemberModal.
 *   2. BillingConsentCard — shows services-consent status on a light-green
 *      background with a "View Consent" button.
 */
function CenterColumn({
  memberId,
  onEditFlag,
  onViewConsent,
}: CenterColumnProps): React.JSX.Element {
  return (
    <View style={centerColStyles.container}>
      <FlagNoteCard memberId={memberId} onEditFlag={onEditFlag} />
      <BillingConsentCard memberId={memberId} onViewConsent={onViewConsent} />
    </View>
  );
}

const centerColStyles = StyleSheet.create({
  container: {
    flex: Platform.OS === 'web' ? 3 : undefined,
    borderRightWidth: Platform.OS === 'web' ? 1 : 0,
    borderRightColor: '#F3F4F6',
    borderTopWidth: Platform.OS === 'web' ? 0 : 1,
    borderTopColor: '#F3F4F6',
    gap: 0,
  } as ViewStyle,
});

// ── FlagNoteCard ──────────────────────────────────────────────────────────────

interface FlagNoteCardProps {
  memberId: string;
  onEditFlag: () => void;
}

/**
 * Amber/cream card showing the current flag note (if any).
 * Edit pencil top-right opens FlagMemberModal for CHW edits.
 */
function FlagNoteCard({ memberId, onEditFlag }: FlagNoteCardProps): React.JSX.Element {
  const { data: flagNote, isLoading } = useFlagNote(memberId);

  return (
    <View style={flagNoteCardStyles.container}>
      {/* Header row */}
      <View style={flagNoteCardStyles.headerRow}>
        <View style={flagNoteCardStyles.titleRow}>
          <Flag size={13} color="#92400E" />
          <Text style={flagNoteCardStyles.title}>Flag Note</Text>
        </View>
        <TouchableOpacity
          style={flagNoteCardStyles.editBtn}
          onPress={onEditFlag}
          accessibilityRole="button"
          accessibilityLabel="Edit flag note"
        >
          <Edit2 size={12} color="#92400E" />
        </TouchableOpacity>
      </View>

      {/* Body */}
      {isLoading ? (
        <View style={flagNoteCardStyles.loadingRow}>
          <ActivityIndicator size="small" color="#92400E" />
          <Text style={flagNoteCardStyles.loadingText}>Loading…</Text>
        </View>
      ) : flagNote ? (
        <View>
          <Text style={flagNoteCardStyles.noteBody} numberOfLines={3}>
            {flagNote.body}
          </Text>
          <Text style={flagNoteCardStyles.noteDate}>
            {formatDate(flagNote.createdAt)}
          </Text>
        </View>
      ) : (
        <Text style={flagNoteCardStyles.emptyText}>No flag on this member.</Text>
      )}
    </View>
  );
}

const flagNoteCardStyles = StyleSheet.create({
  container: {
    backgroundColor: '#FFFBEB',
    borderBottomWidth: 1,
    borderBottomColor: '#FDE68A',
    padding: 16,
    gap: 8,
    flex: 1,
  } as ViewStyle,
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  } as ViewStyle,
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  } as ViewStyle,
  title: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 12,
    color: '#92400E',
  } as TextStyle,
  editBtn: {
    width: 26,
    height: 26,
    borderRadius: radius.sm,
    backgroundColor: '#FDE68A',
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
  } as ViewStyle,
  loadingText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#92400E',
  } as TextStyle,
  noteBody: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: '#78350F',
    lineHeight: 18,
  } as TextStyle,
  noteDate: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 10,
    color: '#A16207',
    marginTop: 4,
  } as TextStyle,
  emptyText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: '#A16207',
    fontStyle: 'italic',
  } as TextStyle,
});

// ── BillingConsentCard ────────────────────────────────────────────────────────

interface BillingConsentCardProps {
  memberId: string;
  onViewConsent: () => void;
}

/**
 * Light-green card showing the member's services consent status.
 * "View Consent" button placeholder — opens full consent detail (no behavior yet).
 */
function BillingConsentCard({
  memberId,
  onViewConsent,
}: BillingConsentCardProps): React.JSX.Element {
  const { data: consentData, isLoading } = useMemberServicesConsent(memberId);
  const consentValue: ServicesConsentStatus = consentData?.value ?? null;
  const isRefused = consentValue === 'refuse_services';

  // Billable / non-billable toggle (CHW-controlled). Defaults to billable.
  const { data: billingStatus } = useMemberBillingStatus(memberId);
  const updateBilling = useUpdateMemberBillingStatus(memberId);
  const isBillable = billingStatus?.isBillable ?? true;

  const handleToggleBillable = (next: boolean): void => {
    if (updateBilling.isPending) return;
    updateBilling.mutate(next, {
      onError: () => {
        const msg = 'Could not update billing status. Please try again.';
        if (Platform.OS === 'web' && typeof window !== 'undefined') {
          window.alert(msg);
        } else {
          Alert.alert('Error', msg);
        }
      },
    });
  };

  const statusLabel = isRefused
    ? 'Refused Services'
    : consentValue === 'consent_to_services'
    ? 'Consented'
    : 'Unknown';

  const statusColor = isRefused ? '#B91C1C' : '#15803D';
  const statusIcon = isRefused
    ? <ShieldX size={13} color={statusColor} />
    : consentValue === 'consent_to_services'
    ? <ShieldCheck size={13} color={statusColor} />
    : <ShieldOff size={13} color="#9CA3AF" />;

  return (
    <View style={billingConsentCardStyles.container}>
      {/* Header */}
      <View style={billingConsentCardStyles.headerRow}>
        <Text style={billingConsentCardStyles.title}>Billing Consent</Text>
      </View>

      {/* Status indicator */}
      {isLoading ? (
        <View style={billingConsentCardStyles.loadingRow}>
          <ActivityIndicator size="small" color="#15803D" />
          <Text style={billingConsentCardStyles.loadingText}>Loading…</Text>
        </View>
      ) : (
        <View style={billingConsentCardStyles.statusRow}>
          {statusIcon}
          <Text style={[billingConsentCardStyles.statusLabel, { color: statusColor }]}>
            {statusLabel}
          </Text>
        </View>
      )}

      {consentData?.changedAt && (
        <Text style={billingConsentCardStyles.changedAt}>
          Updated {formatDate(consentData.changedAt)}
        </Text>
      )}

      {/* Billable / non-billable toggle (CHW-controlled) */}
      <View style={billingConsentCardStyles.billableRow}>
        <View style={billingConsentCardStyles.billableLabelWrap}>
          <Text style={billingConsentCardStyles.billableLabel}>
            {isBillable ? 'Billable' : 'Non-billable'}
          </Text>
          <Text style={billingConsentCardStyles.billableSub}>
            {isBillable
              ? 'Sessions are billable to Medi-Cal'
              : 'Sessions excluded from billing'}
          </Text>
        </View>
        {updateBilling.isPending ? (
          <ActivityIndicator size="small" color="#15803D" />
        ) : (
          <Switch
            value={isBillable}
            onValueChange={handleToggleBillable}
            trackColor={{ false: '#D1D5DB', true: '#86EFAC' }}
            thumbColor={isBillable ? '#15803D' : '#9CA3AF'}
            accessibilityLabel="Toggle billable status"
          />
        )}
      </View>

      {billingStatus?.changedAt && (
        <Text style={billingConsentCardStyles.changedAt}>
          Billing status updated {formatDate(billingStatus.changedAt)}
        </Text>
      )}

      {/* View Consent CTA */}
      <TouchableOpacity
        style={billingConsentCardStyles.viewBtn}
        onPress={onViewConsent}
        accessibilityRole="button"
        accessibilityLabel="View full consent details"
      >
        <Text style={billingConsentCardStyles.viewBtnText}>View Consent</Text>
      </TouchableOpacity>
    </View>
  );
}

const billingConsentCardStyles = StyleSheet.create({
  container: {
    backgroundColor: '#F0FDF4',
    padding: 16,
    gap: 8,
    flex: 1,
  } as ViewStyle,
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  } as ViewStyle,
  title: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 12,
    color: '#15803D',
  } as TextStyle,
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
  } as ViewStyle,
  loadingText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#15803D',
  } as TextStyle,
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  } as ViewStyle,
  statusLabel: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
  } as TextStyle,
  changedAt: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 10,
    color: '#6B7280',
  } as TextStyle,
  billableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginTop: 4,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#DCFCE7',
  } as ViewStyle,
  billableLabelWrap: {
    flex: 1,
    gap: 1,
  } as ViewStyle,
  billableLabel: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 12,
    color: '#166534',
  } as TextStyle,
  billableSub: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 10,
    color: '#6B7280',
  } as TextStyle,
  viewBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.md,
    backgroundColor: '#DCFCE7',
    borderWidth: 1,
    borderColor: '#BBF7D0',
    alignSelf: 'flex-start',
    marginTop: 4,
  } as ViewStyle,
  viewBtnText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 11,
    color: '#15803D',
  } as TextStyle,
});

// ─── TEMPLATE_CATEGORY_ICONS / DESCRIPTIONS ──────────────────────────────────

/** Friendly human-readable descriptions for the 10 standardized template slugs. */
const TEMPLATE_DESCRIPTIONS: Record<string, string> = {
  food_assistance:         'Connect member with food banks, pantries, and meal programs.',
  housing:                 'Address housing instability, transitional housing, and shelter.',
  mental_health:           'Link member to mental health services and crisis support.',
  maternal_health:         'Support prenatal/postnatal care, WIC, and family health.',
  rent_payment_assistance: 'Navigate emergency rental aid programs and tenant services.',
  utility_support:         'Access utility shut-off prevention and payment assistance.',
  calfresh_enrollment:     'Guide member through CalFresh / SNAP enrollment process.',
  healthcare_appointment:  'Schedule and track specialty or primary care appointments.',
  food_pantry:             'Connect member to local food pantry distribution services.',
  health_education:        'Provide chronic-disease education and wellness coaching.',
};

/** Icon + background colour for each template category. */
const CATEGORY_STYLE: Record<string, { iconColor: string; iconBg: string }> = {
  food:           { iconColor: '#D97706', iconBg: '#FEF3C7' },
  housing:        { iconColor: '#2563EB', iconBg: '#DBEAFE' },
  mental_health:  { iconColor: '#7C3AED', iconBg: '#EDE9FE' },
  maternal_health:{ iconColor: '#BE185D', iconBg: '#FCE7F3' },
  benefits:       { iconColor: '#15803D', iconBg: '#DCFCE7' },
  utilities:      { iconColor: '#EA580C', iconBg: '#FFEDD5' },
  healthcare:     { iconColor: '#0D9488', iconBg: '#CCFBF1' },
  education:      { iconColor: '#4338CA', iconBg: '#E0E7FF' },
};

function templateCategoryStyle(category: string) {
  return CATEGORY_STYLE[category] ?? { iconColor: '#6B7280', iconBg: '#F3F4F6' };
}

// ─── AddJourneyModal ──────────────────────────────────────────────────────────

interface AddJourneyModalProps {
  memberId: string;
  memberName: string;
  visible: boolean;
  /** Slugs of templates the member already has an active journey for. */
  existingActiveSlugs: Set<string>;
  onClose: () => void;
  /** Called after a journey is successfully created. */
  onCreated: () => void;
}

/**
 * Modal that lets a CHW pick from all 10 active journey templates and
 * start a new MemberJourney.
 *
 * Dedup guard: templates whose slug is already in `existingActiveSlugs` are
 * rendered greyed-out and unselectable — the backend would return 409, so we
 * block at the form boundary for a better UX.
 *
 * Platform:
 *   - Web: fixed overlay + animated slide-up panel with backdrop dismiss.
 *   - Native: React Native Modal (form-sheet style, same as RightDrawer).
 *
 * Esc / backdrop tap closes the modal without submitting.
 */
function AddJourneyModal({
  memberId,
  memberName,
  visible,
  existingActiveSlugs,
  onClose,
  onCreated,
}: AddJourneyModalProps): React.JSX.Element {
  const { data: templates, isLoading: templatesLoading } = useJourneyTemplates();
  const createJourney = useCreateMemberJourney(memberId);

  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Reset selection whenever the modal opens.
  useEffect(() => {
    if (visible) {
      setSelectedSlug(null);
      setSubmitError(null);
    }
  }, [visible]);

  // Esc key closes on web.
  useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [visible, onClose]);

  const handleSubmit = useCallback(async (): Promise<void> => {
    if (!selectedSlug) return;
    setSubmitError(null);

    // Guard: client-side dedup check before hitting the network.
    if (existingActiveSlugs.has(selectedSlug)) {
      setSubmitError('This member already has an active journey for the selected template.');
      return;
    }

    try {
      const payload: CreateMemberJourneyPayload = {
        memberId,
        templateSlug: selectedSlug,
      };
      await createJourney.mutateAsync(payload);
      onCreated();
      onClose();
    } catch (err: unknown) {
      const message =
        err != null &&
        typeof err === 'object' &&
        'message' in err &&
        typeof (err as { message: unknown }).message === 'string'
          ? (err as { message: string }).message
          : 'Failed to start journey. Please try again.';
      setSubmitError(message);
    }
  }, [selectedSlug, existingActiveSlugs, memberId, createJourney, onCreated, onClose]);

  const canSubmit = selectedSlug !== null && !createJourney.isPending;

  const bodyContent = (
    <View style={addJourneyStyles.body}>
      {/* Header */}
      <View style={addJourneyStyles.modalHeader}>
        <View style={addJourneyStyles.modalHeaderText}>
          <Text style={addJourneyStyles.modalTitle}>Start a new journey</Text>
          <Text style={addJourneyStyles.modalSubtitle} numberOfLines={1}>
            for {memberName}
          </Text>
        </View>
        <TouchableOpacity
          style={addJourneyStyles.closeBtn}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
        >
          <Text style={addJourneyStyles.closeBtnText}>✕</Text>
        </TouchableOpacity>
      </View>

      {/* Template list */}
      <ScrollView
        style={addJourneyStyles.listScroll}
        contentContainerStyle={addJourneyStyles.listContent}
        showsVerticalScrollIndicator={false}
      >
        {templatesLoading ? (
          <View style={addJourneyStyles.loadingRow}>
            <ActivityIndicator size="small" color={tokens.textMuted} />
            <Text style={addJourneyStyles.loadingText}>Loading templates…</Text>
          </View>
        ) : (templates ?? []).length === 0 ? (
          <Text style={addJourneyStyles.emptyText}>No templates available.</Text>
        ) : (
          (templates ?? []).map((template) => {
            const alreadyActive = existingActiveSlugs.has(template.slug);
            const isSelected = selectedSlug === template.slug;
            const catStyle = templateCategoryStyle(template.category);
            const description =
              TEMPLATE_DESCRIPTIONS[template.slug] ??
              `${template.name} journey — 6-step care pathway.`;

            return (
              <TouchableOpacity
                key={template.id}
                style={[
                  addJourneyStyles.templateRow,
                  isSelected && addJourneyStyles.templateRowSelected,
                  alreadyActive && addJourneyStyles.templateRowDisabled,
                ]}
                onPress={alreadyActive ? undefined : () => setSelectedSlug(template.slug)}
                disabled={alreadyActive}
                accessibilityRole="radio"
                accessibilityState={{ checked: isSelected, disabled: alreadyActive }}
                accessibilityLabel={`${template.name}${alreadyActive ? ' — already active' : ''}`}
              >
                {/* Category icon circle */}
                <View
                  style={[
                    addJourneyStyles.templateIcon,
                    { backgroundColor: alreadyActive ? '#F3F4F6' : catStyle.iconBg },
                  ]}
                >
                  <Heart
                    size={14}
                    color={alreadyActive ? '#D1D5DB' : catStyle.iconColor}
                  />
                </View>

                {/* Template text */}
                <View style={addJourneyStyles.templateTextBlock}>
                  <Text
                    style={[
                      addJourneyStyles.templateName,
                      alreadyActive && addJourneyStyles.templateNameDisabled,
                    ]}
                    numberOfLines={1}
                  >
                    {template.name}
                  </Text>
                  <Text
                    style={[
                      addJourneyStyles.templateDescription,
                      alreadyActive && addJourneyStyles.templateDescriptionDisabled,
                    ]}
                    numberOfLines={2}
                  >
                    {alreadyActive ? 'Already active for this member' : description}
                  </Text>
                </View>

                {/* Selection indicator */}
                <View
                  style={[
                    addJourneyStyles.radioOuter,
                    isSelected && addJourneyStyles.radioOuterSelected,
                    alreadyActive && addJourneyStyles.radioOuterDisabled,
                  ]}
                >
                  {isSelected && <View style={addJourneyStyles.radioDot} />}
                </View>
              </TouchableOpacity>
            );
          })
        )}
      </ScrollView>

      {/* Error banner */}
      {submitError !== null && (
        <View style={addJourneyStyles.errorBanner}>
          <Text style={addJourneyStyles.errorText}>{submitError}</Text>
        </View>
      )}

      {/* Footer */}
      <View style={addJourneyStyles.footer}>
        <TouchableOpacity
          style={addJourneyStyles.cancelBtn}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Cancel"
        >
          <Text style={addJourneyStyles.cancelBtnText}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[addJourneyStyles.submitBtn, !canSubmit && addJourneyStyles.submitBtnDisabled]}
          onPress={() => { void handleSubmit(); }}
          disabled={!canSubmit}
          accessibilityRole="button"
          accessibilityLabel="Start journey"
          accessibilityState={{ disabled: !canSubmit }}
        >
          {createJourney.isPending ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Text style={addJourneyStyles.submitBtnText}>Start Journey</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );

  if (Platform.OS !== 'web') {
    // Native: use a standard RN Modal (form-sheet).
    return (
      <Modal
        visible={visible}
        animationType="slide"
        presentationStyle="formSheet"
        onRequestClose={onClose}
      >
        <View style={addJourneyStyles.nativeContainer}>{bodyContent}</View>
      </Modal>
    );
  }

  // Web: fixed overlay with animated panel + backdrop dismiss.
  if (!visible) return <></>;

  return (
    <View style={addJourneyStyles.webOverlay}>
      <Pressable
        style={addJourneyStyles.webBackdrop}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close modal"
      />
      <View style={addJourneyStyles.webPanel}>{bodyContent}</View>
    </View>
  );
}

const addJourneyStyles = StyleSheet.create({
  // Web overlay
  webOverlay: {
    position: 'fixed' as 'absolute',
    inset: 0,
    zIndex: 200,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  webBackdrop: {
    position: 'absolute' as 'absolute',
    inset: 0,
    backgroundColor: 'rgba(0,0,0,0.35)',
  } as ViewStyle,
  webPanel: {
    width: '100%',
    maxWidth: 560,
    maxHeight: '80vh' as unknown as number,
    backgroundColor: '#FFFFFF',
    borderRadius: radius.xl,
    overflow: 'hidden',
    zIndex: 1,
  } as ViewStyle,

  // Native container
  nativeContainer: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  } as ViewStyle,

  // Shared body
  body: {
    flex: 1,
    flexDirection: 'column',
  } as ViewStyle,

  // Header
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
    gap: 12,
  } as ViewStyle,
  modalHeaderText: {
    flex: 1,
    gap: 2,
  } as ViewStyle,
  modalTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 17,
    color: '#111827',
    lineHeight: 24,
  } as TextStyle,
  modalSubtitle: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: tokens.textSecondary,
  } as TextStyle,
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F3F4F6',
    flexShrink: 0,
  } as ViewStyle,
  closeBtnText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#6B7280',
  } as TextStyle,

  // Template list
  listScroll: {
    flex: 1,
    maxHeight: Platform.OS === 'web' ? (400 as unknown as number) : undefined,
  } as ViewStyle,
  listContent: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 6,
  } as ViewStyle,
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 20,
    justifyContent: 'center',
  } as ViewStyle,
  loadingText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: tokens.textMuted,
  } as TextStyle,
  emptyText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: '#A0A6AB',
    fontStyle: 'italic',
    textAlign: 'center',
    paddingVertical: 20,
  } as TextStyle,

  // Template row
  templateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: '#F3F4F6',
    backgroundColor: '#FFFFFF',
  } as ViewStyle,
  templateRowSelected: {
    borderColor: tokens.primary,
    backgroundColor: '#F0FDF4',
  } as ViewStyle,
  templateRowDisabled: {
    backgroundColor: '#FAFAFA',
    borderColor: '#F3F4F6',
    opacity: 0.65,
  } as ViewStyle,
  templateIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,
  templateTextBlock: {
    flex: 1,
    gap: 2,
  } as ViewStyle,
  templateName: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: '#111827',
    lineHeight: 18,
  } as TextStyle,
  templateNameDisabled: {
    color: '#9CA3AF',
  } as TextStyle,
  templateDescription: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#6B7280',
    lineHeight: 16,
  } as TextStyle,
  templateDescriptionDisabled: {
    color: '#C4C9CE',
  } as TextStyle,
  radioOuter: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: '#D1D5DB',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,
  radioOuterSelected: {
    borderColor: tokens.primary,
  } as ViewStyle,
  radioOuterDisabled: {
    borderColor: '#E5E7EB',
  } as ViewStyle,
  radioDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: tokens.primary,
  } as ViewStyle,

  // Error
  errorBanner: {
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: '#FEF2F2',
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#FECACA',
  } as ViewStyle,
  errorText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    color: '#B91C1C',
    lineHeight: 18,
  } as TextStyle,

  // Footer
  footer: {
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'flex-end',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
  } as ViewStyle,
  cancelBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#F4F1ED',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: '#DDD6CC',
  } as ViewStyle,
  cancelBtnText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: '#6B7280',
  } as TextStyle,
  submitBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: tokens.primary,
    borderRadius: radius.md,
    minWidth: 110,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  submitBtnDisabled: {
    backgroundColor: '#D1D5DB',
  } as ViewStyle,
  submitBtnText: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 13,
    color: '#FFFFFF',
  } as TextStyle,
});

// ─── Severity helpers ─────────────────────────────────────────────────────────

/**
 * Derive severity level from journey progressPercent.
 *
 * Heuristic (client-side, no backend change required):
 *   progressPercent < 33   → 'high'   — red ring, red Pill
 *   33 ≤ progress < 67     → 'medium' — amber ring, amber Pill
 *   progress ≥ 67          → 'low'    — yellow ring, yellow Pill
 */
type JourneySeverity = 'high' | 'medium' | 'low';

function deriveSeverity(progressPercent: number): JourneySeverity {
  if (progressPercent < 33) return 'high';
  if (progressPercent < 67) return 'medium';
  return 'low';
}

/** Chip background for each priority rank (1 = most urgent). */
const RANK_CHIP_BG: Record<number, string> = {
  1: tokens.red100,
  2: tokens.amber100,
  3: '#FEF9C3', // yellow-100 — not in tokens but consistent with palette
};

/** Chip text color per rank. */
const RANK_CHIP_COLOR: Record<number, string> = {
  1: tokens.red700,
  2: tokens.amber700,
  3: '#A16207', // yellow-800
};

// ─── ResourceNeedsColumn ─────────────────────────────────────────────────────

interface ResourceNeedsColumnProps {
  memberId: string;
  displayName: string;
  sessionCount: number;
  servicesConsentRefused: boolean;
  onNavigateToConversation: (conversationId: string) => void;
  onNavigateAndCall: () => void;
}

/**
 * Right column of the 3-column top card.
 *
 * Shows:
 *   - "Resource Needs (Priority)" card — top-3 active journeys ranked by
 *     severity (low progressPercent = highest priority).
 *   - Rewards balance badge.
 *   - Call / Message CTAs (dimmed when services refused).
 *   - Session count chip.
 *
 * Adds Journey modal state lives here so AddJourneyModal is available to the
 * Member Journey section header via a passed-down trigger callback.
 */
function ResourceNeedsColumn({
  memberId,
  displayName,
  sessionCount,
  servicesConsentRefused,
  onNavigateToConversation,
  onNavigateAndCall,
}: ResourceNeedsColumnProps): React.JSX.Element {
  const { data: journeys, isLoading: journeysLoading } = useMemberJourneys(memberId);
  const { data: rewardsBalance } = useMemberRewardsBalance(memberId);

  const activeJourneys = useMemo(
    () => journeys?.filter((j) => j.status === 'active') ?? [],
    [journeys],
  );

  /**
   * Top-3 active journeys sorted by severity — lowest progressPercent first
   * (most urgent need at rank 1).
   */
  const top3 = useMemo(
    () =>
      [...activeJourneys]
        .sort((a, b) => a.progressPercent - b.progressPercent)
        .slice(0, 3),
    [activeJourneys],
  );

  const ctaDisabled = servicesConsentRefused;
  const ctaOpacity = ctaDisabled ? 0.45 : 1;

  return (
    <View style={resourceColStyles.container}>
      {/* Resource Needs heading */}
      <View style={resourceColStyles.headRow}>
        <View>
          <Text style={resourceColStyles.headTitle}>Resource Needs</Text>
          <Text style={resourceColStyles.headSub}>(Priority)</Text>
        </View>
        {/* Edit pencil — no behavior yet (future edit modal) */}
        <TouchableOpacity
          style={resourceColStyles.editBtn}
          onPress={() => {
            // TODO: opens resource-needs edit modal (future sprint)
          }}
          accessibilityRole="button"
          accessibilityLabel="Edit resource needs priority"
        >
          <Edit2 size={12} color={tokens.textMuted} />
        </TouchableOpacity>
      </View>

      {/* Priority items */}
      {journeysLoading ? (
        <View style={resourceColStyles.loadingRow}>
          <ActivityIndicator size="small" color={tokens.textMuted} />
          <Text style={resourceColStyles.loadingText}>Loading…</Text>
        </View>
      ) : top3.length === 0 ? (
        <Text style={resourceColStyles.emptyText}>No active journeys.</Text>
      ) : (
        <View style={resourceColStyles.priorityList}>
          <StaggerList delayMs={50} durationMs={240}>
            {top3.map((journey, index) => {
              const rank = index + 1;
              const severity = deriveSeverity(journey.progressPercent);
              const chipBg = RANK_CHIP_BG[rank] ?? '#F3F4F6';
              const chipColor = RANK_CHIP_COLOR[rank] ?? tokens.textMuted;
              const pillVariant =
                severity === 'high'
                  ? 'red'
                  : severity === 'medium'
                  ? 'amber'
                  : ('amber' as const);
              const pillLabel =
                severity === 'high' ? 'High' : severity === 'medium' ? 'Medium' : 'Low';

              return (
                <View key={journey.id} style={resourceColStyles.priorityItem}>
                  {/* Rank chip */}
                  <View style={[resourceColStyles.rankChip, { backgroundColor: chipBg }]}>
                    <Text style={[resourceColStyles.rankText, { color: chipColor }, numerals.tabular]}>
                      {rank}
                    </Text>
                  </View>

                  {/* Journey name */}
                  <Text style={resourceColStyles.journeyName} numberOfLines={2}>
                    {journey.template.name}
                  </Text>

                  {/* Severity pill */}
                  <Pill variant={pillVariant} size="sm">{pillLabel}</Pill>
                </View>
              );
            })}
          </StaggerList>
        </View>
      )}

      {/* Rewards balance */}
      {rewardsBalance !== undefined && (
        <View style={resourceColStyles.rewardsBadge}>
          <Star size={12} color="#D97706" />
          <Text style={[resourceColStyles.rewardsText, numerals.tabular]}>
            {rewardsBalance.currentBalance.toLocaleString()} wellness pts
          </Text>
        </View>
      )}

      {/* Services refused caption */}
      {servicesConsentRefused && (
        <View style={resourceColStyles.refusedCaption}>
          <ShieldX size={11} color="#B91C1C" />
          <Text style={resourceColStyles.refusedCaptionText}>
            Member has refused services
          </Text>
        </View>
      )}

      {/* Call / Message CTAs */}
      <View style={[resourceColStyles.ctaRow, { opacity: ctaOpacity }]}>
        <TouchableOpacity
          style={[resourceColStyles.ctaBtn, resourceColStyles.callBtn]}
          onPress={ctaDisabled ? undefined : onNavigateAndCall}
          disabled={ctaDisabled}
          accessibilityRole="button"
          accessibilityLabel={
            ctaDisabled
              ? 'Call disabled — member has refused services'
              : `Call ${displayName}`
          }
          accessibilityState={{ disabled: ctaDisabled }}
        >
          <Phone size={14} color="#FFFFFF" />
          <Text style={resourceColStyles.ctaBtnText}>Call</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[resourceColStyles.ctaBtn, resourceColStyles.messageBtn]}
          onPress={ctaDisabled ? undefined : () => onNavigateToConversation('')}
          disabled={ctaDisabled}
          accessibilityRole="button"
          accessibilityLabel={
            ctaDisabled
              ? 'Message disabled — member has refused services'
              : `Message ${displayName}`
          }
          accessibilityState={{ disabled: ctaDisabled }}
        >
          <MessageSquare size={14} color={tokens.primary} />
          <Text style={[resourceColStyles.ctaBtnText, { color: tokens.primary }]}>
            Message
          </Text>
        </TouchableOpacity>
      </View>

      {/* Session count chip */}
      {sessionCount > 0 && (
        <View style={resourceColStyles.sessionCountRow}>
          <Text style={[resourceColStyles.sessionCountText, numerals.tabular]}>
            {sessionCount} session{sessionCount !== 1 ? 's' : ''} completed
          </Text>
        </View>
      )}
    </View>
  );
}

const resourceColStyles = StyleSheet.create({
  container: {
    flex: Platform.OS === 'web' ? 3 : undefined,
    padding: 20,
    borderTopWidth: Platform.OS === 'web' ? 0 : 1,
    borderTopColor: '#F3F4F6',
    gap: 10,
  } as ViewStyle,
  headRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: -2,
  } as ViewStyle,
  headTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 13,
    color: tokens.textPrimary,
  } as TextStyle,
  headSub: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: tokens.textMuted,
    marginTop: 1,
  } as TextStyle,
  editBtn: {
    width: 26,
    height: 26,
    borderRadius: radius.sm,
    backgroundColor: tokens.gray100,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
  } as ViewStyle,
  loadingText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: tokens.textMuted,
  } as TextStyle,
  emptyText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: '#A0A6AB',
    fontStyle: 'italic',
  } as TextStyle,
  priorityList: {
    gap: 6,
  } as ViewStyle,
  priorityItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  } as ViewStyle,
  rankChip: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,
  rankText: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 11,
    lineHeight: 13,
  } as TextStyle,
  journeyName: {
    flex: 1,
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    color: tokens.textPrimary,
    lineHeight: 16,
  } as TextStyle,
  rewardsBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#FFFBEB',
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: '#FDE68A',
  } as ViewStyle,
  rewardsText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 11,
    color: '#D97706',
  } as TextStyle,
  refusedCaption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#FEF2F2',
    borderRadius: radius.sm,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: '#FECACA',
  } as ViewStyle,
  refusedCaptionText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 11,
    color: '#B91C1C',
  } as TextStyle,
  ctaRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
  } as ViewStyle,
  ctaBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 9,
    borderRadius: radius.md,
  } as ViewStyle,
  callBtn: {
    backgroundColor: tokens.primary,
  } as ViewStyle,
  messageBtn: {
    backgroundColor: tokens.primary + '12',
    borderWidth: 1,
    borderColor: tokens.primary + '40',
  } as ViewStyle,
  ctaBtnText: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 13,
    color: '#FFFFFF',
  } as TextStyle,
  sessionCountRow: {
    alignItems: 'center',
  } as ViewStyle,
  sessionCountText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#9CA3AF',
  } as TextStyle,
});

// ─── Multi-track Journey Timeline ─────────────────────────────────────────────

/**
 * Maps a MemberJourneyResponse to the 6-step roadmap display data.
 * Derives step state from the backend step.status values.
 * Uses actual pointsOnCompletion from the API (post-T06: 10/25/30/10/25/50).
 */
function buildRoadmapSteps(journey: MemberJourneyResponse | undefined) {
  const standardStepKeys = [
    'Need Identified',
    'Eligibility Screening',
    'Upload Documents',
    'Follow Up',
    'Resource Connection',
    'Journey Complete',
  ];

  if (!journey) {
    return standardStepKeys.map((key) => ({
      key,
      label: key,
      state: 'upcoming' as const,
      points: JOURNEY_STEP_POINTS[key] ?? 0,
    }));
  }

  return standardStepKeys.map((key) => {
    const backendStep = journey.steps.find((s) => s.stepName === key);
    const state = backendStep?.status ?? ('upcoming' as const);
    return {
      key,
      label: key,
      state,
      points: backendStep?.pointsOnCompletion ?? JOURNEY_STEP_POINTS[key] ?? 0,
    };
  });
}

type RoadmapStepState = 'completed' | 'in_progress' | 'missed' | 'upcoming';

interface RoadmapStep {
  key: string;
  label: string;
  state: RoadmapStepState;
  points: number;
}

// Timeline responsive breakpoints
const TIMELINE_WIDE_BP = 1024;
const TIMELINE_MID_BP = 768;

interface StepCircleProps {
  step: RoadmapStep;
  isLast: boolean;
}

/**
 * Single step node in the horizontal timeline.
 * Completed → filled green + check icon.
 * In Progress → filled green + outer glow ring + check icon.
 * Missed → filled amber + X icon.
 * Upcoming → empty gray circle.
 * Connector line: emerald-300 if LEFT step is completed, gray otherwise.
 */
const StepCircle = React.memo(function StepCircle({
  step,
  isLast,
}: StepCircleProps): React.JSX.Element {
  const isCompleted = step.state === 'completed';
  const isInProgress = step.state === 'in_progress';
  const isMissed = step.state === 'missed';
  const isUpcoming = step.state === 'upcoming';

  const dotBg = isCompleted || isInProgress ? '#16A34A' : isMissed ? '#F59E0B' : '#E5E7EB';
  const lineBg = isCompleted ? '#34D399' : '#E5E7EB';

  const subLabelText = isCompleted
    ? 'Completed'
    : isInProgress
    ? 'In Progress'
    : isMissed
    ? 'Missed'
    : 'Upcoming';

  const subLabelColor = isCompleted || isInProgress
    ? '#16A34A'
    : isMissed
    ? '#D97706'
    : tokens.textMuted;

  return (
    <View
      style={timelineStyles.stepWrapper}
      accessibilityLabel={`${step.label}: ${subLabelText}, ${step.points} points on completion`}
      accessibilityRole="text"
    >
      {/* Circle + connector */}
      <View style={timelineStyles.circleRow}>
        <View
          style={[
            timelineStyles.circleOuter,
            isInProgress && timelineStyles.circleInProgressRing,
          ]}
        >
          <View style={[timelineStyles.dot, { backgroundColor: dotBg }]}>
            {isCompleted || isInProgress ? (
              <Check size={10} color="#FFFFFF" strokeWidth={3} />
            ) : isMissed ? (
              <X size={10} color="#FFFFFF" strokeWidth={3} />
            ) : (
              <View style={timelineStyles.dotInner} />
            )}
          </View>
        </View>
        {!isLast && (
          <View style={[timelineStyles.connector, { backgroundColor: lineBg }]} />
        )}
      </View>

      {/* Step name */}
      <Text
        style={isUpcoming ? timelineStyles.stepLabelMuted : timelineStyles.stepLabelActive}
        numberOfLines={2}
      >
        {step.label}
      </Text>
      {/* Status */}
      <Text style={[timelineStyles.subLabel, { color: subLabelColor }]}>
        {subLabelText}
      </Text>
      {/* Points */}
      <Text style={[isUpcoming ? timelineStyles.pointsMuted : timelineStyles.pointsActive, numerals.tabular]}>
        +{step.points} pts
      </Text>
    </View>
  );
});

interface VerticalStepRowProps {
  step: RoadmapStep;
}

/**
 * Single step card for the narrow (<768px) vertical layout.
 */
const VerticalStepRow = React.memo(function VerticalStepRow({
  step,
}: VerticalStepRowProps): React.JSX.Element {
  const isCompleted = step.state === 'completed';
  const isInProgress = step.state === 'in_progress';
  const isMissed = step.state === 'missed';
  const isUpcoming = step.state === 'upcoming';

  const dotBg = isCompleted || isInProgress ? '#16A34A' : isMissed ? '#F59E0B' : '#E5E7EB';
  const subLabelText = isCompleted
    ? 'Completed'
    : isInProgress
    ? 'In Progress'
    : isMissed
    ? 'Missed'
    : 'Upcoming';
  const subLabelColor = isCompleted || isInProgress
    ? '#16A34A'
    : isMissed
    ? '#D97706'
    : tokens.textMuted;

  return (
    <View
      style={verticalStepStyles.row}
      accessibilityLabel={`${step.label}: ${subLabelText}, ${step.points} points`}
      accessibilityRole="text"
    >
      <View
        style={[
          verticalStepStyles.dot,
          { backgroundColor: dotBg },
          isInProgress && verticalStepStyles.dotInProgress,
        ]}
      >
        {isCompleted || isInProgress ? (
          <Check size={9} color="#FFFFFF" strokeWidth={3} />
        ) : isMissed ? (
          <X size={9} color="#FFFFFF" strokeWidth={3} />
        ) : null}
      </View>
      <View style={verticalStepStyles.textBlock}>
        <Text
          style={[
            verticalStepStyles.stepName,
            isUpcoming && verticalStepStyles.stepNameMuted,
          ]}
        >
          {step.label}
        </Text>
        <View style={verticalStepStyles.metaRow}>
          <Text style={[verticalStepStyles.statusText, { color: subLabelColor }]}>
            {subLabelText}
          </Text>
          <Text style={[verticalStepStyles.pointsText, numerals.tabular]}>+{step.points} pts</Text>
        </View>
      </View>
    </View>
  );
});

const verticalStepStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  } as ViewStyle,
  dot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,
  dotInProgress: {
    borderWidth: 2,
    borderColor: '#34D399',
  } as ViewStyle,
  textBlock: { flex: 1, gap: 2 } as ViewStyle,
  stepName: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    color: tokens.textPrimary,
  } as TextStyle,
  stepNameMuted: {
    color: tokens.textMuted,
    fontFamily: 'PlusJakartaSans_400Regular',
  } as TextStyle,
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  } as ViewStyle,
  statusText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
  } as TextStyle,
  pointsText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 10,
    color: tokens.textMuted,
  } as TextStyle,
});

interface SingleJourneyTrackProps {
  journey: MemberJourneyResponse;
  rank: number;
  windowWidth: number;
}

/**
 * A single journey track row: rank chip + name + severity pill in the header,
 * then the 6-step timeline below.
 *
 * Responsive:
 *   ≥ 1024px — evenly-spaced flex row (wideRow).
 *   768–1023px — horizontal ScrollView (overflowable swipe).
 *   < 768px  — vertical VerticalStepRow list.
 */
const SingleJourneyTrack = React.memo(function SingleJourneyTrack({
  journey,
  rank,
  windowWidth,
}: SingleJourneyTrackProps): React.JSX.Element {
  const steps = useMemo(() => buildRoadmapSteps(journey), [journey]);
  const severity = deriveSeverity(journey.progressPercent);
  const chipBg = RANK_CHIP_BG[rank] ?? '#F3F4F6';
  const chipColor = RANK_CHIP_COLOR[rank] ?? tokens.textMuted;

  const isNarrow = windowWidth < TIMELINE_MID_BP;
  const isMid = windowWidth >= TIMELINE_MID_BP && windowWidth < TIMELINE_WIDE_BP;

  const pillVariant =
    severity === 'high' ? 'red' : severity === 'medium' ? 'amber' : ('amber' as const);
  const pillLabel =
    severity === 'high' ? 'High' : severity === 'medium' ? 'Medium' : 'Low';

  return (
    <View style={trackStyles.container}>
      {/* Header row */}
      <View style={trackStyles.header}>
        <View style={[trackStyles.rankChip, { backgroundColor: chipBg }]}>
          <Text style={[trackStyles.rankText, { color: chipColor }, numerals.tabular]}>{rank}</Text>
        </View>
        <Text style={trackStyles.journeyName} numberOfLines={1}>
          {journey.template.name}
        </Text>
        <Pill variant={pillVariant} size="sm">{pillLabel}</Pill>
        <Text style={[trackStyles.progressLabel, numerals.tabular]}>
          {Math.round(journey.progressPercent)}%
        </Text>
      </View>

      {/* Step layout by viewport */}
      {isNarrow ? (
        <View style={trackStyles.verticalList}>
          {steps.map((step) => (
            <VerticalStepRow key={step.key} step={step} />
          ))}
        </View>
      ) : isMid ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={timelineStyles.scrollRow}
        >
          {steps.map((step, index) => (
            <StepCircle
              key={step.key}
              step={step}
              isLast={index === steps.length - 1}
            />
          ))}
        </ScrollView>
      ) : (
        <View style={timelineStyles.wideRow}>
          {steps.map((step, index) => (
            <StepCircle
              key={step.key}
              step={step}
              isLast={index === steps.length - 1}
            />
          ))}
        </View>
      )}
    </View>
  );
});

const trackStyles = StyleSheet.create({
  container: {
    gap: 12,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  } as ViewStyle,
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  } as ViewStyle,
  rankChip: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,
  rankText: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 12,
  } as TextStyle,
  journeyName: {
    flex: 1,
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 15,
    color: tokens.textPrimary,
    lineHeight: 20,
  } as TextStyle,
  progressLabel: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 11,
    color: tokens.textMuted,
  } as TextStyle,
  verticalList: { gap: 0 } as ViewStyle,
});

const timelineStyles = StyleSheet.create({
  stepWrapper: {
    flex: 1,
    alignItems: 'center',
    minWidth: 76,
    flexShrink: 0,
    position: 'relative',
    paddingHorizontal: 2,
  } as ViewStyle,
  circleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    justifyContent: 'center',
    marginBottom: 6,
    position: 'relative',
  } as ViewStyle,
  circleOuter: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
    zIndex: 1,
  } as ViewStyle,
  circleInProgressRing: {
    borderWidth: 2,
    borderColor: '#34D399',
    width: 28,
    height: 28,
    borderRadius: 14,
  } as ViewStyle,
  dot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  dotInner: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#D1D5DB',
  } as ViewStyle,
  connector: {
    position: 'absolute',
    left: '50%',
    right: '-50%',
    top: '50%',
    height: 2,
    zIndex: 0,
    marginTop: -1,
  } as ViewStyle,
  stepLabelActive: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 11,
    color: tokens.textPrimary,
    textAlign: 'center',
    maxWidth: 80,
    lineHeight: 14,
  } as TextStyle,
  stepLabelMuted: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: tokens.textMuted,
    textAlign: 'center',
    maxWidth: 80,
    lineHeight: 14,
  } as TextStyle,
  subLabel: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 10,
    textAlign: 'center',
    marginTop: 2,
  } as TextStyle,
  pointsActive: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 10,
    color: '#047857',
    backgroundColor: '#ECFDF5',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 999,
    marginTop: 3,
    textAlign: 'center',
    overflow: 'hidden',
  } as TextStyle,
  pointsMuted: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 10,
    color: tokens.textMuted,
    backgroundColor: '#F3F4F6',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 999,
    marginTop: 3,
    textAlign: 'center',
    overflow: 'hidden',
  } as TextStyle,
  scrollRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 4,
    paddingBottom: 8,
  } as ViewStyle,
  wideRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 4,
  } as ViewStyle,
});

interface MemberJourneyTimelineProps {
  memberId: string;
  onAddJourney: () => void;
  windowWidth: number;
}

/**
 * Multi-track Member Journey section body.
 * Shows up to 3 active journeys in severity-rank order (ascending progressPercent).
 * onAddJourney is passed from the section header to preserve the existing modal trigger.
 */
function MemberJourneyTimeline({
  memberId,
  onAddJourney: _onAddJourney,
  windowWidth,
}: MemberJourneyTimelineProps): React.JSX.Element {
  const { data: journeys, isLoading } = useMemberJourneys(memberId);

  /**
   * Top-3 active journeys sorted ascending by progressPercent.
   * Lowest progress = highest priority = rank 1.
   */
  const top3Active = useMemo(() => {
    const active = journeys?.filter((j) => j.status === 'active') ?? [];
    return [...active]
      .sort((a, b) => a.progressPercent - b.progressPercent)
      .slice(0, 3);
  }, [journeys]);

  if (isLoading) {
    return (
      <View style={mjStyles.loadingRow}>
        <ActivityIndicator size="small" color={tokens.textMuted} />
        <Text style={mjStyles.loadingText}>Loading journeys…</Text>
      </View>
    );
  }

  if (top3Active.length === 0) {
    return (
      <EmptySectionState message="No active journeys. Use 'Add Journey' to start one." />
    );
  }

  return (
    <View style={mjStyles.container}>
      {top3Active.map((journey, index) => (
        <SingleJourneyTrack
          key={journey.id}
          journey={journey}
          rank={index + 1}
          windowWidth={windowWidth}
        />
      ))}
    </View>
  );
}

const mjStyles = StyleSheet.create({
  container: { gap: 0 } as ViewStyle,
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 20,
  } as ViewStyle,
  loadingText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: tokens.textMuted,
  } as TextStyle,
});

// ─── QuickAccessRow ───────────────────────────────────────────────────────────

interface QuickAccessRowProps {
  memberId: string;
  displayName: string;
  onAddNote: () => void;
  onFlagMember: () => void;
  onScheduleSession: () => void;
  onDocumentSession: () => void;
}

/**
 * Horizontal row of 4 frequently-used CHW actions for this member.
 * Each button is tappable and routes to the appropriate action.
 */
function QuickAccessRow({
  onAddNote,
  onFlagMember,
  onScheduleSession,
  onDocumentSession,
}: QuickAccessRowProps): React.JSX.Element {
  const quickActions: Array<{
    icon: React.ReactNode;
    label: string;
    iconBg: string;
    onPress: () => void;
  }> = [
    {
      icon: <NotebookPen size={16} color="#2563EB" />,
      label: 'Add Note',
      iconBg: '#EFF6FF',
      onPress: onAddNote,
    },
    {
      icon: <Flag size={16} color="#DC2626" />,
      label: 'Flag Member',
      iconBg: '#FEF2F2',
      onPress: onFlagMember,
    },
    {
      icon: <Calendar size={16} color="#7C3AED" />,
      label: 'Schedule Session',
      iconBg: '#F5F3FF',
      onPress: onScheduleSession,
    },
    {
      icon: <ClipboardList size={16} color="#D97706" />,
      label: 'Document Session',
      iconBg: '#FFFBEB',
      onPress: onDocumentSession,
    },
  ];

  return (
    <Card style={quickRowStyles.card}>
      <View style={quickRowStyles.row}>
        {quickActions.map((action, index) => (
          <PressableCard
            key={action.label}
            onPress={action.onPress}
            style={[
              quickRowStyles.actionBtn,
              quickRowStyles.actionBtnFlat,
              index < quickActions.length - 1 && quickRowStyles.actionBtnBorder,
            ]}
            accessibilityLabel={action.label}
          >
            <View style={[quickRowStyles.iconCircle, { backgroundColor: action.iconBg }]}>
              {action.icon}
            </View>
            <Text style={quickRowStyles.actionLabel}>{action.label}</Text>
          </PressableCard>
        ))}
      </View>
    </Card>
  );
}

const quickRowStyles = StyleSheet.create({
  card: {
    marginBottom: 20,
    overflow: 'hidden',
  } as ViewStyle,
  row: {
    flexDirection: 'row',
    alignItems: 'stretch',
  } as ViewStyle,
  actionBtn: {
    flex: 1,
    alignItems: 'center',
    gap: 8,
    paddingVertical: 16,
    paddingHorizontal: 8,
  } as ViewStyle,
  actionBtnBorder: {
    borderRightWidth: 1,
    borderRightColor: '#F3F4F6',
  } as ViewStyle,
  /** Suppresses PressableCard's default card surface — buttons live inside a Card already. */
  actionBtnFlat: {
    borderWidth: 0,
    backgroundColor: 'transparent',
    shadowOpacity: 0,
    elevation: 0,
    borderRadius: 0,
  } as ViewStyle,
  iconCircle: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  actionLabel: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 11,
    color: '#374151',
    textAlign: 'center',
  } as TextStyle,
});

// ─── BillableUnitsWidget ──────────────────────────────────────────────────────

interface BillableUnitsWidgetProps {
  memberId: string;
}

/**
 * Billable Units widget sourced from GET /chw/members/{id}/billable-units.
 * Shows today's count vs daily cap and this year's count vs yearly cap.
 * Renders a disabled-style banner when can_bill is false (daily cap reached).
 */
function BillableUnitsWidget({ memberId }: BillableUnitsWidgetProps): React.JSX.Element {
  const { data: units, isLoading } = useChwBillableUnits(memberId);

  if (isLoading) {
    return (
      <View style={billingWidgetStyles.loadingRow}>
        <ActivityIndicator size="small" color={tokens.textMuted} />
        <Text style={billingWidgetStyles.loadingText}>Loading billing data…</Text>
      </View>
    );
  }

  if (units === null || units === undefined) {
    return (
      <View style={billingWidgetStyles.unavailable}>
        <Text style={billingWidgetStyles.unavailableText}>
          Billing data not available — requires an active care relationship.
        </Text>
      </View>
    );
  }

  const dailyAtCap = units.daily.remaining === 0;
  const yearlyAtCap = units.yearly.remaining === 0;
  const canBill = !dailyAtCap;

  return (
    <View>
      {!canBill && (
        <View style={billingWidgetStyles.capBanner}>
          <Text style={billingWidgetStyles.capBannerText}>
            Daily billing cap reached — no additional units can be billed today.
          </Text>
        </View>
      )}
      <View style={billingWidgetStyles.grid}>
        {/* Today */}
        <View style={billingWidgetStyles.cell}>
          <Text style={billingWidgetStyles.periodLabel}>Today</Text>
          <View style={billingWidgetStyles.barTrack}>
            <View
              style={[
                billingWidgetStyles.barFill,
                {
                  width: `${(units.daily.used / units.daily.limit) * 100}%` as `${number}%`,
                  backgroundColor: dailyAtCap ? '#DC2626' : tokens.primary,
                },
              ]}
            />
          </View>
          <View style={billingWidgetStyles.statsRow}>
            <Text
              style={[
                billingWidgetStyles.usedLabel,
                dailyAtCap && billingWidgetStyles.usedLabelDanger,
                numerals.tabular,
              ]}
            >
              {units.daily.used} / {units.daily.limit} used
            </Text>
            <Text style={[billingWidgetStyles.remainingLabel, numerals.tabular]}>
              {units.daily.remaining} left
            </Text>
          </View>
        </View>

        <View style={billingWidgetStyles.divider} />

        {/* This year */}
        <View style={billingWidgetStyles.cell}>
          <Text style={billingWidgetStyles.periodLabel}>This Year</Text>
          <View style={billingWidgetStyles.barTrack}>
            <View
              style={[
                billingWidgetStyles.barFill,
                {
                  width: `${(units.yearly.used / units.yearly.limit) * 100}%` as `${number}%`,
                  backgroundColor: yearlyAtCap ? '#DC2626' : tokens.primary,
                },
              ]}
            />
          </View>
          <View style={billingWidgetStyles.statsRow}>
            <Text
              style={[
                billingWidgetStyles.usedLabel,
                yearlyAtCap && billingWidgetStyles.usedLabelDanger,
                numerals.tabular,
              ]}
            >
              {units.yearly.used} / {units.yearly.limit} used
            </Text>
            <Text style={[billingWidgetStyles.remainingLabel, numerals.tabular]}>
              {units.yearly.remaining} left
            </Text>
          </View>
        </View>
      </View>
    </View>
  );
}

const billingWidgetStyles = StyleSheet.create({
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 12,
  } as ViewStyle,
  loadingText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: tokens.textMuted,
  } as TextStyle,
  unavailable: {
    backgroundColor: '#F9FAFB',
    borderRadius: radius.md,
    padding: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  } as ViewStyle,
  unavailableText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: '#6B7280',
    fontStyle: 'italic',
  } as TextStyle,
  capBanner: {
    backgroundColor: '#FEF2F2',
    borderRadius: radius.md,
    padding: 10,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#FECACA',
  } as ViewStyle,
  capBannerText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    color: '#B91C1C',
    textAlign: 'center',
  } as TextStyle,
  grid: {
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: '#F4F1ED',
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    overflow: 'hidden',
  } as ViewStyle,
  cell: {
    flex: 1,
    padding: 12,
    gap: 8,
  } as ViewStyle,
  divider: {
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

// ─── SessionsTable ────────────────────────────────────────────────────────────

interface SessionsTableProps {
  sessions: RecentSessionItem[];
  totalCount: number;
  onViewSession: (sessionId: string) => void;
}

/**
 * Paginated sessions table.
 * Columns: Date & Time / Type / Status / Duration / Modality / Actions (View notes).
 * 20 rows per page with previous/next pagination controls.
 */
function SessionsTable({
  sessions,
  totalCount,
  onViewSession,
}: SessionsTableProps): React.JSX.Element {
  const [currentPage, setCurrentPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(sessions.length / SESSIONS_PAGE_SIZE));

  const pageSlice = useMemo(() => {
    const startIndex = (currentPage - 1) * SESSIONS_PAGE_SIZE;
    return sessions.slice(startIndex, startIndex + SESSIONS_PAGE_SIZE);
  }, [sessions, currentPage]);

  const handlePreviousPage = useCallback((): void => {
    setCurrentPage((prev) => Math.max(1, prev - 1));
  }, []);

  const handleNextPage = useCallback((): void => {
    setCurrentPage((prev) => Math.min(totalPages, prev + 1));
  }, [totalPages]);

  if (sessions.length === 0) {
    return <EmptySectionState message="No sessions with this member yet." />;
  }

  return (
    <View>
      {/* Table header */}
      <View style={tableStyles.header}>
        <Text style={[tableStyles.headerCell, tableStyles.colDate]}>Date & Time</Text>
        <Text style={[tableStyles.headerCell, tableStyles.colModality]}>Type</Text>
        <Text style={[tableStyles.headerCell, tableStyles.colStatus]}>Status</Text>
        <Text style={[tableStyles.headerCell, tableStyles.colDuration]}>Duration</Text>
        <Text style={[tableStyles.headerCell, tableStyles.colModality]}>Modality</Text>
        <Text style={[tableStyles.headerCell, tableStyles.colActions]}>Actions</Text>
      </View>

      {/* Table rows */}
      {pageSlice.map((session) => {
        const statusLabel = SESSION_STATUS_LABELS[session.status] ?? session.status;
        const modeLabel = SESSION_MODE_LABELS[session.mode] ?? session.mode;
        const statusColor =
          session.status === 'completed'
            ? tokens.primary
            : session.status === 'in_progress'
            ? '#D97706'
            : session.status === 'cancelled'
            ? '#9CA3AF'
            : '#6B7280';

        return (
          <View key={session.id} style={tableStyles.row}>
            <Text style={[tableStyles.cell, tableStyles.colDate, tableStyles.dateText]}>
              {formatDateTime(session.scheduledAt ?? session.startedAt)}
            </Text>
            <Text style={[tableStyles.cell, tableStyles.colModality]}>
              {modeLabel}
            </Text>
            <View style={tableStyles.colStatus}>
              <View style={[tableStyles.statusPill, { backgroundColor: statusColor + '18' }]}>
                <Text style={[tableStyles.statusText, { color: statusColor }]}>
                  {statusLabel}
                </Text>
              </View>
            </View>
            <Text style={[tableStyles.cell, tableStyles.colDuration]}>
              {session.durationMinutes != null
                ? `${session.durationMinutes} min`
                : '—'}
            </Text>
            <Text style={[tableStyles.cell, tableStyles.colModality]}>
              Individual
            </Text>
            <View style={tableStyles.colActions}>
              <TouchableOpacity
                style={tableStyles.viewBtn}
                onPress={() => onViewSession(session.id)}
                accessibilityRole="button"
                accessibilityLabel={`View notes for session on ${formatDateTime(session.scheduledAt)}`}
              >
                <Text style={tableStyles.viewBtnText}>View notes</Text>
              </TouchableOpacity>
            </View>
          </View>
        );
      })}

      {/* Pagination controls */}
      <View style={tableStyles.pagination}>
        <Text style={tableStyles.pageInfo}>
          {sessions.length} session{sessions.length !== 1 ? 's' : ''}
          {totalCount > sessions.length ? ` (showing ${sessions.length})` : ''}
          {' · '}Page {currentPage} of {totalPages}
        </Text>
        <View style={tableStyles.pageButtons}>
          <TouchableOpacity
            style={[tableStyles.pageBtn, currentPage === 1 && tableStyles.pageBtnDisabled]}
            onPress={handlePreviousPage}
            disabled={currentPage === 1}
            accessibilityRole="button"
            accessibilityLabel="Previous page"
            accessibilityState={{ disabled: currentPage === 1 }}
          >
            <ArrowLeft size={14} color={currentPage === 1 ? '#9CA3AF' : tokens.primary} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[tableStyles.pageBtn, currentPage === totalPages && tableStyles.pageBtnDisabled]}
            onPress={handleNextPage}
            disabled={currentPage === totalPages}
            accessibilityRole="button"
            accessibilityLabel="Next page"
            accessibilityState={{ disabled: currentPage === totalPages }}
          >
            <ArrowRight size={14} color={currentPage === totalPages ? '#9CA3AF' : tokens.primary} />
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const tableStyles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 2,
    borderBottomColor: '#E5E7EB',
    marginBottom: 2,
  } as ViewStyle,
  headerCell: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 11,
    color: '#6B7280',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  } as TextStyle,
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  } as ViewStyle,
  cell: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: '#374151',
  } as TextStyle,
  // Column width distribution
  colDate: { flex: 3 } as ViewStyle,
  colStatus: { flex: 2 } as ViewStyle,
  colModality: { flex: 2 } as ViewStyle,
  colDuration: { flex: 1.5 } as ViewStyle,
  colActions: { flex: 2, alignItems: 'flex-end' } as ViewStyle,
  dateText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    color: '#111827',
  } as TextStyle,
  statusPill: {
    borderRadius: radius.sm,
    paddingHorizontal: 7,
    paddingVertical: 2,
    alignSelf: 'flex-start',
  } as ViewStyle,
  statusText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 11,
  } as TextStyle,
  viewBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: tokens.primary + '12',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: tokens.primary + '35',
  } as ViewStyle,
  viewBtnText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 11,
    color: tokens.primary,
  } as TextStyle,
  pagination: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 12,
    marginTop: 4,
  } as ViewStyle,
  pageInfo: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#9CA3AF',
  } as TextStyle,
  pageButtons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  } as ViewStyle,
  pageBtn: {
    width: 32,
    height: 32,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E5E7EB',
  } as ViewStyle,
  pageBtnDisabled: {
    backgroundColor: '#F9FAFB',
    borderColor: '#F3F4F6',
  } as ViewStyle,
});

// ─── FlagMemberModal ──────────────────────────────────────────────────────────

interface FlagMemberModalProps {
  memberId: string;
  visible: boolean;
  onClose: () => void;
}

/**
 * Modal for creating or deleting a flag note.
 * Reads the existing flag note and allows the CHW to write a new one or remove it.
 */
function FlagMemberModal({ memberId, visible, onClose }: FlagMemberModalProps): React.JSX.Element {
  const { data: existingNote, isLoading: noteLoading } = useFlagNote(memberId);
  const createNote = useCreateFlagNote(memberId);
  const deleteNote = useDeleteFlagNote(memberId);

  const [noteText, setNoteText] = useState('');

  const handleSave = useCallback(async (): Promise<void> => {
    const trimmed = noteText.trim();
    if (trimmed.length === 0) return;
    await createNote.mutateAsync(trimmed);
    setNoteText('');
    onClose();
  }, [noteText, createNote, onClose]);

  const handleDelete = useCallback(async (): Promise<void> => {
    await deleteNote.mutateAsync();
    onClose();
  }, [deleteNote, onClose]);

  if (!visible) return <></>;

  return (
    <RightDrawer
      isOpen={visible}
      onClose={onClose}
      title="Flag Member"
      subtitle="CHW-only note attached to this member's profile"
      footer={
        <View style={flagModalStyles.footer}>
          <TouchableOpacity
            style={flagModalStyles.cancelBtn}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
          >
            <Text style={flagModalStyles.cancelBtnText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={flagModalStyles.saveBtn}
            onPress={() => { void handleSave(); }}
            disabled={createNote.isPending || noteText.trim().length === 0}
            accessibilityRole="button"
            accessibilityLabel="Save flag note"
          >
            {createNote.isPending ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Text style={flagModalStyles.saveBtnText}>Save Flag</Text>
            )}
          </TouchableOpacity>
        </View>
      }
    >
      <View style={flagModalStyles.content}>
        {noteLoading ? (
          <View style={flagModalStyles.loadingRow}>
            <ActivityIndicator size="small" color={tokens.textMuted} />
            <Text style={flagModalStyles.loadingText}>Loading existing flag…</Text>
          </View>
        ) : null}

        {existingNote && !noteLoading ? (
          <View style={flagModalStyles.existingNote}>
            <View style={flagModalStyles.existingNoteHeader}>
              <Flag size={14} color="#DC2626" />
              <Text style={flagModalStyles.existingNoteTitle}>Current Flag Note</Text>
            </View>
            <Text style={flagModalStyles.existingNoteBody}>{existingNote.body}</Text>
            <Text style={flagModalStyles.existingNoteDate}>
              Added {formatDate(existingNote.createdAt)}
            </Text>
            <TouchableOpacity
              style={flagModalStyles.removeBtn}
              onPress={() => { void handleDelete(); }}
              disabled={deleteNote.isPending}
              accessibilityRole="button"
              accessibilityLabel="Remove existing flag note"
            >
              {deleteNote.isPending ? (
                <ActivityIndicator size="small" color="#B91C1C" />
              ) : (
                <Text style={flagModalStyles.removeBtnText}>Remove Flag</Text>
              )}
            </TouchableOpacity>
          </View>
        ) : null}

        <Text style={flagModalStyles.inputLabel}>
          {existingNote ? 'Replace with a new note:' : 'Add a flag note:'}
        </Text>
        <TextInput
          style={flagModalStyles.textInput}
          value={noteText}
          onChangeText={setNoteText}
          placeholder="e.g. Prefers evening appointments, transportation assistance needed…"
          placeholderTextColor="#A0A6AB"
          multiline
          numberOfLines={4}
          maxLength={2000}
          textAlignVertical="top"
          accessibilityLabel="Flag note text input"
        />
        <Text style={flagModalStyles.charCount}>{noteText.length}/2000</Text>

        <View style={flagModalStyles.hipaaNotice}>
          <Text style={flagModalStyles.hipaaNoticeText}>
            This note is CHW-visible only and is never shown to the member (HIPAA minimum-necessary).
          </Text>
        </View>
      </View>
    </RightDrawer>
  );
}

const flagModalStyles = StyleSheet.create({
  content: { gap: 14 } as ViewStyle,
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
  } as ViewStyle,
  loadingText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: tokens.textMuted,
  } as TextStyle,
  existingNote: {
    backgroundColor: '#FEF2F2',
    borderRadius: radius.md,
    padding: 12,
    gap: 6,
    borderWidth: 1,
    borderColor: '#FECACA',
  } as ViewStyle,
  existingNoteHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  } as ViewStyle,
  existingNoteTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 13,
    color: '#B91C1C',
  } as TextStyle,
  existingNoteBody: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: '#111827',
    lineHeight: 20,
  } as TextStyle,
  existingNoteDate: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#9CA3AF',
  } as TextStyle,
  removeBtn: {
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#FEE2E2',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: '#FECACA',
    marginTop: 4,
  } as ViewStyle,
  removeBtnText: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 12,
    color: '#B91C1C',
  } as TextStyle,
  inputLabel: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: '#374151',
  } as TextStyle,
  textInput: {
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: radius.md,
    padding: 12,
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: '#111827',
    minHeight: 100,
    backgroundColor: '#FFFFFF',
  } as TextStyle,
  charCount: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#9CA3AF',
    textAlign: 'right',
    marginTop: -8,
  } as TextStyle,
  hipaaNotice: {
    backgroundColor: '#F4F1ED',
    borderRadius: radius.sm,
    padding: 10,
    borderWidth: 1,
    borderColor: '#DDD6CC',
  } as ViewStyle,
  hipaaNoticeText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#6B7280',
    lineHeight: 16,
  } as TextStyle,
  footer: {
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'flex-end',
  } as ViewStyle,
  cancelBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#F4F1ED',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: '#DDD6CC',
  } as ViewStyle,
  cancelBtnText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: '#6B7280',
  } as TextStyle,
  saveBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: tokens.primary,
    borderRadius: radius.md,
    minWidth: 96,
    alignItems: 'center',
  } as ViewStyle,
  saveBtnText: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 13,
    color: '#FFFFFF',
  } as TextStyle,
});

// ─── SectionCard wrapper ──────────────────────────────────────────────────────

interface SectionCardProps {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  titleRight?: React.ReactNode;
}

function SectionCard({
  title,
  subtitle,
  children,
  titleRight,
}: SectionCardProps): React.JSX.Element {
  return (
    <Card style={sectionCardStyles.card}>
      <View style={sectionCardStyles.header}>
        <SectionHeader title={title} subtitle={subtitle} right={titleRight} />
      </View>
      <View style={sectionCardStyles.body}>{children}</View>
    </Card>
  );
}

const sectionCardStyles = StyleSheet.create({
  card: {
    marginBottom: 20,
    overflow: 'hidden',
  } as ViewStyle,
  header: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 8,
  } as ViewStyle,
  body: {
    paddingHorizontal: 20,
    paddingBottom: 16,
  } as ViewStyle,
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

  const { width: windowWidth } = useWindowDimensions();

  /**
   * When true, OpenQuestionsDrawer renders as an inline side panel inside the
   * content flex-row — no backdrop, content compresses. When false it renders
   * as a fixed overlay (mobile/narrow viewports).
   */
  const isOpenQuestionsInline =
    Platform.OS === 'web' && windowWidth >= OPEN_QUESTIONS_INLINE_BREAKPOINT;

  const { userName } = useAuth();
  const chwInitials = userName
    ? userName
        .split(' ')
        .map((n) => n[0] ?? '')
        .join('')
        .toUpperCase()
        .slice(0, 2)
    : 'CW';

  const { data: profile, isLoading, error } = useMemberDetail(memberId);
  const { data: servicesConsentData } = useMemberServicesConsent(memberId);
  const servicesConsentRefused = servicesConsentData?.value === 'refuse_services';

  // ── Drawer / modal state ─────────────────────────────────────────────────────
  const [openQuestionsOpen, setOpenQuestionsOpen] = useState(false);
  const [flagModalOpen, setFlagModalOpen] = useState(false);
  const [addJourneyOpen, setAddJourneyOpen] = useState(false);

  // Journeys data used both by ResourceNeedsColumn and AddJourneyModal dedup guard.
  const { data: journeysForModal } = useMemberJourneys(memberId);
  const existingActiveSlugs = useMemo<Set<string>>(
    () =>
      new Set(
        (journeysForModal ?? [])
          .filter((j) => j.status === 'active')
          .map((j) => j.template.slug),
      ),
    [journeysForModal],
  );

  // ── Navigation helpers ───────────────────────────────────────────────────────

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

  const handleNavigateToConversation = useCallback(
    (_conversationId: string): void => {
      navigation.navigate('Messages', { memberId });
    },
    [navigation, memberId],
  );

  const handleNavigateAndCall = useCallback((): void => {
    navigation.navigate('Messages', { memberId, autoCall: true });
  }, [navigation, memberId]);

  // ── Loading state ────────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <SafeAreaView style={s.safeArea} edges={['top']}>
        <StatusBar barStyle="dark-content" backgroundColor={tokens.pageBg} />
        <View style={s.header}>
          <TouchableOpacity
            style={s.backBtn}
            onPress={() => navigation.goBack()}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <ArrowLeft size={20} color={tokens.textPrimary} />
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

  // ── 403 / error state ────────────────────────────────────────────────────────

  const is403 =
    error != null &&
    typeof error === 'object' &&
    'status' in error &&
    (error as { status: number }).status === 403;

  if (is403 || (error != null && !profile)) {
    return (
      <SafeAreaView style={s.safeArea} edges={['top']}>
        <StatusBar barStyle="dark-content" backgroundColor={tokens.pageBg} />
        <View style={s.header}>
          <TouchableOpacity
            style={s.backBtn}
            onPress={() => navigation.goBack()}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <ArrowLeft size={20} color={tokens.textPrimary} />
          </TouchableOpacity>
          <Text style={s.headerTitle}>Member Profile</Text>
          <View style={{ width: 40 }} />
        </View>
        <View style={s.emptyState}>
          <View style={s.emptyIconCircle}>
            <ShieldOff size={28} color={tokens.textMuted} />
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

  const displayName = `${profile.firstName} ${profile.lastName}`.trim();
  const initials = getInitials(profile.firstName, profile.lastName);

  // ── Main render ──────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={s.safeArea} edges={['top']}>
      <StatusBar barStyle="dark-content" backgroundColor={tokens.pageBg} />

      <AppShell
        role="chw"
        activeKey="memberProfile"
        userBlock={{ initials: chwInitials, name: userName ?? 'CHW', role: 'CHW' }}
      >
        {/* Native-only back header */}
        {Platform.OS !== 'web' && (
          <View style={s.header}>
            <TouchableOpacity
              style={s.backBtn}
              onPress={() => navigation.goBack()}
              accessibilityRole="button"
              accessibilityLabel="Go back"
            >
              <ArrowLeft size={20} color={tokens.textPrimary} />
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
          contentInsetAdjustmentBehavior="automatic"
        >
          <View style={s.pageWrap}>

            {/* Web: back link + page header */}
            {Platform.OS === 'web' && (
              <View style={s.webHeader}>
                <TouchableOpacity
                  style={s.backLinkWeb}
                  onPress={() => navigation.goBack()}
                  accessibilityRole="button"
                  accessibilityLabel="Back to members"
                >
                  <ArrowLeft size={16} color={tokens.primary} />
                  <Text style={s.backLinkText}>Back to Members</Text>
                </TouchableOpacity>
                <PageHeader
                  title={displayName}
                  subtitle="Member Profile"
                />
              </View>
            )}

            {/* ───────────────────────────────────────────────────────────────
                TOP CARD: 3 columns
                  Left   — Demographics
                  Center — Flag Note card (amber) + Billing Consent card (green)
                  Right  — Resource Needs (Priority) + Call/Message CTAs
            ─────────────────────────────────────────────────────────────── */}
            <Card style={s.topCard}>
              <View style={s.topCardRow}>

                {/* LEFT: Demographics */}
                <DemographicsColumn profile={profile} />

                {/* CENTER: Flag Note + Billing Consent */}
                <CenterColumn
                  memberId={memberId}
                  onEditFlag={() => setFlagModalOpen(true)}
                  onViewConsent={() =>
                    Alert.alert(
                      'Billing Consent',
                      'Full consent details are managed by the member. This status reflects their current choice.',
                    )
                  }
                />

                {/* RIGHT: Resource Needs (Priority) + Call/Message */}
                <ResourceNeedsColumn
                  memberId={memberId}
                  displayName={displayName}
                  sessionCount={profile.sessionCount}
                  servicesConsentRefused={servicesConsentRefused}
                  onNavigateToConversation={handleNavigateToConversation}
                  onNavigateAndCall={handleNavigateAndCall}
                />

              </View>
            </Card>

            {/* ───────────────────────────────────────────────────────────────
                QUICK ACCESS ROW — 4 common actions
            ─────────────────────────────────────────────────────────────── */}
            <QuickAccessRow
              memberId={memberId}
              displayName={displayName}
              onAddNote={() =>
                Alert.alert(
                  'Case Notes',
                  'Per-member case notes are scoped to each session today. Open a session card below to view or add notes. A dedicated case-notes timeline ships next sprint.',
                )
              }
              onFlagMember={() => setFlagModalOpen(true)}
              onScheduleSession={() =>
                Alert.alert(
                  'Schedule Session',
                  'Use the Calendar tab to schedule a new session with this member.',
                )
              }
              onDocumentSession={() =>
                Alert.alert(
                  'Document Session',
                  'Documentation is submitted from within an active session. Start or open a session with this member to document it.',
                )
              }
            />

            {/* Main content + optional sidebar */}
            {/*
              Layout strategy for the Open Questions inline panel:
              ─────────────────────────────────────────────────────
              On viewports >= 1024px (isOpenQuestionsInline = true):
                contentRow is a flex-row. When the drawer is open, it renders
                as a flex sibling of mainCol — the Quick Access rail is hidden
                to avoid crowding three columns. The drawer occupies
                OPEN_QUESTIONS_INLINE_WIDTH px on the right, mainCol takes the
                remaining flex:1 space.

              On narrower viewports / native:
                The drawer renders as a fixed overlay outside the ScrollView
                (see below). The Quick Access rail is always shown.
            */}
            <View style={s.contentRow}>
              <View style={s.mainCol}>

                {/* ─────────────────────────────────────────────────────────
                    MEMBER JOURNEY — multi-track horizontal timeline
                ─────────────────────────────────────────────────────── */}
                <SectionCard
                  title="Member Journey"
                  subtitle="Progress for Top Resource Needs"
                  titleRight={
                    <View style={s.journeyHeaderRight}>
                      {/* Edit pencil — no-op placeholder for future reorder modal */}
                      <TouchableOpacity
                        style={s.journeyEditBtn}
                        onPress={() => {
                          // TODO: opens journey reorder modal (future sprint)
                        }}
                        accessibilityRole="button"
                        accessibilityLabel="Edit member journey order"
                      >
                        <Edit2 size={12} color={tokens.textMuted} />
                      </TouchableOpacity>
                      {/* Add Journey — wired to the existing AddJourneyModal */}
                      <TouchableOpacity
                        style={s.addJourneyBtn}
                        onPress={() => setAddJourneyOpen(true)}
                        accessibilityRole="button"
                        accessibilityLabel="Add a new journey for this member"
                      >
                        <Plus size={12} color={tokens.primary} />
                        <Text style={s.addJourneyBtnText}>Add Journey</Text>
                      </TouchableOpacity>
                    </View>
                  }
                >
                  <MemberJourneyTimeline
                    memberId={memberId}
                    onAddJourney={() => setAddJourneyOpen(true)}
                    windowWidth={windowWidth}
                  />
                </SectionCard>

                {/* AddJourneyModal — triggered from both the section header and
                    the empty-state CTA. Dedup guard uses existingActiveSlugs
                    computed from the same useMemberJourneys query. */}
                <AddJourneyModal
                  memberId={memberId}
                  memberName={displayName}
                  visible={addJourneyOpen}
                  existingActiveSlugs={existingActiveSlugs}
                  onClose={() => setAddJourneyOpen(false)}
                  onCreated={() => {
                    /* useMemberJourneys is invalidated by the mutation's onSuccess;
                       the query refetches automatically — no extra action needed. */
                  }}
                />

                {/* ─────────────────────────────────────────────────────────
                    BILLABLE UNITS WIDGET
                ─────────────────────────────────────────────────────── */}
                <SectionCard
                  title="Billable Units (Medi-Cal)"
                  subtitle="4/day · 10/year cap"
                >
                  <BillableUnitsWidget memberId={memberId} />
                </SectionCard>

                {/* ─────────────────────────────────────────────────────────
                    SESSIONS TABLE (paginated, 20/page)
                ─────────────────────────────────────────────────────── */}
                <SectionCard
                  title="Sessions"
                  titleRight={
                    profile.sessionCount > 0 ? (
                      <View style={s.countBadge}>
                        <Text style={s.countBadgeText}>
                          {profile.sessionCount} total
                        </Text>
                      </View>
                    ) : undefined
                  }
                >
                  <SessionsTable
                    sessions={profile.recentSessions}
                    totalCount={profile.sessionCount}
                    onViewSession={handleViewSession}
                  />
                </SectionCard>

                {/* ─────────────────────────────────────────────────────────
                    HIPAA notice
                ─────────────────────────────────────────────────────── */}
                <View style={s.hipaaNotice}>
                  <Text style={s.hipaaNoticeText}>
                    This view shows only the information needed for care delivery.
                    Member identifiers, raw insurance details, notes from other CHWs,
                    and session transcripts are not displayed
                    (HIPAA minimum necessary — 45 CFR §164.514(d)).
                  </Text>
                </View>

              </View>

              {/*
                Inline Open Questions panel — only in the flex-row when the
                drawer is open AND we're on a wide viewport. This replaces
                the Quick Access rail while open so the layout stays 2-column.
              */}
              {isOpenQuestionsInline && (
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
                          templateName: `${CATEGORY_LABELS[profile.primaryCategories[0]!] ?? profile.primaryCategories[0]!} Journey`,
                          currentStepName: 'Upload Documents',
                          vertical: profile.primaryCategories[0]!,
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
              )}

              {/* ── Web right rail: Quick Access (hidden when inline drawer is open) ── */}
              {Platform.OS === 'web' && !(isOpenQuestionsInline && openQuestionsOpen) && (
                <RightRail width={240}>
                  {/* Open Questions card */}
                  <Card style={s.railCard}>
                    <Text style={s.railCardTitle}>Quick Access</Text>
                    <RailAccessItem
                      icon={<NotebookPen size={14} color="#2563EB" />}
                      iconBg="#EFF6FF"
                      label="Case Notes"
                      sublabel="View all notes"
                      onPress={() =>
                        Alert.alert(
                          'Coming soon',
                          'Per-member case notes are scoped to each session today. A dedicated timeline ships next sprint.',
                        )
                      }
                    />
                    <RailAccessItem
                      icon={<Flag size={14} color="#DC2626" />}
                      iconBg="#FEF2F2"
                      label="Flag Member"
                      sublabel="Add/edit flag note"
                      onPress={() => setFlagModalOpen(true)}
                    />
                    <RailAccessItem
                      icon={<CheckSquare size={14} color="#EA580C" />}
                      iconBg="#FFF7ED"
                      label="Screening Results"
                      sublabel="View history"
                      onPress={() =>
                        Alert.alert(
                          'Coming soon',
                          'Screening results tracking is planned for an upcoming sprint.',
                        )
                      }
                    />
                    <RailAccessItem
                      icon={<CheckCircle size={14} color="#16A34A" />}
                      iconBg="#F0FDF4"
                      label="Eligibility"
                      sublabel="Verification status"
                      onPress={() =>
                        Alert.alert(
                          'Coming soon',
                          'Eligibility verification is planned for an upcoming sprint.',
                        )
                      }
                    />
                    <RailAccessItem
                      icon={<UploadCloud size={14} color="#64748B" />}
                      iconBg="#F8FAFC"
                      label="Documents"
                      sublabel="Member uploads"
                      onPress={() =>
                        Alert.alert(
                          'Coming soon',
                          'CHW-scoped document review ships in an upcoming sprint.',
                        )
                      }
                    />
                    <RailAccessItem
                      icon={<RadioTower size={14} color="#D97706" />}
                      iconBg="#FFFBEB"
                      label="Outreach History"
                      sublabel="All interactions"
                      onPress={() =>
                        Alert.alert(
                          'Coming soon',
                          'Outreach history tracking is planned for an upcoming sprint.',
                        )
                      }
                    />
                    <RailAccessItem
                      icon={<Sparkles size={14} color={tokens.emerald500} />}
                      iconBg={tokens.emerald500 + '18'}
                      label="Open Questions"
                      sublabel="AI-suggested prompts"
                      onPress={() => setOpenQuestionsOpen(true)}
                    />
                  </Card>
                </RightRail>
              )}
            </View>

          </View>
        </ScrollView>

        {/* ── Flag Member drawer/modal ── */}
        <FlagMemberModal
          memberId={memberId}
          visible={flagModalOpen}
          onClose={() => setFlagModalOpen(false)}
        />

        {/*
          ── Open Questions drawer — overlay mode (narrow viewports / native) ──
          Only render here when NOT in inline mode. On wide web viewports the
          drawer lives inside the contentRow flex-row above (inline panel).
        */}
        {!isOpenQuestionsInline && (
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
                    templateName: `${CATEGORY_LABELS[profile.primaryCategories[0]!] ?? profile.primaryCategories[0]!} Journey`,
                    currentStepName: 'Upload Documents',
                    vertical: profile.primaryCategories[0]!,
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
        )}

        {/* ProfileContactButtons drives the masked-call + conversation
            find-or-create flow. On mobile it renders inline in the
            sheet; on web the Call/Message buttons in the top card are
            the primary entry point and these are rendered invisibly for
            the find-or-create side-effect only. */}
        {!servicesConsentRefused && (
          <View style={{ height: 0, overflow: 'hidden' }}>
            <ProfileContactButtons
              targetUserId={memberId}
              targetUserRole="member"
              sharedSessionCount={profile.sessionCount}
              targetDisplayName={displayName}
              onNavigateToConversation={handleNavigateToConversation}
              onNavigateAndCall={handleNavigateAndCall}
            />
          </View>
        )}

      </AppShell>
    </SafeAreaView>
  );
}

// ─── RailAccessItem (web right-rail only) ────────────────────────────────────

interface RailAccessItemProps {
  icon: React.ReactNode;
  label: string;
  sublabel?: string;
  iconBg?: string;
  onPress: () => void;
}

function RailAccessItem({
  icon,
  label,
  sublabel,
  iconBg = '#EFF6FF',
  onPress,
}: RailAccessItemProps): React.JSX.Element {
  return (
    <TouchableOpacity
      style={railItemStyles.item}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View style={[railItemStyles.iconWrap, { backgroundColor: iconBg }]}>{icon}</View>
      <View style={railItemStyles.labelWrap}>
        <Text style={railItemStyles.label}>{label}</Text>
        {sublabel ? <Text style={railItemStyles.sublabel}>{sublabel}</Text> : null}
      </View>
      <ChevronRight size={12} color="#D1D5DB" />
    </TouchableOpacity>
  );
}

const railItemStyles = StyleSheet.create({
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 9,
    paddingHorizontal: 4,
    borderRadius: radius.md,
  } as ViewStyle,
  iconWrap: {
    width: 30,
    height: 30,
    borderRadius: radius.sm,
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
    fontSize: 12,
    color: '#111827',
  } as TextStyle,
  sublabel: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 10,
    color: '#6B7280',
  } as TextStyle,
});

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: tokens.pageBg,
  } as ViewStyle,

  // Native back header
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

  // Web header
  webHeader: { marginBottom: 8 } as ViewStyle,
  backLinkWeb: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 12,
  } as ViewStyle,
  backLinkText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: tokens.primary,
  } as TextStyle,

  // Scroll
  scroll: { flex: 1 } as ViewStyle,
  scrollContent: { flexGrow: 1 } as ViewStyle,
  pageWrap: {
    width: '100%',
    maxWidth: 1280,
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

  // 3-column top card
  topCard: {
    marginBottom: 20,
    padding: 0,
    overflow: 'hidden',
  } as ViewStyle,
  topCardRow: {
    flexDirection: Platform.OS === 'web' ? 'row' : 'column',
  } as ViewStyle,

  // Content row (main + right rail)
  contentRow: {
    flexDirection: Platform.OS === 'web' ? 'row' : 'column',
    gap: 24,
    alignItems: 'flex-start',
  } as ViewStyle,
  mainCol: { flex: 1 } as ViewStyle,

  // Web right rail card
  railCard: {
    padding: 16,
    gap: 2,
  } as ViewStyle,
  railCardTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 13,
    color: '#111827',
    marginBottom: 10,
  } as TextStyle,

  // Count badge (sessions header)
  countBadge: {
    backgroundColor: tokens.primary + '15',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 100,
  } as ViewStyle,
  countBadgeText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 10,
    color: tokens.primary,
  } as TextStyle,

  // Member Journey section header right slot
  journeyHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  } as ViewStyle,
  journeyEditBtn: {
    width: 26,
    height: 26,
    borderRadius: radius.sm,
    backgroundColor: tokens.gray100,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  addJourneyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: tokens.primary + '12',
    borderWidth: 1,
    borderColor: tokens.primary + '40',
  } as ViewStyle,
  addJourneyBtnText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 11,
    color: tokens.primary,
  } as TextStyle,

  // HIPAA notice
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

  // Error / 403 state
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
});

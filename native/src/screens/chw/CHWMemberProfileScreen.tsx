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
 *   - Quick Access rail card (web, right rail) — Case Notes, Screening Results,
 *                Eligibility Verification, Uploaded Documents.
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
  Image,
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
  type ImageStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  Calendar,
  Check,
  CheckCircle,
  CheckCircle2,
  Circle,
  Clock,
  Edit2,
  FileText,
  Flag,
  FolderOpen,
  Heart,
  MessageSquare,
  NotebookPen,
  Pencil,
  Phone,
  Plus,
  Shield,
  ShieldCheck,
  ShieldOff,
  ShieldX,
  Star,
  User,
  CheckSquare,
  UploadCloud,
  ChevronRight,
  ClipboardList,
  X,
} from 'lucide-react-native';
import { useQuery } from '@tanstack/react-query';

// Web-only: createPortal lets fixed overlays escape any transformed ancestor.
// Metro replaces Platform.OS with the literal platform string at build time, so
// native bundles never execute this require and react-dom is not bundled for native.
let _webCreatePortal: ((children: React.ReactNode, container: Element) => React.ReactPortal) | null =
  null;
if (Platform.OS === 'web') {
  // Typed inline (not via `typeof import('react-dom')`) so we don't need a
  // direct @types/react-dom dev dep — that package's peer pins @types/react
  // ^19.2.0 which conflicts with our ~19.1.0 and broke Vercel's npm install.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  _webCreatePortal = (
    require('react-dom') as {
      createPortal: (children: React.ReactNode, container: Element) => React.ReactPortal;
    }
  ).createPortal;
}

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
  useUpdateMemberPreferredName,
  useUpdateMemberDemographics,
  useUpdateMemberResourceNeeds,
  useCloseMember,
  useReopenMember,
  useFlagNote,
  useCreateFlagNote,
  useDeleteFlagNote,
  useChwBillableUnits,
  useCreateMemberJourney,
  useJourneyTemplates,
  useMemberJourneys,
  useMemberRewardsBalance,
  useCaseNotes,
  useCreateCaseNote,
  useSessionNotes,
  useMemberDocuments,
  useCreateCustomJourney,
  useUpdateJourneyPriority,
  useRemoveJourney,
  useAddJourneyNode,
  useUpdateJourneyNode,
  useDeleteJourneyNode,
  useUpdateJourneyStep,
  useUpdateJourneyStepStatus,
  type CreateMemberJourneyPayload,
  type JourneyTemplateResponse,
  type ServicesConsentValue,
  type MemberJourneyResponse,
  type MemberJourneyStepResponse,
  type MemberDemographicsUpdate,
  type ResourceNeedLevel,
} from '../../hooks/useApiQueries';
import {
  INSURANCE_OPTIONS,
  validateCinForCarrier,
  expectedFormatMessage,
} from '../../constants/insurance';
import { POINTS_ENABLED } from '../../constants/featureFlags';

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
  /** Member's self-uploaded avatar (presigned). Null → fall back to initials. */
  profilePictureUrl?: string | null;
  /** Member's chosen name; null falls back to firstName in the UI. */
  preferredName: string | null;
  phoneE164: string | null;
  email: string | null;
  primaryLanguage: string;
  additionalLanguages: string[];
  address: string | null;
  city: string | null;
  zipCode: string | null;
  mco: string | null;
  // Raw address parts for the demographics edit modal (joined `address`/`city`
  // above are display-only).
  addressLine1: string | null;
  addressLine2: string | null;
  cityName: string | null;
  state: string | null;
  ecmEligible: boolean;
  primaryCategories: string[];
  /** Member's editable resource needs (selection order). Drives the pencil edit. */
  resourceNeeds: string[];
  /** CHW-assigned priority level per resource need slug. List of {slug, level} pairs — slugs are intact snake_case values from the API. */
  resourceNeedLevels: Array<{ slug: string; level: ResourceNeedLevel }>;
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
  // ── Member closure disposition ────────────────────────────────────────────
  /** Disposition when closed; null = member is open/active. */
  closureStatus: CloseMemberStatus | null;
  /** One of the 12 closure reason slugs; null when open. */
  closureReason: CloseMemberReason | null;
  /** ISO timestamp the member was closed; null when open. */
  closedAt: string | null;
}

interface AssessmentResponseItem {
  questionId: string;
  questionText: string;
  answerValue: string;
  answerLabel: string;
}

interface AssessmentLatest {
  completedAt: string;
  responseCounts: Record<string, number>;
  /** Per-question answers (snapshots) returned by the latest-assessment endpoint. */
  responses: AssessmentResponseItem[];
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
  awaiting_documentation: 'Awaiting Docs',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'No Show',
};

/**
 * Format a session duration (minutes) as "Xh Ym" — or "Ym" under an hour.
 * Returns "—" when there is no recorded duration (e.g. scheduled/cancelled).
 */
function formatSessionDuration(mins: number | null | undefined): string {
  if (mins == null) return '—';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const minutes = mins % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/**
 * Billable Medi-Cal units from a session's duration (founder rule, 2026-07-04):
 * nothing bills until the 16th minute, then one unit per additional 30 minutes,
 * capped at the per-day maximum of 4.
 *
 *   ≤ 15 min  → 0    16–45 → 1    46–75 → 2    76–105 → 3    > 105 → 4
 *
 * Returns null when there is no duration to measure (nothing to bill yet).
 */
function billableUnitsFromDuration(mins: number | null | undefined): number | null {
  if (mins == null) return null;
  if (mins <= 15) return 0;
  return Math.min(4, Math.ceil((mins - 15) / 30));
}

const SESSION_MODE_LABELS: Record<string, string> = {
  in_person: 'In Person',
  virtual: 'Video',
  phone: 'Phone',
};

const CATEGORY_LABELS: Record<string, string> = {
  housing: 'Housing',
  food: 'Food Security',
  mental_health: 'Mental Health',
  transportation: 'Transportation',
  healthcare: 'Healthcare',
  employment: 'Employment',
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

// Canonical step descriptions, mirroring the backend STANDARD_STEPS. Used as a
// fallback so the read-only timeline always shows a description even when a
// journey's step (or the placeholder "no journey" state) doesn't carry one.
const JOURNEY_STEP_DESCRIPTIONS: Record<string, string> = {
  'Need Identified': "CHW confirms the member's active need for this pathway.",
  'Eligibility Screening': 'Member completes eligibility screening for the relevant program.',
  'Upload Documents': 'Member uploads required supporting documents.',
  'Follow Up': 'CHW follows up to confirm progress and next actions.',
  'Resource Connection': 'Member is connected to the appropriate resource or provider.',
  'Journey Complete': "Member's need has been addressed. Journey closed.",
};

// ─── Member closure vocabulary (mirrors backend CloseStatus / CloseReason) ──
// Slugs are the stable API values; the labels below are the display strings
// shown in the "Confirm Close" modal and the "Closed" badge.
type CloseMemberStatus = 'closed_successful' | 'closed_unsuccessful' | 'declined';
type CloseMemberReason =
  | 'successfully_completed'
  | 'unable_to_make_contact'
  | 'declined_all_services'
  | 'declined_further_services'
  | 'not_eligible'
  | 'lost_to_follow_up'
  | 'moved_out_of_area'
  | 'transferred_to_another_program'
  | 'no_longer_eligible'
  | 'duplicate'
  | 'deceased'
  | 'other';

const CLOSE_STATUS_OPTIONS: ReadonlyArray<{ value: CloseMemberStatus; label: string }> = [
  { value: 'closed_successful', label: 'Closed - Successful' },
  { value: 'closed_unsuccessful', label: 'Closed - Unsuccessful' },
  { value: 'declined', label: 'Declined' },
];

const CLOSE_REASON_OPTIONS: ReadonlyArray<{ value: CloseMemberReason; label: string }> = [
  { value: 'successfully_completed', label: 'Successfully Completed' },
  { value: 'unable_to_make_contact', label: 'Unable to Make Contact' },
  { value: 'declined_all_services', label: 'Declined All Services' },
  { value: 'declined_further_services', label: 'Declined Further Services' },
  { value: 'not_eligible', label: 'Not Eligible' },
  { value: 'lost_to_follow_up', label: 'Lost to Follow-Up' },
  { value: 'moved_out_of_area', label: 'Moved Out of Area' },
  { value: 'transferred_to_another_program', label: 'Transferred to Another Program' },
  { value: 'no_longer_eligible', label: 'No Longer Eligible For Services' },
  { value: 'duplicate', label: 'Duplicate' },
  { value: 'deceased', label: 'Deceased' },
  { value: 'other', label: 'Other' },
];

const CLOSE_STATUS_LABEL: Record<CloseMemberStatus, string> = Object.fromEntries(
  CLOSE_STATUS_OPTIONS.map((o) => [o.value, o.label]),
) as Record<CloseMemberStatus, string>;

// Orange accent for the Close/Reopen affordance (matches the archive icon).
const CLOSE_ACCENT = '#EA580C'; // orange-600

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

// ─── Date helpers (shared by EditDemographicsModal) ───────────────────────────

/** Convert an ISO date ("YYYY-MM-DD") to the MM/DD/YYYY display string. */
function isoToMmddyyyy(iso: string | null | undefined): string {
  if (!iso) return '';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : '';
}

/** Parse MM/DD/YYYY → ISO "YYYY-MM-DD"; returns null when the value is unparseable. */
function mmddyyyyToIso(value: string): string | null {
  const m = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > 2100) {
    return null;
  }
  return `${m[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const DEMOGRAPHICS_SEX_OPTIONS = ['Male', 'Female', 'Other'] as const;

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
  /** When provided, renders a section-level edit pencil on the right. */
  onEdit?: () => void;
}

function ColumnHeading({ text, sub, onEdit }: ColumnHeadingProps): React.JSX.Element {
  return (
    <View style={colHeadingStyles.row}>
      <Text style={colHeadingStyles.text}>{text}</Text>
      {sub ? <Text style={colHeadingStyles.sub}>{sub}</Text> : null}
      {onEdit ? (
        <TouchableOpacity
          style={colHeadingStyles.editBtn}
          onPress={onEdit}
          accessibilityRole="button"
          accessibilityLabel={`Edit ${text}`}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Pencil size={12} color={tokens.textSecondary} />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const colHeadingStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginBottom: 12,
  } as ViewStyle,
  editBtn: {
    marginLeft: 'auto',
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

// ─── EditDemographicsModal ────────────────────────────────────────────────────

interface EditDemographicsModalProps {
  visible: boolean;
  profile: CHWMemberProfileDetail;
  memberId: string;
  onClose: () => void;
}

/**
 * Full demographics editor for the CHW Member Profile.
 *
 * Covers every field the CHW can see on the demographics card:
 * first name, last name, preferred name, date of birth (MM/DD/YYYY),
 * sex (Male/Female/Other picker), insurance, Medi-Cal CIN, address
 * line 1 & 2, city, state, ZIP, phone, and primary language.
 *
 * On save it calls useUpdateMemberDemographics which PATCHes only the
 * supplied fields and then invalidates the CHW member-detail query so
 * the demographics card refreshes automatically.
 *
 * Backend 422 errors surface the response `detail` string inline.
 * DOB is validated client-side before the network call.
 */
function EditDemographicsModal({
  visible,
  profile,
  memberId,
  onClose,
}: EditDemographicsModalProps): React.JSX.Element {
  const updateDemographics = useUpdateMemberDemographics(memberId);

  // ── Form state ────────────────────────────────────────────────────────────
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [preferredName, setPreferredName] = useState('');
  const [dob, setDob] = useState(''); // MM/DD/YYYY
  const [sex, setSex] = useState('');
  const [insurance, setInsurance] = useState('');
  const [cin, setCin] = useState('');
  const [addr1, setAddr1] = useState('');
  const [addr2, setAddr2] = useState('');
  const [city, setCity] = useState('');
  const [stateCode, setStateCode] = useState('');
  const [zip, setZip] = useState('');
  const [phone, setPhone] = useState('');
  const [language, setLanguage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showSexPicker, setShowSexPicker] = useState(false);
  const [showInsurancePicker, setShowInsurancePicker] = useState(false);

  // Hydrate form whenever the modal opens.
  useEffect(() => {
    if (visible) {
      setFirstName(profile.firstName ?? '');
      setLastName(profile.lastName ?? '');
      setPreferredName(profile.preferredName ?? '');
      setDob(isoToMmddyyyy(profile.dateOfBirth));
      setSex(profile.gender ?? '');
      setInsurance(profile.mco ?? '');
      setCin(profile.mediCalId ?? '');
      setAddr1(profile.addressLine1 ?? '');
      setAddr2(profile.addressLine2 ?? '');
      setCity(profile.cityName ?? '');
      setStateCode(profile.state ?? '');
      setZip(profile.zipCode ?? '');
      setPhone(profile.phoneE164 ?? '');
      setLanguage(profile.primaryLanguage ?? '');
      setError(null);
      setShowSexPicker(false);
      setShowInsurancePicker(false);
    }
  }, [visible, profile]);

  /**
   * Live CIN format error — re-computes whenever `cin` or `insurance` changes.
   * Null when CIN is empty (optional for CHW edits) or when it matches the
   * carrier format. Non-null string blocks the Save button.
   *
   * Carrier-aware: switching the Insurance dropdown re-validates the current
   * CIN against the new carrier's format immediately.
   */
  const cinFormatError = useMemo((): string | null => {
    if (!cin.trim()) return null;
    const result = validateCinForCarrier(cin, insurance);
    if (result.valid) return null;
    return `${expectedFormatMessage(insurance)} Also accepted: commercial/Medicare IDs.`;
  }, [cin, insurance]);

  // Esc key closes on web.
  useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [visible, onClose]);

  const handleSave = useCallback(async (): Promise<void> => {
    setError(null);

    const payload: MemberDemographicsUpdate = {};

    if (firstName.trim()) payload.firstName = firstName.trim();
    if (lastName.trim()) payload.lastName = lastName.trim();
    payload.preferredName = preferredName.trim() || null;

    if (dob.trim()) {
      const iso = mmddyyyyToIso(dob);
      if (!iso) {
        setError('Date of birth must be MM/DD/YYYY (e.g. 05/21/1990).');
        return;
      }
      payload.dateOfBirth = iso;
    } else {
      payload.dateOfBirth = null;
    }

    if (sex) payload.gender = sex;
    if (insurance.trim()) payload.insurance = insurance.trim();

    if (cin.trim()) {
      // Profile edit: BLOCK save when the CIN doesn't match the selected
      // insurance carrier's expected format. cinFormatError is the live
      // validation computed from the current cin + insurance values.
      // Re-validates when either the CIN or insurance dropdown changes.
      if (cinFormatError) {
        setError(cinFormatError);
        return; // BLOCK the save — do not call the API until CIN is corrected
      }
      const result = validateCinForCarrier(cin, insurance);
      payload.mediCalId = result.normalized;
    } else {
      payload.mediCalId = null;
    }

    payload.addressLine1 = addr1.trim() || null;
    payload.addressLine2 = addr2.trim() || null;
    payload.city = city.trim() || null;

    if (stateCode.trim() && stateCode.trim().length !== 2) {
      setError('State must be a 2-letter code (e.g. CA).');
      return;
    }
    payload.state = stateCode.trim().toUpperCase() || null;
    payload.zipCode = zip.trim() || null;
    if (phone.trim()) payload.phone = phone.trim();
    if (language.trim()) payload.primaryLanguage = language.trim();

    try {
      await updateDemographics.mutateAsync(payload);
      onClose();
    } catch (err: unknown) {
      const detail =
        err != null &&
        typeof err === 'object' &&
        'detail' in err &&
        typeof (err as { detail: unknown }).detail === 'string'
          ? (err as { detail: string }).detail
          : 'Could not save. Please check your entries and try again.';
      setError(detail);
    }
  }, [
    firstName, lastName, preferredName, dob, sex, insurance, cin,
    cinFormatError, addr1, addr2, city, stateCode, zip, phone, language,
    updateDemographics, onClose,
  ]);

  const body = (
    <View style={editDemoStyles.container}>
      {/* Header */}
      <View style={editDemoStyles.header}>
        <Text style={editDemoStyles.title}>Edit Demographics</Text>
        <TouchableOpacity
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <X size={18} color="#6B7280" />
        </TouchableOpacity>
      </View>

      {/* Scrollable fields */}
      <ScrollView
        style={editDemoStyles.scroll}
        contentContainerStyle={editDemoStyles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Name section */}
        <Text style={editDemoStyles.sectionLabel}>Name</Text>

        <Text style={editDemoStyles.fieldLabel}>First Name</Text>
        <TextInput
          style={editDemoStyles.input}
          value={firstName}
          onChangeText={setFirstName}
          placeholder="First name"
          placeholderTextColor="#9CA3AF"
          accessibilityLabel="First name"
        />

        <Text style={[editDemoStyles.fieldLabel, editDemoStyles.fieldLabelSpaced]}>Last Name</Text>
        <TextInput
          style={editDemoStyles.input}
          value={lastName}
          onChangeText={setLastName}
          placeholder="Last name"
          placeholderTextColor="#9CA3AF"
          accessibilityLabel="Last name"
        />

        <Text style={[editDemoStyles.fieldLabel, editDemoStyles.fieldLabelSpaced]}>Preferred Name</Text>
        <TextInput
          style={editDemoStyles.input}
          value={preferredName}
          onChangeText={setPreferredName}
          placeholder="What they'd like to be called (optional)"
          placeholderTextColor="#9CA3AF"
          accessibilityLabel="Preferred name"
        />

        <View style={editDemoStyles.divider} />
        <Text style={editDemoStyles.sectionLabel}>Personal Details</Text>

        <Text style={editDemoStyles.fieldLabel}>Date of Birth</Text>
        <TextInput
          style={editDemoStyles.input}
          value={dob}
          onChangeText={setDob}
          placeholder="MM/DD/YYYY"
          placeholderTextColor="#9CA3AF"
          autoCorrect={false}
          maxLength={10}
          accessibilityLabel="Date of birth"
        />

        <Text style={[editDemoStyles.fieldLabel, editDemoStyles.fieldLabelSpaced]}>Sex</Text>
        <TouchableOpacity
          style={editDemoStyles.selectorBtn}
          onPress={() => setShowSexPicker((p) => !p)}
          accessibilityRole="button"
          accessibilityLabel={`Sex: ${sex || 'Select'}`}
        >
          <Text
            style={[
              editDemoStyles.selectorText,
              !sex && editDemoStyles.selectorPlaceholder,
            ]}
          >
            {sex || 'Select…'}
          </Text>
          <Text style={editDemoStyles.selectorChevron}>
            {showSexPicker ? '▲' : '▼'}
          </Text>
        </TouchableOpacity>
        {showSexPicker && (
          <View style={editDemoStyles.pickerList}>
            {DEMOGRAPHICS_SEX_OPTIONS.map((opt) => {
              const isSelected = opt === sex;
              return (
                <TouchableOpacity
                  key={opt}
                  style={[
                    editDemoStyles.pickerItem,
                    isSelected && editDemoStyles.pickerItemSelected,
                  ]}
                  onPress={() => {
                    setSex(opt);
                    setShowSexPicker(false);
                  }}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: isSelected }}
                  accessibilityLabel={opt}
                >
                  <Text
                    style={[
                      editDemoStyles.pickerItemText,
                      isSelected && editDemoStyles.pickerItemTextSelected,
                    ]}
                  >
                    {opt}
                  </Text>
                  {isSelected && <Check size={14} color={tokens.primary} />}
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        <View style={editDemoStyles.divider} />
        <Text style={editDemoStyles.sectionLabel}>Insurance</Text>

        <Text style={editDemoStyles.fieldLabel}>Insurance</Text>
        <TouchableOpacity
          style={editDemoStyles.selectorBtn}
          onPress={() => { setShowInsurancePicker((p) => !p); setShowSexPicker(false); }}
          accessibilityRole="button"
          accessibilityLabel={`Insurance carrier: ${insurance || 'Select carrier'}`}
        >
          <Text
            style={[
              editDemoStyles.selectorText,
              !insurance && editDemoStyles.selectorPlaceholder,
            ]}
            numberOfLines={1}
          >
            {insurance || 'Select carrier…'}
          </Text>
          <Text style={editDemoStyles.selectorChevron}>
            {showInsurancePicker ? '▲' : '▼'}
          </Text>
        </TouchableOpacity>
        {showInsurancePicker && (
          <View style={editDemoStyles.pickerList}>
            {INSURANCE_OPTIONS.map((carrier) => {
              const isSelected = carrier === insurance;
              return (
                <TouchableOpacity
                  key={carrier}
                  style={[
                    editDemoStyles.pickerItem,
                    isSelected && editDemoStyles.pickerItemSelected,
                  ]}
                  onPress={() => {
                    setInsurance(carrier);
                    setShowInsurancePicker(false);
                  }}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: isSelected }}
                  accessibilityLabel={carrier}
                >
                  <Text
                    style={[
                      editDemoStyles.pickerItemText,
                      isSelected && editDemoStyles.pickerItemTextSelected,
                    ]}
                  >
                    {carrier}
                  </Text>
                  {isSelected && <Check size={14} color={tokens.primary} />}
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        <Text style={[editDemoStyles.fieldLabel, editDemoStyles.fieldLabelSpaced]}>Member ID / Medi-Cal CIN</Text>
        <TextInput
          style={[editDemoStyles.input, cinFormatError !== null && editDemoStyles.inputError]}
          value={cin}
          onChangeText={(t) => setCin(t.toUpperCase())}
          placeholder="e.g. 91234567A2"
          placeholderTextColor="#9CA3AF"
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={14}
          accessibilityLabel="Medi-Cal CIN"
          accessibilityHint="Medi-Cal CIN (91234567A2), 14-char BIC, or commercial/Medicare ID"
        />
        {/* Live CIN format error — shown as soon as the format looks wrong.
            Blocks Save until the user corrects the CIN or insurance selection. */}
        {cinFormatError !== null ? (
          <Text style={editDemoStyles.cinError} accessibilityRole="alert">
            {cinFormatError}
          </Text>
        ) : (
          <Text style={editDemoStyles.hint}>
            Medi-Cal CIN: 9 + 7 digits + letter + check digit (e.g. 91234567A2)
          </Text>
        )}

        <View style={editDemoStyles.divider} />
        <Text style={editDemoStyles.sectionLabel}>Address</Text>

        <Text style={editDemoStyles.fieldLabel}>Address Line 1</Text>
        <TextInput
          style={editDemoStyles.input}
          value={addr1}
          onChangeText={setAddr1}
          placeholder="Street address"
          placeholderTextColor="#9CA3AF"
          accessibilityLabel="Address line 1"
        />

        <Text style={[editDemoStyles.fieldLabel, editDemoStyles.fieldLabelSpaced]}>Address Line 2</Text>
        <TextInput
          style={editDemoStyles.input}
          value={addr2}
          onChangeText={setAddr2}
          placeholder="Apt, unit, etc. (optional)"
          placeholderTextColor="#9CA3AF"
          accessibilityLabel="Address line 2"
        />

        {/* City / State / ZIP row */}
        <View style={editDemoStyles.inlineRow}>
          <View style={editDemoStyles.inlineGrow}>
            <Text style={[editDemoStyles.fieldLabel, editDemoStyles.fieldLabelSpaced]}>City</Text>
            <TextInput
              style={editDemoStyles.input}
              value={city}
              onChangeText={setCity}
              placeholder="City"
              placeholderTextColor="#9CA3AF"
              accessibilityLabel="City"
            />
          </View>
          <View style={editDemoStyles.inlineState}>
            <Text style={[editDemoStyles.fieldLabel, editDemoStyles.fieldLabelSpaced]}>State</Text>
            <TextInput
              style={editDemoStyles.input}
              value={stateCode}
              onChangeText={(t) => setStateCode(t.toUpperCase())}
              placeholder="CA"
              placeholderTextColor="#9CA3AF"
              autoCapitalize="characters"
              maxLength={2}
              accessibilityLabel="State"
            />
          </View>
          <View style={editDemoStyles.inlineZip}>
            <Text style={[editDemoStyles.fieldLabel, editDemoStyles.fieldLabelSpaced]}>ZIP</Text>
            <TextInput
              style={editDemoStyles.input}
              value={zip}
              onChangeText={setZip}
              placeholder="90001"
              placeholderTextColor="#9CA3AF"
              keyboardType="number-pad"
              maxLength={10}
              accessibilityLabel="ZIP code"
            />
          </View>
        </View>

        <View style={editDemoStyles.divider} />
        <Text style={editDemoStyles.sectionLabel}>Contact & Language</Text>

        <Text style={editDemoStyles.fieldLabel}>Phone</Text>
        <TextInput
          style={editDemoStyles.input}
          value={phone}
          onChangeText={setPhone}
          placeholder="+1 (555) 000-0000"
          placeholderTextColor="#9CA3AF"
          keyboardType="phone-pad"
          accessibilityLabel="Phone number"
        />

        <Text style={[editDemoStyles.fieldLabel, editDemoStyles.fieldLabelSpaced]}>Primary Language</Text>
        <TextInput
          style={editDemoStyles.input}
          value={language}
          onChangeText={setLanguage}
          placeholder="English"
          placeholderTextColor="#9CA3AF"
          accessibilityLabel="Primary language"
        />

        {/* Inline error */}
        {error !== null && (
          <Text style={editDemoStyles.errorText} accessibilityRole="alert">
            {error}
          </Text>
        )}
      </ScrollView>

      {/* Footer actions */}
      <View style={editDemoStyles.footer}>
        <TouchableOpacity
          style={editDemoStyles.cancelBtn}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Cancel"
        >
          <Text style={editDemoStyles.cancelBtnText}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            editDemoStyles.saveBtn,
            (updateDemographics.isPending || cinFormatError !== null) && editDemoStyles.saveBtnDisabled,
          ]}
          onPress={() => { void handleSave(); }}
          disabled={updateDemographics.isPending || cinFormatError !== null}
          accessibilityRole="button"
          accessibilityLabel="Save demographics"
        >
          {updateDemographics.isPending ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Text style={editDemoStyles.saveBtnText}>Save</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );

  if (Platform.OS !== 'web') {
    return (
      <Modal
        visible={visible}
        animationType="slide"
        presentationStyle="formSheet"
        onRequestClose={onClose}
        accessibilityViewIsModal
      >
        <View style={editDemoStyles.nativeContainer}>{body}</View>
      </Modal>
    );
  }

  if (!visible) return <></>;

  return (
    <View style={editDemoStyles.webOverlay}>
      <Pressable
        style={editDemoStyles.webBackdrop}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close modal"
      />
      <View style={editDemoStyles.webPanel}>{body}</View>
    </View>
  );
}

const editDemoStyles = StyleSheet.create({
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
    backgroundColor: 'rgba(17,24,39,0.45)',
  } as ViewStyle,
  webPanel: {
    width: '100%',
    maxWidth: 560,
    maxHeight: '90vh' as unknown as number,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    overflow: 'hidden',
    zIndex: 1,
  } as ViewStyle,

  // Native container
  nativeContainer: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  } as ViewStyle,

  // Modal body wrapper (shared)
  container: {
    flex: 1,
    flexDirection: 'column',
    backgroundColor: '#FFFFFF',
  } as ViewStyle,

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  } as ViewStyle,
  title: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 17,
    color: '#111827',
  } as TextStyle,

  // Scroll
  scroll: {
    flex: 1,
  } as ViewStyle,
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 20,
    gap: 4,
  } as ViewStyle,

  // Section labels (group headings within the form)
  sectionLabel: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 11,
    color: '#6B7280',
    textTransform: 'uppercase' as const,
    letterSpacing: 0.8,
    marginBottom: 8,
    marginTop: 2,
  } as TextStyle,

  // Field label
  fieldLabel: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 11,
    color: '#6B7280',
    textTransform: 'uppercase' as const,
    letterSpacing: 0.7,
    marginBottom: 4,
  } as TextStyle,
  fieldLabelSpaced: {
    marginTop: 12,
  } as TextStyle,

  // Text input
  input: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: 'PlusJakartaSans_400Regular',
    color: '#111827',
    backgroundColor: '#FAFAFA',
  } as TextStyle,

  // Hint text (below CIN input — shown when CIN is valid or empty)
  hint: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#9CA3AF',
    marginTop: 4,
  } as TextStyle,

  // Red border on the CIN input when the format looks incorrect
  inputError: {
    borderColor: '#DC2626',
  } as ViewStyle,

  // Live CIN format error message — blocks Save until corrected
  cinError: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    color: '#DC2626',
    marginTop: 4,
    lineHeight: 18,
  } as TextStyle,

  // Sex dropdown
  selectorBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#FAFAFA',
  } as ViewStyle,
  selectorText: {
    flex: 1,
    fontSize: 14,
    fontFamily: 'PlusJakartaSans_400Regular',
    color: '#111827',
  } as TextStyle,
  selectorPlaceholder: {
    color: '#9CA3AF',
  } as TextStyle,
  selectorChevron: {
    fontSize: 10,
    color: '#6B7280',
    marginLeft: 8,
  } as TextStyle,
  pickerList: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 8,
    marginTop: 4,
    overflow: 'hidden',
    backgroundColor: '#FFFFFF',
  } as ViewStyle,
  pickerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  } as ViewStyle,
  pickerItemSelected: {
    backgroundColor: `${tokens.primary}10`,
  } as ViewStyle,
  pickerItemText: {
    flex: 1,
    fontSize: 13,
    fontFamily: 'PlusJakartaSans_400Regular',
    color: '#111827',
  } as TextStyle,
  pickerItemTextSelected: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    color: tokens.primary,
  } as TextStyle,

  // Inline city/state/ZIP row
  inlineRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'flex-end',
  } as ViewStyle,
  inlineGrow: { flex: 1 } as ViewStyle,
  inlineState: { width: 64 } as ViewStyle,
  inlineZip: { width: 96 } as ViewStyle,

  // Section divider
  divider: {
    height: 1,
    backgroundColor: '#F3F4F6',
    marginVertical: 16,
  } as ViewStyle,

  // Error
  errorText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    color: '#B91C1C',
    marginTop: 12,
    lineHeight: 18,
  } as TextStyle,

  // Footer
  footer: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
  } as ViewStyle,
  cancelBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    alignItems: 'center',
    backgroundColor: '#FAFAFA',
  } as ViewStyle,
  cancelBtnText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#6B7280',
  } as TextStyle,
  saveBtn: {
    flex: 2,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: tokens.primary,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  saveBtnDisabled: {
    opacity: 0.6,
  } as ViewStyle,
  saveBtnText: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
    color: '#FFFFFF',
  } as TextStyle,
});

// ─── EditResourceNeedsModal ───────────────────────────────────────────────────

/** The selectable resource-need categories (slug → label). */
const RESOURCE_NEED_OPTIONS: ReadonlyArray<{ slug: string; label: string }> = [
  { slug: 'housing',        label: 'Housing' },
  { slug: 'transportation', label: 'Transportation' },
  { slug: 'food',           label: 'Food Security' },
  { slug: 'mental_health',  label: 'Mental Health' },
  { slug: 'healthcare',     label: 'Healthcare' },
  { slug: 'employment',     label: 'Employment' },
];

/**
 * Canonical journey/template names that correspond 1:1 to a fixed resource need.
 * A member journey whose template name is NOT in this set is a CHW-authored
 * CUSTOM journey (i.e. a custom resource need). Used to (a) surface custom
 * journeys in the Resource Needs card and (b) prevent a custom need from
 * duplicating a fixed one.
 */
const CANONICAL_JOURNEY_NAMES: ReadonlySet<string> = new Set(
  RESOURCE_NEED_OPTIONS.map((o) => o.label),
);

interface EditResourceNeedsModalProps {
  visible: boolean;
  /** Current selection-ordered resource needs — used to pre-fill selection. */
  currentNeeds: string[];
  /** Current CHW-assigned level per slug — used to pre-fill the level controls. */
  currentLevels: Record<string, ResourceNeedLevel>;
  memberId: string;
  onClose: () => void;
}

/**
 * Modal for editing a member's resource needs and their CHW-assigned priority
 * levels (Low / Medium / High).
 *
 * Each of the 5 resource categories is shown as a toggleable chip row.
 * Already-selected needs are pre-checked with their existing levels. Newly
 * tapped needs are appended to the selection and default to "High". A Low /
 * Medium / High segmented control appears on each selected row so the CHW can
 * adjust the level without re-ordering.
 *
 * On "Save", calls useUpdateMemberResourceNeeds which PATCHes { needs, levels }
 * and invalidates the member-detail query so the card refreshes.
 * Errors surface inline. An empty selection is allowed (clears all needs).
 *
 * Platform:
 *   Web  — fixed overlay + panel with backdrop dismiss (mirrors
 *           EditDemographicsModal).
 *   Native — React Native Modal (form-sheet).
 */
function EditResourceNeedsModal({
  visible,
  currentNeeds,
  currentLevels,
  memberId,
  onClose,
}: EditResourceNeedsModalProps): React.JSX.Element {
  const updateResourceNeeds = useUpdateMemberResourceNeeds(memberId);
  const createCustomJourney = useCreateCustomJourney(memberId);
  const updateJourneyPriority = useUpdateJourneyPriority(memberId);
  const removeJourney = useRemoveJourney(memberId);
  const { data: existingJourneys } = useMemberJourneys(memberId);

  /** Custom needs the CHW has marked for removal (applied on Save). */
  const [customRemovals, setCustomRemovals] = useState<ReadonlySet<string>>(new Set());

  /**
   * Active CHW-authored custom needs (journeys whose name isn't a fixed need),
   * minus any the CHW has staged for removal this session.
   */
  const customNeeds = useMemo(
    () =>
      (existingJourneys ?? []).filter(
        (j) =>
          j.status === 'active' &&
          !CANONICAL_JOURNEY_NAMES.has(j.template.name) &&
          !customRemovals.has(j.id),
      ),
    [existingJourneys, customRemovals],
  );

  /**
   * Selection-ordered list of selected slugs — preserved for the `needs`
   * payload so the backend can maintain a stable display order.
   */
  const [selectedSlugs, setSelectedSlugs] = useState<string[]>([]);
  /** CHW-assigned priority level per selected slug. */
  const [levels, setLevels] = useState<Record<string, ResourceNeedLevel>>({});
  const [error, setError] = useState<string | null>(null);
  /** Free-text name + priority for a new CHW-authored custom resource need. */
  const [customName, setCustomName] = useState('');
  const [customLevel, setCustomLevel] = useState<ResourceNeedLevel>('high');
  /**
   * Pending (unsaved) priority edits for existing custom needs, keyed by
   * journey id. Applied on Save alongside the fixed-need changes; discarded on
   * Cancel — so custom and fixed needs behave identically.
   */
  const [customLevelEdits, setCustomLevelEdits] = useState<Record<string, ResourceNeedLevel>>({});

  // Hydrate selection and levels whenever the modal opens.
  useEffect(() => {
    if (visible) {
      // A fixed need is "selected" if it's saved OR already has an active
      // canonical journey — so the modal matches the (journey-driven) Resource
      // Needs card and Member Journey section. This keeps all three in sync, and
      // means saving never silently abandons an in-progress journey.
      const activeCanonical = (existingJourneys ?? []).filter(
        (j) => j.status === 'active' && CANONICAL_JOURNEY_NAMES.has(j.template.name),
      );
      const slugByLabel = (label: string): string | undefined =>
        RESOURCE_NEED_OPTIONS.find((o) => o.label === label)?.slug;

      const slugs = [...currentNeeds];
      const nextLevels: Record<string, ResourceNeedLevel> = { ...currentLevels };
      for (const j of activeCanonical) {
        const slug = slugByLabel(j.template.name);
        if (slug === undefined) continue;
        if (!slugs.includes(slug)) slugs.push(slug);
        // Default an unrecorded level to the journey's DISPLAYED (derived) level,
        // so opening + saving the modal doesn't change what the CHW already sees.
        if (!(slug in nextLevels)) nextLevels[slug] = deriveSeverity(j.progressPercent);
      }

      setSelectedSlugs(slugs);
      setLevels(nextLevels);
      setCustomLevelEdits({});
      setCustomRemovals(new Set());
      setError(null);
    }
  }, [visible, currentNeeds, currentLevels, existingJourneys]);

  // Esc key closes on web.
  useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [visible, onClose]);

  /**
   * Toggle a category slug in the selection.
   *   - If already selected, remove it and clear its level.
   *   - If not selected, append it to the end and default its level to 'high'.
   */
  const toggleSlug = useCallback((slug: string): void => {
    setSelectedSlugs((prev) => {
      if (prev.includes(slug)) {
        setLevels((lvls) => {
          const next = { ...lvls };
          delete next[slug];
          return next;
        });
        return prev.filter((s) => s !== slug);
      }
      setLevels((lvls) => ({ ...lvls, [slug]: 'high' }));
      return [...prev, slug];
    });
  }, []);

  /** Set the CHW-assigned level for a specific slug. */
  const setLevel = useCallback((slug: string, level: ResourceNeedLevel): void => {
    setLevels((prev) => ({ ...prev, [slug]: level }));
  }, []);

  const handleSave = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      // Convert the working Record<slug, level> to the list-of-{slug,level} shape
      // the API now expects, filtered to only the currently selected slugs.
      const levelsArray = Object.entries(levels)
        .filter(([slug]) => selectedSlugs.includes(slug))
        .map(([slug, level]) => ({ slug, level }));
      await updateResourceNeeds.mutateAsync({ needs: selectedSlugs, levels: levelsArray });

      // Apply staged custom-need removals (abandon the journeys).
      const removalPromises = Array.from(customRemovals).map((id) =>
        removeJourney.mutateAsync(id),
      );

      // Persist any pending custom-need priority edits — only the ones that
      // actually changed (customNeeds already excludes removed ones).
      const customPatches = customNeeds
        .map((j) => ({ j, edited: customLevelEdits[j.id] }))
        .filter(({ j, edited }) => edited !== undefined && edited !== (j.priorityLevel ?? 'medium'))
        .map(({ j, edited }) =>
          updateJourneyPriority.mutateAsync({
            journeyId: j.id,
            priorityLevel: edited as ResourceNeedLevel,
          }),
        );

      await Promise.all([...removalPromises, ...customPatches]);

      onClose();
    } catch (err: unknown) {
      const detail =
        err != null &&
        typeof err === 'object' &&
        'detail' in err &&
        typeof (err as { detail: unknown }).detail === 'string'
          ? (err as { detail: string }).detail
          : 'Could not save resource needs. Please try again.';
      setError(detail);
    }
  }, [
    selectedSlugs,
    levels,
    updateResourceNeeds,
    customNeeds,
    customLevelEdits,
    customRemovals,
    updateJourneyPriority,
    removeJourney,
    onClose,
  ]);

  /** Stage a custom need for removal — applied (abandoned) on Save. */
  const handleRemoveCustom = useCallback((journeyId: string): void => {
    setCustomRemovals((prev) => new Set(prev).add(journeyId));
  }, []);

  /**
   * Create a CHW-authored custom resource need. This provisions a custom journey
   * (POST /journeys/custom) which then surfaces in BOTH the Resource Needs card
   * and the Member Journey section. Guards prevent duplicating a fixed need or an
   * existing custom journey.
   */
  const handleAddCustom = useCallback(async (): Promise<void> => {
    setError(null);
    const name = customName.trim();
    if (!name) return;

    const fixedLabels = RESOURCE_NEED_OPTIONS.map((o) => o.label.toLowerCase());
    if (fixedLabels.includes(name.toLowerCase())) {
      setError(`"${name}" is already a standard resource need — select it above instead.`);
      return;
    }
    const activeJourneyNames = (existingJourneys ?? [])
      .filter((j) => j.status === 'active')
      .map((j) => j.template.name.toLowerCase());
    if (activeJourneyNames.includes(name.toLowerCase())) {
      setError(`"${name}" already exists for this member.`);
      return;
    }

    try {
      await createCustomJourney.mutateAsync({ title: name, priorityLevel: customLevel });
      setCustomName('');
      setCustomLevel('high');
    } catch (err: unknown) {
      const detail =
        err != null &&
        typeof err === 'object' &&
        'detail' in err &&
        typeof (err as { detail: unknown }).detail === 'string'
          ? (err as { detail: string }).detail
          : 'Could not add custom resource need. Please try again.';
      setError(detail);
    }
  }, [customName, customLevel, existingJourneys, createCustomJourney]);

  /** Stage a custom need's priority change locally — persisted on Save. */
  const handleCustomLevelChange = useCallback(
    (journeyId: string, level: ResourceNeedLevel): void => {
      setCustomLevelEdits((prev) => ({ ...prev, [journeyId]: level }));
    },
    [],
  );

  /** Reusable Low/Med/High segmented control (used by the custom-need rows). */
  const renderLevelControl = (
    value: ResourceNeedLevel,
    onChange: (lvl: ResourceNeedLevel) => void,
  ): React.JSX.Element => (
    <View style={editResourceNeedsStyles.levelSegRow}>
      {(['low', 'medium', 'high'] as const).map((lvl) => {
        const isActive = value === lvl;
        return (
          <TouchableOpacity
            key={lvl}
            style={[
              editResourceNeedsStyles.levelPill,
              isActive &&
                (lvl === 'high'
                  ? editResourceNeedsStyles.levelPillHighActive
                  : lvl === 'medium'
                  ? editResourceNeedsStyles.levelPillMedActive
                  : editResourceNeedsStyles.levelPillLowActive),
            ]}
            onPress={() => onChange(lvl)}
            accessibilityRole="button"
            accessibilityLabel={lvl === 'low' ? 'Low' : lvl === 'medium' ? 'Medium' : 'High'}
            accessibilityState={{ selected: isActive }}
          >
            <Text
              style={[
                editResourceNeedsStyles.levelPillText,
                isActive &&
                  (lvl === 'high'
                    ? editResourceNeedsStyles.levelPillTextHigh
                    : lvl === 'medium'
                    ? editResourceNeedsStyles.levelPillTextMed
                    : editResourceNeedsStyles.levelPillTextLow),
              ]}
            >
              {lvl === 'low' ? 'Low' : lvl === 'medium' ? 'Med' : 'High'}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );

  const body = (
    <View style={editResourceNeedsStyles.container}>
      {/* Header */}
      <View style={editResourceNeedsStyles.header}>
        <Text style={editResourceNeedsStyles.title}>Edit Resource Needs</Text>
        <TouchableOpacity
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <X size={18} color="#6B7280" />
        </TouchableOpacity>
      </View>

      {/* Instruction */}
      <View style={editResourceNeedsStyles.instructionRow}>
        <Text style={editResourceNeedsStyles.instructionText}>
          Select the member's resource needs and set each one's priority level.
        </Text>
      </View>

      {/* Category chips */}
      <View style={editResourceNeedsStyles.chipList}>
        {RESOURCE_NEED_OPTIONS.map(({ slug, label }) => {
          const isSelected = selectedSlugs.includes(slug);
          const currentLevel = levels[slug] ?? 'high';

          return (
            <View
              key={slug}
              style={[
                editResourceNeedsStyles.chipRow,
                isSelected && editResourceNeedsStyles.chipRowSelected,
              ]}
            >
              {/* Toggle area: badge + label + check icon */}
              <TouchableOpacity
                style={editResourceNeedsStyles.chipRowToggle}
                onPress={() => toggleSlug(slug)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: isSelected }}
                accessibilityLabel={`${label}${isSelected ? `, ${currentLevel} priority, selected` : ''}`}
              >
                {/* Check circle or unchecked circle */}
                <View
                  style={[
                    editResourceNeedsStyles.chipBadge,
                    isSelected && editResourceNeedsStyles.chipBadgeSelected,
                  ]}
                >
                  {isSelected && <Check size={12} color="#FFFFFF" />}
                </View>

                {/* Label */}
                <Text
                  style={[
                    editResourceNeedsStyles.chipLabel,
                    isSelected && editResourceNeedsStyles.chipLabelSelected,
                  ]}
                  numberOfLines={1}
                >
                  {label}
                </Text>

                {/* Check icon when selected */}
                {isSelected && <Check size={14} color={tokens.primary} />}
              </TouchableOpacity>

              {/* Low / Medium / High segmented control (selected only) */}
              {isSelected && (
                <View style={editResourceNeedsStyles.levelSegRow}>
                  {(['low', 'medium', 'high'] as const).map((lvl) => {
                    const isActive = currentLevel === lvl;
                    return (
                      <TouchableOpacity
                        key={lvl}
                        style={[
                          editResourceNeedsStyles.levelPill,
                          isActive && (
                            lvl === 'high'
                              ? editResourceNeedsStyles.levelPillHighActive
                              : lvl === 'medium'
                              ? editResourceNeedsStyles.levelPillMedActive
                              : editResourceNeedsStyles.levelPillLowActive
                          ),
                        ]}
                        onPress={() => setLevel(slug, lvl)}
                        accessibilityRole="button"
                        accessibilityLabel={lvl === 'low' ? 'Low' : lvl === 'medium' ? 'Medium' : 'High'}
                        accessibilityState={{ selected: isActive }}
                      >
                        <Text
                          style={[
                            editResourceNeedsStyles.levelPillText,
                            isActive && (
                              lvl === 'high'
                                ? editResourceNeedsStyles.levelPillTextHigh
                                : lvl === 'medium'
                                ? editResourceNeedsStyles.levelPillTextMed
                                : editResourceNeedsStyles.levelPillTextLow
                            ),
                          ]}
                        >
                          {lvl === 'low' ? 'Low' : lvl === 'medium' ? 'Med' : 'High'}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              )}
            </View>
          );
        })}

        {/* Existing custom resource needs — rendered inside the same list so they
            share the fixed rows' width and inset. Priority is editable (saved on
            Save); the green badge marks them as CHW-authored. */}
        {customNeeds.map((j) => (
          <View
            key={j.id}
            style={[
              editResourceNeedsStyles.chipRow,
              editResourceNeedsStyles.chipRowSelected,
              editResourceNeedsStyles.customNeedRow,
            ]}
          >
            <View style={editResourceNeedsStyles.chipRowToggle}>
              <View style={[editResourceNeedsStyles.chipBadge, editResourceNeedsStyles.chipBadgeSelected]}>
                <Check size={12} color="#FFFFFF" />
              </View>
              <Text
                style={[editResourceNeedsStyles.chipLabel, editResourceNeedsStyles.chipLabelSelected]}
                numberOfLines={1}
              >
                {j.template.name}
              </Text>
            </View>
            {renderLevelControl(
              customLevelEdits[j.id] ?? j.priorityLevel ?? 'medium',
              (lvl) => handleCustomLevelChange(j.id, lvl),
            )}
            <TouchableOpacity
              style={editResourceNeedsStyles.customRemoveBtn}
              onPress={() => handleRemoveCustom(j.id)}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${j.template.name}`}
              hitSlop={{ top: 8, bottom: 8, left: 4, right: 8 }}
            >
              <X size={15} color={tokens.textMuted} />
            </TouchableOpacity>
          </View>
        ))}
      </View>

      {/* Add a custom resource need — creates a custom journey that then appears
          in BOTH the Resource Needs card and the Member Journey section. */}
      <View style={editResourceNeedsStyles.customAddWrap}>
        <Text style={editResourceNeedsStyles.customAddHeading}>Add a custom resource need</Text>
        <TextInput
          style={editResourceNeedsStyles.customInput}
          value={customName}
          onChangeText={setCustomName}
          placeholder="Name this resource need…"
          placeholderTextColor={tokens.textMuted}
          editable={!createCustomJourney.isPending}
          returnKeyType="done"
          onSubmitEditing={() => void handleAddCustom()}
          accessibilityLabel="Custom resource need name"
        />
        <View style={editResourceNeedsStyles.customAddControls}>
          <View style={editResourceNeedsStyles.customLevelGroup}>
            <Text style={editResourceNeedsStyles.customLevelLabel}>Priority</Text>
            {renderLevelControl(customLevel, setCustomLevel)}
          </View>
          <TouchableOpacity
            style={[
              editResourceNeedsStyles.customAddBtn,
              (createCustomJourney.isPending || customName.trim().length === 0) &&
                editResourceNeedsStyles.customAddBtnDisabled,
            ]}
            onPress={() => void handleAddCustom()}
            disabled={createCustomJourney.isPending || customName.trim().length === 0}
            accessibilityRole="button"
            accessibilityLabel="Add custom resource need"
          >
            {createCustomJourney.isPending ? (
              <ActivityIndicator size="small" color={tokens.primary} />
            ) : (
              <>
                <Plus size={14} color={tokens.primary} />
                <Text style={editResourceNeedsStyles.customAddBtnText}>Add</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </View>

      {/* Inline error */}
      {error !== null && (
        <Text style={editResourceNeedsStyles.errorText} accessibilityRole="alert">
          {error}
        </Text>
      )}

      {/* Footer actions */}
      <View style={editResourceNeedsStyles.footer}>
        <TouchableOpacity
          style={editResourceNeedsStyles.cancelBtn}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Cancel"
        >
          <Text style={editResourceNeedsStyles.cancelBtnText}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            editResourceNeedsStyles.saveBtn,
            updateResourceNeeds.isPending && editResourceNeedsStyles.saveBtnDisabled,
          ]}
          onPress={() => { void handleSave(); }}
          disabled={updateResourceNeeds.isPending}
          accessibilityRole="button"
          accessibilityLabel="Save resource needs"
        >
          {updateResourceNeeds.isPending ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Text style={editResourceNeedsStyles.saveBtnText}>Save</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );

  if (Platform.OS !== 'web') {
    return (
      <Modal
        visible={visible}
        animationType="slide"
        presentationStyle="formSheet"
        onRequestClose={onClose}
        accessibilityViewIsModal
      >
        <View style={editResourceNeedsStyles.nativeContainer}>{body}</View>
      </Modal>
    );
  }

  if (!visible) return <></>;

  return (
    <View style={editResourceNeedsStyles.webOverlay}>
      <Pressable
        style={editResourceNeedsStyles.webBackdrop}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close modal"
      />
      <View style={editResourceNeedsStyles.webPanel}>{body}</View>
    </View>
  );
}

const editResourceNeedsStyles = StyleSheet.create({
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
    backgroundColor: 'rgba(17,24,39,0.45)',
  } as ViewStyle,
  webPanel: {
    width: '100%',
    maxWidth: 460,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    overflow: 'hidden',
    zIndex: 1,
  } as ViewStyle,

  // Native container
  nativeContainer: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  } as ViewStyle,

  // Modal body wrapper
  container: {
    flexDirection: 'column',
    backgroundColor: '#FFFFFF',
  } as ViewStyle,

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  } as ViewStyle,
  title: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 17,
    color: '#111827',
  } as TextStyle,

  // Instruction text
  instructionRow: {
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 8,
  } as ViewStyle,
  instructionText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: '#6B7280',
    lineHeight: 19,
  } as TextStyle,

  // Chip list
  chipList: {
    paddingHorizontal: 20,
    paddingBottom: 8,
    gap: 8,
  } as ViewStyle,
  chipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#FAFAFA',
  } as ViewStyle,
  chipRowSelected: {
    borderColor: tokens.primary,
    backgroundColor: `${tokens.primary}0D`,
  } as ViewStyle,
  /** Left portion of the chip row — check circle + label + check icon. */
  chipRowToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flex: 1,
  } as ViewStyle,

  // Check-circle badge
  chipBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: '#D1D5DB',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,
  chipBadgeSelected: {
    backgroundColor: tokens.primary,
    borderColor: tokens.primary,
  } as ViewStyle,

  chipLabel: {
    flex: 1,
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#374151',
  } as TextStyle,
  chipLabelSelected: {
    color: '#111827',
  } as TextStyle,

  // Low / Medium / High segmented control
  levelSegRow: {
    flexDirection: 'row',
    gap: 4,
    alignItems: 'center',
    flexShrink: 0,
  } as ViewStyle,
  levelPill: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#F9FAFB',
  } as ViewStyle,
  levelPillHighActive: {
    backgroundColor: tokens.red100,
    borderColor: tokens.red700,
  } as ViewStyle,
  levelPillMedActive: {
    backgroundColor: tokens.amber100,
    borderColor: tokens.amber700,
  } as ViewStyle,
  levelPillLowActive: {
    backgroundColor: tokens.emerald100,
    borderColor: tokens.emerald700,
  } as ViewStyle,
  levelPillText: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 10,
    color: '#9CA3AF',
  } as TextStyle,
  levelPillTextHigh: {
    color: tokens.red700,
  } as TextStyle,
  levelPillTextMed: {
    color: tokens.amber700,
  } as TextStyle,
  levelPillTextLow: {
    color: tokens.emerald700,
  } as TextStyle,

  // Custom-need row: tighter right padding + gap so the level control and the
  // remove (X) button both fit cleanly without crowding the edge.
  customNeedRow: {
    paddingRight: 8,
    gap: 6,
  } as ViewStyle,
  customRemoveBtn: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,

  // ── Add-a-custom-need composer ────────────────────────────────────────────
  // Inset to match the chip list (paddingHorizontal: 20) and separated by a
  // hairline divider so it reads as a distinct "compose" area.
  customAddWrap: {
    marginTop: 4,
    marginHorizontal: 20,
    paddingTop: 14,
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: tokens.cardBorder,
  } as ViewStyle,
  customAddHeading: {
    fontSize: 13,
    fontWeight: '700',
    color: tokens.textPrimary,
  } as TextStyle,
  customInput: {
    alignSelf: 'stretch',
    height: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    backgroundColor: tokens.cardBg,
    paddingHorizontal: 12,
    fontSize: 14,
    color: tokens.textPrimary,
  } as TextStyle,
  customAddControls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  } as ViewStyle,
  customLevelGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 1,
  } as ViewStyle,
  customLevelLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: tokens.textMuted,
  } as TextStyle,
  customAddBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 16,
    height: 38,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: tokens.primary,
    backgroundColor: `${tokens.primary}12`,
    flexShrink: 0,
  } as ViewStyle,
  customAddBtnDisabled: {
    opacity: 0.45,
  } as ViewStyle,
  customAddBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: tokens.primary,
  } as TextStyle,

  // Error
  errorText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    color: '#B91C1C',
    marginTop: 8,
    marginHorizontal: 20,
    lineHeight: 18,
  } as TextStyle,

  // Footer
  footer: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
    marginTop: 8,
  } as ViewStyle,
  cancelBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    alignItems: 'center',
    backgroundColor: '#FAFAFA',
  } as ViewStyle,
  cancelBtnText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#6B7280',
  } as TextStyle,
  saveBtn: {
    flex: 2,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: tokens.primary,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  saveBtnDisabled: {
    opacity: 0.6,
  } as ViewStyle,
  saveBtnText: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
    color: '#FFFFFF',
  } as TextStyle,
});

// ─── DemographicsColumn ───────────────────────────────────────────────────────

interface DemographicsColumnProps {
  profile: CHWMemberProfileDetail;
  memberId: string;
  displayName: string;
  servicesConsentRefused: boolean;
  onNavigateToConversation: (conversationId: string) => void;
  onNavigateAndCall: () => void;
  /** Navigates to the Messages screen and auto-triggers the Begin Session flow. */
  onBeginSession: () => void;
  /** When provided, the demographics pencil opens this callback instead of
   *  the legacy inline preferred-name editor. Supplied by the parent screen. */
  onEditDemographics?: () => void;
  /** Opens the Confirm Close modal (rendered at the screen root). */
  onOpenCloseMember: () => void;
  /** Reopens a closed member. */
  onReopenMember: () => void;
  /** True while the reopen mutation is in flight. */
  reopenPending: boolean;
  /** Narrow/split-screen web: render full-width (stacked) instead of a flex column. */
  stacked?: boolean;
}

/**
 * Inline-editable Preferred Name row. View mode shows the value (falling back to
 * first name) with a pencil; tapping the pencil reveals a text field + save/cancel
 * that PATCHes /chw/members/{id}/preferred-name.
 */
function PreferredNameRow({
  memberId,
  profile,
  editing,
  onClose,
}: {
  memberId: string;
  profile: CHWMemberProfileDetail;
  editing: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(profile.preferredName ?? '');
  const update = useUpdateMemberPreferredName(memberId);

  const current = profile.preferredName ?? profile.firstName ?? '';

  // Re-seed the draft each time we enter edit mode (triggered by the section pencil).
  useEffect(() => {
    if (editing) setDraft(profile.preferredName ?? '');
  }, [editing, profile.preferredName]);

  const save = (): void => {
    update.mutate(draft.trim() || null, {
      onSuccess: () => onClose(),
      onError: () => {
        const msg = 'Could not update preferred name. Please try again.';
        if (Platform.OS === 'web' && typeof window !== 'undefined') window.alert(msg);
        else Alert.alert('Error', msg);
      },
    });
  };

  if (editing) {
    return (
      <View style={prefNameStyles.editRow}>
        <User size={13} color={tokens.primary} />
        <TextInput
          style={prefNameStyles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="Preferred name"
          placeholderTextColor="#9CA3AF"
          autoFocus
          maxLength={100}
          editable={!update.isPending}
          onSubmitEditing={save}
          accessibilityLabel="Preferred name input"
        />
        {update.isPending ? (
          <ActivityIndicator size="small" color={tokens.primary} />
        ) : (
          <>
            <TouchableOpacity onPress={save} accessibilityRole="button" accessibilityLabel="Save preferred name" hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Check size={16} color={tokens.primary} />
            </TouchableOpacity>
            <TouchableOpacity onPress={onClose} accessibilityRole="button" accessibilityLabel="Cancel" hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <X size={16} color="#9CA3AF" />
            </TouchableOpacity>
          </>
        )}
      </View>
    );
  }

  return (
    <InfoRow
      icon={<User size={13} color={tokens.primary} />}
      label="Preferred Name"
      value={current || 'Not provided'}
      placeholder={!current}
    />
  );
}

const prefNameStyles = StyleSheet.create({
  editRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
  } as ViewStyle,
  input: {
    flex: 1,
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: tokens.textPrimary ?? '#111827',
    borderWidth: 1,
    borderColor: tokens.cardBorder ?? '#E5E7EB',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    outlineStyle: 'none',
  } as unknown as TextStyle,
});

/**
 * Compact demographics field — label on the left (muted), value on the right
 * (bold). No icon, tight vertical rhythm. Matches the mockup's right-of-avatar
 * field list.
 */
function DemoField({
  label,
  value,
  placeholder = false,
}: {
  label: string;
  value: string;
  placeholder?: boolean;
}): React.JSX.Element {
  return (
    <View style={demoColStyles.fieldRow}>
      <Text style={demoColStyles.fieldLabel}>{label}</Text>
      <Text
        style={[demoColStyles.fieldValue, placeholder && demoColStyles.fieldValuePlaceholder]}
      >
        {value}
      </Text>
    </View>
  );
}

/**
 * A single dropdown selector (button + expandable option list) used inside the
 * Close Member modal. Mirrors the Sex/Insurance pickers in the demographics
 * edit modal, but generic over the option value type.
 */
function CloseSelect<T extends string>({
  label,
  placeholder,
  value,
  options,
  open,
  onToggle,
  onSelect,
}: {
  label: string;
  placeholder: string;
  value: T | null;
  options: ReadonlyArray<{ value: T; label: string }>;
  open: boolean;
  onToggle: () => void;
  onSelect: (value: T) => void;
}): React.JSX.Element {
  const selectedLabel = options.find((o) => o.value === value)?.label ?? null;
  return (
    <View style={closeModalStyles.field}>
      <Text style={closeModalStyles.fieldLabel}>{label}</Text>
      <TouchableOpacity
        style={[closeModalStyles.selectorBtn, open && closeModalStyles.selectorBtnActive]}
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${selectedLabel ?? placeholder}`}
      >
        <Text
          style={[
            closeModalStyles.selectorText,
            !selectedLabel && closeModalStyles.selectorPlaceholder,
          ]}
        >
          {selectedLabel ?? placeholder}
        </Text>
        <Text style={closeModalStyles.selectorChevron}>{open ? '▲' : '▼'}</Text>
      </TouchableOpacity>
      {open && (
        <ScrollView style={closeModalStyles.pickerList} nestedScrollEnabled>
          {options.map((opt) => {
            const isSelected = opt.value === value;
            return (
              <TouchableOpacity
                key={opt.value}
                style={[
                  closeModalStyles.pickerItem,
                  isSelected && closeModalStyles.pickerItemSelected,
                ]}
                onPress={() => onSelect(opt.value)}
                accessibilityRole="radio"
                accessibilityState={{ selected: isSelected }}
                accessibilityLabel={opt.label}
              >
                <Text
                  style={[
                    closeModalStyles.pickerItemText,
                    isSelected && closeModalStyles.pickerItemTextSelected,
                  ]}
                >
                  {opt.label}
                </Text>
                {isSelected && <Check size={14} color={tokens.primary} />}
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

/**
 * "Confirm Close" modal — the CHW picks a disposition (Status) and Reason, then
 * confirms. Both are required before Confirm enables. Modeled on the PearSuite
 * close-member flow. Resets its selection each time it opens.
 */
function CloseMemberModal({
  visible,
  displayName,
  isSubmitting,
  onCancel,
  onConfirm,
}: {
  visible: boolean;
  displayName: string;
  isSubmitting: boolean;
  onCancel: () => void;
  onConfirm: (status: CloseMemberStatus, reason: CloseMemberReason) => void;
}): React.JSX.Element {
  const [status, setStatus] = useState<CloseMemberStatus | null>(null);
  const [reason, setReason] = useState<CloseMemberReason | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [reasonOpen, setReasonOpen] = useState(false);

  // Reset selection whenever the modal transitions to visible.
  useEffect(() => {
    if (visible) {
      setStatus(null);
      setReason(null);
      setStatusOpen(false);
      setReasonOpen(false);
    }
  }, [visible]);

  const canConfirm = status != null && reason != null && !isSubmitting;

  const body = (
    <View style={closeModalStyles.card}>
      <View style={closeModalStyles.header}>
        <Text style={closeModalStyles.headerTitle}>Confirm Close</Text>
      </View>
      <View style={closeModalStyles.content}>
        <Text style={closeModalStyles.prompt}>
          {`Are you sure you want to close ${displayName}?`}
        </Text>

        <CloseSelect
          label="Status"
          placeholder="Select Status…"
          value={status}
          options={CLOSE_STATUS_OPTIONS}
          open={statusOpen}
          onToggle={() => {
            setStatusOpen((p) => !p);
            setReasonOpen(false);
          }}
          onSelect={(v) => {
            setStatus(v);
            setStatusOpen(false);
          }}
        />

        <CloseSelect
          label="Reason"
          placeholder="Select Reason…"
          value={reason}
          options={CLOSE_REASON_OPTIONS}
          open={reasonOpen}
          onToggle={() => {
            setReasonOpen((p) => !p);
            setStatusOpen(false);
          }}
          onSelect={(v) => {
            setReason(v);
            setReasonOpen(false);
          }}
        />

        <View style={closeModalStyles.actions}>
          <TouchableOpacity
            style={[closeModalStyles.actionBtn, closeModalStyles.cancelBtn]}
            onPress={onCancel}
            disabled={isSubmitting}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
          >
            <Text style={closeModalStyles.cancelBtnText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              closeModalStyles.actionBtn,
              closeModalStyles.confirmBtn,
              !canConfirm && closeModalStyles.confirmBtnDisabled,
            ]}
            onPress={() => {
              if (status != null && reason != null) onConfirm(status, reason);
            }}
            disabled={!canConfirm}
            accessibilityRole="button"
            accessibilityLabel="Confirm close"
            accessibilityState={{ disabled: !canConfirm }}
          >
            {isSubmitting ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Text style={closeModalStyles.confirmBtnText}>Confirm</Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );

  // Use a React Native <Modal> on BOTH web and native. On web, react-native-web
  // renders the Modal into a portal appended to the document root, so it escapes
  // the (transform-wrapped, tall) profile-screen container that made a
  // position:fixed overlay behave like position:absolute — which parked the
  // dialog near the bottom of the long page and behind the cards. The portal
  // covers the FULL viewport (sidebar included), so the backdrop dims everything
  // and the dialog is always centered and on top.
  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent
      onRequestClose={onCancel}
      accessibilityViewIsModal
    >
      <View style={closeModalStyles.overlay}>
        <Pressable
          style={closeModalStyles.backdrop}
          onPress={onCancel}
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
        />
        {body}
      </View>
    </Modal>
  );
}

const closeModalStyles = StyleSheet.create({
  // Fills the Modal's portal (full viewport on web + native) and centers the card.
  overlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  } as ViewStyle,
  backdrop: {
    position: 'absolute' as 'absolute',
    inset: 0,
    // Dim the ENTIRE screen so only the dialog is highlighted.
    backgroundColor: 'rgba(17,24,39,0.55)',
  } as ViewStyle,
  card: {
    width: '100%',
    maxWidth: 460,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    overflow: 'hidden',
    zIndex: 1,
    // Lift the dialog off the dimmed page so it reads as the only active surface.
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.25,
    shadowRadius: 32,
    elevation: 12,
  } as ViewStyle,
  header: {
    backgroundColor: tokens.emerald700,
    paddingVertical: 16,
    paddingHorizontal: 20,
  } as ViewStyle,
  headerTitle: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 18,
    color: '#FFFFFF',
  } as TextStyle,
  content: {
    padding: 20,
    gap: 16,
  } as ViewStyle,
  prompt: {
    fontFamily: 'PlusJakartaSans_500Medium',
    fontSize: 15,
    color: tokens.textPrimary,
  } as TextStyle,
  field: {
    gap: 6,
  } as ViewStyle,
  fieldLabel: {
    fontFamily: 'PlusJakartaSans_500Medium',
    fontSize: 13,
    color: tokens.textSecondary,
  } as TextStyle,
  selectorBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 14,
  } as ViewStyle,
  selectorBtnActive: {
    borderColor: tokens.primary,
  } as ViewStyle,
  selectorText: {
    fontFamily: 'PlusJakartaSans_500Medium',
    fontSize: 15,
    color: tokens.textPrimary,
  } as TextStyle,
  selectorPlaceholder: {
    color: tokens.textMuted,
  } as TextStyle,
  selectorChevron: {
    fontSize: 12,
    color: tokens.textMuted,
    marginLeft: 8,
  } as TextStyle,
  pickerList: {
    marginTop: 4,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 10,
    maxHeight: 200,
  } as ViewStyle,
  pickerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 11,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  } as ViewStyle,
  pickerItemSelected: {
    backgroundColor: tokens.primary + '10',
  } as ViewStyle,
  pickerItemText: {
    fontFamily: 'PlusJakartaSans_500Medium',
    fontSize: 15,
    color: tokens.textPrimary,
  } as TextStyle,
  pickerItemTextSelected: {
    color: tokens.primary,
  } as TextStyle,
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    marginTop: 4,
  } as ViewStyle,
  actionBtn: {
    minWidth: 104,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 11,
    paddingHorizontal: 18,
    borderRadius: 10,
  } as ViewStyle,
  cancelBtn: {
    backgroundColor: '#EF4444',
  } as ViewStyle,
  cancelBtnText: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
    color: '#FFFFFF',
  } as TextStyle,
  confirmBtn: {
    backgroundColor: tokens.emerald700,
  } as ViewStyle,
  confirmBtnDisabled: {
    opacity: 0.45,
  } as ViewStyle,
  confirmBtnText: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
    color: '#FFFFFF',
  } as TextStyle,
});

/**
 * Left column of the 3-column top card. Compact two-sub-column card: avatar +
 * Call/Message on the left, demographic fields listed to the right (per mockup).
 *
 * The section-level pencil now opens the full EditDemographicsModal (via
 * onEditDemographics) rather than the legacy inline preferred-name editor.
 */
function DemographicsColumn({
  profile,
  memberId,
  displayName,
  servicesConsentRefused,
  onNavigateToConversation,
  onNavigateAndCall,
  onBeginSession,
  onEditDemographics,
  onOpenCloseMember,
  onReopenMember,
  reopenPending,
  stacked = false,
}: DemographicsColumnProps): React.JSX.Element {
  const initials = getInitials(profile.firstName, profile.lastName);

  // A closed member disables active engagement (Begin Session / Message) — same
  // as a services-consent refusal — and swaps the primary CTA for "Reopen".
  const isClosed = profile.closureStatus != null;
  const ctaDisabled = servicesConsentRefused || isClosed;

  // Two-line address: street (+ apt/suite) on the first line; city, state, and
  // ZIP grouped together on the second so "Los Angeles, CA, 90062" never wraps
  // apart. `profile.address` is "line1[, line2]" and `profile.city` is
  // "City, ST" (both assembled server-side).
  const cityStateZip = [profile.city, profile.zipCode].filter(Boolean).join(', ');
  const addressLabel = profile.address
    ? [profile.address, cityStateZip].filter(Boolean).join('\n')
    : profile.zipCode
    ? `ZIP ${profile.zipCode}`
    : 'Not provided';

  const languageValue = [profile.primaryLanguage, ...profile.additionalLanguages]
    .filter(Boolean)
    .join(', ');

  return (
    <View style={[demoColStyles.container, stacked && demoColStyles.containerStacked]}>
      {/* Card header: title + section edit pencil */}
      <View style={demoColStyles.cardHeader}>
        <Text style={demoColStyles.cardTitle}>Member Demographics</Text>
        <TouchableOpacity
          onPress={onEditDemographics}
          accessibilityRole="button"
          accessibilityLabel="Edit demographics"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Pencil size={13} color={tokens.textSecondary} />
        </TouchableOpacity>
      </View>

      {/* Body: avatar + Call/Message on the left, fields on the right */}
      <View style={demoColStyles.body}>
        {/* Left sub-column */}
        <View style={demoColStyles.leftCol}>
          <View style={demoColStyles.avatar}>
            {profile.profilePictureUrl ? (
              <Image
                source={{ uri: profile.profilePictureUrl }}
                style={demoColStyles.avatarImage}
                accessibilityLabel={`${displayName} profile photo`}
              />
            ) : (
              <Text style={demoColStyles.avatarText}>{initials}</Text>
            )}
          </View>
          <View style={demoColStyles.badgesRow}>
            {isClosed ? (
              <Pill variant="amber" size="sm" style={demoColStyles.statusPillWrap}>
                {`Closed · ${CLOSE_STATUS_LABEL[profile.closureStatus as CloseMemberStatus]}`}
              </Pill>
            ) : (
              <Pill variant="emerald" size="sm">Active</Pill>
            )}
            {profile.ecmEligible && <Pill variant="blue" size="sm">ECM</Pill>}
          </View>
          <View style={demoColStyles.ctaStack}>
            <TouchableOpacity
              style={[demoColStyles.ctaBtn, demoColStyles.beginSessionBtn, ctaDisabled && demoColStyles.ctaBtnDisabled]}
              onPress={ctaDisabled ? undefined : onBeginSession}
              disabled={ctaDisabled}
              accessibilityRole="button"
              accessibilityLabel={
                isClosed
                  ? 'Begin Session disabled — member is closed'
                  : ctaDisabled
                  ? 'Begin Session disabled — member has refused services'
                  : `Begin Session with ${displayName}`
              }
              accessibilityState={{ disabled: ctaDisabled }}
            >
              <Text style={demoColStyles.ctaBtnText}>Begin Session</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[demoColStyles.ctaBtn, demoColStyles.messageBtn, ctaDisabled && demoColStyles.ctaBtnDisabled]}
              onPress={ctaDisabled ? undefined : () => onNavigateToConversation('')}
              disabled={ctaDisabled}
              accessibilityRole="button"
              accessibilityLabel={
                isClosed
                  ? 'Message disabled — member is closed'
                  : ctaDisabled
                  ? 'Message disabled — member has refused services'
                  : `Message ${displayName}`
              }
              accessibilityState={{ disabled: ctaDisabled }}
            >
              <MessageSquare size={14} color={tokens.primary} />
              <Text style={[demoColStyles.ctaBtnText, { color: tokens.primary }]}>Message</Text>
            </TouchableOpacity>

            {/* Close / Reopen member — the orange archive affordance. The
                Confirm Close modal is rendered at the screen root (see parent)
                so its overlay isn't clipped by this card's stacking context. */}
            {isClosed ? (
              <TouchableOpacity
                style={[demoColStyles.ctaBtn, demoColStyles.reopenBtn]}
                onPress={onReopenMember}
                disabled={reopenPending}
                accessibilityRole="button"
                accessibilityLabel={`Reopen ${displayName}`}
              >
                <Archive size={14} color={CLOSE_ACCENT} />
                <Text style={[demoColStyles.ctaBtnText, { color: CLOSE_ACCENT }]}>
                  {reopenPending ? 'Reopening…' : 'Reopen Member'}
                </Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={[demoColStyles.ctaBtn, demoColStyles.closeBtn]}
                onPress={onOpenCloseMember}
                accessibilityRole="button"
                accessibilityLabel={`Close ${displayName}`}
              >
                <Archive size={14} color={CLOSE_ACCENT} />
                <Text style={[demoColStyles.ctaBtnText, { color: CLOSE_ACCENT }]}>Close Member</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* Right sub-column: fields */}
        <View style={demoColStyles.fields}>
          <DemoField label="Last Name" value={profile.lastName || 'Not provided'} placeholder={!profile.lastName} />
          <DemoField label="First Name" value={profile.firstName || 'Not provided'} placeholder={!profile.firstName} />
          <DemoField
            label="Preferred Name"
            value={(profile.preferredName ?? profile.firstName) || 'Not provided'}
            placeholder={!(profile.preferredName ?? profile.firstName)}
          />
          <View style={demoColStyles.divider} />
          <DemoField label="Date of Birth" value={formatDob(profile.dateOfBirth)} placeholder={!profile.dateOfBirth} />
          <DemoField label="Sex" value={profile.gender ?? 'Not provided'} placeholder={!profile.gender} />
          <View style={demoColStyles.divider} />
          <DemoField label="Insurance" value={profile.mco ?? 'Not provided'} placeholder={!profile.mco} />
          <DemoField label="Member ID" value={profile.mediCalId ?? 'Not provided'} placeholder={!profile.mediCalId} />
          <View style={demoColStyles.divider} />
          <DemoField label="Address" value={addressLabel} placeholder={!profile.address && !profile.zipCode} />
          <DemoField label="Phone" value={profile.phoneE164 ?? 'Not provided'} placeholder={!profile.phoneE164} />
          <DemoField label="Primary Language" value={languageValue || 'Not provided'} placeholder={!languageValue} />
          {profile.email ? <DemoField label="Email" value={profile.email} /> : null}
        </View>
      </View>
    </View>
  );
}

const demoColStyles = StyleSheet.create({
  container: {
    flex: Platform.OS === 'web' ? 5 : undefined,
    borderRightWidth: Platform.OS === 'web' ? 1 : 0,
    borderRightColor: '#F3F4F6',
    padding: 16,
  } as ViewStyle,
  // Stacked (narrow/split web): full-width, hug content, drop the row divider.
  containerStacked: {
    flexGrow: 0,
    flexShrink: 1,
    flexBasis: 'auto',
    borderRightWidth: 0,
  } as ViewStyle,
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  } as ViewStyle,
  cardTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 13,
    color: '#111827',
  } as TextStyle,
  body: {
    flexDirection: 'row',
    gap: 16,
    alignItems: 'flex-start',
  } as ViewStyle,
  leftCol: {
    width: 132,
    alignItems: 'center',
    gap: 8,
  } as ViewStyle,
  avatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#CBD5E1',
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  avatarText: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 22,
    color: '#FFFFFF',
  } as TextStyle,
  avatarImage: {
    width: 72,
    height: 72,
    borderRadius: 36,
  } as ImageStyle,
  badgesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
    justifyContent: 'center',
    // Fill the left sub-column so a capped-width status pill can wrap instead
    // of overflowing past the avatar on both sides.
    alignSelf: 'stretch',
  } as ViewStyle,
  // Caps the closed-status pill to the column width → its label wraps to two
  // lines rather than being clipped on either side.
  statusPillWrap: {
    maxWidth: '100%',
  } as ViewStyle,
  ctaStack: {
    alignSelf: 'stretch',
    gap: 8,
    marginTop: 4,
  } as ViewStyle,
  ctaStackDisabled: {
    opacity: 0.45,
  } as ViewStyle,
  ctaBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 9,
    borderRadius: radius.md,
  } as ViewStyle,
  /**
   * Matches CHWMessagesScreen beginSessionBtn exactly:
   * emerald700 background, borderRadius 10, 11px vertical / 16px horizontal padding.
   */
  beginSessionBtn: {
    backgroundColor: tokens.emerald700,
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 16,
  } as ViewStyle,
  messageBtn: {
    backgroundColor: tokens.primary + '12',
    borderWidth: 1,
    borderColor: tokens.primary + '40',
  } as ViewStyle,
  // Orange outline affordance for Close Member (matches the archive icon).
  closeBtn: {
    backgroundColor: CLOSE_ACCENT + '12',
    borderWidth: 1,
    borderColor: CLOSE_ACCENT + '40',
  } as ViewStyle,
  reopenBtn: {
    backgroundColor: CLOSE_ACCENT + '12',
    borderWidth: 1,
    borderColor: CLOSE_ACCENT + '40',
  } as ViewStyle,
  ctaBtnDisabled: {
    opacity: 0.45,
  } as ViewStyle,
  ctaBtnText: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 13,
    color: '#FFFFFF',
  } as TextStyle,
  fields: {
    flex: 1,
  } as ViewStyle,
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 3,
    gap: 8,
  } as ViewStyle,
  fieldLabel: {
    width: 112,
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: '#6B7280',
  } as TextStyle,
  fieldValue: {
    flex: 1,
    fontFamily: 'DMSans_700Bold',
    fontSize: 13,
    color: '#111827',
  } as TextStyle,
  fieldValuePlaceholder: {
    fontFamily: 'PlusJakartaSans_400Regular',
    color: '#9CA3AF',
    fontStyle: 'italic',
  } as TextStyle,
  divider: {
    height: 1,
    backgroundColor: '#F3F4F6',
    marginVertical: 6,
  } as ViewStyle,
});

// ─── CenterColumn: FlagNoteCard + BillingConsentCard ─────────────────────────

type ServicesConsentStatus = ServicesConsentValue | null;

interface CenterColumnProps {
  memberId: string;
  /** Opens the Flag Member edit drawer (re-uses FlagMemberModal). */
  onEditFlag: () => void;
  /** Narrow/split-screen web: render full-width (stacked). */
  stacked?: boolean;
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
  stacked = false,
}: CenterColumnProps): React.JSX.Element {
  return (
    <View style={[centerColStyles.container, stacked && centerColStyles.containerStacked]}>
      <FlagNoteCard memberId={memberId} onEditFlag={onEditFlag} />
      <BillingConsentCard memberId={memberId} />
    </View>
  );
}

const centerColStyles = StyleSheet.create({
  container: {
    flex: Platform.OS === 'web' ? 4 : undefined,
    borderRightWidth: Platform.OS === 'web' ? 1 : 0,
    borderRightColor: '#F3F4F6',
    borderTopWidth: Platform.OS === 'web' ? 0 : 1,
    borderTopColor: '#F3F4F6',
    gap: 0,
  } as ViewStyle,
  // Stacked (narrow/split web): full-width, hug content, divider on top.
  containerStacked: {
    flexGrow: 0,
    flexShrink: 1,
    flexBasis: 'auto',
    borderRightWidth: 0,
    borderTopWidth: 1,
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
            Added {formatDate(flagNote.createdAt)} by You
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
}

/**
 * Light-green card showing the member's services consent status.
 * "View Consent" button placeholder — opens full consent detail (no behavior yet).
 */
function BillingConsentCard({
  memberId,
}: BillingConsentCardProps): React.JSX.Element {
  const [showConsent, setShowConsent] = useState(false);
  const { data: consentData } = useMemberServicesConsent(memberId);

  // Billable / non-billable toggle (CHW-controlled). Defaults to billable.
  const { data: billingStatus, isLoading } = useMemberBillingStatus(memberId);
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

  // Billing consent is captured by default at signup (it's required to create a
  // member account) and stays "captured" while the member is billable. Turning
  // the Billable toggle off records the member as having declined billing (their
  // sessions become non-billable) until it's turned back on. Two states only.
  const statusLabel = isBillable ? 'Consent captured' : 'Declined';
  const statusColor = isBillable ? '#15803D' : '#B91C1C';
  const statusIcon = isBillable ? (
    <ShieldCheck size={13} color={statusColor} />
  ) : (
    <ShieldX size={13} color={statusColor} />
  );

  return (
    <View style={billingConsentCardStyles.container}>
      {/* Header */}
      <View style={billingConsentCardStyles.headerRow}>
        <Text style={billingConsentCardStyles.title}>Billing Consent</Text>
        <TouchableOpacity
          style={{ marginLeft: 'auto' }}
          onPress={() => {
            const msg =
              'Billing consent is captured from the member. Use the Billable toggle below to set whether this member’s sessions are billable.';
            if (Platform.OS === 'web' && typeof window !== 'undefined') window.alert(msg);
            else Alert.alert('Billing Consent', msg);
          }}
          accessibilityRole="button"
          accessibilityLabel="Edit billing consent"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Pencil size={12} color="#15803D" />
        </TouchableOpacity>
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
        onPress={() => setShowConsent(true)}
        accessibilityRole="button"
        accessibilityLabel="View full consent details"
      >
        <Text style={billingConsentCardStyles.viewBtnText}>View Consent</Text>
      </TouchableOpacity>

      {/* Consent detail modal */}
      <Modal
        visible={showConsent}
        transparent
        animationType="fade"
        onRequestClose={() => setShowConsent(false)}
        accessibilityViewIsModal
      >
        <View style={consentModalStyles.overlay}>
          <View style={consentModalStyles.sheet}>
            <View style={consentModalStyles.headerRow}>
              <Text style={consentModalStyles.title}>Billing &amp; Services Consent</Text>
              <TouchableOpacity
                onPress={() => setShowConsent(false)}
                accessibilityRole="button"
                accessibilityLabel="Close"
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <X size={18} color="#6B7280" />
              </TouchableOpacity>
            </View>

            <View style={consentModalStyles.statusRow}>
              {statusIcon}
              <Text style={[consentModalStyles.statusLabel, { color: statusColor }]}>
                {statusLabel}
              </Text>
            </View>

            <Text style={consentModalStyles.meta}>
              {consentData?.changedAt
                ? `Last updated ${formatDate(consentData.changedAt)}`
                : 'No consent change recorded yet.'}
            </Text>
            <Text style={consentModalStyles.meta}>
              Billing: {isBillable ? 'Billable to Medi-Cal' : 'Non-billable (excluded)'}
              {billingStatus?.changedAt ? ` · updated ${formatDate(billingStatus.changedAt)}` : ''}
            </Text>

            <View style={consentModalStyles.divider} />

            <Text style={consentModalStyles.bodyText}>
              The member consents to receive Community Health Worker services and to the
              sharing of their information as needed for care coordination and Medi-Cal
              billing. Consent is captured from and controlled by the member; this card
              reflects their current choice. Billing eligibility is set by the CHW via the
              Billable toggle.
            </Text>

            <TouchableOpacity
              style={consentModalStyles.closeBtn}
              onPress={() => setShowConsent(false)}
              accessibilityRole="button"
              accessibilityLabel="Done"
            >
              <Text style={consentModalStyles.closeBtnText}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const consentModalStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(17,24,39,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  } as ViewStyle,
  sheet: {
    width: '100%',
    maxWidth: 440,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 20,
    gap: 10,
  } as ViewStyle,
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  } as ViewStyle,
  title: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 15,
    color: '#111827',
  } as TextStyle,
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  } as ViewStyle,
  statusLabel: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
  } as TextStyle,
  meta: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: '#6B7280',
  } as TextStyle,
  divider: {
    height: 1,
    backgroundColor: '#F3F4F6',
    marginVertical: 4,
  } as ViewStyle,
  bodyText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: '#374151',
    lineHeight: 19,
  } as TextStyle,
  closeBtn: {
    marginTop: 6,
    alignSelf: 'flex-end',
    backgroundColor: '#15803D',
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 8,
  } as ViewStyle,
  closeBtnText: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 13,
    color: '#FFFFFF',
  } as TextStyle,
});

const screeningStyles = StyleSheet.create({
  qaRow: {
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  } as ViewStyle,
  question: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: '#6B7280',
  } as TextStyle,
  answer: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 13,
    color: '#111827',
    marginTop: 2,
  } as TextStyle,
});

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

// ─── CreateCustomJourneyModal ─────────────────────────────────────────────────

/** Resource categories offered as quick-pick chips in the custom journey creator. */
const JOURNEY_CATEGORY_CHIPS: ReadonlyArray<{ label: string }> = [
  { label: 'Housing' },
  { label: 'Transportation' },
  { label: 'Food Security' },
  { label: 'Mental Health' },
  { label: 'Healthcare' },
  { label: 'Employment' },
];

interface CreateCustomJourneyModalProps {
  memberId: string;
  memberName: string;
  visible: boolean;
  onClose: () => void;
}

/**
 * Modal for creating a CHW-authored custom journey.
 *
 * The CHW types a free-form title or picks one of the 5 resource-category
 * quick-pick chips. On submit, calls `useCreateCustomJourney(memberId)` which
 * provisions the journey + 3 blank starter nodes (10/5/5 pts) and invalidates
 * the journeys cache so the new journey appears immediately.
 *
 * Platform: web fixed-overlay + Esc; native RN Modal.
 */
function CreateCustomJourneyModal({
  memberId,
  memberName,
  visible,
  onClose,
}: CreateCustomJourneyModalProps): React.JSX.Element {
  const createCustomJourney = useCreateCustomJourney(memberId);

  const [title, setTitle] = useState('');
  const [priorityLevel, setPriorityLevel] = useState<ResourceNeedLevel>('high');
  const [error, setError] = useState<string | null>(null);

  // Reset state whenever the modal opens.
  useEffect(() => {
    if (visible) {
      setTitle('');
      setPriorityLevel('high');
      setError(null);
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
    const trimmed = title.trim();
    if (!trimmed) {
      setError('Please enter a journey title or pick a category below.');
      return;
    }
    setError(null);
    try {
      await createCustomJourney.mutateAsync({ title: trimmed, priorityLevel });
      onClose();
    } catch (err: unknown) {
      const detail =
        err != null &&
        typeof err === 'object' &&
        'detail' in err &&
        typeof (err as { detail: unknown }).detail === 'string'
          ? (err as { detail: string }).detail
          : 'Could not create journey. Please try again.';
      setError(detail);
    }
  }, [title, priorityLevel, createCustomJourney, onClose]);

  const body = (
    <View style={createCustomJourneyStyles.container}>
      {/* Header */}
      <View style={createCustomJourneyStyles.header}>
        <View style={createCustomJourneyStyles.headerTextBlock}>
          <Text style={createCustomJourneyStyles.title}>Add a Journey</Text>
          <Text style={createCustomJourneyStyles.subtitle} numberOfLines={1}>
            for {memberName}
          </Text>
        </View>
        <TouchableOpacity
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <X size={18} color="#6B7280" />
        </TouchableOpacity>
      </View>

      {/* Body */}
      <View style={createCustomJourneyStyles.body}>
        {/* Free-text title */}
        <Text style={createCustomJourneyStyles.fieldLabel}>Journey title</Text>
        <TextInput
          style={createCustomJourneyStyles.input}
          value={title}
          onChangeText={setTitle}
          placeholder="e.g. Housing Stability"
          placeholderTextColor="#9CA3AF"
          autoFocus
          maxLength={120}
          returnKeyType="done"
          onSubmitEditing={() => { void handleSubmit(); }}
          accessibilityLabel="Journey title"
          editable={!createCustomJourney.isPending}
        />

        {/* Quick-pick chips */}
        <Text style={createCustomJourneyStyles.chipsSectionLabel}>
          Or pick a resource category
        </Text>
        <View style={createCustomJourneyStyles.chipsRow}>
          {JOURNEY_CATEGORY_CHIPS.map(({ label }) => {
            const isSelected = title === label;
            return (
              <TouchableOpacity
                key={label}
                style={[
                  createCustomJourneyStyles.chip,
                  isSelected && createCustomJourneyStyles.chipSelected,
                ]}
                onPress={() => setTitle(isSelected ? '' : label)}
                accessibilityRole="radio"
                accessibilityState={{ checked: isSelected }}
                accessibilityLabel={label}
              >
                <Text
                  style={[
                    createCustomJourneyStyles.chipText,
                    isSelected && createCustomJourneyStyles.chipTextSelected,
                  ]}
                >
                  {label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Priority */}
        <Text style={createCustomJourneyStyles.priorityLabel}>Priority</Text>
        <View style={createCustomJourneyStyles.priorityRow}>
          {(['low', 'medium', 'high'] as const).map((lvl) => {
            const isActive = priorityLevel === lvl;
            return (
              <TouchableOpacity
                key={lvl}
                style={[
                  createCustomJourneyStyles.priorityPill,
                  isActive && createCustomJourneyStyles.priorityPillActive,
                ]}
                onPress={() => setPriorityLevel(lvl)}
                disabled={createCustomJourney.isPending}
                accessibilityRole="radio"
                accessibilityState={{ selected: isActive }}
                accessibilityLabel={lvl === 'low' ? 'Low' : lvl === 'medium' ? 'Medium' : 'High'}
              >
                <Text
                  style={[
                    createCustomJourneyStyles.priorityPillText,
                    isActive && createCustomJourneyStyles.priorityPillTextActive,
                  ]}
                >
                  {lvl === 'low' ? 'Low' : lvl === 'medium' ? 'Medium' : 'High'}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Hint */}
        <Text style={createCustomJourneyStyles.hint}>
          Creates 3 blank starter nodes — you'll write the step text in edit mode.
        </Text>

        {/* Inline error */}
        {error !== null && (
          <Text style={createCustomJourneyStyles.errorText} accessibilityRole="alert">
            {error}
          </Text>
        )}
      </View>

      {/* Footer */}
      <View style={createCustomJourneyStyles.footer}>
        <TouchableOpacity
          style={createCustomJourneyStyles.cancelBtn}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Cancel"
        >
          <Text style={createCustomJourneyStyles.cancelBtnText}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            createCustomJourneyStyles.submitBtn,
            (!title.trim() || createCustomJourney.isPending) &&
              createCustomJourneyStyles.submitBtnDisabled,
          ]}
          onPress={() => { void handleSubmit(); }}
          disabled={!title.trim() || createCustomJourney.isPending}
          accessibilityRole="button"
          accessibilityLabel="Create journey"
          accessibilityState={{ disabled: !title.trim() || createCustomJourney.isPending }}
        >
          {createCustomJourney.isPending ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Text style={createCustomJourneyStyles.submitBtnText}>Create Journey</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );

  if (Platform.OS !== 'web') {
    return (
      <Modal
        visible={visible}
        animationType="slide"
        presentationStyle="formSheet"
        onRequestClose={onClose}
        accessibilityViewIsModal
      >
        <View style={createCustomJourneyStyles.nativeContainer}>{body}</View>
      </Modal>
    );
  }

  if (!visible) return <></>;

  return (
    <View style={createCustomJourneyStyles.webOverlay}>
      <Pressable
        style={createCustomJourneyStyles.webBackdrop}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close modal"
      />
      <View style={createCustomJourneyStyles.webPanel}>{body}</View>
    </View>
  );
}

const createCustomJourneyStyles = StyleSheet.create({
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
    backgroundColor: 'rgba(17,24,39,0.45)',
  } as ViewStyle,
  webPanel: {
    width: '100%',
    maxWidth: 480,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    overflow: 'hidden',
    zIndex: 1,
  } as ViewStyle,
  nativeContainer: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  } as ViewStyle,
  container: {
    flexDirection: 'column',
    backgroundColor: '#FFFFFF',
  } as ViewStyle,
  header: {
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
  headerTextBlock: {
    flex: 1,
    gap: 2,
  } as ViewStyle,
  title: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 17,
    color: '#111827',
  } as TextStyle,
  subtitle: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: '#6B7280',
  } as TextStyle,
  body: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 8,
    gap: 8,
  } as ViewStyle,
  fieldLabel: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 11,
    color: '#6B7280',
    textTransform: 'uppercase' as const,
    letterSpacing: 0.7,
    marginBottom: 2,
  } as TextStyle,
  input: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: 'PlusJakartaSans_400Regular',
    color: '#111827',
    backgroundColor: '#FAFAFA',
  } as TextStyle,
  chipsSectionLabel: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: '#6B7280',
    marginTop: 8,
    marginBottom: 4,
  } as TextStyle,
  chipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  } as ViewStyle,
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 100,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#F9FAFB',
  } as ViewStyle,
  chipSelected: {
    backgroundColor: `${tokens.primary}12`,
    borderColor: tokens.primary,
  } as ViewStyle,
  chipText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    color: '#374151',
  } as TextStyle,
  chipTextSelected: {
    color: tokens.primary,
  } as TextStyle,
  priorityLabel: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: '#6B7280',
    marginTop: 12,
    marginBottom: 4,
  } as TextStyle,
  priorityRow: {
    flexDirection: 'row',
    gap: 6,
  } as ViewStyle,
  priorityPill: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#F9FAFB',
  } as ViewStyle,
  priorityPillActive: {
    backgroundColor: `${tokens.primary}12`,
    borderColor: tokens.primary,
  } as ViewStyle,
  priorityPillText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: '#374151',
  } as TextStyle,
  priorityPillTextActive: {
    color: tokens.primary,
  } as TextStyle,
  hint: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#9CA3AF',
    marginTop: 4,
    lineHeight: 16,
  } as TextStyle,
  errorText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    color: '#B91C1C',
    marginTop: 4,
    lineHeight: 18,
  } as TextStyle,
  footer: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
    justifyContent: 'flex-end',
    marginTop: 4,
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
    minWidth: 130,
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

// ─── EditJourneyNodeModal ─────────────────────────────────────────────────────

interface EditJourneyNodeModalProps {
  visible: boolean;
  memberId: string;
  journeyId: string;
  /** The templateStepId of the node being edited (used as the stepId in the PATCH). */
  stepId: string;
  /** Current step name (empty string for blank nodes). */
  initialName: string;
  /** Current step description. */
  initialDescription: string;
  /** Current step status — drives the tri-state segmented control. */
  stepStatus: string;
  /**
   * True when this is the only step in the journey. When true the Remove button
   * is disabled with a caption — the backend would reject the deletion anyway,
   * but we prevent the round-trip and surface a friendlier explanation.
   */
  isOnlyStep: boolean;
  onClose: () => void;
}

/**
 * Modal for editing a journey node's name, description, and status.
 * Works for both built-in and custom journeys — the backend forks a built-in
 * journey into a private per-member copy on the first structural edit.
 * Calls `useUpdateJourneyNode({ journeyId, stepId: node.templateStepId, name, description })`.
 *
 * Platform: web fixed-overlay + Esc; native RN Modal.
 */
function EditJourneyNodeModal({
  visible,
  memberId,
  journeyId,
  stepId,
  initialName,
  initialDescription,
  stepStatus,
  isOnlyStep,
  onClose,
}: EditJourneyNodeModalProps): React.JSX.Element {
  const updateNode = useUpdateJourneyNode(memberId);
  const updateStepStatus = useUpdateJourneyStepStatus(memberId);
  const deleteNode = useDeleteJourneyNode(memberId);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Local optimistic status state — initialized to a safe default; hydrated by the
  // useEffect below whenever the modal opens. Do not compute from props here: if the
  // modal is ever switched to a visibility-prop pattern (no unmount), the useState
  // initializer would be stale while the effect correctly re-hydrates.
  const [selectedStatus, setSelectedStatus] = useState<'upcoming' | 'in_progress' | 'completed'>('upcoming');

  // Hydrate from props whenever the modal opens.
  useEffect(() => {
    if (visible) {
      setName(initialName);
      setDescription(initialDescription);
      setError(null);
      setDeleteError(null);
      setSelectedStatus(
        stepStatus === 'completed' ? 'completed' : stepStatus === 'in_progress' ? 'in_progress' : 'upcoming',
      );
    }
  }, [visible, initialName, initialDescription, stepStatus]);

  // Esc key closes on web.
  useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [visible, onClose]);

  const handleSave = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      await updateNode.mutateAsync({
        journeyId,
        stepId,
        name: name.trim(),
        description: description.trim(),
      });
      onClose();
    } catch (err: unknown) {
      const detail =
        err != null &&
        typeof err === 'object' &&
        'detail' in err &&
        typeof (err as { detail: unknown }).detail === 'string'
          ? (err as { detail: string }).detail
          : 'Could not save. Please try again.';
      setError(detail);
    }
  }, [name, description, journeyId, stepId, updateNode, onClose]);

  /**
   * Prompt the CHW with a native Alert before permanently removing the step.
   * On confirmation, calls DELETE /journeys/{journeyId}/nodes/{stepId} and
   * closes the modal on success. Shows an inline error on failure.
   */
  const handleRemove = useCallback((): void => {
    // Defensive guard — the button is disabled when isOnlyStep, but guard here too.
    if (isOnlyStep) return;
    const onConfirmed = (): void => {
      setDeleteError(null);
      deleteNode.mutate(
        { journeyId, stepId },
        {
          onSuccess: () => { onClose(); },
          onError: (err: unknown) => {
            const detail =
              err != null &&
              typeof err === 'object' &&
              'detail' in err &&
              typeof (err as { detail: unknown }).detail === 'string'
                ? (err as { detail: string }).detail
                : 'Could not remove step. Please try again.';
            setDeleteError(detail);
          },
        },
      );
    };

    if (Platform.OS === 'web') {
      if (!window.confirm("Remove this step from the journey? This can't be undone.")) return;
      onConfirmed();
    } else {
      Alert.alert(
        'Remove Step',
        "Remove this step from the journey? This can't be undone.",
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Remove', style: 'destructive', onPress: onConfirmed },
        ],
        { cancelable: true },
      );
    }
  }, [isOnlyStep, journeyId, stepId, deleteNode, onClose]);

  // Segmented status control handler — optimistic update with rollback.
  const handleStatusChange = useCallback(
    (newStatus: 'upcoming' | 'in_progress' | 'completed'): void => {
      const previousStatus = selectedStatus;
      setSelectedStatus(newStatus);
      updateStepStatus.mutate(
        { journeyId, stepId, status: newStatus },
        {
          onError: () => {
            setSelectedStatus(previousStatus);
            setError('Could not update status. Please try again.');
          },
        },
      );
    },
    [selectedStatus, journeyId, stepId, updateStepStatus],
  );

  const isMissed = stepStatus === 'missed';

  const body = (
    <View style={editNodeStyles.container}>
      {/* Header */}
      <View style={editNodeStyles.header}>
        <Text style={editNodeStyles.title}>Edit Step</Text>
        <TouchableOpacity
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <X size={18} color="#6B7280" />
        </TouchableOpacity>
      </View>

      {/* Body */}
      <View style={editNodeStyles.body}>
        {/* Section 1 — Status segmented control */}
        {isMissed ? (
          <View style={editNodeStyles.missedChip}>
            <Text style={editNodeStyles.missedChipText}>Step marked missed</Text>
          </View>
        ) : (
          <View style={editNodeStyles.segmentRow}>
            {(
              [
                { value: 'upcoming', label: 'Not Started' },
                { value: 'in_progress', label: 'In Progress' },
                { value: 'completed', label: 'Completed' },
              ] as const
            ).map(({ value, label }) => {
              const isSelected = selectedStatus === value;
              const segBg = isSelected
                ? value === 'completed'
                  ? '#16A34A'
                  : value === 'in_progress'
                    ? '#D1FAE5'
                    : '#F3F4F6'
                : 'transparent';
              const segTextColor = isSelected
                ? value === 'completed'
                  ? '#FFFFFF'
                  : value === 'in_progress'
                    ? '#16A34A'
                    : '#374151'
                : '#9CA3AF';
              return (
                <TouchableOpacity
                  key={value}
                  style={[editNodeStyles.segment, { backgroundColor: segBg }]}
                  onPress={() => { if (!isSelected && !updateStepStatus.isPending) handleStatusChange(value); }}
                  disabled={updateStepStatus.isPending}
                  accessibilityRole="button"
                  accessibilityLabel={`Set status to ${label}`}
                  accessibilityState={{ selected: isSelected }}
                >
                  <Text style={[editNodeStyles.segmentText, { color: segTextColor }]}>{label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        {/* Section 2 — Name / description fields (available for all journeys) */}
        <>
          <Text style={editNodeStyles.fieldLabel}>Step name</Text>
          <TextInput
            style={editNodeStyles.input}
            value={name}
            onChangeText={setName}
            placeholder="e.g. Schedule Housing Appointment"
            placeholderTextColor="#9CA3AF"
            autoFocus
            maxLength={200}
            returnKeyType="next"
            accessibilityLabel="Step name"
            editable={!updateNode.isPending}
          />

          <Text style={[editNodeStyles.fieldLabel, editNodeStyles.fieldLabelSpaced]}>
            Description (optional)
          </Text>
          <TextInput
            style={[editNodeStyles.input, editNodeStyles.textArea]}
            value={description}
            onChangeText={setDescription}
            placeholder="What the member should do for this step…"
            placeholderTextColor="#9CA3AF"
            multiline
            numberOfLines={3}
            textAlignVertical="top"
            maxLength={1000}
            accessibilityLabel="Step description"
            editable={!updateNode.isPending}
          />
        </>

        {error !== null && (
          <Text style={editNodeStyles.errorText} accessibilityRole="alert">
            {error}
          </Text>
        )}

        {deleteError !== null && (
          <Text style={editNodeStyles.errorText} accessibilityRole="alert">
            {deleteError}
          </Text>
        )}

        {isOnlyStep && (
          <Text style={editNodeStyles.onlyStepCaption}>
            Cannot delete the last remaining step. Add a replacement step before removing this one.
          </Text>
        )}

      </View>

      {/* Footer — Remove (destructive) + Save for all journeys */}
      <View style={editNodeStyles.footer}>
        <TouchableOpacity
          style={[
            editNodeStyles.removeBtn,
            (isOnlyStep || deleteNode.isPending || updateNode.isPending) && editNodeStyles.saveBtnDisabled,
          ]}
          onPress={handleRemove}
          disabled={isOnlyStep || deleteNode.isPending || updateNode.isPending}
          accessibilityRole="button"
          accessibilityLabel={
            isOnlyStep
              ? 'Cannot remove the last remaining step'
              : 'Remove this step from the journey'
          }
        >
          {deleteNode.isPending ? (
            <ActivityIndicator size="small" color={tokens.red700} />
          ) : (
            <Text style={editNodeStyles.removeBtnText}>Remove</Text>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            editNodeStyles.saveBtn,
            (updateNode.isPending || deleteNode.isPending) && editNodeStyles.saveBtnDisabled,
          ]}
          onPress={() => { void handleSave(); }}
          disabled={updateNode.isPending || deleteNode.isPending}
          accessibilityRole="button"
          accessibilityLabel="Save step"
        >
          {updateNode.isPending ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Text style={editNodeStyles.saveBtnText}>Save</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );

  if (Platform.OS !== 'web') {
    return (
      <Modal
        visible={visible}
        animationType="slide"
        presentationStyle="formSheet"
        onRequestClose={onClose}
        accessibilityViewIsModal
      >
        <View style={editNodeStyles.nativeContainer}>{body}</View>
      </Modal>
    );
  }

  if (!visible) return <></>;

  // Build the overlay tree once; then portal it to document.body so it escapes
  // any CSS-transform ancestor (animated containers make `position: fixed`
  // ancestor-relative, which causes the modal to scroll out of view).
  const webOverlay = (
    <View style={editNodeStyles.webOverlay}>
      <Pressable
        style={editNodeStyles.webBackdrop}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close modal"
      />
      <View style={editNodeStyles.webPanel}>{body}</View>
    </View>
  );

  // _webCreatePortal is non-null on web (assigned at module level).
  // Casting as JSX.Element is safe — ReactPortal satisfies ReactElement.
  if (_webCreatePortal !== null && typeof document !== 'undefined') {
    return _webCreatePortal(webOverlay, document.body) as unknown as React.JSX.Element;
  }
  // Fallback: render inline (should not normally be reached on web).
  return webOverlay;
}

const editNodeStyles = StyleSheet.create({
  webOverlay: {
    position: 'fixed' as 'absolute',
    inset: 0,
    zIndex: 210,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  webBackdrop: {
    position: 'absolute' as 'absolute',
    inset: 0,
    // Transparent — no dim. Kept as a full-screen press target for click-outside dismiss.
    backgroundColor: 'transparent',
  } as ViewStyle,
  webPanel: {
    width: '100%',
    maxWidth: 440,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    overflow: 'hidden',
    zIndex: 1,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    // Pronounced shadow so the card reads as floating without a backdrop dim.
    boxShadow: '0 12px 40px rgba(17,24,39,0.18), 0 2px 8px rgba(17,24,39,0.10)',
  } as ViewStyle,
  nativeContainer: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  } as ViewStyle,
  container: {
    flexDirection: 'column',
    backgroundColor: '#FFFFFF',
  } as ViewStyle,
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  } as ViewStyle,
  title: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 17,
    color: '#111827',
  } as TextStyle,
  body: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 8,
    gap: 4,
  } as ViewStyle,
  fieldLabel: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 11,
    color: '#6B7280',
    textTransform: 'uppercase' as const,
    letterSpacing: 0.7,
    marginBottom: 4,
  } as TextStyle,
  fieldLabelSpaced: {
    marginTop: 12,
  } as TextStyle,
  input: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: 'PlusJakartaSans_400Regular',
    color: '#111827',
    backgroundColor: '#FAFAFA',
  } as TextStyle,
  textArea: {
    minHeight: 72,
  } as TextStyle,
  errorText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    color: '#B91C1C',
    marginTop: 8,
    lineHeight: 18,
  } as TextStyle,
  /** Muted helper shown when the step is the last one and cannot be removed. */
  onlyStepCaption: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: '#9CA3AF',
    marginTop: 8,
    lineHeight: 18,
  } as TextStyle,
  footer: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
    justifyContent: 'flex-end',
    marginTop: 4,
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
  /** Destructive "Remove" button — mirrors flagModal's removeBtn pattern. */
  removeBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: tokens.red100,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: '#FECACA',
    minWidth: 80,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  removeBtnText: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 13,
    color: tokens.red700,
  } as TextStyle,
  saveBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: tokens.primary,
    borderRadius: radius.md,
    minWidth: 80,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  saveBtnDisabled: {
    opacity: 0.6,
  } as ViewStyle,
  saveBtnText: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 13,
    color: '#FFFFFF',
  } as TextStyle,
  // Tri-state status segmented control
  segmentRow: {
    flexDirection: 'row',
    borderRadius: 8,
    backgroundColor: '#F9FAFB',
    padding: 2,
    marginBottom: 16,
    gap: 2,
  } as ViewStyle,
  segment: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: 6,
    minHeight: 44,
  } as ViewStyle,
  segmentText: {
    fontFamily: 'DMSans_500Medium',
    fontSize: 12,
  } as TextStyle,
  // Standard journey name note
  standardNote: {
    fontFamily: 'DMSans_400Regular',
    fontSize: 12,
    color: tokens.textSecondary,
    marginBottom: 12,
    fontStyle: 'italic',
  } as TextStyle,
  // Missed step chip
  missedChip: {
    backgroundColor: '#FEE2E2',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 16,
    alignSelf: 'flex-start',
  } as ViewStyle,
  missedChipText: {
    fontFamily: 'DMSans_500Medium',
    fontSize: 12,
    color: '#B91C1C',
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

/** Stable sort order for CHW-assigned resource need levels. */
const LEVEL_SORT_ORDER: Record<ResourceNeedLevel, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/**
 * The member's active journeys paired with their DISPLAY level, sorted
 * high→medium→low. This is THE single source of truth shared by the Resource
 * Needs card and the Member Journey section, so the two are always in sync — a
 * member need IS an active journey.
 *
 * Level: a fixed-need journey (template name maps to a resource-need slug) uses
 * the CHW-assigned resource-need level when set; everything else (orphan
 * canonical journeys, custom journeys) falls back to a progress-derived severity.
 */
function activeJourneysWithLevel(
  journeys: MemberJourneyResponse[] | undefined,
  resourceNeedLevels: Record<string, ResourceNeedLevel>,
): { journey: MemberJourneyResponse; level: JourneySeverity }[] {
  return (journeys ?? [])
    .filter((j) => j.status === 'active')
    .map((journey, i) => {
      const slug = RESOURCE_NEED_OPTIONS.find((o) => o.label === journey.template.name)?.slug;
      let level: JourneySeverity;
      if (slug !== undefined && slug in resourceNeedLevels) {
        // Fixed need with a CHW-assigned level.
        level = resourceNeedLevels[slug];
      } else if (journey.priorityLevel) {
        // Custom need with a CHW-assigned priority.
        level = journey.priorityLevel;
      } else {
        // Orphan canonical journey (or anything unlabelled): derive from progress.
        level = deriveSeverity(journey.progressPercent);
      }
      return { journey, level, i };
    })
    .sort((a, b) => {
      const diff = LEVEL_SORT_ORDER[a.level] - LEVEL_SORT_ORDER[b.level];
      return diff !== 0 ? diff : a.i - b.i;
    })
    .map(({ journey, level }) => ({ journey, level }));
}

// ─── ResourceNeedsColumn ─────────────────────────────────────────────────────

interface ResourceNeedsColumnProps {
  memberId: string;
  profile: CHWMemberProfileDetail;
  sessionCount: number;
  servicesConsentRefused: boolean;
  /** Opens the Edit Resource Needs modal — supplied by the parent screen. */
  onEditResourceNeeds: () => void;
  /** Narrow/split-screen web: render full-width (stacked). */
  stacked?: boolean;
}

/**
 * Right column of the 3-column top card.
 *
 * Shows:
 *   - "Resource Needs (Level)" card — the member's selected resource needs
 *     sorted high→medium→low by CHW-assigned level, each showing a level Pill.
 *   - Rewards balance badge.
 *   - Call / Message CTAs (dimmed when services refused).
 *   - Session count chip.
 */
function ResourceNeedsColumn({
  memberId,
  profile,
  sessionCount,
  servicesConsentRefused,
  onEditResourceNeeds,
  stacked = false,
}: ResourceNeedsColumnProps): React.JSX.Element {
  const { data: rewardsBalance } = useMemberRewardsBalance(memberId);

  /** Flat slug→level lookup built once from the array — used for O(1) reads below. */
  const slugLevelLookup = useMemo(
    () =>
      Object.fromEntries(
        profile.resourceNeedLevels.map((x) => [x.slug, x.level]),
      ) as Record<string, ResourceNeedLevel>,
    [profile.resourceNeedLevels],
  );

  /**
   * Resource needs sorted high→medium→low (stable: preserves selection order
   * within the same level).
   */
  // The Resource Needs card renders the member's ACTIVE JOURNEYS — the exact
  // same set and order as the Member Journey section (shared helper) — so the
  // two sections are always in sync. A member need IS an active journey.
  const { data: journeys } = useMemberJourneys(memberId);
  const needRows = useMemo(
    () => activeJourneysWithLevel(journeys, slugLevelLookup),
    [journeys, slugLevelLookup],
  );

  /** One need row: journey name + its level pill. */
  const renderNeedRow = ({
    journey,
    level,
  }: {
    journey: MemberJourneyResponse;
    level: JourneySeverity;
  }): React.JSX.Element => {
    const pillVariant: 'red' | 'amber' | 'emerald' =
      level === 'high' ? 'red' : level === 'medium' ? 'amber' : 'emerald';
    const pillLabel = level === 'high' ? 'High' : level === 'medium' ? 'Medium' : 'Low';
    return (
      <View key={journey.id} style={resourceColStyles.priorityItem}>
        <Text style={resourceColStyles.journeyName} numberOfLines={2}>
          {journey.template.name}
        </Text>
        <Pill variant={pillVariant} size="sm">{pillLabel}</Pill>
      </View>
    );
  };

  const hasAnyNeeds = needRows.length > 0;

  return (
    <View style={[resourceColStyles.container, stacked && resourceColStyles.containerStacked]}>
      {/* Resource Needs heading */}
      <View style={resourceColStyles.headRow}>
        <View>
          <Text style={resourceColStyles.headTitle}>Resource Needs</Text>
          <Text style={resourceColStyles.headSub}>(Level)</Text>
        </View>
        {/* Edit pencil — opens EditResourceNeedsModal */}
        <TouchableOpacity
          style={resourceColStyles.editBtn}
          onPress={onEditResourceNeeds}
          accessibilityRole="button"
          accessibilityLabel="Edit resource needs levels"
        >
          <Edit2 size={12} color={tokens.textMuted} />
        </TouchableOpacity>
      </View>

      {/* Needs list */}
      {!hasAnyNeeds ? (
        <Text style={resourceColStyles.emptyText}>No resource needs selected.</Text>
      ) : Platform.OS === 'web' ? (
        <View style={resourceColStyles.needsScrollWeb}>
          <View style={resourceColStyles.priorityList}>
            <StaggerList delayMs={50} durationMs={240}>
              {needRows.map(renderNeedRow)}
            </StaggerList>
          </View>
        </View>
      ) : (
        <ScrollView
          style={resourceColStyles.needsScrollNative}
          nestedScrollEnabled
          showsVerticalScrollIndicator={false}
        >
          <View style={resourceColStyles.priorityList}>
            <StaggerList delayMs={50} durationMs={240}>
              {needRows.map(renderNeedRow)}
            </StaggerList>
          </View>
        </ScrollView>
      )}

      {/* Wellness points stat — read-only, promoted from the old pill.
          Gated by POINTS_ENABLED (points hidden platform-wide for now). */}
      {POINTS_ENABLED && rewardsBalance !== undefined && (
        <View
          style={resourceColStyles.rewardsBadge}
          accessibilityRole="text"
          accessibilityLabel={`${rewardsBalance.currentBalance.toLocaleString()} wellness points`}
        >
          <Star size={16} color="#D97706" />
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
  // Stacked (narrow/split web): full-width, hug content, divider on top.
  containerStacked: {
    flexGrow: 0,
    flexShrink: 1,
    flexBasis: 'auto',
    borderTopWidth: 1,
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
  needsScrollWeb: {
    maxHeight: Platform.OS === 'web' ? (260 as unknown as number) : undefined,
    overflowY: Platform.OS === 'web' ? ('auto' as unknown as 'scroll') : undefined,
  } as ViewStyle,
  needsScrollNative: {
    maxHeight: 260,
  } as ViewStyle,
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
    justifyContent: 'center',
    gap: 6,
    marginTop: 8,
    paddingVertical: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: '#FDE68A',
    backgroundColor: '#FFFBEB',
  } as ViewStyle,
  rewardsText: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 13,
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
function buildRoadmapSteps(journey: MemberJourneyResponse | undefined): RoadmapStep[] {
  const standardStepKeys = [
    'Need Identified',
    'Eligibility Screening',
    'Upload Documents',
    'Follow Up',
    'Resource Connection',
    'Journey Complete',
  ];

  // Placeholder for the loading / no-journey state only.
  const placeholder = (): RoadmapStep[] =>
    standardStepKeys.map((key) => ({
      key,
      label: key,
      description: JOURNEY_STEP_DESCRIPTIONS[key] ?? '',
      state: 'upcoming' as const,
      points: JOURNEY_STEP_POINTS[key] ?? 0,
    }));

  if (!journey || journey.steps.length === 0) return placeholder();

  // Render the journey's OWN steps (in order) — NOT a hardcoded canonical list.
  // Custom journeys can have any number of steps with any names/descriptions;
  // matching against canonical names silently dropped edits and showed the wrong
  // steps for custom journeys. Fall back to the canonical description only when a
  // step has no description of its own and its name matches a standard step.
  return [...journey.steps]
    .sort((a, b) => a.stepOrder - b.stepOrder)
    .map((step) => {
      const name = step.stepName?.trim() ?? '';
      const description =
        step.stepDescription?.trim() || (name ? JOURNEY_STEP_DESCRIPTIONS[name] ?? '' : '');
      return {
        key: step.id,
        label: name || 'Untitled step',
        description,
        state: (step.status ?? 'upcoming') as RoadmapStepState,
        points: step.pointsOnCompletion ?? 0,
      };
    });
}

type RoadmapStepState = 'completed' | 'in_progress' | 'missed' | 'upcoming';

interface RoadmapStep {
  key: string;
  label: string;
  description: string;
  state: RoadmapStepState;
  points: number;
}

// Timeline responsive breakpoints
const TIMELINE_WIDE_BP = 1024;
const TIMELINE_MID_BP = 768;

// Stack the dense 3-column member header below this WINDOW width. Set generously
// (not 1024) because the ~256px sidebar eats into the content area, so 3 columns
// only have room to breathe on genuinely wide windows — below this they cramp
// (labels wrap one word per line, values clip). Below → clean full-width stack.
const STACK_COLUMNS_BP = 1280;

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

  // Match the member "Journey Steps" node format: a 52px ring with a
  // clock / check / outline-circle icon, a status pill, and a colour-coded label.
  const circleColor = isCompleted
    ? tokens.primary
    : isInProgress
    ? tokens.amber700
    : isMissed
    ? tokens.red700
    : tokens.textMuted;
  const lineBg = isCompleted ? '#34D399' : '#E5E7EB';

  const statusLabel = step.state.replace('_', ' ');
  const pillVariant: 'emerald' | 'amber' | 'red' | 'gray' = isCompleted
    ? 'emerald'
    : isInProgress
    ? 'amber'
    : isMissed
    ? 'red'
    : 'gray';

  return (
    <View
      style={[
        timelineStyles.stepWrapper,
        isInProgress && timelineStyles.stepWrapperActive,
      ]}
      accessibilityLabel={`${step.label}: ${statusLabel}`}
      accessibilityRole="text"
    >
      {/* Circle + connector */}
      <View style={timelineStyles.circleRow}>
        <View
          style={[
            timelineStyles.stepCircle,
            {
              borderColor: circleColor,
              backgroundColor: isCompleted ? circleColor : 'transparent',
            },
          ]}
        >
          {isCompleted ? (
            <CheckCircle2 size={20} color="#FFFFFF" />
          ) : isInProgress ? (
            <Clock size={20} color={circleColor} />
          ) : isMissed ? (
            <X size={18} color={circleColor} strokeWidth={2.5} />
          ) : (
            <Circle size={20} color={circleColor} />
          )}
        </View>
        {!isLast && (
          <View style={[timelineStyles.connector, { backgroundColor: lineBg }]} />
        )}
      </View>

      {/* Step name */}
      <Text
        style={[timelineStyles.stepLabelActive, { color: circleColor }]}
        numberOfLines={2}
      >
        {step.label}
      </Text>
      {/* Description */}
      {step.description.trim().length > 0 && (
        <Text style={timelineStyles.stepDescription} numberOfLines={3}>
          {step.description}
        </Text>
      )}
      {/* Status pill */}
      <Pill variant={pillVariant} size="sm">
        {statusLabel}
      </Pill>
      {/* Points — hidden platform-wide for now (POINTS_ENABLED) */}
      {POINTS_ENABLED && (
        <Text style={[timelineStyles.pointsActive, numerals.tabular]}>
          +{step.points} pts
        </Text>
      )}
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

  const dotBg = isCompleted ? '#16A34A' : isInProgress ? '#EAB308' : isMissed ? '#F59E0B' : '#E5E7EB';
  const subLabelText = isCompleted
    ? 'Completed'
    : isInProgress
    ? 'In Progress'
    : isMissed
    ? 'Missed'
    : 'Upcoming';
  const subLabelColor = isCompleted
    ? '#16A34A'
    : isInProgress
    ? '#CA8A04'
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
        {step.description.trim().length > 0 && (
          <Text style={verticalStepStyles.stepDescription} numberOfLines={2}>
            {step.description}
          </Text>
        )}
        <View style={verticalStepStyles.metaRow}>
          <Text style={[verticalStepStyles.statusText, { color: subLabelColor }]}>
            {subLabelText}
          </Text>
          {POINTS_ENABLED && (
            <Text style={[verticalStepStyles.pointsText, numerals.tabular]}>+{step.points} pts</Text>
          )}
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
    borderColor: '#FACC15',
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
  stepDescription: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: tokens.textMuted,
    lineHeight: 15,
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
  /** The CHW-assigned level computed by the shared `activeJourneysWithLevel`
   *  helper — identical to what the Resource Needs section shows, so the two
   *  sections stay in sync (canonical → resourceNeedLevels, custom → priorityLevel). */
  level: JourneySeverity;
  /** Retained for keyed list rendering; no longer shown as a numeric badge. */
  rank: number;
  windowWidth: number;
  memberId: string;
  /** When true, CHW edit affordances (add node, edit/complete each node) are visible. */
  editMode: boolean;
}

/**
 * A single journey track row: level pill + name + progress % in the header,
 * then the step timeline below.
 *
 * The severity pill reflects the CHW-assigned level from `resourceNeedLevels`
 * when the journey's template name matches a known resource need option.
 * Falls back to progress-derived severity (deriveSeverity) for journeys that
 * don't correspond to a named resource need category (e.g. custom journeys).
 *
 * When editMode is true and the journey is custom (template.slug starts with
 * "custom-"), each node shows an edit pencil and a "Complete" action on the
 * current incomplete node. An "Add node" button appears at the bottom of the
 * track. Non-custom journeys are read-only in all modes.
 *
 * Responsive:
 *   ≥ 1024px — evenly-spaced flex row (wideRow).
 *   768–1023px — horizontal ScrollView (overflowable swipe).
 *   < 768px  — vertical VerticalStepRow list.
 */
const SingleJourneyTrack = React.memo(function SingleJourneyTrack({
  journey,
  level,
  rank: _rank,
  windowWidth,
  memberId,
  editMode,
}: SingleJourneyTrackProps): React.JSX.Element {
  const steps = useMemo(() => buildRoadmapSteps(journey), [journey]);

  // `level` is computed once by the shared activeJourneysWithLevel helper (the
  // same value the Resource Needs section shows) and passed in — so the level
  // pill here always matches the Resource Needs pill for the same journey.

  const isNarrow = windowWidth < TIMELINE_MID_BP;
  const isMid = windowWidth >= TIMELINE_MID_BP && windowWidth < TIMELINE_WIDE_BP;

  const pillVariant: 'red' | 'amber' | 'emerald' =
    level === 'high' ? 'red' : level === 'medium' ? 'amber' : 'emerald';
  const pillLabel = level === 'high' ? 'High' : level === 'medium' ? 'Medium' : 'Low';

  /** Whether this journey was built with the custom-journey creator. */
  const isCustom = journey.template.slug.startsWith('custom-');

  // ── Edit-mode sub-state ──────────────────────────────────────────────────────
  const [editingStep, setEditingStep] = useState<MemberJourneyStepResponse | null>(null);
  const [pressedStepId, setPressedStepId] = useState<string | null>(null);
  const addNode = useAddJourneyNode(memberId);
  const completeStep = useUpdateJourneyStep();
  const removeJourney = useRemoveJourney(memberId);

  /** Remove this journey entirely (and its resource need if canonical). */
  const handleRemoveJourney = useCallback((): void => {
    const proceed = (): void => {
      removeJourney.mutate(journey.id, {
        onError: () => {
          const msg = 'Could not remove the journey. Please try again.';
          if (Platform.OS === 'web' && typeof window !== 'undefined') window.alert(msg);
          else Alert.alert('Error', msg);
        },
      });
    };
    const confirmMsg = `Remove the "${journey.template.name}" journey? It will be removed from this member's resource needs and journeys.`;
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      if (window.confirm(confirmMsg)) proceed();
    } else {
      Alert.alert('Remove journey', confirmMsg, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: proceed },
      ]);
    }
  }, [removeJourney, journey.id, journey.template.name]);

  const handleAddNode = useCallback((): void => {
    addNode.mutate(
      { journeyId: journey.id },
      {
        onError: () => {
          const msg = 'Could not add node. Please try again.';
          if (Platform.OS === 'web' && typeof window !== 'undefined') window.alert(msg);
          else Alert.alert('Error', msg);
        },
      },
    );
  }, [addNode, journey.id]);

  const handleCompleteStep = useCallback((step: MemberJourneyStepResponse): void => {
    completeStep.mutate(
      { journeyId: journey.id, stepId: step.templateStepId, status: 'completed' },
      {
        onError: () => {
          const msg = 'Could not mark step complete. Please try again.';
          if (Platform.OS === 'web' && typeof window !== 'undefined') window.alert(msg);
          else Alert.alert('Error', msg);
        },
      },
    );
  }, [completeStep, journey.id]);

  const handleAddNodePositional = useCallback(
    (position: 'before' | 'after', relativeStep: MemberJourneyStepResponse): void => {
      addNode.mutate(
        {
          journeyId: journey.id,
          insertOptions: { position, relativeToStepId: relativeStep.templateStepId },
        },
        {
          onError: () => {
            const msg = 'Could not add node. Please try again.';
            if (Platform.OS === 'web' && typeof window !== 'undefined') window.alert(msg);
            else Alert.alert('Error', msg);
          },
        },
      );
    },
    [addNode, journey.id],
  );

  return (
    <View style={trackStyles.container}>
      {/* Header row */}
      <View style={trackStyles.header}>
        <Text style={trackStyles.journeyName} numberOfLines={1}>
          {journey.template.name}
        </Text>
        <Pill variant={pillVariant} size="sm">{pillLabel}</Pill>
        <Text style={[trackStyles.progressLabel, numerals.tabular]}>
          {Math.round(journey.progressPercent)}%
        </Text>
        {editMode && isCustom && (
          // "Custom" badge is a display hint — shown only once the journey has
          // been forked into a per-member copy (slug starts with "custom-").
          <View style={trackStyles.editModeBadge}>
            <Text style={trackStyles.editModeBadgeText}>Custom</Text>
          </View>
        )}
        {editMode && (
          // Remove this journey entirely (and its resource need if canonical).
          <TouchableOpacity
            style={trackStyles.removeJourneyBtn}
            onPress={handleRemoveJourney}
            disabled={removeJourney.isPending}
            accessibilityRole="button"
            accessibilityLabel={`Remove ${journey.template.name} journey`}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <X size={16} color="#DC2626" />
          </TouchableOpacity>
        )}
      </View>

      {/* Step layout by viewport */}
      {editMode ? (
        // Edit mode: always render the vertical list so each node is tappable (custom and standard)
        <View style={trackStyles.editNodeList}>
          {journey.steps.map((step, index) => {
            const isCompleted = step.status === 'completed';
            const isInProgress = step.status === 'in_progress';
            const hasName = step.stepName.trim().length > 0;
            const isPressed = pressedStepId === step.id;

            const dotBg = isCompleted ? '#16A34A' : isInProgress ? '#16A34A' : '#E5E7EB';
            const dotBorderColor = isInProgress ? '#34D399' : 'transparent';

            return (
              <React.Fragment key={step.id}>
                <Pressable
                  style={[
                    trackStyles.editNodeRow,
                    isPressed && {
                      transform: [{ scale: 0.97 }],
                      borderWidth: 2,
                      borderColor: tokens.primary,
                      borderRadius: 8,
                    },
                  ]}
                  onPress={() => setEditingStep(step)}
                  onPressIn={() => setPressedStepId(step.id)}
                  onPressOut={() => setPressedStepId(null)}
                  accessibilityRole="button"
                  accessibilityLabel={`Edit step: ${step.stepName || 'Untitled step'}`}
                >
                  {/* Step dot */}
                  <View
                    style={[
                      trackStyles.editNodeDot,
                      { backgroundColor: dotBg, borderColor: dotBorderColor, borderWidth: isInProgress ? 2 : 0 },
                    ]}
                  >
                    {isCompleted ? (
                      <Check size={9} color="#FFFFFF" strokeWidth={3} />
                    ) : null}
                  </View>

                  {/* Step text block */}
                  <View style={trackStyles.editNodeTextBlock}>
                    <Text
                      style={[
                        trackStyles.editNodeName,
                        !hasName && trackStyles.editNodeNamePlaceholder,
                      ]}
                      numberOfLines={1}
                    >
                      {hasName ? step.stepName : 'Untitled step — tap to edit'}
                    </Text>
                    {step.stepDescription.trim().length > 0 && (
                      <Text style={trackStyles.editNodeDesc} numberOfLines={2}>
                        {step.stepDescription}
                      </Text>
                    )}
                    {POINTS_ENABLED && (
                      <Text style={trackStyles.editNodePts}>+{step.pointsOnCompletion} pts</Text>
                    )}
                  </View>
                </Pressable>
                {index < journey.steps.length - 1 && (
                  <StepInserter
                    onInsert={() => handleAddNodePositional('after', step)}
                    disabled={addNode.isPending}
                  />
                )}
              </React.Fragment>
            );
          })}

          {/* Add step at bottom — available for all journeys */}
          <TouchableOpacity
            style={trackStyles.addNodeBtn}
            onPress={handleAddNode}
            disabled={addNode.isPending}
            accessibilityRole="button"
            accessibilityLabel="Add a new step to this journey"
          >
            {addNode.isPending ? (
              <ActivityIndicator size="small" color={tokens.primary} />
            ) : (
              <>
                <Plus size={13} color={tokens.primary} />
                <Text style={trackStyles.addNodeBtnText}>Add step</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      ) : isNarrow ? (
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

      {/* EditJourneyNodeModal — scoped per track, zIndex above journey list */}
      {editingStep !== null && (
        <EditJourneyNodeModal
          visible={editingStep !== null}
          memberId={memberId}
          journeyId={journey.id}
          stepId={editingStep.templateStepId}
          initialName={editingStep.stepName}
          initialDescription={editingStep.stepDescription}
          stepStatus={editingStep.status}
          isOnlyStep={journey.steps.length <= 1}
          onClose={() => setEditingStep(null)}
        />
      )}
    </View>
  );
});

// ─── StepInserter ────────────────────────────────────────────────────────────

/**
 * Renders a hoverable "+" affordance centered ON the grey horizontal divider
 * that sits between consecutive step rows in the edit-mode step list.
 *
 * Placement: the zone height is 18 px with a negative marginBottom of -9 so the
 * circular button straddles the 1 px `borderBottomColor: '#F9FAFB'` line that
 * separates adjacent `editNodeRow` entries.
 *
 * Resting state (web): fully transparent — blends into the `#F9FAFB` divider.
 * Hover state (web): reveals a white circular button with `tokens.primary`
 * border and a Plus icon. On native (no hover), always renders at low opacity
 * so the affordance remains tappable.
 */
function StepInserter({
  onInsert,
  disabled,
}: {
  onInsert: () => void;
  disabled?: boolean;
}): React.JSX.Element {
  const [hover, setHover] = useState(false);

  // On web: reveal on hover. On native: always show at low opacity.
  const isWeb = Platform.OS === 'web';
  const showContent = isWeb ? hover : true;

  return (
    <Pressable
      onPress={disabled ? undefined : onInsert}
      onHoverIn={() => { if (isWeb) setHover(true); }}
      onHoverOut={() => { if (isWeb) setHover(false); }}
      accessibilityRole="button"
      accessibilityLabel="Insert a step here"
      style={trackStyles.inserterZone}
    >
      {/* Divider line is always visible — it is the separator between rows. */}
      <View style={trackStyles.inserterLine} />
      {/* Only the "+" button disappears at rest and reveals on hover. */}
      <View
        style={[
          trackStyles.inserterBtnWrap,
          { opacity: showContent ? 1 : 0 },
        ]}
      >
        <View
          style={[
            trackStyles.inserterBtn,
            hover && isWeb && trackStyles.inserterBtnHover,
          ]}
        >
          <Plus size={12} color={tokens.primary} />
        </View>
      </View>
    </Pressable>
  );
}

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

  // Remove-journey (X) button in header, shown in edit mode.
  removeJourneyBtn: {
    marginLeft: 8,
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,

  // Edit-mode badge in header
  editModeBadge: {
    backgroundColor: `${tokens.primary}14`,
    borderRadius: 100,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: `${tokens.primary}30`,
    flexShrink: 0,
  } as ViewStyle,
  editModeBadgeText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 10,
    color: tokens.primary,
  } as TextStyle,

  // Edit-mode node list
  editNodeList: {
    gap: 2,
  } as ViewStyle,
  editNodeRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: 8,
    minHeight: 44,  // WCAG 44×44 minimum touch target
    // No borderBottom: the StepInserter between rows owns the divider line so
    // its hover band coincides exactly with the visible divider.
  } as ViewStyle,
  editNodeDot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    marginTop: 1,
  } as ViewStyle,
  editNodeTextBlock: {
    flex: 1,
    gap: 2,
  } as ViewStyle,
  editNodeName: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: tokens.textPrimary,
    lineHeight: 18,
  } as TextStyle,
  editNodeNamePlaceholder: {
    fontFamily: 'PlusJakartaSans_400Regular',
    color: '#9CA3AF',
    fontStyle: 'italic',
  } as TextStyle,
  editNodeDesc: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#6B7280',
    lineHeight: 16,
  } as TextStyle,
  editNodePts: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 10,
    color: '#047857',
    marginTop: 1,
  } as TextStyle,
  completeNodeBtn: {
    backgroundColor: `${tokens.primary}14`,
    borderWidth: 1,
    borderColor: `${tokens.primary}30`,
  } as ViewStyle,

  // Add node button
  addNodeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: `${tokens.primary}40`,
    backgroundColor: `${tokens.primary}0A`,
  } as ViewStyle,
  addNodeBtnText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    color: tokens.primary,
  } as TextStyle,
  // Step inserter — the "+" affordance centered on the grey inter-step
  // divider line (#F9FAFB = editNodeRow borderBottomColor). Resting state:
  // invisible on web; faint on native. Negative marginBottom pulls the zone
  // up so the circular button straddles the 1 px borderBottomColor line above.
  // A clean, non-overlapping hover band that sits in normal flow between two
  // step rows. It OWNS the divider line (rows no longer draw their own), so the
  // band the user hovers coincides exactly with the visible divider — the prior
  // -9 marginBottom overlapped the rows, so the cursor landed on a row Pressable
  // and onHoverIn never fired.
  inserterZone: {
    width: '100%',
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  } as ViewStyle,
  inserterLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: '50%',
    height: 1,
    // The visible divider between step rows (rows no longer have a borderBottom).
    backgroundColor: '#F3F4F6',
  } as ViewStyle,
  inserterBtnWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  inserterBtn: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#F9FAFB',
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  inserterBtnHover: {
    borderColor: tokens.primary,
  } as ViewStyle,
});

const timelineStyles = StyleSheet.create({
  stepWrapper: {
    flex: 1,
    alignItems: 'center',
    minWidth: 76,
    flexShrink: 0,
    position: 'relative',
    paddingHorizontal: 2,
    gap: 4,
  } as ViewStyle,
  // Light-green highlight on the in-progress node (mirrors the member view).
  stepWrapperActive: {
    backgroundColor: `${tokens.primary}12`,
    borderRadius: 12,
    paddingVertical: 8,
  } as ViewStyle,
  // 52px status ring (mirrors the member Journey Steps node).
  stepCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
    zIndex: 1,
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
    borderColor: '#FACC15',
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
  stepDescription: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 10,
    color: tokens.textMuted,
    textAlign: 'center',
    maxWidth: 96,
    lineHeight: 13,
    marginTop: 3,
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
  /** When true, edit affordances are shown on each journey track. */
  editMode: boolean;
  /** CHW-assigned priority levels keyed by resource need slug. */
  resourceNeedLevels: Record<string, ResourceNeedLevel>;
}

/**
 * Multi-track Member Journey section body.
 * Shows up to 3 active journeys sorted by CHW-assigned level (high→medium→low).
 * Journeys whose template name matches a known resource need are ranked by the
 * CHW-assigned level; unmatched journeys fall back to progress-derived severity.
 * When editMode is true, custom journeys expose add-node / edit-node / complete-node affordances.
 */
function MemberJourneyTimeline({
  memberId,
  onAddJourney,
  windowWidth,
  editMode,
  resourceNeedLevels,
}: MemberJourneyTimelineProps): React.JSX.Element {
  const { data: journeys, isLoading } = useMemberJourneys(memberId);

  /**
   * All active journeys sorted by CHW-assigned level (high→medium→low, stable).
   * The matching uses journey.template.name → RESOURCE_NEED_OPTIONS label → slug.
   * Journeys with no matching resource need fall back to deriveSeverity.
   */
  // Keep the {journey, level} pairs from the shared helper — the SAME level the
  // Resource Needs section shows — and pass each level down so the two sections
  // can never diverge (custom journeys included, which use journey.priorityLevel).
  const activeJourneysSorted = useMemo(
    () => activeJourneysWithLevel(journeys, resourceNeedLevels),
    [journeys, resourceNeedLevels],
  );

  if (isLoading) {
    return (
      <View style={mjStyles.loadingRow}>
        <ActivityIndicator size="small" color={tokens.textMuted} />
        <Text style={mjStyles.loadingText}>Loading journeys…</Text>
      </View>
    );
  }

  // "Create a custom journey" entry — always rendered at the BOTTOM of the list
  // (and below the empty state) so a CHW can author a free-text journey for
  // needs that aren't covered by the canonical resource needs.
  const addJourneyRow = (
    <TouchableOpacity
      style={mjStyles.addJourneyRow}
      onPress={onAddJourney}
      accessibilityRole="button"
      accessibilityLabel="Create a custom journey for this member"
    >
      <Plus size={15} color={tokens.primary} />
      <Text style={mjStyles.addJourneyRowText}>Create a custom journey</Text>
    </TouchableOpacity>
  );

  if (activeJourneysSorted.length === 0) {
    return (
      <View style={mjStyles.emptyWrap}>
        <EmptySectionState message="No active journeys yet." />
        {addJourneyRow}
      </View>
    );
  }

  const journeyList = activeJourneysSorted.map(({ journey, level }, index) => (
    <SingleJourneyTrack
      key={journey.id}
      journey={journey}
      level={level}
      rank={index + 1}
      windowWidth={windowWidth}
      memberId={memberId}
      editMode={editMode}
    />
  ));

  return Platform.OS === 'web' ? (
    <View
      style={mjStyles.scrollContainer}
      accessibilityRole="list"
    >
      {journeyList}
      {addJourneyRow}
    </View>
  ) : (
    <ScrollView
      style={mjStyles.scrollContainerNative}
      nestedScrollEnabled
      showsVerticalScrollIndicator={false}
    >
      {journeyList}
      {addJourneyRow}
    </ScrollView>
  );
}

const mjStyles = StyleSheet.create({
  container: { gap: 0 } as ViewStyle,
  emptyWrap: { gap: 12 } as ViewStyle,
  addJourneyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 10,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: tokens.cardBorder,
    backgroundColor: tokens.cardBg,
  } as ViewStyle,
  addJourneyRowText: {
    fontSize: 13,
    fontWeight: '600',
    color: tokens.primary,
  } as TextStyle,
  scrollContainer: {
    maxHeight: Platform.OS === 'web' ? (560 as unknown as number) : undefined,
    overflowY: Platform.OS === 'web' ? ('auto' as unknown as 'scroll') : undefined,
  } as ViewStyle,
  scrollContainerNative: {
    maxHeight: 560,
  } as ViewStyle,
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

// ─── SessionNotesModal ────────────────────────────────────────────────────────

/** One row in a session's notes timeline: the original summary or an added note. */
interface SessionNoteEntry {
  key: string;
  kind: 'summary' | 'addendum';
  body: string;
  /** ISO timestamp used for ordering + display. */
  timestamp: string;
  pinned?: boolean;
}

interface SessionNotesModalProps {
  /** The session whose notes to display. Null when the modal is closed. */
  session: RecentSessionItem | null;
  memberId: string;
  onClose: () => void;
}

/**
 * Compact centered modal that displays case notes linked to a specific session.
 *
 * Data source: `useCaseNotes(memberId)` — fetches the member's case-note list
 * (already imported and used elsewhere on this screen) and filters client-side
 * by `note.sessionId === session.id`. Case notes carry a nullable `sessionId`
 * field set at creation time when the note is linked to a session.
 *
 * Follows the same web-overlay / native-Modal pattern used by
 * EditDemographicsModal and EditResourceNeedsModal.
 *
 * HIPAA: notes are already gated by the CHW↔member relationship enforced by the
 * backend. They are rendered but never logged.
 */
function SessionNotesModal({
  session,
  memberId,
  onClose,
}: SessionNotesModalProps): React.JSX.Element {
  const visible = session !== null;
  const [draft, setDraft] = useState('');
  const createNote = useCreateCaseNote();

  // Original session note = the CHW's documentation summary for this session.
  // Additional notes = case notes linked to this session (session_id set), each
  // independently timestamped. Both are fetched for the member and filtered to
  // this session client-side.
  const { data: noteList, isLoading: notesLoading, isError: notesError } = useCaseNotes(
    memberId,
    { enabled: visible, limit: 200 },
  );
  const { data: sessionSummaries, isLoading: summariesLoading } = useSessionNotes(memberId, {
    enabled: visible,
  });

  const isLoading = notesLoading || summariesLoading;
  const isError = notesError;

  // Unified, chronological (oldest-first) list: the documentation summary first,
  // then each added note by its own timestamp — so additions are distinguishable
  // from the original session note.
  const entries = useMemo((): SessionNoteEntry[] => {
    if (!session) return [];
    const list: SessionNoteEntry[] = [];
    const summary = sessionSummaries?.find((s) => s.sessionId === session.id);
    if (summary) {
      list.push({
        key: `summary-${session.id}`,
        kind: 'summary',
        body: summary.summary,
        timestamp: summary.submittedAt,
      });
    }
    for (const n of noteList?.items ?? []) {
      if (n.sessionId === session.id) {
        list.push({
          key: n.id,
          kind: 'addendum',
          body: n.body,
          timestamp: n.createdAt,
          pinned: n.isPinned,
        });
      }
    }
    return list.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }, [session, sessionSummaries, noteList]);

  // Reset the composer whenever the modal opens for a different session.
  useEffect(() => {
    setDraft('');
  }, [session?.id]);

  const handleAddNote = useCallback(async (): Promise<void> => {
    const trimmed = draft.trim();
    if (!trimmed || !session) return;
    await createNote.mutateAsync({ memberId, body: trimmed, sessionId: session.id });
    setDraft('');
  }, [draft, session, memberId, createNote]);

  // Esc key closes on web.
  useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [visible, onClose]);

  const sessionDateLabel = session
    ? formatDateTime(session.scheduledAt ?? session.startedAt)
    : '';

  const body = (
    <View style={sessionNotesModalStyles.container}>
      {/* Header */}
      <View style={sessionNotesModalStyles.header}>
        <View style={sessionNotesModalStyles.headerTextBlock}>
          <Text style={sessionNotesModalStyles.title}>Session Notes</Text>
          {sessionDateLabel ? (
            <Text style={sessionNotesModalStyles.subtitle}>{sessionDateLabel}</Text>
          ) : null}
        </View>
        <TouchableOpacity
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close session notes"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <X size={18} color="#6B7280" />
        </TouchableOpacity>
      </View>

      {/* Body */}
      <ScrollView
        style={sessionNotesModalStyles.scroll}
        contentContainerStyle={sessionNotesModalStyles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Composer — adds a timestamped note to THIS session */}
        <View style={sessionNotesModalStyles.composer}>
          <TextInput
            style={sessionNotesModalStyles.composerInput}
            value={draft}
            onChangeText={setDraft}
            placeholder="Add a note to this session…"
            placeholderTextColor="#9CA3AF"
            multiline
            editable={!createNote.isPending}
            accessibilityLabel="Add a note to this session"
          />
          <TouchableOpacity
            style={[
              sessionNotesModalStyles.addBtn,
              (!draft.trim() || createNote.isPending) && sessionNotesModalStyles.addBtnDisabled,
            ]}
            onPress={() => { void handleAddNote(); }}
            disabled={!draft.trim() || createNote.isPending}
            accessibilityRole="button"
            accessibilityLabel="Add note to session"
          >
            {createNote.isPending ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Text style={sessionNotesModalStyles.addBtnText}>Add note</Text>
            )}
          </TouchableOpacity>
        </View>

        {isLoading ? (
          <View style={sessionNotesModalStyles.centerRow}>
            <ActivityIndicator size="small" color={tokens.primary} />
            <Text style={sessionNotesModalStyles.loadingText}>Loading notes…</Text>
          </View>
        ) : isError ? (
          <Text style={sessionNotesModalStyles.errorText}>
            Could not load notes. Please close and try again.
          </Text>
        ) : entries.length === 0 ? (
          <Text style={sessionNotesModalStyles.emptyText}>
            No notes recorded for this session yet.
          </Text>
        ) : (
          entries.map((entry) => (
            <View key={entry.key} style={sessionNotesModalStyles.noteCard}>
              <View style={sessionNotesModalStyles.noteTagRow}>
                <View
                  style={[
                    sessionNotesModalStyles.noteTag,
                    entry.kind === 'summary'
                      ? sessionNotesModalStyles.noteTagSummary
                      : sessionNotesModalStyles.noteTagAddendum,
                  ]}
                >
                  <Text
                    style={[
                      sessionNotesModalStyles.noteTagText,
                      entry.kind === 'summary'
                        ? sessionNotesModalStyles.noteTagTextSummary
                        : sessionNotesModalStyles.noteTagTextAddendum,
                    ]}
                  >
                    {entry.kind === 'summary' ? 'Session summary' : 'Added note'}
                  </Text>
                </View>
              </View>
              <Text style={sessionNotesModalStyles.noteBody}>{entry.body}</Text>
              <Text style={sessionNotesModalStyles.noteMeta}>
                {formatDateTime(entry.timestamp)}
                {entry.pinned ? ' · Pinned' : ''}
              </Text>
            </View>
          ))
        )}
      </ScrollView>

      {/* Footer */}
      <View style={sessionNotesModalStyles.footer}>
        <TouchableOpacity
          style={sessionNotesModalStyles.closeBtn}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
        >
          <Text style={sessionNotesModalStyles.closeBtnText}>Done</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  if (Platform.OS !== 'web') {
    return (
      <Modal
        visible={visible}
        animationType="slide"
        presentationStyle="formSheet"
        onRequestClose={onClose}
        accessibilityViewIsModal
      >
        <View style={sessionNotesModalStyles.nativeContainer}>{body}</View>
      </Modal>
    );
  }

  if (!visible) return <></>;

  return (
    <View style={sessionNotesModalStyles.webOverlay}>
      <Pressable
        style={sessionNotesModalStyles.webBackdrop}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close modal"
      />
      <View style={sessionNotesModalStyles.webPanel}>{body}</View>
    </View>
  );
}

const sessionNotesModalStyles = StyleSheet.create({
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
    backgroundColor: 'rgba(17,24,39,0.45)',
  } as ViewStyle,
  webPanel: {
    width: '100%',
    maxWidth: 520,
    maxHeight: '80vh' as unknown as number,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    overflow: 'hidden',
    zIndex: 1,
  } as ViewStyle,

  // Native container
  nativeContainer: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  } as ViewStyle,

  // Modal body wrapper
  container: {
    flex: 1,
    flexDirection: 'column',
    backgroundColor: '#FFFFFF',
  } as ViewStyle,

  // Header
  header: {
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
  headerTextBlock: {
    flex: 1,
    gap: 2,
  } as ViewStyle,
  title: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 17,
    color: '#111827',
    lineHeight: 24,
  } as TextStyle,
  subtitle: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: '#6B7280',
  } as TextStyle,

  // Scroll
  scroll: {
    flex: 1,
  } as ViewStyle,
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 20,
    gap: 12,
  } as ViewStyle,

  // Loading / empty / error
  centerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 24,
    justifyContent: 'center',
  } as ViewStyle,
  loadingText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: '#6B7280',
  } as TextStyle,
  emptyText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: '#A0A6AB',
    fontStyle: 'italic',
    textAlign: 'center',
    paddingVertical: 24,
  } as TextStyle,
  errorText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: '#B91C1C',
    paddingVertical: 24,
    textAlign: 'center',
  } as TextStyle,

  // Note card
  noteCard: {
    backgroundColor: '#F9FAFB',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    padding: 14,
    gap: 6,
  } as ViewStyle,
  noteBody: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#111827',
    lineHeight: 21,
  } as TextStyle,
  noteMeta: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#9CA3AF',
  } as TextStyle,
  noteTagRow: {
    flexDirection: 'row',
  } as ViewStyle,
  noteTag: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
  } as ViewStyle,
  noteTagSummary: {
    backgroundColor: `${tokens.primary}14`,
  } as ViewStyle,
  noteTagAddendum: {
    backgroundColor: '#F59E0B22',
  } as ViewStyle,
  noteTagText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 10,
  } as TextStyle,
  noteTagTextSummary: {
    color: tokens.primary,
  } as TextStyle,
  noteTagTextAddendum: {
    color: '#B45309',
  } as TextStyle,
  // Composer
  composer: {
    gap: 8,
    marginBottom: 4,
  } as ViewStyle,
  composerInput: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 64,
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#111827',
    textAlignVertical: 'top',
  } as TextStyle,
  addBtn: {
    alignSelf: 'flex-end',
    backgroundColor: tokens.primary,
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 8,
    minWidth: 96,
    alignItems: 'center',
  } as ViewStyle,
  addBtnDisabled: {
    opacity: 0.45,
  } as ViewStyle,
  addBtnText: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 13,
    color: '#FFFFFF',
  } as TextStyle,

  // Footer
  footer: {
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
    alignItems: 'flex-end',
  } as ViewStyle,
  closeBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: tokens.primary,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 80,
  } as ViewStyle,
  closeBtnText: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
    color: '#FFFFFF',
  } as TextStyle,
});

// ─── SessionsTable ────────────────────────────────────────────────────────────

interface SessionsTableProps {
  sessions: RecentSessionItem[];
  totalCount: number;
  memberId: string;
}

/**
 * Paginated sessions table.
 * Columns: Date & Time / Type / Status / Duration / Units / Actions (View notes).
 * 10 rows per page with previous/next pagination controls.
 *
 * "View notes" opens an in-page SessionNotesModal that fetches case notes for
 * the selected session via useCaseNotes filtered by sessionId.
 */
function SessionsTable({
  sessions,
  totalCount,
  memberId,
}: SessionsTableProps): React.JSX.Element {
  const [currentPage, setCurrentPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(sessions.length / SESSIONS_PAGE_SIZE));

  // Notes modal state: null = closed, set to a session = open for that session.
  const [notesSession, setNotesSession] = useState<RecentSessionItem | null>(null);

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

  const handleCloseNotes = useCallback((): void => {
    setNotesSession(null);
  }, []);

  if (sessions.length === 0) {
    return <EmptySectionState message="No sessions with this member yet." />;
  }

  return (
    <View>
      {/* Table header */}
      <View style={tableStyles.header}>
        <Text style={[tableStyles.headerCell, tableStyles.colDate]}>Date & Time</Text>
        <Text style={[tableStyles.headerCell, tableStyles.colType]}>Type</Text>
        <Text style={[tableStyles.headerCell, tableStyles.colStatus]}>Status</Text>
        <Text style={[tableStyles.headerCell, tableStyles.colDuration]}>Duration</Text>
        <Text style={[tableStyles.headerCell, tableStyles.colUnits]}>Units</Text>
        <Text style={[tableStyles.headerCell, tableStyles.colActions]}>Notes</Text>
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
            : session.status === 'awaiting_documentation'
            ? '#2563EB'
            : session.status === 'cancelled'
            ? '#9CA3AF'
            : '#6B7280';

        return (
          <View key={session.id} style={tableStyles.row}>
            <Text style={[tableStyles.cell, tableStyles.colDate, tableStyles.dateText]}>
              {formatDateTime(session.scheduledAt ?? session.startedAt)}
            </Text>
            <Text style={[tableStyles.cell, tableStyles.colType]}>
              {modeLabel}
            </Text>
            <View style={tableStyles.colStatus}>
              <View style={[tableStyles.statusPill, { backgroundColor: statusColor + '18' }]}>
                <Text
                  style={[tableStyles.statusText, { color: statusColor }]}
                  numberOfLines={1}
                >
                  {statusLabel}
                </Text>
              </View>
            </View>
            <Text style={[tableStyles.cell, tableStyles.colDuration]} numberOfLines={1}>
              {formatSessionDuration(session.durationMinutes)}
            </Text>
            <Text style={[tableStyles.cell, tableStyles.colUnits]} numberOfLines={1}>
              {(() => {
                // Prefer the actual billed units once documented; otherwise show
                // the units this session will bill based on its duration.
                const units =
                  session.unitsBilled ??
                  billableUnitsFromDuration(session.durationMinutes);
                return units == null ? '—' : String(units);
              })()}
            </Text>
            <View style={tableStyles.colActions}>
              <TouchableOpacity
                style={tableStyles.viewBtn}
                onPress={() => setNotesSession(session)}
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
          {`Showing ${(currentPage - 1) * SESSIONS_PAGE_SIZE + 1} to ` +
            `${Math.min(currentPage * SESSIONS_PAGE_SIZE, sessions.length)} of ` +
            `${sessions.length} session${sessions.length !== 1 ? 's' : ''}`}
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

      {/* Session notes modal — rendered inside the table so it stays scoped */}
      <SessionNotesModal
        session={notesSession}
        memberId={memberId}
        onClose={handleCloseNotes}
      />
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
  // Column width distribution (Modality removed; freed flex redistributed to Date, Type, Units)
  colDate: { flex: 2.6 } as ViewStyle,
  colType: { flex: 1.5 } as ViewStyle,
  colStatus: { flex: 2.4 } as ViewStyle,
  colDuration: { flex: 1.4 } as ViewStyle,
  colUnits: { flex: 1 } as ViewStyle,
  colActions: { flex: 1.8, alignItems: 'flex-end' } as ViewStyle,
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

// ─── CaseNotesModal ───────────────────────────────────────────────────────────

/**
 * Format an ISO datetime as "May 26, 2026 · 8:30 PM".
 * Used for case-note timestamps.
 */
function formatNoteTimestamp(iso: string): string {
  const d = new Date(iso);
  const datePart = d.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  const timePart = d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${datePart} · ${timePart}`;
}

interface CaseNotesModalProps {
  visible: boolean;
  memberId: string;
  /** The member's sessions — used to label session-linked notes and to power
   *  the "attach to session" selector in the composer. */
  sessions: RecentSessionItem[];
  onClose: () => void;
}

/** One row in the unified Case Notes timeline. */
interface CaseTimelineEntry {
  key: string;
  kind: 'summary' | 'note';
  body: string;
  /** ISO timestamp for ordering + display. */
  timestamp: string;
  /** The session this entry belongs to, if any. */
  sessionId: string | null;
  /** Human date of the linked session, if any (e.g. "Jun 27, 9:21 PM"). */
  sessionLabel?: string;
}

/**
 * Modal showing a unified, timestamp-ordered timeline of the member's notes:
 * every session documentation summary (the original session notes) plus every
 * CHW case note (standalone or attached to a session). The composer can attach
 * a new note to a specific session, so additions are timestamped addenda,
 * distinguishable from the original session summary.
 *
 * Platform:
 *   Web  — fixed overlay + backdrop + Esc key.
 *   Native — RN Modal (form-sheet).
 */
function CaseNotesModal({
  visible,
  memberId,
  sessions,
  onClose,
}: CaseNotesModalProps): React.JSX.Element {
  const { data: notesList, isLoading: notesLoading } = useCaseNotes(memberId, {
    enabled: visible,
  });
  const { data: sessionSummaries, isLoading: summariesLoading } = useSessionNotes(memberId, {
    enabled: visible,
  });
  const createNote = useCreateCaseNote();
  const isLoading = notesLoading || summariesLoading;

  const [draft, setDraft] = useState('');
  // Which session a new note attaches to; null = general (standalone) note.
  const [attachSessionId, setAttachSessionId] = useState<string | null>(null);
  const [showSessionPicker, setShowSessionPicker] = useState(false);

  // Reset composer whenever the modal opens.
  useEffect(() => {
    if (visible) {
      setDraft('');
      setAttachSessionId(null);
      setShowSessionPicker(false);
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

  const handleAddNote = useCallback(async (): Promise<void> => {
    const trimmed = draft.trim();
    if (!trimmed || createNote.isPending) return;
    await createNote.mutateAsync({ memberId, body: trimmed, sessionId: attachSessionId });
    setDraft('');
    setAttachSessionId(null);
  }, [draft, memberId, attachSessionId, createNote]);

  // session_id -> "Mon D, h:MM AM" label for tagging session-linked entries.
  const sessionLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sessions) {
      map.set(s.id, formatDateTime(s.scheduledAt ?? s.startedAt));
    }
    return map;
  }, [sessions]);

  // Merge session summaries + case notes into one newest-first timeline.
  const items = useMemo((): CaseTimelineEntry[] => {
    const list: CaseTimelineEntry[] = [];
    for (const s of sessionSummaries ?? []) {
      list.push({
        key: `summary-${s.sessionId}`,
        kind: 'summary',
        body: s.summary,
        timestamp: s.submittedAt,
        sessionId: s.sessionId,
        sessionLabel:
          sessionLabelById.get(s.sessionId) ??
          (s.occurredAt ? formatDateTime(s.occurredAt) : undefined),
      });
    }
    for (const n of notesList?.items ?? []) {
      list.push({
        key: n.id,
        kind: 'note',
        body: n.body,
        timestamp: n.createdAt,
        sessionId: n.sessionId,
        sessionLabel: n.sessionId ? sessionLabelById.get(n.sessionId) : undefined,
      });
    }
    return list.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }, [sessionSummaries, notesList, sessionLabelById]);

  const attachLabel =
    attachSessionId != null
      ? sessionLabelById.get(attachSessionId) ?? 'Selected session'
      : 'General note (no session)';

  const body = (
    <View style={caseNotesStyles.container}>
      {/* Header */}
      <View style={caseNotesStyles.header}>
        <Text style={caseNotesStyles.title}>Case Notes</Text>
        <TouchableOpacity
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <X size={18} color="#6B7280" />
        </TouchableOpacity>
      </View>

      {/* Composer */}
      <View style={caseNotesStyles.composer}>
        <TextInput
          style={caseNotesStyles.composerInput}
          value={draft}
          onChangeText={setDraft}
          placeholder="Add a note…"
          placeholderTextColor="#9CA3AF"
          multiline
          numberOfLines={3}
          textAlignVertical="top"
          accessibilityLabel="New case note"
          editable={!createNote.isPending}
        />
        {/* Attach-to-session selector */}
        {sessions.length > 0 && (
          <View>
            <TouchableOpacity
              style={caseNotesStyles.attachBtn}
              onPress={() => setShowSessionPicker((p) => !p)}
              accessibilityRole="button"
              accessibilityLabel={`Attach to: ${attachLabel}`}
            >
              <Text style={caseNotesStyles.attachBtnText} numberOfLines={1}>
                Attach to: {attachLabel}
              </Text>
              <Text style={caseNotesStyles.attachChevron}>{showSessionPicker ? '▲' : '▼'}</Text>
            </TouchableOpacity>
            {showSessionPicker && (
              <ScrollView style={caseNotesStyles.attachList} nestedScrollEnabled>
                <TouchableOpacity
                  style={caseNotesStyles.attachItem}
                  onPress={() => { setAttachSessionId(null); setShowSessionPicker(false); }}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: attachSessionId === null }}
                >
                  <Text style={caseNotesStyles.attachItemText}>General note (no session)</Text>
                  {attachSessionId === null && <Check size={14} color={tokens.primary} />}
                </TouchableOpacity>
                {sessions.map((s) => {
                  const label = `${formatDateTime(s.scheduledAt ?? s.startedAt)} · ${s.mode}`;
                  const selected = attachSessionId === s.id;
                  return (
                    <TouchableOpacity
                      key={s.id}
                      style={caseNotesStyles.attachItem}
                      onPress={() => { setAttachSessionId(s.id); setShowSessionPicker(false); }}
                      accessibilityRole="radio"
                      accessibilityState={{ selected }}
                    >
                      <Text style={caseNotesStyles.attachItemText} numberOfLines={1}>{label}</Text>
                      {selected && <Check size={14} color={tokens.primary} />}
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}
          </View>
        )}
        <TouchableOpacity
          style={[
            caseNotesStyles.addBtn,
            (!draft.trim() || createNote.isPending) && caseNotesStyles.addBtnDisabled,
          ]}
          onPress={() => { void handleAddNote(); }}
          disabled={!draft.trim() || createNote.isPending}
          accessibilityRole="button"
          accessibilityLabel="Add note"
        >
          {createNote.isPending ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Text style={caseNotesStyles.addBtnText}>Add note</Text>
          )}
        </TouchableOpacity>
      </View>

      <View style={caseNotesStyles.divider} />

      {/* Unified notes timeline (session summaries + case notes, newest first) */}
      <ScrollView
        style={caseNotesStyles.list}
        contentContainerStyle={caseNotesStyles.listContent}
        showsVerticalScrollIndicator={false}
      >
        {isLoading ? (
          <View style={caseNotesStyles.centerRow}>
            <ActivityIndicator size="small" color={tokens.textMuted} />
            <Text style={caseNotesStyles.mutedText}>Loading…</Text>
          </View>
        ) : items.length === 0 ? (
          <Text style={caseNotesStyles.emptyText}>No notes yet.</Text>
        ) : (
          items.map((entry) => {
            const tag =
              entry.kind === 'summary'
                ? 'Session summary'
                : entry.sessionId
                ? 'Session note'
                : null;
            return (
              <View key={entry.key} style={caseNotesStyles.noteRow}>
                {tag && (
                  <Text style={caseNotesStyles.noteTag}>
                    {tag}
                    {entry.sessionLabel ? ` · ${entry.sessionLabel}` : ''}
                  </Text>
                )}
                <Text style={caseNotesStyles.noteBody}>{entry.body}</Text>
                <Text style={caseNotesStyles.noteTimestamp}>
                  {formatNoteTimestamp(entry.timestamp)}
                </Text>
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );

  if (Platform.OS !== 'web') {
    return (
      <Modal
        visible={visible}
        animationType="slide"
        presentationStyle="formSheet"
        onRequestClose={onClose}
        accessibilityViewIsModal
      >
        <View style={caseNotesStyles.nativeContainer}>{body}</View>
      </Modal>
    );
  }

  if (!visible) return <></>;

  return (
    <View style={caseNotesStyles.webOverlay}>
      <Pressable
        style={caseNotesStyles.webBackdrop}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close modal"
      />
      <View style={caseNotesStyles.webPanel}>{body}</View>
    </View>
  );
}

const caseNotesStyles = StyleSheet.create({
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
    backgroundColor: 'rgba(17,24,39,0.45)',
  } as ViewStyle,
  webPanel: {
    width: '100%',
    maxWidth: 520,
    maxHeight: '85vh' as unknown as number,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    overflow: 'hidden',
    zIndex: 1,
  } as ViewStyle,
  nativeContainer: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  } as ViewStyle,
  container: {
    flex: 1,
    flexDirection: 'column',
    backgroundColor: '#FFFFFF',
  } as ViewStyle,
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  } as ViewStyle,
  title: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 17,
    color: '#111827',
  } as TextStyle,
  composer: {
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 10,
    gap: 8,
  } as ViewStyle,
  composerInput: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: '#111827',
    backgroundColor: '#FAFAFA',
    minHeight: 72,
  } as TextStyle,
  addBtn: {
    alignSelf: 'flex-end',
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 8,
    backgroundColor: tokens.primary,
    minWidth: 90,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  addBtnDisabled: {
    opacity: 0.45,
  } as ViewStyle,
  addBtnText: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 13,
    color: '#FFFFFF',
  } as TextStyle,
  divider: {
    height: 1,
    backgroundColor: '#F3F4F6',
  } as ViewStyle,
  list: {
    flex: 1,
  } as ViewStyle,
  listContent: {
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 20,
    gap: 12,
  } as ViewStyle,
  centerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 20,
    justifyContent: 'center',
  } as ViewStyle,
  mutedText: {
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
    paddingVertical: 24,
  } as TextStyle,
  noteRow: {
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
    gap: 4,
  } as ViewStyle,
  noteTag: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 10,
    color: tokens.primary,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  } as TextStyle,
  noteBody: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: '#111827',
    lineHeight: 20,
  } as TextStyle,
  noteTimestamp: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#9CA3AF',
  } as TextStyle,
  // Attach-to-session selector (composer)
  attachBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
  } as ViewStyle,
  attachBtnText: {
    fontFamily: 'PlusJakartaSans_500Medium',
    fontSize: 13,
    color: '#374151',
    flex: 1,
  } as TextStyle,
  attachChevron: {
    fontSize: 11,
    color: '#9CA3AF',
    marginLeft: 8,
  } as TextStyle,
  attachList: {
    marginTop: 4,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 8,
    maxHeight: 180,
  } as ViewStyle,
  attachItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  } as ViewStyle,
  attachItemText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: '#374151',
    flex: 1,
  } as TextStyle,
});

// ─── UploadedDocumentsModal ───────────────────────────────────────────────────

/**
 * Format a file size in bytes to a human-readable string (e.g. "1.2 MB").
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface UploadedDocumentsModalProps {
  visible: boolean;
  memberId: string;
  onClose: () => void;
}

/**
 * Read-only modal listing the member's uploaded documents.
 * Each row shows filename, documentType label, and human-readable size.
 *
 * Platform: web fixed-overlay + Esc; native RN Modal.
 */
function UploadedDocumentsModal({
  visible,
  memberId,
  onClose,
}: UploadedDocumentsModalProps): React.JSX.Element {
  const { data: docsList, isLoading } = useMemberDocuments(memberId, 1, 50);

  // Esc key closes on web.
  useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [visible, onClose]);

  const items = docsList?.items ?? [];

  const body = (
    <View style={docsModalStyles.container}>
      {/* Header */}
      <View style={docsModalStyles.header}>
        <Text style={docsModalStyles.title}>Uploaded Documents</Text>
        <TouchableOpacity
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <X size={18} color="#6B7280" />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={docsModalStyles.list}
        contentContainerStyle={docsModalStyles.listContent}
        showsVerticalScrollIndicator={false}
      >
        {isLoading ? (
          <View style={docsModalStyles.centerRow}>
            <ActivityIndicator size="small" color={tokens.textMuted} />
            <Text style={docsModalStyles.mutedText}>Loading…</Text>
          </View>
        ) : items.length === 0 ? (
          <Text style={docsModalStyles.emptyText}>No documents uploaded.</Text>
        ) : (
          items.map((doc) => (
            <View key={doc.id} style={docsModalStyles.docRow}>
              <View style={docsModalStyles.docIcon}>
                <FileText size={16} color="#64748B" />
              </View>
              <View style={docsModalStyles.docInfo}>
                <Text style={docsModalStyles.docFilename} numberOfLines={1}>
                  {doc.filename}
                </Text>
                <View style={docsModalStyles.docMeta}>
                  <View style={docsModalStyles.docTypePill}>
                    <Text style={docsModalStyles.docTypeText}>{doc.documentType}</Text>
                  </View>
                  <Text style={docsModalStyles.docSize}>{formatFileSize(doc.sizeBytes)}</Text>
                </View>
              </View>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );

  if (Platform.OS !== 'web') {
    return (
      <Modal
        visible={visible}
        animationType="slide"
        presentationStyle="formSheet"
        onRequestClose={onClose}
        accessibilityViewIsModal
      >
        <View style={docsModalStyles.nativeContainer}>{body}</View>
      </Modal>
    );
  }

  if (!visible) return <></>;

  return (
    <View style={docsModalStyles.webOverlay}>
      <Pressable
        style={docsModalStyles.webBackdrop}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close modal"
      />
      <View style={docsModalStyles.webPanel}>{body}</View>
    </View>
  );
}

const docsModalStyles = StyleSheet.create({
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
    backgroundColor: 'rgba(17,24,39,0.45)',
  } as ViewStyle,
  webPanel: {
    width: '100%',
    maxWidth: 480,
    maxHeight: '80vh' as unknown as number,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    overflow: 'hidden',
    zIndex: 1,
  } as ViewStyle,
  nativeContainer: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  } as ViewStyle,
  container: {
    flex: 1,
    flexDirection: 'column',
    backgroundColor: '#FFFFFF',
  } as ViewStyle,
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  } as ViewStyle,
  title: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 17,
    color: '#111827',
  } as TextStyle,
  list: {
    flex: 1,
  } as ViewStyle,
  listContent: {
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 20,
    gap: 8,
  } as ViewStyle,
  centerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 20,
    justifyContent: 'center',
  } as ViewStyle,
  mutedText: {
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
    paddingVertical: 24,
  } as TextStyle,
  docRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  } as ViewStyle,
  docIcon: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,
  docInfo: {
    flex: 1,
    gap: 4,
  } as ViewStyle,
  docFilename: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: '#111827',
  } as TextStyle,
  docMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  } as ViewStyle,
  docTypePill: {
    backgroundColor: '#F1F5F9',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  } as ViewStyle,
  docTypeText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 10,
    color: '#64748B',
    textTransform: 'uppercase' as const,
    letterSpacing: 0.4,
  } as TextStyle,
  docSize: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#9CA3AF',
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

  // Stack the dense 3-column header vertically when the window is narrow
  // (e.g. split-screen / half-width) so the columns go full-width instead of
  // cramping side by side. Mirrors the native (always-stacked) treatment.
  const stackColumns = Platform.OS === 'web' && windowWidth < STACK_COLUMNS_BP;

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
  const { data: assessmentLatest } = useAssessmentLatest(memberId);

  // Single stable resource-need level map (slug → level), memoized off the
  // profile's levels array. Passed by reference to BOTH the Member Journey
  // section and the Edit Resource Needs modal. Building it inline in JSX created
  // a fresh object every render, which re-fired the Edit modal's hydrate effect
  // and silently wiped the CHW's in-progress edits; a stable reference fixes that.
  const resourceNeedLevelsMap = useMemo(
    () =>
      Object.fromEntries(
        (profile?.resourceNeedLevels ?? []).map((x) => [x.slug, x.level]),
      ) as Record<string, ResourceNeedLevel>,
    [profile?.resourceNeedLevels],
  );

  // ── Drawer / modal state ─────────────────────────────────────────────────────
  const [openQuestionsOpen, setOpenQuestionsOpen] = useState(false);
  const [flagModalOpen, setFlagModalOpen] = useState(false);
  const [editDemographicsOpen, setEditDemographicsOpen] = useState(false);
  const [editResourceNeedsOpen, setEditResourceNeedsOpen] = useState(false);
  const [addJourneyOpen, setAddJourneyOpen] = useState(false);
  /** Controls the new CreateCustomJourneyModal (replaces the "Add Journey" action). */
  const [createCustomJourneyOpen, setCreateCustomJourneyOpen] = useState(false);
  /** When true, the Member Journey section reveals per-node edit affordances. */
  const [journeyEditMode, setJourneyEditMode] = useState(false);
  const [showScreening, setShowScreening] = useState(false);
  const [caseNotesOpen, setCaseNotesOpen] = useState(false);
  const [documentsOpen, setDocumentsOpen] = useState(false);
  // Close/Reopen member — modal rendered at the screen root (not nested in the
  // demographics card) so its overlay isn't clipped by the card's stacking context.
  const [closeMemberOpen, setCloseMemberOpen] = useState(false);
  const closeMember = useCloseMember(memberId);
  const reopenMember = useReopenMember(memberId);
  const handleReopenMember = useCallback(() => {
    reopenMember.mutate(undefined, {
      onError: () => Alert.alert('Could not reopen member', 'Please try again.'),
    });
  }, [reopenMember]);

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

  const handleNavigateToConversation = useCallback(
    (_conversationId: string): void => {
      navigation.navigate('Messages', { memberId });
    },
    [navigation, memberId],
  );

  const handleNavigateAndCall = useCallback((): void => {
    navigation.navigate('Messages', { memberId, autoCall: true });
  }, [navigation, memberId]);

  /**
   * Navigates to the Messages screen and auto-triggers the Begin Session flow
   * for this member. Mirrors the existing autoCall param pattern.
   *
   * `autoBeginSession` is an additive param beyond the current type definition in
   * CHWSessionsStackParamList (owned by a parallel agent). Cast via `as never` to
   * avoid a compile error until the type is extended.
   */
  const handleBeginSession = useCallback((): void => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (navigation.navigate as (...args: any[]) => void)('Messages', {
      memberId,
      autoBeginSession: true,
    });
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
                  // MemberProfile is pushed inside SessionsStack, so goBack()
                  // lands on Messages. "Back to Members" must navigate to the
                  // CHWMembers tab explicitly (navigate bubbles up to the parent
                  // tab navigator that owns it).
                  onPress={() =>
                    (navigation as unknown as { navigate: (name: string) => void }).navigate(
                      'CHWMembers',
                    )
                  }
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
              <View style={[s.topCardRow, stackColumns && s.topCardRowStacked]}>

                {/* LEFT: Demographics + Begin Session/Message */}
                <DemographicsColumn
                  profile={profile}
                  memberId={memberId}
                  displayName={displayName}
                  servicesConsentRefused={servicesConsentRefused}
                  onNavigateToConversation={handleNavigateToConversation}
                  onNavigateAndCall={handleNavigateAndCall}
                  onBeginSession={handleBeginSession}
                  onEditDemographics={() => setEditDemographicsOpen(true)}
                  onOpenCloseMember={() => setCloseMemberOpen(true)}
                  onReopenMember={handleReopenMember}
                  reopenPending={reopenMember.isPending}
                  stacked={stackColumns}
                />

                {/* CENTER: Flag Note + Billing Consent */}
                <CenterColumn
                  memberId={memberId}
                  onEditFlag={() => setFlagModalOpen(true)}
                  stacked={stackColumns}
                />

                {/* RIGHT: Resource Needs (Priority) */}
                <ResourceNeedsColumn
                  memberId={memberId}
                  profile={profile}
                  sessionCount={profile.sessionCount}
                  servicesConsentRefused={servicesConsentRefused}
                  onEditResourceNeeds={() => setEditResourceNeedsOpen(true)}
                  stacked={stackColumns}
                />

              </View>
            </Card>

            {/* Main content + optional sidebar */}
            {/*
              Layout strategy for the Open Questions inline panel:
              ─────────────────────────────────────────────────────
              On viewports >= 1024px (isOpenQuestionsInline = true):
                contentRow is a flex-row. When the drawer is open, it renders
                as a flex sibling of mainCol. The drawer occupies
                OPEN_QUESTIONS_INLINE_WIDTH px on the right, mainCol takes the
                remaining flex:1 space.

              On narrower viewports / native:
                The drawer renders as a fixed overlay outside the ScrollView
                (see below). mainCol is full-width.
            */}
            <View style={[s.contentRow, stackColumns && s.contentRowStacked]}>
              <View style={[s.mainCol, stackColumns && s.mainColStacked]}>

                {/* ─────────────────────────────────────────────────────────
                    MEMBER JOURNEY — multi-track horizontal timeline
                ─────────────────────────────────────────────────────── */}
                <SectionCard
                  title="Member Journey"
                  subtitle="Progress for Resource Needs"
                  titleRight={
                    <View style={s.journeyHeaderRight}>
                      {/* Edit pencil — toggles journeyEditMode to reveal per-node affordances */}
                      <TouchableOpacity
                        style={[
                          s.journeyEditBtn,
                          journeyEditMode && s.journeyEditBtnActive,
                        ]}
                        onPress={() => setJourneyEditMode((prev) => !prev)}
                        accessibilityRole="button"
                        accessibilityLabel={
                          journeyEditMode ? 'Exit journey edit mode' : 'Enter journey edit mode'
                        }
                        accessibilityState={{ selected: journeyEditMode }}
                      >
                        <Edit2
                          size={12}
                          color={journeyEditMode ? tokens.primary : tokens.textMuted}
                        />
                      </TouchableOpacity>
                      {/* Add Journey — opens CreateCustomJourneyModal */}
                      <TouchableOpacity
                        style={s.addJourneyBtn}
                        onPress={() => setCreateCustomJourneyOpen(true)}
                        accessibilityRole="button"
                        accessibilityLabel="Add a new custom journey for this member"
                      >
                        <Plus size={12} color={tokens.primary} />
                        <Text style={s.addJourneyBtnText}>Add Journey</Text>
                      </TouchableOpacity>
                    </View>
                  }
                >
                  {/* Edit-mode banner */}
                  {journeyEditMode && (
                    <View style={s.journeyEditBanner}>
                      <Text style={s.journeyEditBannerText}>
                        Edit mode — tap nodes on custom journeys to edit step text, mark complete, or add steps.
                      </Text>
                      <TouchableOpacity
                        onPress={() => setJourneyEditMode(false)}
                        accessibilityRole="button"
                        accessibilityLabel="Done editing"
                        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                      >
                        <Text style={s.journeyEditBannerDone}>Done</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                  <MemberJourneyTimeline
                    memberId={memberId}
                    onAddJourney={() => setCreateCustomJourneyOpen(true)}
                    windowWidth={windowWidth}
                    editMode={journeyEditMode}
                    resourceNeedLevels={resourceNeedLevelsMap}
                  />
                </SectionCard>

                {/* CreateCustomJourneyModal — "Add Journey" entry point. */}
                <CreateCustomJourneyModal
                  memberId={memberId}
                  memberName={displayName}
                  visible={createCustomJourneyOpen}
                  onClose={() => setCreateCustomJourneyOpen(false)}
                />

                {/* AddJourneyModal (template picker) — kept available for future
                    template-based journey creation; currently not wired to the header. */}
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
                          {profile.sessionCount} completed
                        </Text>
                      </View>
                    ) : undefined
                  }
                >
                  <SessionsTable
                    sessions={profile.recentSessions}
                    totalCount={profile.sessionCount}
                    memberId={memberId}
                  />
                </SectionCard>


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
                <RightRail width={240} style={stackColumns ? s.railStacked : undefined}>
                  <Card style={s.railCard}>
                    <Text style={s.railCardTitle}>Quick Access</Text>
                    <RailAccessItem
                      icon={<NotebookPen size={14} color="#2563EB" />}
                      iconBg="#EFF6FF"
                      label="Case Notes"
                      sublabel="View all notes"
                      onPress={() => setCaseNotesOpen(true)}
                    />
                    <RailAccessItem
                      icon={<CheckSquare size={14} color="#EA580C" />}
                      iconBg="#FFF7ED"
                      label="Screening Results"
                      sublabel={
                        assessmentLatest?.responses?.length
                          ? `${assessmentLatest.responses.length} answers`
                          : 'View answers'
                      }
                      onPress={() => setShowScreening(true)}
                    />
                    <RailAccessItem
                      icon={<UploadCloud size={14} color="#64748B" />}
                      iconBg="#F8FAFC"
                      label="Uploaded Documents"
                      sublabel="Member uploads"
                      onPress={() =>
                        (navigation.navigate as (...args: any[]) => void)(
                          'CHWDocuments',
                          { memberId },
                        )
                      }
                    />
                  </Card>
                </RightRail>
              )}

            </View>

          </View>
        </ScrollView>

        {/* ── Edit Demographics modal ── */}
        <EditDemographicsModal
          visible={editDemographicsOpen}
          profile={profile}
          memberId={memberId}
          onClose={() => setEditDemographicsOpen(false)}
        />

        {/* ── Flag Member drawer/modal ── */}
        <FlagMemberModal
          memberId={memberId}
          visible={flagModalOpen}
          onClose={() => setFlagModalOpen(false)}
        />

        {/* ── Edit Resource Needs modal ── */}
        <EditResourceNeedsModal
          visible={editResourceNeedsOpen}
          currentNeeds={profile.resourceNeeds}
          currentLevels={resourceNeedLevelsMap}
          memberId={memberId}
          onClose={() => setEditResourceNeedsOpen(false)}
        />

        {/* Screening answers modal — the member's latest SDOH/health responses */}
        <Modal
          visible={showScreening}
          transparent
          animationType="fade"
          onRequestClose={() => setShowScreening(false)}
          accessibilityViewIsModal
        >
          <View style={consentModalStyles.overlay}>
            <View style={[consentModalStyles.sheet, { maxWidth: 520 }]}>
              <View style={consentModalStyles.headerRow}>
                <Text style={consentModalStyles.title}>Screening Answers</Text>
                <TouchableOpacity
                  onPress={() => setShowScreening(false)}
                  accessibilityRole="button"
                  accessibilityLabel="Close"
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <X size={18} color="#6B7280" />
                </TouchableOpacity>
              </View>
              {assessmentLatest?.completedAt ? (
                <Text style={consentModalStyles.meta}>
                  Completed {formatDate(assessmentLatest.completedAt)}
                </Text>
              ) : null}
              <View style={consentModalStyles.divider} />
              {assessmentLatest?.responses?.length ? (
                <ScrollView style={{ maxHeight: 360 }}>
                  {assessmentLatest.responses.map((r, i) => (
                    <View key={`${r.questionId}-${i}`} style={screeningStyles.qaRow}>
                      <Text style={screeningStyles.question}>{r.questionText}</Text>
                      <Text style={screeningStyles.answer}>{r.answerLabel}</Text>
                    </View>
                  ))}
                </ScrollView>
              ) : (
                <Text style={consentModalStyles.bodyText}>
                  No screening completed for this member yet. Run the SDOH / Health
                  Screening from the conversation or session to capture answers.
                </Text>
              )}
              <TouchableOpacity
                style={consentModalStyles.closeBtn}
                onPress={() => setShowScreening(false)}
                accessibilityRole="button"
                accessibilityLabel="Done"
              >
                <Text style={consentModalStyles.closeBtnText}>Done</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

        {/* ── Case Notes modal ── */}
        <CaseNotesModal
          visible={caseNotesOpen}
          memberId={memberId}
          sessions={profile.recentSessions}
          onClose={() => setCaseNotesOpen(false)}
        />

        {/* ── Close Member modal (root-level so the overlay isn't clipped) ── */}
        <CloseMemberModal
          visible={closeMemberOpen}
          displayName={displayName}
          isSubmitting={closeMember.isPending}
          onCancel={() => setCloseMemberOpen(false)}
          onConfirm={(status, reason) => {
            closeMember.mutate(
              { status, reason },
              {
                onSuccess: () => setCloseMemberOpen(false),
                onError: () => Alert.alert('Could not close member', 'Please try again.'),
              },
            );
          }}
        />

        {/* ── Uploaded Documents modal ── */}
        <UploadedDocumentsModal
          visible={documentsOpen}
          memberId={memberId}
          onClose={() => setDocumentsOpen(false)}
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

/**
 * Single tappable row inside the Quick Access rail card.
 * Displays an icon badge, label, optional sublabel, and a chevron.
 */
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
    // paddingTop intentionally omitted: AppShell's mainContent already applies
    // 32px of top padding via its ScrollView contentContainerStyle. Adding top
    // padding here doubled the gap above the "John Thomas II / Member Profile"
    // header vs. screens that don't own a nested ScrollView (e.g. CHWMembersScreen).
    paddingHorizontal: 24,
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
  // Narrow / split-screen web: stack the columns vertically.
  topCardRowStacked: {
    flexDirection: 'column',
  } as ViewStyle,

  // Content row (main + right rail)
  contentRow: {
    flexDirection: Platform.OS === 'web' ? 'row' : 'column',
    gap: 24,
    alignItems: 'flex-start',
  } as ViewStyle,
  // Narrow/split web: stack the main content over a full-width rail.
  contentRowStacked: {
    flexDirection: 'column',
    alignItems: 'stretch',
  } as ViewStyle,
  mainCol: { flex: 1 } as ViewStyle,
  mainColStacked: {
    flexGrow: 0,
    flexBasis: 'auto',
    width: '100%',
  } as ViewStyle,
  railStacked: {
    width: '100%',
  } as ViewStyle,

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
  journeyEditBtnActive: {
    backgroundColor: `${tokens.primary}18`,
    borderWidth: 1,
    borderColor: `${tokens.primary}40`,
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

  // Journey edit-mode inline banner
  journeyEditBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: `${tokens.primary}0A`,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: `${tokens.primary}25`,
    marginBottom: 12,
    gap: 8,
  } as ViewStyle,
  journeyEditBannerText: {
    flex: 1,
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: tokens.primary,
    lineHeight: 16,
  } as TextStyle,
  journeyEditBannerDone: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 12,
    color: tokens.primary,
    flexShrink: 0,
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

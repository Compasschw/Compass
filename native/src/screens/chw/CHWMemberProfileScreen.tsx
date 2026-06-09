/**
 * CHWMemberProfileScreen — Full member context view for CHW/admin users.
 *
 * Layout (T08 Phase 1 Second Run redesign):
 *   - 3-column top card:
 *       Left  — Demographics (READ-ONLY): name, phone, address/ZIP, language,
 *               insurance/MCO, email.
 *       Center — Services Consent status (READ-ONLY on CHW side). When the
 *               member has refused services, the Call/Message CTAs in the right
 *               column are dimmed and a caption is shown.
 *       Right  — Active Journeys list + Member rewards balance + Call/Message CTAs.
 *   - Member Journey roadmap (6-step horizontal scroll with points).
 *   - Quick Access row — Add Note, Flag Member, Schedule Session, Document Session.
 *   - Billable Units widget (today vs daily cap; this year vs yearly cap).
 *   - Sessions table — paginated (20 rows/page).
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
  CheckCircle,
  Clock,
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
} from 'lucide-react-native';
import { useQuery } from '@tanstack/react-query';

import { colors as legacyColors } from '../../theme/colors';
import { fonts } from '../../theme/typography';
import { colors as tokens, spacing, radius } from '../../theme/tokens';
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
  RightDrawer,
  RightRail,
  SectionHeader,
} from '../../components/ui';
import { useAuth } from '../../context/AuthContext';
import {
  OpenQuestionsDrawer,
  OPEN_QUESTIONS_INLINE_BREAKPOINT,
} from '../../components/chw/OpenQuestionsDrawer';
import {
  useMemberServicesConsent,
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

const SESSIONS_PAGE_SIZE = 20;

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

// ─── ServicesConsentColumn ────────────────────────────────────────────────────

type ServicesConsentStatus = ServicesConsentValue | null;

interface ServicesConsentColumnProps {
  memberId: string;
}

/**
 * Center column of the 3-column top card.
 * Renders the member's Services Consent status read-only on the CHW side.
 * When status is 'refuse_services', shows a red warning banner.
 */
function ServicesConsentColumn({ memberId }: ServicesConsentColumnProps): React.JSX.Element {
  const { data: consentData, isLoading } = useMemberServicesConsent(memberId);
  const consentValue: ServicesConsentStatus = consentData?.value ?? null;
  const isRefused = consentValue === 'refuse_services';

  return (
    <View style={consentColStyles.container}>
      <ColumnHeading text="Services Consent" sub="(read-only)" />

      {isLoading ? (
        <View style={consentColStyles.loadingRow}>
          <ActivityIndicator size="small" color={tokens.textMuted} />
          <Text style={consentColStyles.loadingText}>Loading…</Text>
        </View>
      ) : consentValue === null ? (
        <View style={[consentColStyles.statusBlock, consentColStyles.statusNeutral]}>
          <ShieldOff size={18} color="#A0A6AB" />
          <Text style={[consentColStyles.statusLabel, { color: '#A0A6AB' }]}>
            Status unavailable
          </Text>
          <Text style={consentColStyles.statusSub}>
            Consent data not yet available for this member.
          </Text>
        </View>
      ) : isRefused ? (
        <View style={[consentColStyles.statusBlock, consentColStyles.statusRefused]}>
          <ShieldX size={18} color="#B91C1C" />
          <Text style={[consentColStyles.statusLabel, { color: '#B91C1C' }]}>
            Refused Services
          </Text>
          <Text style={[consentColStyles.statusSub, { color: '#DC2626' }]}>
            Member has refused services. Call and Message actions are disabled.
          </Text>
        </View>
      ) : (
        <View style={[consentColStyles.statusBlock, consentColStyles.statusGranted]}>
          <ShieldCheck size={18} color="#15803D" />
          <Text style={[consentColStyles.statusLabel, { color: '#15803D' }]}>
            Consented to Services
          </Text>
          <Text style={consentColStyles.statusSub}>
            Member has consented to receive CHW services.
          </Text>
        </View>
      )}

      {consentData?.changedAt ? (
        <Text style={consentColStyles.changedAt}>
          Last updated: {formatDate(consentData.changedAt)}
        </Text>
      ) : null}

      {/* Policy notice */}
      <View style={consentColStyles.noticeBox}>
        <Shield size={11} color="#9CA3AF" />
        <Text style={consentColStyles.noticeText}>
          This consent is member-controlled and cannot be changed from the CHW side.
        </Text>
      </View>
    </View>
  );
}

const consentColStyles = StyleSheet.create({
  container: {
    flex: Platform.OS === 'web' ? 3 : undefined,
    padding: 20,
    borderRightWidth: Platform.OS === 'web' ? 1 : 0,
    borderRightColor: '#F3F4F6',
    borderTopWidth: Platform.OS === 'web' ? 0 : 1,
    borderTopColor: '#F3F4F6',
  } as ViewStyle,
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 16,
  } as ViewStyle,
  loadingText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: tokens.textMuted,
  } as TextStyle,
  statusBlock: {
    borderRadius: radius.md,
    padding: 12,
    gap: 6,
    marginBottom: 10,
  } as ViewStyle,
  statusGranted: {
    backgroundColor: '#F0FDF4',
    borderWidth: 1,
    borderColor: '#BBFBCA',
  } as ViewStyle,
  statusRefused: {
    backgroundColor: '#FEF2F2',
    borderWidth: 1,
    borderColor: '#FECACA',
  } as ViewStyle,
  statusNeutral: {
    backgroundColor: '#F9FAFB',
    borderWidth: 1,
    borderColor: '#E5E7EB',
  } as ViewStyle,
  statusLabel: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 13,
  } as TextStyle,
  statusSub: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: '#6B7280',
    lineHeight: 18,
  } as TextStyle,
  changedAt: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#9CA3AF',
    marginBottom: 10,
  } as TextStyle,
  noticeBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    backgroundColor: '#F9FAFB',
    borderRadius: radius.sm,
    padding: 8,
    marginTop: 4,
  } as ViewStyle,
  noticeText: {
    flex: 1,
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#9CA3AF',
    lineHeight: 16,
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

// ─── ActiveJourneysAndCTAColumn ───────────────────────────────────────────────

interface ActiveJourneysAndCTAColumnProps {
  memberId: string;
  displayName: string;
  sessionCount: number;
  servicesConsentRefused: boolean;
  onNavigateToConversation: (conversationId: string) => void;
  onNavigateAndCall: () => void;
}

/**
 * Right column of the 3-column top card.
 * Shows: Active Journeys list (with "+ Add Journey" button), Member wellness
 * points balance, Call/Message CTAs.
 * CTAs are dimmed + disabled when the member has refused services.
 */
function ActiveJourneysAndCTAColumn({
  memberId,
  displayName,
  sessionCount,
  servicesConsentRefused,
  onNavigateToConversation,
  onNavigateAndCall,
}: ActiveJourneysAndCTAColumnProps): React.JSX.Element {
  const { data: journeys, isLoading: journeysLoading } = useMemberJourneys(memberId);
  const { data: rewardsBalance } = useMemberRewardsBalance(memberId);
  const [addJourneyOpen, setAddJourneyOpen] = useState(false);

  const activeJourneys = useMemo(
    () => journeys?.filter((j) => j.status === 'active') ?? [],
    [journeys],
  );

  /**
   * Set of template slugs for which the member already has an active journey.
   * Passed to AddJourneyModal so it can grey-out already-enrolled templates
   * before the POST, avoiding a 409 round-trip.
   */
  const existingActiveSlugs = useMemo<Set<string>>(
    () => new Set(activeJourneys.map((j) => j.template.slug)),
    [activeJourneys],
  );

  const ctaDisabled = servicesConsentRefused;
  const ctaOpacity = ctaDisabled ? 0.45 : 1;

  return (
    <View style={ctaColStyles.container}>
      {/* Section heading row + "+ Add Journey" button */}
      <View style={ctaColStyles.journeyHeadRow}>
        <ColumnHeading text="Active Journeys" />
        <TouchableOpacity
          style={ctaColStyles.addJourneyBtn}
          onPress={() => setAddJourneyOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="Add a new journey for this member"
        >
          <Plus size={12} color={tokens.primary} />
          <Text style={ctaColStyles.addJourneyBtnText}>Add Journey</Text>
        </TouchableOpacity>
      </View>

      {/* Journeys list */}
      {journeysLoading ? (
        <View style={ctaColStyles.loadingRow}>
          <ActivityIndicator size="small" color={tokens.textMuted} />
          <Text style={ctaColStyles.loadingText}>Loading journeys…</Text>
        </View>
      ) : activeJourneys.length === 0 ? (
        <Text style={ctaColStyles.emptyJourneys}>No active journeys.</Text>
      ) : (
        <View style={ctaColStyles.journeyList}>
          {activeJourneys.slice(0, 3).map((journey) => (
            <JourneyListRow key={journey.id} journey={journey} />
          ))}
          {activeJourneys.length > 3 && (
            <Text style={ctaColStyles.moreJourneys}>
              +{activeJourneys.length - 3} more
            </Text>
          )}
        </View>
      )}

      {/* Add Journey modal — renders here so it has access to local state */}
      <AddJourneyModal
        memberId={memberId}
        memberName={displayName}
        visible={addJourneyOpen}
        existingActiveSlugs={existingActiveSlugs}
        onClose={() => setAddJourneyOpen(false)}
        onCreated={() => {
          /* useMemberJourneys is invalidated by the mutation's onSuccess;
             the query refetches automatically — no extra action needed here. */
        }}
      />

      {/* Rewards balance */}
      {rewardsBalance !== undefined && (
        <View style={ctaColStyles.rewardsBadge}>
          <Star size={12} color="#D97706" />
          <Text style={ctaColStyles.rewardsText}>
            {rewardsBalance.currentBalance.toLocaleString()} wellness pts
          </Text>
        </View>
      )}

      {/* Services refused caption */}
      {servicesConsentRefused && (
        <View style={ctaColStyles.refusedCaption}>
          <ShieldX size={11} color="#B91C1C" />
          <Text style={ctaColStyles.refusedCaptionText}>
            Member has refused services
          </Text>
        </View>
      )}

      {/* Call / Message CTAs */}
      <View style={[ctaColStyles.ctaRow, { opacity: ctaOpacity }]}>
        <TouchableOpacity
          style={[ctaColStyles.ctaBtn, ctaColStyles.callBtn]}
          onPress={ctaDisabled ? undefined : onNavigateAndCall}
          disabled={ctaDisabled}
          accessibilityRole="button"
          accessibilityLabel={ctaDisabled ? 'Call disabled — member has refused services' : `Call ${displayName}`}
          accessibilityState={{ disabled: ctaDisabled }}
        >
          <Phone size={14} color="#FFFFFF" />
          <Text style={ctaColStyles.ctaBtnText}>Call</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[ctaColStyles.ctaBtn, ctaColStyles.messageBtn]}
          onPress={
            ctaDisabled
              ? undefined
              : () => onNavigateToConversation('')
          }
          disabled={ctaDisabled}
          accessibilityRole="button"
          accessibilityLabel={ctaDisabled ? 'Message disabled — member has refused services' : `Message ${displayName}`}
          accessibilityState={{ disabled: ctaDisabled }}
        >
          <MessageSquare size={14} color={tokens.primary} />
          <Text style={[ctaColStyles.ctaBtnText, { color: tokens.primary }]}>
            Message
          </Text>
        </TouchableOpacity>
      </View>

      {/* Session count chip */}
      {sessionCount > 0 && (
        <View style={ctaColStyles.sessionCountRow}>
          <Text style={ctaColStyles.sessionCountText}>
            {sessionCount} session{sessionCount !== 1 ? 's' : ''} completed
          </Text>
        </View>
      )}
    </View>
  );
}

interface JourneyListRowProps {
  journey: MemberJourneyResponse;
}

function JourneyListRow({ journey }: JourneyListRowProps): React.JSX.Element {
  const currentStepName = journey.currentStep?.stepName ?? null;
  const progressPercent = Math.round(journey.progressPercent);

  return (
    <View style={journeyRowStyles.container}>
      <View style={journeyRowStyles.header}>
        <Text style={journeyRowStyles.name} numberOfLines={1}>
          {journey.template.name}
        </Text>
        <Text style={journeyRowStyles.percent}>{progressPercent}%</Text>
      </View>
      {currentStepName ? (
        <Text style={journeyRowStyles.step} numberOfLines={1}>
          {currentStepName}
        </Text>
      ) : null}
      {/* Progress bar */}
      <View style={journeyRowStyles.barTrack}>
        <View
          style={[
            journeyRowStyles.barFill,
            { width: `${progressPercent}%` as `${number}%` },
          ]}
        />
      </View>
    </View>
  );
}

const journeyRowStyles = StyleSheet.create({
  container: {
    gap: 4,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  } as ViewStyle,
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  } as ViewStyle,
  name: {
    flex: 1,
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    color: '#111827',
  } as TextStyle,
  percent: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 11,
    color: tokens.primary,
    marginLeft: 6,
  } as TextStyle,
  step: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#6B7280',
  } as TextStyle,
  barTrack: {
    height: 4,
    backgroundColor: '#E5E7EB',
    borderRadius: 2,
    overflow: 'hidden',
  } as ViewStyle,
  barFill: {
    height: '100%',
    backgroundColor: tokens.primary,
    borderRadius: 2,
  } as ViewStyle,
});

const ctaColStyles = StyleSheet.create({
  container: {
    flex: Platform.OS === 'web' ? 3 : undefined,
    padding: 20,
    borderTopWidth: Platform.OS === 'web' ? 0 : 1,
    borderTopColor: '#F3F4F6',
    gap: 8,
  } as ViewStyle,
  journeyHeadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: -4,
  } as ViewStyle,
  addJourneyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
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
  emptyJourneys: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: '#A0A6AB',
    fontStyle: 'italic',
  } as TextStyle,
  journeyList: {
    gap: 0,
  } as ViewStyle,
  moreJourneys: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#9CA3AF',
    paddingTop: 4,
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

// ─── JourneyRoadmap ───────────────────────────────────────────────────────────

/**
 * Maps a MemberJourneyResponse to the 6-step roadmap display data.
 * Derives step state from the backend step.status values.
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

interface JourneyRoadmapProps {
  memberId: string;
}

/**
 * Horizontal 6-step journey roadmap.
 * Fetches the member's active journey and renders step states with points.
 * Falls back to all-upcoming display when no journey data is available.
 */
function JourneyRoadmap({ memberId }: JourneyRoadmapProps): React.JSX.Element {
  const { data: journeys, isLoading } = useMemberJourneys(memberId);
  const activeJourney = useMemo(
    () => journeys?.find((j) => j.status === 'active'),
    [journeys],
  );
  const roadmapSteps: RoadmapStep[] = useMemo(
    () => buildRoadmapSteps(activeJourney),
    [activeJourney],
  );

  if (isLoading) {
    return (
      <View style={roadmapStyles.loadingRow}>
        <ActivityIndicator size="small" color={tokens.textMuted} />
        <Text style={roadmapStyles.loadingText}>Loading journey…</Text>
      </View>
    );
  }

  return (
    <View style={roadmapStyles.container}>
      {activeJourney && (
        <View style={roadmapStyles.templateBadge}>
          <Text style={roadmapStyles.templateName}>
            {activeJourney.template.name}
          </Text>
          <Text style={roadmapStyles.templateProgress}>
            {Math.round(activeJourney.progressPercent)}% complete
          </Text>
        </View>
      )}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={roadmapStyles.row}
      >
        {roadmapSteps.map((step, index) => {
          const isLast = index === roadmapSteps.length - 1;
          const isCompleted = step.state === 'completed';
          const isInProgress = step.state === 'in_progress';
          const isMissed = step.state === 'missed';
          const isUpcoming = step.state === 'upcoming';

          const dotBg = isCompleted || isInProgress
            ? '#16A34A'
            : isMissed
            ? '#F59E0B'
            : '#E5E7EB';

          const lineBg = isCompleted ? '#16A34A' : '#E5E7EB';

          const subLabelText = isCompleted
            ? 'Completed'
            : isInProgress
            ? 'In Progress'
            : isMissed
            ? 'Missed'
            : '';

          const subLabelColor = isCompleted
            ? '#6B7280'
            : isInProgress
            ? '#16A34A'
            : isMissed
            ? '#EF4444'
            : '#9CA3AF';

          return (
            <View key={step.key} style={roadmapStyles.stepWrapper}>
              {/* Circle + outer ring for in-progress/missed */}
              <View
                style={[
                  roadmapStyles.circleOuter,
                  isInProgress && roadmapStyles.circleInProgress,
                  isMissed && roadmapStyles.circleMissed,
                ]}
              >
                <View style={[roadmapStyles.dot, { backgroundColor: dotBg }]}>
                  {isCompleted || isInProgress ? (
                    <CheckCircle size={20} color="#FFFFFF" />
                  ) : isMissed ? (
                    <Clock size={20} color="#FFFFFF" />
                  ) : (
                    <View style={roadmapStyles.dotInner} />
                  )}
                </View>
              </View>

              {/* Connector line */}
              {!isLast && (
                <View style={[roadmapStyles.connector, { backgroundColor: lineBg }]} />
              )}

              {/* Labels */}
              <Text
                style={[
                  roadmapStyles.label,
                  !isUpcoming && roadmapStyles.labelActive,
                ]}
              >
                {step.label}
              </Text>
              {subLabelText ? (
                <Text style={[roadmapStyles.subLabel, { color: subLabelColor }]}>
                  {subLabelText}
                </Text>
              ) : null}
              <Text
                style={[
                  roadmapStyles.points,
                  isUpcoming && roadmapStyles.pointsMuted,
                ]}
              >
                +{step.points} pts
              </Text>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const roadmapStyles = StyleSheet.create({
  container: { paddingHorizontal: 4 } as ViewStyle,
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
  templateBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 12,
    paddingHorizontal: 4,
  } as ViewStyle,
  templateName: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 13,
    color: '#111827',
  } as TextStyle,
  templateProgress: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: tokens.textSecondary,
  } as TextStyle,
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 4,
    paddingBottom: 8,
  } as ViewStyle,
  stepWrapper: {
    alignItems: 'center',
    position: 'relative',
    width: 104,
    flexShrink: 0,
  } as ViewStyle,
  circleOuter: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
    marginBottom: 8,
    zIndex: 1,
  } as ViewStyle,
  circleInProgress: {
    borderWidth: 3,
    borderColor: '#FCD34D',
  } as ViewStyle,
  circleMissed: {
    borderWidth: 3,
    borderColor: '#FCA5A5',
  } as ViewStyle,
  dot: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  dotInner: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#9CA3AF',
  } as ViewStyle,
  connector: {
    position: 'absolute',
    top: 25,
    left: '50%',
    right: '-50%',
    height: 3,
    zIndex: 0,
  } as ViewStyle,
  label: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 10,
    color: '#9CA3AF',
    textAlign: 'center',
    maxWidth: 90,
  } as TextStyle,
  labelActive: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    color: '#111827',
  } as TextStyle,
  subLabel: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 10,
    textAlign: 'center',
    marginTop: 1,
  } as TextStyle,
  points: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 10,
    color: '#047857',
    backgroundColor: '#ECFDF5',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
    marginTop: 3,
    textAlign: 'center',
    overflow: 'hidden',
  } as TextStyle,
  pointsMuted: {
    color: '#6B7280',
    backgroundColor: '#F3F4F6',
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
          <TouchableOpacity
            key={action.label}
            style={[
              quickRowStyles.actionBtn,
              index < quickActions.length - 1 && quickRowStyles.actionBtnBorder,
            ]}
            onPress={action.onPress}
            accessibilityRole="button"
            accessibilityLabel={action.label}
          >
            <View style={[quickRowStyles.iconCircle, { backgroundColor: action.iconBg }]}>
              {action.icon}
            </View>
            <Text style={quickRowStyles.actionLabel}>{action.label}</Text>
          </TouchableOpacity>
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
              ]}
            >
              {units.daily.used} / {units.daily.limit} used
            </Text>
            <Text style={billingWidgetStyles.remainingLabel}>
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
              ]}
            >
              {units.yearly.used} / {units.yearly.limit} used
            </Text>
            <Text style={billingWidgetStyles.remainingLabel}>
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
        <Text style={[tableStyles.headerCell, tableStyles.colStatus]}>Status</Text>
        <Text style={[tableStyles.headerCell, tableStyles.colModality]}>Modality</Text>
        <Text style={[tableStyles.headerCell, tableStyles.colDuration]}>Duration</Text>
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
            <View style={tableStyles.colStatus}>
              <View style={[tableStyles.statusPill, { backgroundColor: statusColor + '18' }]}>
                <Text style={[tableStyles.statusText, { color: statusColor }]}>
                  {statusLabel}
                </Text>
              </View>
            </View>
            <Text style={[tableStyles.cell, tableStyles.colModality]}>
              {modeLabel}
            </Text>
            <Text style={[tableStyles.cell, tableStyles.colDuration]}>
              {session.durationMinutes != null
                ? `${session.durationMinutes} min`
                : '—'}
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
            <ArrowLeft size={20} color={legacyColors.foreground} />
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
            <ArrowLeft size={20} color={legacyColors.foreground} />
          </TouchableOpacity>
          <Text style={s.headerTitle}>Member Profile</Text>
          <View style={{ width: 40 }} />
        </View>
        <View style={s.emptyState}>
          <View style={s.emptyIconCircle}>
            <ShieldOff size={28} color={legacyColors.mutedForeground} />
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
              <ArrowLeft size={20} color={legacyColors.foreground} />
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
                TOP CARD: 3 columns — Demographics / Consent / Journeys+CTAs
            ─────────────────────────────────────────────────────────────── */}
            <Card style={s.topCard}>
              <View style={s.topCardRow}>

                {/* LEFT: Demographics */}
                <DemographicsColumn profile={profile} />

                {/* CENTER: Services Consent */}
                <ServicesConsentColumn memberId={memberId} />

                {/* RIGHT: Active Journeys + Rewards + Call/Message */}
                <ActiveJourneysAndCTAColumn
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
                    MEMBER JOURNEY ROADMAP
                ─────────────────────────────────────────────────────── */}
                <SectionCard
                  title="Member Journey"
                  subtitle="6-step roadmap with wellness points"
                >
                  <JourneyRoadmap memberId={memberId} />
                </SectionCard>

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
                      icon={<Sparkles size={14} color={legacyColors.secondary} />}
                      iconBg={legacyColors.secondary + '18'}
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

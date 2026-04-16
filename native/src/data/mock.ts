// CompassCHW Mock Data — React Native
// Single source of truth for demo/mock purposes.
// Medi-Cal rate: $26.66 per 15-minute billing unit.

// ─── Types ────────────────────────────────────────────────────────────────────

export type UserRole = 'chw' | 'member';
export type Vertical = 'housing' | 'rehab' | 'food' | 'mental_health' | 'healthcare';
export type SessionStatus = 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
export type RequestStatus = 'open' | 'matched' | 'completed' | 'cancelled';
export type Urgency = 'routine' | 'soon' | 'urgent';
export type SessionMode = 'in_person' | 'virtual' | 'phone';
export type ZCodeCategory = 'counseling' | 'housing_economic' | 'health_access' | 'behavioral' | 'legal';
export type CredentialStatus = 'pending' | 'verified' | 'expired';
export type RewardAction = 'session_completed' | 'follow_through' | 'redeemed';

export interface CHWProfile {
  id: string;
  name: string;
  /** Two-letter initials for avatar placeholder */
  avatar: string;
  specializations: Vertical[];
  languages: string[];
  rating: number;
  yearsExperience: number;
  totalSessions: number;
  isAvailable: boolean;
  bio: string;
  zipCode: string;
}

export interface MemberProfile {
  id: string;
  name: string;
  zipCode: string;
  primaryLanguage: string;
  primaryNeed: Vertical;
  rewardsBalance: number;
}

export interface ServiceRequest {
  id: string;
  memberName: string;
  vertical: Vertical;
  urgency: Urgency;
  description: string;
  preferredMode: SessionMode;
  status: RequestStatus;
  createdAt: string;
  /** Number of 15-minute billing units expected */
  estimatedUnits: number;
}

export interface MemberConsent {
  consentedAt: string;
  typedSignature: string;
  consentType: 'medical_billing';
}

export interface CallRecording {
  sessionId: string;
  startedAt: string;
  endedAt?: string;
  durationSeconds?: number;
  memberConsentGiven: boolean;
}

export interface DiagnosisCode {
  code: string;
  description: string;
  category: ZCodeCategory;
  isArchived?: boolean;
}

export interface ProcedureCode {
  code: string;
  modifier: string;
  description: string;
  groupSize: string;
}

export interface SessionDocumentation {
  sessionId: string;
  summary: string;
  resourcesReferred: string[];
  memberGoals: string[];
  followUpNeeded: boolean;
  followUpDate?: string;
  diagnosisCodes: string[];
  procedureCode?: string;
  unitsToBill: number;
  submittedAt?: string;
}

export interface Credential {
  id: string;
  type: 'chw_certification' | 'hipaa_training' | 'background_check' | 'continuing_education';
  label: string;
  status: CredentialStatus;
  uploadDate?: string;
  expirationDate?: string;
  fileName?: string;
  creditHours?: number;
  requiredHours?: number;
}

export interface CalendarEvent {
  id: string;
  title: string;
  date: string;
  startTime: string;
  endTime: string;
  vertical?: Vertical;
  type: 'session' | 'goal_milestone';
  chwName?: string;
  memberName?: string;
}

export interface RewardHistoryEntry {
  id: string;
  action: RewardAction;
  description: string;
  points: number;
  date: string;
}

export interface RedemptionItem {
  id: string;
  name: string;
  description: string;
  pointsCost: number;
  category: 'transportation' | 'grocery' | 'phone' | 'wellness';
  emoji: string;
}

export interface Session {
  id: string;
  chwName: string;
  memberName: string;
  vertical: Vertical;
  status: SessionStatus;
  mode: SessionMode;
  scheduledAt: string;
  startedAt?: string;
  endedAt?: string;
  durationMinutes?: number;
  unitsBilled?: number;
  notes?: string;
  /** Pre-deduction gross amount in USD */
  grossAmount?: number;
  /** Post-deduction net payout in USD */
  netAmount?: number;
  consent?: MemberConsent;
  diagnosisCodes?: string[];
  documentation?: SessionDocumentation;
  callRecording?: CallRecording;
}

export interface Goal {
  id: string;
  title: string;
  emoji: string;
  category: Vertical;
  /** 0–100 */
  progress: number;
  sessionsCompleted: number;
  nextSession: string;
  status: string;
}

export interface EarningsSummary {
  thisWeek: number;
  thisMonth: number;
  allTime: number;
  pendingPayout: number;
  sessionsThisWeek: number;
  avgRating: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Medi-Cal reimbursement rate per 15-minute billing unit. */
export const MEDI_CAL_RATE = 26.66;

/** Fraction of gross billing the CHW receives after platform fee. */
export const NET_PAYOUT_RATE = 0.85;

// ─── Helper functions ─────────────────────────────────────────────────────────

/**
 * Format a number as a USD currency string (e.g. 90.64 → "$90.64").
 */
export function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/**
 * Calculate net CHW earnings from a gross billing amount.
 */
export function calculateNetEarnings(grossAmount: number): number {
  return parseFloat((grossAmount * NET_PAYOUT_RATE).toFixed(2));
}

// ─── CHW Profiles ─────────────────────────────────────────────────────────────

export const chwProfiles: CHWProfile[] = [
  {
    id: 'chw-001',
    name: 'Maria Guadalupe Reyes',
    avatar: 'MR',
    specializations: ['housing', 'food', 'mental_health'],
    languages: ['English', 'Spanish'],
    rating: 4.9,
    yearsExperience: 6,
    totalSessions: 312,
    isAvailable: true,
    bio: 'Born and raised in Boyle Heights. I specialize in connecting families with stable housing, CalFresh enrollment, and mental health resources. Fluent in Spanish.',
    zipCode: '90033',
  },
  {
    id: 'chw-002',
    name: 'Darnell Washington',
    avatar: 'DW',
    specializations: ['rehab', 'healthcare', 'mental_health'],
    languages: ['English'],
    rating: 4.8,
    yearsExperience: 4,
    totalSessions: 187,
    isAvailable: true,
    bio: 'Former peer support specialist with lived experience in recovery. I help members navigate substance use treatment, Medi-Cal enrollment, and community support groups in South LA.',
    zipCode: '90047',
  },
  {
    id: 'chw-003',
    name: 'Linh Tran Nguyen',
    avatar: 'LN',
    specializations: ['healthcare', 'food', 'housing'],
    languages: ['English', 'Vietnamese'],
    rating: 4.7,
    yearsExperience: 3,
    totalSessions: 98,
    isAvailable: false,
    bio: 'I serve the Vietnamese-American community in the San Gabriel Valley. My focus is preventive care, diabetes management education, and food security navigation.',
    zipCode: '91801',
  },
];

// ─── Member Profiles ───────────────────────────────────────────────────────────

export const memberProfiles: MemberProfile[] = [
  {
    id: 'mem-001',
    name: 'Rosa Delgado',
    zipCode: '90031',
    primaryLanguage: 'Spanish',
    primaryNeed: 'housing',
    rewardsBalance: 120,
  },
  {
    id: 'mem-002',
    name: 'Marcus Johnson',
    zipCode: '90059',
    primaryLanguage: 'English',
    primaryNeed: 'rehab',
    rewardsBalance: 45,
  },
  {
    id: 'mem-003',
    name: 'Fatima Al-Hassan',
    zipCode: '90250',
    primaryLanguage: 'Arabic',
    primaryNeed: 'mental_health',
    rewardsBalance: 75,
  },
];

// ─── Service Requests ──────────────────────────────────────────────────────────

export const serviceRequests: ServiceRequest[] = [
  {
    id: 'req-001',
    memberName: 'Rosa Delgado',
    vertical: 'housing',
    urgency: 'urgent',
    description:
      'Received eviction notice. Need help understanding tenant rights and applying for emergency rental assistance through the LA County ERAP program.',
    preferredMode: 'in_person',
    status: 'open',
    createdAt: '2026-04-01T09:15:00Z',
    estimatedUnits: 4,
  },
  {
    id: 'req-002',
    memberName: 'Marcus Johnson',
    vertical: 'rehab',
    urgency: 'soon',
    description:
      'Seeking referral to an outpatient substance use treatment program covered by Medi-Cal. Has 60-day sobriety milestone and wants to maintain momentum.',
    preferredMode: 'virtual',
    status: 'open',
    createdAt: '2026-04-01T11:30:00Z',
    estimatedUnits: 3,
  },
  {
    id: 'req-003',
    memberName: 'Fatima Al-Hassan',
    vertical: 'mental_health',
    urgency: 'soon',
    description:
      'Looking for a therapist who speaks Arabic or has experience with Middle Eastern cultural backgrounds. Prefer female provider. Medi-Cal covered.',
    preferredMode: 'phone',
    status: 'matched',
    createdAt: '2026-03-30T14:00:00Z',
    estimatedUnits: 2,
  },
  {
    id: 'req-004',
    memberName: 'James Okonkwo',
    vertical: 'food',
    urgency: 'routine',
    description:
      'Family of four needs help enrolling in CalFresh. Recently lost job, income dropped below threshold. Need guidance on documents required.',
    preferredMode: 'in_person',
    status: 'open',
    createdAt: '2026-03-29T10:00:00Z',
    estimatedUnits: 2,
  },
  {
    id: 'req-005',
    memberName: 'Elena Vasquez',
    vertical: 'healthcare',
    urgency: 'routine',
    description:
      'Needs help scheduling overdue preventive screenings (mammogram, diabetes A1C) and understanding Medi-Cal managed care plan benefits.',
    preferredMode: 'phone',
    status: 'completed',
    createdAt: '2026-03-25T08:30:00Z',
    estimatedUnits: 2,
  },
];

// ─── Sessions ──────────────────────────────────────────────────────────────────

// Billing: $26.66/unit (15 min). Platform takes 15%, CHW nets 85%.
// grossAmount = units * 26.66; netAmount = grossAmount * 0.85

export const sessions: Session[] = [
  {
    id: 'sess-001',
    chwName: 'Maria Guadalupe Reyes',
    memberName: 'Rosa Delgado',
    vertical: 'housing',
    status: 'scheduled',
    mode: 'in_person',
    scheduledAt: '2026-04-03T10:00:00Z',
    notes: 'Bring printed ERAP application checklist.',
  },
  {
    id: 'sess-002',
    chwName: 'Darnell Washington',
    memberName: 'Marcus Johnson',
    vertical: 'rehab',
    status: 'completed',
    mode: 'virtual',
    scheduledAt: '2026-03-31T14:00:00Z',
    startedAt: '2026-03-31T14:02:00Z',
    endedAt: '2026-03-31T15:01:00Z',
    durationMinutes: 59,
    unitsBilled: 4,
    grossAmount: 106.64,
    netAmount: 90.64,
    notes: 'Completed Medi-Cal IOP referral. Member selected Pacific Clinics Arcadia. Follow-up in 2 weeks.',
  },
  {
    id: 'sess-003',
    chwName: 'Maria Guadalupe Reyes',
    memberName: 'Fatima Al-Hassan',
    vertical: 'mental_health',
    status: 'completed',
    mode: 'phone',
    scheduledAt: '2026-03-28T11:00:00Z',
    startedAt: '2026-03-28T11:05:00Z',
    endedAt: '2026-03-28T11:35:00Z',
    durationMinutes: 30,
    unitsBilled: 2,
    grossAmount: 53.32,
    netAmount: 45.32,
    notes: 'Identified two bilingual therapists. Member to call Monday for intake.',
  },
  {
    id: 'sess-004',
    chwName: 'Linh Tran Nguyen',
    memberName: 'Elena Vasquez',
    vertical: 'healthcare',
    status: 'completed',
    mode: 'phone',
    scheduledAt: '2026-03-26T09:00:00Z',
    startedAt: '2026-03-26T09:01:00Z',
    endedAt: '2026-03-26T09:47:00Z',
    durationMinutes: 46,
    unitsBilled: 3,
    grossAmount: 79.98,
    netAmount: 67.98,
    notes: 'Scheduled mammogram at St. Francis Medical Center for April 10. Provided diabetes care management education materials.',
  },
];

// ─── Goals (Member-facing) ─────────────────────────────────────────────────────

export const goals: Goal[] = [
  {
    id: 'goal-001',
    title: 'Secure Stable Housing',
    emoji: '🏠',
    category: 'housing',
    progress: 35,
    sessionsCompleted: 1,
    nextSession: '2026-04-03T10:00:00Z',
    status: 'on_track',
  },
  {
    id: 'goal-002',
    title: 'Maintain Recovery Milestones',
    emoji: '💪',
    category: 'rehab',
    progress: 60,
    sessionsCompleted: 3,
    nextSession: '2026-04-07T14:00:00Z',
    status: 'on_track',
  },
  {
    id: 'goal-003',
    title: 'Access Mental Health Support',
    emoji: '🧠',
    category: 'mental_health',
    progress: 80,
    sessionsCompleted: 2,
    nextSession: '2026-04-10T11:00:00Z',
    status: 'almost_done',
  },
];

// ─── Earnings Summary (CHW-facing) ────────────────────────────────────────────

export const earningsSummary: EarningsSummary = {
  thisWeek: 181.28,
  thisMonth: 724.22,
  allTime: 8_304.50,
  pendingPayout: 181.28,
  sessionsThisWeek: 2,
  avgRating: 4.9,
};

// ─── Display label maps ───────────────────────────────────────────────────────

export const verticalLabels: Record<Vertical, string> = {
  housing: 'Housing',
  rehab: 'Rehab & Recovery',
  food: 'Food Security',
  mental_health: 'Mental Health',
  healthcare: 'Healthcare Access',
};

export const urgencyLabels: Record<Urgency, string> = {
  routine: 'Routine',
  soon: 'Soon',
  urgent: 'Urgent',
};

export const sessionStatusLabels: Record<SessionStatus, string> = {
  scheduled: 'Scheduled',
  in_progress: 'In Progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export const requestStatusLabels: Record<RequestStatus, string> = {
  open: 'Open',
  matched: 'Matched',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export const sessionModeLabels: Record<SessionMode, string> = {
  in_person: 'In Person',
  virtual: 'Video Call',
  phone: 'Phone',
};

// ─── ICD-10 / Z-Codes ─────────────────────────────────────────────────────────

export const zCodeCategoryLabels: Record<ZCodeCategory, string> = {
  counseling: 'Counseling & Wellness',
  housing_economic: 'Housing & Economic',
  health_access: 'Health Access & Literacy',
  behavioral: 'Behavioral',
  legal: 'Legal Circumstances',
};

export const diagnosisCodes: DiagnosisCode[] = [
  { code: 'Z71.89', description: 'Other specified counseling, wellness visits', category: 'counseling' },
  { code: 'Z59.12', description: 'Utility Insecurity', category: 'housing_economic' },
  { code: 'Z72.3', description: 'Lack of physical exercise', category: 'behavioral' },
  { code: 'Z75.3', description: 'Unavailability and inaccessibility of health-care facilities', category: 'health_access' },
  { code: 'Z59.00', description: 'Living Situation, unspecified', category: 'housing_economic' },
  { code: 'Z59.89', description: 'Other problems related to housing and economic circumstances', category: 'housing_economic' },
  { code: 'Z55.6', description: 'Problems related to health literacy', category: 'health_access' },
  { code: 'Z59.9', description: 'Problem related to housing and economic circumstances, unspecified', category: 'housing_economic' },
  { code: 'Z59.86', description: 'Financial insecurity', category: 'housing_economic', isArchived: true },
  { code: 'Z65.3', description: 'Problems related to other legal circumstances', category: 'legal' },
];

// ─── CPT Procedure Codes ──────────────────────────────────────────────────────

export const procedureCodes: ProcedureCode[] = [
  { code: '98960', modifier: 'U2', description: 'CHW Service 1 Person', groupSize: '1 person' },
  { code: '98961', modifier: 'U2', description: 'CHW Service 2-4 People', groupSize: '2-4 people' },
  { code: '98962', modifier: 'U2', description: 'CHW Service 5-8 People', groupSize: '5-8 people' },
];

// ─── Credentials ─────────────────────────────────────────────────────────────

export const mockCredentials: Credential[] = [
  { id: 'cred-001', type: 'chw_certification', label: 'CHW Certification', status: 'verified', uploadDate: '2025-08-15', expirationDate: '2027-08-15', fileName: 'chw-cert-maria-reyes.pdf' },
  { id: 'cred-002', type: 'hipaa_training', label: 'HIPAA Training', status: 'verified', uploadDate: '2025-11-01', expirationDate: '2026-11-01', fileName: 'hipaa-training-2025.pdf' },
  { id: 'cred-003', type: 'background_check', label: 'Background Check', status: 'verified', uploadDate: '2025-06-20', fileName: 'bg-check-cleared.pdf' },
  { id: 'cred-004', type: 'continuing_education', label: 'Continuing Education', status: 'pending', uploadDate: '2026-02-10', fileName: 'ce-credits-2026.pdf', creditHours: 12, requiredHours: 20 },
];

// ─── Calendar Events ──────────────────────────────────────────────────────────

export const mockCalendarEvents: CalendarEvent[] = [
  { id: 'cal-001', title: 'Session: Rosa Delgado', date: '2026-04-03', startTime: '10:00', endTime: '11:00', vertical: 'housing', type: 'session', memberName: 'Rosa Delgado', chwName: 'Maria Guadalupe Reyes' },
  { id: 'cal-002', title: 'Session: Marcus Johnson', date: '2026-04-07', startTime: '14:00', endTime: '15:00', vertical: 'rehab', type: 'session', memberName: 'Marcus Johnson', chwName: 'Darnell Washington' },
  { id: 'cal-003', title: 'Session: Fatima Al-Hassan', date: '2026-04-10', startTime: '11:00', endTime: '12:00', vertical: 'mental_health', type: 'session', memberName: 'Fatima Al-Hassan', chwName: 'Maria Guadalupe Reyes' },
  { id: 'cal-004', title: 'Session: James Okonkwo', date: '2026-04-14', startTime: '09:00', endTime: '10:00', vertical: 'food', type: 'session', memberName: 'James Okonkwo', chwName: 'Maria Guadalupe Reyes' },
  { id: 'cal-005', title: 'CE Training Workshop', date: '2026-04-18', startTime: '13:00', endTime: '16:00', type: 'goal_milestone', chwName: 'Maria Guadalupe Reyes' },
  { id: 'cal-006', title: 'Session: Rosa Delgado (Follow-up)', date: '2026-04-21', startTime: '10:00', endTime: '11:00', vertical: 'housing', type: 'session', memberName: 'Rosa Delgado', chwName: 'Maria Guadalupe Reyes' },
  { id: 'cal-007', title: 'Goal: Housing application deadline', date: '2026-04-15', startTime: '09:00', endTime: '09:00', vertical: 'housing', type: 'goal_milestone', memberName: 'Rosa Delgado' },
  { id: 'cal-008', title: 'Goal: Recovery 90-day milestone', date: '2026-04-25', startTime: '09:00', endTime: '09:00', vertical: 'rehab', type: 'goal_milestone', memberName: 'Marcus Johnson' },
];

// ─── Rewards ──────────────────────────────────────────────────────────────────

export const mockRewardHistory: RewardHistoryEntry[] = [
  { id: 'rw-001', action: 'session_completed', description: 'Session with Maria Guadalupe Reyes', points: 50, date: '2026-04-02' },
  { id: 'rw-002', action: 'follow_through', description: 'Scheduled mammogram appointment', points: 25, date: '2026-04-01' },
  { id: 'rw-003', action: 'session_completed', description: 'Session with Darnell Washington', points: 50, date: '2026-03-31' },
  { id: 'rw-004', action: 'redeemed', description: 'Redeemed: Metro TAP card (bus pass)', points: -100, date: '2026-03-28' },
  { id: 'rw-005', action: 'follow_through', description: 'Submitted CalFresh application', points: 25, date: '2026-03-25' },
  { id: 'rw-006', action: 'session_completed', description: 'Session with Linh Tran Nguyen', points: 50, date: '2026-03-20' },
];

export const redemptionCatalog: RedemptionItem[] = [
  { id: 'red-001', name: 'Metro TAP Card', description: 'LA Metro bus & rail pass (7-day)', pointsCost: 200, category: 'transportation', emoji: '🚌' },
  { id: 'red-002', name: 'Grocery Gift Card', description: '$25 card for Ralphs, Food 4 Less, or Northgate', pointsCost: 300, category: 'grocery', emoji: '🛒' },
  { id: 'red-003', name: 'Phone Minutes', description: '500 minutes prepaid talk & text', pointsCost: 150, category: 'phone', emoji: '📱' },
  { id: 'red-004', name: 'Wellness Kit', description: 'Blood pressure monitor + fitness tracker', pointsCost: 250, category: 'wellness', emoji: '🧘' },
];

// ─── Documentation helpers ────────────────────────────────────────────────────

export const predefinedMemberGoals: string[] = [
  'Secure stable housing',
  'Access food assistance programs',
  'Connect with mental health services',
  'Enroll in health insurance',
  'Find substance use treatment',
  'Improve health literacy',
  'Obtain transportation assistance',
  'Resolve legal barriers to care',
  'Complete preventive health screenings',
  'Build a support network',
];

export const predefinedResources: string[] = [
  'LA Regional Food Bank',
  'Union Rescue Mission',
  'LAMP Community',
  "St. John's Well Child Center",
  'Didi Hirsch Mental Health Services',
  'APLA Health',
  'LA LGBT Center',
  'The Midnight Mission',
  'CalFresh / SNAP',
  'Medi-Cal Enrollment',
  'Section 8 / Housing Authority',
  'LA County ERAP',
];

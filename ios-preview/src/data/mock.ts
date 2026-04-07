// CompassCHW Mock Data
// All pages share this single source of truth for demo/mockup purposes.
// Medi-Cal rate: $26.66 per 15-minute unit

// ─── Types ────────────────────────────────────────────────────────────────────

export type UserRole = 'chw' | 'member';
export type Vertical = 'housing' | 'rehab' | 'food' | 'mental_health' | 'healthcare';
export type SessionStatus = 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
export type RequestStatus = 'open' | 'matched' | 'completed' | 'cancelled';
export type Urgency = 'routine' | 'soon' | 'urgent';
export type SessionMode = 'in_person' | 'virtual' | 'phone';

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
  thisWeek: 181.28,   // 2 sessions × avg ~$90.64
  thisMonth: 724.22,  // realistic monthly for part-time CHW
  allTime: 8_304.50,
  pendingPayout: 181.28,
  sessionsThisWeek: 2,
  avgRating: 4.9,
};

// ─── Vertical display helpers ──────────────────────────────────────────────────

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

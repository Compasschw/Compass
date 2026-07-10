/**
 * React Query hooks for all backend API endpoints.
 *
 * Each query hook returns { data, isLoading, error, refetch }.
 * Each mutation hook returns { mutateAsync, isPending }.
 *
 * All responses are auto-transformed from snake_case → camelCase.
 * All request bodies are auto-transformed from camelCase → snake_case.
 */

import { Platform } from 'react-native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { ApiError, api, getTokens } from '../api/client';
import { transformKeys, toSnakeCase } from '../utils/caseTransform';
import { showAlert } from '../utils/showAlert';
import { getSessionAISummary, type AISummaryResponse } from '../api/sessions';

// ─── Types (camelCase, matching what screens expect) ─────────────────────────

export interface SessionData {
  id: string;
  requestId: string;
  chwId: string;
  memberId: string;
  vertical: string;
  status: string;
  mode: string;
  scheduledAt: string;
  /** Appointment end time (calendar duration). Distinct from endedAt (actual end). */
  scheduledEndAt?: string | null;
  /** CHW's Confirmed/Pending choice for a scheduled appointment. */
  schedulingStatus?: 'confirmed' | 'pending' | null;
  startedAt?: string;
  endedAt?: string;
  durationMinutes?: number;
  suggestedUnits?: number;
  unitsBilled?: number;
  grossAmount?: number;
  netAmount?: number;
  /** CHW-authored notes — the canonical `summary` field on the documentation row. */
  notes?: string;
  /** AI-generated summary from session transcript. Null/absent when unavailable. */
  aiSummary?: string | null;
  /** ISO8601 timestamp of AI summary generation. */
  aiSummaryGeneratedAt?: string | null;
  /** When true, the CHW opted to exclude the AI summary from submitted documentation. */
  aiSummaryExcluded?: boolean;
  /** Inbox swipe-action state. Null/undefined = default (not pinned / not archived / not deleted).
   *  When set, holds the UTC ISO8601 timestamp the CHW applied the action. Deleted threads are
   *  never returned by the inbox list endpoint, so deletedAt is informational only on detail loads. */
  pinnedAt?: string | null;
  archivedAt?: string | null;
  deletedAt?: string | null;
  createdAt: string;
  chwName?: string;
  memberName?: string;
}

export interface ServiceRequestData {
  id: string;
  memberId: string;
  matchedChwId?: string;
  /** Legacy single-vertical field — always set to verticals[0]. */
  vertical: string;
  /** Authoritative multi-vertical array. May be empty for pre-migration rows;
   *  fall back to [vertical] when rendering in that case. */
  verticals: string[];
  urgency: string;
  description: string;
  preferredMode: string;
  status: string;
  estimatedUnits: number;
  createdAt: string;
  memberName?: string;
}

export interface EarningsSummary {
  thisMonth: number;
  allTime: number;
  avgRating: number;
  sessionsThisWeek: number;
  pendingPayout: number;
  // Earnings-page fields (respect the ?period= selector).
  earningsThisPeriod: number;
  paidThisPeriod: number;
  pendingInTransit: boolean;
  nextPayoutDate?: string | null; // ISO date
}

/** Period selector for the Earnings page. */
export type EarningsPeriod = 'this_month' | 'last_month';

/** One completed-session earning row (Sessions Completed table). */
export interface SessionEarningItem {
  sessionId: string;
  serviceDate?: string | null; // ISO date
  memberName: string;
  sessionMode: string; // 'in_person' | 'virtual' | 'phone'
  units: number;
  amountEarned: number;
  paymentStatus: 'paid' | 'pending';
}

/** One payout row (Recent Payouts table). */
export interface PayoutItem {
  date?: string | null; // ISO datetime
  amount: number;
  status: string;
  method: string;
  reference?: string | null;
}

export interface ChwProfile {
  id: string;
  userId: string;
  specializations: string[];
  languages: string[];
  rating: number;
  yearsExperience: number;
  totalSessions: number;
  isAvailable: boolean;
  bio: string;
  zipCode: string;
  // Joined from the User row by /chw/profile (mirrors MemberProfile shape).
  // Optional in the type because older API responses may pre-date the join.
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  /**
   * ISO-8601 timestamp set by POST /phone/confirm-verification.
   * Null means the stored phone number has not been SMS-verified.
   */
  phoneVerifiedAt?: string | null;
  /**
   * S3 public-bucket URL for the CHW's profile photo.
   * Null when no photo has been uploaded.
   */
  profilePictureUrl?: string | null;
  /**
   * Compliance status, surfaced on the CHW Profile screen.
   * backgroundCheckStatus is one of: "not_started" | "pending" | "clear" | "consider".
   * Optional because older API responses may pre-date the compliance columns.
   */
  hipaaTrainingCompleted?: boolean;
  chwCertification?: string | null;
  backgroundCheckStatus?: 'not_started' | 'pending' | 'clear' | 'consider';
}

export interface MemberProfile {
  id: string;
  userId: string;
  zipCode: string;
  primaryLanguage: string;
  primaryNeed: string;
  rewardsBalance: number;
  preferredMode?: string;
  insuranceProvider?: string;
  // Surfaced from the associated User row.
  name?: string;
  phone?: string;
  email?: string;
  /**
   * ISO-8601 timestamp set by POST /phone/confirm-verification.
   * Null / absent means the stored phone number has not been SMS-verified.
   */
  phoneVerifiedAt?: string | null;
  /**
   * S3 public-bucket URL for the member's profile photo.
   * Null when no photo has been uploaded.
   */
  profilePictureUrl?: string | null;
  // ── Full demographics (member-editable on their own profile) ──────────────
  // Returned in full by GET /member/profile (member-only). mediCalId is the full
  // CIN (the member is the data subject viewing their own record).
  preferredName?: string | null;
  dateOfBirth?: string | null; // ISO date "YYYY-MM-DD"
  gender?: string | null;      // "Male" | "Female" | "Other"
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;       // 2-letter USPS code
  insuranceCompany?: string | null;
  mediCalId?: string | null;   // full CIN, e.g. "12345678A"
}

export interface ChwBrowseItem {
  /** CHWProfile primary key (not the user UUID). */
  id: string;
  /**
   * CHW User.id (UUID). Use this — not `id` — as the chw_id path param for
   * GET /member/chws/{chw_id} and any other user-scoped CHW endpoints.
   * The backend browse endpoint returns both fields; this is the one that
   * joins against the users table.
   */
  userId: string;
  name: string;
  specializations: string[];
  languages: string[];
  rating: number;
  yearsExperience: number;
  totalSessions: number;
  isAvailable: boolean;
  bio: string;
  zipCode: string;
}

export interface RewardTransaction {
  id: string;
  action: string;
  points: number;
  createdAt: string;
}

export interface ConversationData {
  id: string;
  chwId: string;
  memberId: string;
  sessionId: string | null;
  /**
   * Currently in_progress Session for this conversation, if any.
   * Source-of-truth for End Session / Submit Documentation in the CHW
   * Messages screen — when null, those buttons should be hidden.
   */
  activeSessionId: string | null;
  createdAt: string;
  /** Display name of the CHW participant. */
  chwName: string;
  /** Display name of the member participant. */
  memberName: string;
  /**
   * Member's last authenticated activity (ISO8601). Null if never active.
   * Drives the presence "Active" pill (member on the app within ~10 min).
   */
  memberLastActiveAt: string | null;
  /** Body-truncated preview of the most recent message. Null when no messages yet. */
  lastMessagePreview: string | null;
  /** ISO8601 timestamp of the most recent message. Null when no messages yet. */
  lastMessageAt: string | null;
  /** UUID of the user who sent the most recent message. Null when no messages. */
  lastMessageSenderId: string | null;
  /** Count of messages the authenticated user has not yet read. */
  unreadCount: number;
  /** ISO8601 timestamp when the user pinned this thread. Null = unpinned. */
  pinnedAt: string | null;
  /** ISO8601 timestamp when the user archived this thread. Null = active. */
  archivedAt: string | null;
  /** ISO8601 soft-delete timestamp. Null = not deleted. */
  deletedAt: string | null;
  /** UUID of the user who soft-deleted the thread. Null = not deleted. */
  deletedByUserId: string | null;
}

export interface FileAttachmentInline {
  id: string;
  filename: string;
  sizeBytes: number;
  contentType: string;
  s3Key: string;
}

export interface MessageData {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  type: string;
  createdAt: string;
  attachment?: FileAttachmentInline | null;
}

// ─── Member-facing CHW Profile ───────────────────────────────────────────────

/**
 * Public-style CHW profile returned by GET /member/chws/{chw_id}.
 *
 * Any authenticated member may fetch this for any CHW — no relationship gate.
 * Fields are the CHW's professional/public attributes; phone/email/payout state
 * are explicitly excluded (members contact CHWs through the platform).
 */
export interface MemberFacingCHWProfile {
  /** CHW user ID — the canonical identifier used in navigation params. */
  id: string;
  /** First name from the CHW's display name. */
  firstName: string;
  /**
   * Privacy shorthand: first character of the last name + ".".
   * E.g. "Smith" → "S.".
   */
  lastNameInitial: string;
  /** Primary language from CHWProfile.languages[0], defaulting to "English". */
  primaryLanguage: string;
  /** Remaining elements of CHWProfile.languages after the first. */
  additionalLanguages: string[];
  /** First element of CHWProfile.specializations, or null. */
  primarySpecialization: string | null;
  /**
   * Human-readable experience bracket derived from CHWProfile.years_experience.
   * E.g. "<1 year", "1 year", "5 years". Null when CHWProfile row is absent.
   */
  yearsExperience: string | null;
  /** True when the CHW's intake confirms CA CHW certification. */
  caChwCertified: boolean;
  /** Preferred modality: "in_person" | "virtual" | "hybrid" | null. */
  modality: string | null;
  /** ZIP codes the CHW serves. Currently single-element (CHWProfile.zip_code). */
  serviceAreaZips: string[];
  /** Day abbreviations from availability_windows JSONB. E.g. ["mon","wed","fri"]. */
  availableDays: string[];
  /** Effective weekly hours: { "mon": "09:00-17:00", ... }. Drives calendar shading. */
  availabilityWindows: Record<string, string>;
  /** Count of sessions the calling member has had with this CHW (any status). */
  sharedSessionCount: number;
  /** CHW's self-uploaded avatar (presigned). Null → fall back to initials. */
  profilePictureUrl?: string | null;
}

// ─── CHW Member Profile (HIPAA-gated) ────────────────────────────────────────

/**
 * HIPAA minimum-necessary member profile returned by GET /chw/members/{id}/profile.
 *
 * Excludes: medi_cal_id, insurance_provider, session notes/transcripts, and
 * session data belonging to other CHWs. See backend CHWMemberProfileView for
 * the full exclusion list and statutory justification.
 */
export interface ChwMemberProfileView {
  id: string;
  name: string;
  /** Phone for masked-call initiation only. May be null. */
  phone: string | null;
  primaryLanguage: string;
  primaryNeed: string | null;
  /** ZIP for service-area context; not precise enough for re-identification. */
  zipCode: string | null;
  /** Completed sessions with this CHW only. */
  totalSessionsWithYou: number;
  /** Completed sessions across all CHWs — care-continuity context. */
  totalSessionsAllTime: number;
  /** ISO timestamp of the last completed session between this CHW and member. */
  lastSessionAt: string | null;
  /** Open service_request.id matched to this CHW, if any. */
  activeRequestId: string | null;
}

// ─── Query Keys ──────────────────────────────────────────────────────────────

// ─── CHW Map Data ─────────────────────────────────────────────────────────────

/**
 * A single member pin on the CHW map.
 *
 * PHI-minimised: display_name is first-initial only ("J."), coordinates are
 * ZIP-centroid (not precise address). Full member data must be fetched via
 * useChwMemberProfile.
 */
export interface MapMemberPin {
  id: string;
  /** First initial + period only, e.g. "J." */
  displayName: string;
  zipCode: string;
  /** ZIP-centroid latitude — NOT precise address. */
  latitude: number;
  /** ZIP-centroid longitude — NOT precise address. */
  longitude: number;
  /** Member's stated care need categories (e.g. ["housing", "food"]). */
  primaryCategories: string[];
  /** Count of completed sessions between this CHW and this member. */
  sessionCount: number;
}

/**
 * A single resource pin on the CHW map.
 *
 * Resources are public service locations — not PHI. Precise coordinates are
 * appropriate here. Category drives pin colour.
 */
export interface MapResourcePin {
  id: string;
  name: string;
  /** One of: housing | food | mental_health | transportation | healthcare | employment */
  category: string;
  latitude: number;
  longitude: number;
  address: string;
}

/** Aggregate response from GET /chw/map-data. */
export interface ChwMapData {
  members: MapMemberPin[];
  resources: MapResourcePin[];
}

// ─── Members Roster ───────────────────────────────────────────────────────────

/**
 * Lightweight journey info embedded in a roster row.
 * Matches backend ActiveJourneyInfo schema.
 */
export interface ActiveJourneyInfo {
  /** Journey template name, e.g. 'Food Assistance'. */
  name: string;
  /** Current in-progress step name. Null when no active step. */
  currentStep: string | null;
  /** Completion percentage 0–100. */
  percent: number;
}

/**
 * A single row in the CHW Members roster table.
 * Matches backend MembersRosterItem schema.
 *
 * HIPAA: medi_cal_id raw value is never present — only maskedId (last 4 chars).
 */
export interface MembersRosterItem {
  /** Member's User.id — use for navigation to CHWMemberProfileScreen. */
  id: string;
  displayName: string;
  /** Age in whole years from DOB. Null when DOB not recorded (v1). */
  age: number | null;
  /** Full DOB (ISO "YYYY-MM-DD"). Canonical patient-matching identifier for the
   *  relationship-gated CHW. Null when not recorded. */
  dateOfBirth?: string | null;
  /** Last 4 of medi_cal_id formatted '...XXXX'. '—' when absent. */
  maskedId: string;
  /** Up to 2 uppercase initials for the avatar circle. */
  avatarInitials: string;
  /** 'active' = session in last 30d OR open/accepted request. */
  status: 'active' | 'inactive';
  /** Always null in v1 — no clinical risk model yet. */
  risk: null;
  /** Engagement bucket derived from 60-day session count. */
  engagement: 'highly' | 'moderately' | 'disengaged';
  /** Most recent active journey, or null if none. */
  activeJourney: ActiveJourneyInfo | null;
  /** ISO timestamp of most recent session. */
  lastContactAt: string | null;
  /** Primary vertical of the most recent active ServiceRequest. */
  topNeed: string | null;
}

// ─── Case Notes types ────────────────────────────────────────────────────────

/**
 * A single case note authored by the authenticated CHW.
 *
 * ``body`` is PHI — it is only returned to the authorised author or admin.
 * All fields are camelCase (auto-transformed by the api client).
 */
export interface CaseNoteData {
  id: string;
  memberId: string;
  chwId: string;
  sessionId: string | null;
  body: string;
  isPinned: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Paginated response from GET /members/{id}/case-notes. */
export interface CaseNoteListData {
  items: CaseNoteData[];
  total: number;
  limit: number;
  offset: number;
}

export const queryKeys = {
  sessions: ['sessions'] as const,
  session: (id: string) => ['sessions', id] as const,
  sessionAiSummary: (id: string) => ['sessions', id, 'ai-summary'] as const,
  requests: ['requests'] as const,
  /** Member-scoped: the authenticated member's own requests regardless of status. */
  myRequests: ['requests', 'mine'] as const,
  /** CHW-scoped: requests the member directed at THIS CHW (24h lock window). */
  incomingMemberRequests: ['requests', 'incoming'] as const,
  chwEarnings: ['chw', 'earnings'] as const,
  chwClaims: ['chw', 'claims'] as const,
  chwProfile: ['chw', 'profile'] as const,
  memberProfile: ['member', 'profile'] as const,
  memberRewards: ['member', 'rewards'] as const,
  chwBrowse: (vertical?: string) => ['chw', 'browse', vertical ?? 'all'] as const,
  conversations: ['conversations'] as const,
  /**
   * Conversation list split on the includeArchived flag so toggling the
   * "Show archived" filter never returns stale cached data.
   */
  conversationList: (includeArchived: boolean) =>
    ['conversations', { includeArchived }] as const,
  messages: (conversationId: string) => ['conversations', conversationId, 'messages'] as const,
  chwMemberProfile: (memberId: string) => ['chw', 'members', memberId, 'profile'] as const,
  /** Full rich member profile for the CHW Member Profile screen. */
  chwMemberDetail: (memberId: string) => ['chw', 'members', memberId, 'detail'] as const,
  chwMapData: ['chw', 'map-data'] as const,
  /** Public-style CHW profile for the member-facing CHW Profile screen. */
  memberFacingCHWProfile: (chwId: string) => ['member', 'chws', chwId] as const,
  /** CHW caseload journey list from GET /chw/journeys. */
  chwJourneys: ['chw', 'journeys'] as const,
  /** CHW members roster from GET /chw/members. */
  chwMembers: ['chw', 'members'] as const,
  /** CHW resource-folder search results, scoped by category + free-text query. */
  chwResources: (category?: string, q?: string) =>
    ['chw', 'resources', category ?? 'all', q ?? ''] as const,
  /** Case notes for a member, scoped to the authenticated CHW. */
  caseNotes: (memberId: string, limit?: number, offset?: number) =>
    ['case-notes', memberId, limit ?? 50, offset ?? 0] as const,
};

/** Re-export so callers don't need a second import from api/sessions. */
export type { AISummaryResponse };

/** CHW-assigned priority level for a resource need category. */
export type ResourceNeedLevel = 'low' | 'medium' | 'high';

/**
 * Per-claim row returned by GET /chw/claims. Exposes the lifecycle status
 * (pending / submitted / paid / rejected) so the Earnings screen can show
 * accurate per-session badges instead of mocked-by-id values.
 */
export interface ChwClaim {
  id: string;
  sessionId: string | null;
  procedureCode: string;
  units: number;
  grossAmount: number;
  platformFee: number;
  pearSuiteFee: number | null;
  netPayout: number;
  status: 'pending' | 'submitted' | 'paid' | 'rejected' | string;
  serviceDate: string | null;
  submittedAt: string | null;
  paidAt: string | null;
  createdAt: string | null;
}

// ─── Query Hooks ─────────────────────────────────────────────────────────────

/**
 * Inbox list. When ``includeArchived`` is true the CHW also sees archived
 * threads in the same list (used to power the "Show archived" toggle in
 * the inbox header). Soft-deleted threads are NEVER returned. The query
 * key splits on the flag so toggling doesn't return stale cached data.
 */
export function useSessions(options?: { includeArchived?: boolean }) {
  const includeArchived = options?.includeArchived ?? false;
  return useQuery({
    queryKey: [...queryKeys.sessions, { includeArchived }],
    queryFn: async () => {
      const qs = includeArchived ? '?include_archived=true' : '';
      const raw = await api<unknown[]>(`/sessions/${qs}`);
      return transformKeys<SessionData[]>(raw);
    },
    // Poll + refetch on focus so a session scheduled by the other party (e.g. a
    // CHW booking a follow-up) shows up on this side's calendar without a manual
    // refresh. Both calendars read this query.
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useSession(id: string) {
  return useQuery({
    queryKey: queryKeys.session(id),
    queryFn: async () => {
      const raw = await api<unknown>(`/sessions/${id}`);
      return transformKeys<SessionData>(raw);
    },
    enabled: !!id,
  });
}

export function useRequests() {
  return useQuery({
    queryKey: queryKeys.requests,
    queryFn: async () => {
      const raw = await api<unknown[]>('/requests/');
      return transformKeys<ServiceRequestData[]>(raw);
    },
    // Re-fetch every 15 s while the component is mounted so the CHW open-request
    // list reflects member cancellations without requiring a manual pull-to-refresh.
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });
}

/**
 * Member-side query: returns all of the authenticated member's own requests,
 * ordered newest-first. The backend's GET /requests/ already scopes to the
 * caller when the caller is a member, so this reuses the same endpoint but
 * stores the result under a separate query key so member and CHW caches don't
 * collide.
 *
 * Polls every 15 s so the member sees CHW-pass events without a manual refresh.
 */
export function useMyRequests() {
  return useQuery({
    queryKey: queryKeys.myRequests,
    queryFn: async () => {
      const raw = await api<unknown[]>('/requests/');
      return transformKeys<ServiceRequestData[]>(raw);
    },
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });
}

export function useChwEarnings(period: EarningsPeriod = 'this_month') {
  return useQuery({
    queryKey: [...queryKeys.chwEarnings, period] as const,
    queryFn: async () => {
      const raw = await api<unknown>(`/chw/earnings?period=${period}`);
      return transformKeys<EarningsSummary>(raw);
    },
  });
}

/** Completed-session earnings for the Sessions Completed table. */
export function useChwEarningSessions(period: EarningsPeriod = 'this_month') {
  return useQuery({
    queryKey: ['chw', 'earnings', 'sessions', period] as const,
    queryFn: async () => {
      const raw = await api<unknown[]>(`/chw/earnings/sessions?period=${period}`);
      return transformKeys<SessionEarningItem[]>(raw);
    },
  });
}

/** Recent payouts (paid claims) for the Recent Payouts table. */
export function useChwPayouts(period: EarningsPeriod = 'this_month') {
  return useQuery({
    queryKey: ['chw', 'payouts', period] as const,
    queryFn: async () => {
      const raw = await api<unknown[]>(`/chw/payouts?period=${period}`);
      return transformKeys<PayoutItem[]>(raw);
    },
  });
}

/**
 * Per-claim list for the authenticated CHW (newest first, capped at 200).
 * Replaces the mocked `derivePayoutStatus(sess-002 → "submitted")` table in
 * CHWEarningsScreen with real BillingClaim status sourced from PostgreSQL.
 */
export function useChwClaims() {
  return useQuery({
    queryKey: queryKeys.chwClaims,
    queryFn: async () => {
      const raw = await api<unknown>('/chw/claims');
      return transformKeys<ChwClaim[]>(raw);
    },
  });
}

export function useChwProfile() {
  return useQuery({
    queryKey: queryKeys.chwProfile,
    queryFn: async () => {
      const raw = await api<unknown>('/chw/profile');
      return transformKeys<ChwProfile>(raw);
    },
  });
}

export function useMemberProfile() {
  return useQuery({
    queryKey: queryKeys.memberProfile,
    queryFn: async () => {
      const raw = await api<unknown>('/member/profile');
      return transformKeys<MemberProfile>(raw);
    },
  });
}

export function useMemberRewards() {
  return useQuery({
    queryKey: queryKeys.memberRewards,
    queryFn: async () => {
      const raw = await api<unknown[]>('/member/rewards');
      return transformKeys<RewardTransaction[]>(raw);
    },
  });
}

export function useChwBrowse(vertical?: string) {
  return useQuery({
    queryKey: queryKeys.chwBrowse(vertical),
    queryFn: async () => {
      const path = vertical && vertical !== 'all'
        ? `/chw/browse?vertical=${vertical}`
        : '/chw/browse';
      const raw = await api<unknown[]>(path);
      return transformKeys<ChwBrowseItem[]>(raw);
    },
  });
}

/**
 * Fetch the HIPAA-scoped member profile for a given member, gated on the
 * authenticated CHW having an active relationship (session or accepted request).
 *
 * Returns null data when memberId is empty — callers should guard on that.
 *
 * HTTP 403 from the backend (no relationship) is surfaced as-is so the screen
 * can render the "no access" empty state instead of a generic error.
 */
export function useChwMemberProfile(memberId: string) {
  return useQuery({
    queryKey: queryKeys.chwMemberProfile(memberId),
    queryFn: async () => {
      const raw = await api<unknown>(`/chw/members/${memberId}/profile`);
      return transformKeys<ChwMemberProfileView>(raw);
    },
    enabled: memberId.length > 0,
    staleTime: 60_000, // 1 min — profile data is slow-moving
    retry: (failureCount, error: unknown) => {
      // Never retry a 403 — the gate is intentional, not transient.
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

/**
 * Fetch the CHW's map data: member ZIP-centroid pins + community resource pins.
 *
 * Members are filtered server-side to only those the calling CHW has had at
 * least one session with. Coordinates are ZIP-centroid for members (PHI-safe)
 * and precise for resources (public service locations — not PHI).
 *
 * Stale after 2 minutes — member/resource data changes slowly; this avoids
 * hammering the backend on every re-render.
 */
export function useChwMapData() {
  return useQuery({
    queryKey: queryKeys.chwMapData,
    queryFn: async () => {
      const raw = await api<unknown>('/chw/map-data');
      return transformKeys<ChwMapData>(raw);
    },
    staleTime: 120_000, // 2 min — map data changes slowly
  });
}

/**
 * Fetch the public-style CHW profile for the member-facing CHW Profile screen.
 *
 * Any authenticated member may call this for any CHW — there is no relationship
 * gate on the backend (unlike useChwMemberProfile which requires an active
 * session or service request). This is the "public discovery" surface.
 *
 * Stale after 2 minutes — CHW profile data changes rarely (specializations,
 * languages, availability). The shared_session_count portion changes more often
 * but is low-stakes to serve slightly stale.
 *
 * @param chwId - The CHW's user UUID (from ChwBrowseItem.id or session.chwId).
 */
export function useMemberFacingCHWProfile(chwId: string) {
  return useQuery({
    queryKey: queryKeys.memberFacingCHWProfile(chwId),
    queryFn: async (): Promise<MemberFacingCHWProfile> => {
      const raw = await api<unknown>(`/member/chws/${chwId}`);
      return transformKeys<MemberFacingCHWProfile>(raw);
    },
    enabled: chwId.length > 0,
    staleTime: 120_000, // 2 min — CHW profile data is slow-moving
    retry: (failureCount, error: unknown) => {
      // Never retry a 404 — the CHW genuinely doesn't exist.
      if (
        error != null &&
        typeof error === 'object' &&
        'status' in error &&
        (error as { status: number }).status === 404
      ) {
        return false;
      }
      return failureCount < 2;
    },
  });
}

/**
 * Inbox conversation list.
 *
 * When `includeArchived` is true the user also sees archived threads in the
 * same list (powers the "Show archived" toggle in the inbox header).
 * Soft-deleted threads are NEVER returned — the server excludes them.
 * The query key splits on the flag so toggling doesn't return stale cached data.
 *
 * Sort order is determined server-side: pinned first, then last_message_at desc.
 */
export function useConversations(options?: { includeArchived?: boolean }) {
  const includeArchived = options?.includeArchived ?? false;
  return useQuery({
    queryKey: queryKeys.conversationList(includeArchived),
    queryFn: async () => {
      const qs = includeArchived ? '?include_archived=true' : '';
      const raw = await api<unknown[]>(`/conversations/${qs}`);
      return transformKeys<ConversationData[]>(raw);
    },
    // Poll so member presence (the "Active" pill) and unread counts stay live.
    refetchInterval: 45_000,
  });
}

export function useMessages(conversationId: string) {
  return useQuery({
    queryKey: queryKeys.messages(conversationId),
    queryFn: async () => {
      const raw = await api<unknown[]>(`/conversations/${conversationId}/messages`);
      return transformKeys<MessageData[]>(raw);
    },
    enabled: !!conversationId,
  });
}

// ─── Mutation Hooks ──────────────────────────────────────────────────────────

/**
 * Row shape for the CHW Members-page "Request" filter. One entry per
 * pending Schedule-with-X request that's still inside its 24h CHW-exclusive
 * lock window AND directed at the authenticated CHW.
 */
export interface IncomingMemberRequest {
  id: string;
  memberId: string;
  memberName: string;
  vertical: string;
  verticals: string[];
  urgency: string;
  preferredMode: string;
  description: string;
  estimatedUnits: number;
  targetExpiresAt: string | null;
  createdAt: string;
}

/**
 * GET /api/v1/requests/incoming — pending member requests directed at the
 * authenticated CHW.  Polls every 30s while mounted so the Request filter
 * picks up new submissions without a manual pull-to-refresh.
 */
export function useIncomingMemberRequests(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.incomingMemberRequests,
    queryFn: async () => {
      const raw = await api<unknown[]>('/requests/incoming');
      return transformKeys<IncomingMemberRequest[]>(raw);
    },
    enabled: options?.enabled ?? true,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useAcceptRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (requestId: string) => {
      await api(`/requests/${requestId}/accept`, { method: 'PATCH' });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.requests });
      void qc.invalidateQueries({ queryKey: queryKeys.sessions });
      // Request filter row vanishes after Accept (request becomes a member).
      void qc.invalidateQueries({ queryKey: queryKeys.incomingMemberRequests });
    },
  });
}

export function usePassRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (requestId: string) => {
      await api(`/requests/${requestId}/pass`, { method: 'PATCH' });
    },
    onSuccess: () => {
      // Invalidate both the CHW open-requests list and the member pending list
      // so both sides reflect the pass within the next polling cycle.
      void qc.invalidateQueries({ queryKey: queryKeys.requests });
      void qc.invalidateQueries({ queryKey: queryKeys.myRequests });
      // Decline button on the Request filter routes through pass too.
      void qc.invalidateQueries({ queryKey: queryKeys.incomingMemberRequests });
    },
  });
}

/**
 * Member cancels one of their own open requests.
 *
 * Optimistic behaviour: the caller removes the request from the local list
 * immediately (via the `pendingCancelIds` state in `MemberSessionsScreen`).
 * On success we invalidate both the member and CHW request caches so both
 * sides pick up the cancellation within the next polling cycle (≤15 s).
 *
 * Calls PATCH /requests/{id}/cancel — the backend enforces that only the
 * owning member may cancel, and only while the request is still `open`.
 */
export function useCancelRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (requestId: string) => {
      await api(`/requests/${requestId}/cancel`, { method: 'PATCH' });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.myRequests });
      // Also invalidate the CHW-facing requests query so any CHW browsing open
      // requests sees the cancellation within the next polling cycle.
      void qc.invalidateQueries({ queryKey: queryKeys.requests });
    },
  });
}

export interface CreateRequestPayload {
  /**
   * One or more verticals the member needs help with.
   * Replaces the old per-vertical fan-out pattern: the frontend now sends a
   * single POST with all selected verticals instead of N separate requests.
   */
  verticals: string[];
  urgency: string;
  description: string;
  preferredMode: string;
  estimatedUnits: number;
  /** Schedule-with-X: chosen CHW's user_id. Backend locks the request to
   *  this CHW for 24h before opening it to the general pool. */
  targetChwId?: string;
}

export function useCreateRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreateRequestPayload) => {
      // POST one request carrying the full verticals array.
      // The backend writes both `verticals` (authoritative) and
      // `vertical = verticals[0]` (backwards-compat for sessions/claims).
      await api('/requests/', {
        method: 'POST',
        body: JSON.stringify(toSnakeCase(data)),
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.requests });
    },
    onError: (error: Error) => {
      showAlert('Something went wrong', error?.message ?? 'Please try again.');
    },
  });
}

// ─── Create Session ───────────────────────────────────────────────────────────

export interface CreateSessionPayload {
  /** Accepted ServiceRequest.id that this session is fulfilling. */
  requestId: string;
  /** ISO-8601 datetime string for the scheduled start. */
  scheduledAt: string;
  /** Session delivery modality — mirrors backend SessionMode enum. */
  mode: 'in_person' | 'virtual';
}

/**
 * CHW mutation — create a new scheduled session from an accepted service request.
 *
 * POST /api/v1/sessions/
 *
 * Requires a `request_id` from an already-accepted ServiceRequest.
 * The backend derives `chw_id`, `member_id`, and `vertical` from the request row.
 *
 * On success, invalidates the sessions list so the calendar and dashboard
 * reflect the newly scheduled session without a manual refresh.
 */
export function useCreateSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: CreateSessionPayload): Promise<SessionData> => {
      const raw = await api<unknown>('/sessions/', {
        method: 'POST',
        body: JSON.stringify({
          request_id: payload.requestId,
          scheduled_at: payload.scheduledAt,
          mode: payload.mode,
        }),
      });
      return transformKeys<SessionData>(raw);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.sessions });
      void qc.invalidateQueries({ queryKey: queryKeys.requests });
    },
    onError: (error: Error) => {
      showAlert('Failed to schedule session', error?.message ?? 'Please try again.');
    },
  });
}

export interface ScheduleSessionPayload {
  /** CHW path: the member to schedule with (CHW must already work with them). */
  memberId?: string;
  /** Member path: the CHW to schedule with (the member's assigned CHW). */
  chwId?: string;
  /** ISO-8601 datetime for the appointment start. */
  scheduledAt: string;
  /** ISO-8601 datetime for the appointment end (optional). */
  scheduledEndAt?: string | null;
  /** Session delivery modality — mirrors backend SessionMode (virtual = video). */
  mode: 'in_person' | 'virtual' | 'phone';
  /** CHW's Confirmed/Pending choice. */
  schedulingStatus?: 'confirmed' | 'pending';
  notes?: string;
}

/**
 * CHW mutation — schedule a session directly with one of their members.
 *
 * POST /api/v1/sessions/schedule. Unlike useCreateSession, no pre-existing
 * service request is needed: the backend reuses or auto-creates the underlying
 * request. Powers the Calendar "Schedule Session" flow.
 */
export function useScheduleSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: ScheduleSessionPayload): Promise<SessionData> => {
      const raw = await api<unknown>('/sessions/schedule', {
        method: 'POST',
        body: JSON.stringify({
          // CHW path sends member_id; member path sends chw_id. The backend
          // resolves the other side from the authenticated caller.
          ...(payload.memberId ? { member_id: payload.memberId } : {}),
          ...(payload.chwId ? { chw_id: payload.chwId } : {}),
          scheduled_at: payload.scheduledAt,
          scheduled_end_at: payload.scheduledEndAt ?? null,
          mode: payload.mode,
          scheduling_status: payload.schedulingStatus ?? 'confirmed',
          notes: payload.notes ?? null,
        }),
      });
      return transformKeys<SessionData>(raw);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.sessions });
    },
    onError: (error: Error) => {
      showAlert('Failed to schedule session', error?.message ?? 'Please try again.');
    },
  });
}

export function useStartSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: string) => {
      await api(`/sessions/${sessionId}/start`, { method: 'PATCH' });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.sessions });
    },
  });
}

/** CHW confirms a member-requested (pending) session → scheduling_status confirmed. */
export function useConfirmSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: string): Promise<SessionData> => {
      const raw = await api<unknown>(`/sessions/${sessionId}/confirm`, { method: 'PATCH' });
      return transformKeys<SessionData>(raw);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.sessions });
    },
    onError: (error: Error) => {
      showAlert('Failed to confirm session', error?.message ?? 'Please try again.');
    },
  });
}

/** CHW declines a member-requested (pending) session → status cancelled. */
export function useDeclineSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: string): Promise<SessionData> => {
      const raw = await api<unknown>(`/sessions/${sessionId}/decline`, { method: 'PATCH' });
      return transformKeys<SessionData>(raw);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.sessions });
    },
    onError: (error: Error) => {
      showAlert('Failed to decline session', error?.message ?? 'Please try again.');
    },
  });
}

/**
 * Either participant cancels a scheduled session (the member "Remove" action,
 * and the cancel half of a reschedule). PATCH /sessions/{id}/cancel.
 */
export function useCancelSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: string): Promise<SessionData> => {
      const raw = await api<unknown>(`/sessions/${sessionId}/cancel`, { method: 'PATCH' });
      return transformKeys<SessionData>(raw);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.sessions });
    },
    onError: (error: Error) => {
      showAlert('Failed to remove session', error?.message ?? 'Please try again.');
    },
  });
}

/** The CHW's open 30-min slots for a day (ISO-8601 UTC), for member scheduling. */
export interface AvailableSlotsResponse {
  date: string;
  slots: string[];
}

/**
 * GET /member/chws/{chwId}/available-slots?date=YYYY-MM-DD — the CHW's open
 * slots (within their working hours, minus booked) so the member can only pick
 * times the CHW is free.
 */
export function useChwAvailableSlots(chwId: string, date: string, enabled = true) {
  return useQuery({
    queryKey: ['member', 'chws', chwId, 'available-slots', date] as const,
    queryFn: async (): Promise<AvailableSlotsResponse> => {
      const raw = await api<unknown>(
        `/member/chws/${chwId}/available-slots?date=${date}`,
      );
      return transformKeys<AvailableSlotsResponse>(raw);
    },
    enabled: enabled && !!chwId && !!date,
    staleTime: 15_000,
  });
}

export function useCompleteSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: string) => {
      await api(`/sessions/${sessionId}/complete`, { method: 'PATCH' });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.sessions });
      void qc.invalidateQueries({ queryKey: queryKeys.chwEarnings });
    },
  });
}

export function useSubmitDocumentation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, data }: { sessionId: string; data: Record<string, unknown> }) => {
      await api(`/sessions/${sessionId}/documentation`, {
        method: 'POST',
        body: JSON.stringify(toSnakeCase(data)),
      });
    },
    onSuccess: () => {
      // Submitting documentation completes the session and creates a
      // BillingClaim + stamps billed units/amounts, so refresh:
      //  - sessions: the session status flips to "completed" (Messages rail's
      //    "Complete Session" button → "Begin Session").
      //  - conversations: the completed session is no longer in_progress, so the
      //    conversation's active_session_id clears and the rail fully resets.
      //  - Earnings / Claims / Payouts: the new claim + earnings appear.
      void qc.invalidateQueries({ queryKey: queryKeys.sessions });
      void qc.invalidateQueries({ queryKey: queryKeys.conversations });
      void qc.invalidateQueries({ queryKey: queryKeys.chwClaims });
      void qc.invalidateQueries({ queryKey: queryKeys.chwEarnings });
      void qc.invalidateQueries({ queryKey: ['chw', 'payouts'] });
    },
  });
}

// ─── CHW Messages inbox swipe-actions ────────────────────────────────────────
// Three small mutations powering the swipe-revealed Pin / Archive / Delete
// buttons.  Each invalidates the sessions query so the inbox re-fetches and
// the row visually shifts (pin → top of list, archive → vanishes, delete →
// vanishes).  All three are idempotent on the backend.

/**
 * Pin or unpin a thread.  Pinned threads sort to the top of the inbox.
 */
export function useToggleSessionPin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, pinned }: { sessionId: string; pinned: boolean }) => {
      await api(`/sessions/${sessionId}/pin`, {
        method: 'PATCH',
        body: JSON.stringify({ pinned }),
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.sessions });
    },
  });
}

/**
 * Archive or unarchive a thread.  Archived threads disappear from the
 * default inbox; flip the "Show archived" toggle to see them inline.
 */
export function useToggleSessionArchive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, archived }: { sessionId: string; archived: boolean }) => {
      await api(`/sessions/${sessionId}/archive`, {
        method: 'PATCH',
        body: JSON.stringify({ archived }),
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.sessions });
    },
  });
}

/**
 * Mute or unmute a thread.  A muted thread stays in the inbox but its unread
 * notification/badge is suppressed and a bell-off indicator is shown on the
 * row.  Backed by ``PATCH /sessions/{id}/mute`` (body ``{ muted: boolean }``),
 * which toggles the session's ``muted_at`` timestamp.
 *
 * The CHW Messages inbox is conversation-based, so this operates on the
 * conversation's underlying session id (originating or active session).
 * Invalidates both the sessions and conversations queries so any dependent
 * view refetches.
 */
export function useToggleSessionMute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, muted }: { sessionId: string; muted: boolean }) => {
      await api(`/sessions/${sessionId}/mute`, {
        method: 'PATCH',
        body: JSON.stringify({ muted }),
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.sessions });
      void qc.invalidateQueries({ queryKey: queryKeys.conversations });
    },
  });
}

/**
 * Soft-delete a thread.  Hides it from the inbox; PHI/messages remain
 * in the DB for compliance audit + admin-side undelete.
 */
export function useDeleteSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: string) => {
      await api(`/sessions/${sessionId}`, {
        method: 'DELETE',
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.sessions });
    },
  });
}

// ─── End Session ─────────────────────────────────────────────────────────────

/**
 * POST /api/v1/sessions/{sessionId}/end
 *
 * Terminates the active Vonage call bridge and transitions the session from
 * ``in_progress`` → ``awaiting_documentation``.  The FE listens for the
 * ``awaiting_documentation`` status to open the DocumentationModal automatically.
 *
 * Invalidates the sessions cache on success so the inbox reflects the new
 * status without a manual pull-to-refresh.
 *
 * Idempotent: calling /end on an already-ended session returns 200 with the
 * current state — no error is surfaced.
 */
export function useEndSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: string): Promise<SessionData> => {
      const raw = await api<unknown>(`/sessions/${sessionId}/end`, {
        method: 'POST',
      });
      return transformKeys<SessionData>(raw);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.sessions });
    },
    onError: (error: Error) => {
      showAlert('Could not end session', error?.message ?? 'Please try again.');
    },
  });
}

// ─── Case Notes ──────────────────────────────────────────────────────────────

/**
 * Fetch paginated case notes for a member authored by the authenticated CHW.
 *
 * GET /api/v1/members/{memberId}/case-notes
 *
 * Relationship-gated: only the CHW with an active care relationship can read.
 * Results are scoped to the calling CHW — notes from other CHWs are never
 * returned.
 *
 * Stale after 30 s — case notes are low-frequency but important.  Callers
 * should invalidate the query key after a successful create/update/delete to
 * get an immediate refresh.
 */
export function useCaseNotes(
  memberId: string,
  options?: { limit?: number; offset?: number; enabled?: boolean },
) {
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;
  return useQuery({
    queryKey: queryKeys.caseNotes(memberId, limit, offset),
    queryFn: async (): Promise<CaseNoteListData> => {
      const qs = `?limit=${limit}&offset=${offset}`;
      const raw = await api<unknown>(`/members/${memberId}/case-notes${qs}`);
      return transformKeys<CaseNoteListData>(raw);
    },
    enabled: (options?.enabled ?? true) && memberId.length > 0,
    staleTime: 30_000,
  });
}

/** A CHW-authored session documentation summary (the "original" session note). */
export interface SessionNoteData {
  sessionId: string;
  /** When the session happened (ISO); null if never scheduled/started. */
  occurredAt: string | null;
  /** Session modality (phone | video | in_person) — for labeling. */
  mode: string;
  /** The CHW-authored documentation summary. */
  summary: string;
  /** When the documentation was submitted (ISO) — the note's timestamp. */
  submittedAt: string;
}

/**
 * Fetch the CHW-authored session documentation summaries for a member — the
 * "original" session notes shown in the View Notes and Case Notes timelines.
 *
 * GET /api/v1/chw/members/{memberId}/session-notes (relationship-gated;
 * scoped to the caller CHW's own sessions with this member).
 */
export function useSessionNotes(memberId: string, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['chw', 'members', memberId, 'session-notes'] as const,
    queryFn: async (): Promise<SessionNoteData[]> => {
      const raw = await api<unknown>(`/chw/members/${memberId}/session-notes`);
      return transformKeys<SessionNoteData[]>(raw);
    },
    enabled: (options?.enabled ?? true) && memberId.length > 0,
    staleTime: 30_000,
  });
}

export interface CreateCaseNotePayload {
  memberId: string;
  body: string;
  sessionId?: string | null;
  isPinned?: boolean;
}

/**
 * Create a case note for a member.
 *
 * POST /api/v1/case-notes
 *
 * On success invalidates the member's case-note list so the new note appears
 * immediately.
 */
export function useCreateCaseNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: CreateCaseNotePayload): Promise<CaseNoteData> => {
      const raw = await api<unknown>('/case-notes', {
        method: 'POST',
        body: JSON.stringify(toSnakeCase(payload)),
      });
      return transformKeys<CaseNoteData>(raw);
    },
    onSuccess: (_data, variables) => {
      // Invalidate all pages of the member's case-note list.
      void qc.invalidateQueries({
        predicate: (query) => {
          const key = query.queryKey;
          return (
            Array.isArray(key) &&
            key[0] === 'case-notes' &&
            key[1] === variables.memberId
          );
        },
      });
    },
    onError: (error: Error) => {
      showAlert('Could not save note', error?.message ?? 'Please try again.');
    },
  });
}

export interface UpdateCaseNotePayload {
  noteId: string;
  memberId: string; // used only for cache invalidation
  body?: string;
  isPinned?: boolean;
}

/**
 * Edit a case note's body or pin state.
 *
 * PATCH /api/v1/case-notes/{noteId}
 *
 * Author-only on the backend — only the CHW who created the note may edit it.
 */
export function useUpdateCaseNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: UpdateCaseNotePayload): Promise<CaseNoteData> => {
      const { noteId, memberId: _memberId, ...rest } = payload;
      const raw = await api<unknown>(`/case-notes/${noteId}`, {
        method: 'PATCH',
        body: JSON.stringify(toSnakeCase(rest)),
      });
      return transformKeys<CaseNoteData>(raw);
    },
    onSuccess: (_data, variables) => {
      void qc.invalidateQueries({
        predicate: (query) => {
          const key = query.queryKey;
          return (
            Array.isArray(key) &&
            key[0] === 'case-notes' &&
            key[1] === variables.memberId
          );
        },
      });
    },
  });
}

/**
 * Soft-delete a case note.
 *
 * DELETE /api/v1/case-notes/{noteId}
 *
 * Author-only on the backend.  Idempotent — calling twice returns 204 both times.
 */
export function useDeleteCaseNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      noteId,
    }: {
      noteId: string;
      memberId: string;
    }): Promise<void> => {
      await api(`/case-notes/${noteId}`, { method: 'DELETE' });
    },
    onSuccess: (_data, variables) => {
      void qc.invalidateQueries({
        predicate: (query) => {
          const key = query.queryKey;
          return (
            Array.isArray(key) &&
            key[0] === 'case-notes' &&
            key[1] === variables.memberId
          );
        },
      });
    },
  });
}

/**
 * Mutation to generate (or regenerate) an AI summary from the session transcript.
 *
 * Call pattern:
 *   const { mutateAsync, isPending } = useGenerateAISummary();
 *   const result = await mutateAsync(sessionId);
 *
 * On success the result is the raw AISummaryResponse — callers store it in local
 * modal state. We don't cache it in React Query because the user can regenerate
 * on demand and the value is ephemeral until documentation is submitted.
 */
export function useGenerateAISummary() {
  return useMutation({
    mutationFn: (sessionId: string): Promise<AISummaryResponse> =>
      getSessionAISummary(sessionId),
  });
}

export function useUpdateChwProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: Partial<ChwProfile>) => {
      await api('/chw/profile', {
        method: 'PUT',
        body: JSON.stringify(toSnakeCase(data)),
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.chwProfile });
    },
  });
}

/** The CHW's weekly availability windows: { "mon": "09:00-17:00", ... }. */
export interface ChwAvailability {
  availabilityWindows: Record<string, string>;
}

/** GET /chw/availability — the authenticated CHW's own working-hours windows. */
export function useChwAvailability() {
  return useQuery({
    queryKey: ['chw', 'availability'] as const,
    queryFn: async (): Promise<ChwAvailability> => {
      const raw = await api<unknown>('/chw/availability');
      return transformKeys<ChwAvailability>(raw);
    },
    staleTime: 60_000,
  });
}

/** PUT /chw/availability — set the CHW's weekly working-hours windows. */
export function useUpdateChwAvailability() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (windows: Record<string, string>): Promise<ChwAvailability> => {
      const raw = await api<unknown>('/chw/availability', {
        method: 'PUT',
        body: JSON.stringify({ availability_windows: windows }),
      });
      return transformKeys<ChwAvailability>(raw);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['chw', 'availability'] });
    },
    onError: (error: Error) => {
      showAlert('Failed to save availability', error?.message ?? 'Please try again.');
    },
  });
}

export function useUpdateMemberProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: Partial<MemberProfile>) => {
      await api('/member/profile', {
        method: 'PUT',
        body: JSON.stringify(toSnakeCase(data)),
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.memberProfile });
    },
  });
}

// ─── Profile picture upload ───────────────────────────────────────────────────

/** Role determines which profile PUT endpoint to call after the S3 upload. */
export type ProfilePictureRole = 'chw' | 'member';

/**
 * Hook: upload a profile picture for the authenticated user.
 *
 * Flow (called by ProfilePictureEditor):
 *   1. POST /upload/presigned-url with purpose=profile_image → {upload_url, s3_key}
 *   2. PUT <upload_url> with the image blob (no auth header — it's a presigned S3 URL)
 *   3. Build the public S3 URL from s3_key + bucket env var
 *   4. PUT /chw/profile or /member/profile with {profile_picture_url}
 *   5. Invalidate the relevant profile query
 *
 * Returns the new public URL so the editor can show an optimistic preview.
 *
 * The S3 public base URL is the standard virtual-hosted S3 URL:
 *   https://<bucket>.s3.<region>.amazonaws.com/<key>
 * We derive it from the s3_key returned by the presigned-URL endpoint.
 * In production the bucket is publicly readable (profile images are not PHI).
 */
export function useUploadProfilePicture(role: ProfilePictureRole) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({
      blob,
      filename,
      contentType,
    }: {
      blob: Blob;
      filename: string;
      contentType: 'image/jpeg' | 'image/png';
    }): Promise<string> => {
      // Step 1 — get presigned URL from backend
      const presignedRaw = await api<unknown>('/upload/presigned-url', {
        method: 'POST',
        body: JSON.stringify({
          filename,
          content_type: contentType,
          purpose: 'profile_image',
          size_bytes: blob.size,
        }),
      });

      const { uploadUrl, s3Key } = transformKeys<{
        uploadUrl: string;
        s3Key: string;
      }>(presignedRaw);

      // Step 2 — PUT blob directly to S3 (no auth header — presigned URL already encodes credentials)
      const s3Response = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body: blob,
      });

      if (!s3Response.ok) {
        throw new Error(`S3 upload failed with status ${s3Response.status}`);
      }

      // Step 3 — derive public URL from the s3_key
      // The upload endpoint routes profile_image purpose to the public bucket.
      // Public URL format: https://<bucket>.s3.<region>.amazonaws.com/<key>
      // We use the presigned URL's origin (scheme + host) as the base —
      // that avoids hard-coding the bucket/region in the frontend.
      const s3Origin = new URL(uploadUrl).origin;
      const publicUrl = `${s3Origin}/${s3Key}`;

      // Step 4 — update the user's profile with the new URL
      const profilePath = role === 'chw' ? '/chw/profile' : '/member/profile';
      await api(profilePath, {
        method: 'PUT',
        body: JSON.stringify({ profile_picture_url: publicUrl }),
      });

      return publicUrl;
    },
    onSuccess: () => {
      const key = role === 'chw' ? queryKeys.chwProfile : queryKeys.memberProfile;
      void qc.invalidateQueries({ queryKey: key });
    },
  });
}

/**
 * Hook: remove the authenticated user's profile picture.
 * PATCHes profile_picture_url to null via the profile PUT endpoint.
 */
export function useRemoveProfilePicture(role: ProfilePictureRole) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (): Promise<void> => {
      const profilePath = role === 'chw' ? '/chw/profile' : '/member/profile';
      await api(profilePath, {
        method: 'PUT',
        body: JSON.stringify({ profile_picture_url: null }),
      });
    },
    onSuccess: () => {
      const key = role === 'chw' ? queryKeys.chwProfile : queryKeys.memberProfile;
      void qc.invalidateQueries({ queryKey: key });
    },
  });
}

// ─── Payments (Stripe Connect) ───────────────────────────────────────────────

export interface PaymentsAccountStatus {
  accountId: string | null;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  requirementsCurrentlyDue: string[];
}

export interface ConnectOnboardingResponse {
  onboardingUrl: string;
  expiresAt: string;
  accountId: string;
}

export function usePaymentsAccountStatus(enabled = true) {
  return useQuery({
    queryKey: ['payments', 'account-status'],
    queryFn: async () => {
      const raw = await api<unknown>('/payments/account-status');
      return transformKeys<PaymentsAccountStatus>(raw);
    },
    enabled,
    // Re-check on focus — users return from Stripe onboarding and expect fresh state
    refetchOnWindowFocus: true,
    staleTime: 5_000,
  });
}

export function useConnectOnboardingLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<ConnectOnboardingResponse> => {
      const raw = await api<unknown>('/payments/connect-onboarding', {
        method: 'POST',
      });
      return transformKeys<ConnectOnboardingResponse>(raw);
    },
    onSuccess: () => {
      // Creating/reusing the account may affect account-status — refetch
      void qc.invalidateQueries({ queryKey: ['payments', 'account-status'] });
    },
    onError: (error: Error) => {
      // 503 = Stripe payouts aren't configured on the platform yet. This is an
      // expected pre-launch state, not a failure — show the server's friendly
      // message with a neutral title instead of alarming "Something went wrong".
      if (error instanceof ApiError && error.status === 503) {
        showAlert('Payouts not available yet', error.detail);
        return;
      }
      showAlert('Something went wrong', error?.message ?? 'Please try again.');
    },
  });
}

// ─── Magic Link (passwordless auth) ──────────────────────────────────────────

export function useRequestMagicLink() {
  return useMutation({
    mutationFn: async (email: string) => {
      await api('/auth/magic/request', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
    },
  });
}

export interface MagicLinkVerifyResult {
  accessToken: string;
  refreshToken: string;
  role: string;
  name: string;
  tokenType: string;
}

export function useVerifyMagicLink() {
  return useMutation({
    mutationFn: async (token: string): Promise<MagicLinkVerifyResult> => {
      const raw = await api<unknown>('/auth/magic/verify', {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
      return transformKeys<MagicLinkVerifyResult>(raw);
    },
  });
}

// ─── Messages ────────────────────────────────────────────────────────────────

export function useSendMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ conversationId, body }: { conversationId: string; body: string }) => {
      await api(`/conversations/${conversationId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body, type: 'text' }),
      });
    },
    onSuccess: (_data, variables) => {
      void qc.invalidateQueries({ queryKey: queryKeys.messages(variables.conversationId) });
    },
  });
}

/** Shape returned by DELETE /api/v1/conversations/{id} (soft-delete). */
export interface SoftDeleteConversationResult {
  id: string;
  deletedAt: string;
  deletedByUserId: string;
}

/**
 * Soft-delete a conversation thread.
 *
 * DELETE /api/v1/conversations/{conversation_id}
 *
 * Auth: Bearer JWT — caller must be a participant (CHW or member).
 * Idempotent: deleting an already-deleted thread returns 200.
 * Deleted threads are excluded from GET /conversations/ server-side —
 * no client-side filtering needed after invalidation.
 *
 * Optimistic update: removes the conversation from the cached list
 * immediately, then rolls back if the DELETE fails.
 *
 * @param onDeselect - Called on success when the deleted conversation
 *   was currently selected (caller should reset selected thread state).
 */
export function useSoftDeleteConversation(options?: {
  onDeselect?: (conversationId: string) => void;
}) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (conversationId: string): Promise<SoftDeleteConversationResult> => {
      const raw = await api<unknown>(`/conversations/${conversationId}`, {
        method: 'DELETE',
      });
      return transformKeys<SoftDeleteConversationResult>(raw);
    },

    // Optimistic update: yank the row from all active conversation list caches
    // immediately. We snapshot every active conversationList variant
    // (includeArchived=false and includeArchived=true) so we can roll them all
    // back if the DELETE fails.
    onMutate: async (conversationId: string) => {
      // Cancel any in-flight fetches so they don't overwrite our optimistic state.
      await qc.cancelQueries({ queryKey: queryKeys.conversations });

      // Snapshot both possible list variants (archived and non-archived).
      const previousNormal = qc.getQueryData<ConversationData[]>(
        queryKeys.conversationList(false),
      );
      const previousArchived = qc.getQueryData<ConversationData[]>(
        queryKeys.conversationList(true),
      );

      const removeDeleted = (old: ConversationData[] | undefined): ConversationData[] =>
        (old ?? []).filter((c) => c.id !== conversationId);

      qc.setQueryData<ConversationData[]>(queryKeys.conversationList(false), removeDeleted);
      qc.setQueryData<ConversationData[]>(queryKeys.conversationList(true), removeDeleted);

      return { previousNormal, previousArchived };
    },

    onError: (
      _error: unknown,
      _conversationId: string,
      context:
        | {
            previousNormal?: ConversationData[];
            previousArchived?: ConversationData[];
          }
        | undefined,
    ) => {
      // Roll back both list caches to their pre-mutation snapshots.
      if (context?.previousNormal !== undefined) {
        qc.setQueryData(queryKeys.conversationList(false), context.previousNormal);
      }
      if (context?.previousArchived !== undefined) {
        qc.setQueryData(queryKeys.conversationList(true), context.previousArchived);
      }
      showAlert('Could not delete conversation', 'Please try again.');
    },

    onSuccess: (_data, conversationId) => {
      // Refetch to sync with server (catches the idempotent-200 case too).
      // Prefix-based invalidation covers all conversationList variants.
      void qc.invalidateQueries({ queryKey: queryKeys.conversations });
      options?.onDeselect?.(conversationId);
    },
  });
}

// ─── Conversation-scoped messaging (Stage 2 inbox hooks) ─────────────────────

/**
 * Fetch the full cross-session message history for a conversation.
 *
 * Supports optional cursor-based pagination via `beforeTs` (ISO8601 timestamp
 * or message ID). Polls every 4 seconds while the component is mounted so new
 * inbound messages appear without a manual pull-to-refresh.
 *
 * GET /api/v1/conversations/{id}/messages?before=&limit=
 *
 * @param conversationId - Target conversation UUID.
 * @param beforeTs       - Optional cursor — fetch messages older than this value.
 */
export function useConversationMessages(conversationId: string, beforeTs?: string) {
  return useQuery({
    queryKey: queryKeys.messages(conversationId),
    queryFn: async (): Promise<MessageData[]> => {
      const params = new URLSearchParams();
      if (beforeTs !== undefined) params.set('before', beforeTs);
      const qs = params.toString() ? `?${params.toString()}` : '';
      const raw = await api<unknown[]>(`/conversations/${conversationId}/messages${qs}`);
      return transformKeys<MessageData[]>(raw);
    },
    enabled: !!conversationId,
    // Match the session-message polling cadence.
    refetchInterval: 4_000,
    // Stale immediately so we never serve a cached snapshot to a fresh mount.
    staleTime: 0,
  });
}

/**
 * Variables accepted by `useConversationSendMessage`.
 */
export interface SendConversationMessageVars {
  conversationId: string;
  /** Body text. May be empty when an attachment is present. */
  body: string;
  /** Optional — attach a file previously uploaded via /upload/presigned-url. */
  attachment?: {
    s3Key: string;
    filename: string;
    sizeBytes: number;
    contentType: string;
  };
}

/**
 * Post a new message to a conversation.
 *
 * Mirrors `useSessionSendMessage` — same attachment payload shape, same
 * invalidation pattern. Does NOT perform optimistic updates internally;
 * the caller manages local state for proper rollback (see SessionChat pattern).
 *
 * POST /api/v1/conversations/{id}/messages
 */
export function useConversationSendMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: SendConversationMessageVars): Promise<MessageData> => {
      const payload: Record<string, unknown> = { body: vars.body };
      if (vars.attachment !== undefined) {
        payload.attachment_s3_key = vars.attachment.s3Key;
        payload.attachment_filename = vars.attachment.filename;
        payload.attachment_size_bytes = vars.attachment.sizeBytes;
        payload.attachment_content_type = vars.attachment.contentType;
      }
      // HIPAA: body content is intentionally not logged anywhere in this call.
      const raw = await api<unknown>(`/conversations/${vars.conversationId}/messages`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      return transformKeys<MessageData>(raw);
    },
    onSuccess: (_data, variables) => {
      // Invalidate the per-conversation message list so the background poll
      // picks up the authoritative row from the server.
      void qc.invalidateQueries({
        queryKey: queryKeys.messages(variables.conversationId),
      });
      // Also invalidate the inbox list so last_message_preview / last_message_at
      // update without a manual refresh. Prefix-based — covers all variants.
      void qc.invalidateQueries({ queryKey: queryKeys.conversations });
    },
  });
}

/**
 * Pin or unpin a conversation thread.
 *
 * Optimistic update: flips `pinnedAt` on the cached row immediately, then
 * rolls back if the PATCH fails. Mirrors `useToggleSessionPin`.
 *
 * PATCH /api/v1/conversations/{id}/pin  body: { pinned: boolean }
 */
export function useToggleConversationPin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      conversationId,
      pinned,
    }: {
      conversationId: string;
      pinned: boolean;
    }): Promise<void> => {
      await api(`/conversations/${conversationId}/pin`, {
        method: 'PATCH',
        body: JSON.stringify({ pinned }),
      });
    },

    onMutate: async ({ conversationId, pinned }) => {
      await qc.cancelQueries({ queryKey: queryKeys.conversations });

      const previousNormal = qc.getQueryData<ConversationData[]>(
        queryKeys.conversationList(false),
      );
      const previousArchived = qc.getQueryData<ConversationData[]>(
        queryKeys.conversationList(true),
      );

      const applyPin = (old: ConversationData[] | undefined): ConversationData[] =>
        (old ?? []).map((c) =>
          c.id === conversationId
            ? { ...c, pinnedAt: pinned ? new Date().toISOString() : null }
            : c,
        );

      qc.setQueryData<ConversationData[]>(queryKeys.conversationList(false), applyPin);
      qc.setQueryData<ConversationData[]>(queryKeys.conversationList(true), applyPin);

      return { previousNormal, previousArchived };
    },

    onError: (
      _error: unknown,
      _variables: { conversationId: string; pinned: boolean },
      context:
        | {
            previousNormal?: ConversationData[];
            previousArchived?: ConversationData[];
          }
        | undefined,
    ) => {
      if (context?.previousNormal !== undefined) {
        qc.setQueryData(queryKeys.conversationList(false), context.previousNormal);
      }
      if (context?.previousArchived !== undefined) {
        qc.setQueryData(queryKeys.conversationList(true), context.previousArchived);
      }
      showAlert('Could not update pin', 'Please try again.');
    },

    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.conversations });
    },
  });
}

/**
 * Archive or unarchive a conversation thread.
 *
 * Optimistic update: flips `archivedAt` on the cached row immediately, then
 * rolls back if the PATCH fails. Mirrors `useToggleSessionArchive`.
 *
 * PATCH /api/v1/conversations/{id}/archive  body: { archived: boolean }
 */
export function useToggleConversationArchive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      conversationId,
      archived,
    }: {
      conversationId: string;
      archived: boolean;
    }): Promise<void> => {
      await api(`/conversations/${conversationId}/archive`, {
        method: 'PATCH',
        body: JSON.stringify({ archived }),
      });
    },

    onMutate: async ({ conversationId, archived }) => {
      await qc.cancelQueries({ queryKey: queryKeys.conversations });

      const previousNormal = qc.getQueryData<ConversationData[]>(
        queryKeys.conversationList(false),
      );
      const previousArchived = qc.getQueryData<ConversationData[]>(
        queryKeys.conversationList(true),
      );

      const applyArchive = (old: ConversationData[] | undefined): ConversationData[] =>
        (old ?? []).map((c) =>
          c.id === conversationId
            ? { ...c, archivedAt: archived ? new Date().toISOString() : null }
            : c,
        );

      qc.setQueryData<ConversationData[]>(queryKeys.conversationList(false), applyArchive);
      qc.setQueryData<ConversationData[]>(queryKeys.conversationList(true), applyArchive);

      return { previousNormal, previousArchived };
    },

    onError: (
      _error: unknown,
      _variables: { conversationId: string; archived: boolean },
      context:
        | {
            previousNormal?: ConversationData[];
            previousArchived?: ConversationData[];
          }
        | undefined,
    ) => {
      if (context?.previousNormal !== undefined) {
        qc.setQueryData(queryKeys.conversationList(false), context.previousNormal);
      }
      if (context?.previousArchived !== undefined) {
        qc.setQueryData(queryKeys.conversationList(true), context.previousArchived);
      }
      showAlert('Could not update archive', 'Please try again.');
    },

    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.conversations });
    },
  });
}

/**
 * Mark messages as read up to (and including) the given message ID.
 *
 * Fire-and-forget — the UI does not block on this. Silent failure mirrors
 * `useSessionMarkRead`: read receipts are best-effort side effects.
 *
 * On success, the conversations list is invalidated so the `unreadCount`
 * badge on the inbox row refreshes without a manual pull-to-refresh.
 *
 * POST /api/v1/conversations/{id}/messages/read  body: { up_to_message_id: uuid }
 */
export function useConversationMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      conversationId,
      upToMessageId,
    }: {
      conversationId: string;
      upToMessageId: string;
    }): Promise<void> => {
      await api(`/conversations/${conversationId}/messages/read`, {
        method: 'POST',
        body: JSON.stringify({ up_to_message_id: upToMessageId }),
      });
    },
    onSuccess: () => {
      // Refresh the inbox list so the unread badge reflects the new read position.
      void qc.invalidateQueries({ queryKey: queryKeys.conversations });
    },
    // Silent failure: read receipts are a best-effort side effect.
    onError: () => undefined,
  });
}

// ─── Session-scoped messaging (Phase 1 chat) ─────────────────────────────────

/**
 * Inline attachment payload returned with a session message. The
 * `downloadUrl` is a freshly-minted presigned GET URL — clients should not
 * cache it across requests since it expires after ~1 hour.
 */
export interface SessionMessageAttachment {
  id: string;
  filename: string;
  sizeBytes: number;
  contentType: string;
  s3Key: string;
  downloadUrl: string;
}

/**
 * Canonical shape of a single session message returned by
 * GET /sessions/{session_id}/messages.
 */
export interface SessionMessageData {
  id: string;
  /** UUID of the user who authored the message. */
  senderUserId: string;
  /** "chw" | "member" — used for bubble alignment without needing the full user record. */
  senderRole: 'chw' | 'member';
  body: string;
  /** "text" | "image" | "file" — set server-side based on attachment content type. */
  type?: string;
  createdAt: string;
  attachment?: SessionMessageAttachment | null;
}

/**
 * An optimistic or confirmed message used in the local UI list.
 * The `status` field is client-side only and must NEVER be sent to the API.
 */
export interface SessionMessageLocal extends SessionMessageData {
  /** undefined = confirmed from server; "sending" = optimistic; "failed" = send error */
  status?: 'sending' | 'failed';
}

export const sessionMessageQueryKeys = {
  messages: (sessionId: string) => ['sessions', sessionId, 'messages'] as const,
};

/**
 * Fetch messages for a session with cursor-based pagination.
 * Polls every 4 seconds while the component is mounted.
 *
 * @param sessionId - The session UUID.
 * @param afterId   - Optional last-seen message ID for cursor-based incremental fetch.
 */
export function useSessionMessages(sessionId: string, afterId?: string) {
  return useQuery({
    queryKey: sessionMessageQueryKeys.messages(sessionId),
    queryFn: async (): Promise<SessionMessageData[]> => {
      const qs = afterId ? `?after=${encodeURIComponent(afterId)}` : '';
      const raw = await api<unknown[]>(`/sessions/${sessionId}/messages${qs}`);
      return transformKeys<SessionMessageData[]>(raw);
    },
    enabled: !!sessionId,
    refetchInterval: 4_000,
    // Stale immediately so we never serve a cached snapshot to a fresh mount
    staleTime: 0,
  });
}

/**
 * Post a new text message to a session.
 * Does NOT perform optimistic updates internally — the caller manages local state
 * for proper rollback handling (see SessionChat component).
 *
 * Returns the created SessionMessageData row from the server.
 */
export interface SendSessionMessageVars {
  sessionId: string;
  /** Body text. May be empty when an attachment is present. */
  body: string;
  /** Optional — attach a file previously uploaded via /upload/presigned-url. */
  attachment?: {
    s3Key: string;
    filename: string;
    sizeBytes: number;
    contentType: string;
  };
}

export function useSessionSendMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: SendSessionMessageVars): Promise<SessionMessageData> => {
      const payload: Record<string, unknown> = { body: vars.body };
      if (vars.attachment) {
        payload.attachment_s3_key = vars.attachment.s3Key;
        payload.attachment_filename = vars.attachment.filename;
        payload.attachment_size_bytes = vars.attachment.sizeBytes;
        payload.attachment_content_type = vars.attachment.contentType;
      }
      const raw = await api<unknown>(`/sessions/${vars.sessionId}/messages`, {
        method: 'POST',
        // HIPAA: body content is intentionally not logged anywhere in this call.
        body: JSON.stringify(payload),
      });
      return transformKeys<SessionMessageData>(raw);
    },
    onSuccess: (_data, variables) => {
      // Invalidate so the background poll picks up the authoritative row
      void qc.invalidateQueries({
        queryKey: sessionMessageQueryKeys.messages(variables.sessionId),
      });
    },
  });
}

/**
 * Mark messages as read up to (and including) the given message ID.
 * Fire-and-forget — UI does not block on this.
 */
export function useSessionMarkRead() {
  return useMutation({
    mutationFn: async ({
      sessionId,
      upToMessageId,
    }: {
      sessionId: string;
      upToMessageId: string;
    }): Promise<void> => {
      await api(`/sessions/${sessionId}/messages/read`, {
        method: 'POST',
        body: JSON.stringify({ up_to_message_id: upToMessageId }),
      });
    },
    // Silent failure: read receipts are a best-effort side effect.
    onError: () => undefined,
  });
}

/**
 * Initiate a Vonage masked call bridging both parties for this session.
 *
 * TODO(backend): Backend agent is shipping either
 *   POST /sessions/{session_id}/call  (preferred)
 *   or POST /communication/call-bridge { session_id }
 * Wire is against /sessions/{session_id}/call. If the backend lands a different
 * path, swap the URL here — tracked in Compass issue #[call-bridge-contract].
 */
export function useStartCall() {
  return useMutation({
    mutationFn: async (sessionId: string): Promise<void> => {
      await api(`/sessions/${sessionId}/call`, { method: 'POST' });
    },
  });
}

// ─── Transcription Consent ───────────────────────────────────────────────────

export interface TranscriptionConsentPayload {
  /** Always "ai_transcription" for session transcription. */
  consentType: 'ai_transcription';
  /**
   * The user's typed name as a digital signature confirming consent.
   * Must be non-empty before the CHW initiates recording.
   */
  typedSignature: string;
  /**
   * If true, the calling CHW attests that the member gave verbal consent
   * on the call. Backend accepts this only when the caller is the session
   * CHW. Used for single-device / phone-call flows.
   */
  chwAttestation?: boolean;
}

/**
 * POST /sessions/{id}/consent
 *
 * Records AI-transcription consent for both parties before the CHW may start
 * the live transcript stream. Returns 200 on success with the created consent
 * record; throws ApiError on failure (400 duplicate, 403 forbidden, etc.).
 *
 * HIPAA: only the session ID and consent metadata are transmitted — no audio
 * or transcript content is included in this request.
 */
export function useGrantTranscriptionConsent(sessionId: string) {
  return useMutation({
    mutationFn: async (payload: TranscriptionConsentPayload): Promise<void> => {
      await api(`/sessions/${sessionId}/consent`, {
        method: 'POST',
        body: JSON.stringify({
          consent_type: payload.consentType,
          typed_signature: payload.typedSignature,
          chw_attestation: payload.chwAttestation ?? false,
        }),
      });
    },
  });
}

// ─── Two-party consent request hooks ─────────────────────────────────────────
//
// HIPAA + California §632 compliant in-app two-party consent flow.
//
// CHW side:
//   useCreateConsentRequest — POST /sessions/{id}/consent-requests
//   useCancelConsentRequest — POST /consent-requests/{id}/cancel
//   useConsentRequestStatus — GET  /consent-requests/{id} (polling)
//
// Member side:
//   usePendingConsents      — GET  /sessions/{id}/pending-consents (polling)
//   useApproveConsentRequest — POST /consent-requests/{id}/approve
//   useDenyConsentRequest   — POST /consent-requests/{id}/deny
//
// Polling interval: 3 000 ms.  This gives sub-5-second latency while keeping
// the request rate modest (20 req/min per active session per side).  The
// upgrade path to WebSocket push is documented below each polling hook.

/** The status values returned by the backend for a ConsentRequest row. */
export type ConsentRequestStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'cancelled'
  | 'expired';

/** Terminal statuses — polling should stop when the status reaches one of these. */
const CONSENT_TERMINAL_STATUSES = new Set<ConsentRequestStatus>([
  'approved',
  'denied',
  'cancelled',
  'expired',
]);

/**
 * Wire shape for a ConsentRequest row returned by the backend.
 * All fields are camelCase (auto-transformed by the api client).
 */
export interface ConsentRequestData {
  id: string;
  sessionId: string;
  chwId: string;
  memberId: string;
  consentType: string;
  status: ConsentRequestStatus;
  requestedAt: string;
  respondedAt: string | null;
  expiresAt: string;
}

/** Query-key namespace for consent-request data. */
export const consentRequestQueryKeys = {
  pendingConsents: (sessionId: string) =>
    ['sessions', sessionId, 'pending-consents'] as const,
  consentRequest: (requestId: string) =>
    ['consent-requests', requestId] as const,
};

/**
 * CHW mutation — create a pending ConsentRequest for the session.
 *
 * POST /api/v1/sessions/{sessionId}/consent-requests
 *
 * Returns the created ConsentRequestData row (status="pending").
 * Throws with HTTP 409 if a non-expired pending request already exists —
 * callers should surface this as "Request already in progress".
 *
 * HIPAA: no PHI is transmitted in this call — only the session ID and the
 * consent type ("ai_transcription").
 */
export function useCreateConsentRequest(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      consentType: 'ai_transcription' = 'ai_transcription',
    ): Promise<ConsentRequestData> => {
      const raw = await api<unknown>(
        `/sessions/${sessionId}/consent-requests`,
        {
          method: 'POST',
          body: JSON.stringify({ consent_type: consentType }),
        },
      );
      return transformKeys<ConsentRequestData>(raw);
    },
    onSuccess: (data) => {
      // Seed the individual request cache so CHW polling starts with a value.
      qc.setQueryData(
        consentRequestQueryKeys.consentRequest(data.id),
        data,
      );
    },
  });
}

/**
 * Member query — poll for pending consent requests on this session.
 *
 * GET /api/v1/sessions/{sessionId}/pending-consents
 *
 * Polls every 3 000 ms while:
 *   - the component is mounted
 *   - `opts.enabled` is true (callers pass `myRole === 'member' && session.status === 'in_progress'`)
 *
 * Returns an array of pending ConsentRequestData rows (normally 0 or 1 items).
 *
 * Upgrade path to WebSocket push: when APNs/FCM is live, the member side can
 * rely on a push notification instead of polling.  Swap `refetchInterval` for
 * an FCM-triggered `queryClient.invalidateQueries` call at that point.
 */
export function usePendingConsents(
  sessionId: string,
  opts: { enabled: boolean },
) {
  return useQuery({
    queryKey: consentRequestQueryKeys.pendingConsents(sessionId),
    queryFn: async (): Promise<ConsentRequestData[]> => {
      const raw = await api<unknown[]>(
        `/sessions/${sessionId}/pending-consents`,
      );
      return transformKeys<ConsentRequestData[]>(raw);
    },
    enabled: opts.enabled && sessionId.length > 0,
    refetchInterval: 3_000,
    staleTime: 0,
  });
}

/**
 * Member mutation — approve a pending consent request.
 *
 * POST /api/v1/consent-requests/{requestId}/approve
 *
 * ``typedSignature`` is the member's full name — stored on the resulting
 * MemberConsent row as the HIPAA-required individual authorization signature.
 *
 * On success the backend creates a MemberConsent row with the member's own
 * user ID (not the CHW's), satisfying California §632 two-party consent.
 */
export function useApproveConsentRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      requestId,
      typedSignature,
    }: {
      requestId: string;
      typedSignature: string;
    }): Promise<ConsentRequestData> => {
      const raw = await api<unknown>(
        `/consent-requests/${requestId}/approve`,
        {
          method: 'POST',
          body: JSON.stringify({ typed_signature: typedSignature }),
        },
      );
      return transformKeys<ConsentRequestData>(raw);
    },
    onSuccess: (data) => {
      // Update the cached status so the CHW polling sees "approved" immediately.
      qc.setQueryData(consentRequestQueryKeys.consentRequest(data.id), data);
    },
  });
}

/**
 * Member mutation — deny a pending consent request.
 *
 * POST /api/v1/consent-requests/{requestId}/deny
 *
 * Denial is final for this request — the CHW must create a new ConsentRequest
 * to ask again.  No MemberConsent row is created.
 */
export function useDenyConsentRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (requestId: string): Promise<ConsentRequestData> => {
      const raw = await api<unknown>(
        `/consent-requests/${requestId}/deny`,
        { method: 'POST' },
      );
      return transformKeys<ConsentRequestData>(raw);
    },
    onSuccess: (data) => {
      qc.setQueryData(consentRequestQueryKeys.consentRequest(data.id), data);
    },
  });
}

/**
 * CHW mutation — cancel an outstanding consent request.
 *
 * POST /api/v1/consent-requests/{requestId}/cancel
 *
 * Called when the CHW closes the "Waiting for member…" modal before the
 * member responds.  Prevents the member from seeing a stale approval modal
 * after the CHW has given up.
 */
export function useCancelConsentRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (requestId: string): Promise<ConsentRequestData> => {
      const raw = await api<unknown>(
        `/consent-requests/${requestId}/cancel`,
        { method: 'POST' },
      );
      return transformKeys<ConsentRequestData>(raw);
    },
    onSuccess: (data) => {
      qc.setQueryData(consentRequestQueryKeys.consentRequest(data.id), data);
    },
  });
}

/**
 * CHW query — poll for status updates on a specific consent request.
 *
 * GET /api/v1/consent-requests/{requestId}
 *
 * Polls every 3 000 ms while:
 *   - `opts.enabled` is true (callers pass `status === 'pending'`)
 *   - the request status has not reached a terminal value
 *
 * The `refetchInterval` callback stops polling automatically once the status
 * transitions to approved, denied, cancelled, or expired — eliminating the
 * need for callers to manually manage the polling lifecycle.
 *
 * Upgrade path to WebSocket push: replace `refetchInterval` with an
 * FCM-triggered invalidation when APNs/FCM push is deployed.
 */
export function useConsentRequestStatus(
  requestId: string,
  opts: { enabled: boolean },
) {
  return useQuery({
    queryKey: consentRequestQueryKeys.consentRequest(requestId),
    queryFn: async (): Promise<ConsentRequestData> => {
      const raw = await api<unknown>(`/consent-requests/${requestId}`);
      return transformKeys<ConsentRequestData>(raw);
    },
    enabled: opts.enabled && requestId.length > 0,
    refetchInterval: (query) => {
      const data = query.state.data as ConsentRequestData | undefined;
      if (data === undefined) return 3_000;
      return CONSENT_TERMINAL_STATUSES.has(data.status) ? false : 3_000;
    },
    staleTime: 0,
  });
}

// ─── Member Services Consent (T03) ───────────────────────────────────────────

/**
 * Union of the two values returned by GET /api/v1/member/services-consent.
 *
 * consent_to_services — member accepts CHW services (default state)
 * refuse_services     — member has refused; blocks call/message/session creation
 */
export type ServicesConsentValue = 'consent_to_services' | 'refuse_services';

/** Shape returned by GET /api/v1/member/services-consent (camelCase post-transform). */
export interface MemberServicesConsentData {
  value: ServicesConsentValue;
  /** ISO timestamp of the last flip, or null when never changed from default. */
  changedAt: string | null;
  /** User ID of whoever last recorded the change (member self or admin). */
  lastChangedBy: string | null;
}

/** Feature flag: set to false to skip the services-consent fetch entirely.
 *
 *  T03 added the endpoint (commit 20a0e23) but the DB migration may not be
 *  applied in prod during the rollout window. When false, the hook returns
 *  `null` data without hitting the network so the UI renders a neutral state
 *  instead of crashing. Flip to true once prod migration is confirmed live.
 */
const SERVICES_CONSENT_FEATURE_ENABLED = true;

/**
 * Fetch the authenticated member's own services-consent status.
 *
 * Endpoint: GET /api/v1/member/services-consent (no query params — the
 * backend resolves the record from the JWT, not a memberId param).
 *
 * Feature-flagged identically to the CHW-side hook: when
 * SERVICES_CONSENT_FEATURE_ENABLED is false, or the server returns a 5xx
 * (migration not yet applied), the hook resolves with null so the member-
 * facing UI renders a neutral/permissive state instead of crashing.
 *
 * Used by MemberMessagesScreen to gate the composer: if the value is
 * 'refuse_services', the composer is hidden and a status banner is shown.
 */
export function useOwnServicesConsent() {
  return useQuery({
    queryKey: ['member', 'own', 'services-consent'] as const,
    queryFn: async (): Promise<MemberServicesConsentData | null> => {
      if (!SERVICES_CONSENT_FEATURE_ENABLED) return null;
      try {
        const raw = await api<unknown>('/member/services-consent');
        return transformKeys<MemberServicesConsentData>(raw);
      } catch (err) {
        const isServerError =
          err instanceof Error &&
          'status' in err &&
          typeof (err as { status: unknown }).status === 'number' &&
          (err as { status: number }).status >= 500;
        if (isServerError) return null;
        throw err;
      }
    },
    enabled: SERVICES_CONSENT_FEATURE_ENABLED,
    staleTime: 30_000,
    retry: false,
  });
}

// ─── Member billing status (billable / non-billable) ───────────────────────────

/** Shape returned by GET/PATCH /api/v1/members/{id}/billing-status (camelCase). */
export interface MemberBillingStatusData {
  isBillable: boolean;
  /** ISO timestamp of the last flip, or null when never changed from default. */
  changedAt: string | null;
  /** User ID of the CHW/admin who last changed it, or null. */
  changedBy: string | null;
}

/**
 * Fetch a member's billable/non-billable status (CHW or admin view).
 *
 * Endpoint: GET /api/v1/members/{member_id}/billing-status. Empty memberId
 * disables the query.
 */
export function useMemberBillingStatus(memberId: string) {
  return useQuery({
    queryKey: ['member', memberId, 'billing-status'] as const,
    queryFn: async (): Promise<MemberBillingStatusData> => {
      const raw = await api<unknown>(`/members/${memberId}/billing-status`);
      return transformKeys<MemberBillingStatusData>(raw);
    },
    enabled: !!memberId,
    staleTime: 30_000,
  });
}

/**
 * Toggle a member's billable/non-billable status (CHW or admin only).
 *
 * Endpoint: PATCH /api/v1/members/{member_id}/billing-status { is_billable }.
 * Optimistically updates the cached billing-status on success.
 */
export function useUpdateMemberBillingStatus(memberId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (isBillable: boolean): Promise<MemberBillingStatusData> => {
      const raw = await api<unknown>(`/members/${memberId}/billing-status`, {
        method: 'PATCH',
        body: JSON.stringify({ is_billable: isBillable }),
      });
      return transformKeys<MemberBillingStatusData>(raw);
    },
    onSuccess: (data) => {
      qc.setQueryData(['member', memberId, 'billing-status'], data);
    },
  });
}

/** Shape returned by PATCH /chw/members/{id}/preferred-name (camelCase). */
export interface PreferredNameData {
  preferredName: string | null;
}

/**
 * Set a member's preferred name from the CHW Member Profile (CHW or admin).
 *
 * Endpoint: PATCH /api/v1/chw/members/{member_id}/preferred-name
 * { preferred_name }. A null/blank value clears it. Invalidates the CHW member
 * detail query so the demographics row refreshes.
 */
export function useUpdateMemberPreferredName(memberId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (preferredName: string | null): Promise<PreferredNameData> => {
      const raw = await api<unknown>(`/chw/members/${memberId}/preferred-name`, {
        method: 'PATCH',
        body: JSON.stringify({ preferred_name: preferredName }),
      });
      return transformKeys<PreferredNameData>(raw);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['chw', 'members', memberId, 'detail'] });
    },
  });
}

/** CHW-editable member demographics payload (PATCH /chw/members/{id}/demographics). */
export interface MemberDemographicsUpdate {
  firstName?: string;
  lastName?: string;
  preferredName?: string | null;
  dateOfBirth?: string | null; // ISO "YYYY-MM-DD"
  gender?: string | null;      // Male | Female | Other
  insurance?: string | null;
  mediCalId?: string | null;   // CIN 8 digits + 1 letter
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;       // 2-letter USPS
  zipCode?: string | null;
  phone?: string | null;
  primaryLanguage?: string | null;
}

/**
 * Edit a member's demographics from the CHW Member Profile pencil.
 *
 * PATCH /api/v1/chw/members/{member_id}/demographics. Only supplied fields
 * change. Backend validates CIN / gender / state and combines first+last into
 * the name. Invalidates the CHW member detail query so the card refreshes.
 */
export function useUpdateMemberDemographics(memberId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: MemberDemographicsUpdate): Promise<void> => {
      await api(`/chw/members/${memberId}/demographics`, {
        method: 'PATCH',
        body: JSON.stringify(toSnakeCase(payload)),
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['chw', 'members', memberId, 'detail'] });
    },
  });
}

/** Disposition + reason for closing a member. Slugs mirror the backend. */
export interface CloseMemberPayload {
  status:
    | 'closed_successful'
    | 'closed_unsuccessful'
    | 'declined';
  reason:
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
}

/**
 * Close a member's case from the CHW Member Profile.
 *
 * POST /api/v1/chw/members/{member_id}/close with { status, reason }. On success
 * invalidates the member-detail (badge + read-only CTAs refresh) and the roster.
 */
export function useCloseMember(memberId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: CloseMemberPayload): Promise<void> => {
      await api(`/chw/members/${memberId}/close`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['chw', 'members', memberId, 'detail'] });
      void qc.invalidateQueries({ queryKey: queryKeys.chwMembers });
    },
  });
}

/**
 * Reopen a previously-closed member. POST /api/v1/chw/members/{member_id}/reopen.
 * Clears the disposition server-side; invalidates the same queries as close.
 */
export function useReopenMember(memberId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<void> => {
      await api(`/chw/members/${memberId}/reopen`, { method: 'POST' });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['chw', 'members', memberId, 'detail'] });
      void qc.invalidateQueries({ queryKey: queryKeys.chwMembers });
    },
  });
}

/**
 * Edit a member's resource needs from the CHW Member Profile (Resource Needs
 * pencil). PATCH /api/v1/chw/members/{member_id}/resource-needs.
 *
 * `needs` is a selection-ordered list of resource categories ('housing' | 'transportation'
 * | 'food' | 'mental_health' | 'healthcare'). `levels` is a list of
 * `{ slug, level }` pairs — slugs are string values (immune to key-casing
 * transforms), matching the new API contract.
 * Invalidates the member-detail query so the card refreshes.
 */
export function useUpdateMemberResourceNeeds(memberId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      needs,
      levels,
    }: {
      needs: string[];
      levels: Array<{ slug: string; level: ResourceNeedLevel }>;
    }): Promise<void> => {
      await api(`/chw/members/${memberId}/resource-needs`, {
        method: 'PATCH',
        body: JSON.stringify({ needs, levels }),
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['chw', 'members', memberId, 'detail'] });
      // Saving needs runs the server-side reconcile (creates/abandons journeys),
      // so the journeys query — read by BOTH the Resource Needs card and the
      // Member Journey section — must refresh too, or the views show stale data.
      void qc.invalidateQueries({ queryKey: memberJourneysKey(memberId) });
      void qc.invalidateQueries({ queryKey: queryKeys.chwJourneys });
    },
  });
}

/**
 * Fetch the services-consent status for a given member from the CHW side.
 *
 * Endpoint: GET /api/v1/member/services-consent
 * (The spec targets the member's own consent endpoint; CHW reads it on behalf
 * of the selected member by passing the memberId as a query param.)
 *
 * Feature-flagged: when SERVICES_CONSENT_FEATURE_ENABLED is false, or when
 * the server returns 503 / 500 (migration not yet applied), the hook resolves
 * with null rather than throwing so callers render a neutral state.
 *
 * @param memberId — the member whose consent status to fetch. Empty string
 *   disables the query (callers guard on !!selectedSession.memberId).
 */
export function useMemberServicesConsent(memberId: string) {
  return useQuery({
    queryKey: ['member', memberId, 'services-consent'] as const,
    queryFn: async (): Promise<MemberServicesConsentData | null> => {
      if (!SERVICES_CONSENT_FEATURE_ENABLED) return null;
      try {
        const raw = await api<unknown>(`/member/services-consent?member_id=${memberId}`);
        return transformKeys<MemberServicesConsentData>(raw);
      } catch (err) {
        // Treat any 5xx as a soft rollout failure — return null so the UI
        // shows a neutral "consent status unavailable" state instead of
        // surfacing an error that would block the CHW's workflow.
        const isServerError =
          err instanceof Error &&
          'status' in err &&
          typeof (err as { status: unknown }).status === 'number' &&
          (err as { status: number }).status >= 500;
        if (isServerError) return null;
        throw err;
      }
    },
    enabled: SERVICES_CONSENT_FEATURE_ENABLED && memberId.length > 0,
    staleTime: 30_000,
    retry: false, // do not retry on server errors during rollout window
  });
}

/**
 * Update the authenticated member's own services-consent status.
 *
 * Endpoint: PATCH /api/v1/member/services-consent
 * Body: { value: ServicesConsentValue }
 *
 * On success invalidates both the member-own and any CHW-side reads of the
 * same member's consent so call/message gate UI refreshes across all screens
 * without a manual reload.
 *
 * The caller is responsible for showing the confirm modal before calling
 * mutateAsync with `refuse_services` — this hook does not enforce the UX gate.
 */
export function useUpdateServicesConsent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (value: ServicesConsentValue): Promise<MemberServicesConsentData> => {
      const raw = await api<unknown>('/member/services-consent', {
        method: 'PATCH',
        body: JSON.stringify({ value }),
      });
      return transformKeys<MemberServicesConsentData>(raw);
    },
    onSuccess: (_data, _value) => {
      // Invalidate the member-own consent query so the toggle reflects the new state.
      void qc.invalidateQueries({
        queryKey: ['member', 'own', 'services-consent'],
      });
      // Also invalidate any CHW-side reads (keyed by memberId) in case the CHW
      // is simultaneously viewing the member — the refusal banner updates without reload.
      void qc.invalidateQueries({
        predicate: (query) => {
          const key = query.queryKey;
          return (
            Array.isArray(key) &&
            key.length === 3 &&
            key[0] === 'member' &&
            key[2] === 'services-consent'
          );
        },
      });
    },
    onError: (_error: unknown) => {
      // Callers handle errors inline — no silent failures.
    },
  });
}

// ─── Insurance + CIN edit (T03) ──────────────────────────────────────────────

/**
 * Payload for PATCH /api/v1/member/profile/insurance-cin.
 *
 * Both fields are required; send the normalized forms (CIN uppercased).
 * The server validates CIN against `^\d{8}[A-Z]$` and returns 422 on mismatch.
 */
export interface UpdateInsuranceCinPayload {
  /** Insurance carrier name — must match one of the 6 curated carriers. */
  insuranceCompany: string;
  /** Medi-Cal ID in the format 8 digits + 1 uppercase letter, e.g. "12345678A". */
  mediCalId: string;
}

/**
 * Update the authenticated member's insurance provider and Medi-Cal CIN.
 *
 * Endpoint: PATCH /api/v1/member/profile/insurance-cin
 * Body: { insurance_company: string, medi_cal_id: string }
 *
 * On success invalidates the member profile query so the Demographics card
 * refreshes with the new values.
 *
 * The caller must validate CIN format (`^\d{8}[A-Z]$`, case-normalized) before
 * calling mutateAsync — do not ship an invalid PATCH body.
 */
export function useUpdateInsuranceCin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: UpdateInsuranceCinPayload): Promise<void> => {
      await api('/member/profile/insurance-cin', {
        method: 'PATCH',
        body: JSON.stringify({
          insurance_company: payload.insuranceCompany,
          medi_cal_id: payload.mediCalId,
        }),
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.memberProfile });
    },
    onError: (_error: unknown) => {
      // Callers handle errors inline — no silent failures.
    },
  });
}

// ─── CHW Intake Questionnaire ───────────────────────────────────────────────

export interface CHWIntakeState {
  // Section 1
  yearsExperience?: string;
  employmentStatus?: string;
  educationLevel?: string;
  primarySetting?: string;
  // Section 2
  caChwCertificate?: string;
  trainingPathway?: string;
  additionalCertification?: string;
  mediCalFamiliarity?: string;
  ehrExperience?: string;
  // Section 3
  primaryLanguage?: string;
  otherLanguageFluency?: string;
  additionalLanguage?: string;
  culturalCompetencyTraining?: string;
  livedExperience?: string;
  primaryLanguageOther?: string;
  additionalLanguageOther?: string;
  // Section 4
  primarySpecialization?: string;
  sdohExperience?: string;
  populationExperience?: string;
  motivationalInterviewing?: string;
  hedisExperience?: string;
  // Section 5
  preferredModality?: string;
  homeVisitComfort?: string;
  telehealthComfort?: string;
  transportation?: string;
  preferredCaseload?: string;
  // Section 6
  preferredSchedule?: string;
  preferredEmploymentType?: string;
  urgentOutreach?: string;
  // Metadata
  lastCompletedSection?: number;
  completedAt?: string | null;
}

export function useCHWIntake(enabled = true) {
  return useQuery({
    queryKey: ['chw', 'intake'],
    queryFn: async () => {
      const raw = await api<unknown>('/chw/intake');
      return transformKeys<CHWIntakeState>(raw);
    },
    enabled,
    staleTime: 30_000,
  });
}

/**
 * Server-managed fields on the intake row that the client must NEVER include
 * in a PATCH body. The backend's `IntakeUpdate` schema is `extra="forbid"`,
 * so sending these triggers a 422 "Extra inputs are not permitted" error.
 *
 * The bug: CHWIntakeScreen seeds `draft` from the GET /chw/intake response
 * (which DOES include `completedAt`), then on Submit pipes the entire draft
 * through this hook. We filter those keys out at the boundary so any future
 * caller is protected without having to remember the rule.
 */
const CHW_INTAKE_SERVER_MANAGED: ReadonlySet<keyof CHWIntakeState> = new Set([
  'completedAt',
]);

export function useUpdateCHWIntake() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Partial<CHWIntakeState>) => {
      const safe: Partial<CHWIntakeState> = {};
      for (const [k, v] of Object.entries(patch)) {
        if (!CHW_INTAKE_SERVER_MANAGED.has(k as keyof CHWIntakeState)) {
          (safe as Record<string, unknown>)[k] = v;
        }
      }
      const raw = await api<unknown>('/chw/intake', {
        method: 'PATCH',
        body: JSON.stringify(toSnakeCase(safe)),
      });
      return transformKeys<CHWIntakeState>(raw);
    },
    onSuccess: (data) => {
      qc.setQueryData(['chw', 'intake'], data);
    },
  });
}

export function useSubmitCHWIntake() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const raw = await api<unknown>('/chw/intake/submit', { method: 'POST' });
      return transformKeys<CHWIntakeState>(raw);
    },
    onSuccess: (data) => {
      qc.setQueryData(['chw', 'intake'], data);
    },
  });
}

// ─── Credentials ────────────────────────────────────────────────────────────

export interface CredentialValidation {
  id: string;
  chwId: string;
  programName: string;
  validationStatus: string;
  institutionConfirmed: boolean;
  createdAt: string;
  /** Path-only S3 key for the uploaded document, once the CHW has uploaded one. */
  documentS3Key?: string | null;
  /** ISO date string for credential expiry, if provided at upload time. */
  expiryDate?: string | null;
}

/**
 * Payload sent when submitting a new credential validation record.
 * Maps to the backend's CredentialValidationSubmit schema.
 */
export interface SubmitCredentialPayload {
  /** Issuing institution name (required by the backend). */
  institutionName: string;
  /** Optional contact e-mail for the institution. */
  institutionContactEmail?: string;
  /** Full programme / certificate name. */
  programName: string;
  /** Certificate or licence number (optional). */
  certificateNumber?: string;
  /** ISO date string for when the credential was awarded (optional). */
  graduationDate?: string;
}

/**
 * Payload for attaching a document S3 key and optional expiry date to an
 * existing credential validation record.
 *
 * TODO: Backend agent must add PATCH /credentials/validations/{id} that accepts
 * { document_s3_key, expiry_date } — tracked in Compass issue #[backend-patch-cred].
 */
export interface PatchCredentialDocumentPayload {
  documentS3Key: string;
  expiryDate?: string;
}

export function useCredentialValidations(enabled = true) {
  return useQuery({
    queryKey: ['credentials', 'validations'],
    queryFn: async () => {
      const raw = await api<unknown>('/credentials/validations');
      return transformKeys<CredentialValidation[]>(raw);
    },
    enabled,
    staleTime: 30_000,
  });
}

/**
 * Submit a new credential validation record to the backend.
 * On success, invalidates the validations list cache.
 */
export function useSubmitCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: SubmitCredentialPayload): Promise<CredentialValidation> => {
      const raw = await api<unknown>('/credentials/validate', {
        method: 'POST',
        body: JSON.stringify(toSnakeCase(data)),
      });
      return transformKeys<CredentialValidation>(raw);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['credentials', 'validations'] });
    },
  });
}

// ─── Account deletion ─────────────────────────────────────────────────────────

/**
 * Mutation that calls DELETE /auth/users/me.
 *
 * Password is optional — the backend treats JWT auth as sufficient for
 * the web Yes/No confirmation flow.  Legacy mobile callers that still
 * collect a password should pass it through and the backend will verify;
 * the Apple-policy-mandated password challenge can be reinstated by
 * flipping this back to required.
 *
 * The server responds 204 No Content on success. The caller is responsible
 * for clearing auth state and routing to the landing screen.
 *
 * Usage:
 *   const deleteAccount = useDeleteAccount();
 *   await deleteAccount.mutateAsync();                  // web Yes/No flow
 *   await deleteAccount.mutateAsync({ password: '…' }); // legacy mobile flow
 */
export function useDeleteAccount() {
  return useMutation({
    mutationFn: async (args?: { password?: string }): Promise<void> => {
      const body = args?.password ? { password: args.password } : {};
      await api<void>('/auth/users/me', {
        method: 'DELETE',
        body: JSON.stringify(body),
      });
    },
  });
}

// ─── Transcript Export ───────────────────────────────────────────────────────

/**
 * Download the session transcript as a PDF.
 *
 * Native path: streams the PDF to a temporary file via expo-file-system, then
 * opens the OS share sheet via expo-sharing.
 * Web path: creates a temporary Blob URL and triggers a browser <a download>.
 *
 * HIPAA: the PDF bytes are never logged. Only the session ID and HTTP status
 * are surfaced in error messages.
 *
 * Returns a cleanup function that revokes the blob URL on web.
 */
export function useTranscriptExport() {
  return useMutation({
    mutationFn: async (sessionId: string): Promise<void> => {
      // Use raw fetch (not `api()`) so we can read the binary response body.
      const storedTokens = await getTokens();

      const API_BASE =
        process.env.EXPO_PUBLIC_API_URL ?? 'https://api.joincompasschw.com/api/v1';

      const response = await fetch(
        `${API_BASE}/sessions/${sessionId}/transcript/export?format=pdf`,
        {
          method: 'GET',
          headers: {
            ...(storedTokens?.access
              ? { Authorization: `Bearer ${storedTokens.access}` }
              : {}),
          },
        },
      );

      if (!response.ok) {
        throw new Error(`Export failed (HTTP ${response.status})`);
      }

      if (Platform.OS === 'web') {
        // Web: create a temporary blob URL and trigger a browser <a download>.
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `session-${sessionId}-transcript.pdf`;
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        // Revoke after a short delay to let the download begin.
        setTimeout(() => URL.revokeObjectURL(url), 5_000);
      } else {
        // Native: write to the cache dir then open the OS share sheet.
        const arrayBuffer = await response.arrayBuffer();

        // Convert to base64 for FileSystem.writeAsStringAsync.
        const bytes = new Uint8Array(arrayBuffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
          binary += String.fromCharCode(bytes[i]!);
        }
        const base64 = btoa(binary);

        const fileUri = `${FileSystem.cacheDirectory ?? ''}session-${sessionId}-transcript.pdf`;
        await FileSystem.writeAsStringAsync(fileUri, base64, {
          encoding: FileSystem.EncodingType.Base64,
        });

        const canShare = await Sharing.isAvailableAsync();
        if (!canShare) {
          throw new Error('Sharing is not available on this device.');
        }
        await Sharing.shareAsync(fileUri, {
          mimeType: 'application/pdf',
          dialogTitle: 'Save or share session transcript',
          UTI: 'com.adobe.pdf',
        });
      }
    },
  });
}

// ─── Device audio capture consent ────────────────────────────────────────────
//
// `device_audio_capture` consent is per-CHW-relationship, not per-session.
// The member opts in once; the grant persists for all subsequent sessions with
// the same CHW.  These hooks are the frontend surface for that contract:
//
//   useMemberDeviceAudioConsent  — GET /sessions/{id}/consents, extracts the
//                                  CHW-relationship flag and the grant timestamp.
//   useGrantDeviceAudioConsent   — POST /sessions/{id}/consent with
//                                  consent_type="device_audio_capture".

/**
 * Wire shape for a single consent row returned by GET /sessions/{id}/consents.
 */
export interface SessionConsentRow {
  id: string;
  sessionId: string;
  memberId: string;
  /** e.g. "medical_billing" | "ai_transcription" | "device_audio_capture" */
  consentType: string;
  consentedAt: string;
  /**
   * True when the member has a device_audio_capture grant for ANY past session
   * with this session's CHW.  The backend computes this cross-session lookup
   * so the frontend can skip the opt-in modal without extra round trips.
   */
  chwAudioConsentActive: boolean;
}

/** Query-key namespace for session-level consent data. */
export const sessionConsentQueryKeys = {
  consents: (sessionId: string) =>
    ['sessions', sessionId, 'consents'] as const,
};

/**
 * Query hook — fetch all consent records for a session, polling every
 * 10 seconds while the session is in progress.
 *
 * GET /api/v1/sessions/{sessionId}/consents
 *
 * The primary use case is checking `chwAudioConsentActive` on any returned row
 * (or deriving it from an empty list — the backend always computes it regardless
 * of whether this specific session has a device_audio_capture row).
 *
 * Because the endpoint includes `chw_audio_consent_active` on every row but
 * may return an empty list for sessions where no consent has been recorded yet,
 * this hook also exposes a `chwAudioConsentActive` boolean derived as:
 *   - true  if any returned row has `chwAudioConsentActive === true`
 *   - false otherwise (empty list or no row with the flag set)
 *
 * HIPAA: typed_signature, ip_address, and user_agent are intentionally excluded
 * by the backend — only non-PHI metadata is transmitted.
 *
 * @param sessionId  - UUID string of the active session.
 * @param chwId      - UUID string of the CHW (used only for query-key namespacing;
 *                     the backend derives the CHW from the session row).
 * @param opts.enabled  - Pass false to suspend polling (e.g. session not in_progress).
 */
export function useMemberDeviceAudioConsent(
  sessionId: string,
  chwId: string,
  opts: { enabled: boolean },
) {
  const query = useQuery({
    queryKey: [...sessionConsentQueryKeys.consents(sessionId), chwId],
    queryFn: async (): Promise<SessionConsentRow[]> => {
      const raw = await api<unknown[]>(`/sessions/${sessionId}/consents`);
      return transformKeys<SessionConsentRow[]>(raw);
    },
    enabled: opts.enabled && sessionId.length > 0,
    // Poll every 10 s while the session is active so that a freshly granted
    // consent (from a previous session with the same CHW) is detected quickly.
    // Once chwAudioConsentActive is true there is no need to keep polling —
    // callers should disable the query after the first successful grant.
    refetchInterval: 10_000,
    staleTime: 5_000,
  });

  // Derive the cross-session boolean from the returned rows.
  const chwAudioConsentActive: boolean =
    (query.data ?? []).some((row) => row.chwAudioConsentActive);

  return { ...query, chwAudioConsentActive };
}

/**
 * Mutation hook — POST device_audio_capture consent for a session.
 *
 * POST /api/v1/sessions/{sessionId}/consent
 *   { consent_type: "device_audio_capture", typed_signature: <memberName> }
 *
 * Called when the member taps "Yes, share my device's audio" in the
 * MemberDeviceAudioConsentModal.  On success the consent row is persisted and
 * the session consents cache is invalidated so polling picks up the change
 * immediately.
 *
 * HIPAA: typed_signature is the member's name (non-PHI metadata used as the
 * HIPAA "individual authorization" signature).  No audio or transcript content
 * is transmitted in this call.
 *
 * @param sessionId - UUID string of the active session.
 */
export function useGrantDeviceAudioConsent(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (typedSignature: string): Promise<void> => {
      await api(`/sessions/${sessionId}/consent`, {
        method: 'POST',
        body: JSON.stringify({
          consent_type: 'device_audio_capture',
          typed_signature: typedSignature,
        }),
      });
    },
    onSuccess: () => {
      // Invalidate the consents cache so the membership polling immediately
      // reflects the new grant — prevents the modal from re-showing.
      void qc.invalidateQueries({
        queryKey: sessionConsentQueryKeys.consents(sessionId),
      });
    },
  });
}

// ─── Journeys ────────────────────────────────────────────────────────────────

/**
 * A single step within a JourneyTemplate (camelCase mirror of JourneyStepResponse).
 */
export interface JourneyStepResponse {
  id: string;
  templateId: string;
  order: number;
  name: string;
  description: string;
  pointsOnCompletion: number;
  requiredDocuments: string[];
  createdAt: string;
}

/** Template metadata returned inside MemberJourneyResponse. */
export interface JourneyTemplateResponse {
  id: string;
  slug: string;
  name: string;
  category: string;
  icon: string;
  isActive: boolean;
  steps: JourneyStepResponse[];
  createdAt: string;
}

/**
 * Per-member per-step state merged with template step fields.
 * Mirrors backend MemberJourneyStepResponse (snake_case → camelCase).
 */
export interface MemberJourneyStepResponse {
  id: string;
  memberJourneyId: string;
  templateStepId: string;
  stepOrder: number;
  stepName: string;
  stepDescription: string;
  pointsOnCompletion: number;
  requiredDocuments: string[];
  /** "upcoming" | "in_progress" | "completed" | "missed" */
  status: 'upcoming' | 'in_progress' | 'completed' | 'missed';
  startedAt: string | null;
  completedAt: string | null;
  dueDate: string | null;
  pointsAwarded: number;
  createdAt: string;
}

/**
 * Full member-journey view returned by GET /chw/journeys.
 *
 * Mirrors backend MemberJourneyResponse (snake_case → camelCase).
 * progressPercent is computed server-side: completed_steps / total_steps * 100.
 */
export interface MemberJourneyResponse {
  id: string;
  memberId: string;
  chwId: string;
  template: JourneyTemplateResponse;
  steps: MemberJourneyStepResponse[];
  /** "active" | "paused" | "completed" | "abandoned" */
  status: 'active' | 'paused' | 'completed' | 'abandoned';
  progressPercent: number;
  currentStep: MemberJourneyStepResponse | null;
  wellnessPointsEarned: number;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  /** Present on the CHW caseload list (GET /chw/journeys) — joined member name. */
  memberName?: string;
  /** Present on the CHW caseload list — current step name (lightweight, no full step state). */
  currentStepName?: string | null;
  /** CHW-assigned priority for custom journeys. Null for canonical journeys. */
  priorityLevel?: 'low' | 'medium' | 'high' | null;
}

/** Raw flat item returned by GET /chw/journeys (lightweight, no step-state detail). */
interface ChwJourneyApiItem {
  id: string;
  memberId: string;
  memberName: string;
  templateName: string;
  templateSlug: string;
  templateIcon: string;
  status: 'active' | 'paused' | 'completed' | 'abandoned';
  progressPercent: number;
  currentStepName: string | null;
  wellnessPointsEarned: number;
  startedAt: string;
  completedAt: string | null;
}

/**
 * Fetch all member journeys assigned to the authenticated CHW.
 *
 * GET /chw/journeys — returns MemberJourneyResponse[].
 * Stale after 60 s; journey progress changes slowly between CHW interactions.
 */
export function useChwJourneys() {
  return useQuery({
    queryKey: queryKeys.chwJourneys,
    queryFn: async (): Promise<MemberJourneyResponse[]> => {
      const raw = await api<unknown[]>('/chw/journeys');
      const items = transformKeys<ChwJourneyApiItem[]>(raw);
      // GET /chw/journeys returns a LIGHTWEIGHT flat item (member_name,
      // template_name, current_step_name; NO nested template object or steps
      // array). Adapt it to the MemberJourneyResponse shape the Journeys screen
      // renders so field access (template.name, steps.map) never crashes.
      return items.map((it): MemberJourneyResponse => ({
        id: it.id,
        memberId: it.memberId,
        memberName: it.memberName,
        chwId: '',
        template: {
          name: it.templateName,
          slug: it.templateSlug,
        } as unknown as JourneyTemplateResponse,
        steps: [],
        status: it.status,
        progressPercent: it.progressPercent,
        currentStep: null,
        currentStepName: it.currentStepName,
        wellnessPointsEarned: it.wellnessPointsEarned,
        startedAt: it.startedAt,
        completedAt: it.completedAt,
        createdAt: it.startedAt,
      }));
    },
    staleTime: 60_000,
  });
}

/** Query key for GET /journeys/{journeyId} — full step detail for one journey. */
export const chwJourneyDetailKey = (journeyId: string) =>
  ['chw', 'journeys', journeyId] as const;

/**
 * Fetch full step-state detail for a single journey on the CHW caseload.
 *
 * GET /journeys/{journeyId} — returns a full MemberJourneyResponse (with the
 * ordered `steps` array and `currentStep`). Backs the expandable Journeys card:
 * only fetched when `enabled` is true (i.e. the card has been expanded), so the
 * list view stays lightweight.
 */
export function useChwJourneyDetail(journeyId: string, enabled: boolean) {
  return useQuery({
    queryKey: chwJourneyDetailKey(journeyId),
    enabled,
    queryFn: async (): Promise<MemberJourneyResponse> => {
      const raw = await api<unknown>(`/journeys/${journeyId}`);
      return transformKeys<MemberJourneyResponse>(raw);
    },
    staleTime: 30_000,
  });
}

/** Body for PATCH /journeys/{journeyId}/steps/{stepId}. */
export interface UpdateJourneyStepPayload {
  journeyId: string;
  stepId: string;
  status: 'in_progress' | 'completed' | 'missed';
  notes?: string;
}

/**
 * Mark a journey step in_progress / completed / missed.
 *
 * PATCH /journeys/{journeyId}/steps/{stepId}. When status='completed' the backend
 * awards the step's points_on_completion, writes a wellness-points ledger row, and
 * advances the journey to the next step. This is the "reward this step" action on
 * the expandable Journeys card. Returns the refreshed MemberJourneyResponse.
 *
 * Invalidates the caseload list, this journey's detail query, and the member's
 * rewards balance so the points update everywhere without a reload.
 */
export function useUpdateJourneyStep() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      payload: UpdateJourneyStepPayload,
    ): Promise<MemberJourneyResponse> => {
      const { journeyId, stepId, status, notes } = payload;
      const raw = await api<unknown>(`/journeys/${journeyId}/steps/${stepId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status, ...(notes != null ? { notes } : {}) }),
      });
      return transformKeys<MemberJourneyResponse>(raw);
    },
    onSuccess: (updated) => {
      void qc.invalidateQueries({ queryKey: queryKeys.chwJourneys });
      void qc.invalidateQueries({ queryKey: chwJourneyDetailKey(updated.id) });
      void qc.invalidateQueries({ queryKey: memberRewardsBalanceKey(updated.memberId) });
      // Also refresh the member-scoped journeys list so the member's own
      // MemberJourney/Home progress updates immediately (matches the sibling
      // useUpdateJourneyStepStatus which keeps all three slices consistent).
      void qc.invalidateQueries({ queryKey: memberJourneysKey(updated.memberId) });
    },
  });
}

/** Body for PATCH /journeys/{journeyId}/steps/{stepId} — member-journey node editor. */
export interface UpdateStepStatusPayload {
  journeyId: string;
  stepId: string;
  status: 'upcoming' | 'in_progress' | 'completed' | 'missed';
  notes?: string;
}

/**
 * PATCH a step's status for a specific member's journey, with optimistic update.
 *
 * Differs from `useUpdateJourneyStep` in two ways:
 * 1. Accepts `memberId` to scope `memberJourneysKey` invalidation (which the
 *    CHW-facing hook omits).
 * 2. Applies an optimistic cache update so the Node Editor UI reflects the new
 *    status immediately, with rollback on error.
 *
 * On success invalidates chwJourneyDetailKey, memberJourneysKey, and
 * memberRewardsBalanceKey so all three cache slices stay consistent.
 */
export function useUpdateJourneyStepStatus(memberId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: UpdateStepStatusPayload): Promise<MemberJourneyResponse> => {
      const { journeyId, stepId, status, notes } = payload;
      const raw = await api<unknown>(`/journeys/${journeyId}/steps/${stepId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status, ...(notes != null ? { notes } : {}) }),
      });
      return transformKeys<MemberJourneyResponse>(raw);
    },
    onMutate: async (payload) => {
      // Cancel in-flight fetches for this key so they don't overwrite our optimistic update.
      await qc.cancelQueries({ queryKey: memberJourneysKey(memberId) });
      // Snapshot the current value for rollback.
      const previous = qc.getQueryData(memberJourneysKey(memberId));
      // Apply optimistic update: patch the matching step's status in the cache.
      qc.setQueryData(
        memberJourneysKey(memberId),
        (old: MemberJourneyResponse[] | undefined) => {
          if (old == null) return old;
          return old.map((journey) => {
            if (journey.id !== payload.journeyId) return journey;
            return {
              ...journey,
              steps: journey.steps.map((step) => {
                if (step.templateStepId !== payload.stepId) return step;
                return { ...step, status: payload.status };
              }),
            };
          });
        },
      );
      return { previous };
    },
    onError: (_err, _payload, context) => {
      // Rollback the optimistic update on mutation failure.
      if (context?.previous !== undefined) {
        qc.setQueryData(memberJourneysKey(memberId), context.previous);
      }
    },
    onSuccess: (updated) => {
      void qc.invalidateQueries({ queryKey: chwJourneyDetailKey(updated.id) });
      void qc.invalidateQueries({ queryKey: memberJourneysKey(memberId) });
      void qc.invalidateQueries({ queryKey: memberRewardsBalanceKey(memberId) });
    },
  });
}

/**
 * CHW members roster from GET /chw/members.
 *
 * Returns all members the authenticated CHW has a relationship with (session or
 * accepted ServiceRequest), ordered by last_contact_at descending. Stale time
 * is 2 minutes — the roster changes at session/request granularity, not sub-minute.
 */
export function useChwMembers() {
  return useQuery({
    queryKey: queryKeys.chwMembers,
    queryFn: async (): Promise<MembersRosterItem[]> => {
      const raw = await api<unknown[]>('/chw/members');
      return transformKeys<MembersRosterItem[]>(raw);
    },
    staleTime: 120_000,
  });
}

/** Payload for POST /chw/members — a CHW onboarding a brand-new member.
 *
 * Mirrors the member self-signup field set so the CHW-created member is
 * immediately as complete as a self-registered one (Pear/Medi-Cal-billing
 * ready). The backend reuses the same boundary validator as /auth/register.
 */
export interface CreateChwMemberPayload {
  /** Member's full name — must include first AND last (backend enforces ≥2 tokens). */
  name: string;
  /** Member's login email. Duplicate → 400. */
  email: string;
  /** Optional contact phone (normalized to E.164 server-side). */
  phone?: string;
  /** Temporary password the CHW shares with the member (min 8 chars). */
  tempPassword: string;
  /** Date of birth, ISO YYYY-MM-DD (Pear-required). */
  dateOfBirth: string;
  /** Sex — Pear CreateMember enum value (Pear-required). */
  gender: 'Male' | 'Female' | 'Other';
  /** Curated Medi-Cal carrier display label (Pear-required). */
  insuranceCompany: string;
  /** CIN / Medi-Cal member ID — normalized + validated server-side (Pear-required). */
  mediCalId: string;
  /** Street address line 1 (optional — completable before first Pear sync). */
  addressLine1?: string;
  /** Address line 2 — apt/suite/unit (optional). */
  addressLine2?: string;
  /** City (optional). */
  city?: string;
  /** 2-letter USPS state code (optional; format-validated server-side). */
  state?: string;
  /** Member ZIP code (Pear-required). */
  zipCode: string;
}

/** Response for POST /chw/members — the freshly-created member. */
export interface CreatedChwMember {
  id: string;
  name: string;
  email: string;
}

/**
 * CHW mutation — onboard a brand-new member account wired to this CHW.
 *
 * POST /api/v1/chw/members. The backend creates the member User + MemberProfile,
 * establishes the CHW↔member care relationship (matched ServiceRequest +
 * Conversation) so messaging / scheduling / journeys work immediately, and
 * returns the created member. On success we invalidate the roster so the new
 * member appears without a manual refresh.
 *
 * Login model: the CHW supplies a temporary password and shares it with the
 * member out-of-band; the member logs in via the normal flow and changes it
 * later. Duplicate email surfaces as a 400 ApiError (handled by the caller).
 */
export function useCreateChwMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: CreateChwMemberPayload): Promise<CreatedChwMember> => {
      const raw = await api<unknown>('/chw/members', {
        method: 'POST',
        body: JSON.stringify({
          name: payload.name,
          email: payload.email,
          phone: payload.phone ?? null,
          temp_password: payload.tempPassword,
          date_of_birth: payload.dateOfBirth,
          gender: payload.gender,
          insurance_company: payload.insuranceCompany,
          medi_cal_id: payload.mediCalId,
          address_line1: payload.addressLine1 ?? null,
          address_line2: payload.addressLine2 ?? null,
          city: payload.city ?? null,
          state: payload.state ?? null,
          zip_code: payload.zipCode,
        }),
      });
      return transformKeys<CreatedChwMember>(raw);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.chwMembers });
      void qc.invalidateQueries({ queryKey: queryKeys.conversations });
    },
    // Intentionally no onError alert here — the AddMemberModal renders inline
    // validation (e.g. duplicate-email 400) next to the form instead.
  });
}

/**
 * CHW Resource-folder search.
 *
 * GET /resources/search?category=&q= — returns up to 50 active resources
 * ranked by full-text relevance + category exact match.
 *
 * Caches per (category, query) tuple; stale after 5 min since the catalog
 * changes infrequently.
 */
export interface ChwResourceItem {
  id: string;
  name: string;
  description: string;
  category:
    | 'housing'
    | 'food'
    | 'mental_health'
    | 'rehab'
    | 'healthcare'
    | 'legal'
    | 'transportation'
    | 'other';
  url: string | null;
  phone: string | null;
  address: string | null;
  zipCode: string | null;
  hours: string | null;
  eligibility: string | null;
  languages: string[];
  status: 'active' | 'inactive';
  createdAt: string;
}

export function useChwResources(params: { category?: string; q?: string } = {}) {
  const { category, q } = params;
  const search = new URLSearchParams();
  if (category && category !== 'all') search.set('category', category);
  if (q) search.set('q', q);
  const qs = search.toString();
  const url = `/resources/search${qs ? `?${qs}` : ''}`;

  return useQuery({
    queryKey: queryKeys.chwResources(category, q),
    queryFn: async (): Promise<ChwResourceItem[]> => {
      const raw = await api<unknown[]>(url);
      return transformKeys<ChwResourceItem[]>(raw);
    },
    staleTime: 300_000,
  });
}

// ─── Journey templates + create-member-journey ───────────────────────────────

/** Query key for GET /journeys/templates. */
export const journeyTemplatesKey = ['journeys', 'templates'] as const;

/**
 * Fetch all active journey templates.
 *
 * GET /api/v1/journeys/templates — returns JourneyTemplateResponse[].
 * Available to any authenticated user (CHW or member). Stale after 10 min;
 * the template catalog changes rarely.
 */
export function useJourneyTemplates() {
  return useQuery({
    queryKey: journeyTemplatesKey,
    queryFn: async (): Promise<JourneyTemplateResponse[]> => {
      const raw = await api<unknown[]>('/journeys/templates');
      return transformKeys<JourneyTemplateResponse[]>(raw);
    },
    staleTime: 600_000, // 10 min — template catalog is slow-moving
  });
}

/** Input shape for POST /members/{member_id}/journeys. */
export interface CreateMemberJourneyPayload {
  memberId: string;
  templateSlug: string;
}

/**
 * CHW mutation — start a new journey for a member.
 *
 * POST /api/v1/members/{member_id}/journeys
 * Body: { member_id, template_slug }
 *
 * Backend guards:
 *   - 403 if the CHW has no active relationship with the member.
 *   - 409 if the member already has an active journey for this template.
 *   - 404 if the template_slug does not exist or is inactive.
 *
 * On success, invalidates the member journeys query so the Active Journeys
 * list and Roadmap in CHWMemberProfileScreen refresh immediately.
 *
 * @param memberId — The member's User.id. Used to scope the cache invalidation.
 */
export function useCreateMemberJourney(memberId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: CreateMemberJourneyPayload): Promise<MemberJourneyResponse> => {
      const raw = await api<unknown>(`/members/${payload.memberId}/journeys`, {
        method: 'POST',
        body: JSON.stringify({
          member_id: payload.memberId,
          template_slug: payload.templateSlug,
        }),
      });
      return transformKeys<MemberJourneyResponse>(raw);
    },
    onSuccess: () => {
      // Invalidate the member journey list so Active Journeys + Roadmap refresh.
      void qc.invalidateQueries({ queryKey: memberJourneysKey(memberId) });
      // Also refresh the CHW caseload Journeys page (GET /chw/journeys) so a
      // newly-assigned journey shows up there without a hard reload.
      void qc.invalidateQueries({ queryKey: queryKeys.chwJourneys });
    },
    onError: (_error: unknown) => {
      // Callers handle errors inline — no silent failures.
    },
  });
}

/**
 * Create a CHW-authored custom journey (3 blank nodes worth 10/5/5 points).
 * POST /api/v1/journeys/custom { member_id, title }.
 */
export function useCreateCustomJourney(memberId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: string | { title: string; priorityLevel?: ResourceNeedLevel },
    ): Promise<MemberJourneyResponse> => {
      // Back-compat: callers may pass a bare title string or { title, priorityLevel }.
      const title = typeof input === 'string' ? input : input.title;
      const priorityLevel = typeof input === 'string' ? undefined : input.priorityLevel;
      const raw = await api<unknown>('/journeys/custom', {
        method: 'POST',
        body: JSON.stringify({
          member_id: memberId,
          title,
          ...(priorityLevel ? { priority_level: priorityLevel } : {}),
        }),
      });
      return transformKeys<MemberJourneyResponse>(raw);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: memberJourneysKey(memberId) });
      void qc.invalidateQueries({ queryKey: queryKeys.chwJourneys });
    },
  });
}

/**
 * Update a custom journey's CHW-assigned priority level.
 * PATCH /api/v1/journeys/{journeyId}/priority { priority_level }.
 */
export function useUpdateJourneyPriority(memberId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      journeyId,
      priorityLevel,
    }: {
      journeyId: string;
      priorityLevel: ResourceNeedLevel;
    }): Promise<MemberJourneyResponse> => {
      const raw = await api<unknown>(`/journeys/${journeyId}/priority`, {
        method: 'PATCH',
        body: JSON.stringify({ priority_level: priorityLevel }),
      });
      return transformKeys<MemberJourneyResponse>(raw);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: memberJourneysKey(memberId) });
      void qc.invalidateQueries({ queryKey: queryKeys.chwJourneys });
    },
  });
}

/**
 * Remove (abandon) a journey owned by the CHW — custom OR canonical.
 * DELETE /api/v1/journeys/{journeyId}. For a canonical journey the backend also
 * drops the matching resource need, so the member-detail query is invalidated
 * too (its resource_needs change).
 */
export function useRemoveJourney(memberId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (journeyId: string): Promise<void> => {
      await api(`/journeys/${journeyId}`, { method: 'DELETE' });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: memberJourneysKey(memberId) });
      void qc.invalidateQueries({ queryKey: queryKeys.chwJourneys });
      void qc.invalidateQueries({ queryKey: ['chw', 'members', memberId, 'detail'] });
    },
  });
}

/**
 * Add a node to a custom journey (5 pts; 10 if first).
 * POST /api/v1/journeys/{journeyId}/nodes { name?, description? }.
 */
export function useAddJourneyNode(memberId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      journeyId: string;
      name?: string;
      description?: string;
      /** When provided, inserts the node relative to an existing step rather than appending. */
      insertOptions?: { position: 'before' | 'after'; relativeToStepId: string };
    }): Promise<MemberJourneyResponse> => {
      const body: Record<string, unknown> = {
        name: vars.name ?? null,
        description: vars.description ?? null,
      };
      if (vars.insertOptions != null) {
        body.position = vars.insertOptions.position;
        body.relative_to_step_id = vars.insertOptions.relativeToStepId;
      }
      const raw = await api<unknown>(`/journeys/${vars.journeyId}/nodes`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return transformKeys<MemberJourneyResponse>(raw);
    },
    onSuccess: (_data, vars) => {
      // Invalidate BOTH the member journeys list and this journey's detail slice
      // so an added node shows immediately in the expandable Journeys card too
      // (matches useUpdateJourneyNode / useDeleteJourneyNode).
      void qc.invalidateQueries({ queryKey: memberJourneysKey(memberId) });
      void qc.invalidateQueries({ queryKey: chwJourneyDetailKey(vars.journeyId) });
    },
  });
}

/**
 * Edit a custom journey node's name/description.
 * PATCH /api/v1/journeys/{journeyId}/nodes/{stepId} { name?, description? }.
 */
export function useUpdateJourneyNode(memberId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      journeyId: string;
      stepId: string;
      name?: string;
      description?: string;
    }): Promise<MemberJourneyResponse> => {
      const body: Record<string, unknown> = {};
      if (vars.name !== undefined) body.name = vars.name;
      if (vars.description !== undefined) body.description = vars.description;
      const raw = await api<unknown>(`/journeys/${vars.journeyId}/nodes/${vars.stepId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      return transformKeys<MemberJourneyResponse>(raw);
    },
    onSuccess: (_data, vars) => {
      // Invalidate BOTH the journeys list and the journey-detail slice so an
      // edited step name/description refreshes immediately everywhere it's
      // shown (matches useUpdateJourneyStepStatus / useDeleteJourneyNode).
      void qc.invalidateQueries({ queryKey: memberJourneysKey(memberId) });
      void qc.invalidateQueries({ queryKey: chwJourneyDetailKey(vars.journeyId) });
    },
  });
}

/** Input shape for DELETE /api/v1/journeys/{member_journey_id}/nodes/{step_id}. */
export interface DeleteJourneyNodePayload {
  /** The member journey to remove the node from. */
  journeyId: string;
  /** The templateStepId of the node being removed. */
  stepId: string;
}

/**
 * Remove a custom journey node (step).
 *
 * DELETE /api/v1/journeys/{member_journey_id}/nodes/{step_id}
 *
 * Backend reorders remaining nodes and reverses any points awarded when the
 * step was completed. Returns the refreshed MemberJourneyResponse (or 204).
 *
 * On success invalidates:
 *   - chwJourneyDetailKey  — journey-detail cache slice
 *   - memberJourneysKey    — member journeys list / roadmap
 *   - memberRewardsBalanceKey — points balance (may have reversed)
 *
 * @param memberId — Scopes cache invalidation to this member.
 */
export function useDeleteJourneyNode(memberId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: DeleteJourneyNodePayload): Promise<void> => {
      await api<unknown>(`/journeys/${payload.journeyId}/nodes/${payload.stepId}`, {
        method: 'DELETE',
      });
    },
    onSuccess: (_data, payload) => {
      void qc.invalidateQueries({ queryKey: chwJourneyDetailKey(payload.journeyId) });
      void qc.invalidateQueries({ queryKey: memberJourneysKey(memberId) });
      void qc.invalidateQueries({ queryKey: memberRewardsBalanceKey(memberId) });
    },
    onError: (_error: unknown) => {
      // Callers handle errors inline — no silent failures.
    },
  });
}

// ─── Member-facing rewards (new /rewards backend) ────────────────────────────

/**
 * Catalog item returned by GET /rewards/catalog.
 * Mirrors backend RewardCatalogItemResponse (snake_case → camelCase).
 */
export interface RewardCatalogItem {
  id: string;
  sku: string;
  name: string;
  description: string;
  imageEmoji: string;
  costPoints: number;
  fulfillmentType: string;
  /** null = unlimited stock */
  inventoryRemaining: number | null;
  isActive: boolean;
  createdAt: string;
}

/**
 * Wellness-points balance summary returned by
 * GET /members/{member_id}/rewards/balance.
 * Mirrors backend WellnessPointsBalanceResponse.
 */
export interface WellnessPointsBalance {
  memberId: string;
  currentBalance: number;
  earnedLifetime: number;
  redeemedLifetime: number;
  nextUnlockItem: RewardCatalogItem | null;
  pointsToNext: number;
}

/**
 * A single redemption record returned by
 * GET /members/{member_id}/rewards/redemptions.
 * Mirrors backend RewardRedemptionResponse (snake_case → camelCase).
 */
export interface RewardRedemption {
  id: string;
  memberId: string;
  catalogItemId: string;
  costPointsAtRedemption: number;
  /** "pending" | "fulfilled" | "cancelled" | "failed" */
  status: string;
  fulfillmentReference: string | null;
  requestedAt: string;
  fulfilledAt: string | null;
  failureReason: string | null;
  createdAt: string;
}

// ─── Member journey response (member-facing, identical shape to CHW-facing) ──

// Re-exports for member screens — the types are already defined above the CHW
// hooks section; no duplication needed.

// ─── Extended query keys ──────────────────────────────────────────────────────

// Append member-scoped keys to the existing queryKeys object via module
// augmentation is not possible after const assertion; use direct property
// access at call sites and add the key functions here as named exports.

/** Query key for GET /rewards/catalog (public, role-independent). */
export const rewardsCatalogKey = ['rewards', 'catalog'] as const;

/** Query key for GET /members/{id}/rewards/balance. */
export const memberRewardsBalanceKey = (memberId: string) =>
  ['member', memberId, 'rewards', 'balance'] as const;

/** Query key for GET /members/{id}/rewards/redemptions. */
export const memberRedemptionsKey = (memberId: string) =>
  ['member', memberId, 'rewards', 'redemptions'] as const;

/** Query key for GET /members/{id}/journeys (member-facing). */
export const memberJourneysKey = (memberId: string) =>
  ['member', memberId, 'journeys'] as const;

/**
 * Fetch the rewards catalog (all active items).
 *
 * GET /rewards/catalog — public endpoint, any authenticated user may call.
 * Stale after 5 minutes; catalog changes rarely.
 */
export function useRewardsCatalog() {
  return useQuery({
    queryKey: rewardsCatalogKey,
    queryFn: async (): Promise<RewardCatalogItem[]> => {
      const raw = await api<unknown[]>('/rewards/catalog');
      return transformKeys<RewardCatalogItem[]>(raw);
    },
    staleTime: 300_000, // 5 min
  });
}

/**
 * Fetch the computed wellness-points balance for the given member.
 *
 * GET /members/{member_id}/rewards/balance
 * Includes next-unlock item and lifetime earned/redeemed totals.
 */
export function useMemberRewardsBalance(memberId: string) {
  return useQuery({
    queryKey: memberRewardsBalanceKey(memberId),
    queryFn: async (): Promise<WellnessPointsBalance> => {
      const raw = await api<unknown>(`/members/${memberId}/rewards/balance`);
      return transformKeys<WellnessPointsBalance>(raw);
    },
    enabled: !!memberId,
    staleTime: 30_000, // 30 s — balance changes on session completion
  });
}

/**
 * CHW/admin awards wellness points to a member.
 *
 * POST /members/{member_id}/rewards/award { points, reason }. Members cannot
 * award their own points (backend 403). Invalidates the member's balance.
 */
export function useAwardMemberPoints(memberId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      vars: { points: number; reason?: string },
    ): Promise<{ currentBalance: number; pointsAwarded: number }> => {
      const raw = await api<unknown>(`/members/${memberId}/rewards/award`, {
        method: 'POST',
        body: JSON.stringify({ points: vars.points, reason: vars.reason ?? null }),
      });
      return transformKeys<{ currentBalance: number; pointsAwarded: number }>(raw);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: memberRewardsBalanceKey(memberId) });
    },
  });
}

/**
 * Fetch all redemption records for the given member (newest first).
 *
 * GET /members/{member_id}/rewards/redemptions
 */
export function useMemberRedemptions(memberId: string) {
  return useQuery({
    queryKey: memberRedemptionsKey(memberId),
    queryFn: async (): Promise<RewardRedemption[]> => {
      const raw = await api<unknown[]>(`/members/${memberId}/rewards/redemptions`);
      return transformKeys<RewardRedemption[]>(raw);
    },
    enabled: !!memberId,
    staleTime: 60_000,
  });
}

/**
 * Fetch all journeys for the given member (member-facing).
 *
 * GET /members/{member_id}/journeys — returns MemberJourneyResponse[].
 * The active journey is the first non-completed, non-abandoned entry.
 */
export function useMemberJourneys(memberId: string) {
  return useQuery({
    queryKey: memberJourneysKey(memberId),
    queryFn: async (): Promise<MemberJourneyResponse[]> => {
      const raw = await api<unknown[]>(`/members/${memberId}/journeys`);
      return transformKeys<MemberJourneyResponse[]>(raw);
    },
    enabled: !!memberId,
    // Short stale + background polling so a CHW's edits to the member's journey
    // (new steps, status changes, added journeys) surface on the member side
    // without a manual refresh. Also refetches when the member refocuses the tab.
    staleTime: 20_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
}

// ─── Rewards redemption mutation (member-facing) ──────────────────────────────

/**
 * POST /members/{member_id}/rewards/redemptions
 *
 * Creates a new redemption request for the given catalog item.
 * On success invalidates both the balance and redemptions caches.
 */
export function useCreateRedemption(memberId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (catalogItemId: string): Promise<RewardRedemption> => {
      const raw = await api<unknown>(
        `/members/${memberId}/rewards/redemptions`,
        {
          method: 'POST',
          body: JSON.stringify({ catalog_item_id: catalogItemId }),
        },
      );
      return transformKeys<RewardRedemption>(raw);
    },
    onSuccess: () => {
      // Guardrail #4: invalidate ALL three caches so balance deducts,
      // catalog inventory_remaining decrements, and history refreshes.
      void qc.invalidateQueries({ queryKey: rewardsCatalogKey });
      void qc.invalidateQueries({ queryKey: memberRewardsBalanceKey(memberId) });
      void qc.invalidateQueries({ queryKey: memberRedemptionsKey(memberId) });
    },
    onError: (_error: unknown) => {
      // Caller handles the error — no silent failures.
    },
  });
}

// ─── Flag Notes (T04) ────────────────────────────────────────────────────────

/**
 * Wire shape for a single active flag note returned by
 * GET /api/v1/members/{member_id}/flag-note.
 *
 * HIPAA: ``body`` is PHI — only CHW-authenticated callers receive this value.
 */
export interface FlagNoteData {
  id: string;
  memberId: string;
  authorChwId: string;
  /** PHI — do not log. */
  body: string;
  createdAt: string;
}

/** Query key namespace for flag-note data. */
export const flagNoteQueryKeys = {
  flagNote: (memberId: string) => ['members', memberId, 'flag-note'] as const,
};

/**
 * Fetch the currently active flag note for the given member.
 *
 * GET /api/v1/members/{member_id}/flag-note
 *
 * Returns null when no active note exists (HTTP 200 with JSON null from backend).
 * Returns 403 when the calling CHW has no care relationship with the member.
 *
 * @param memberId - The member's User.id (UUID string).
 */
export function useFlagNote(memberId: string) {
  return useQuery({
    queryKey: flagNoteQueryKeys.flagNote(memberId),
    queryFn: async (): Promise<FlagNoteData | null> => {
      const raw = await api<unknown>(`/members/${memberId}/flag-note`);
      if (raw === null || raw === undefined) return null;
      return transformKeys<FlagNoteData>(raw);
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

/**
 * Create (or replace) the active flag note for the given member.
 *
 * POST /api/v1/members/{member_id}/flag-note
 * Body: { body: string }
 *
 * If an active note already exists the backend soft-deletes it first.
 * On success the flag-note cache for this member is invalidated.
 */
export function useCreateFlagNote(memberId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (noteBody: string): Promise<FlagNoteData> => {
      const raw = await api<unknown>(`/members/${memberId}/flag-note`, {
        method: 'POST',
        body: JSON.stringify({ body: noteBody }),
      });
      return transformKeys<FlagNoteData>(raw);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: flagNoteQueryKeys.flagNote(memberId) });
    },
    onError: (error: Error) => {
      showAlert('Failed to save flag note', error?.message ?? 'Please try again.');
    },
  });
}

/**
 * Soft-delete the currently active flag note for the given member.
 *
 * DELETE /api/v1/members/{member_id}/flag-note
 *
 * Idempotent — returns 200 even when no active note exists.
 * On success the flag-note cache for this member is invalidated.
 */
export function useDeleteFlagNote(memberId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<void> => {
      await api(`/members/${memberId}/flag-note`, { method: 'DELETE' });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: flagNoteQueryKeys.flagNote(memberId) });
    },
    onError: (error: Error) => {
      showAlert('Failed to remove flag', error?.message ?? 'Please try again.');
    },
  });
}

// ─── Billable Units (T05) ─────────────────────────────────────────────────────

/**
 * Wire shape for GET /api/v1/chw/members/{member_id}/billable-units.
 *
 * All counts are scoped to the authenticated CHW ↔ this member pair.
 */
export interface ChwBillableUnitsData {
  daily: {
    used: number;
    limit: number;
    remaining: number;
  };
  yearly: {
    used: number;
    limit: number;
    remaining: number;
  };
  /** ISO date string (YYYY-MM-DD) in America/Los_Angeles wall-clock time. */
  asOfLaLocalDate: string;
}

/** Query key for CHW billable-units widget. */
export const billableUnitsKey = (memberId: string) =>
  ['chw', 'members', memberId, 'billable-units'] as const;

/**
 * Fetch daily and yearly Medi-Cal billable-unit counts for a CHW↔member pair.
 *
 * GET /api/v1/chw/members/{member_id}/billable-units
 *
 * Returns null when the CHW has no shared session with the member (403).
 * Stale after 60 s — caps change when documentation is submitted.
 *
 * @param memberId - The member's User.id (UUID string).
 */
export function useChwBillableUnits(memberId: string) {
  return useQuery({
    queryKey: billableUnitsKey(memberId),
    queryFn: async (): Promise<ChwBillableUnitsData | null> => {
      try {
        const raw = await api<unknown>(`/chw/members/${memberId}/billable-units`);
        return transformKeys<ChwBillableUnitsData>(raw);
      } catch (err) {
        if (
          err != null &&
          typeof err === 'object' &&
          'status' in err &&
          (err as { status: number }).status === 403
        ) {
          return null;
        }
        throw err;
      }
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

/**
 * Attach an uploaded S3 document key (and optional expiry date) to an
 * existing credential validation record via
 * PATCH /credentials/validations/{id}.
 */
export function usePatchCredentialDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      credentialId,
      payload,
    }: {
      credentialId: string;
      payload: PatchCredentialDocumentPayload;
    }): Promise<void> => {
      const body: Record<string, string> = {
        document_s3_key: payload.documentS3Key,
      };
      if (payload.expiryDate) {
        body.expiry_date = payload.expiryDate;
      }
      await api(`/credentials/validations/${credentialId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['credentials', 'validations'] });
    },
  });
}

// ─── Member Documents ─────────────────────────────────────────────────────────

/**
 * Shape of a MemberDocument row returned by the backend.
 * s3_url is intentionally absent — clients must use the download-url endpoint.
 */
export interface MemberDocumentData {
  id: string;
  memberId: string;
  documentType: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  uploadedBy: string;
  uploadedAt: string;
  deletedAt: string | null;
}

/** Paginated envelope from GET /members/{id}/documents. */
export interface MemberDocumentListData {
  items: MemberDocumentData[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Fetch paginated active documents for a member.
 * Works for both member-self and CHW-with-relationship callers.
 *
 * Query key: ['member', 'documents', memberId]
 */
export function useMemberDocuments(memberId: string, page = 1, pageSize = 50) {
  return useQuery({
    queryKey: ['member', 'documents', memberId, page, pageSize],
    queryFn: async () => {
      if (!memberId) return { items: [], total: 0, page: 1, pageSize } as MemberDocumentListData;
      const raw = await api<unknown>(
        `/members/${memberId}/documents?page=${page}&page_size=${pageSize}`,
      );
      return transformKeys<MemberDocumentListData>(raw);
    },
    enabled: !!memberId,
  });
}

/**
 * Soft-delete a member document (204 No Content).
 * Invalidates the owning member's documents list on success.
 *
 * Usage:
 *   const del = useMemberDocumentDelete(memberId);
 *   del.mutate(docId);
 */
export function useMemberDocumentDelete(memberId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (docId: string): Promise<void> => {
      await api(`/documents/${docId}`, { method: 'DELETE' });
    },
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ['member', 'documents', memberId],
      });
    },
  });
}

/** Shape returned by GET /documents/{id}/download-url. */
export interface PresignedDownloadUrlData {
  downloadUrl: string;
  expiresInSeconds: number;
}

/**
 * Lazily fetch a presigned download URL for a specific member document.
 * The query is disabled by default — set `enabled: true` or call
 * `refetch()` manually to trigger the request.
 *
 * The presigned URL expires in 15 minutes; do NOT cache it indefinitely.
 * Use `staleTime: 0` (default) so a second call always fetches a fresh URL.
 */
export function useMemberDocumentDownloadUrl(docId: string | null, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['member', 'documents', 'download-url', docId],
    queryFn: async () => {
      if (!docId) throw new Error('docId is required');
      const raw = await api<unknown>(`/documents/${docId}/download-url`);
      return transformKeys<PresignedDownloadUrlData>(raw);
    },
    enabled: (options?.enabled ?? false) && !!docId,
    // Never cache — URL expires in 15 min and is only valid for one download.
    staleTime: 0,
    gcTime: 0,
  });
}

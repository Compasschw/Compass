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
import { api, getTokens } from '../api/client';
import { transformKeys, toSnakeCase } from '../utils/caseTransform';
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
}

export interface ChwBrowseItem {
  id: string;
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
  sessionId?: string;
  createdAt: string;
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
  /** One of: housing | food | mental_health | rehab | healthcare */
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

export const queryKeys = {
  sessions: ['sessions'] as const,
  session: (id: string) => ['sessions', id] as const,
  sessionAiSummary: (id: string) => ['sessions', id, 'ai-summary'] as const,
  requests: ['requests'] as const,
  /** Member-scoped: the authenticated member's own requests regardless of status. */
  myRequests: ['requests', 'mine'] as const,
  chwEarnings: ['chw', 'earnings'] as const,
  chwClaims: ['chw', 'claims'] as const,
  chwProfile: ['chw', 'profile'] as const,
  memberProfile: ['member', 'profile'] as const,
  memberRewards: ['member', 'rewards'] as const,
  chwBrowse: (vertical?: string) => ['chw', 'browse', vertical ?? 'all'] as const,
  conversations: ['conversations'] as const,
  messages: (conversationId: string) => ['conversations', conversationId, 'messages'] as const,
  chwMemberProfile: (memberId: string) => ['chw', 'members', memberId, 'profile'] as const,
  /** Full rich member profile for the CHW Member Profile screen. */
  chwMemberDetail: (memberId: string) => ['chw', 'members', memberId, 'detail'] as const,
  chwMapData: ['chw', 'map-data'] as const,
};

/** Re-export so callers don't need a second import from api/sessions. */
export type { AISummaryResponse };

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

export function useSessions() {
  return useQuery({
    queryKey: queryKeys.sessions,
    queryFn: async () => {
      const raw = await api<unknown[]>('/sessions/');
      return transformKeys<SessionData[]>(raw);
    },
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

export function useChwEarnings() {
  return useQuery({
    queryKey: queryKeys.chwEarnings,
    queryFn: async () => {
      const raw = await api<unknown>('/chw/earnings');
      return transformKeys<EarningsSummary>(raw);
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

export function useConversations() {
  return useQuery({
    queryKey: queryKeys.conversations,
    queryFn: async () => {
      const raw = await api<unknown[]>('/conversations/');
      return transformKeys<ConversationData[]>(raw);
    },
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

export function useAcceptRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (requestId: string) => {
      await api(`/requests/${requestId}/accept`, { method: 'PATCH' });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.requests });
      void qc.invalidateQueries({ queryKey: queryKeys.sessions });
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
      void qc.invalidateQueries({ queryKey: queryKeys.sessions });
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
 * Mutation that calls DELETE /auth/users/me with the user's current password.
 *
 * The server responds 204 No Content on success. The caller is responsible
 * for clearing auth state and routing to the landing screen.
 *
 * Usage:
 *   const deleteAccount = useDeleteAccount();
 *   await deleteAccount.mutateAsync({ password: 'hunter2' });
 */
export function useDeleteAccount() {
  return useMutation({
    mutationFn: async ({ password }: { password: string }): Promise<void> => {
      await api<void>('/auth/users/me', {
        method: 'DELETE',
        body: JSON.stringify({ password }),
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

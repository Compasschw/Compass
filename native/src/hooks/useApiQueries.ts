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
  notes?: string;
  createdAt: string;
  chwName?: string;
  memberName?: string;
}

export interface ServiceRequestData {
  id: string;
  memberId: string;
  matchedChwId?: string;
  vertical: string;
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

// ─── Query Keys ──────────────────────────────────────────────────────────────

export const queryKeys = {
  sessions: ['sessions'] as const,
  session: (id: string) => ['sessions', id] as const,
  requests: ['requests'] as const,
  chwEarnings: ['chw', 'earnings'] as const,
  chwClaims: ['chw', 'claims'] as const,
  chwProfile: ['chw', 'profile'] as const,
  memberProfile: ['member', 'profile'] as const,
  memberRewards: ['member', 'rewards'] as const,
  chwBrowse: (vertical?: string) => ['chw', 'browse', vertical ?? 'all'] as const,
  conversations: ['conversations'] as const,
  messages: (conversationId: string) => ['conversations', conversationId, 'messages'] as const,
};

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
      void qc.invalidateQueries({ queryKey: queryKeys.requests });
    },
  });
}

export function useCreateRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      vertical: string;
      urgency: string;
      description: string;
      preferredMode: string;
      estimatedUnits: number;
    }) => {
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
        }),
      });
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

/**
 * React Query hooks for all backend API endpoints.
 *
 * Each query hook returns { data, isLoading, error, refetch }.
 * Each mutation hook returns { mutateAsync, isPending }.
 *
 * All responses are auto-transformed from snake_case → camelCase.
 * All request bodies are auto-transformed from camelCase → snake_case.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
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

export interface MessageData {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  type: string;
  createdAt: string;
}

// ─── Query Keys ──────────────────────────────────────────────────────────────

export const queryKeys = {
  sessions: ['sessions'] as const,
  session: (id: string) => ['sessions', id] as const,
  requests: ['requests'] as const,
  chwEarnings: ['chw', 'earnings'] as const,
  chwProfile: ['chw', 'profile'] as const,
  memberProfile: ['member', 'profile'] as const,
  memberRewards: ['member', 'rewards'] as const,
  chwBrowse: (vertical?: string) => ['chw', 'browse', vertical ?? 'all'] as const,
  conversations: ['conversations'] as const,
  messages: (conversationId: string) => ['conversations', conversationId, 'messages'] as const,
};

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

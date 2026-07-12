/**
 * Hook test for useStartSession — the React Query mutation orchestration that
 * pure-helper tests (sessionStartOptimistic.test.ts) cannot cover: the optimistic
 * cache write on mutate, and the ROLLBACK on error. This is the layer where the
 * real risk lives (a broken rollback leaves a phantom in_progress session), so it
 * is exercised directly against a real QueryClient.
 */
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { useStartSession, queryKeys, type SessionData, type ConversationData } from './useApiQueries';

// Stub only the network call; keep ApiError / getTokens real so the module loads.
vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return { ...actual, api: vi.fn() };
});
import { api } from '../api/client';

const mockedApi = api as unknown as ReturnType<typeof vi.fn>;

const SESSION_ID = 'sess-1';

function makeSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    id: SESSION_ID,
    status: 'scheduled',
    scheduledAt: '2026-07-11T10:00:00.000Z',
    ...overrides,
  } as SessionData;
}

function makeConversation(overrides: Partial<ConversationData> = {}): ConversationData {
  return {
    id: 'conv-1',
    activeSessionId: SESSION_ID,
    activeSessionStartedAt: null,
    ...overrides,
  } as ConversationData;
}

function setup() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  // Seed the caches the button + timer read from.
  qc.setQueryData<SessionData>(queryKeys.session(SESSION_ID), makeSession());
  qc.setQueryData<ConversationData[]>(queryKeys.conversationList(false), [makeConversation()]);

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useStartSession(), { wrapper });
  return { qc, result };
}

beforeEach(() => {
  mockedApi.mockReset();
});

describe('useStartSession — optimistic cache orchestration', () => {
  it('optimistically flips the session to in_progress and stamps started_at', async () => {
    mockedApi.mockResolvedValueOnce(undefined);
    const { qc, result } = setup();

    result.current.mutate(SESSION_ID);

    // Optimistic write happens synchronously in onMutate — assert it applied.
    await waitFor(() => {
      expect(qc.getQueryData<SessionData>(queryKeys.session(SESSION_ID))?.status).toBe('in_progress');
    });
    expect(qc.getQueryData<SessionData>(queryKeys.session(SESSION_ID))?.startedAt).toBeTruthy();

    const conv = qc.getQueryData<ConversationData[]>(queryKeys.conversationList(false))?.[0];
    expect(conv?.activeSessionStartedAt).toBeTruthy();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedApi).toHaveBeenCalledWith(`/sessions/${SESSION_ID}/start`, { method: 'PATCH' });
  });

  it('rolls back the optimistic writes when the start request fails', async () => {
    mockedApi.mockRejectedValueOnce(new Error('boom'));
    const { qc, result } = setup();

    result.current.mutate(SESSION_ID);

    await waitFor(() => expect(result.current.isError).toBe(true));

    // Session status must be restored to the pre-mutate value…
    expect(qc.getQueryData<SessionData>(queryKeys.session(SESSION_ID))?.status).toBe('scheduled');
    // …and the conversation timer start must be cleared again (no phantom timer).
    const conv = qc.getQueryData<ConversationData[]>(queryKeys.conversationList(false))?.[0];
    expect(conv?.activeSessionStartedAt).toBeNull();
  });

  it('preserves an already-set started_at on restart (idempotent)', async () => {
    mockedApi.mockResolvedValueOnce(undefined);
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const existingStart = '2026-07-11T09:00:00.000Z';
    qc.setQueryData<SessionData>(queryKeys.session(SESSION_ID), makeSession({ startedAt: existingStart }));
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useStartSession(), { wrapper });

    result.current.mutate(SESSION_ID);

    await waitFor(() => {
      expect(qc.getQueryData<SessionData>(queryKeys.session(SESSION_ID))?.status).toBe('in_progress');
    });
    expect(qc.getQueryData<SessionData>(queryKeys.session(SESSION_ID))?.startedAt).toBe(existingStart);
  });
});

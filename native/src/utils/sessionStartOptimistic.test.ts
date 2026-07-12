import { describe, it, expect } from 'vitest';

import {
  withSessionStarted,
  withStartedAtForSession,
  type StartableSession,
} from './sessionStartOptimistic';

const NOW = '2026-07-11T10:00:00.000Z';

describe('withSessionStarted', () => {
  it('flips status to in_progress and stamps startedAt when unset', () => {
    const input: StartableSession = { status: 'scheduled' };
    const out = withSessionStarted(input, NOW);
    expect(out.status).toBe('in_progress');
    expect(out.startedAt).toBe(NOW);
  });

  it('preserves an existing startedAt (idempotent restart)', () => {
    const earlier = '2026-07-11T09:00:00.000Z';
    const out = withSessionStarted({ status: 'scheduled', startedAt: earlier }, NOW);
    expect(out.startedAt).toBe(earlier);
  });

  it('does not mutate the input', () => {
    const input = { status: 'scheduled' as string };
    withSessionStarted(input, NOW);
    expect(input.status).toBe('scheduled');
  });

  it('carries through unrelated fields', () => {
    const out = withSessionStarted({ status: 'scheduled', id: 's1' } as { status: string; id: string }, NOW);
    expect(out.id).toBe('s1');
  });
});

describe('withStartedAtForSession', () => {
  const rows = [
    { activeSessionId: 's1', activeSessionStartedAt: null },
    { activeSessionId: 's2', activeSessionStartedAt: null },
    { activeSessionId: null, activeSessionStartedAt: null },
  ];

  it('seeds startedAt only on the matching conversation', () => {
    const out = withStartedAtForSession(rows, 's1', NOW);
    expect(out[0].activeSessionStartedAt).toBe(NOW);
    expect(out[1].activeSessionStartedAt).toBeNull();
    expect(out[2].activeSessionStartedAt).toBeNull();
  });

  it('leaves an already-set startedAt untouched', () => {
    const existing = [{ activeSessionId: 's1', activeSessionStartedAt: '2026-07-11T09:00:00.000Z' }];
    const out = withStartedAtForSession(existing, 's1', NOW);
    expect(out[0].activeSessionStartedAt).toBe('2026-07-11T09:00:00.000Z');
  });

  it('returns a row unchanged when nothing matches', () => {
    const out = withStartedAtForSession(rows, 'nope', NOW);
    expect(out.every((c) => c.activeSessionStartedAt === null)).toBe(true);
  });

  it('does not mutate the input rows', () => {
    withStartedAtForSession(rows, 's1', NOW);
    expect(rows[0].activeSessionStartedAt).toBeNull();
  });
});

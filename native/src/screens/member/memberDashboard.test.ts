/**
 * Unit tests for countAwaitingChw — the member Home "Awaiting CHW" tile count.
 * Tier 1 (node env): pure helper, no react-native.
 */
import { describe, it, expect } from 'vitest';

import { countAwaitingChw } from './memberDashboard';
import type { ServiceRequestData, SessionData } from '../../hooks/useApiQueries';

const session = (partial: Partial<SessionData>): SessionData =>
  ({ status: 'scheduled', schedulingStatus: 'confirmed', ...partial }) as SessionData;
const request = (partial: Partial<ServiceRequestData>): ServiceRequestData =>
  ({ status: 'open', ...partial }) as ServiceRequestData;

describe('countAwaitingChw', () => {
  it('counts member-requested sessions still pending the CHW approval', () => {
    const sessions = [
      session({ schedulingStatus: 'pending' }),
      session({ schedulingStatus: 'pending' }),
      session({ schedulingStatus: 'confirmed' }), // approved — not awaiting
    ];
    expect(countAwaitingChw(sessions, [])).toBe(2);
  });

  it('ignores pending sessions that are not scheduled (e.g. completed/cancelled)', () => {
    const sessions = [
      session({ status: 'completed', schedulingStatus: 'pending' }),
      session({ status: 'cancelled', schedulingStatus: 'pending' }),
    ];
    expect(countAwaitingChw(sessions, [])).toBe(0);
  });

  it('adds open service requests', () => {
    const sessions = [session({ schedulingStatus: 'pending' })];
    const requests = [request({ status: 'open' }), request({ status: 'matched' })];
    expect(countAwaitingChw(sessions, requests)).toBe(2); // 1 pending session + 1 open request
  });

  it('is 0 when nothing is awaiting the CHW', () => {
    expect(countAwaitingChw([session({ schedulingStatus: 'confirmed' })], [])).toBe(0);
    expect(countAwaitingChw([], [])).toBe(0);
  });
});

/**
 * Unit coverage for MemberCalendarScreen's `deriveBadgeStatus` — the O1 fix
 * (Compass Batch Plan, Epic O) that stops the calendar auto-labeling any
 * cancelled session OR any past-but-still-`scheduled` session as "Missed".
 *
 * This mirrors CHWCalendarScreen.test.tsx's "deriveBadgeStatus truthful
 * status tags (O1)" suite — MemberCalendarScreen PORTS (copies + adapts) the
 * same badge logic rather than importing it (see the file's module docstring),
 * so it needs its own regression coverage rather than relying on the CHW
 * screen's tests to catch a drift between the two copies.
 *
 * Deliberately Tier-1-flavored: only the pure, exported `deriveBadgeStatus`
 * helper is imported — no component render, no network/auth/navigation
 * mocks — even though the file lives in a `*.test.tsx` (jsdom) because the
 * source module is a `.tsx` screen file.
 */
import { describe, expect, it, vi } from 'vitest';

// @react-navigation/native's real barrel drags in an extension-less import
// that jsdom/vite-node can't resolve (see CHWMessagesScreen.test.tsx /
// CHWCalendarScreen.test.tsx for the same issue) — even though this file
// only imports a pure helper and never renders the component, importing the
// module still evaluates MemberCalendarScreen.tsx's top-level imports, which
// include `useNavigation`/`useRoute` from this package.
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: vi.fn(),
    goBack: vi.fn(),
    addListener: vi.fn(() => vi.fn()),
    setOptions: vi.fn(),
  }),
  useRoute: () => ({ params: {} }),
}));

import { deriveBadgeStatus } from './MemberCalendarScreen';

describe('MemberCalendarScreen — deriveBadgeStatus truthful status tags (O1)', () => {
  const now = new Date('2026-07-12T18:00:00.000Z');

  it('maps completed → "Completed"', () => {
    expect(
      deriveBadgeStatus({ status: 'completed', scheduledAt: '2026-07-12T15:00:00.000Z' }, now),
    ).toBe('Completed');
  });

  it('maps cancelled → "Cancelled"', () => {
    expect(
      deriveBadgeStatus({ status: 'cancelled', scheduledAt: '2026-07-12T15:00:00.000Z' }, now),
    ).toBe('Cancelled');
  });

  it('maps cancelled_no_consent → "Cancelled"', () => {
    expect(
      deriveBadgeStatus(
        { status: 'cancelled_no_consent', scheduledAt: '2026-07-12T15:00:00.000Z' },
        now,
      ),
    ).toBe('Cancelled');
  });

  it('maps a still-pending scheduling request → "Pending"', () => {
    expect(
      deriveBadgeStatus(
        { status: 'scheduled', schedulingStatus: 'pending', scheduledAt: '2026-07-12T15:00:00.000Z' },
        now,
      ),
    ).toBe('Pending');
  });

  it('maps an upcoming confirmed session → "Confirmed"', () => {
    const future = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    expect(deriveBadgeStatus({ status: 'scheduled', scheduledAt: future }, now)).toBe('Confirmed');
  });

  it('does NOT auto-label a past-but-never-started scheduled session "Missed" — stays "Confirmed"', () => {
    const past = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    expect(deriveBadgeStatus({ status: 'scheduled', scheduledAt: past }, now)).toBe('Confirmed');
  });

  it('never produces a "Missed" tag for any past-but-never-started status — the auto-Missed rule is gone', () => {
    const statuses = [
      'scheduled',
      'in_progress',
      'awaiting_documentation',
      'completed',
      'cancelled',
      'cancelled_no_consent',
    ];
    const past = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    for (const status of statuses) {
      expect(deriveBadgeStatus({ status, scheduledAt: past }, now)).not.toBe('Missed');
    }
  });

  // ── Epic O2 — explicit no_show status ("Missed") ─────────────────────────

  it('maps no_show → "Missed"', () => {
    expect(
      deriveBadgeStatus({ status: 'no_show', scheduledAt: '2026-07-12T15:00:00.000Z' }, now),
    ).toBe('Missed');
  });

  it('does not conflate no_show with cancelled — they remain distinct statuses', () => {
    const past = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    expect(deriveBadgeStatus({ status: 'no_show', scheduledAt: past }, now)).toBe('Missed');
    expect(deriveBadgeStatus({ status: 'cancelled', scheduledAt: past }, now)).toBe('Cancelled');
  });
});

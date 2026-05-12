/**
 * MyCHWScreen — entry point for the Member's "My CHW" sidebar item.
 *
 * Decides what to render based on whether the member has an assigned CHW yet:
 *
 *   - Loading sessions          → AppShell skeleton (no flicker on cold load).
 *   - Has at least one session  → MemberFacingCHWProfileScreen with the
 *                                 chwId from the most recent session, no
 *                                 back button (this IS the landing page).
 *   - No sessions yet           → MemberFindScreen (the find/match flow).
 *
 * "Assigned CHW" is derived from the most recent Session.chwId because the
 * Compass data model has no explicit assigned_chw_id field on Member. The
 * latest session's CHW is the working definition of "your CHW" today; if/when
 * we introduce a real assignment relationship, this screen is the single
 * place to swap in that lookup.
 */

import React, { useMemo } from 'react';
import { View } from 'react-native';

import { useAuth } from '../../context/AuthContext';
import { useSessions } from '../../hooks/useApiQueries';
import { AppShell } from '../../components/ui';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { MemberFacingCHWProfileScreen } from './MemberFacingCHWProfileScreen';
import { MemberFindScreen } from './MemberFindScreen';

export function MyCHWScreen(): React.JSX.Element {
  const { userName } = useAuth();
  const sessionsQuery = useSessions();

  const memberInitials = (userName ?? 'M')
    .split(' ')
    .slice(0, 2)
    .map((p) => p[0] ?? '')
    .join('')
    .toUpperCase();

  const shellUserBlock = {
    initials: memberInitials,
    name: userName ?? 'Member',
    role: 'Member' as const,
  };

  // Pick the most recent session — sessions are typically ordered by the
  // backend, but sort defensively in case the API contract changes.
  const assignedChwId = useMemo<string | null>(() => {
    const sessions = sessionsQuery.data ?? [];
    if (sessions.length === 0) return null;
    const sorted = [...sessions].sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
    return sorted[0]?.chwId ?? null;
  }, [sessionsQuery.data]);

  // ── Loading: skeleton inside the shell so the sidebar stays put ─────────────
  if (sessionsQuery.isLoading) {
    return (
      <AppShell role="member" activeKey="myChw" userBlock={shellUserBlock}>
        <View>
          <LoadingSkeleton variant="card" />
          <LoadingSkeleton variant="rows" rows={4} />
        </View>
      </AppShell>
    );
  }

  // ── Has assigned CHW: render the profile inline (back button hidden) ────────
  if (assignedChwId) {
    return <MemberFacingCHWProfileScreen chwId={assignedChwId} hideBack />;
  }

  // ── No CHW yet: render the find/match flow ──────────────────────────────────
  return <MemberFindScreen />;
}

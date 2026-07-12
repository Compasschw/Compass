/**
 * Pure helpers for the member Home dashboard tiles. No react-native imports so
 * the counting logic is unit-tested in the node env.
 */
import type { ServiceRequestData, SessionData } from '../../hooks/useApiQueries';

/**
 * Count of things awaiting the CHW, for the Home "Open Requests / Awaiting CHW"
 * tile. That's member-requested sessions still pending the CHW's approval
 * (``scheduling_status === 'pending'`` — these appear on the Appointments page)
 * plus any open service requests not yet picked up. Counting the pending
 * sessions is what keeps this tile in sync with the Appointments page (it
 * previously counted only open service requests, so a session awaiting the
 * CHW's approval showed as 0).
 */
export function countAwaitingChw(
  sessions: readonly SessionData[],
  requests: readonly ServiceRequestData[],
): number {
  const pendingSessions = sessions.filter(
    (s) => s.status === 'scheduled' && s.schedulingStatus === 'pending',
  ).length;
  const openRequests = requests.filter((r) => r.status === 'open').length;
  return pendingSessions + openRequests;
}

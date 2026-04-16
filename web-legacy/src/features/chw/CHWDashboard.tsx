import { DollarSign, Star, CalendarCheck, ClipboardList, Loader2 } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { StatCard } from '../../shared/components/StatCard';
import { Badge } from '../../shared/components/Badge';
import { VerticalIcon } from '../../shared/components/VerticalIcon';
import { formatCurrency, formatDate, MEDI_CAL_RATE, NET_PAYOUT_RATE } from '../../shared/utils/format';
import { useChwEarnings, useRequests, useSessions } from '../../api/hooks';
import type { Vertical } from '../../data/mock';

const SESSION_MODE_LABELS: Record<string, string> = {
  in_person: 'In Person', virtual: 'Virtual', phone: 'Phone',
};
const URGENCY_LABELS: Record<string, string> = {
  routine: '🟢 Routine', soon: '🟡 Soon', urgent: '🔴 Urgent',
};

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * CHW Dashboard — the landing page after login for health workers.
 *
 * Shows:
 * - Personalised greeting
 * - Four key stat cards (earnings, rating, sessions, open requests)
 * - Recent open requests (top 3)
 * - Upcoming scheduled session
 */
export function CHWDashboard() {
  const { userName } = useAuth();
  const firstName = userName?.split(' ')[0] ?? 'there';

  const { data: earnings, isLoading: earningsLoading } = useChwEarnings();
  const { data: requests = [], isLoading: requestsLoading } = useRequests();
  const { data: sessionsList = [], isLoading: sessionsLoading } = useSessions();

  const isLoading = earningsLoading || requestsLoading || sessionsLoading;
  const openRequests = requests.filter((r) => r.status === 'open');
  const upcomingSession = sessionsList.find((s) => s.status === 'scheduled');

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Greeting */}
      <div>
        <h2 className="text-2xl font-semibold text-[#0077B6]">
          Good morning, {firstName}
        </h2>
        <p className="text-sm text-[#555555] mt-1">
          Here's what's happening with your work today.
        </p>
      </div>

      {/* Stat cards */}
      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 size={24} className="animate-spin text-[#6B8F71]" />
          <span className="ml-2 text-sm text-[#8B9B8D]">Loading dashboard...</span>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            icon={<DollarSign size={18} className="text-[#6B8F71]" />}
            label="This Month"
            value={formatCurrency(earnings?.this_month ?? 0)}
            subtext={`${formatCurrency(earnings?.pending_payout ?? 0)} pending`}
            iconBg="bg-[rgba(107,143,113,0.15)]"
          />
          <StatCard
            icon={<Star size={18} className="text-yellow-500" />}
            label="Avg Rating"
            value={(earnings?.avg_rating ?? 0).toFixed(1)}
            subtext="From member reviews"
            iconBg="bg-yellow-100"
          />
          <StatCard
            icon={<CalendarCheck size={18} className="text-[#0077B6]" />}
            label="Sessions"
            value={earnings?.sessions_this_week ?? 0}
            subtext="This week"
            iconBg="bg-blue-100"
          />
          <StatCard
            icon={<ClipboardList size={18} className="text-purple-600" />}
            label="Open Requests"
            value={openRequests.length}
            subtext="Awaiting match"
            iconBg="bg-purple-100"
          />
        </div>
      )}

      {/* Upcoming session */}
      {upcomingSession && (
        <section aria-labelledby="upcoming-heading">
          <h3
            id="upcoming-heading"
            className="text-sm font-semibold text-[#2C3E2D] uppercase tracking-wide mb-3"
          >
            Upcoming Session
          </h3>
          <div className="bg-white rounded-[20px] border border-[rgba(44,62,45,0.1)] p-4 flex items-start gap-3">
            <div className="w-10 h-10 rounded-[12px] bg-[rgba(107,143,113,0.15)] flex items-center justify-center shrink-0">
              <VerticalIcon vertical={upcomingSession.vertical as Vertical} size={20} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm font-semibold text-[#2C3E2D]">
                  Session
                </p>
                <Badge variant="vertical" value={upcomingSession.vertical as Vertical} />
                <Badge variant="session-status" value={upcomingSession.status as 'scheduled'} />
              </div>
              <p className="text-xs text-[#555555] mt-1">
                {upcomingSession.scheduled_at ? formatDate(upcomingSession.scheduled_at) : 'TBD'}
                {' · '}
                {SESSION_MODE_LABELS[upcomingSession.mode] ?? upcomingSession.mode}
              </p>
            </div>
          </div>
        </section>
      )}

      {/* Open requests */}
      <section aria-labelledby="requests-heading">
        <div className="flex items-center justify-between mb-3">
          <h3
            id="requests-heading"
            className="text-sm font-semibold text-[#2C3E2D] uppercase tracking-wide"
          >
            Open Requests Near You
          </h3>
          <a href="/chw/requests" className="text-xs text-[#0077B6] hover:underline font-medium">
            View all
          </a>
        </div>

        <div className="space-y-3">
          {openRequests.slice(0, 3).map((request) => (
            <div
              key={request.id}
              className="bg-white rounded-[20px] border border-[rgba(44,62,45,0.1)] p-4"
            >
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-[12px] bg-[#FBF7F0] border border-[rgba(44,62,45,0.1)] flex items-center justify-center shrink-0">
                  <VerticalIcon vertical={request.vertical as Vertical} size={18} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="text-sm font-semibold text-[#2C3E2D]">
                      {request.member_name ?? 'Community Member'}
                    </span>
                    <Badge variant="vertical" value={request.vertical as Vertical} />
                    <Badge variant="urgency" value={request.urgency as 'routine' | 'soon' | 'urgent'} />
                  </div>
                  <p className="text-xs text-[#555555] leading-relaxed line-clamp-2">
                    {request.description}
                  </p>
                  <div className="flex items-center gap-3 mt-2">
                    <span className="text-xs text-[#8B9B8D]">
                      {SESSION_MODE_LABELS[request.preferred_mode] ?? request.preferred_mode}
                    </span>
                    <span className="text-xs text-[#8B9B8D]">·</span>
                    <span className="text-xs text-[#8B9B8D]">
                      ~{request.estimated_units} units (
                      {formatCurrency(request.estimated_units * MEDI_CAL_RATE * NET_PAYOUT_RATE)} net)
                    </span>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Urgency legend note */}
      <p className="text-xs text-[#8B9B8D] text-center">
        Urgency: {URGENCY_LABELS.routine} — {URGENCY_LABELS.soon} — {URGENCY_LABELS.urgent} · Rates reflect $26.66/unit Medi-Cal reimbursement, 85% CHW payout.
      </p>
    </div>
  );
}

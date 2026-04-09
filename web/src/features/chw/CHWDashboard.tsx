import { DollarSign, Star, CalendarCheck, ClipboardList } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { StatCard } from '../../shared/components/StatCard';
import { Badge } from '../../shared/components/Badge';
import { VerticalIcon } from '../../shared/components/VerticalIcon';
import { formatCurrency, formatDate, MEDI_CAL_RATE, NET_PAYOUT_RATE } from '../../shared/utils/format';
import {
  earningsSummary,
  serviceRequests,
  sessions,
  urgencyLabels,
  sessionModeLabels,
} from '../../data/mock';

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

  const openRequests = serviceRequests.filter((r) => r.status === 'open');
  const upcomingSession = sessions.find((s) => s.status === 'scheduled');

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
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          icon={<DollarSign size={18} className="text-[#6B8F71]" />}
          label="This Week"
          value={formatCurrency(earningsSummary.thisWeek)}
          subtext="Pending payout"
          iconBg="bg-[rgba(107,143,113,0.15)]"
        />
        <StatCard
          icon={<Star size={18} className="text-yellow-500" />}
          label="Avg Rating"
          value={earningsSummary.avgRating.toFixed(1)}
          subtext="Last 30 sessions"
          iconBg="bg-yellow-100"
        />
        <StatCard
          icon={<CalendarCheck size={18} className="text-[#0077B6]" />}
          label="Sessions"
          value={earningsSummary.sessionsThisWeek}
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
              <VerticalIcon vertical={upcomingSession.vertical} size={20} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm font-semibold text-[#2C3E2D]">
                  {upcomingSession.memberName}
                </p>
                <Badge variant="vertical" value={upcomingSession.vertical} />
                <Badge variant="session-status" value={upcomingSession.status} />
              </div>
              <p className="text-xs text-[#555555] mt-1">
                {formatDate(upcomingSession.scheduledAt)}
                {' · '}
                {sessionModeLabels[upcomingSession.mode]}
              </p>
              {upcomingSession.notes && (
                <p className="text-xs text-[#8B9B8D] mt-1 italic truncate">
                  {upcomingSession.notes}
                </p>
              )}
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
                  <VerticalIcon vertical={request.vertical} size={18} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="text-sm font-semibold text-[#2C3E2D]">
                      {request.memberName}
                    </span>
                    <Badge variant="vertical" value={request.vertical} />
                    <Badge variant="urgency" value={request.urgency} />
                  </div>
                  <p className="text-xs text-[#555555] leading-relaxed line-clamp-2">
                    {request.description}
                  </p>
                  <div className="flex items-center gap-3 mt-2">
                    <span className="text-xs text-[#8B9B8D]">
                      {sessionModeLabels[request.preferredMode]}
                    </span>
                    <span className="text-xs text-[#8B9B8D]">·</span>
                    <span className="text-xs text-[#8B9B8D]">
                      ~{request.estimatedUnits} units (
                      {formatCurrency(request.estimatedUnits * MEDI_CAL_RATE * NET_PAYOUT_RATE)} net)
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
        Urgency: {urgencyLabels.routine} — {urgencyLabels.soon} — {urgencyLabels.urgent} · Rates reflect $26.66/unit Medi-Cal reimbursement, 85% CHW payout.
      </p>
    </div>
  );
}

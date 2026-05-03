import { useAuth } from '../auth/AuthContext';
import { StatCard } from '../../shared/components/StatCard';
import { Badge } from '../../shared/components/Badge';
import { VerticalIcon } from '../../shared/components/VerticalIcon';
import { formatDate } from '../../shared/utils/format';
import { Gift, CalendarCheck, Map, ArrowRight, Loader2 } from 'lucide-react';
import { useSessions } from '../../api/hooks';
import type { Vertical } from '../../data/mock';
import { Link } from 'react-router-dom';

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Member Home — the landing page for community members after login.
 *
 * Shows:
 * - Personalised greeting
 * - Rewards balance, upcoming session count, active goals count
 * - Active goals with progress bars
 * - Link to find a CHW
 */
export function MemberHome() {
  const { userName } = useAuth();
  const firstName = userName?.split(' ')[0] ?? 'there';

  const { data: sessionsList = [], isLoading } = useSessions();
  const upcomingSessions = sessionsList.filter((s) => s.status === 'scheduled');

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {/* Greeting */}
      <div>
        <h2 className="text-2xl font-semibold text-[#0077B6]">
          Hello, {firstName}
        </h2>
        <p className="text-sm text-[#555555] mt-1">
          Let's keep making progress on your health goals today.
        </p>
      </div>

      {/* Stat cards */}
      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 size={24} className="animate-spin text-[#6B8F71]" />
          <span className="ml-2 text-sm text-[#8B9B8D]">Loading...</span>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          <StatCard
            icon={<Gift size={18} className="text-[#6B8F71]" />}
            label="Rewards"
            value="0 pts"
            iconBg="bg-[rgba(107,143,113,0.15)]"
          />
          <StatCard
            icon={<CalendarCheck size={18} className="text-[#0077B6]" />}
            label="Upcoming"
            value={upcomingSessions.length}
            subtext="Sessions"
            iconBg="bg-blue-100"
          />
          <StatCard
            icon={<Map size={18} className="text-purple-600" />}
            label="Goals"
            value={0}
            subtext="Active"
            iconBg="bg-purple-100"
          />
        </div>
      )}

      {/* Goals — placeholder until goals endpoint is built */}
      <section aria-labelledby="goals-heading">
        <div className="flex items-center justify-between mb-3">
          <h3
            id="goals-heading"
            className="text-sm font-semibold text-[#2C3E2D] uppercase tracking-wide"
          >
            My Goals
          </h3>
          <Link
            to="/member/roadmap"
            className="text-xs text-[#0077B6] hover:underline font-medium flex items-center gap-1"
          >
            Full roadmap <ArrowRight size={12} />
          </Link>
        </div>

        <div className="bg-white rounded-[20px] border border-[rgba(44,62,45,0.1)] p-6 text-center">
          <Map size={24} className="mx-auto text-[#8B9B8D] mb-2" />
          <p className="text-sm font-semibold text-[#2C3E2D]">No goals yet</p>
          <p className="text-xs text-[#8B9B8D] mt-1">
            Work with a CHW to set personalized health goals.
          </p>
        </div>
      </section>

      {/* Primary CTA — direct request submission */}
      <div className="bg-[#2C3E2D] rounded-[12px] p-5 flex items-center gap-4">
        <div className="flex-1">
          <p className="text-white font-semibold text-sm">
            Need help right now?
          </p>
          <p className="text-[rgba(255,255,255,0.7)] text-xs mt-1">
            Submit a request and a CHW matched to your needs will reach out.
          </p>
        </div>
        <Link
          to="/member/request"
          className="shrink-0 bg-white text-[#2C3E2D] hover:bg-[#FBF7F0] font-semibold text-sm px-4 py-2 rounded-[12px] transition-colors flex items-center gap-1.5"
        >
          Request Help <ArrowRight size={14} />
        </Link>
      </div>

      {/* Secondary CTA — browse-then-pick flow (existing entry point) */}
      <div className="bg-[#0077B6] rounded-[12px] p-5 flex items-center gap-4">
        <div className="flex-1">
          <p className="text-white font-semibold text-sm">
            Want to pick a specific CHW?
          </p>
          <p className="text-blue-100 text-xs mt-1">
            Browse profiles and schedule a session with someone you choose.
          </p>
        </div>
        <Link
          to="/member/find"
          className="shrink-0 bg-white text-[#0077B6] hover:bg-blue-50 font-semibold text-sm px-4 py-2 rounded-[12px] transition-colors flex items-center gap-1.5"
        >
          Find CHW <ArrowRight size={14} />
        </Link>
      </div>

      {/* Upcoming sessions preview */}
      {upcomingSessions.length > 0 && (
        <section aria-labelledby="upcoming-member-heading">
          <h3
            id="upcoming-member-heading"
            className="text-sm font-semibold text-[#2C3E2D] uppercase tracking-wide mb-3"
          >
            Upcoming Sessions
          </h3>
          {upcomingSessions.map((session) => (
            <div
              key={session.id}
              className="bg-white rounded-[20px] border border-[rgba(44,62,45,0.1)] p-4 flex items-center gap-3"
            >
              <div className="w-10 h-10 rounded-[12px] bg-[rgba(107,143,113,0.15)] flex items-center justify-center shrink-0">
                <VerticalIcon vertical={session.vertical as Vertical} size={18} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-[#2C3E2D]">
                  Session
                </p>
                <p className="text-xs text-[#555555]">
                  {session.scheduled_at ? formatDate(session.scheduled_at) : 'TBD'}
                </p>
              </div>
              <Badge variant="session-status" value={session.status as 'scheduled'} />
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

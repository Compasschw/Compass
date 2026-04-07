import { useAuth } from '../auth/AuthContext';
import { StatCard } from '../../shared/components/StatCard';
import { Badge } from '../../shared/components/Badge';
import { VerticalIcon } from '../../shared/components/VerticalIcon';
import { Gift, CalendarCheck, Map, ArrowRight } from 'lucide-react';
import { goals, sessions, memberProfiles } from '../../data/mock';
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

  // Use the first member profile for mock data
  const member = memberProfiles[0];

  const upcomingSessions = sessions.filter((s) => s.status === 'scheduled');
  const activeGoals = goals.filter((g) => g.status !== 'completed');

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
  }

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
      <div className="grid grid-cols-3 gap-3">
        <StatCard
          icon={<Gift size={18} className="text-[#00B050]" />}
          label="Rewards"
          value={`${member.rewardsBalance} pts`}
          iconBg="bg-[#D0F0D0]"
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
          value={activeGoals.length}
          subtext="Active"
          iconBg="bg-purple-100"
        />
      </div>

      {/* Active goals */}
      <section aria-labelledby="goals-heading">
        <div className="flex items-center justify-between mb-3">
          <h3
            id="goals-heading"
            className="text-sm font-semibold text-[#1A1A1A] uppercase tracking-wide"
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

        <div className="space-y-3">
          {activeGoals.map((goal) => (
            <div
              key={goal.id}
              className="bg-white rounded-[12px] border border-[#E5E7EB] p-4"
            >
              <div className="flex items-start gap-3">
                <span className="text-2xl leading-none mt-0.5" role="img" aria-hidden="true">
                  {goal.emoji}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <p className="text-sm font-semibold text-[#1A1A1A] truncate">
                      {goal.title}
                    </p>
                    <Badge variant="vertical" value={goal.category} />
                  </div>
                  {/* Progress bar */}
                  <div
                    className="w-full bg-[#E5E7EB] rounded-full h-1.5 mb-2"
                    role="progressbar"
                    aria-valuenow={goal.progress}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`${goal.title} progress`}
                  >
                    <div
                      className="bg-[#00B050] h-1.5 rounded-full transition-all"
                      style={{ width: `${goal.progress}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between text-xs text-[#AAAAAA]">
                    <span>{goal.progress}% complete</span>
                    <span>Next: {formatDate(goal.nextSession)}</span>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* CTA to find CHW */}
      <div className="bg-[#0077B6] rounded-[12px] p-5 flex items-center gap-4">
        <div className="flex-1">
          <p className="text-white font-semibold text-sm">
            Need help with a new goal?
          </p>
          <p className="text-blue-100 text-xs mt-1">
            Find a Community Health Worker near you.
          </p>
        </div>
        <Link
          to="/member/find"
          className="shrink-0 bg-white text-[#0077B6] hover:bg-blue-50 font-semibold text-sm px-4 py-2 rounded-[8px] transition-colors flex items-center gap-1.5"
        >
          Find CHW <ArrowRight size={14} />
        </Link>
      </div>

      {/* Upcoming sessions preview */}
      {upcomingSessions.length > 0 && (
        <section aria-labelledby="upcoming-member-heading">
          <h3
            id="upcoming-member-heading"
            className="text-sm font-semibold text-[#1A1A1A] uppercase tracking-wide mb-3"
          >
            Upcoming Sessions
          </h3>
          {upcomingSessions.map((session) => (
            <div
              key={session.id}
              className="bg-white rounded-[12px] border border-[#E5E7EB] p-4 flex items-center gap-3"
            >
              <div className="w-10 h-10 rounded-[8px] bg-[#D0F0D0] flex items-center justify-center shrink-0">
                <VerticalIcon vertical={session.vertical} size={18} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-[#1A1A1A]">
                  {session.chwName}
                </p>
                <p className="text-xs text-[#555555]">
                  {formatDate(session.scheduledAt)}
                </p>
              </div>
              <Badge variant="session-status" value={session.status} />
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

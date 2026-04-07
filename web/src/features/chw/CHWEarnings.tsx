import { DollarSign, Star, CalendarCheck, TrendingUp, Banknote } from 'lucide-react';
import { StatCard } from '../../shared/components/StatCard';
import { VerticalIcon } from '../../shared/components/VerticalIcon';
import { earningsSummary, sessions, sessionModeLabels } from '../../data/mock';

// ─── Constants ────────────────────────────────────────────────────────────────

const MEDI_CAL_RATE = 26.66;

// ─── Scenario table data ──────────────────────────────────────────────────────

interface EarningsScenario {
  label: string;
  description: string;
  unitsPerDay: number;
  grossPerDay: number;
  netP1PerDay: number;
  netP2PerDay: number;
}

/**
 * Jemal's Medi-Cal earnings scenario table.
 * P1 = Phase 1 (Pear Suite, 28% combined deduction → 72% net).
 * P2 = Phase 2 (direct billing, 17.4% combined deduction → 82.6% net approx).
 * Gross = units × $26.66. Net P1 = gross × 0.7225. Net P2 = gross × 0.8245.
 */
const earningsScenarios: EarningsScenario[] = [
  {
    label: 'Light',
    description: '2 members × 1 unit',
    unitsPerDay: 2,
    grossPerDay: parseFloat((2 * MEDI_CAL_RATE).toFixed(2)),
    netP1PerDay: 38.54,
    netP2PerDay: 43.98,
  },
  {
    label: 'Moderate',
    description: '4 members × 2 units',
    unitsPerDay: 8,
    grossPerDay: parseFloat((8 * MEDI_CAL_RATE).toFixed(2)),
    netP1PerDay: 154.16,
    netP2PerDay: 175.94,
  },
  {
    label: 'Full',
    description: '6 members × 3 units',
    unitsPerDay: 18,
    grossPerDay: parseFloat((18 * MEDI_CAL_RATE).toFixed(2)),
    netP1PerDay: 346.86,
    netP2PerDay: 395.91,
  },
  {
    label: 'Max Daily',
    description: '5 members × 4 units',
    unitsPerDay: 20,
    grossPerDay: parseFloat((20 * MEDI_CAL_RATE).toFixed(2)),
    netP1PerDay: 385.40,
    netP2PerDay: 439.89,
  },
];

// ─── Types ────────────────────────────────────────────────────────────────────

type PayoutStatus = 'pending' | 'submitted' | 'approved';

const payoutStatusStyles: Record<PayoutStatus, string> = {
  pending: 'bg-yellow-100 text-yellow-800',
  submitted: 'bg-blue-100 text-blue-700',
  approved: 'bg-green-100 text-green-700',
};

const payoutStatusLabels: Record<PayoutStatus, string> = {
  pending: 'Pending',
  submitted: 'Submitted',
  approved: 'Approved',
};

/**
 * Derives a mock payout status from session ID for demo purposes.
 */
function derivePayoutStatus(sessionId: string): PayoutStatus {
  const map: Record<string, PayoutStatus> = {
    'sess-002': 'submitted',
    'sess-003': 'approved',
    'sess-004': 'approved',
  };
  return map[sessionId] ?? 'pending';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  }).format(amount);
}

function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * CHW Earnings page — the money dashboard.
 *
 * Sections:
 * 1. Hero: pending payout amount with green gradient background
 * 2. Stat cards: this month, all time, avg rating, sessions this week
 * 3. Earnings scenario table (Jemal's Medi-Cal math)
 * 4. Recent payouts list
 * 5. Payout schedule note
 */
export function CHWEarnings() {
  const completedSessions = sessions.filter((s) => s.status === 'completed');

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Page header */}
      <div>
        <h2 className="text-2xl font-semibold text-[#0077B6]">Earnings & Payouts</h2>
        <p className="text-sm text-[#555555] mt-1">
          Track your Medi-Cal reimbursements and payout history.
        </p>
      </div>

      {/* ── Hero section ── */}
      <section
        aria-labelledby="hero-earnings-heading"
        className="relative overflow-hidden rounded-[12px] p-6"
        style={{
          background: 'linear-gradient(135deg, #00B050 0%, #008F40 60%, #006A30 100%)',
        }}
      >
        {/* Decorative background circle */}
        <div
          className="absolute -right-8 -top-8 w-40 h-40 rounded-full opacity-10 bg-white"
          aria-hidden="true"
        />
        <div
          className="absolute -right-2 -bottom-10 w-28 h-28 rounded-full opacity-10 bg-white"
          aria-hidden="true"
        />

        <div className="relative z-10">
          <div className="flex items-center gap-2 mb-1">
            <Banknote size={16} className="text-white/80" aria-hidden="true" />
            <p className="text-sm font-medium text-white/80 uppercase tracking-wide">
              Pending Payout
            </p>
          </div>
          <p
            id="hero-earnings-heading"
            className="text-5xl font-bold text-white leading-none tracking-tight"
          >
            {formatCurrency(earningsSummary.pendingPayout)}
          </p>
          <p className="text-sm text-white/70 mt-2">
            This week · {earningsSummary.sessionsThisWeek} sessions completed
          </p>
        </div>
      </section>

      {/* ── Stat cards ── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          icon={<DollarSign size={18} className="text-[#00B050]" />}
          label="This Month"
          value={formatCurrency(earningsSummary.thisMonth)}
          subtext="Apr 2026"
          iconBg="bg-[#D0F0D0]"
        />
        <StatCard
          icon={<TrendingUp size={18} className="text-[#0077B6]" />}
          label="All Time"
          value={formatCurrency(earningsSummary.allTime)}
          subtext="Career total"
          iconBg="bg-blue-100"
        />
        <StatCard
          icon={<Star size={18} className="text-yellow-500" />}
          label="Avg Rating"
          value={earningsSummary.avgRating.toFixed(1)}
          subtext="Last 30 sessions"
          iconBg="bg-yellow-100"
        />
        <StatCard
          icon={<CalendarCheck size={18} className="text-purple-600" />}
          label="Sessions"
          value={earningsSummary.sessionsThisWeek}
          subtext="This week"
          iconBg="bg-purple-100"
        />
      </div>

      {/* ── Earnings scenario table ── */}
      <section aria-labelledby="scenario-heading">
        <h3
          id="scenario-heading"
          className="text-sm font-semibold text-[#1A1A1A] uppercase tracking-wide mb-3"
        >
          Earnings Scenarios
        </h3>

        <div className="bg-white rounded-[12px] border border-[#E5E7EB] overflow-hidden">
          {/* Table — scrollable on narrow screens */}
          <div className="overflow-x-auto">
            <table
              className="w-full text-sm"
              aria-label="Daily earnings scenarios by workload"
            >
              <thead>
                <tr className="bg-[#F8FAFB] border-b border-[#E5E7EB]">
                  <th
                    scope="col"
                    className="text-left text-xs font-semibold text-[#555555] uppercase tracking-wide px-4 py-3"
                  >
                    Scenario
                  </th>
                  <th
                    scope="col"
                    className="text-right text-xs font-semibold text-[#555555] uppercase tracking-wide px-4 py-3 whitespace-nowrap"
                  >
                    Units/day
                  </th>
                  <th
                    scope="col"
                    className="text-right text-xs font-semibold text-[#555555] uppercase tracking-wide px-4 py-3 whitespace-nowrap"
                  >
                    Gross/day
                  </th>
                  <th
                    scope="col"
                    className="text-right text-xs font-semibold text-[#00B050] uppercase tracking-wide px-4 py-3 whitespace-nowrap"
                  >
                    Net P1/day
                  </th>
                  <th
                    scope="col"
                    className="text-right text-xs font-semibold text-[#0077B6] uppercase tracking-wide px-4 py-3 whitespace-nowrap"
                  >
                    Net P2/day
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E5E7EB]">
                {earningsScenarios.map((scenario, index) => (
                  <tr
                    key={scenario.label}
                    className={index % 2 === 0 ? 'bg-white' : 'bg-[#F8FAFB]/50'}
                  >
                    <td className="px-4 py-3">
                      <span className="font-semibold text-[#1A1A1A]">
                        {scenario.label}
                      </span>
                      <span className="block text-xs text-[#AAAAAA] mt-0.5">
                        {scenario.description}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-[#555555]">
                      {scenario.unitsPerDay}
                    </td>
                    <td className="px-4 py-3 text-right text-[#555555]">
                      {formatCurrency(scenario.grossPerDay)}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-[#00B050]">
                      {formatCurrency(scenario.netP1PerDay)}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-[#0077B6]">
                      {formatCurrency(scenario.netP2PerDay)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Footnote */}
          <div className="px-4 py-3 border-t border-[#E5E7EB] bg-[#F8FAFB]">
            <p className="text-xs text-[#AAAAAA] leading-relaxed">
              P1 = Phase 1 (Pear Suite platform). P2 = Phase 2 (direct Medi-Cal billing).
              Rate: $26.66/unit (15 min).
            </p>
          </div>
        </div>
      </section>

      {/* ── Recent payouts ── */}
      <section aria-labelledby="payouts-heading">
        <h3
          id="payouts-heading"
          className="text-sm font-semibold text-[#1A1A1A] uppercase tracking-wide mb-3"
        >
          Recent Payouts
        </h3>

        {completedSessions.length > 0 ? (
          <div className="bg-white rounded-[12px] border border-[#E5E7EB] divide-y divide-[#E5E7EB]">
            {completedSessions.map((session) => {
              const status = derivePayoutStatus(session.id);
              return (
                <div
                  key={session.id}
                  className="flex items-center gap-3 p-4"
                >
                  {/* Vertical icon */}
                  <div
                    className="w-9 h-9 rounded-[8px] bg-[#F8FAFB] border border-[#E5E7EB] flex items-center justify-center shrink-0"
                    aria-hidden="true"
                  >
                    <VerticalIcon vertical={session.vertical} size={16} />
                  </div>

                  {/* Details */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-[#1A1A1A] truncate">
                      {session.memberName}
                    </p>
                    <p className="text-xs text-[#AAAAAA]">
                      {formatShortDate(session.scheduledAt)}
                      {session.unitsBilled != null && (
                        <> · {session.unitsBilled} {session.unitsBilled === 1 ? 'unit' : 'units'}</>
                      )}
                      {' · '}
                      {sessionModeLabels[session.mode]}
                    </p>
                  </div>

                  {/* Amount + status */}
                  <div className="text-right shrink-0">
                    <p className="text-sm font-bold text-[#1A1A1A]">
                      {formatCurrency(session.netAmount ?? 0)}
                    </p>
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium mt-1 ${payoutStatusStyles[status]}`}
                    >
                      {payoutStatusLabels[status]}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div
            className="bg-white rounded-[12px] border border-[#E5E7EB] p-10 flex flex-col items-center gap-3 text-center"
            role="status"
          >
            <div className="w-12 h-12 rounded-full bg-[#F8FAFB] border border-[#E5E7EB] flex items-center justify-center">
              <DollarSign size={22} className="text-[#AAAAAA]" aria-hidden="true" />
            </div>
            <p className="text-sm font-semibold text-[#1A1A1A]">No payouts yet</p>
            <p className="text-xs text-[#AAAAAA]">
              Complete sessions to start earning.
            </p>
          </div>
        )}
      </section>

      {/* Payout schedule note */}
      <div className="bg-white rounded-[12px] border border-[#E5E7EB] p-4 flex items-center gap-3">
        <div
          className="w-9 h-9 rounded-[8px] bg-[#D0F0D0] flex items-center justify-center shrink-0"
          aria-hidden="true"
        >
          <Banknote size={18} className="text-[#00B050]" />
        </div>
        <p className="text-sm text-[#555555]">
          <span className="font-semibold text-[#1A1A1A]">Payout schedule: </span>
          Payouts are processed weekly via direct deposit, every Friday for the prior week's approved sessions.
        </p>
      </div>
    </div>
  );
}

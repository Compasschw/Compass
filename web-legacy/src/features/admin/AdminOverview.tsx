import { useQuery } from '@tanstack/react-query';
import {
  Users,
  HeartHandshake,
  ClipboardList,
  Calendar,
  FileCheck2,
  DollarSign,
  TrendingUp,
  Activity,
} from 'lucide-react';
import type { AdminStats } from './adminTypes';
import { adminFetch } from './adminApi';
import { formatUSD } from './adminFormatters';

// ─── Stat card types ──────────────────────────────────────────────────────────

type StatVariant = 'blue' | 'green' | 'amber' | 'teal';

interface StatCardConfig {
  label: string;
  value: (s: AdminStats) => string | number;
  icon: React.ElementType;
  variant: StatVariant;
}

const STAT_CARDS: StatCardConfig[] = [
  {
    label: 'Total CHWs',
    value: (s) => s.total_chws.toLocaleString(),
    icon: HeartHandshake,
    variant: 'blue',
  },
  {
    label: 'Total Members',
    value: (s) => s.total_members.toLocaleString(),
    icon: Users,
    variant: 'blue',
  },
  {
    label: 'Open Requests',
    value: (s) => s.open_requests.toLocaleString(),
    icon: ClipboardList,
    variant: 'blue',
  },
  {
    label: 'Sessions This Week',
    value: (s) => s.sessions_this_week.toLocaleString(),
    icon: Calendar,
    variant: 'teal',
  },
  {
    label: 'All-Time Sessions',
    value: (s) => s.total_sessions_all_time.toLocaleString(),
    icon: Activity,
    variant: 'teal',
  },
  {
    label: 'Claims Pending',
    value: (s) => s.claims_pending.toLocaleString(),
    icon: FileCheck2,
    variant: 'amber',
  },
  {
    label: 'Claims Paid This Month',
    value: (s) => s.claims_paid_this_month.toLocaleString(),
    icon: FileCheck2,
    variant: 'green',
  },
  {
    label: 'Earnings This Month',
    value: (s) => formatUSD(s.total_earnings_this_month),
    icon: DollarSign,
    variant: 'green',
  },
  {
    label: 'Platform Revenue (est.)',
    value: (s) => formatUSD(s.total_earnings_this_month * 0.15),
    icon: TrendingUp,
    variant: 'green',
  },
];

// ─── Variant styles ───────────────────────────────────────────────────────────

const variantStyles: Record<StatVariant, { bg: string; iconBg: string; iconColor: string }> = {
  blue: {
    bg: 'bg-white',
    iconBg: 'bg-[rgba(0,119,182,0.1)]',
    iconColor: 'text-[#0077B6]',
  },
  green: {
    bg: 'bg-white',
    iconBg: 'bg-[rgba(107,143,113,0.12)]',
    iconColor: 'text-[#6B8F71]',
  },
  amber: {
    bg: 'bg-white',
    iconBg: 'bg-[rgba(217,119,6,0.1)]',
    iconColor: 'text-[#D97706]',
  },
  teal: {
    bg: 'bg-white',
    iconBg: 'bg-[rgba(20,184,166,0.1)]',
    iconColor: 'text-[#0D9488]',
  },
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCardSkeleton() {
  return (
    <div className="bg-white rounded-[16px] border border-[rgba(44,62,45,0.06)] p-5 animate-pulse">
      <div className="flex items-start justify-between mb-4">
        <div className="w-10 h-10 rounded-[10px] bg-[rgba(44,62,45,0.06)]" />
      </div>
      <div className="h-8 w-24 bg-[rgba(44,62,45,0.06)] rounded mb-2" />
      <div className="h-4 w-32 bg-[rgba(44,62,45,0.04)] rounded" />
    </div>
  );
}

interface StatCardProps {
  label: string;
  displayValue: string | number;
  icon: React.ElementType;
  variant: StatVariant;
}

function StatCard({ label, displayValue, icon: Icon, variant }: StatCardProps) {
  const styles = variantStyles[variant];
  return (
    <div className={`${styles.bg} rounded-[16px] border border-[rgba(44,62,45,0.06)] p-5`}>
      <div className="flex items-start justify-between mb-4">
        <div className={`w-10 h-10 rounded-[10px] ${styles.iconBg} flex items-center justify-center`}>
          <Icon size={20} className={styles.iconColor} aria-hidden="true" />
        </div>
      </div>
      <p className="text-2xl font-bold text-[#2C3E2D] leading-none mb-1">
        {displayValue}
      </p>
      <p className="text-sm text-[#6B7B6D]">{label}</p>
    </div>
  );
}

// ─── Overview page ────────────────────────────────────────────────────────────

/**
 * Admin overview — renders 8 aggregate stat cards.
 * Refetches every 30 seconds.
 */
export function AdminOverview() {
  const { data, isLoading, isError, error, dataUpdatedAt } = useQuery<AdminStats>({
    queryKey: ['admin', 'stats'],
    queryFn: () => adminFetch<AdminStats>('/stats'),
    refetchInterval: 30_000,
  });

  const lastUpdated = dataUpdatedAt
    ? new Date(dataUpdatedAt).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
      })
    : null;

  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-[#2C3E2D]">Overview</h1>
          <p className="text-sm text-[#6B7B6D] mt-0.5">
            Live marketplace metrics{lastUpdated ? ` · updated ${lastUpdated}` : ''}
          </p>
        </div>
      </div>

      {/* Error state */}
      {isError && (
        <div
          role="alert"
          className="mb-6 p-4 rounded-[12px] bg-red-50 border border-red-200 text-sm text-red-700"
        >
          Failed to load stats:{' '}
          {error instanceof Error ? error.message : 'Unknown error'}
        </div>
      )}

      {/* Stat grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {isLoading
          ? Array.from({ length: 9 }).map((_, i) => <StatCardSkeleton key={i} />)
          : STAT_CARDS.map((card) => (
              <StatCard
                key={card.label}
                label={card.label}
                displayValue={data ? card.value(data) : '—'}
                icon={card.icon}
                variant={card.variant}
              />
            ))}
      </div>
    </div>
  );
}

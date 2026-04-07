import type { ReactNode } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface StatCardProps {
  /** Lucide icon element or any ReactNode */
  icon: ReactNode;
  label: string;
  value: string | number;
  /** Optional supporting line beneath the value */
  subtext?: string;
  /** Tailwind background colour class applied to the icon container */
  iconBg?: string;
  className?: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Displays a single metric with an icon, label, value, and optional subtext.
 * Used on dashboards and summary screens across both CHW and Member views.
 */
export function StatCard({
  icon,
  label,
  value,
  subtext,
  iconBg = 'bg-[#D0F0D0]',
  className = '',
}: StatCardProps) {
  return (
    <div
      className={`bg-white rounded-[12px] shadow-sm border border-[#E5E7EB] p-4 flex items-start gap-3 ${className}`}
    >
      <div
        className={`${iconBg} rounded-[8px] p-2.5 flex items-center justify-center shrink-0`}
        aria-hidden="true"
      >
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-xs text-[#AAAAAA] font-medium uppercase tracking-wide truncate">
          {label}
        </p>
        <p className="text-xl font-semibold text-[#1A1A1A] leading-tight mt-0.5">
          {value}
        </p>
        {subtext && (
          <p className="text-xs text-[#555555] mt-0.5 truncate">{subtext}</p>
        )}
      </div>
    </div>
  );
}

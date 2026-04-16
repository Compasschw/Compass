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
  iconBg = 'bg-[rgba(107,143,113,0.15)]',
  className = '',
}: StatCardProps) {
  return (
    <div
      className={`bg-white rounded-[20px] shadow-sm border border-[rgba(44,62,45,0.1)] p-4 flex items-start gap-3 ${className}`}
    >
      <div
        className={`${iconBg} rounded-[12px] p-2.5 flex items-center justify-center shrink-0`}
        aria-hidden="true"
      >
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-xs text-[#8B9B8D] font-medium uppercase tracking-wide truncate">
          {label}
        </p>
        <p className="text-xl font-semibold text-[#2C3E2D] leading-tight mt-0.5">
          {value}
        </p>
        {subtext && (
          <p className="text-xs text-[#555555] mt-0.5 truncate">{subtext}</p>
        )}
      </div>
    </div>
  );
}

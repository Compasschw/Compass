/**
 * Formatting utilities specific to the admin dashboard.
 * Hand-rolled — no date-fns dependency.
 */

/** Format a number as USD with 2 decimal places: $1,234.56 */
export function formatUSD(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/** Format an ISO datetime or date string as "Apr 23, 2026" */
export function formatAbsoluteDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Format an ISO datetime string as a relative label ("2h ago", "3d ago").
 * Falls back to the absolute date for anything older than 7 days.
 */
export function formatRelativeDate(iso: string | null): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  const nowMs = Date.now();
  const diffMs = nowMs - then;

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(diffMs / 86_400_000);
  if (days < 7) return `${days}d ago`;

  return formatAbsoluteDate(iso);
}

/** Capitalise the first letter of a string (e.g. status labels). */
export function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

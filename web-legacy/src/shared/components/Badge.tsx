import type { Vertical, Urgency, SessionStatus, RequestStatus } from '../../data/mock';

// ─── Types ────────────────────────────────────────────────────────────────────

type BadgeVariant =
  | 'vertical'
  | 'urgency'
  | 'session-status'
  | 'request-status';

interface BadgeProps {
  variant: BadgeVariant;
  value: Vertical | Urgency | SessionStatus | RequestStatus;
  className?: string;
}

// ─── Color maps ───────────────────────────────────────────────────────────────

const verticalStyles: Record<Vertical, string> = {
  housing: 'bg-amber-100 text-amber-800',
  rehab: 'bg-purple-100 text-purple-800',
  food: 'bg-orange-100 text-orange-800',
  mental_health: 'bg-pink-100 text-pink-800',
  healthcare: 'bg-blue-100 text-blue-800',
};

const verticalLabels: Record<Vertical, string> = {
  housing: 'Housing',
  rehab: 'Rehab',
  food: 'Food Security',
  mental_health: 'Mental Health',
  healthcare: 'Healthcare',
};

const urgencyStyles: Record<Urgency, string> = {
  routine: 'bg-gray-100 text-gray-700',
  soon: 'bg-yellow-100 text-yellow-800',
  urgent: 'bg-red-100 text-red-700',
};

const urgencyLabels: Record<Urgency, string> = {
  routine: 'Routine',
  soon: 'Soon',
  urgent: 'Urgent',
};

const sessionStatusStyles: Record<SessionStatus, string> = {
  scheduled: 'bg-blue-100 text-blue-700',
  in_progress: 'bg-green-100 text-green-700',
  completed: 'bg-gray-100 text-gray-600',
  cancelled: 'bg-red-100 text-red-600',
};

const sessionStatusLabels: Record<SessionStatus, string> = {
  scheduled: 'Scheduled',
  in_progress: 'In Progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

const requestStatusStyles: Record<RequestStatus, string> = {
  open: 'bg-blue-100 text-blue-700',
  matched: 'bg-green-100 text-green-700',
  completed: 'bg-gray-100 text-gray-600',
  cancelled: 'bg-red-100 text-red-600',
};

const requestStatusLabels: Record<RequestStatus, string> = {
  open: 'Open',
  matched: 'Matched',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveStyles(variant: BadgeVariant, value: string): string {
  switch (variant) {
    case 'vertical':
      return verticalStyles[value as Vertical] ?? 'bg-gray-100 text-gray-700';
    case 'urgency':
      return urgencyStyles[value as Urgency] ?? 'bg-gray-100 text-gray-700';
    case 'session-status':
      return sessionStatusStyles[value as SessionStatus] ?? 'bg-gray-100 text-gray-700';
    case 'request-status':
      return requestStatusStyles[value as RequestStatus] ?? 'bg-gray-100 text-gray-700';
  }
}

function resolveLabel(variant: BadgeVariant, value: string): string {
  switch (variant) {
    case 'vertical':
      return verticalLabels[value as Vertical] ?? value;
    case 'urgency':
      return urgencyLabels[value as Urgency] ?? value;
    case 'session-status':
      return sessionStatusLabels[value as SessionStatus] ?? value;
    case 'request-status':
      return requestStatusLabels[value as RequestStatus] ?? value;
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Small pill badge for verticals, urgency levels, and status values.
 * Colour-coded consistently throughout the app.
 */
export function Badge({ variant, value, className = '' }: BadgeProps) {
  const styles = resolveStyles(variant, value);
  const label = resolveLabel(variant, value);

  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${styles} ${className}`}
    >
      {label}
    </span>
  );
}

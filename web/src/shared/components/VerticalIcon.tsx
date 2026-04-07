import {
  Home,
  RefreshCw,
  ShoppingBasket,
  Brain,
  Stethoscope,
  type LucideIcon,
} from 'lucide-react';
import type { Vertical } from '../../data/mock';

// ─── Types ────────────────────────────────────────────────────────────────────

interface VerticalIconProps {
  vertical: Vertical;
  /** Pixel size passed to lucide's `size` prop. Defaults to 20. */
  size?: number;
  className?: string;
}

// ─── Mapping ──────────────────────────────────────────────────────────────────

const iconMap: Record<Vertical, LucideIcon> = {
  housing: Home,
  rehab: RefreshCw,
  food: ShoppingBasket,
  mental_health: Brain,
  healthcare: Stethoscope,
};

const colorMap: Record<Vertical, string> = {
  housing: 'text-amber-600',
  rehab: 'text-purple-600',
  food: 'text-orange-500',
  mental_health: 'text-pink-600',
  healthcare: 'text-[#0077B6]',
};

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Renders the appropriate lucide icon for a given social-determinants vertical,
 * with a consistent colour coding used across the entire app.
 */
export function VerticalIcon({ vertical, size = 20, className = '' }: VerticalIconProps) {
  const Icon = iconMap[vertical];
  const colorClass = colorMap[vertical];

  return (
    <Icon
      size={size}
      className={`${colorClass} ${className}`}
      aria-hidden="true"
    />
  );
}

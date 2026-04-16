/**
 * VerticalIcon — renders the lucide-react-native icon for a social-determinants
 * vertical with the canonical colour coding used across the entire app.
 *
 * Single source of truth — eliminates the inline VERTICAL_COLORS / icon maps
 * duplicated across individual screens.
 */

import React from 'react';
import {
  Home,
  RefreshCw,
  ShoppingBasket,
  Brain,
  Stethoscope,
} from 'lucide-react-native';
import type { Vertical } from '../../data/mock';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VerticalIconProps {
  vertical: Vertical;
  /** Icon size in dp. Defaults to 20. */
  size?: number;
  /** Override colour. Falls back to the canonical vertical colour. */
  color?: string;
}

// ─── Mappings ─────────────────────────────────────────────────────────────────

type LucideRNComponent = React.ComponentType<{ size?: number; color?: string }>;

const iconMap: Record<Vertical, LucideRNComponent> = {
  housing:       Home,
  rehab:         RefreshCw,
  food:          ShoppingBasket,
  mental_health: Brain,
  healthcare:    Stethoscope,
};

/** Canonical colours — matches the web VerticalIcon and Badge components. */
export const verticalColors: Record<Vertical, string> = {
  housing:       '#D97706', // amber-600
  rehab:         '#9333EA', // purple-600
  food:          '#F97316', // orange-500
  mental_health: '#DB2777', // pink-600
  healthcare:    '#2563EB', // blue-600
};

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Renders the vertical-specific lucide icon at the given size.
 */
export function VerticalIcon({
  vertical,
  size = 20,
  color,
}: VerticalIconProps): React.JSX.Element {
  const Icon = iconMap[vertical];
  const resolvedColor = color ?? verticalColors[vertical];

  return <Icon size={size} color={resolvedColor} />;
}

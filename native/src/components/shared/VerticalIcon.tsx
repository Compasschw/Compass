/**
 * VerticalIcon — renders the lucide-react-native icon for a social-determinants
 * vertical with the canonical colour coding used across the entire app.
 *
 * Colours and icon selection delegate to lib/verticals.ts — single source of
 * truth. If you need to change a colour or swap an icon, do it there.
 */

import React from 'react';
import {
  Home,
  Bus,
  ShoppingBasket,
  Brain,
  Stethoscope,
  Briefcase,
} from 'lucide-react-native';
import type { Vertical } from '../../data/mock';
import { VERTICAL_COLOR } from '../../lib/verticals';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VerticalIconProps {
  vertical: Vertical;
  /** Icon size in dp. Defaults to 20. */
  size?: number;
  /** Override colour. Falls back to the canonical vertical colour from lib/verticals. */
  color?: string;
}

// ─── Mappings ─────────────────────────────────────────────────────────────────

type LucideRNComponent = React.ComponentType<{ size?: number; color?: string }>;

const iconMap: Record<Vertical, LucideRNComponent> = {
  housing:        Home,
  transportation: Bus,
  food:           ShoppingBasket,
  mental_health:  Brain,
  healthcare:     Stethoscope,
  employment:     Briefcase,
};

/**
 * Canonical colours — sourced from lib/verticals.ts.
 *
 * Re-exported for legacy callers that imported `verticalColors` directly from
 * this component. New code should import VERTICAL_COLOR from lib/verticals.
 *
 * @deprecated Import VERTICAL_COLOR from lib/verticals.ts instead.
 */
export const verticalColors: Record<Vertical, string> = VERTICAL_COLOR as Record<Vertical, string>;

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
  const resolvedColor = color ?? VERTICAL_COLOR[vertical];

  return <Icon size={size} color={resolvedColor} />;
}

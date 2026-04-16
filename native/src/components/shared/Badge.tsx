/**
 * Badge — small pill label for verticals, urgency levels, and status values.
 *
 * Single source of truth for colour coding across the entire app.
 * Maps to the web Badge component's colour palette.
 */

import React from 'react';
import { View, Text, StyleSheet, type ViewStyle, type TextStyle } from 'react-native';
import type { Vertical, Urgency, SessionStatus, RequestStatus } from '../../data/mock';

// ─── Types ────────────────────────────────────────────────────────────────────

export type BadgeVariant =
  | 'vertical'
  | 'urgency'
  | 'session-status'
  | 'request-status'
  | 'billing-status';

export interface BadgeProps {
  variant: BadgeVariant;
  value: string;
  style?: ViewStyle;
}

// ─── Colour tokens ────────────────────────────────────────────────────────────

interface BadgeTokens {
  bg: string;
  text: string;
}

const verticalTokens: Record<Vertical, BadgeTokens> = {
  housing:      { bg: '#FEF3C7', text: '#92400E' }, // amber-100 / amber-800
  rehab:        { bg: '#F3E8FF', text: '#6B21A8' }, // purple-100 / purple-800
  food:         { bg: '#FFEDD5', text: '#9A3412' }, // orange-100 / orange-800
  mental_health:{ bg: '#FCE7F3', text: '#9D174D' }, // pink-100 / pink-800
  healthcare:   { bg: '#DBEAFE', text: '#1E40AF' }, // blue-100 / blue-800
};

const urgencyTokens: Record<Urgency, BadgeTokens> = {
  routine: { bg: '#F3F4F6', text: '#374151' }, // gray-100 / gray-700
  soon:    { bg: '#FEF9C3', text: '#854D0E' }, // yellow-100 / yellow-800
  urgent:  { bg: '#FEE2E2', text: '#B91C1C' }, // red-100 / red-700
};

const sessionStatusTokens: Record<SessionStatus, BadgeTokens> = {
  scheduled:   { bg: '#DBEAFE', text: '#1D4ED8' }, // blue-100 / blue-700
  in_progress: { bg: '#DCFCE7', text: '#15803D' }, // green-100 / green-700
  completed:   { bg: '#F3F4F6', text: '#4B5563' }, // gray-100 / gray-600
  cancelled:   { bg: '#FEE2E2', text: '#DC2626' }, // red-100 / red-600
};

const requestStatusTokens: Record<RequestStatus, BadgeTokens> = {
  open:      { bg: '#DBEAFE', text: '#1D4ED8' }, // blue-100 / blue-700
  matched:   { bg: '#DCFCE7', text: '#15803D' }, // green-100 / green-700
  completed: { bg: '#F3F4F6', text: '#4B5563' }, // gray-100 / gray-600
  cancelled: { bg: '#FEE2E2', text: '#DC2626' }, // red-100 / red-600
};

const billingStatusTokens: Record<string, BadgeTokens> = {
  pending:   { bg: '#FEF3C7', text: '#92400E' }, // amber-100 / amber-800
  submitted: { bg: '#DBEAFE', text: '#1D4ED8' }, // blue-100 / blue-700
  approved:  { bg: '#DCFCE7', text: '#15803D' }, // green-100 / green-700
};

// ─── Label maps ───────────────────────────────────────────────────────────────

const verticalLabels: Record<Vertical, string> = {
  housing:       'Housing',
  rehab:         'Rehab',
  food:          'Food Security',
  mental_health: 'Mental Health',
  healthcare:    'Healthcare',
};

const urgencyLabels: Record<Urgency, string> = {
  routine: 'Routine',
  soon:    'Soon',
  urgent:  'Urgent',
};

const sessionStatusLabels: Record<SessionStatus, string> = {
  scheduled:   'Scheduled',
  in_progress: 'In Progress',
  completed:   'Completed',
  cancelled:   'Cancelled',
};

const requestStatusLabels: Record<RequestStatus, string> = {
  open:      'Open',
  matched:   'Matched',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

const billingStatusLabels: Record<string, string> = {
  pending:   'Pending',
  submitted: 'Submitted',
  approved:  'Approved',
};

// ─── Fallback ─────────────────────────────────────────────────────────────────

const fallbackTokens: BadgeTokens = { bg: '#F3F4F6', text: '#374151' };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveTokens(variant: BadgeVariant, value: string): BadgeTokens {
  switch (variant) {
    case 'vertical':
      return verticalTokens[value as Vertical] ?? fallbackTokens;
    case 'urgency':
      return urgencyTokens[value as Urgency] ?? fallbackTokens;
    case 'session-status':
      return sessionStatusTokens[value as SessionStatus] ?? fallbackTokens;
    case 'request-status':
      return requestStatusTokens[value as RequestStatus] ?? fallbackTokens;
    case 'billing-status':
      return billingStatusTokens[value] ?? fallbackTokens;
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
    case 'billing-status':
      return billingStatusLabels[value] ?? value;
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Renders a small pill badge with consistent colour coding.
 */
export function Badge({ variant, value, style }: BadgeProps): React.JSX.Element {
  const tokens = resolveTokens(variant, value);
  const label = resolveLabel(variant, value);

  const pillStyle: ViewStyle = {
    ...styles.pill,
    backgroundColor: tokens.bg,
  };

  const labelStyle: TextStyle = {
    ...styles.label,
    color: tokens.text,
  };

  return (
    <View style={[pillStyle, style]}>
      <Text style={labelStyle}>{label}</Text>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  pill: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 9999,
  } as ViewStyle,
  label: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.2,
  } as TextStyle,
});

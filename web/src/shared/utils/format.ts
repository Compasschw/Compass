/**
 * Shared formatting utilities for the Compass CHW frontend.
 * Centralizes currency, date, and billing formatting to eliminate duplication.
 */

/** Medi-Cal reimbursement rate per 15-minute unit */
export const MEDI_CAL_RATE = 26.66;

/** CHW net payout rate after platform + Pear Suite fees (Phase 1) */
export const NET_PAYOUT_RATE = 0.85;

/** Format a number as USD currency (e.g., "$26.66") */
export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(amount);
}

/** Format an ISO date string to a readable date (e.g., "April 8, 2026") */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Format an ISO date string to a short date (e.g., "Apr 8") */
export function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

/** Calculate net earnings for a given number of units */
export function calculateNetEarnings(units: number): number {
  return units * MEDI_CAL_RATE * NET_PAYOUT_RATE;
}

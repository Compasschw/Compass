import { api } from "./client";

export interface EarningsData {
  this_month: number;
  all_time: number;
  avg_rating: number;
  sessions_this_week: number;
  pending_payout: number;
}

export interface CHWBrowseData {
  id: string;
  user_id: string;
  name: string;
  specializations: string[];
  languages: string[];
  rating: number;
  years_experience: number;
  total_sessions: number;
  is_available: boolean;
  bio: string | null;
  zip_code: string | null;
}

export const fetchChwEarnings = (): Promise<EarningsData> => api("/chw/earnings");
export const fetchChwBrowse = (vertical?: string): Promise<CHWBrowseData[]> =>
  api("/chw/browse" + (vertical ? `?vertical=${vertical}` : ""));

/**
 * Per-claim row returned by GET /chw/claims. Used by CHWSessions and
 * CHWEarnings to render real per-session billing status (replacing the
 * hardcoded sess-002/003/004 mock map).
 */
export interface ChwClaimData {
  id: string;
  session_id: string | null;
  procedure_code: string;
  units: number;
  gross_amount: number;
  platform_fee: number;
  pear_suite_fee: number | null;
  net_payout: number;
  status: 'pending' | 'submitted' | 'paid' | 'rejected' | string;
  service_date: string | null;
  submitted_at: string | null;
  paid_at: string | null;
  created_at: string | null;
}

export const fetchChwClaims = (): Promise<ChwClaimData[]> => api("/chw/claims");

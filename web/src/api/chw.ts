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

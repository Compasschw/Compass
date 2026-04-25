/**
 * Shared TypeScript interfaces for admin dashboard API responses.
 * Field names mirror the Python Pydantic schemas in backend/app/schemas/admin.py.
 * No PHI fields are present — the backend enforces HIPAA exclusions at schema level.
 */

export interface AdminStats {
  total_chws: number;
  total_members: number;
  open_requests: number;
  sessions_this_week: number;
  claims_pending: number;
  claims_paid_this_month: number;
  total_earnings_this_month: number;
  total_sessions_all_time: number;
}

export interface CHWAdminItem {
  id: string;
  user_id: string;
  name: string;
  email: string;
  phone: string | null;
  specializations: string[];
  languages: string[];
  zip_code: string | null;
  rating: number;
  years_experience: number;
  is_available: boolean;
  total_sessions: number;
  created_at: string;
}

export interface MemberAdminItem {
  id: string;
  user_id: string;
  name: string;
  email: string;
  phone: string | null;
  zip_code: string | null;
  primary_language: string;
  primary_need: string | null;
  rewards_balance: number;
  created_at: string;
}

export interface RequestAdminItem {
  id: string;
  member_name: string | null;
  matched_chw_name: string | null;
  vertical: string;
  urgency: string;
  description: string;
  preferred_mode: string;
  status: string;
  estimated_units: number;
  created_at: string;
}

export interface SessionAdminItem {
  id: string;
  chw_name: string | null;
  member_name: string | null;
  vertical: string;
  status: string;
  mode: string;
  scheduled_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_minutes: number | null;
  units_billed: number | null;
  net_amount: number | null;
  created_at: string;
}

export interface ClaimAdminItem {
  id: string;
  chw_name: string | null;
  member_name: string | null;
  procedure_code: string;
  units: number;
  gross_amount: number;
  platform_fee: number;
  pear_suite_fee: number | null;
  net_payout: number;
  status: string;
  service_date: string | null;
  submitted_at: string | null;
  paid_at: string | null;
}

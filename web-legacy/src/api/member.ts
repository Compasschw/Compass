import { api } from './client';

/**
 * Member-side API client.
 *
 * The legacy public surface (waitlist, marketing) doesn't need this — only
 * authenticated member screens (onboarding, profile editor, request list).
 */

export interface MemberProfileResponse {
  id: string;
  user_id: string;
  zip_code: string | null;
  primary_language: string;
  primary_need: string | null;
  rewards_balance: number;
  insurance_provider: string | null;
  name: string | null;
  phone: string | null;
  email: string | null;
}

export interface MemberProfileUpdate {
  zip_code?: string;
  primary_language?: string;
  primary_need?: string;
  insurance_provider?: string;
  preferred_mode?: string;
  /** Medi-Cal beneficiary identification number — encrypted at rest. */
  medi_cal_id?: string;
}

/** Read the authenticated member's profile (404 if no profile row exists). */
export async function getMemberProfile(): Promise<MemberProfileResponse> {
  return api<MemberProfileResponse>('/member/profile');
}

/**
 * Upsert the authenticated member's profile.
 *
 * The backend creates the row if missing (defensive cover for accounts
 * registered before signup-time profile provisioning landed). Only the
 * fields supplied are written — every field is optional.
 */
export async function updateMemberProfile(
  data: MemberProfileUpdate,
): Promise<MemberProfileResponse> {
  return api<MemberProfileResponse>('/member/profile', {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

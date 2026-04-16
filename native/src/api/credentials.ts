/**
 * Credentials API — submit and review CHW credential validations,
 * and search training institutions.
 *
 * Mirrors the web API contract at /credentials/.
 */

import { api } from './client';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CredentialValidation {
  id: string;
  chw_id: string;
  program_name: string;
  validation_status: string;
  institution_confirmed: boolean;
  created_at: string;
}

export interface InstitutionResult {
  id: string;
  name: string;
  city?: string;
  state?: string;
}

// ─── API functions ────────────────────────────────────────────────────────────

/**
 * Submit a new credential validation request.
 *
 * @param data - Credential payload (program name, document s3_key, etc.).
 */
export function submitCredentialValidation(
  data: Record<string, unknown>,
): Promise<CredentialValidation> {
  return api<CredentialValidation>('/credentials/validate', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

/**
 * Fetch all credential validation records for the current user.
 */
export function fetchValidations(): Promise<CredentialValidation[]> {
  return api<CredentialValidation[]>('/credentials/validations');
}

/**
 * Approve or reject a credential validation (admin / staff only).
 *
 * @param id       - Validation record ID.
 * @param approved - True to approve, false to reject.
 * @param notes    - Optional reviewer notes attached to the decision.
 */
export function reviewValidation(
  id: string,
  approved: boolean,
  notes = '',
): Promise<CredentialValidation> {
  const queryParams = `approved=${approved}&notes=${encodeURIComponent(notes)}`;
  return api<CredentialValidation>(
    `/credentials/validations/${id}/review?${queryParams}`,
    { method: 'PATCH' },
  );
}

/**
 * Search known training institutions by name fragment.
 *
 * @param query - Partial name string to search.
 */
export function searchInstitutions(query: string): Promise<InstitutionResult[]> {
  return api<InstitutionResult[]>(
    `/credentials/institutions?q=${encodeURIComponent(query)}`,
  );
}

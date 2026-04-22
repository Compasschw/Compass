/**
 * Matching API — find CHWs that match a service request's criteria,
 * and browse the CHW roster by vertical.
 *
 * Mirrors the web API contracts at /matching/ and /chw/browse.
 */

import { api } from './client';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MatchResult {
  chw_id: string;
  score: number;
  distance_miles: number;
  /**
   * Short labels explaining why this CHW ranked well, e.g.
   * ["3.2 mi away", "speaks Spanish", "specializes in chronic disease"].
   * The member-facing candidate card renders these as chips.
   */
  match_reasons: string[];
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

export interface FindMatchingChwsParams {
  vertical: string;
  lat?: number;
  lng?: number;
  language?: string;
  /** "in_person" | "remote" | "hybrid" — enables intake-based modality filtering. */
  mode?: string;
  /** "routine" | "soon" | "urgent" — enables urgent-outreach preference. */
  urgency?: string;
}

// ─── API functions ────────────────────────────────────────────────────────────

/**
 * Find CHWs that best match the given service request criteria.
 * Returns scored + distance-ranked results.
 *
 * @param params - Vertical is required; lat/lng and language are optional filters.
 */
export function findMatchingChws(
  params: FindMatchingChwsParams,
): Promise<{ matches: MatchResult[] }> {
  // URLSearchParams is available in the RN Hermes runtime (polyfilled by Expo).
  const qs = new URLSearchParams({ vertical: params.vertical });

  if (params.lat !== undefined) qs.set('lat', String(params.lat));
  if (params.lng !== undefined) qs.set('lng', String(params.lng));
  if (params.language) qs.set('language', params.language);
  if (params.mode) qs.set('mode', params.mode);
  if (params.urgency) qs.set('urgency', params.urgency);

  return api<{ matches: MatchResult[] }>(`/matching/chws?${qs.toString()}`);
}

/**
 * Browse the CHW roster, optionally filtered by vertical.
 *
 * @param vertical - Optional vertical slug to filter results.
 */
export function fetchChwBrowse(vertical?: string): Promise<CHWBrowseData[]> {
  const path = vertical ? `/chw/browse?vertical=${vertical}` : '/chw/browse';
  return api<CHWBrowseData[]>(path);
}

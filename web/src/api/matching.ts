import { api } from "./client";

export interface MatchResult { chw_id: string; score: number; distance_miles: number; }

export function findMatchingChws(params: { vertical: string; lat?: number; lng?: number; language?: string }) {
  const qs = new URLSearchParams({ vertical: params.vertical });
  if (params.lat) qs.set("lat", String(params.lat));
  if (params.lng) qs.set("lng", String(params.lng));
  if (params.language) qs.set("language", params.language);
  return api<{ matches: MatchResult[] }>("/matching/chws?" + qs.toString());
}

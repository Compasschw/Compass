/**
 * testimonials.ts — API calls for the Testimonials feature.
 *
 * Endpoints consumed:
 *   POST /api/v1/sessions/{session_id}/testimonials       — member submit
 *   GET  /api/v1/chws/{chw_id}/testimonials               — public list (approved only)
 *   GET  /api/v1/chws/{chw_id}/testimonials/summary       — aggregate stats
 *   GET  /api/v1/admin/testimonials                       — admin moderation queue
 *   POST /api/v1/admin/testimonials/{id}/moderate         — admin approve/reject
 *
 * Snake-case API response fields are converted to camelCase at the boundary
 * via `transformKeys`. This is consistent with the rest of this codebase.
 *
 * The ADMIN_KEY is NOT embedded in this client — admin endpoints in this file
 * are called from AdminTestimonialsScreen which injects the key via the shared
 * `adminApi` helper (or the bearer token from storage when the admin is using
 * a native session). Adjust if the project adds a dedicated admin auth flow.
 */

import { api } from './client';
import { transformKeys, toSnakeCase } from '../utils/caseTransform';

// ─── Types ────────────────────────────────────────────────────────────────────

export type TestimonialStatus = 'pending' | 'approved' | 'rejected';

/** Full testimonial row — returned to the submitting member. */
export interface Testimonial {
  id: string;
  chwId: string;
  memberId: string;
  sessionId: string | null;
  rating: number;
  text: string | null;
  status: TestimonialStatus;
  createdAt: string;
}

/** Privacy-preserving view shown on the public CHW Profile. */
export interface PublicTestimonial {
  id: string;
  rating: number;
  text: string | null;
  /** First letter of the member's first name + "." (e.g. "R."). */
  authorInitial: string;
  createdAt: string;
}

/** Aggregate rating stats for the CHW Profile header widget. */
export interface TestimonialSummary {
  /** Average star rating; null when no approved testimonials exist.
   *  PUBLIC-facing value — use for any rating shown to someone other than
   *  the CHW themselves (e.g. the member-facing CHW profile). */
  ratingAvg: number | null;
  /** Number of approved testimonials contributing to the average. */
  ratingCount: number;
  /** QA-batch #16: average across ALL member post-session ratings
   *  (regardless of admin-moderation approval) — for the CHW's own private
   *  Dashboard "Member satisfaction" snapshot only. Null when
   *  allRatingsCount is 0. Never render this to anyone but the CHW
   *  themselves; approval still gates public display. */
  allRatingsAvg: number | null;
  /** Number of post-session ratings (any approval status) contributing to
   *  allRatingsAvg. */
  allRatingsCount: number;
}

/** Full row enriched with member/CHW names — for admin moderation queue. */
export interface AdminTestimonialView {
  id: string;
  chwId: string;
  chwName: string;
  memberId: string;
  memberName: string;
  sessionId: string | null;
  rating: number;
  text: string | null;
  status: TestimonialStatus;
  moderationNotes: string | null;
  createdAt: string;
  moderatedAt: string | null;
}

export interface TestimonialCreatePayload {
  rating: number;
  text?: string | null;
}

export interface AdminModeratePayload {
  action: 'approve' | 'reject';
  notes?: string | null;
}

// ─── Member endpoint ──────────────────────────────────────────────────────────

/**
 * Submit a star rating and optional text review for a completed session.
 *
 * @throws {ApiError} 403 — caller is not the session's member
 * @throws {ApiError} 422 — session is not completed, or rating out of range
 * @throws {ApiError} 409 — testimonial already exists for this (member, session)
 */
export async function submitTestimonial(
  sessionId: string,
  payload: TestimonialCreatePayload,
): Promise<Testimonial> {
  const raw = await api<Record<string, unknown>>(
    `/sessions/${sessionId}/testimonials`,
    {
      method: 'POST',
      body: JSON.stringify(toSnakeCase(payload)),
    },
  );
  return transformKeys<Testimonial>(raw);
}

// ─── Public endpoints ─────────────────────────────────────────────────────────

/**
 * Fetch the aggregate rating stats for a CHW.
 * Always succeeds — rating_avg is null and count is 0 when no approved testimonials exist.
 */
export async function getTestimonialSummary(chwId: string): Promise<TestimonialSummary> {
  const raw = await api<Record<string, unknown>>(
    `/chws/${chwId}/testimonials/summary`,
  );
  return transformKeys<TestimonialSummary>(raw);
}

/**
 * Fetch approved testimonials for a CHW profile page.
 *
 * @param limit  Max results (default 3 for inline display, up to 50 for "see all").
 * @param offset Pagination offset.
 */
export async function listChwTestimonials(
  chwId: string,
  limit: number = 3,
  offset: number = 0,
): Promise<PublicTestimonial[]> {
  const raw = await api<unknown[]>(
    `/chws/${chwId}/testimonials?limit=${limit}&offset=${offset}`,
  );
  return (raw as Record<string, unknown>[]).map(
    (item) => transformKeys<PublicTestimonial>(item),
  );
}

// ─── Admin endpoints ──────────────────────────────────────────────────────────

/**
 * Fetch the paginated admin moderation queue.
 *
 * @param status   Filter by status. Defaults to 'pending'.
 * @param limit    Max results per page.
 * @param offset   Pagination offset.
 * @param adminKey The ADMIN_KEY bearer token to pass as Authorization.
 */
export async function adminListTestimonials(
  status: TestimonialStatus = 'pending',
  limit: number = 20,
  offset: number = 0,
  adminKey: string,
): Promise<AdminTestimonialView[]> {
  const raw = await api<unknown[]>(
    `/admin/testimonials?status=${status}&limit=${limit}&offset=${offset}`,
    {
      headers: { Authorization: `Bearer ${adminKey}` },
      skipAuth: true,
    },
  );
  return (raw as Record<string, unknown>[]).map(
    (item) => transformKeys<AdminTestimonialView>(item),
  );
}

/**
 * Approve or reject a testimonial.
 *
 * @param testimonialId  The testimonial UUID.
 * @param payload        ``{ action: "approve"|"reject", notes?: string }``
 * @param adminKey       The ADMIN_KEY bearer token.
 */
export async function adminModerateTestimonial(
  testimonialId: string,
  payload: AdminModeratePayload,
  adminKey: string,
): Promise<AdminTestimonialView> {
  const raw = await api<Record<string, unknown>>(
    `/admin/testimonials/${testimonialId}/moderate`,
    {
      method: 'POST',
      body: JSON.stringify(toSnakeCase(payload)),
      headers: { Authorization: `Bearer ${adminKey}` },
      skipAuth: true,
    },
  );
  return transformKeys<AdminTestimonialView>(raw);
}

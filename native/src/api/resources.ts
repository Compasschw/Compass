/**
 * resources.ts — API calls for the CHW Resource Folder.
 *
 * Endpoints consumed:
 *   GET  /api/v1/resources/search          — authenticated search
 *   GET  /api/v1/resources/{id}             — fetch one resource
 *   POST /api/v1/chw/resources/suggestions  — CHW submit suggestion
 *   GET  /api/v1/admin/resources            — admin paginated list
 *   POST /api/v1/admin/resources            — admin create
 *   PATCH /api/v1/admin/resources/{id}      — admin update
 *   DELETE /api/v1/admin/resources/{id}     — admin soft-delete
 *   GET  /api/v1/admin/resources/suggestions        — admin suggestion queue
 *   POST /api/v1/admin/resources/suggestions/{id}/approve — admin approve
 *   POST /api/v1/admin/resources/suggestions/{id}/reject  — admin reject
 *
 * All request/response types are camelCase (transformed from/to snake_case
 * at the boundary — consistent with the rest of the codebase).
 */

import { api } from './client';
import { transformKeys, toSnakeCase } from '../utils/caseTransform';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ResourceCategory =
  | 'housing'
  | 'food'
  | 'mental_health'
  | 'rehab'
  | 'healthcare'
  | 'legal'
  | 'transportation'
  | 'other';

export type ResourceStatus = 'active' | 'inactive';
export type SuggestionStatus = 'pending' | 'approved' | 'rejected';

export interface Resource {
  id: string;
  name: string;
  description: string;
  category: ResourceCategory;
  url: string | null;
  phone: string | null;
  address: string | null;
  zipCode: string | null;
  latitude: number | null;
  longitude: number | null;
  hours: string | null;
  eligibility: string | null;
  languages: string[];
  status: ResourceStatus;
  createdAt: string;
  createdByAdminId?: string | null;
}

export interface ResourceSuggestion {
  id: string;
  chwId: string;
  proposedResource: Record<string, unknown>;
  notes: string | null;
  status: SuggestionStatus;
  reviewedByAdminId: string | null;
  createdAt: string;
  reviewedAt: string | null;
}

export interface PaginatedResources {
  items: Resource[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PaginatedSuggestions {
  items: ResourceSuggestion[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ResourceSearchParams {
  q?: string;
  category?: ResourceCategory;
  zipCode?: string;
  limit?: number;
}

export interface AdminResourceListParams {
  category?: ResourceCategory;
  status?: ResourceStatus;
  q?: string;
  page?: number;
  pageSize?: number;
}

export interface ResourceCreatePayload {
  name: string;
  description: string;
  category: ResourceCategory;
  url?: string | null;
  phone?: string | null;
  address?: string | null;
  zipCode?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  hours?: string | null;
  eligibility?: string | null;
  languages?: string[];
}

export interface ResourceUpdatePayload {
  name?: string;
  description?: string;
  category?: ResourceCategory;
  url?: string | null;
  phone?: string | null;
  address?: string | null;
  zipCode?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  hours?: string | null;
  eligibility?: string | null;
  languages?: string[];
  status?: ResourceStatus;
}

export interface SuggestionCreatePayload {
  proposedResource: Record<string, unknown>;
  notes?: string | null;
}

export interface SuggestionApprovePayload {
  name?: string;
  description?: string;
  category?: ResourceCategory;
  phone?: string | null;
  url?: string | null;
  address?: string | null;
  zipCode?: string | null;
  hours?: string | null;
  eligibility?: string | null;
  languages?: string[];
}

export interface SuggestionRejectPayload {
  adminNotes?: string | null;
}

// ─── Response transformer ─────────────────────────────────────────────────────

/** Convert a raw snake_case API response to camelCase. */
function toResource(raw: Record<string, unknown>): Resource {
  return transformKeys<Resource>(raw);
}

function toSuggestion(raw: Record<string, unknown>): ResourceSuggestion {
  return transformKeys<ResourceSuggestion>(raw);
}

// ─── Public / CHW endpoints ───────────────────────────────────────────────────

/**
 * Search active resources. Returns up to ``limit`` ranked results.
 * Authenticates with the stored user JWT (any role).
 */
export async function searchResources(
  params: ResourceSearchParams,
): Promise<Resource[]> {
  const query = new URLSearchParams();
  if (params.q) query.set('q', params.q);
  if (params.category) query.set('category', params.category);
  if (params.zipCode) query.set('zip_code', params.zipCode);
  if (params.limit != null) query.set('limit', String(params.limit));

  const qs = query.toString();
  const url = `/resources/search${qs ? `?${qs}` : ''}`;
  const res = await api(url);
  if (!res.ok) throw new Error(`Resource search failed: ${res.status}`);
  const data = (await res.json()) as unknown[];
  return data.map((r) => toResource(r as Record<string, unknown>));
}

/**
 * Fetch a single resource by UUID.
 * Returns null if the resource is not found (404).
 * Inactive resources are still returned (for @-mention token resolution).
 */
export async function getResourceById(resourceId: string): Promise<Resource | null> {
  const res = await api(`/resources/${resourceId}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Fetch resource failed: ${res.status}`);
  return toResource((await res.json()) as Record<string, unknown>);
}

/**
 * CHW submits a resource suggestion for admin review.
 * Requires CHW role; will throw ApiError 403 for other roles.
 */
export async function createResourceSuggestion(
  payload: SuggestionCreatePayload,
): Promise<ResourceSuggestion> {
  const body = toSnakeCase({
    proposedResource: payload.proposedResource,
    notes: payload.notes ?? null,
  });
  const res = await api('/chw/resources/suggestions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new Error(err.detail ?? `Create suggestion failed: ${res.status}`);
  }
  return toSuggestion((await res.json()) as Record<string, unknown>);
}

// ─── Admin endpoints ───────────────────────────────────────────────────────────

/**
 * Paginated admin resource list.
 * Authenticates with the stored user JWT (admin role expected by the caller).
 * Note: The admin resource endpoints use the ADMIN_KEY bearer in the web
 * admin dashboard, but in the native admin screen we pass the user JWT and
 * rely on the admin role check. This is intentional for the native context.
 *
 * If the project later gates these strictly behind the raw ADMIN_KEY, the
 * caller will pass it explicitly via the Authorization header override.
 */
export async function adminListResources(
  params: AdminResourceListParams = {},
): Promise<PaginatedResources> {
  const query = new URLSearchParams();
  if (params.category) query.set('category', params.category);
  if (params.status) query.set('status', params.status);
  if (params.q) query.set('q', params.q);
  if (params.page != null) query.set('page', String(params.page));
  if (params.pageSize != null) query.set('page_size', String(params.pageSize));

  const qs = query.toString();
  const url = `/admin/resources${qs ? `?${qs}` : ''}`;
  const res = await api(url);
  if (!res.ok) throw new Error(`Admin list resources failed: ${res.status}`);

  const raw = (await res.json()) as {
    items: Record<string, unknown>[];
    total: number;
    page: number;
    page_size: number;
  };
  return {
    items: raw.items.map(toResource),
    total: raw.total,
    page: raw.page,
    pageSize: raw.page_size,
  };
}

/** Admin create resource. */
export async function adminCreateResource(
  payload: ResourceCreatePayload,
): Promise<Resource> {
  const body = toSnakeCase(payload as unknown as Record<string, unknown>);
  const res = await api('/admin/resources', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new Error(err.detail ?? `Create resource failed: ${res.status}`);
  }
  return toResource((await res.json()) as Record<string, unknown>);
}

/** Admin partial update resource. */
export async function adminUpdateResource(
  resourceId: string,
  payload: ResourceUpdatePayload,
): Promise<Resource> {
  const body = toSnakeCase(payload as unknown as Record<string, unknown>);
  const res = await api(`/admin/resources/${resourceId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new Error(err.detail ?? `Update resource failed: ${res.status}`);
  }
  return toResource((await res.json()) as Record<string, unknown>);
}

/** Admin soft-delete resource (sets status=inactive). */
export async function adminDeleteResource(resourceId: string): Promise<void> {
  const res = await api(`/admin/resources/${resourceId}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 204) {
    throw new Error(`Delete resource failed: ${res.status}`);
  }
}

/** Admin suggestion queue. */
export async function adminListSuggestions(
  status: SuggestionStatus = 'pending',
  page = 1,
  pageSize = 20,
): Promise<PaginatedSuggestions> {
  const query = new URLSearchParams({
    status,
    page: String(page),
    page_size: String(pageSize),
  });
  const res = await api(`/admin/resources/suggestions?${query}`);
  if (!res.ok) throw new Error(`List suggestions failed: ${res.status}`);

  const raw = (await res.json()) as {
    items: Record<string, unknown>[];
    total: number;
    page: number;
    page_size: number;
  };
  return {
    items: raw.items.map(toSuggestion),
    total: raw.total,
    page: raw.page,
    pageSize: raw.page_size,
  };
}

/** Admin approve suggestion → creates a new Resource row. */
export async function adminApproveSuggestion(
  suggestionId: string,
  overrides: SuggestionApprovePayload = {},
): Promise<Resource> {
  const body = toSnakeCase(overrides as unknown as Record<string, unknown>);
  const res = await api(`/admin/resources/suggestions/${suggestionId}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new Error(err.detail ?? `Approve suggestion failed: ${res.status}`);
  }
  return toResource((await res.json()) as Record<string, unknown>);
}

/** Admin reject suggestion. */
export async function adminRejectSuggestion(
  suggestionId: string,
  adminNotes?: string,
): Promise<ResourceSuggestion> {
  const body = toSnakeCase({ adminNotes: adminNotes ?? null });
  const res = await api(`/admin/resources/suggestions/${suggestionId}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new Error(err.detail ?? `Reject suggestion failed: ${res.status}`);
  }
  return toSuggestion((await res.json()) as Record<string, unknown>);
}

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
 *
 * Transport notes: `api()` resolves with the parsed JSON body on 2xx
 * (an empty object on 204) and throws {@link ApiError} on any non-2xx
 * response, with the server's `detail` message attached.
 */

import { api, ApiError } from './client';
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

// ─── Wire types (snake_case payloads as returned by the API) ─────────────────

/** Raw snake_case resource row as returned by the API. */
interface ResourceWire {
  id: string;
  name: string;
  description: string;
  category: ResourceCategory;
  url: string | null;
  phone: string | null;
  address: string | null;
  zip_code: string | null;
  latitude: number | null;
  longitude: number | null;
  hours: string | null;
  eligibility: string | null;
  languages: string[];
  status: ResourceStatus;
  created_at: string;
  created_by_admin_id?: string | null;
}

/** Raw snake_case suggestion row as returned by the API. */
interface ResourceSuggestionWire {
  id: string;
  chw_id: string;
  proposed_resource: Record<string, unknown>;
  notes: string | null;
  status: SuggestionStatus;
  reviewed_by_admin_id: string | null;
  created_at: string;
  reviewed_at: string | null;
}

/** Generic snake_case pagination envelope used by the admin list endpoints. */
interface PaginatedWire<TItem> {
  items: TItem[];
  total: number;
  page: number;
  page_size: number;
}

// ─── Response transformers ────────────────────────────────────────────────────

/** Convert a raw snake_case API resource to the camelCase domain shape. */
function toResource(raw: ResourceWire): Resource {
  return transformKeys<Resource>(raw);
}

/** Convert a raw snake_case API suggestion to the camelCase domain shape. */
function toSuggestion(raw: ResourceSuggestionWire): ResourceSuggestion {
  return transformKeys<ResourceSuggestion>(raw);
}

// ─── Public / CHW endpoints ───────────────────────────────────────────────────

/**
 * Search active resources. Returns up to ``limit`` ranked results.
 * Authenticates with the stored user JWT (any role).
 *
 * @throws {ApiError} on any non-2xx response.
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
  const data = await api<ResourceWire[]>(url);
  return data.map(toResource);
}

/**
 * Fetch a single resource by UUID.
 * Returns null if the resource is not found (404).
 * Inactive resources are still returned (for @-mention token resolution).
 *
 * @throws {ApiError} on any non-2xx response other than 404.
 */
export async function getResourceById(resourceId: string): Promise<Resource | null> {
  try {
    const raw = await api<ResourceWire>(`/resources/${resourceId}`);
    return toResource(raw);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/**
 * CHW submits a resource suggestion for admin review.
 * Requires CHW role; will throw ApiError 403 for other roles.
 */
export async function createResourceSuggestion(
  payload: SuggestionCreatePayload,
): Promise<ResourceSuggestion> {
  const body = toSnakeCase<Record<string, unknown>>({
    proposedResource: payload.proposedResource,
    notes: payload.notes ?? null,
  });
  const raw = await api<ResourceSuggestionWire>('/chw/resources/suggestions', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return toSuggestion(raw);
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
 *
 * @throws {ApiError} on any non-2xx response.
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
  const raw = await api<PaginatedWire<ResourceWire>>(url);
  return {
    items: raw.items.map(toResource),
    total: raw.total,
    page: raw.page,
    pageSize: raw.page_size,
  };
}

/**
 * Admin create resource.
 *
 * @throws {ApiError} on any non-2xx response (detail message from the server).
 */
export async function adminCreateResource(
  payload: ResourceCreatePayload,
): Promise<Resource> {
  const body = toSnakeCase<Record<string, unknown>>(payload);
  const raw = await api<ResourceWire>('/admin/resources', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return toResource(raw);
}

/**
 * Admin partial update resource.
 *
 * @throws {ApiError} on any non-2xx response (detail message from the server).
 */
export async function adminUpdateResource(
  resourceId: string,
  payload: ResourceUpdatePayload,
): Promise<Resource> {
  const body = toSnakeCase<Record<string, unknown>>(payload);
  const raw = await api<ResourceWire>(`/admin/resources/${resourceId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  return toResource(raw);
}

/**
 * Admin soft-delete resource (sets status=inactive).
 * `api()` resolves on 2xx (including 204 No Content) and throws otherwise.
 *
 * @throws {ApiError} on any non-2xx response.
 */
export async function adminDeleteResource(resourceId: string): Promise<void> {
  await api<void>(`/admin/resources/${resourceId}`, { method: 'DELETE' });
}

/**
 * Admin suggestion queue.
 *
 * @throws {ApiError} on any non-2xx response.
 */
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
  const raw = await api<PaginatedWire<ResourceSuggestionWire>>(
    `/admin/resources/suggestions?${query}`,
  );
  return {
    items: raw.items.map(toSuggestion),
    total: raw.total,
    page: raw.page,
    pageSize: raw.page_size,
  };
}

/**
 * Admin approve suggestion → creates a new Resource row.
 *
 * @throws {ApiError} on any non-2xx response (detail message from the server).
 */
export async function adminApproveSuggestion(
  suggestionId: string,
  overrides: SuggestionApprovePayload = {},
): Promise<Resource> {
  const body = toSnakeCase<Record<string, unknown>>(overrides);
  const raw = await api<ResourceWire>(
    `/admin/resources/suggestions/${suggestionId}/approve`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  );
  return toResource(raw);
}

/**
 * Admin reject suggestion.
 *
 * @throws {ApiError} on any non-2xx response (detail message from the server).
 */
export async function adminRejectSuggestion(
  suggestionId: string,
  adminNotes?: string,
): Promise<ResourceSuggestion> {
  const body = toSnakeCase<Record<string, unknown>>({ adminNotes: adminNotes ?? null });
  const raw = await api<ResourceSuggestionWire>(
    `/admin/resources/suggestions/${suggestionId}/reject`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  );
  return toSuggestion(raw);
}

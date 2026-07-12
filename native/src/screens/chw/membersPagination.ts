/**
 * Pure pagination for the CHW "My Members" roster.
 *
 * Kept in its own module (no react-native imports) so the pagination math is
 * unit-tested in the node env without dragging in the whole screen. Consumed
 * by CHWMembersScreen's roster body.
 */

/** Members shown per page before the roster paginates. */
export const MEMBERS_PAGE_SIZE = 10;

/**
 * Slice a list into one 1-indexed page. ``page`` is clamped into
 * ``[1, totalPages]`` so an out-of-range page (e.g. after the list shrinks or
 * the filter changes) never yields an empty view.
 */
export function paginateMembers<T>(
  items: readonly T[],
  page: number,
  pageSize: number = MEMBERS_PAGE_SIZE,
): { pageItems: T[]; page: number; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(Math.max(1, Math.floor(page)), totalPages);
  const start = (safePage - 1) * pageSize;
  return { pageItems: items.slice(start, start + pageSize), page: safePage, totalPages };
}

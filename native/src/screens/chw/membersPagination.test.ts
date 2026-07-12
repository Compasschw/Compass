/**
 * Unit tests for paginateMembers — the pure pagination math behind the CHW
 * "My Members" roster (10 per page; controls only appear past one page).
 *
 * Tier 1 (node env): imports only the pure helper, no react-native.
 */
import { describe, it, expect } from 'vitest';

import { MEMBERS_PAGE_SIZE, paginateMembers } from './membersPagination';

const makeList = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);

describe('paginateMembers', () => {
  it('MEMBERS_PAGE_SIZE is 10', () => {
    expect(MEMBERS_PAGE_SIZE).toBe(10);
  });

  it('returns the whole list on one page when at/under the page size', () => {
    const r = paginateMembers(makeList(10), 1);
    expect(r.totalPages).toBe(1);
    expect(r.pageItems).toHaveLength(10);
  });

  it('splits every 10 members onto a new page', () => {
    const list = makeList(25);
    expect(paginateMembers(list, 1).totalPages).toBe(3);
    expect(paginateMembers(list, 1).pageItems).toEqual(makeList(10)); // 1..10
    expect(paginateMembers(list, 2).pageItems).toEqual(makeList(20).slice(10)); // 11..20
    expect(paginateMembers(list, 3).pageItems).toEqual([21, 22, 23, 24, 25]);
  });

  it('clamps an out-of-range page into [1, totalPages]', () => {
    const list = makeList(25);
    expect(paginateMembers(list, 99).page).toBe(3);
    expect(paginateMembers(list, 99).pageItems).toEqual([21, 22, 23, 24, 25]);
    expect(paginateMembers(list, 0).page).toBe(1);
    expect(paginateMembers(list, -5).page).toBe(1);
  });

  it('never yields an empty view for a non-empty list', () => {
    const r = paginateMembers(makeList(11), 5);
    expect(r.pageItems.length).toBeGreaterThan(0);
    expect(r.page).toBe(2);
  });

  it('handles an empty list (one page, no items)', () => {
    const r = paginateMembers([], 1);
    expect(r.totalPages).toBe(1);
    expect(r.pageItems).toEqual([]);
    expect(r.page).toBe(1);
  });
});

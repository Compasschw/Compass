import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import type { WaitlistAdminItem } from './adminTypes';
import { adminFetch } from './adminApi';
import {
  TableContainer,
  TableSkeleton,
  EmptyTableState,
  ErrorTableState,
  Pagination,
  PageHeader,
  SearchInput,
  StatusBadge,
} from './adminTableUtils';

const PAGE_SIZE = 50;

interface WaitlistListResponse {
  items: WaitlistAdminItem[];
  total: number;
}

/**
 * Admin Waitlist page — paginated list of pre-launch signups from the landing
 * page. Reads from `GET /api/v1/admin/waitlist/entries` (admin key + 2FA
 * required). Client-side search filters the current page by name, email, or
 * role; CSV export emits the current page's filtered rows.
 */
export function WaitlistAdmin() {
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');

  const { data, isLoading, isError, error, isFetching, refetch } =
    useQuery<WaitlistListResponse>({
      queryKey: ['admin', 'waitlist', page],
      queryFn: () =>
        adminFetch<WaitlistListResponse>('/waitlist/entries', {
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        }),
      placeholderData: (prev) => prev,
    });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  const filtered = search.trim()
    ? items.filter((entry) => {
        const q = search.toLowerCase();
        const fullName = `${entry.first_name} ${entry.last_name}`.toLowerCase();
        return (
          fullName.includes(q) ||
          entry.email.toLowerCase().includes(q) ||
          entry.role.toLowerCase().includes(q)
        );
      })
    : items;

  function handlePageChange(newPage: number) {
    setPage(newPage);
    setSearch('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function exportCSV() {
    if (filtered.length === 0) return;
    const header = ['First Name', 'Last Name', 'Email', 'Role', 'Signed Up At'];
    const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const rows = filtered.map((entry) =>
      [
        entry.first_name,
        entry.last_name,
        entry.email,
        entry.role,
        entry.created_at,
      ]
        .map(escape)
        .join(','),
    );
    const csv = [header.map(escape).join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `compass-waitlist-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <PageHeader
        title="Waitlist"
        subtitle={isLoading ? 'Loading…' : `${total.toLocaleString()} signed up`}
        actions={
          <>
            <SearchInput
              id="waitlist-search"
              label="Search waitlist by name, email, or role"
              value={search}
              placeholder="Search name / email / role"
              onChange={setSearch}
            />
            <button
              type="button"
              onClick={exportCSV}
              disabled={filtered.length === 0 || isLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] bg-[#2C3E2D] text-white text-sm font-medium hover:bg-[#1F2D20] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              aria-label="Export current page as CSV"
            >
              <Download size={14} aria-hidden="true" />
              Export CSV
            </button>
          </>
        }
      />

      <TableContainer>
        {isLoading ? (
          <TableSkeleton rows={10} cols={5} />
        ) : isError ? (
          <ErrorTableState
            message={
              error instanceof Error ? error.message : 'Failed to load waitlist'
            }
            onRetry={() => {
              void refetch();
            }}
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-[rgba(44,62,45,0.08)]">
                    {['Name', 'Email', 'Role', 'Signed Up'].map((col) => (
                      <th
                        key={col}
                        scope="col"
                        className="px-4 py-3 text-left text-xs font-semibold text-[#2C3E2D] uppercase tracking-wide whitespace-nowrap"
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 ? (
                    <tr>
                      <td colSpan={4}>
                        <EmptyTableState
                          message={
                            search
                              ? `No signups match "${search}" on this page.`
                              : 'No waitlist signups yet. Share the landing page!'
                          }
                        />
                      </td>
                    </tr>
                  ) : (
                    filtered.map((entry, i) => (
                      <tr
                        key={entry.id}
                        className={`border-b border-[rgba(44,62,45,0.04)] hover:bg-[#FBF7F0] transition-colors ${
                          isFetching ? 'opacity-60' : ''
                        } ${i % 2 === 1 ? 'bg-[rgba(44,62,45,0.01)]' : ''}`}
                      >
                        <td className="px-4 py-3 font-medium text-[#2C3E2D] whitespace-nowrap">
                          {`${entry.first_name} ${entry.last_name}`.trim() ||
                            '—'}
                        </td>
                        <td className="px-4 py-3 text-[#555555]">
                          <a
                            href={`mailto:${entry.email}`}
                            className="hover:underline"
                          >
                            {entry.email}
                          </a>
                        </td>
                        <td className="px-4 py-3">
                          <StatusBadge status={entry.role} />
                        </td>
                        <td className="px-4 py-3 text-[#555555] whitespace-nowrap">
                          {new Date(entry.created_at).toLocaleString()}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <Pagination
              page={page}
              pageSize={PAGE_SIZE}
              totalItems={total}
              onPageChange={handlePageChange}
              isLoading={isFetching}
            />
          </>
        )}
      </TableContainer>
    </div>
  );
}

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, XCircle } from 'lucide-react';
import type { CHWAdminItem } from './adminTypes';
import { adminFetch } from './adminApi';
import {
  Chip,
  TableContainer,
  TableSkeleton,
  EmptyTableState,
  ErrorTableState,
  Pagination,
  PageHeader,
  SearchInput,
} from './adminTableUtils';

const PAGE_SIZE = 50;

interface CHWListResponse {
  items: CHWAdminItem[];
  total: number;
}

/**
 * Admin CHWs page — paginated table with client-side search by name/email.
 */
export function AdminCHWs() {
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');

  const { data, isLoading, isError, error, isFetching, refetch } = useQuery<CHWListResponse>({
    queryKey: ['admin', 'chws', page],
    queryFn: () =>
      adminFetch<CHWListResponse>('/chws', {
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
    placeholderData: (prev) => prev,
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  // Client-side filter on the current page by name or email
  const filtered = search.trim()
    ? items.filter((chw) => {
        const q = search.toLowerCase();
        return (
          chw.name.toLowerCase().includes(q) ||
          chw.email.toLowerCase().includes(q)
        );
      })
    : items;

  function handlePageChange(newPage: number) {
    setPage(newPage);
    setSearch('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  return (
    <div>
      <PageHeader
        title="Community Health Workers"
        subtitle={isLoading ? 'Loading…' : `${total.toLocaleString()} registered`}
        actions={
          <SearchInput
            id="chw-search"
            label="Search CHWs by name or email"
            value={search}
            placeholder="Search name / email"
            onChange={setSearch}
          />
        }
      />

      <TableContainer>
        {isLoading ? (
          <TableSkeleton rows={10} cols={8} />
        ) : isError ? (
          <ErrorTableState
            message={error instanceof Error ? error.message : 'Failed to load CHWs'}
            onRetry={() => { void refetch(); }}
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-[rgba(44,62,45,0.08)]">
                    {[
                      'Name',
                      'Email',
                      'Phone',
                      'Zip',
                      'Specializations',
                      'Languages',
                      'Rating',
                      'Yrs Exp',
                      'Available',
                      'Sessions',
                    ].map((col) => (
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
                      <td colSpan={10}>
                        <EmptyTableState
                          message={
                            search
                              ? `No CHWs match "${search}" on this page.`
                              : 'No CHWs found.'
                          }
                        />
                      </td>
                    </tr>
                  ) : (
                    filtered.map((chw, i) => (
                      <tr
                        key={chw.id}
                        className={`border-b border-[rgba(44,62,45,0.04)] hover:bg-[#FBF7F0] transition-colors ${
                          isFetching ? 'opacity-60' : ''
                        } ${i % 2 === 1 ? 'bg-[rgba(44,62,45,0.01)]' : ''}`}
                      >
                        <td className="px-4 py-3 font-medium text-[#2C3E2D] whitespace-nowrap">
                          {chw.name}
                        </td>
                        <td className="px-4 py-3 text-[#555555]">{chw.email}</td>
                        <td className="px-4 py-3 text-[#555555] whitespace-nowrap">
                          {chw.phone ?? '—'}
                        </td>
                        <td className="px-4 py-3 text-[#555555] whitespace-nowrap">
                          {chw.zip_code ?? '—'}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap max-w-[180px]">
                            {chw.specializations.length > 0
                              ? chw.specializations.map((s) => (
                                  <Chip key={s} label={s} />
                                ))
                              : <span className="text-[#8B9B8D]">—</span>}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap max-w-[140px]">
                            {chw.languages.length > 0
                              ? chw.languages.map((l) => <Chip key={l} label={l} />)
                              : <span className="text-[#8B9B8D]">—</span>}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-[#555555] whitespace-nowrap">
                          {chw.rating.toFixed(1)}
                        </td>
                        <td className="px-4 py-3 text-[#555555] text-center">
                          {chw.years_experience}
                        </td>
                        <td className="px-4 py-3 text-center">
                          {chw.is_available ? (
                            <CheckCircle2
                              size={16}
                              className="text-[#6B8F71] mx-auto"
                              aria-label="Available"
                            />
                          ) : (
                            <XCircle
                              size={16}
                              className="text-[#8B9B8D] mx-auto"
                              aria-label="Unavailable"
                            />
                          )}
                        </td>
                        <td className="px-4 py-3 text-[#555555] text-right pr-5">
                          {chw.total_sessions.toLocaleString()}
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

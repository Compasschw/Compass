import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { MemberAdminItem } from './adminTypes';
import { adminFetch } from './adminApi';
import {
  TableContainer,
  TableSkeleton,
  EmptyTableState,
  ErrorTableState,
  Pagination,
  PageHeader,
  SearchInput,
} from './adminTableUtils';

const PAGE_SIZE = 50;

interface MemberListResponse {
  items: MemberAdminItem[];
  total: number;
}

/**
 * Admin Members page — paginated table with client-side search by name/email.
 * Rewards balance is displayed as integer points (not currency).
 */
export function AdminMembers() {
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');

  const { data, isLoading, isError, error, isFetching, refetch } = useQuery<MemberListResponse>({
    queryKey: ['admin', 'members', page],
    queryFn: () =>
      adminFetch<MemberListResponse>('/members', {
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
    placeholderData: (prev) => prev,
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  const filtered = search.trim()
    ? items.filter((m) => {
        const q = search.toLowerCase();
        return (
          m.name.toLowerCase().includes(q) ||
          m.email.toLowerCase().includes(q)
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
        title="Members"
        subtitle={isLoading ? 'Loading…' : `${total.toLocaleString()} registered`}
        actions={
          <SearchInput
            id="member-search"
            label="Search members by name or email"
            value={search}
            placeholder="Search name / email"
            onChange={setSearch}
          />
        }
      />

      <TableContainer>
        {isLoading ? (
          <TableSkeleton rows={10} cols={7} />
        ) : isError ? (
          <ErrorTableState
            message={error instanceof Error ? error.message : 'Failed to load members'}
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
                      'Primary Language',
                      'Primary Need',
                      'Rewards Pts',
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
                      <td colSpan={7}>
                        <EmptyTableState
                          message={
                            search
                              ? `No members match "${search}" on this page.`
                              : 'No members found.'
                          }
                        />
                      </td>
                    </tr>
                  ) : (
                    filtered.map((member, i) => (
                      <tr
                        key={member.id}
                        className={`border-b border-[rgba(44,62,45,0.04)] hover:bg-[#FBF7F0] transition-colors ${
                          isFetching ? 'opacity-60' : ''
                        } ${i % 2 === 1 ? 'bg-[rgba(44,62,45,0.01)]' : ''}`}
                      >
                        <td className="px-4 py-3 font-medium text-[#2C3E2D] whitespace-nowrap">
                          {member.name}
                        </td>
                        <td className="px-4 py-3 text-[#555555]">{member.email}</td>
                        <td className="px-4 py-3 text-[#555555] whitespace-nowrap">
                          {member.phone ?? '—'}
                        </td>
                        <td className="px-4 py-3 text-[#555555] whitespace-nowrap">
                          {member.zip_code ?? '—'}
                        </td>
                        <td className="px-4 py-3 text-[#555555] whitespace-nowrap">
                          {member.primary_language}
                        </td>
                        <td className="px-4 py-3 text-[#555555]">
                          {member.primary_need ?? '—'}
                        </td>
                        <td className="px-4 py-3 text-right pr-5 text-[#555555] font-medium whitespace-nowrap">
                          {member.rewards_balance.toLocaleString()}
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

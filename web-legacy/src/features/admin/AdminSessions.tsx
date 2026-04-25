import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SessionAdminItem } from './adminTypes';
import { adminFetch } from './adminApi';
import { formatAbsoluteDate, formatUSD } from './adminFormatters';
import {
  StatusBadge,
  TableContainer,
  TableSkeleton,
  EmptyTableState,
  ErrorTableState,
  Pagination,
  PageHeader,
  FilterSelect,
} from './adminTableUtils';

const PAGE_SIZE = 50;

type StatusFilter = 'all' | 'scheduled' | 'in_progress' | 'completed' | 'cancelled';

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All statuses' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

interface SessionListResponse {
  items: SessionAdminItem[];
  total: number;
}

/**
 * Admin Sessions page — paginated table with server-side status filter.
 */
export function AdminSessions() {
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const { data, isLoading, isError, error, isFetching, refetch } =
    useQuery<SessionListResponse>({
      queryKey: ['admin', 'sessions', page, statusFilter],
      queryFn: () => {
        const params: Record<string, string | number> = {
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        };
        if (statusFilter !== 'all') params['status'] = statusFilter;
        return adminFetch<SessionListResponse>('/sessions', params);
      },
      placeholderData: (prev) => prev,
    });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  function handleStatusChange(value: string) {
    setStatusFilter(value as StatusFilter);
    setPage(0);
  }

  function handlePageChange(newPage: number) {
    setPage(newPage);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  return (
    <div>
      <PageHeader
        title="Sessions"
        subtitle={isLoading ? 'Loading…' : `${total.toLocaleString()} matching`}
        actions={
          <FilterSelect
            id="session-status-filter"
            label="Status"
            value={statusFilter}
            options={STATUS_OPTIONS}
            onChange={handleStatusChange}
          />
        }
      />

      <TableContainer>
        {isLoading ? (
          <TableSkeleton rows={10} cols={9} />
        ) : isError ? (
          <ErrorTableState
            message={error instanceof Error ? error.message : 'Failed to load sessions'}
            onRetry={() => { void refetch(); }}
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-[rgba(44,62,45,0.08)]">
                    {[
                      'Scheduled',
                      'CHW',
                      'Member',
                      'Vertical',
                      'Mode',
                      'Status',
                      'Duration (min)',
                      'Units',
                      'Net $',
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
                  {items.length === 0 ? (
                    <tr>
                      <td colSpan={9}>
                        <EmptyTableState message="No sessions found for the selected filter." />
                      </td>
                    </tr>
                  ) : (
                    items.map((session, i) => (
                      <tr
                        key={session.id}
                        className={`border-b border-[rgba(44,62,45,0.04)] hover:bg-[#FBF7F0] transition-colors ${
                          isFetching ? 'opacity-60' : ''
                        } ${i % 2 === 1 ? 'bg-[rgba(44,62,45,0.01)]' : ''}`}
                      >
                        <td className="px-4 py-3 text-[#6B7B6D] whitespace-nowrap text-xs">
                          {formatAbsoluteDate(session.scheduled_at)}
                        </td>
                        <td className="px-4 py-3 font-medium text-[#2C3E2D] whitespace-nowrap">
                          {session.chw_name ?? '—'}
                        </td>
                        <td className="px-4 py-3 text-[#555555] whitespace-nowrap">
                          {session.member_name ?? '—'}
                        </td>
                        <td className="px-4 py-3 text-[#555555] whitespace-nowrap">
                          {session.vertical}
                        </td>
                        <td className="px-4 py-3 text-[#555555] whitespace-nowrap">
                          {session.mode}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <StatusBadge status={session.status} />
                        </td>
                        <td className="px-4 py-3 text-[#555555] text-right">
                          {session.duration_minutes ?? '—'}
                        </td>
                        <td className="px-4 py-3 text-[#555555] text-right">
                          {session.units_billed ?? '—'}
                        </td>
                        <td className="px-4 py-3 text-right pr-5 font-medium text-[#2C3E2D] whitespace-nowrap">
                          {session.net_amount !== null
                            ? formatUSD(session.net_amount)
                            : '—'}
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

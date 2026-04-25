import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { RequestAdminItem } from './adminTypes';
import { adminFetch } from './adminApi';
import { formatRelativeDate } from './adminFormatters';
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

type StatusFilter = 'all' | 'open' | 'matched' | 'completed';

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All statuses' },
  { value: 'open', label: 'Open' },
  { value: 'matched', label: 'Matched' },
  { value: 'completed', label: 'Completed' },
];

interface RequestListResponse {
  items: RequestAdminItem[];
  total: number;
}

/** Truncated description with click-to-expand. */
function DescriptionCell({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const LIMIT = 80;
  if (text.length <= LIMIT || expanded) {
    return (
      <span>
        {text}
        {expanded && text.length > LIMIT && (
          <button
            onClick={() => setExpanded(false)}
            className="ml-1 text-xs text-[#0077B6] hover:underline focus:outline-none focus:underline"
          >
            less
          </button>
        )}
      </span>
    );
  }
  return (
    <span>
      {text.slice(0, LIMIT)}…
      <button
        onClick={() => setExpanded(true)}
        className="ml-1 text-xs text-[#0077B6] hover:underline focus:outline-none focus:underline"
        aria-label="Expand description"
      >
        more
      </button>
    </span>
  );
}

/**
 * Admin Requests page — paginated table with server-side status filter.
 */
export function AdminRequests() {
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const { data, isLoading, isError, error, isFetching, refetch } =
    useQuery<RequestListResponse>({
      queryKey: ['admin', 'requests', page, statusFilter],
      queryFn: () => {
        const params: Record<string, string | number> = {
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        };
        if (statusFilter !== 'all') params['status'] = statusFilter;
        return adminFetch<RequestListResponse>('/requests', params);
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
        title="Service Requests"
        subtitle={isLoading ? 'Loading…' : `${total.toLocaleString()} matching`}
        actions={
          <FilterSelect
            id="request-status-filter"
            label="Status"
            value={statusFilter}
            options={STATUS_OPTIONS}
            onChange={handleStatusChange}
          />
        }
      />

      <TableContainer>
        {isLoading ? (
          <TableSkeleton rows={10} cols={8} />
        ) : isError ? (
          <ErrorTableState
            message={error instanceof Error ? error.message : 'Failed to load requests'}
            onRetry={() => { void refetch(); }}
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-[rgba(44,62,45,0.08)]">
                    {[
                      'Created',
                      'Member',
                      'Matched CHW',
                      'Vertical',
                      'Urgency',
                      'Mode',
                      'Units',
                      'Status',
                      'Description',
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
                        <EmptyTableState message="No requests found for the selected filter." />
                      </td>
                    </tr>
                  ) : (
                    items.map((req, i) => (
                      <tr
                        key={req.id}
                        className={`border-b border-[rgba(44,62,45,0.04)] hover:bg-[#FBF7F0] transition-colors ${
                          isFetching ? 'opacity-60' : ''
                        } ${i % 2 === 1 ? 'bg-[rgba(44,62,45,0.01)]' : ''}`}
                      >
                        <td className="px-4 py-3 text-[#6B7B6D] whitespace-nowrap text-xs">
                          {formatRelativeDate(req.created_at)}
                        </td>
                        <td className="px-4 py-3 font-medium text-[#2C3E2D] whitespace-nowrap">
                          {req.member_name ?? '—'}
                        </td>
                        <td className="px-4 py-3 text-[#555555] whitespace-nowrap">
                          {req.matched_chw_name ?? '—'}
                        </td>
                        <td className="px-4 py-3 text-[#555555] whitespace-nowrap">
                          {req.vertical}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <StatusBadge status={req.urgency} />
                        </td>
                        <td className="px-4 py-3 text-[#555555] whitespace-nowrap">
                          {req.preferred_mode}
                        </td>
                        <td className="px-4 py-3 text-[#555555] text-right">
                          {req.estimated_units}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <StatusBadge status={req.status} />
                        </td>
                        <td className="px-4 py-3 text-[#6B7B6D] max-w-[240px]">
                          <DescriptionCell text={req.description} />
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

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ClaimAdminItem } from './adminTypes';
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

type StatusFilter = 'all' | 'pending' | 'submitted' | 'paid' | 'denied';

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'submitted', label: 'Submitted' },
  { value: 'paid', label: 'Paid' },
  { value: 'denied', label: 'Denied' },
];

interface ClaimListResponse {
  items: ClaimAdminItem[];
  total: number;
}

/**
 * Admin Claims page — paginated billing claims table with status filter.
 * No diagnosis codes are shown (excluded at schema level per HIPAA).
 */
export function AdminClaims() {
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const { data, isLoading, isError, error, isFetching, refetch } =
    useQuery<ClaimListResponse>({
      queryKey: ['admin', 'claims', page, statusFilter],
      queryFn: () => {
        const params: Record<string, string | number> = {
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        };
        if (statusFilter !== 'all') params['status'] = statusFilter;
        return adminFetch<ClaimListResponse>('/claims', params);
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
        title="Billing Claims"
        subtitle={isLoading ? 'Loading…' : `${total.toLocaleString()} matching`}
        actions={
          <FilterSelect
            id="claim-status-filter"
            label="Status"
            value={statusFilter}
            options={STATUS_OPTIONS}
            onChange={handleStatusChange}
          />
        }
      />

      <TableContainer>
        {isLoading ? (
          <TableSkeleton rows={10} cols={11} />
        ) : isError ? (
          <ErrorTableState
            message={error instanceof Error ? error.message : 'Failed to load claims'}
            onRetry={() => { void refetch(); }}
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-[rgba(44,62,45,0.08)]">
                    {[
                      'Service Date',
                      'CHW',
                      'Member',
                      'Procedure',
                      'Units',
                      'Gross $',
                      'Platform Fee',
                      'Pear Fee',
                      'Net Payout',
                      'Status',
                      'Submitted',
                      'Paid',
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
                      <td colSpan={12}>
                        <EmptyTableState message="No claims found for the selected filter." />
                      </td>
                    </tr>
                  ) : (
                    items.map((claim, i) => (
                      <tr
                        key={claim.id}
                        className={`border-b border-[rgba(44,62,45,0.04)] hover:bg-[#FBF7F0] transition-colors ${
                          isFetching ? 'opacity-60' : ''
                        } ${i % 2 === 1 ? 'bg-[rgba(44,62,45,0.01)]' : ''}`}
                      >
                        <td className="px-4 py-3 text-[#6B7B6D] whitespace-nowrap text-xs">
                          {formatAbsoluteDate(claim.service_date)}
                        </td>
                        <td className="px-4 py-3 font-medium text-[#2C3E2D] whitespace-nowrap">
                          {claim.chw_name ?? '—'}
                        </td>
                        <td className="px-4 py-3 text-[#555555] whitespace-nowrap">
                          {claim.member_name ?? '—'}
                        </td>
                        <td className="px-4 py-3 text-[#555555] font-mono text-xs whitespace-nowrap">
                          {claim.procedure_code}
                        </td>
                        <td className="px-4 py-3 text-[#555555] text-right">
                          {claim.units}
                        </td>
                        <td className="px-4 py-3 text-right text-[#555555] whitespace-nowrap">
                          {formatUSD(claim.gross_amount)}
                        </td>
                        <td className="px-4 py-3 text-right text-[#555555] whitespace-nowrap">
                          {formatUSD(claim.platform_fee)}
                        </td>
                        <td className="px-4 py-3 text-right text-[#555555] whitespace-nowrap">
                          {claim.pear_suite_fee !== null
                            ? formatUSD(claim.pear_suite_fee)
                            : '—'}
                        </td>
                        <td className="px-4 py-3 text-right font-semibold text-[#6B8F71] whitespace-nowrap">
                          {formatUSD(claim.net_payout)}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <StatusBadge status={claim.status} />
                        </td>
                        <td className="px-4 py-3 text-[#6B7B6D] whitespace-nowrap text-xs">
                          {formatAbsoluteDate(claim.submitted_at)}
                        </td>
                        <td className="px-4 py-3 text-[#6B7B6D] whitespace-nowrap text-xs">
                          {formatAbsoluteDate(claim.paid_at)}
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

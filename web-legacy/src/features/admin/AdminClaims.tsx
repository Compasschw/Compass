import { useCallback, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdminClaimStatusResponse, ClaimAdminItem } from './adminTypes';
import { adminFetch, adminPatch, AdminApiError } from './adminApi';
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

type ToastVariant = 'success' | 'warning' | 'error';

interface Toast {
  variant: ToastVariant;
  message: string;
}

/**
 * Allowed forward transitions per the backend validator (admin.py).
 *
 *   pending   → submitted | paid | rejected
 *   submitted → paid | rejected
 *   paid      → (terminal)
 *   rejected  → (terminal)
 *
 * Reverting to `pending` is intentionally not allowed; the operator must
 * request a fresh documentation submission instead.
 */
function nextStatusOptions(current: string): Array<'submitted' | 'paid' | 'rejected'> {
  const lower = current.toLowerCase();
  if (lower === 'pending') return ['submitted', 'paid', 'rejected'];
  if (lower === 'submitted') return ['paid', 'rejected'];
  return [];
}

const NEXT_STATUS_LABELS: Record<'submitted' | 'paid' | 'rejected', string> = {
  submitted: 'Mark Submitted',
  paid: 'Mark Paid',
  rejected: 'Mark Rejected',
};

/**
 * Admin Claims page — paginated billing claims table with status filter
 * and per-row status-advance actions. No diagnosis codes are shown
 * (excluded at schema level per HIPAA).
 *
 * Status-advance actions hit `PATCH /api/v1/admin/claims/{id}/status` and
 * surface the response (especially `payout_triggered` /
 * `payout_blocked_reason`) via a transient banner so operators know if a
 * Stripe transfer fired.
 */
export function AdminClaims() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [toast, setToast] = useState<Toast | null>(null);
  const [pendingClaimId, setPendingClaimId] = useState<string | null>(null);

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

  const advanceStatus = useMutation<
    AdminClaimStatusResponse,
    Error,
    { claimId: string; status: 'submitted' | 'paid' | 'rejected' }
  >({
    mutationFn: ({ claimId, status }) =>
      adminPatch<AdminClaimStatusResponse>(`/claims/${claimId}/status`, { status }),
    onMutate: ({ claimId }) => {
      setPendingClaimId(claimId);
      setToast(null);
    },
    onSuccess: (response) => {
      if (response.status === 'paid') {
        if (response.payout_triggered) {
          setToast({
            variant: 'success',
            message: `Claim marked paid — Stripe Transfer initiated to CHW.`,
          });
        } else {
          setToast({
            variant: 'warning',
            message:
              `Claim marked paid, but payout was NOT triggered. Reason: ` +
              `${response.payout_blocked_reason ?? 'unknown'}. ` +
              `Re-run after CHW completes Stripe Connect onboarding.`,
          });
        }
      } else {
        setToast({
          variant: 'success',
          message: `Claim status advanced to ${response.status}.`,
        });
      }
      void queryClient.invalidateQueries({ queryKey: ['admin', 'claims'] });
    },
    onError: (err) => {
      const detail = err instanceof AdminApiError
        ? `(${err.status}) ${err.message}`
        : err.message;
      setToast({
        variant: 'error',
        message: `Status advance failed: ${detail}`,
      });
    },
    onSettled: () => {
      setPendingClaimId(null);
    },
  });

  const handleAdvance = useCallback(
    (claim: ClaimAdminItem, target: 'submitted' | 'paid' | 'rejected') => {
      const phrase =
        target === 'paid'
          ? `mark this claim as PAID (will trigger Stripe Transfer to ${claim.chw_name ?? 'the CHW'})`
          : target === 'rejected'
          ? `mark this claim as REJECTED`
          : `mark this claim as SUBMITTED to Pear Suite`;
      const ok = window.confirm(
        `Are you sure you want to ${phrase}? This action cannot be reverted to "pending".`,
      );
      if (!ok) return;
      advanceStatus.mutate({ claimId: claim.id, status: target });
    },
    [advanceStatus],
  );

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

      {toast && (
        <div
          className={`mb-4 px-4 py-3 rounded-lg border text-sm flex items-start justify-between gap-4 ${
            toast.variant === 'success'
              ? 'border-[rgba(107,143,113,0.4)] bg-[rgba(107,143,113,0.08)] text-[#2C3E2D]'
              : toast.variant === 'warning'
              ? 'border-[rgba(214,158,46,0.4)] bg-[rgba(214,158,46,0.08)] text-[#7A4F00]'
              : 'border-[rgba(192,57,43,0.4)] bg-[rgba(192,57,43,0.08)] text-[#7A1E14]'
          }`}
        >
          <span>{toast.message}</span>
          <button
            type="button"
            onClick={() => setToast(null)}
            className="text-xs font-semibold underline opacity-70 hover:opacity-100"
          >
            Dismiss
          </button>
        </div>
      )}

      <TableContainer>
        {isLoading ? (
          <TableSkeleton rows={10} cols={13} />
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
                      'Actions',
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
                      <td colSpan={13}>
                        <EmptyTableState message="No claims found for the selected filter." />
                      </td>
                    </tr>
                  ) : (
                    items.map((claim, i) => {
                      const nextOptions = nextStatusOptions(claim.status);
                      const isThisRowPending = pendingClaimId === claim.id;
                      return (
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
                          <td className="px-4 py-3 whitespace-nowrap">
                            {nextOptions.length === 0 ? (
                              <span className="text-xs text-[#6B7B6D]">—</span>
                            ) : (
                              <div className="flex flex-wrap gap-1.5">
                                {nextOptions.map((target) => (
                                  <button
                                    key={target}
                                    type="button"
                                    disabled={isThisRowPending}
                                    onClick={() => handleAdvance(claim, target)}
                                    className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                                      target === 'paid'
                                        ? 'bg-[#6B8F71] text-white hover:bg-[#5C7E62]'
                                        : target === 'rejected'
                                        ? 'bg-[rgba(192,57,43,0.12)] text-[#7A1E14] hover:bg-[rgba(192,57,43,0.2)]'
                                        : 'bg-[rgba(44,62,45,0.08)] text-[#2C3E2D] hover:bg-[rgba(44,62,45,0.14)]'
                                    }`}
                                  >
                                    {isThisRowPending ? '…' : NEXT_STATUS_LABELS[target]}
                                  </button>
                                ))}
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })
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

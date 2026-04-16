import { useState, useCallback } from 'react';
import { CheckCircle, XCircle, Inbox, Loader2 } from 'lucide-react';
import { Badge } from '../../shared/components/Badge';
import { VerticalIcon } from '../../shared/components/VerticalIcon';
import { formatCurrency, MEDI_CAL_RATE, calculateNetEarnings } from '../../shared/utils/format';
import { useRequests, useAcceptRequest, usePassRequest } from '../../api/hooks';
import type { ServiceRequestData } from '../../api/requests';
import type { Vertical } from '../../data/mock';

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSION_MODE_LABELS: Record<string, string> = {
  in_person: 'In Person',
  virtual: 'Virtual',
  phone: 'Phone',
};

type FilterTab = 'all' | Vertical;

const filterTabs: { key: FilterTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'housing', label: 'Housing' },
  { key: 'food', label: 'Food' },
  { key: 'mental_health', label: 'Mental Health' },
  { key: 'rehab', label: 'Rehab' },
  { key: 'healthcare', label: 'Healthcare' },
];

// ─── Sub-components ───────────────────────────────────────────────────────────

interface ToastProps {
  message: string;
}

function Toast({ message }: ToastProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 bg-[#2C3E2D] text-white text-sm font-medium px-4 py-3 rounded-[20px] shadow-lg"
    >
      <CheckCircle size={16} className="text-[#6B8F71] shrink-0" aria-hidden="true" />
      {message}
    </div>
  );
}

interface RequestCardProps {
  request: ServiceRequestData;
  onAccept: (id: string) => void;
  onPass: (id: string) => void;
}

function RequestCard({ request, onAccept, onPass }: RequestCardProps) {
  const grossEarnings = request.estimated_units * MEDI_CAL_RATE;
  const netEarnings = calculateNetEarnings(request.estimated_units);
  const displayName = request.member_name ?? 'Community Member';

  return (
    <article
      className="bg-white rounded-[20px] border border-[rgba(44,62,45,0.1)] p-4"
      aria-label={`Request from ${displayName}`}
    >
      <div className="flex items-start gap-3">
        {/* Vertical icon */}
        <div
          className="w-10 h-10 rounded-[12px] bg-[#FBF7F0] border border-[rgba(44,62,45,0.1)] flex items-center justify-center shrink-0"
          aria-hidden="true"
        >
          <VerticalIcon vertical={request.vertical as Vertical} size={18} />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {/* Header row */}
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="text-sm font-semibold text-[#2C3E2D]">
              {displayName}
            </span>
            <Badge variant="vertical" value={request.vertical as Vertical} />
            <Badge variant="urgency" value={request.urgency as 'routine' | 'soon' | 'urgent'} />
            <span className="ml-auto text-xs text-[#8B9B8D]">
              {SESSION_MODE_LABELS[request.preferred_mode] ?? request.preferred_mode}
            </span>
          </div>

          {/* Description — 2-line clamp */}
          <p className="text-xs text-[#555555] leading-relaxed line-clamp-2">
            {request.description}
          </p>

          {/* Estimated earnings */}
          <div className="mt-2 flex items-center gap-1.5">
            <span className="text-xs font-medium text-[#6B8F71]">
              ~{request.estimated_units} {request.estimated_units === 1 ? 'unit' : 'units'}
            </span>
            <span className="text-xs text-[#8B9B8D]">·</span>
            <span className="text-xs text-[#555555]">
              {formatCurrency(grossEarnings)} gross
            </span>
            <span className="text-xs text-[#8B9B8D]">·</span>
            <span className="text-xs font-semibold text-[#2C3E2D]">
              {formatCurrency(netEarnings)} net
            </span>
          </div>
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-2 mt-4">
        <button
          type="button"
          onClick={() => onAccept(request.id)}
          className="flex-1 flex items-center justify-center gap-1.5 bg-[#2C3E2D] hover:bg-[#3A5240] active:bg-[#243D25] text-white text-sm font-semibold py-2.5 rounded-[12px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6B8F71]"
          aria-label={`Accept request from ${displayName}`}
        >
          <CheckCircle size={15} aria-hidden="true" />
          Accept
        </button>
        <button
          type="button"
          onClick={() => onPass(request.id)}
          className="flex-1 flex items-center justify-center gap-1.5 bg-white border border-[rgba(44,62,45,0.1)] hover:bg-[#FBF7F0] active:bg-[#F0F0F0] text-[#555555] text-sm font-semibold py-2.5 rounded-[12px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#AAAAAA]"
          aria-label={`Pass on request from ${displayName}`}
        >
          <XCircle size={15} aria-hidden="true" />
          Pass
        </button>
      </div>
    </article>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * CHW Requests page — the inbox for incoming community member service requests.
 *
 * Features:
 * - Filter tabs by vertical category
 * - Per-request earnings estimate (units × $26.66 × 0.85)
 * - Accept / Pass actions with toast feedback
 * - Empty state when no requests match the active filter
 */
export function CHWRequests() {
  const [activeFilter, setActiveFilter] = useState<FilterTab>('all');
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const { data: requests = [], isLoading } = useRequests();
  const acceptMutation = useAcceptRequest();
  const passMutation = usePassRequest();

  // Only show open requests
  const openRequests = requests.filter((r) => r.status === 'open');

  const filteredRequests = openRequests.filter(
    (r) => activeFilter === 'all' || r.vertical === activeFilter,
  );

  const openCount = openRequests.length;

  const showToast = useCallback((message: string) => {
    setToastMessage(message);
    const timer = setTimeout(() => setToastMessage(null), 3000);
    return () => clearTimeout(timer);
  }, []);

  const handleAccept = useCallback(
    (id: string) => {
      const request = requests.find((r) => r.id === id);
      acceptMutation.mutate(id);
      showToast(`Request accepted! Session created for ${request?.member_name ?? 'member'}.`);
    },
    [requests, acceptMutation, showToast],
  );

  const handlePass = useCallback((id: string) => {
    passMutation.mutate(id);
  }, [passMutation]);

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Toast notification */}
      {toastMessage && <Toast message={toastMessage} />}

      {/* Page header */}
      <div className="flex items-center gap-3">
        <h2 className="text-2xl font-semibold text-[#0077B6]">Open Requests</h2>
        {openCount > 0 && (
          <span
            className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-[#2C3E2D] text-white text-xs font-bold"
            aria-label={`${openCount} open requests`}
          >
            {openCount}
          </span>
        )}
      </div>

      {/* Filter tabs — horizontally scrollable on mobile */}
      <div
        role="tablist"
        aria-label="Filter by category"
        className="flex gap-1 overflow-x-auto pb-1 scrollbar-hide -mx-4 px-4 sm:mx-0 sm:px-0"
      >
        {filterTabs.map((tab) => {
          const isActive = activeFilter === tab.key;
          const tabCount =
            tab.key === 'all'
              ? openRequests.length
              : openRequests.filter((r) => r.vertical === tab.key).length;

          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setActiveFilter(tab.key)}
              className={[
                'shrink-0 px-3.5 py-1.5 text-sm font-medium rounded-full border transition-all whitespace-nowrap focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6B8F71]',
                isActive
                  ? 'bg-[#2C3E2D] border-[#6B8F71] text-white'
                  : 'bg-white border-[rgba(44,62,45,0.1)] text-[#555555] hover:border-[#6B8F71] hover:text-[#6B8F71]',
              ].join(' ')}
            >
              {tab.label}
              {tabCount > 0 && (
                <span
                  className={[
                    'ml-1.5 text-xs font-semibold',
                    isActive ? 'text-white/80' : 'text-[#8B9B8D]',
                  ].join(' ')}
                >
                  {tabCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Loading state */}
      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={24} className="animate-spin text-[#6B8F71]" />
          <span className="ml-2 text-sm text-[#8B9B8D]">Loading requests...</span>
        </div>
      )}

      {/* Request list */}
      {!isLoading && filteredRequests.length > 0 ? (
        <section
          aria-label="Filtered requests"
          className="space-y-3"
        >
          {filteredRequests.map((request) => (
            <RequestCard
              key={request.id}
              request={request}
              onAccept={handleAccept}
              onPass={handlePass}
            />
          ))}
        </section>
      ) : !isLoading ? (
        /* Empty state */
        <div
          className="bg-white rounded-[20px] border border-[rgba(44,62,45,0.1)] p-10 flex flex-col items-center gap-3 text-center"
          role="status"
          aria-label="No matching requests"
        >
          <div className="w-12 h-12 rounded-full bg-[#FBF7F0] border border-[rgba(44,62,45,0.1)] flex items-center justify-center">
            <Inbox size={22} className="text-[#8B9B8D]" aria-hidden="true" />
          </div>
          <p className="text-sm font-semibold text-[#2C3E2D]">No open requests</p>
          <p className="text-xs text-[#8B9B8D] max-w-xs">
            {activeFilter === 'all'
              ? 'No open requests right now. Check back soon!'
              : 'No open requests in this category. Check back soon!'}
          </p>
        </div>
      ) : null}

      {/* Rate footnote */}
      <p className="text-xs text-[#8B9B8D] text-center pb-2">
        Earnings based on $26.66/unit Medi-Cal rate · 85% CHW net payout after platform fees.
      </p>
    </div>
  );
}

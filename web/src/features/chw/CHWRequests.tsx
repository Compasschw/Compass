import { useState, useCallback, useMemo } from 'react';
import { CheckCircle, XCircle, Inbox } from 'lucide-react';
import { Badge } from '../../shared/components/Badge';
import { VerticalIcon } from '../../shared/components/VerticalIcon';
import { MapView, type MapMarker } from '../../shared/components/MapView';
import {
  serviceRequests,
  sessionModeLabels,
  type Vertical,
  type ServiceRequest,
} from '../../data/mock';

// ─── Constants ────────────────────────────────────────────────────────────────

const MEDI_CAL_RATE = 26.66;
const NET_PAYOUT_RATE = 0.85;

/**
 * Mock coordinates for open service request members.
 * In production these would come from the member's zip-code geocode.
 */
const REQUEST_COORDINATES: Record<string, { lat: number; lng: number }> = {
  'req-001': { lat: 34.0600, lng: -118.2250 }, // Rosa Delgado — Boyle Heights area
  'req-002': { lat: 33.9650, lng: -118.2900 }, // Marcus Johnson — South LA
  'req-004': { lat: 34.0300, lng: -118.3500 }, // James Okonkwo — Mid-city
};

/** Color per vertical category for request markers. */
const VERTICAL_MARKER_COLOR: Record<string, string> = {
  housing: '#3B82F6',
  rehab:   '#EF4444',
  food:    '#F59E0B',
  mental_health: '#7C3AED',
  healthcare: '#0D9488',
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  }).format(amount);
}

function calcNetEarnings(units: number): number {
  return units * MEDI_CAL_RATE * NET_PAYOUT_RATE;
}

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
  request: ServiceRequest;
  onAccept: (id: string) => void;
  onPass: (id: string) => void;
}

function RequestCard({ request, onAccept, onPass }: RequestCardProps) {
  const grossEarnings = request.estimatedUnits * MEDI_CAL_RATE;
  const netEarnings = calcNetEarnings(request.estimatedUnits);

  return (
    <article
      className="bg-white rounded-[20px] border border-[rgba(44,62,45,0.1)] p-4"
      aria-label={`Request from ${request.memberName}`}
    >
      <div className="flex items-start gap-3">
        {/* Vertical icon */}
        <div
          className="w-10 h-10 rounded-[12px] bg-[#FBF7F0] border border-[rgba(44,62,45,0.1)] flex items-center justify-center shrink-0"
          aria-hidden="true"
        >
          <VerticalIcon vertical={request.vertical} size={18} />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {/* Header row */}
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="text-sm font-semibold text-[#2C3E2D]">
              {request.memberName}
            </span>
            <Badge variant="vertical" value={request.vertical} />
            <Badge variant="urgency" value={request.urgency} />
            <span className="ml-auto text-xs text-[#8B9B8D]">
              {sessionModeLabels[request.preferredMode]}
            </span>
          </div>

          {/* Description — 2-line clamp */}
          <p className="text-xs text-[#555555] leading-relaxed line-clamp-2">
            {request.description}
          </p>

          {/* Estimated earnings */}
          <div className="mt-2 flex items-center gap-1.5">
            <span className="text-xs font-medium text-[#6B8F71]">
              ~{request.estimatedUnits} {request.estimatedUnits === 1 ? 'unit' : 'units'}
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
          aria-label={`Accept request from ${request.memberName}`}
        >
          <CheckCircle size={15} aria-hidden="true" />
          Accept
        </button>
        <button
          type="button"
          onClick={() => onPass(request.id)}
          className="flex-1 flex items-center justify-center gap-1.5 bg-white border border-[rgba(44,62,45,0.1)] hover:bg-[#FBF7F0] active:bg-[#F0F0F0] text-[#555555] text-sm font-semibold py-2.5 rounded-[12px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#AAAAAA]"
          aria-label={`Pass on request from ${request.memberName}`}
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
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Only show open requests that haven't been acted on
  const openRequests = serviceRequests.filter(
    (r) => r.status === 'open' && !dismissedIds.has(r.id),
  );

  const filteredRequests = openRequests.filter(
    (r) => activeFilter === 'all' || r.vertical === activeFilter,
  );

  const openCount = openRequests.length;

  /** Build map markers for visible open requests that have known coordinates. */
  const requestMapMarkers = useMemo<MapMarker[]>(
    () =>
      openRequests
        .filter((r) => r.id in REQUEST_COORDINATES)
        .map((r) => {
          const coords = REQUEST_COORDINATES[r.id];
          const urgencyLabel = r.urgency === 'urgent' ? '🔴' : r.urgency === 'soon' ? '🟡' : '🟢';
          return {
            id: r.id,
            lat: coords.lat,
            lng: coords.lng,
            label: urgencyLabel,
            type: 'resource' as const,
            color: VERTICAL_MARKER_COLOR[r.vertical] ?? '#555555',
            popupContent: `
              <strong style="color:#2C3E2D;font-size:13px">${r.memberName}</strong><br/>
              <span style="color:#555555;font-size:12px">${r.vertical.replace('_', ' ')} · ${r.urgency}</span><br/>
              <span style="color:#555555;font-size:12px">${r.estimatedUnits * 15} min est.</span>
            `,
          };
        }),
    [openRequests],
  );

  const showToast = useCallback((message: string) => {
    setToastMessage(message);
    const timer = setTimeout(() => setToastMessage(null), 3000);
    return () => clearTimeout(timer);
  }, []);

  const handleAccept = useCallback(
    (id: string) => {
      const request = serviceRequests.find((r) => r.id === id);
      setDismissedIds((prev) => new Set(prev).add(id));
      showToast(`Request accepted! Session created for ${request?.memberName ?? 'member'}.`);
    },
    [showToast],
  );

  const handlePass = useCallback((id: string) => {
    setDismissedIds((prev) => new Set(prev).add(id));
  }, []);

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

      {/* Request location map */}
      {requestMapMarkers.length > 0 && (
        <section aria-labelledby="requests-map-heading">
          <h3
            id="requests-map-heading"
            className="text-sm font-semibold text-[#2C3E2D] uppercase tracking-wide mb-2"
          >
            Request Locations
          </h3>
          <MapView
            centerLat={34.0200}
            centerLng={-118.2800}
            zoom={11}
            height={180}
            markers={requestMapMarkers}
            borderRadius={12}
          />
        </section>
      )}

      {/* Request list */}
      {filteredRequests.length > 0 ? (
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
      ) : (
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
      )}

      {/* Rate footnote */}
      <p className="text-xs text-[#8B9B8D] text-center pb-2">
        Earnings based on $26.66/unit Medi-Cal rate · 85% CHW net payout after platform fees.
      </p>
    </div>
  );
}

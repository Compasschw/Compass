import { useState, useCallback, useEffect, useRef } from 'react';
import {
  Play,
  StopCircle,
  ChevronDown,
  ChevronUp,
  CalendarClock,
  CheckCheck,
  Mic,
  MicOff,
  Check,
  X,
  Search,
  FileText,
  Circle,
  Loader2,
} from 'lucide-react';
import { Badge } from '../../shared/components/Badge';
import { VerticalIcon } from '../../shared/components/VerticalIcon';
import { formatCurrency, formatDate, formatShortDate, MEDI_CAL_RATE, NET_PAYOUT_RATE } from '../../shared/utils/format';
import {
  sessionModeLabels,
  diagnosisCodes,
  zCodeCategoryLabels,
  predefinedMemberGoals,
  predefinedResources,
  procedureCodes,
  type Session,
  type SessionStatus,
  type SessionDocumentation,
  type ZCodeCategory,
} from '../../data/mock';
import { useSessions, useStartSession, useCompleteSession, useChwClaims } from '../../api/hooks';
import type { ChwClaimData } from '../../api/chw';
import type { SessionData } from '../../api/sessions';
import { SessionChat } from './SessionChat';

// ─── API adapter ─────────────────────────────────────────────────────────────

function toSession(d: SessionData): Session {
  return {
    id: d.id,
    chwName: d.chw_name ?? 'CHW',
    memberName: d.member_name ?? 'Member',
    vertical: d.vertical as Session['vertical'],
    status: d.status as Session['status'],
    mode: d.mode as Session['mode'],
    scheduledAt: d.scheduled_at ?? d.created_at,
    startedAt: d.started_at ?? undefined,
    endedAt: d.ended_at ?? undefined,
    durationMinutes: d.duration_minutes ?? undefined,
    unitsBilled: d.units_billed ?? undefined,
    grossAmount: d.gross_amount ?? undefined,
    netAmount: d.net_amount ?? undefined,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ─── Billing status helpers ───────────────────────────────────────────────────

type BillingStatus = 'pending' | 'submitted' | 'approved' | 'rejected';

/**
 * Derives a mock billing status from session ID for demo purposes.
 * In production this would come from the backend billing record.
 */
/**
 * Convert a backend BillingClaim.status string to the local BillingStatus
 * union the badge renders. Mirrors the helper in CHWEarningsScreen so
 * both screens display identical status labels for the same claim.
 */
function mapClaimStatus(claimStatus: string | undefined): BillingStatus {
  switch (claimStatus) {
    case 'submitted':
      return 'submitted';
    case 'paid':
      return 'approved';
    case 'rejected':
      return 'rejected';
    default:
      return 'pending';
  }
}

function lookupBillingStatus(
  sessionId: string,
  claimsBySession: Map<string, ChwClaimData>,
): BillingStatus {
  return mapClaimStatus(claimsBySession.get(sessionId)?.status);
}

const billingStatusStyles: Record<BillingStatus, string> = {
  pending: 'bg-yellow-100 text-yellow-800',
  submitted: 'bg-blue-100 text-blue-700',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
};

const billingStatusLabels: Record<BillingStatus, string> = {
  pending: 'Pending',
  submitted: 'Submitted',
  approved: 'Paid',
  rejected: 'Rejected',
};

// ─── Recording state types ────────────────────────────────────────────────────

interface RecordingState {
  isRecording: boolean;
  consentGiven: boolean;
  showConsentPrompt: boolean;
  startedAt: number | null;
  elapsedSeconds: number;
  savedAt: number | null;
}

// ─── DiagnosisCodeSelector ────────────────────────────────────────────────────

interface DiagnosisCodeSelectorProps {
  selectedCodes: string[];
  onToggle: (code: string) => void;
}

function DiagnosisCodeSelector({ selectedCodes, onToggle }: DiagnosisCodeSelectorProps) {
  const [query, setQuery] = useState('');

  const filtered = query.trim().length > 0
    ? diagnosisCodes.filter(
        (d) =>
          d.code.toLowerCase().includes(query.toLowerCase()) ||
          d.description.toLowerCase().includes(query.toLowerCase()),
      )
    : diagnosisCodes;

  // Group by category preserving insertion order
  const grouped = filtered.reduce<Record<ZCodeCategory, typeof diagnosisCodes[number][]>>(
    (acc, item) => {
      if (!acc[item.category]) acc[item.category] = [];
      acc[item.category].push(item);
      return acc;
    },
    {} as Record<ZCodeCategory, typeof diagnosisCodes[number][]>,
  );

  const categoryOrder: ZCodeCategory[] = [
    'counseling',
    'housing_economic',
    'health_access',
    'behavioral',
    'legal',
  ];

  return (
    <div>
      <label
        htmlFor="dx-search"
        className="block text-xs font-semibold text-[#2C3E2D] uppercase tracking-wide mb-2"
      >
        Diagnosis Codes (ICD-10 Z-Codes)
        <span className="ml-1 text-red-500" aria-hidden="true">*</span>
      </label>

      {/* Search input */}
      <div className="relative mb-3">
        <Search
          size={14}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8B9B8D] pointer-events-none"
          aria-hidden="true"
        />
        <input
          id="dx-search"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by code or description..."
          className="w-full pl-8 pr-3 py-2 text-sm border border-[rgba(44,62,45,0.1)] rounded-[12px] bg-white text-[#2C3E2D] placeholder:text-[#8B9B8D] focus:outline-none focus:ring-2 focus:ring-[#6B8F71] focus:border-[#6B8F71]"
        />
      </div>

      {/* Code list grouped by category */}
      <div
        className="border border-[rgba(44,62,45,0.1)] rounded-[12px] bg-white overflow-y-auto"
        style={{ minHeight: '120px', maxHeight: '220px' }}
        role="group"
        aria-label="Diagnosis code selection"
      >
        {categoryOrder.map((cat) => {
          const codes = grouped[cat];
          if (!codes || codes.length === 0) return null;
          return (
            <div key={cat}>
              <div className="px-3 py-1.5 bg-[#FBF7F0] border-b border-[rgba(44,62,45,0.1)] sticky top-0">
                <span className="text-[10px] font-semibold uppercase tracking-widest text-[#8B9B8D]">
                  {zCodeCategoryLabels[cat]}
                </span>
              </div>
              {codes.map((dx) => {
                const isSelected = selectedCodes.includes(dx.code);
                return (
                  <label
                    key={dx.code}
                    className={[
                      'flex items-start gap-3 px-3 py-2.5 cursor-pointer transition-colors border-b border-[#F3F4F6] last:border-b-0',
                      isSelected ? 'bg-[rgba(107,143,113,0.08)]' : 'hover:bg-[#FBF7F0]',
                    ].join(' ')}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={isSelected}
                      onChange={() => onToggle(dx.code)}
                    />
                    <span
                      className={[
                        'w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 mt-0.5 transition-colors',
                        isSelected
                          ? 'border-[#6B8F71] bg-[#2C3E2D]'
                          : 'border-[#D1D5DB] bg-white',
                      ].join(' ')}
                      aria-hidden="true"
                    >
                      {isSelected && <Check size={9} className="text-white" strokeWidth={3} />}
                    </span>
                    <span className="flex-1 min-w-0 text-xs text-[#2C3E2D] leading-relaxed">
                      <span className="font-mono font-semibold text-[#0077B6]">{dx.code}</span>
                      {' — '}
                      <span className={dx.isArchived ? 'text-[#8B9B8D]' : ''}>
                        {dx.description}
                        {dx.isArchived && (
                          <em className="ml-1 text-[#8B9B8D] not-italic text-[10px]">
                            (Archived)
                          </em>
                        )}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-[#8B9B8D]">
            No codes match your search.
          </div>
        )}
      </div>

      {/* Selected code chips */}
      {selectedCodes.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2" aria-label="Selected diagnosis codes">
          {selectedCodes.map((code) => {
            const dx = diagnosisCodes.find((d) => d.code === code);
            return (
              <span
                key={code}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-[rgba(107,143,113,0.15)] text-[#6B8F71] text-xs font-semibold"
              >
                {code}
                <button
                  type="button"
                  onClick={() => onToggle(code)}
                  aria-label={`Remove ${code}${dx ? ` — ${dx.description}` : ''}`}
                  className="ml-0.5 hover:text-[#008F40] transition-colors"
                >
                  <X size={11} strokeWidth={2.5} aria-hidden="true" />
                </button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── SessionDocumentationModal ────────────────────────────────────────────────

interface SessionDocumentationModalProps {
  session: Session;
  durationMinutes: number;
  onSubmit: (doc: SessionDocumentation) => void;
  onCancel: () => void;
}

function SessionDocumentationModal({
  session,
  durationMinutes,
  onSubmit,
  onCancel,
}: SessionDocumentationModalProps) {
  const autoUnits = Math.ceil(durationMinutes / 15);

  const [summary, setSummary] = useState('');
  const [selectedResources, setSelectedResources] = useState<string[]>([]);
  const [selectedGoals, setSelectedGoals] = useState<string[]>([]);
  const [followUpNeeded, setFollowUpNeeded] = useState<boolean | null>(null);
  const [followUpDate, setFollowUpDate] = useState('');
  const [diagnosisCodeSelection, setDiagnosisCodeSelection] = useState<string[]>([]);
  const [selectedProcedureCode, setSelectedProcedureCode] = useState('98960');
  const [unitsToBill, setUnitsToBill] = useState(autoUnits);
  const [submitting, setSubmitting] = useState(false);

  const isValid =
    summary.trim().length > 0 && diagnosisCodeSelection.length > 0 && selectedProcedureCode.length > 0;

  function toggleResource(resource: string) {
    setSelectedResources((prev) =>
      prev.includes(resource) ? prev.filter((r) => r !== resource) : [...prev, resource],
    );
  }

  function toggleGoal(goal: string) {
    setSelectedGoals((prev) =>
      prev.includes(goal) ? prev.filter((g) => g !== goal) : [...prev, goal],
    );
  }

  function toggleDiagnosisCode(code: string) {
    setDiagnosisCodeSelection((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
    );
  }

  function handleSubmit() {
    if (!isValid || submitting) return;
    setSubmitting(true);

    const doc: SessionDocumentation = {
      sessionId: session.id,
      summary: summary.trim(),
      resourcesReferred: selectedResources,
      memberGoals: selectedGoals,
      followUpNeeded: followUpNeeded === true,
      followUpDate: followUpNeeded === true && followUpDate ? followUpDate : undefined,
      diagnosisCodes: diagnosisCodeSelection,
      procedureCode: selectedProcedureCode,
      unitsToBill,
      submittedAt: new Date().toISOString(),
    };

    // Simulate brief async submission
    setTimeout(() => {
      onSubmit(doc);
      setSubmitting(false);
    }, 600);
  }

  // Prevent body scroll while modal open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const grossAmount = unitsToBill * MEDI_CAL_RATE;
  const netAmount = grossAmount * NET_PAYOUT_RATE;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="doc-modal-title"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
        onClick={onCancel}
        aria-hidden="true"
      />

      {/* Modal panel */}
      <div className="relative bg-white rounded-[16px] w-full max-w-lg shadow-xl flex flex-col max-h-[90vh]">
        {/* Fixed header */}
        <div className="px-6 pt-6 pb-4 border-b border-[rgba(44,62,45,0.1)] shrink-0">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2
                id="doc-modal-title"
                className="text-lg font-bold text-[#2C3E2D]"
              >
                Session Documentation
              </h2>
              <p className="text-sm text-[#555555] mt-0.5">
                {session.memberName} &middot;{' '}
                {formatShortDate(session.scheduledAt)}
              </p>
            </div>
            <button
              type="button"
              onClick={onCancel}
              className="p-1.5 rounded-[6px] text-[#8B9B8D] hover:text-[#555555] hover:bg-[#FBF7F0] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6B8F71]"
              aria-label="Cancel documentation"
            >
              <X size={18} aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Scrollable body */}
        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-6">
          {/* Session summary */}
          <div>
            <label
              htmlFor="doc-summary"
              className="block text-xs font-semibold text-[#2C3E2D] uppercase tracking-wide mb-2"
            >
              Session Summary
              <span className="ml-1 text-red-500" aria-hidden="true">*</span>
            </label>
            <textarea
              id="doc-summary"
              rows={3}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Describe what was accomplished in this session..."
              className="w-full text-sm text-[#2C3E2D] border border-[rgba(44,62,45,0.1)] rounded-[12px] p-3 resize-none focus:outline-none focus:ring-2 focus:ring-[#6B8F71] focus:border-[#6B8F71] placeholder:text-[#8B9B8D]"
            />
          </div>

          {/* Resources referred */}
          <div>
            <p className="text-xs font-semibold text-[#2C3E2D] uppercase tracking-wide mb-2">
              Resources Referred
            </p>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Select resources referred">
              {predefinedResources.map((resource) => {
                const isSelected = selectedResources.includes(resource);
                return (
                  <button
                    key={resource}
                    type="button"
                    onClick={() => toggleResource(resource)}
                    aria-pressed={isSelected}
                    className={[
                      'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-all',
                      isSelected
                        ? 'bg-[rgba(107,143,113,0.15)] border-[#6B8F71] text-[#6B8F71]'
                        : 'bg-white border-[rgba(44,62,45,0.1)] text-[#555555] hover:border-[#6B8F71]/50',
                    ].join(' ')}
                  >
                    {isSelected && (
                      <Check size={10} strokeWidth={3} aria-hidden="true" />
                    )}
                    {resource}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Member goals discussed */}
          <div>
            <p className="text-xs font-semibold text-[#2C3E2D] uppercase tracking-wide mb-2">
              Member Goals Discussed
            </p>
            <div className="space-y-2" role="group" aria-label="Select member goals discussed">
              {predefinedMemberGoals.map((goal) => {
                const isChecked = selectedGoals.includes(goal);
                return (
                  <label
                    key={goal}
                    className={[
                      'flex items-center gap-3 px-3 py-2 rounded-[12px] border cursor-pointer transition-colors',
                      isChecked
                        ? 'border-[#6B8F71] bg-[rgba(107,143,113,0.08)]'
                        : 'border-[rgba(44,62,45,0.1)] bg-white hover:border-[#6B8F71]/40',
                    ].join(' ')}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={isChecked}
                      onChange={() => toggleGoal(goal)}
                    />
                    <span
                      className={[
                        'w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors',
                        isChecked
                          ? 'border-[#6B8F71] bg-[#2C3E2D]'
                          : 'border-[#D1D5DB] bg-white',
                      ].join(' ')}
                      aria-hidden="true"
                    >
                      {isChecked && <Check size={9} className="text-white" strokeWidth={3} />}
                    </span>
                    <span className={`text-sm ${isChecked ? 'text-[#6B8F71] font-medium' : 'text-[#2C3E2D]'}`}>
                      {goal}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          {/* Follow-up */}
          <div>
            <p className="text-xs font-semibold text-[#2C3E2D] uppercase tracking-wide mb-2">
              Follow-Up Needed?
            </p>
            <div className="flex gap-2 mb-3">
              <button
                type="button"
                onClick={() => setFollowUpNeeded(true)}
                aria-pressed={followUpNeeded === true}
                className={[
                  'flex-1 py-2 rounded-[12px] text-sm font-semibold border transition-all',
                  followUpNeeded === true
                    ? 'bg-[#2C3E2D] border-[#6B8F71] text-white'
                    : 'bg-white border-[rgba(44,62,45,0.1)] text-[#555555] hover:border-[#6B8F71]/50',
                ].join(' ')}
              >
                Yes
              </button>
              <button
                type="button"
                onClick={() => setFollowUpNeeded(false)}
                aria-pressed={followUpNeeded === false}
                className={[
                  'flex-1 py-2 rounded-[12px] text-sm font-semibold border transition-all',
                  followUpNeeded === false
                    ? 'bg-[#555555] border-[#555555] text-white'
                    : 'bg-white border-[rgba(44,62,45,0.1)] text-[#555555] hover:border-[#555555]/50',
                ].join(' ')}
              >
                No
              </button>
            </div>
            {followUpNeeded === true && (
              <div>
                <label
                  htmlFor="follow-up-date"
                  className="block text-xs font-medium text-[#555555] mb-1.5"
                >
                  Follow-up date
                </label>
                <input
                  id="follow-up-date"
                  type="date"
                  value={followUpDate}
                  onChange={(e) => setFollowUpDate(e.target.value)}
                  min={new Date().toISOString().split('T')[0]}
                  className="w-full text-sm border border-[rgba(44,62,45,0.1)] rounded-[12px] px-3 py-2.5 text-[#2C3E2D] focus:outline-none focus:ring-2 focus:ring-[#6B8F71] focus:border-[#6B8F71]"
                />
              </div>
            )}
          </div>

          {/* Diagnosis codes */}
          <DiagnosisCodeSelector
            selectedCodes={diagnosisCodeSelection}
            onToggle={toggleDiagnosisCode}
          />

          {/* Procedure & Modifiers */}
          <div>
            <label
              htmlFor="procedure-code"
              className="block text-xs font-semibold text-[#2C3E2D] uppercase tracking-wide mb-2"
            >
              Procedure and Modifiers *
            </label>
            <select
              id="procedure-code"
              value={selectedProcedureCode}
              onChange={(e) => setSelectedProcedureCode(e.target.value)}
              className="w-full text-sm border border-[rgba(44,62,45,0.1)] rounded-[12px] px-3 py-2.5 text-[#2C3E2D] bg-white focus:outline-none focus:ring-2 focus:ring-[#6B8F71] focus:border-[#6B8F71]"
            >
              {procedureCodes.map((pc) => (
                <option key={pc.code} value={pc.code}>
                  {pc.code} {pc.modifier} - {pc.description} - {pc.groupSize}
                </option>
              ))}
            </select>
            <p className="text-xs text-[#8B9B8D] mt-1.5">
              Select the service type based on number of people served in this session.
            </p>
          </div>

          {/* Units to bill */}
          <div>
            <label
              htmlFor="units-to-bill"
              className="block text-xs font-semibold text-[#2C3E2D] uppercase tracking-wide mb-2"
            >
              Units to Bill
            </label>
            <input
              id="units-to-bill"
              type="number"
              min={1}
              max={16}
              value={unitsToBill}
              onChange={(e) => setUnitsToBill(Math.max(1, parseInt(e.target.value, 10) || 1))}
              className="w-full text-sm border border-[rgba(44,62,45,0.1)] rounded-[12px] px-3 py-2.5 text-[#2C3E2D] font-semibold focus:outline-none focus:ring-2 focus:ring-[#6B8F71] focus:border-[#6B8F71]"
            />
            <p className="text-xs text-[#8B9B8D] mt-1.5">
              Based on {durationMinutes} min = {autoUnits}{' '}
              {autoUnits === 1 ? 'unit' : 'units'} @ $26.66/unit
              {unitsToBill !== autoUnits && (
                <span className="ml-1 text-amber-600">(manually adjusted)</span>
              )}
            </p>
            <div className="mt-2 flex items-center gap-4 text-xs">
              <span className="text-[#555555]">
                Gross:{' '}
                <span className="font-semibold text-[#2C3E2D]">
                  {formatCurrency(grossAmount)}
                </span>
              </span>
              <span className="text-[#555555]">
                Net (85%):{' '}
                <span className="font-semibold text-[#6B8F71]">
                  {formatCurrency(netAmount)}
                </span>
              </span>
            </div>
          </div>
        </div>

        {/* Fixed footer */}
        <div className="px-6 py-4 border-t border-[rgba(44,62,45,0.1)] shrink-0">
          {!isValid && (
            <p className="text-xs text-[#8B9B8D] text-center mb-3">
              {summary.trim().length === 0 && diagnosisCodeSelection.length === 0
                ? 'Add a summary and at least one diagnosis code to submit.'
                : summary.trim().length === 0
                ? 'A session summary is required to submit.'
                : 'Select at least one diagnosis code to submit.'}
            </p>
          )}
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!isValid || submitting}
            className="w-full flex items-center justify-center gap-2 bg-[#2C3E2D] hover:bg-[#3A5240] disabled:bg-[rgba(107,143,113,0.15)] disabled:cursor-not-allowed text-white text-sm font-semibold py-3 rounded-[12px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6B8F71]"
          >
            {submitting ? (
              <>
                <span
                  className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin"
                  aria-hidden="true"
                />
                Submitting...
              </>
            ) : (
              <>
                <FileText size={15} aria-hidden="true" />
                Submit Documentation &amp; Billing
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Toast notification ───────────────────────────────────────────────────────

interface ToastProps {
  message: string;
  onDismiss: () => void;
}

function Toast({ message, onDismiss }: ToastProps) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 4000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2.5 bg-[#2C3E2D] text-white text-sm font-medium px-5 py-3 rounded-[20px] shadow-lg"
    >
      <span className="w-5 h-5 rounded-full bg-[#2C3E2D] flex items-center justify-center shrink-0">
        <Check size={11} className="text-white" strokeWidth={3} aria-hidden="true" />
      </span>
      {message}
    </div>
  );
}

// ─── ActiveSessionCard ────────────────────────────────────────────────────────

interface ActiveSessionCardProps {
  session: Session;
  onStart: (id: string) => void;
  onEnd: (id: string) => void;
  onNotesChange: (id: string, notes: string) => void;
  localNotes: string;
  isExpanded: boolean;
  onToggleExpand: (id: string) => void;
  recordingState: RecordingState;
  onRecordingAction: (id: string, action: 'request-consent' | 'confirm-consent' | 'cancel-consent' | 'stop') => void;
  chwId: string;
}

function ActiveSessionCard({
  session,
  onStart,
  onEnd,
  onNotesChange,
  localNotes,
  isExpanded,
  onToggleExpand,
  recordingState,
  onRecordingAction,
  chwId,
}: ActiveSessionCardProps) {
  const isInProgress = session.status === 'in_progress';
  const showRecording = isInProgress && session.mode === 'phone';

  return (
    <article
      className="bg-white rounded-[20px] border border-[rgba(44,62,45,0.1)] overflow-hidden"
      aria-label={`Session with ${session.memberName}`}
    >
      {/* Card body */}
      <div className="p-4">
        <div className="flex items-start gap-3">
          {/* Vertical icon */}
          <div
            className="w-10 h-10 rounded-[12px] bg-[rgba(107,143,113,0.15)] flex items-center justify-center shrink-0"
            aria-hidden="true"
          >
            <VerticalIcon vertical={session.vertical} size={18} />
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span className="text-sm font-semibold text-[#2C3E2D]">
                {session.memberName}
              </span>
              <Badge variant="vertical" value={session.vertical} />

              {/* In-progress indicator with animated pulse */}
              {isInProgress ? (
                <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium bg-green-100 text-green-700">
                  <span
                    className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"
                    aria-hidden="true"
                  />
                  In Progress
                </span>
              ) : (
                <Badge variant="session-status" value={session.status as SessionStatus} />
              )}
            </div>

            <p className="text-xs text-[#555555]">
              {formatDate(session.scheduledAt)}
              {' · '}
              {sessionModeLabels[session.mode]}
            </p>
          </div>

          {/* Expand toggle */}
          <button
            type="button"
            onClick={() => onToggleExpand(session.id)}
            className="p-1 rounded-[6px] text-[#8B9B8D] hover:text-[#555555] hover:bg-[#FBF7F0] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6B8F71]"
            aria-expanded={isExpanded}
            aria-label={isExpanded ? 'Collapse session details' : 'Expand session details'}
          >
            {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        </div>

        {/* Action buttons */}
        <div className="mt-4 space-y-2">
          {isInProgress ? (
            <button
              type="button"
              onClick={() => onEnd(session.id)}
              className="w-full flex items-center justify-center gap-2 bg-red-50 border border-red-200 hover:bg-red-100 text-red-700 text-sm font-semibold py-2.5 rounded-[12px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-400"
              aria-label={`End session with ${session.memberName}`}
            >
              <StopCircle size={15} aria-hidden="true" />
              End Session
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onStart(session.id)}
              className="w-full flex items-center justify-center gap-2 bg-[#2C3E2D] hover:bg-[#3A5240] active:bg-[#243D25] text-white text-sm font-semibold py-2.5 rounded-[12px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6B8F71]"
              aria-label={`Start session with ${session.memberName}`}
            >
              <Play size={15} aria-hidden="true" />
              Start Session
            </button>
          )}
        </div>
      </div>

      {/* Recording section — phone sessions in progress only */}
      {showRecording && (
        <div className="border-t border-[rgba(44,62,45,0.1)] p-4 bg-[#FBF7F0]">
          {/* Not yet recording and no saved recording */}
          {!recordingState.isRecording && !recordingState.savedAt && !recordingState.showConsentPrompt && (
            <button
              type="button"
              onClick={() => onRecordingAction(session.id, 'request-consent')}
              className="w-full flex items-center justify-center gap-2 border border-[rgba(44,62,45,0.1)] bg-white hover:bg-[rgba(107,143,113,0.08)] hover:border-[#6B8F71]/50 text-[#555555] hover:text-[#6B8F71] text-sm font-medium py-2.5 rounded-[12px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6B8F71]"
              aria-label="Start recording this call"
            >
              <Mic size={15} aria-hidden="true" />
              Record Call
            </button>
          )}

          {/* Consent prompt */}
          {recordingState.showConsentPrompt && !recordingState.isRecording && (
            <div className="bg-white rounded-[12px] border border-[rgba(44,62,45,0.1)] p-4">
              <p className="text-sm font-semibold text-[#2C3E2D] mb-1">Consent required</p>
              <p className="text-xs text-[#555555] leading-relaxed mb-4">
                This call will be recorded for documentation purposes. Do you have verbal consent
                from the member?
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => onRecordingAction(session.id, 'confirm-consent')}
                  className="flex-1 flex items-center justify-center gap-1.5 bg-[#2C3E2D] hover:bg-[#3A5240] text-white text-sm font-semibold py-2 rounded-[12px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6B8F71]"
                >
                  <Check size={13} aria-hidden="true" />
                  Yes, Record
                </button>
                <button
                  type="button"
                  onClick={() => onRecordingAction(session.id, 'cancel-consent')}
                  className="flex-1 flex items-center justify-center gap-1.5 bg-white border border-[rgba(44,62,45,0.1)] hover:bg-[#FBF7F0] text-[#555555] text-sm font-semibold py-2 rounded-[12px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#555555]"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Recording in progress */}
          {recordingState.isRecording && (
            <div className="bg-white rounded-[12px] border border-red-200 p-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Circle
                    size={8}
                    className="text-red-500 fill-red-500 animate-pulse"
                    aria-hidden="true"
                  />
                  <span className="text-sm font-semibold text-red-600">Recording</span>
                  <span
                    className="text-sm font-mono text-red-500"
                    aria-label={`Recording duration: ${formatElapsed(recordingState.elapsedSeconds)}`}
                  >
                    {formatElapsed(recordingState.elapsedSeconds)}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => onRecordingAction(session.id, 'stop')}
                  className="flex items-center gap-1.5 bg-red-50 border border-red-200 hover:bg-red-100 text-red-700 text-xs font-semibold px-3 py-1.5 rounded-[6px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-400"
                  aria-label="Stop recording"
                >
                  <MicOff size={13} aria-hidden="true" />
                  Stop
                </button>
              </div>
            </div>
          )}

          {/* Recording saved confirmation */}
          {recordingState.savedAt && !recordingState.isRecording && (
            <div className="flex items-center gap-2 text-sm text-[#6B8F71]">
              <span className="w-5 h-5 rounded-full bg-[rgba(107,143,113,0.15)] flex items-center justify-center shrink-0">
                <Check size={11} strokeWidth={3} aria-hidden="true" />
              </span>
              <span className="font-medium">Recording saved</span>
            </div>
          )}
        </div>
      )}

      {/* Expanded notes + chat section */}
      {isExpanded && (
        <div className="border-t border-[rgba(44,62,45,0.1)] p-4 bg-[#FBF7F0] space-y-3">
          <div>
            <label
              htmlFor={`notes-${session.id}`}
              className="block text-xs font-semibold text-[#2C3E2D] uppercase tracking-wide mb-2"
            >
              Session Notes
            </label>
            <textarea
              id={`notes-${session.id}`}
              rows={3}
              value={localNotes}
              onChange={(e) => onNotesChange(session.id, e.target.value)}
              placeholder="Document your session notes here…"
              className="w-full text-sm text-[#2C3E2D] bg-white border border-[rgba(44,62,45,0.1)] rounded-[12px] p-3 resize-none focus:outline-none focus:ring-2 focus:ring-[#6B8F71] focus:border-[#6B8F71] placeholder:text-[#8B9B8D]"
            />
          </div>

          {/* In-session chat */}
          {session.status === 'in_progress' && (
            <SessionChat sessionId={session.id} chwId={chwId} />
          )}
        </div>
      )}
    </article>
  );
}

// ─── CompletedSessionCard ─────────────────────────────────────────────────────

interface CompletedSessionCardProps {
  session: Session;
  isExpanded: boolean;
  onToggleExpand: (id: string) => void;
  /** Map of session_id → claim, indexed at the parent for O(1) lookup. */
  claimsBySession: Map<string, ChwClaimData>;
}

function CompletedSessionCard({
  session,
  isExpanded,
  onToggleExpand,
  claimsBySession,
}: CompletedSessionCardProps) {
  const billingStatus = lookupBillingStatus(session.id, claimsBySession);
  const gross = session.grossAmount ?? 0;
  const net = session.netAmount ?? 0;

  return (
    <article
      className="bg-white rounded-[20px] border border-[rgba(44,62,45,0.1)] overflow-hidden"
      aria-label={`Completed session with ${session.memberName}`}
    >
      {/* Card body — clickable to expand */}
      <button
        type="button"
        className="w-full text-left p-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#6B8F71] focus-visible:rounded-[12px]"
        onClick={() => onToggleExpand(session.id)}
        aria-expanded={isExpanded}
        aria-label={`${isExpanded ? 'Collapse' : 'Expand'} details for session with ${session.memberName}`}
      >
        <div className="flex items-start gap-3">
          {/* Vertical icon */}
          <div
            className="w-10 h-10 rounded-[12px] bg-[#FBF7F0] border border-[rgba(44,62,45,0.1)] flex items-center justify-center shrink-0"
            aria-hidden="true"
          >
            <VerticalIcon vertical={session.vertical} size={18} />
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span className="text-sm font-semibold text-[#2C3E2D]">
                {session.memberName}
              </span>
              <Badge variant="vertical" value={session.vertical} />
              <span
                className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${billingStatusStyles[billingStatus]}`}
              >
                {billingStatusLabels[billingStatus]}
              </span>
            </div>

            <p className="text-xs text-[#555555]">
              {formatShortDate(session.scheduledAt)}
              {session.durationMinutes != null && (
                <> · {session.durationMinutes} min</>
              )}
              {' · '}
              {sessionModeLabels[session.mode]}
            </p>

            {/* Billing summary row */}
            <div className="flex items-center gap-3 mt-2">
              {session.unitsBilled != null && (
                <span className="text-xs text-[#8B9B8D]">
                  {session.unitsBilled} {session.unitsBilled === 1 ? 'unit' : 'units'}
                </span>
              )}
              {gross > 0 && (
                <>
                  <span className="text-xs text-[#8B9B8D]">·</span>
                  <span className="text-xs text-[#555555]">
                    {formatCurrency(gross)} gross
                  </span>
                  <span className="text-xs text-[#8B9B8D]">·</span>
                  <span className="text-xs font-semibold text-[#6B8F71]">
                    {formatCurrency(net)} net
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Chevron */}
          <span className="text-[#8B9B8D] mt-0.5" aria-hidden="true">
            {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </span>
        </div>
      </button>

      {/* Expanded detail section */}
      {isExpanded && (
        <div className="border-t border-[rgba(44,62,45,0.1)] p-4 bg-[#FBF7F0] space-y-4">
          {/* Notes */}
          {session.notes && (
            <div>
              <p className="text-xs font-semibold text-[#2C3E2D] uppercase tracking-wide mb-1.5">
                Session Notes
              </p>
              <p className="text-sm text-[#555555] leading-relaxed">{session.notes}</p>
            </div>
          )}

          {/* Documentation summary if present */}
          {session.documentation && (
            <div>
              <p className="text-xs font-semibold text-[#2C3E2D] uppercase tracking-wide mb-1.5">
                Documentation
              </p>
              <p className="text-sm text-[#555555] leading-relaxed">
                {session.documentation.summary}
              </p>
              {session.documentation.diagnosisCodes.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {session.documentation.diagnosisCodes.map((code) => (
                    <span
                      key={code}
                      className="inline-flex items-center px-2 py-0.5 rounded-full bg-[rgba(107,143,113,0.15)] text-[#6B8F71] text-xs font-semibold"
                    >
                      {code}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Duration breakdown */}
          <div>
            <p className="text-xs font-semibold text-[#2C3E2D] uppercase tracking-wide mb-2">
              Duration Breakdown
            </p>
            <div className="grid grid-cols-2 gap-2 text-xs">
              {session.startedAt && (
                <>
                  <span className="text-[#8B9B8D]">Started</span>
                  <span className="text-[#2C3E2D] font-medium text-right">
                    {formatDate(session.startedAt)}
                  </span>
                </>
              )}
              {session.endedAt && (
                <>
                  <span className="text-[#8B9B8D]">Ended</span>
                  <span className="text-[#2C3E2D] font-medium text-right">
                    {formatDate(session.endedAt)}
                  </span>
                </>
              )}
              {session.durationMinutes != null && (
                <>
                  <span className="text-[#8B9B8D]">Duration</span>
                  <span className="text-[#2C3E2D] font-medium text-right">
                    {session.durationMinutes} minutes
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Billing info */}
          {session.unitsBilled != null && (
            <div>
              <p className="text-xs font-semibold text-[#2C3E2D] uppercase tracking-wide mb-2">
                Billing Info
              </p>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <span className="text-[#8B9B8D]">Units Billed</span>
                <span className="text-[#2C3E2D] font-medium text-right">
                  {session.unitsBilled}
                </span>
                <span className="text-[#8B9B8D]">Gross Amount</span>
                <span className="text-[#2C3E2D] font-medium text-right">
                  {formatCurrency(session.grossAmount ?? 0)}
                </span>
                <span className="text-[#8B9B8D]">Net Payout (85%)</span>
                <span className="font-semibold text-[#6B8F71] text-right">
                  {formatCurrency(session.netAmount ?? 0)}
                </span>
                <span className="text-[#8B9B8D]">Billing Status</span>
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium w-fit ml-auto ${billingStatusStyles[billingStatus]}`}
                >
                  {billingStatusLabels[billingStatus]}
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

type SessionTab = 'active' | 'completed';

/**
 * CHW Sessions page — manages active and completed sessions.
 *
 * Features:
 * - Tab bar: Active | Completed with counts
 * - Active sessions: Start / End actions, inline notes textarea
 * - Phone sessions: Record call with member consent flow, elapsed timer
 * - End session: opens documentation modal (summary, resources, goals, diagnosis codes, billing)
 * - Completed sessions: Expandable detail with billing breakdown
 * - In-progress status pulse animation
 */
export function CHWSessions() {
  const [activeTab, setActiveTab] = useState<SessionTab>('active');
  const [sessionStatuses, setSessionStatuses] = useState<
    Record<string, SessionStatus>
  >({});
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [sessionNotes, setSessionNotes] = useState<Record<string, string>>({});
  const [sessionDurations, setSessionDurations] = useState<Record<string, number>>({});
  const [sessionDocumentation, setSessionDocumentation] = useState<
    Record<string, SessionDocumentation>
  >({});
  const [documentingSessionId, setDocumentingSessionId] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Real API data
  const { data: apiSessions = [], isLoading } = useSessions();
  const { data: apiClaims = [] } = useChwClaims();
  const startMutation = useStartSession();
  const completeMutation = useCompleteSession();
  const sessions: Session[] = apiSessions.map(toSession);
  const chwId = apiSessions[0]?.chw_id ?? '';

  // Index claims by session_id once for O(1) lookup inside the rows.
  // Replaces the hardcoded sess-002/003/004 → status mock map.
  const claimsBySession: Map<string, ChwClaimData> = new Map();
  for (const claim of apiClaims) {
    if (claim.session_id && !claimsBySession.has(claim.session_id)) {
      claimsBySession.set(claim.session_id, claim);
    }
  }

  // Per-session recording state
  const [recordingStates, setRecordingStates] = useState<Record<string, RecordingState>>({});

  // Track session start times for duration calculation
  const sessionStartTimes = useRef<Record<string, number>>({});

  // Tick recording elapsed time
  useEffect(() => {
    const interval = setInterval(() => {
      setRecordingStates((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const sessionId of Object.keys(next)) {
          const rs = next[sessionId];
          if (rs.isRecording && rs.startedAt !== null) {
            const elapsed = Math.floor((Date.now() - rs.startedAt) / 1000);
            if (elapsed !== rs.elapsedSeconds) {
              next[sessionId] = { ...rs, elapsedSeconds: elapsed };
              changed = true;
            }
          }
        }
        return changed ? next : prev;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Merge mock data status with local overrides
  const getStatus = useCallback(
    (session: Session): SessionStatus =>
      sessionStatuses[session.id] ?? session.status,
    [sessionStatuses],
  );

  const activeSessions = sessions.filter((s) => {
    const status = getStatus(s);
    return status === 'scheduled' || status === 'in_progress';
  });

  const completedSessions = sessions.filter((s) => {
    const status = getStatus(s);
    return status === 'completed' || status === 'cancelled';
  });

  const handleStart = useCallback((id: string) => {
    startMutation.mutate(id);
    sessionStartTimes.current[id] = Date.now();
    setSessionStatuses((prev) => ({ ...prev, [id]: 'in_progress' }));
    setExpandedIds((prev) => new Set(prev).add(id));
  }, [startMutation]);

  /**
   * End session: compute elapsed duration and open documentation modal
   * instead of immediately completing.
   */
  const handleEnd = useCallback((id: string) => {
    const startTime = sessionStartTimes.current[id];
    const durationMinutes = startTime
      ? Math.max(1, Math.round((Date.now() - startTime) / 60000))
      : 30; // fallback for demo
    setSessionDurations((prev) => ({ ...prev, [id]: durationMinutes }));
    setDocumentingSessionId(id);
  }, []);

  const handleDocumentationSubmit = useCallback(
    async (doc: SessionDocumentation) => {
      if (!documentingSessionId) return;

      // Complete the session on the backend first
      completeMutation.mutate(documentingSessionId);

      setSessionDocumentation((prev) => ({
        ...prev,
        [documentingSessionId]: doc,
      }));
      setSessionStatuses((prev) => ({
        ...prev,
        [documentingSessionId]: 'completed',
      }));
      setExpandedIds((prev) => {
        const next = new Set(prev);
        next.delete(documentingSessionId);
        return next;
      });
      setDocumentingSessionId(null);
      setToastMessage('Session completed. Documentation submitted.');
    },
    [documentingSessionId, completeMutation],
  );

  const handleDocumentationCancel = useCallback(() => {
    setDocumentingSessionId(null);
  }, []);

  const handleToggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleNotesChange = useCallback((id: string, notes: string) => {
    setSessionNotes((prev) => ({ ...prev, [id]: notes }));
  }, []);

  const handleRecordingAction = useCallback(
    (
      id: string,
      action: 'request-consent' | 'confirm-consent' | 'cancel-consent' | 'stop',
    ) => {
      setRecordingStates((prev) => {
        const current: RecordingState = prev[id] ?? {
          isRecording: false,
          consentGiven: false,
          showConsentPrompt: false,
          startedAt: null,
          elapsedSeconds: 0,
          savedAt: null,
        };

        switch (action) {
          case 'request-consent':
            return { ...prev, [id]: { ...current, showConsentPrompt: true } };
          case 'confirm-consent':
            return {
              ...prev,
              [id]: {
                ...current,
                showConsentPrompt: false,
                consentGiven: true,
                isRecording: true,
                startedAt: Date.now(),
                elapsedSeconds: 0,
              },
            };
          case 'cancel-consent':
            return {
              ...prev,
              [id]: {
                ...current,
                showConsentPrompt: false,
              },
            };
          case 'stop':
            return {
              ...prev,
              [id]: {
                ...current,
                isRecording: false,
                savedAt: Date.now(),
              },
            };
          default:
            return prev;
        }
      });
    },
    [],
  );

  const getRecordingState = useCallback(
    (id: string): RecordingState =>
      recordingStates[id] ?? {
        isRecording: false,
        consentGiven: false,
        showConsentPrompt: false,
        startedAt: null,
        elapsedSeconds: 0,
        savedAt: null,
      },
    [recordingStates],
  );

  const tabs: { key: SessionTab; label: string; count: number }[] = [
    { key: 'active', label: 'Active', count: activeSessions.length },
    { key: 'completed', label: 'Completed', count: completedSessions.length },
  ];

  const documentingSession = documentingSessionId
    ? sessions.find((s) => s.id === documentingSessionId) ?? null
    : null;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Page header */}
      <div>
        <h2 className="text-2xl font-semibold text-[#0077B6]">My Sessions</h2>
        <p className="text-sm text-[#555555] mt-1">
          Manage your active sessions and review completed session history.
        </p>
      </div>

      {/* Loading state */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={24} className="animate-spin text-[#6B8F71]" />
          <span className="ml-2 text-sm text-[#8B9B8D]">Loading sessions...</span>
        </div>
      ) : null}

      {/* Tab bar */}
      <div
        role="tablist"
        aria-label="Session tabs"
        className="flex border-b border-[rgba(44,62,45,0.1)]"
      >
        {tabs.map((tab) => {
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setActiveTab(tab.key)}
              className={[
                'flex items-center gap-2 px-4 py-3 text-sm font-semibold border-b-2 -mb-px transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6B8F71]',
                isActive
                  ? 'border-[#6B8F71] text-[#6B8F71]'
                  : 'border-transparent text-[#8B9B8D] hover:text-[#555555]',
              ].join(' ')}
            >
              {tab.label}
              <span
                className={[
                  'inline-flex items-center justify-center w-5 h-5 rounded-full text-xs font-bold',
                  isActive
                    ? 'bg-[rgba(107,143,113,0.15)] text-[#6B8F71]'
                    : 'bg-[#FBF7F0] text-[#8B9B8D]',
                ].join(' ')}
                aria-label={`${tab.count} ${tab.label.toLowerCase()} sessions`}
              >
                {tab.count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Active sessions tab */}
      {activeTab === 'active' && (
        <section aria-label="Active sessions">
          {activeSessions.length > 0 ? (
            <div className="space-y-3">
              {activeSessions.map((session) => (
                <ActiveSessionCard
                  key={session.id}
                  session={{ ...session, status: getStatus(session) }}
                  onStart={handleStart}
                  onEnd={handleEnd}
                  onNotesChange={handleNotesChange}
                  localNotes={sessionNotes[session.id] ?? session.notes ?? ''}
                  isExpanded={expandedIds.has(session.id)}
                  onToggleExpand={handleToggleExpand}
                  recordingState={getRecordingState(session.id)}
                  onRecordingAction={handleRecordingAction}
                  chwId={chwId}
                />
              ))}
            </div>
          ) : (
            <div
              className="bg-white rounded-[20px] border border-[rgba(44,62,45,0.1)] p-10 flex flex-col items-center gap-3 text-center"
              role="status"
            >
              <div className="w-12 h-12 rounded-full bg-[#FBF7F0] border border-[rgba(44,62,45,0.1)] flex items-center justify-center">
                <CalendarClock size={22} className="text-[#8B9B8D]" aria-hidden="true" />
              </div>
              <p className="text-sm font-semibold text-[#2C3E2D]">No active sessions</p>
              <p className="text-xs text-[#8B9B8D]">
                Accept a request to schedule your next session.
              </p>
            </div>
          )}
        </section>
      )}

      {/* Completed sessions tab */}
      {activeTab === 'completed' && (
        <section aria-label="Completed sessions">
          {completedSessions.length > 0 ? (
            <div className="space-y-3">
              {completedSessions.map((session) => {
                const localDoc = sessionDocumentation[session.id];
                const enrichedSession: Session = localDoc
                  ? { ...session, documentation: localDoc }
                  : session;
                return (
                  <CompletedSessionCard
                    key={session.id}
                    session={enrichedSession}
                    isExpanded={expandedIds.has(session.id)}
                    onToggleExpand={handleToggleExpand}
                    claimsBySession={claimsBySession}
                  />
                );
              })}
            </div>
          ) : (
            <div
              className="bg-white rounded-[20px] border border-[rgba(44,62,45,0.1)] p-10 flex flex-col items-center gap-3 text-center"
              role="status"
            >
              <div className="w-12 h-12 rounded-full bg-[#FBF7F0] border border-[rgba(44,62,45,0.1)] flex items-center justify-center">
                <CheckCheck size={22} className="text-[#8B9B8D]" aria-hidden="true" />
              </div>
              <p className="text-sm font-semibold text-[#2C3E2D]">No completed sessions yet</p>
              <p className="text-xs text-[#8B9B8D]">
                Completed sessions will appear here with full billing details.
              </p>
            </div>
          )}
        </section>
      )}

      {/* Documentation modal */}
      {documentingSession && (
        <SessionDocumentationModal
          session={documentingSession}
          durationMinutes={sessionDurations[documentingSession.id] ?? 30}
          onSubmit={handleDocumentationSubmit}
          onCancel={handleDocumentationCancel}
        />
      )}

      {/* Toast notification */}
      {toastMessage && (
        <Toast
          message={toastMessage}
          onDismiss={() => setToastMessage(null)}
        />
      )}
    </div>
  );
}

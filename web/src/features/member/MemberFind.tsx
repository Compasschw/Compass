import { useState, useCallback, useMemo } from 'react';
import { Star, X, CheckCircle, Inbox, ShieldCheck, ArrowLeft } from 'lucide-react';
import { Badge } from '../../shared/components/Badge';
import { VerticalIcon } from '../../shared/components/VerticalIcon';
import { MapView, type MapMarker } from '../../shared/components/MapView';
import {
  chwProfiles,
  type Vertical,
  type CHWProfile,
  type Urgency,
  type SessionMode,
} from '../../data/mock';

// ─── Constants ────────────────────────────────────────────────────────────────

type FilterTab = 'all' | Vertical;

const filterTabs: { key: FilterTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'housing', label: 'Housing' },
  { key: 'food', label: 'Food' },
  { key: 'mental_health', label: 'Mental Health' },
  { key: 'rehab', label: 'Rehab' },
  { key: 'healthcare', label: 'Healthcare' },
];

const urgencyOptions: { key: Urgency; label: string }[] = [
  { key: 'routine', label: 'Routine' },
  { key: 'soon', label: 'Soon' },
  { key: 'urgent', label: 'Urgent' },
];

const modeOptions: { key: SessionMode; label: string }[] = [
  { key: 'in_person', label: 'In Person' },
  { key: 'virtual', label: 'Virtual' },
  { key: 'phone', label: 'Phone' },
];

const verticalOptions: { key: Vertical; label: string; emoji: string }[] = [
  { key: 'housing', label: 'Housing', emoji: '🏠' },
  { key: 'food', label: 'Food Security', emoji: '🛒' },
  { key: 'mental_health', label: 'Mental Health', emoji: '🧠' },
  { key: 'rehab', label: 'Rehab & Recovery', emoji: '💪' },
  { key: 'healthcare', label: 'Healthcare Access', emoji: '🏥' },
];

// ─── Map data ─────────────────────────────────────────────────────────────────

/**
 * Approximate geographic centers for each CHW zip code used in mock data.
 * Coordinates sourced from US Census ZCTA centroids.
 */
const CHW_COORDINATES: Record<string, { lat: number; lng: number }> = {
  '90033': { lat: 34.0445, lng: -118.2107 }, // Boyle Heights
  '90047': { lat: 33.9553, lng: -118.3071 }, // South LA
  '91801': { lat: 34.0953, lng: -118.1270 }, // Alhambra
};

/** Fixed mock resource locations around Los Angeles for the member-facing map. */
const RESOURCE_MARKERS: MapMarker[] = [
  {
    id: 'res-food-1',
    lat: 34.0195,
    lng: -118.1675,
    label: '🛒',
    type: 'resource',
    color: '#F59E0B',
    popupContent: '<strong style="color:#1A1A1A">LA Regional Food Bank</strong><br/><span style="color:#555555">Food Pantry</span>',
  },
  {
    id: 'res-housing-1',
    lat: 34.0453,
    lng: -118.2441,
    label: '🏠',
    type: 'resource',
    color: '#3B82F6',
    popupContent: '<strong style="color:#1A1A1A">Union Rescue Mission</strong><br/><span style="color:#555555">Emergency Shelter</span>',
  },
  {
    id: 'res-housing-2',
    lat: 34.0428,
    lng: -118.2556,
    label: '🏠',
    type: 'resource',
    color: '#3B82F6',
    popupContent: '<strong style="color:#1A1A1A">LAMP Community</strong><br/><span style="color:#555555">Supportive Housing</span>',
  },
  {
    id: 'res-health-1',
    lat: 34.0082,
    lng: -118.3106,
    label: '🏥',
    type: 'resource',
    color: '#0D9488',
    popupContent: "<strong style=\"color:#1A1A1A\">St. John's Well Child Center</strong><br/><span style=\"color:#555555\">Community Clinic</span>",
  },
  {
    id: 'res-mh-1',
    lat: 34.0131,
    lng: -118.3950,
    label: '🧠',
    type: 'resource',
    color: '#7C3AED',
    popupContent: '<strong style="color:#1A1A1A">Didi Hirsch Mental Health</strong><br/><span style="color:#555555">Mental Health Services</span>',
  },
  {
    id: 'res-health-2',
    lat: 34.0759,
    lng: -118.3079,
    label: '🏥',
    type: 'resource',
    color: '#0D9488',
    popupContent: '<strong style="color:#1A1A1A">APLA Health</strong><br/><span style="color:#555555">Community Clinic</span>',
  },
  {
    id: 'res-mh-2',
    lat: 34.0927,
    lng: -118.3443,
    label: '🧠',
    type: 'resource',
    color: '#7C3AED',
    popupContent: '<strong style="color:#1A1A1A">LA LGBT Center</strong><br/><span style="color:#555555">Mental Health &amp; Wellness</span>',
  },
  {
    id: 'res-rehab-1',
    lat: 34.0445,
    lng: -118.2444,
    label: '💪',
    type: 'resource',
    color: '#EF4444',
    popupContent: '<strong style="color:#1A1A1A">Midnight Mission</strong><br/><span style="color:#555555">Rehab &amp; Recovery</span>',
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getInitialsBackground(initials: string): string {
  const backgrounds = [
    'bg-[#D0F0D0] text-[#00B050]',
    'bg-blue-100 text-[#0077B6]',
    'bg-purple-100 text-purple-700',
    'bg-amber-100 text-amber-700',
    'bg-pink-100 text-pink-700',
  ];
  const index = initials.charCodeAt(0) % backgrounds.length;
  return backgrounds[index];
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
      className="fixed top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 bg-[#1A1A1A] text-white text-sm font-medium px-4 py-3 rounded-[12px] shadow-lg max-w-[calc(100vw-2rem)]"
    >
      <CheckCircle size={16} className="text-[#00B050] shrink-0" aria-hidden="true" />
      {message}
    </div>
  );
}

interface StarDisplayProps {
  rating: number;
  size?: number;
}

function StarDisplay({ rating, size = 12 }: StarDisplayProps) {
  const full = Math.floor(rating);
  return (
    <div className="flex items-center gap-0.5" aria-label={`Rating: ${rating} out of 5`}>
      {Array.from({ length: 5 }, (_, i) => (
        <Star
          key={i}
          size={size}
          className={
            i < full
              ? 'text-yellow-400 fill-yellow-400'
              : 'text-[#E5E7EB] fill-[#E5E7EB]'
          }
          aria-hidden="true"
        />
      ))}
      <span className="ml-1 text-xs font-semibold text-[#555555]">{rating.toFixed(1)}</span>
    </div>
  );
}

// ─── Schedule Modal ────────────────────────────────────────────────────────────

interface ScheduleModalProps {
  chw: CHWProfile;
  onClose: () => void;
  onSubmit: (chwName: string) => void;
}

function ScheduleModal({ chw, onClose, onSubmit }: ScheduleModalProps) {
  const [selectedVertical, setSelectedVertical] = useState<Vertical | null>(null);
  const [urgency, setUrgency] = useState<Urgency>('routine');
  const [mode, setMode] = useState<SessionMode>('in_person');
  const [description, setDescription] = useState('');

  // Consent step state — all state resets automatically via key={chw.id} at the call site
  const [step, setStep] = useState<'form' | 'consent'>('form');
  const [consentChecked, setConsentChecked] = useState(false);
  const [typedSignature, setTypedSignature] = useState('');

  const handleFormContinue = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      setStep('consent');
    },
    [],
  );

  const handleConsentSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      onSubmit(chw.name.split(' ')[0]);
    },
    [chw.name, onSubmit],
  );

  const consentSubmitDisabled =
    !consentChecked || typedSignature.trim().length === 0;

  const initColorClass = getInitialsBackground(chw.avatar);

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-40 flex items-end sm:items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="schedule-modal-heading"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded-[16px] w-full max-w-lg max-h-[90vh] overflow-y-auto shadow-xl">
        {/* Modal header */}
        <div className="flex items-center justify-between p-5 border-b border-[#E5E7EB]">
          <div className="flex items-center gap-3">
            <div
              className={`w-10 h-10 rounded-full ${initColorClass} flex items-center justify-center font-bold text-sm shrink-0`}
              aria-hidden="true"
            >
              {chw.avatar}
            </div>
            <div>
              <h2
                id="schedule-modal-heading"
                className="text-base font-bold text-[#1A1A1A]"
              >
                {step === 'form'
                  ? `Schedule with ${chw.name.split(' ')[0]}`
                  : 'Consent for Services'}
              </h2>
              <p className="text-xs text-[#AAAAAA]">{chw.name}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-[#F8FAFB] text-[#AAAAAA] hover:text-[#555555] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0077B6]"
            aria-label="Close modal"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {/* ── Step 1: Form ── */}
        {step === 'form' && (
          <form onSubmit={handleFormContinue} className="p-5 space-y-5">
            {/* What do you need help with */}
            <fieldset>
              <legend className="text-sm font-semibold text-[#1A1A1A] mb-3">
                What do you need help with?
              </legend>
              <div className="space-y-2">
                {verticalOptions.map((option) => {
                  const isSelected = selectedVertical === option.key;
                  return (
                    <button
                      key={option.key}
                      type="button"
                      onClick={() => setSelectedVertical(option.key)}
                      aria-pressed={isSelected}
                      className={[
                        'w-full flex items-center gap-3 px-4 py-3 rounded-[10px] border text-left transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00B050]',
                        isSelected
                          ? 'border-[#00B050] bg-[#D0F0D0]/40'
                          : 'border-[#E5E7EB] bg-white hover:border-[#00B050]/50',
                      ].join(' ')}
                    >
                      <span className="text-xl" role="img" aria-hidden="true">
                        {option.emoji}
                      </span>
                      <span
                        className={`text-sm font-medium ${isSelected ? 'text-[#00B050]' : 'text-[#1A1A1A]'}`}
                      >
                        {option.label}
                      </span>
                      {isSelected && (
                        <CheckCircle
                          size={16}
                          className="text-[#00B050] ml-auto shrink-0"
                          aria-hidden="true"
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            </fieldset>

            {/* Urgency */}
            <fieldset>
              <legend className="text-sm font-semibold text-[#1A1A1A] mb-3">Urgency</legend>
              <div className="flex gap-2">
                {urgencyOptions.map((option) => {
                  const isSelected = urgency === option.key;
                  return (
                    <label
                      key={option.key}
                      className={[
                        'flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-[8px] border cursor-pointer text-sm font-medium transition-all',
                        isSelected
                          ? 'border-[#00B050] bg-[#D0F0D0]/40 text-[#00B050]'
                          : 'border-[#E5E7EB] bg-white text-[#555555] hover:border-[#00B050]/50',
                      ].join(' ')}
                    >
                      <input
                        type="radio"
                        name="urgency"
                        value={option.key}
                        checked={isSelected}
                        onChange={() => setUrgency(option.key)}
                        className="sr-only"
                      />
                      {option.label}
                    </label>
                  );
                })}
              </div>
            </fieldset>

            {/* Preferred mode */}
            <fieldset>
              <legend className="text-sm font-semibold text-[#1A1A1A] mb-3">
                Preferred Mode
              </legend>
              <div className="flex gap-2">
                {modeOptions.map((option) => {
                  const isSelected = mode === option.key;
                  return (
                    <label
                      key={option.key}
                      className={[
                        'flex-1 flex items-center justify-center px-3 py-2.5 rounded-[8px] border cursor-pointer text-sm font-medium transition-all',
                        isSelected
                          ? 'border-[#0077B6] bg-blue-50 text-[#0077B6]'
                          : 'border-[#E5E7EB] bg-white text-[#555555] hover:border-[#0077B6]/50',
                      ].join(' ')}
                    >
                      <input
                        type="radio"
                        name="mode"
                        value={option.key}
                        checked={isSelected}
                        onChange={() => setMode(option.key)}
                        className="sr-only"
                      />
                      {option.label}
                    </label>
                  );
                })}
              </div>
            </fieldset>

            {/* Description */}
            <div>
              <label
                htmlFor="schedule-description"
                className="text-sm font-semibold text-[#1A1A1A] block mb-2"
              >
                Description <span className="text-[#AAAAAA] font-normal">(optional)</span>
              </label>
              <textarea
                id="schedule-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Briefly describe what you need help with..."
                rows={3}
                className="w-full px-3 py-2.5 rounded-[8px] border border-[#E5E7EB] text-sm text-[#1A1A1A] placeholder:text-[#AAAAAA] resize-none focus:outline-none focus:ring-2 focus:ring-[#00B050]/30 focus:border-[#00B050] transition-colors"
              />
            </div>

            {/* Continue button */}
            <button
              type="submit"
              disabled={selectedVertical === null}
              className="w-full bg-[#00B050] hover:bg-[#008F40] active:bg-[#007A38] disabled:bg-[#E5E7EB] disabled:text-[#AAAAAA] disabled:cursor-not-allowed text-white text-sm font-semibold py-3 rounded-[8px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00B050]"
            >
              Continue &rarr;
            </button>
          </form>
        )}

        {/* ── Step 2: Consent ── */}
        {step === 'consent' && (
          <form onSubmit={handleConsentSubmit} className="p-5 space-y-5">
            {/* Back navigation */}
            <button
              type="button"
              onClick={() => setStep('form')}
              className="flex items-center gap-1.5 text-sm font-medium text-[#0077B6] hover:text-[#005A8C] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0077B6] rounded"
              aria-label="Back to request form"
            >
              <ArrowLeft size={15} aria-hidden="true" />
              Back
            </button>

            {/* Info card */}
            <div className="flex items-start gap-3 bg-blue-50 border border-blue-100 rounded-[12px] p-4">
              <div
                className="w-9 h-9 rounded-[8px] bg-[#0077B6]/10 flex items-center justify-center shrink-0 mt-0.5"
                aria-hidden="true"
              >
                <ShieldCheck size={18} className="text-[#0077B6]" />
              </div>
              <p className="text-sm text-[#0077B6] leading-relaxed">
                CHW services are provided to you at no cost by your health plan. Do you
                consent to receive services?
              </p>
            </div>

            {/* Consent checkbox */}
            <div>
              <label className="flex items-start gap-3 cursor-pointer group">
                <div className="relative mt-0.5 shrink-0">
                  <input
                    type="checkbox"
                    id="consent-checkbox"
                    checked={consentChecked}
                    onChange={(e) => setConsentChecked(e.target.checked)}
                    className="sr-only"
                  />
                  <div
                    aria-hidden="true"
                    className={[
                      'w-5 h-5 rounded-[4px] border-2 flex items-center justify-center transition-all',
                      consentChecked
                        ? 'bg-[#0077B6] border-[#0077B6]'
                        : 'bg-white border-[#E5E7EB] group-hover:border-[#0077B6]/50',
                    ].join(' ')}
                    onClick={() => setConsentChecked((prev) => !prev)}
                  >
                    {consentChecked && (
                      <CheckCircle size={13} className="text-white" aria-hidden="true" />
                    )}
                  </div>
                </div>
                <span className="text-sm font-medium text-[#1A1A1A] leading-relaxed select-none">
                  I consent to receive Community Health Worker services
                </span>
              </label>
            </div>

            {/* Signature input */}
            <div>
              <label
                htmlFor="consent-signature"
                className="text-sm font-semibold text-[#1A1A1A] block mb-2"
              >
                Type your full name as signature
              </label>
              <input
                id="consent-signature"
                type="text"
                value={typedSignature}
                onChange={(e) => setTypedSignature(e.target.value)}
                placeholder="Your full name"
                autoComplete="name"
                className="w-full px-3 py-2.5 rounded-[8px] border border-[#E5E7EB] text-sm text-[#1A1A1A] placeholder:text-[#AAAAAA] focus:outline-none focus:ring-2 focus:ring-[#0077B6]/30 focus:border-[#0077B6] transition-colors"
                style={{ fontStyle: 'italic' }}
              />
            </div>

            {/* Submit */}
            <button
              type="submit"
              disabled={consentSubmitDisabled}
              className="w-full bg-[#0077B6] hover:bg-[#005A8C] active:bg-[#004A78] disabled:bg-[#E5E7EB] disabled:text-[#AAAAAA] disabled:cursor-not-allowed text-white text-sm font-semibold py-3 rounded-[8px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0077B6]"
            >
              Submit Request
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

// ─── CHW Card ─────────────────────────────────────────────────────────────────

interface CHWCardProps {
  chw: CHWProfile;
  onSchedule: (chw: CHWProfile) => void;
}

function CHWCard({ chw, onSchedule }: CHWCardProps) {
  const initColorClass = getInitialsBackground(chw.avatar);

  return (
    <article
      className="bg-white rounded-[12px] border border-[#E5E7EB] p-4"
      aria-label={`${chw.name}, CHW`}
    >
      <div className="flex items-start gap-3">
        {/* Avatar */}
        <div
          className={`w-12 h-12 rounded-full ${initColorClass} flex items-center justify-center font-bold text-base shrink-0`}
          aria-hidden="true"
        >
          {chw.avatar}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          {/* Name row */}
          <div className="flex items-start justify-between gap-2 mb-1">
            <p className="text-sm font-bold text-[#1A1A1A]">{chw.name}</p>
          </div>

          {/* Rating + experience */}
          <div className="flex items-center gap-3 mb-2">
            <StarDisplay rating={chw.rating} />
            <span className="text-xs text-[#AAAAAA]">
              {chw.yearsExperience} yrs exp
            </span>
          </div>

          {/* Specialization tags */}
          <div className="flex flex-wrap gap-1 mb-2">
            {chw.specializations.map((vertical) => (
              <Badge key={vertical} variant="vertical" value={vertical} />
            ))}
          </div>

          {/* Languages */}
          <p className="text-xs text-[#555555] mb-2">
            <span className="font-medium text-[#AAAAAA] uppercase tracking-wide text-[10px] mr-1">
              Languages:
            </span>
            {chw.languages.join(', ')}
          </p>

          {/* Bio — 2-line clamp */}
          <p className="text-xs text-[#555555] leading-relaxed line-clamp-2 mb-3">
            {chw.bio}
          </p>

          {/* Schedule button */}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => onSchedule(chw)}
              className="bg-[#00B050] hover:bg-[#008F40] active:bg-[#007A38] text-white text-xs font-semibold px-4 py-2 rounded-[8px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00B050]"
              aria-label={`Schedule a session with ${chw.name}`}
            >
              Schedule
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * MemberFind — "Find Your CHW" page.
 *
 * Features:
 * - Filter tabs by vertical category (scrollable on mobile)
 * - Map placeholder card
 * - Filtered list of available CHWs
 * - Schedule modal with vertical selection, urgency, mode, description
 * - Toast confirmation on submit
 */
export function MemberFind() {
  const [activeFilter, setActiveFilter] = useState<FilterTab>('all');
  const [schedulingChw, setSchedulingChw] = useState<CHWProfile | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const availableChws = useMemo(
    () => chwProfiles.filter((c) => c.isAvailable),
    [],
  );

  const filteredChws = useMemo(
    () =>
      availableChws.filter(
        (c) => activeFilter === 'all' || c.specializations.includes(activeFilter as Vertical),
      ),
    [availableChws, activeFilter],
  );

  /** Build CHW map markers from available CHW profiles + known zip-code coordinates. */
  const chwMarkers = useMemo<MapMarker[]>(
    () =>
      availableChws
        .filter((c) => c.zipCode in CHW_COORDINATES)
        .map((c) => {
          const coords = CHW_COORDINATES[c.zipCode];
          // Slightly jitter markers sharing the same zip so they don't stack
          const jitter = () => (Math.random() - 0.5) * 0.008;
          const specializations = c.specializations
            .map((s) => `<span style="display:inline-block;padding:2px 6px;background:#D0F0D0;color:#00B050;border-radius:4px;font-size:11px;margin:1px 2px">${s.replace('_', ' ')}</span>`)
            .join('');
          return {
            id: c.id,
            lat: coords.lat + jitter(),
            lng: coords.lng + jitter(),
            label: c.avatar,
            type: 'chw' as const,
            color: '#00B050',
            popupContent: `
              <strong style="color:#1A1A1A;font-size:14px">${c.name}</strong><br/>
              <span style="color:#555555;font-size:12px">${c.yearsExperience} yrs exp · ★ ${c.rating}</span><br/>
              <div style="margin-top:6px">${specializations}</div>
            `,
          };
        }),
    [availableChws],
  );

  const allMapMarkers = useMemo(
    () => [...chwMarkers, ...RESOURCE_MARKERS],
    [chwMarkers],
  );

  const showToast = useCallback((message: string) => {
    setToastMessage(message);
    const timer = setTimeout(() => setToastMessage(null), 3500);
    return () => clearTimeout(timer);
  }, []);

  const handleSchedule = useCallback((chw: CHWProfile) => {
    setSchedulingChw(chw);
  }, []);

  const handleModalClose = useCallback(() => {
    setSchedulingChw(null);
  }, []);

  const handleModalSubmit = useCallback(
    (firstName: string) => {
      setSchedulingChw(null);
      showToast(`Request submitted! ${firstName} will be in touch soon.`);
    },
    [showToast],
  );

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Toast */}
      {toastMessage && <Toast message={toastMessage} />}

      {/* Schedule modal — key={chw.id} ensures all state resets when a different CHW is selected */}
      {schedulingChw && (
        <ScheduleModal
          key={schedulingChw.id}
          chw={schedulingChw}
          onClose={handleModalClose}
          onSubmit={handleModalSubmit}
        />
      )}

      {/* Page header */}
      <div>
        <h2 className="text-2xl font-semibold text-[#0077B6]">Find Your CHW</h2>
        <p className="text-sm text-[#555555] mt-1">Matched to your needs</p>
      </div>

      {/* Filter tabs */}
      <div
        role="tablist"
        aria-label="Filter by category"
        className="flex gap-1 overflow-x-auto pb-1 scrollbar-hide -mx-4 px-4 sm:mx-0 sm:px-0"
      >
        {filterTabs.map((tab) => {
          const isActive = activeFilter === tab.key;
          const count =
            tab.key === 'all'
              ? availableChws.length
              : availableChws.filter((c) =>
                  c.specializations.includes(tab.key as Vertical),
                ).length;

          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setActiveFilter(tab.key)}
              className={[
                'shrink-0 px-3.5 py-1.5 text-sm font-medium rounded-full border transition-all whitespace-nowrap focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00B050]',
                isActive
                  ? 'bg-[#00B050] border-[#00B050] text-white'
                  : 'bg-white border-[#E5E7EB] text-[#555555] hover:border-[#00B050] hover:text-[#00B050]',
              ].join(' ')}
            >
              {tab.label}
              {count > 0 && (
                <span
                  className={[
                    'ml-1.5 text-xs font-semibold',
                    isActive ? 'text-white/80' : 'text-[#AAAAAA]',
                  ].join(' ')}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Interactive map — CHW locations + local resources */}
      <section aria-labelledby="map-section-heading">
        <div className="flex items-center justify-between mb-2">
          <h3
            id="map-section-heading"
            className="text-sm font-semibold text-[#1A1A1A] uppercase tracking-wide"
          >
            Local Healthcare Map
          </h3>
          <div className="flex items-center gap-3 text-xs text-[#555555]">
            <span className="flex items-center gap-1">
              <span
                className="inline-block w-3 h-3 rounded-full"
                style={{ background: '#00B050' }}
                aria-hidden="true"
              />
              CHWs
            </span>
            <span className="flex items-center gap-1">
              <span
                className="inline-block w-3 h-3 rounded-full"
                style={{ background: '#3B82F6' }}
                aria-hidden="true"
              />
              Resources
            </span>
          </div>
        </div>
        <MapView
          centerLat={34.0522}
          centerLng={-118.2437}
          zoom={11}
          height="200px"
          markers={allMapMarkers}
          className="sm:!h-[250px]"
          borderRadius={12}
        />
      </section>

      {/* Available CHWs section */}
      <section aria-labelledby="available-chws-heading">
        <h3
          id="available-chws-heading"
          className="text-sm font-semibold text-[#1A1A1A] uppercase tracking-wide mb-3"
        >
          Available CHWs
        </h3>

        {filteredChws.length > 0 ? (
          <div className="space-y-3">
            {filteredChws.map((chw) => (
              <CHWCard key={chw.id} chw={chw} onSchedule={handleSchedule} />
            ))}
          </div>
        ) : (
          <div
            className="bg-white rounded-[12px] border border-[#E5E7EB] p-10 flex flex-col items-center gap-3 text-center"
            role="status"
          >
            <div className="w-12 h-12 rounded-full bg-[#F8FAFB] border border-[#E5E7EB] flex items-center justify-center">
              <Inbox size={22} className="text-[#AAAAAA]" aria-hidden="true" />
            </div>
            <p className="text-sm font-semibold text-[#1A1A1A]">No CHWs available</p>
            <p className="text-xs text-[#AAAAAA] max-w-xs">
              No available CHWs match this category right now. Try a different filter or
              check back soon.
            </p>
          </div>
        )}
      </section>

      {/* Vertical icon legend — contextual */}
      <div className="flex flex-wrap items-center justify-center gap-3 pb-2">
        {(['housing', 'food', 'mental_health', 'rehab', 'healthcare'] as Vertical[]).map(
          (v) => (
            <div key={v} className="flex items-center gap-1">
              <VerticalIcon vertical={v} size={14} />
            </div>
          ),
        )}
        <p className="text-xs text-[#AAAAAA]">Icons represent service specializations</p>
      </div>
    </div>
  );
}

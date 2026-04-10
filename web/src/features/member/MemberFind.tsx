import { useState, useCallback, useMemo } from 'react';
import { Star, X, CheckCircle, Inbox, ShieldCheck, ArrowLeft, Loader2 } from 'lucide-react';
import { Badge } from '../../shared/components/Badge';
import { VerticalIcon } from '../../shared/components/VerticalIcon';
import { MapView, type MapMarker } from '../../shared/components/MapView';
import {
  type Vertical,
  type CHWProfile,
  type Urgency,
  type SessionMode,
} from '../../data/mock';
import { useChwBrowse } from '../../api/hooks';
import { createRequest } from '../../api/requests';
import type { CHWBrowseData } from '../../api/chw';

/** Adapt API snake_case data to the camelCase CHWProfile the component expects */
function toProfile(d: CHWBrowseData): CHWProfile {
  const initials = d.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  return {
    id: d.id,
    name: d.name,
    avatar: initials,
    specializations: d.specializations as Vertical[],
    languages: d.languages,
    rating: d.rating,
    yearsExperience: d.years_experience,
    totalSessions: d.total_sessions,
    isAvailable: d.is_available,
    bio: d.bio ?? '',
    zipCode: d.zip_code ?? '',
  };
}

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
    popupContent: (<><strong style={{ color: "#2C3E2D" }}>LA Regional Food Bank</strong><br/><span style={{ color: "#555" }}>Food Pantry</span></>),
  },
  {
    id: 'res-housing-1',
    lat: 34.0453,
    lng: -118.2441,
    label: '🏠',
    type: 'resource',
    color: '#3B82F6',
    popupContent: (<><strong style={{ color: "#2C3E2D" }}>Union Rescue Mission</strong><br/><span style={{ color: "#555" }}>Emergency Shelter</span></>),
  },
  {
    id: 'res-housing-2',
    lat: 34.0428,
    lng: -118.2556,
    label: '🏠',
    type: 'resource',
    color: '#3B82F6',
    popupContent: (<><strong style={{ color: "#2C3E2D" }}>LAMP Community</strong><br/><span style={{ color: "#555" }}>Supportive Housing</span></>),
  },
  {
    id: 'res-health-1',
    lat: 34.0082,
    lng: -118.3106,
    label: '🏥',
    type: 'resource',
    color: '#0D9488',
    popupContent: (<><strong style={{ color: '#2C3E2D' }}>{"St. John's Well Child Center"}</strong><br/><span style={{ color: '#555' }}>Community Clinic</span></>),
  },
  {
    id: 'res-mh-1',
    lat: 34.0131,
    lng: -118.3950,
    label: '🧠',
    type: 'resource',
    color: '#7C3AED',
    popupContent: (<><strong style={{ color: "#2C3E2D" }}>Didi Hirsch Mental Health</strong><br/><span style={{ color: "#555" }}>Mental Health Services</span></>),
  },
  {
    id: 'res-health-2',
    lat: 34.0759,
    lng: -118.3079,
    label: '🏥',
    type: 'resource',
    color: '#0D9488',
    popupContent: (<><strong style={{ color: "#2C3E2D" }}>APLA Health</strong><br/><span style={{ color: "#555" }}>Community Clinic</span></>),
  },
  {
    id: 'res-mh-2',
    lat: 34.0927,
    lng: -118.3443,
    label: '🧠',
    type: 'resource',
    color: '#7C3AED',
    popupContent: (<><strong style={{ color: "#2C3E2D" }}>LA LGBT Center</strong><br/><span style={{ color: "#555" }}>Mental Health &amp; Wellness</span></>),
  },
  {
    id: 'res-rehab-1',
    lat: 34.0445,
    lng: -118.2444,
    label: '💪',
    type: 'resource',
    color: '#EF4444',
    popupContent: (<><strong style={{ color: "#2C3E2D" }}>Midnight Mission</strong><br/><span style={{ color: "#555" }}>Rehab &amp; Recovery</span></>),
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getInitialsBackground(initials: string): string {
  const backgrounds = [
    'bg-[rgba(107,143,113,0.15)] text-[#6B8F71]',
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
      className="fixed top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 bg-[#2C3E2D] text-white text-sm font-medium px-4 py-3 rounded-[20px] shadow-lg max-w-[calc(100vw-2rem)]"
    >
      <CheckCircle size={16} className="text-[#6B8F71] shrink-0" aria-hidden="true" />
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
              : 'text-[rgba(44,62,45,0.1)] fill-[rgba(44,62,45,0.1)]'
          }
          aria-hidden="true"
        />
      ))}
      <span className="ml-1 text-xs font-semibold text-[#555555]">{rating.toFixed(1)}</span>
    </div>
  );
}

// ─── Schedule Modal ────────────────────────────────────────────────────────────

interface ScheduleFormData {
  vertical: Vertical;
  urgency: Urgency;
  mode: SessionMode;
  description: string;
}

interface ScheduleModalProps {
  chw: CHWProfile;
  onClose: () => void;
  onSubmit: (chwName: string, formData: ScheduleFormData) => void;
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
      onSubmit(chw.name.split(' ')[0], {
        vertical: selectedVertical!,
        urgency,
        mode,
        description,
      });
    },
    [chw.name, onSubmit, selectedVertical, urgency, mode, description],
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
        <div className="flex items-center justify-between p-5 border-b border-[rgba(44,62,45,0.1)]">
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
                className="text-base font-bold text-[#2C3E2D]"
              >
                {step === 'form'
                  ? `Schedule with ${chw.name.split(' ')[0]}`
                  : 'Consent for Services'}
              </h2>
              <p className="text-xs text-[#8B9B8D]">{chw.name}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-[#FBF7F0] text-[#8B9B8D] hover:text-[#555555] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0077B6]"
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
              <legend className="text-sm font-semibold text-[#2C3E2D] mb-3">
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
                        'w-full flex items-center gap-3 px-4 py-3 rounded-[10px] border text-left transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6B8F71]',
                        isSelected
                          ? 'border-[#6B8F71] bg-[rgba(107,143,113,0.15)]/40'
                          : 'border-[rgba(44,62,45,0.1)] bg-white hover:border-[#6B8F71]/50',
                      ].join(' ')}
                    >
                      <span className="text-xl" role="img" aria-hidden="true">
                        {option.emoji}
                      </span>
                      <span
                        className={`text-sm font-medium ${isSelected ? 'text-[#6B8F71]' : 'text-[#2C3E2D]'}`}
                      >
                        {option.label}
                      </span>
                      {isSelected && (
                        <CheckCircle
                          size={16}
                          className="text-[#6B8F71] ml-auto shrink-0"
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
              <legend className="text-sm font-semibold text-[#2C3E2D] mb-3">Urgency</legend>
              <div className="flex gap-2">
                {urgencyOptions.map((option) => {
                  const isSelected = urgency === option.key;
                  return (
                    <label
                      key={option.key}
                      className={[
                        'flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-[12px] border cursor-pointer text-sm font-medium transition-all',
                        isSelected
                          ? 'border-[#6B8F71] bg-[rgba(107,143,113,0.15)]/40 text-[#6B8F71]'
                          : 'border-[rgba(44,62,45,0.1)] bg-white text-[#555555] hover:border-[#6B8F71]/50',
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
              <legend className="text-sm font-semibold text-[#2C3E2D] mb-3">
                Preferred Mode
              </legend>
              <div className="flex gap-2">
                {modeOptions.map((option) => {
                  const isSelected = mode === option.key;
                  return (
                    <label
                      key={option.key}
                      className={[
                        'flex-1 flex items-center justify-center px-3 py-2.5 rounded-[12px] border cursor-pointer text-sm font-medium transition-all',
                        isSelected
                          ? 'border-[#0077B6] bg-blue-50 text-[#0077B6]'
                          : 'border-[rgba(44,62,45,0.1)] bg-white text-[#555555] hover:border-[#0077B6]/50',
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
                className="text-sm font-semibold text-[#2C3E2D] block mb-2"
              >
                Description <span className="text-[#8B9B8D] font-normal">(optional)</span>
              </label>
              <textarea
                id="schedule-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Briefly describe what you need help with..."
                rows={3}
                className="w-full px-3 py-2.5 rounded-[12px] border border-[rgba(44,62,45,0.1)] text-sm text-[#2C3E2D] placeholder:text-[#8B9B8D] resize-none focus:outline-none focus:ring-2 focus:ring-[#6B8F71]/30 focus:border-[#6B8F71] transition-colors"
              />
            </div>

            {/* Continue button */}
            <button
              type="submit"
              disabled={selectedVertical === null}
              className="w-full bg-[#2C3E2D] hover:bg-[#3A5240] active:bg-[#243D25] disabled:bg-[rgba(44,62,45,0.1)] disabled:text-[#8B9B8D] disabled:cursor-not-allowed text-white text-sm font-semibold py-3 rounded-[12px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6B8F71]"
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
                className="w-9 h-9 rounded-[12px] bg-[#0077B6]/10 flex items-center justify-center shrink-0 mt-0.5"
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
                        : 'bg-white border-[rgba(44,62,45,0.1)] group-hover:border-[#0077B6]/50',
                    ].join(' ')}
                    onClick={() => setConsentChecked((prev) => !prev)}
                  >
                    {consentChecked && (
                      <CheckCircle size={13} className="text-white" aria-hidden="true" />
                    )}
                  </div>
                </div>
                <span className="text-sm font-medium text-[#2C3E2D] leading-relaxed select-none">
                  I consent to receive Community Health Worker services
                </span>
              </label>
            </div>

            {/* Signature input */}
            <div>
              <label
                htmlFor="consent-signature"
                className="text-sm font-semibold text-[#2C3E2D] block mb-2"
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
                className="w-full px-3 py-2.5 rounded-[12px] border border-[rgba(44,62,45,0.1)] text-sm text-[#2C3E2D] placeholder:text-[#8B9B8D] focus:outline-none focus:ring-2 focus:ring-[#0077B6]/30 focus:border-[#0077B6] transition-colors"
                style={{ fontStyle: 'italic' }}
              />
            </div>

            {/* Submit */}
            <button
              type="submit"
              disabled={consentSubmitDisabled}
              className="w-full bg-[#0077B6] hover:bg-[#005A8C] active:bg-[#004A78] disabled:bg-[rgba(44,62,45,0.1)] disabled:text-[#8B9B8D] disabled:cursor-not-allowed text-white text-sm font-semibold py-3 rounded-[12px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0077B6]"
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
      className="bg-white rounded-[20px] border border-[rgba(44,62,45,0.1)] p-4"
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
            <p className="text-sm font-bold text-[#2C3E2D]">{chw.name}</p>
          </div>

          {/* Rating + experience */}
          <div className="flex items-center gap-3 mb-2">
            <StarDisplay rating={chw.rating} />
            <span className="text-xs text-[#8B9B8D]">
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
            <span className="font-medium text-[#8B9B8D] uppercase tracking-wide text-[10px] mr-1">
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
              className="bg-[#2C3E2D] hover:bg-[#3A5240] active:bg-[#243D25] text-white text-xs font-semibold px-4 py-2 rounded-[12px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6B8F71]"
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

  const { data: browseData = [], isLoading } = useChwBrowse();
  const availableChws = useMemo(
    () => browseData.map(toProfile),
    [browseData],
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
          return {
            id: c.id,
            lat: coords.lat + jitter(),
            lng: coords.lng + jitter(),
            label: c.avatar,
            type: 'chw' as const,
            color: '#6B8F71',
            popupContent: (
              <>
                <strong style={{ color: '#2C3E2D', fontSize: '14px' }}>{c.name}</strong><br/>
                <span style={{ color: '#555', fontSize: '12px' }}>{c.yearsExperience} yrs exp · ★ {c.rating}</span>
                <div style={{ marginTop: '6px', display: 'flex', flexWrap: 'wrap' as const, gap: '2px' }}>
                  {c.specializations.map((s) => (
                    <span key={s} style={{ display: 'inline-block', padding: '2px 6px', background: 'rgba(107,143,113,0.15)', color: '#6B8F71', borderRadius: '4px', fontSize: '11px' }}>{s.replace('_', ' ')}</span>
                  ))}
                </div>
              </>
            ),
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
    async (firstName: string, formData: ScheduleFormData) => {
      try {
        await createRequest({
          vertical: formData.vertical,
          urgency: formData.urgency,
          preferred_mode: formData.mode,
          description: formData.description,
          estimated_units: 1,
        });
        setSchedulingChw(null);
        showToast(`Request submitted! ${firstName} will be in touch soon.`);
      } catch {
        showToast('Failed to submit request. Please try again.');
      }
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
                'shrink-0 px-3.5 py-1.5 text-sm font-medium rounded-full border transition-all whitespace-nowrap focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6B8F71]',
                isActive
                  ? 'bg-[#2C3E2D] border-[#6B8F71] text-white'
                  : 'bg-white border-[rgba(44,62,45,0.1)] text-[#555555] hover:border-[#6B8F71] hover:text-[#6B8F71]',
              ].join(' ')}
            >
              {tab.label}
              {count > 0 && (
                <span
                  className={[
                    'ml-1.5 text-xs font-semibold',
                    isActive ? 'text-white/80' : 'text-[#8B9B8D]',
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
            className="text-sm font-semibold text-[#2C3E2D] uppercase tracking-wide"
          >
            Local Healthcare Map
          </h3>
          <div className="flex items-center gap-3 text-xs text-[#555555]">
            <span className="flex items-center gap-1">
              <span
                className="inline-block w-3 h-3 rounded-full"
                style={{ background: '#2C3E2D' }}
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
          className="text-sm font-semibold text-[#2C3E2D] uppercase tracking-wide mb-3"
        >
          Available CHWs
        </h3>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={24} className="animate-spin text-[#6B8F71]" />
            <span className="ml-2 text-sm text-[#8B9B8D]">Finding CHWs near you...</span>
          </div>
        ) : filteredChws.length > 0 ? (
          <div className="space-y-3">
            {filteredChws.map((chw) => (
              <CHWCard key={chw.id} chw={chw} onSchedule={handleSchedule} />
            ))}
          </div>
        ) : (
          <div
            className="bg-white rounded-[20px] border border-[rgba(44,62,45,0.1)] p-10 flex flex-col items-center gap-3 text-center"
            role="status"
          >
            <div className="w-12 h-12 rounded-full bg-[#FBF7F0] border border-[rgba(44,62,45,0.1)] flex items-center justify-center">
              <Inbox size={22} className="text-[#8B9B8D]" aria-hidden="true" />
            </div>
            <p className="text-sm font-semibold text-[#2C3E2D]">No CHWs available</p>
            <p className="text-xs text-[#8B9B8D] max-w-xs">
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
        <p className="text-xs text-[#8B9B8D]">Icons represent service specializations</p>
      </div>
    </div>
  );
}

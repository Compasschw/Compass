import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  CheckCircle2,
  ShieldCheck,
  Home as HomeIcon,
  Utensils,
  Brain,
  Stethoscope,
  RefreshCw,
} from 'lucide-react';
import { createRequest } from '../../api/requests';

/**
 * MemberRequestHelp — direct request submission entry point for members.
 *
 * Distinct from MemberFind: there the member browses CHWs first and submits
 * via the schedule-modal on a specific provider. Here we let the member
 * file a request immediately ("I need help with food / housing / etc.")
 * without committing to a particular CHW. The request lands in the open
 * queue and any matched CHW can pick it up — exactly the same backend
 * behavior, but with one fewer step for the member.
 */

type Vertical = 'food' | 'housing' | 'mental_health' | 'healthcare' | 'rehab';
type Urgency = 'routine' | 'soon' | 'urgent';
type Mode = 'phone' | 'virtual' | 'in_person';

interface VerticalOption {
  key: Vertical;
  label: string;
  Icon: React.ComponentType<{ size?: number; className?: string }>;
}

const VERTICAL_OPTIONS: VerticalOption[] = [
  { key: 'food', label: 'Food access', Icon: Utensils },
  { key: 'housing', label: 'Housing', Icon: HomeIcon },
  { key: 'healthcare', label: 'Healthcare navigation', Icon: Stethoscope },
  { key: 'mental_health', label: 'Mental health support', Icon: Brain },
  { key: 'rehab', label: 'Recovery / rehab', Icon: RefreshCw },
];

const URGENCY_OPTIONS: { key: Urgency; label: string; sub: string }[] = [
  { key: 'routine', label: 'Routine', sub: 'Within a couple weeks' },
  { key: 'soon', label: 'Soon', sub: 'In the next few days' },
  { key: 'urgent', label: 'Urgent', sub: 'Today or tomorrow' },
];

const MODE_OPTIONS: { key: Mode; label: string }[] = [
  { key: 'phone', label: 'Phone call' },
  { key: 'virtual', label: 'Chat / video' },
  { key: 'in_person', label: 'In person' },
];

export function MemberRequestHelp() {
  const navigate = useNavigate();
  const [vertical, setVertical] = useState<Vertical | null>(null);
  const [urgency, setUrgency] = useState<Urgency>('routine');
  const [mode, setMode] = useState<Mode>('phone');
  const [description, setDescription] = useState('');
  const [consentChecked, setConsentChecked] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const canSubmit =
    !!vertical &&
    description.trim().length >= 5 &&
    consentChecked &&
    !isSubmitting;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit || !vertical) return;

    setError(null);
    setIsSubmitting(true);
    try {
      await createRequest({
        vertical,
        urgency,
        preferred_mode: mode,
        description: description.trim(),
        estimated_units: 1,
      });
      setSuccess(true);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Could not submit your request. Please try again.',
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  // ── Success view ───────────────────────────────────────────────────────────
  if (success) {
    return (
      <div className="max-w-xl mx-auto p-4">
        <div className="bg-white rounded-[20px] border border-[rgba(44,62,45,0.08)] p-8 text-center">
          <div className="w-14 h-14 rounded-full bg-[rgba(107,143,113,0.15)] flex items-center justify-center mx-auto mb-4">
            <CheckCircle2 size={28} className="text-[#6B8F71]" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-semibold text-[#2C3E2D]">
            Request submitted
          </h1>
          <p className="text-sm text-[#555555] mt-2 leading-relaxed">
            A Community Health Worker matched to your needs will accept your
            request shortly. You'll get a notification by email and can see
            your scheduled session on the Calendar tab.
          </p>
          <div className="mt-8 flex flex-col gap-2">
            <button
              type="button"
              onClick={() => navigate('/member/home')}
              className="bg-[#2C3E2D] hover:bg-[#3A5240] text-white font-semibold py-2.5 rounded-[12px] text-sm transition-colors"
            >
              Back to Home
            </button>
            <button
              type="button"
              onClick={() => {
                setVertical(null);
                setUrgency('routine');
                setMode('phone');
                setDescription('');
                setConsentChecked(false);
                setSuccess(false);
              }}
              className="text-[#6B7B6D] hover:text-[#2C3E2D] font-medium py-2 text-sm transition-colors"
            >
              Submit another request
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Form view ──────────────────────────────────────────────────────────────
  return (
    <div className="max-w-xl mx-auto p-4">
      {/* Back link */}
      <button
        type="button"
        onClick={() => navigate('/member/home')}
        className="flex items-center gap-1.5 text-sm font-medium text-[#0077B6] hover:text-[#005A8C] transition-colors mb-4"
      >
        <ArrowLeft size={15} aria-hidden="true" />
        Back to home
      </button>

      <div className="bg-white rounded-[20px] border border-[rgba(44,62,45,0.08)] p-6 sm:p-8">
        <h1 className="text-2xl font-semibold text-[#2C3E2D]">
          Request help from a CHW
        </h1>
        <p className="text-sm text-[#555555] mt-1.5">
          Tell us what you need. A Community Health Worker matched to your
          situation will accept your request and reach out.
        </p>

        <form onSubmit={handleSubmit} className="mt-6 space-y-6">
          {/* Vertical chooser */}
          <fieldset>
            <legend className="block text-sm font-medium text-[#2C3E2D] mb-2">
              What do you need help with?
            </legend>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {VERTICAL_OPTIONS.map(({ key, label, Icon }) => {
                const active = vertical === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setVertical(key)}
                    className={`flex items-center gap-3 px-3 py-3 rounded-[12px] border text-left transition-colors ${
                      active
                        ? 'border-[#6B8F71] bg-[rgba(107,143,113,0.08)]'
                        : 'border-[rgba(44,62,45,0.1)] hover:border-[#6B8F71]/50'
                    }`}
                    aria-pressed={active}
                  >
                    <Icon
                      size={18}
                      className={active ? 'text-[#6B8F71]' : 'text-[#555555]'}
                    />
                    <span
                      className={`text-sm ${active ? 'font-semibold text-[#2C3E2D]' : 'text-[#555555]'}`}
                    >
                      {label}
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          {/* Urgency */}
          <fieldset>
            <legend className="block text-sm font-medium text-[#2C3E2D] mb-2">
              How soon do you need help?
            </legend>
            <div className="grid grid-cols-3 gap-2">
              {URGENCY_OPTIONS.map(({ key, label, sub }) => {
                const active = urgency === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setUrgency(key)}
                    className={`flex flex-col items-start gap-0.5 px-3 py-2.5 rounded-[12px] border text-left transition-colors ${
                      active
                        ? 'border-[#6B8F71] bg-[rgba(107,143,113,0.08)]'
                        : 'border-[rgba(44,62,45,0.1)] hover:border-[#6B8F71]/50'
                    }`}
                    aria-pressed={active}
                  >
                    <span
                      className={`text-sm font-semibold ${active ? 'text-[#2C3E2D]' : 'text-[#555555]'}`}
                    >
                      {label}
                    </span>
                    <span className="text-[11px] text-[#8B9B8D]">{sub}</span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          {/* Mode */}
          <fieldset>
            <legend className="block text-sm font-medium text-[#2C3E2D] mb-2">
              How would you prefer to meet?
            </legend>
            <div className="grid grid-cols-3 gap-2">
              {MODE_OPTIONS.map(({ key, label }) => {
                const active = mode === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setMode(key)}
                    className={`px-3 py-2.5 rounded-[12px] border text-sm font-medium transition-colors ${
                      active
                        ? 'border-[#6B8F71] bg-[rgba(107,143,113,0.08)] text-[#2C3E2D]'
                        : 'border-[rgba(44,62,45,0.1)] hover:border-[#6B8F71]/50 text-[#555555]'
                    }`}
                    aria-pressed={active}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </fieldset>

          {/* Description */}
          <div>
            <label
              htmlFor="request-description"
              className="block text-sm font-medium text-[#2C3E2D] mb-1.5"
            >
              Tell us more
            </label>
            <textarea
              id="request-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              maxLength={500}
              placeholder="Briefly describe what's going on so the CHW can prepare. (5-500 chars)"
              className="w-full rounded-[12px] border border-[rgba(44,62,45,0.1)] px-3.5 py-2.5 text-sm text-[#2C3E2D] placeholder:text-[#8B9B8D] focus:outline-none focus:ring-2 focus:ring-[#6B8F71] focus:border-transparent transition resize-y"
            />
            <p className="text-xs text-[#8B9B8D] mt-1">
              {description.trim().length}/500 characters
            </p>
          </div>

          {/* Consent */}
          <div className="flex items-start gap-3 bg-blue-50 border border-blue-100 rounded-[12px] p-4">
            <ShieldCheck
              size={18}
              className="text-[#0077B6] mt-0.5 shrink-0"
              aria-hidden="true"
            />
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={consentChecked}
                onChange={(e) => setConsentChecked(e.target.checked)}
                className="mt-0.5 w-4 h-4 accent-[#0077B6]"
              />
              <span className="text-sm text-[#0077B6] leading-relaxed">
                I consent to receive Community Health Worker services. CHW
                services are provided to me at no cost by Medi-Cal. Sessions
                may be recorded for billing and quality purposes.
              </span>
            </label>
          </div>

          {/* Error */}
          {error && (
            <div
              role="alert"
              className="p-3 rounded-[12px] bg-red-50 border border-red-200 text-sm text-red-700"
            >
              {error}
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={!canSubmit}
            className="w-full bg-[#2C3E2D] hover:bg-[#3A5240] disabled:bg-[rgba(107,143,113,0.15)] disabled:text-[#8B9B8D] disabled:cursor-not-allowed text-white font-semibold py-3 rounded-[12px] text-sm transition-colors"
          >
            {isSubmitting ? 'Submitting…' : 'Submit Request'}
          </button>
        </form>
      </div>
    </div>
  );
}

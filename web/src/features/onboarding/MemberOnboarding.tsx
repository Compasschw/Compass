import { useState, useEffect, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Compass,
  Check,
  ArrowRight,
  ArrowLeft,
  ChevronDown,
  Sparkles,
  Star,
  Zap,
} from 'lucide-react';
import { useAuth } from '../auth/AuthContext';

// ─── Constants ────────────────────────────────────────────────────────────────

const TOTAL_STEPS = 4;

const STEP_LABELS = ['Basic Info', 'Health', 'Insurance', 'Welcome'];

const LANGUAGE_OPTIONS = [
  'English',
  'Spanish',
  'Vietnamese',
  'Arabic',
  'Mandarin',
  'Korean',
  'Tagalog',
  'Other',
];

const INSURANCE_PROVIDER_OPTIONS = [
  'Medi-Cal',
  'LA Care',
  'Molina Healthcare',
  'Health Net',
  'Blue Shield of CA',
  'Kaiser Permanente',
  'Other',
  'None / Uninsured',
];

interface SdohItem {
  key: string;
  label: string;
  sublabel: string;
}

const SDOH_ITEMS: SdohItem[] = [
  {
    key: 'housing',
    label: 'Housing stability',
    sublabel: 'Difficulty paying rent, eviction risk, or unsafe living conditions',
  },
  {
    key: 'food',
    label: 'Food access',
    sublabel: 'Trouble affording or obtaining enough food for your household',
  },
  {
    key: 'transportation',
    label: 'Transportation',
    sublabel: 'Difficulty getting to medical appointments or work',
  },
  {
    key: 'employment',
    label: 'Employment',
    sublabel: 'Unemployment, job instability, or income challenges',
  },
  {
    key: 'insurance',
    label: 'Health insurance',
    sublabel: 'Uninsured or trouble navigating your coverage',
  },
  {
    key: 'mental_health',
    label: 'Mental health support',
    sublabel: 'Access to counseling, therapy, or crisis resources',
  },
];

type UrgencyLevel = 'low' | 'medium' | 'high';

interface UrgencyOption {
  value: UrgencyLevel;
  label: string;
  description: string;
  color: string;
}

const URGENCY_OPTIONS: UrgencyOption[] = [
  {
    value: 'low',
    label: 'I can plan ahead',
    description: 'No immediate crisis — looking to improve my situation over time',
    color: 'text-[#555555]',
  },
  {
    value: 'medium',
    label: 'I need help soon',
    description: 'Challenging situation that needs attention in the next few weeks',
    color: 'text-[#F59E0B]',
  },
  {
    value: 'high',
    label: 'I need help urgently',
    description: 'In crisis or facing an immediate threat to housing, health, or safety',
    color: 'text-[#DC2626]',
  },
];

// ─── Step data types ──────────────────────────────────────────────────────────

interface Step1Data {
  firstName: string;
  zipCode: string;
  preferredLanguage: string;
}

interface Step2Data {
  sdohChallenges: string[];
  urgency: UrgencyLevel | '';
}

interface Step3Data {
  insuranceProvider: string;
}

// ─── Step 1: Basic Info ───────────────────────────────────────────────────────

interface StepBasicInfoProps {
  data: Step1Data;
  onChange: (data: Step1Data) => void;
}

function StepBasicInfo({ data, onChange }: StepBasicInfoProps) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold text-[#1A1A1A] mb-1">Welcome to CompassCHW</h2>
        <p className="text-sm text-[#555555]">
          Let's get you set up. A few quick questions to connect you with the right support.
        </p>
      </div>

      <div>
        <label htmlFor="member-first-name" className="block text-sm font-medium text-[#1A1A1A] mb-1.5">
          First name
        </label>
        <input
          id="member-first-name"
          type="text"
          autoComplete="given-name"
          value={data.firstName}
          onChange={(e: ChangeEvent<HTMLInputElement>) =>
            onChange({ ...data, firstName: e.target.value })
          }
          placeholder="Rosa"
          className="w-full rounded-[8px] border border-[#E5E7EB] px-3.5 py-2.5 text-sm text-[#1A1A1A] placeholder:text-[#AAAAAA] focus:outline-none focus:ring-2 focus:ring-[#00B050] focus:border-transparent transition"
        />
      </div>

      <div>
        <label htmlFor="member-zip" className="block text-sm font-medium text-[#1A1A1A] mb-1.5">
          ZIP code
        </label>
        <input
          id="member-zip"
          type="text"
          inputMode="numeric"
          maxLength={5}
          value={data.zipCode}
          onChange={(e: ChangeEvent<HTMLInputElement>) =>
            onChange({ ...data, zipCode: e.target.value })
          }
          placeholder="90031"
          className="w-full rounded-[8px] border border-[#E5E7EB] px-3.5 py-2.5 text-sm text-[#1A1A1A] placeholder:text-[#AAAAAA] focus:outline-none focus:ring-2 focus:ring-[#00B050] focus:border-transparent transition"
        />
        <p className="text-xs text-[#AAAAAA] mt-1">Used to find CHWs near you.</p>
      </div>

      <div>
        <label htmlFor="member-language" className="block text-sm font-medium text-[#1A1A1A] mb-1.5">
          Preferred language
        </label>
        <div className="relative">
          <select
            id="member-language"
            value={data.preferredLanguage}
            onChange={(e) => onChange({ ...data, preferredLanguage: e.target.value })}
            className="w-full rounded-[8px] border border-[#E5E7EB] px-3.5 py-2.5 pr-9 text-sm text-[#1A1A1A] bg-white appearance-none focus:outline-none focus:ring-2 focus:ring-[#00B050] focus:border-transparent transition cursor-pointer"
          >
            <option value="" disabled>
              Select a language
            </option>
            {LANGUAGE_OPTIONS.map((lang) => (
              <option key={lang} value={lang}>
                {lang}
              </option>
            ))}
          </select>
          <ChevronDown
            size={16}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-[#AAAAAA] pointer-events-none"
            aria-hidden="true"
          />
        </div>
      </div>
    </div>
  );
}

// ─── Step 2: Health Assessment (SDOH) ────────────────────────────────────────

interface StepHealthProps {
  data: Step2Data;
  onChange: (data: Step2Data) => void;
}

function StepHealthAssessment({ data, onChange }: StepHealthProps) {
  function toggleChallenge(key: string) {
    const next = data.sdohChallenges.includes(key)
      ? data.sdohChallenges.filter((k) => k !== key)
      : [...data.sdohChallenges, key];
    onChange({ ...data, sdohChallenges: next });
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-[#1A1A1A] mb-1">Health & needs assessment</h2>
        <p className="text-sm text-[#555555]">
          In the past 12 months, have you had difficulty with any of the following?{' '}
          <span className="text-[#AAAAAA]">(select all that apply)</span>
        </p>
      </div>

      {/* SDOH checkboxes */}
      <div className="space-y-2.5">
        {SDOH_ITEMS.map(({ key, label, sublabel }) => {
          const checked = data.sdohChallenges.includes(key);
          return (
            <label
              key={key}
              className={[
                'flex items-start gap-3.5 rounded-[12px] border px-4 py-3.5 cursor-pointer transition-all select-none',
                checked
                  ? 'border-[#00B050] bg-[#F0FBF4]'
                  : 'border-[#E5E7EB] bg-white hover:border-[#00B050]/40 hover:bg-[#F8FAFB]',
              ].join(' ')}
            >
              <input
                type="checkbox"
                className="sr-only"
                checked={checked}
                onChange={() => toggleChallenge(key)}
              />
              <span
                className={[
                  'mt-0.5 w-5 h-5 rounded-[4px] border-2 flex items-center justify-center flex-shrink-0 transition-colors',
                  checked ? 'border-[#00B050] bg-[#00B050]' : 'border-[#D1D5DB] bg-white',
                ].join(' ')}
                aria-hidden="true"
              >
                {checked && <Check size={11} className="text-white" strokeWidth={3} />}
              </span>
              <div className="flex-1 min-w-0">
                <span
                  className={`block text-sm font-semibold ${checked ? 'text-[#00B050]' : 'text-[#1A1A1A]'}`}
                >
                  {label}
                </span>
                <span className="block text-xs text-[#555555] mt-0.5 leading-relaxed">
                  {sublabel}
                </span>
              </div>
            </label>
          );
        })}
      </div>

      {/* Urgency radio */}
      <div>
        <p className="text-sm font-medium text-[#1A1A1A] mb-3">
          How urgent is your need for support?
        </p>
        <div className="space-y-2.5">
          {URGENCY_OPTIONS.map(({ value, label, description, color }) => {
            const selected = data.urgency === value;
            return (
              <label
                key={value}
                className={[
                  'flex items-start gap-3.5 rounded-[12px] border px-4 py-3.5 cursor-pointer transition-all select-none',
                  selected
                    ? 'border-[#0077B6] bg-[#F0F7FF]'
                    : 'border-[#E5E7EB] bg-white hover:border-[#0077B6]/40 hover:bg-[#F8FAFB]',
                ].join(' ')}
              >
                <input
                  type="radio"
                  name="urgency"
                  className="sr-only"
                  checked={selected}
                  onChange={() => onChange({ ...data, urgency: value })}
                />
                <span
                  className={[
                    'mt-0.5 w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-colors',
                    selected ? 'border-[#0077B6] bg-[#0077B6]' : 'border-[#D1D5DB] bg-white',
                  ].join(' ')}
                  aria-hidden="true"
                >
                  {selected && (
                    <span className="w-2 h-2 rounded-full bg-white block" />
                  )}
                </span>
                <div className="flex-1 min-w-0">
                  <span className={`block text-sm font-semibold ${selected ? 'text-[#0077B6]' : color}`}>
                    {label}
                  </span>
                  <span className="block text-xs text-[#555555] mt-0.5 leading-relaxed">
                    {description}
                  </span>
                </div>
              </label>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Step 3: Insurance ────────────────────────────────────────────────────────

interface StepInsuranceProps {
  data: Step3Data;
  onChange: (data: Step3Data) => void;
}

function StepInsurance({ data, onChange }: StepInsuranceProps) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-[#1A1A1A] mb-1">Insurance information</h2>
        <p className="text-sm text-[#555555]">
          Optional — sharing your insurance helps CHWs coordinate care that's covered for you.
        </p>
      </div>

      {/* Provider dropdown */}
      <div>
        <label
          htmlFor="member-insurance"
          className="block text-sm font-medium text-[#1A1A1A] mb-1.5"
        >
          Insurance provider{' '}
          <span className="text-[#AAAAAA] font-normal">(optional)</span>
        </label>
        <div className="relative">
          <select
            id="member-insurance"
            value={data.insuranceProvider}
            onChange={(e) => onChange({ ...data, insuranceProvider: e.target.value })}
            className="w-full rounded-[8px] border border-[#E5E7EB] px-3.5 py-2.5 pr-9 text-sm text-[#1A1A1A] bg-white appearance-none focus:outline-none focus:ring-2 focus:ring-[#00B050] focus:border-transparent transition cursor-pointer"
          >
            <option value="">Select your provider (or skip)</option>
            {INSURANCE_PROVIDER_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
          <ChevronDown
            size={16}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-[#AAAAAA] pointer-events-none"
            aria-hidden="true"
          />
        </div>
      </div>

      {/* Connect button — placeholder action */}
      <button
        type="button"
        aria-disabled="true"
        className="w-full border-2 border-[#00B050] text-[#00B050] hover:bg-[#F0FBF4] font-semibold py-2.5 rounded-[8px] text-sm transition-colors flex items-center justify-center gap-2"
        onClick={() => {/* placeholder: insurance OAuth/connection flow */}}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
        Connect Insurance Provider
      </button>
      <p className="text-xs text-[#AAAAAA] -mt-3 text-center">
        Securely link your plan to auto-verify eligibility (coming soon)
      </p>

      {/* Info callout */}
      <div className="rounded-[12px] border border-[#E5E7EB] bg-[#F8FAFB] px-4 py-4">
        <p className="text-xs font-semibold text-[#1A1A1A] mb-2">Why we ask</p>
        <p className="text-xs text-[#555555] leading-relaxed">
          CHWs can bill Medi-Cal for services on your behalf. Knowing your plan lets them
          check covered services before your session — at no cost to you.
        </p>
      </div>
    </div>
  );
}

// ─── Step 4: Welcome / Confetti ───────────────────────────────────────────────

interface StepWelcomeProps {
  firstName: string;
  onGetStarted: () => void;
}

function StepWelcome({ firstName, onGetStarted }: StepWelcomeProps) {
  const [pointsDisplayed, setPointsDisplayed] = useState(0);
  const TARGET_POINTS = 100;

  // Count-up animation for the points
  useEffect(() => {
    const duration = 1200;
    const stepCount = 40;
    const stepValue = TARGET_POINTS / stepCount;
    const stepTime = duration / stepCount;
    let current = 0;

    const timer = setInterval(() => {
      current += stepValue;
      if (current >= TARGET_POINTS) {
        setPointsDisplayed(TARGET_POINTS);
        clearInterval(timer);
      } else {
        setPointsDisplayed(Math.floor(current));
      }
    }, stepTime);

    return () => clearInterval(timer);
  }, []);

  return (
    <div className="flex flex-col items-center text-center">
      {/* Sparkle header */}
      <div className="relative mb-6">
        {/* Decorative confetti dots */}
        <div className="absolute -top-3 -left-6 flex gap-1" aria-hidden="true">
          {['#00B050', '#0077B6', '#F59E0B', '#DC2626'].map((color, i) => (
            <span
              key={i}
              className="w-2.5 h-2.5 rounded-sm rotate-12 opacity-80"
              style={{ backgroundColor: color, transform: `rotate(${i * 25}deg)` }}
            />
          ))}
        </div>
        <div className="absolute -top-3 -right-6 flex gap-1" aria-hidden="true">
          {['#F59E0B', '#00B050', '#0077B6', '#DC2626'].map((color, i) => (
            <span
              key={i}
              className="w-2.5 h-2.5 rounded-sm opacity-80"
              style={{ backgroundColor: color, transform: `rotate(${-i * 20}deg)` }}
            />
          ))}
        </div>

        <div className="w-20 h-20 rounded-full bg-gradient-to-br from-[#D0F0D0] to-[#B0E8C8] flex items-center justify-center">
          <Sparkles size={36} className="text-[#00B050]" />
        </div>
      </div>

      <h2 className="text-2xl font-bold text-[#1A1A1A] mb-1">
        Welcome to CompassCHW{firstName ? `, ${firstName}` : ''}!
      </h2>
      <p className="text-sm text-[#555555] max-w-xs leading-relaxed mb-8">
        Your profile is all set. We're matching you with Community Health Workers in
        your area who speak your language.
      </p>

      {/* Points award card */}
      <div className="w-full rounded-[12px] border-2 border-[#00B050] bg-gradient-to-br from-[#F0FBF4] to-[#E8F7EE] px-6 py-5 mb-6">
        <div className="flex items-center justify-center gap-2 mb-1">
          <Zap size={18} className="text-[#F59E0B]" />
          <p className="text-xs font-semibold text-[#555555] uppercase tracking-wide">
            Engagement Points Earned
          </p>
          <Zap size={18} className="text-[#F59E0B]" />
        </div>
        <div className="flex items-baseline justify-center gap-1.5 mb-2">
          <span
            className="text-5xl font-black text-[#00B050] tabular-nums"
            aria-live="polite"
            aria-label={`${pointsDisplayed} engagement points`}
          >
            {pointsDisplayed}
          </span>
          <span className="text-lg font-bold text-[#00B050]">pts</span>
        </div>
        <p className="text-xs text-[#555555]">for completing your profile</p>

        {/* Stars */}
        <div className="flex items-center justify-center gap-1 mt-3" aria-hidden="true">
          {Array.from({ length: 5 }).map((_, i) => (
            <Star
              key={i}
              size={14}
              className="text-[#F59E0B] fill-[#F59E0B]"
            />
          ))}
        </div>
      </div>

      {/* How it works */}
      <div className="w-full text-left mb-8">
        <p className="text-xs font-semibold text-[#AAAAAA] uppercase tracking-wide mb-3 text-center">
          What's next
        </p>
        <div className="space-y-2.5">
          {[
            { icon: '🔍', text: 'Browse CHWs matched to your needs and location' },
            { icon: '📅', text: 'Schedule a free intro session in person, virtual, or by phone' },
            { icon: '🎯', text: 'Set goals and track your progress over time' },
            { icon: '⭐', text: 'Earn more points for every session and milestone' },
          ].map(({ icon, text }, i) => (
            <div key={i} className="flex items-center gap-3 rounded-[8px] bg-[#F8FAFB] border border-[#E5E7EB] px-3.5 py-2.5">
              <span className="text-base" role="img" aria-hidden="true">{icon}</span>
              <span className="text-sm text-[#1A1A1A]">{text}</span>
            </div>
          ))}
        </div>
      </div>

      <button
        type="button"
        onClick={onGetStarted}
        className="w-full inline-flex items-center justify-center gap-2 bg-[#00B050] hover:bg-[#008F40] text-white font-semibold py-3 rounded-[8px] text-sm transition-colors"
      >
        Get Started
        <ArrowRight size={16} />
      </button>
    </div>
  );
}

// ─── Bottom stepper dots ──────────────────────────────────────────────────────

interface StepDotsProps {
  currentStep: number;
  totalSteps: number;
  labels: string[];
}

function StepDots({ currentStep, totalSteps, labels }: StepDotsProps) {
  return (
    <nav aria-label="Onboarding progress" className="w-full mb-8">
      <ol className="flex items-start justify-between">
        {Array.from({ length: totalSteps }, (_, i) => {
          const stepNumber = i + 1;
          const isCompleted = stepNumber < currentStep;
          const isCurrent = stepNumber === currentStep;

          return (
            <li key={stepNumber} className="flex flex-col items-center flex-1">
              {/* Connector + dot row */}
              <div className="flex items-center w-full">
                {/* Left connector */}
                <div
                  className={[
                    'flex-1 h-0.5 transition-colors',
                    stepNumber === 1 ? 'invisible' : isCompleted || isCurrent ? 'bg-[#00B050]' : 'bg-[#E5E7EB]',
                  ].join(' ')}
                  aria-hidden="true"
                />
                <div
                  aria-current={isCurrent ? 'step' : undefined}
                  className={[
                    'w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 transition-all',
                    isCompleted
                      ? 'bg-[#00B050] text-white'
                      : isCurrent
                      ? 'bg-[#0077B6] text-white ring-4 ring-[#0077B6]/20'
                      : 'bg-[#E5E7EB] text-[#AAAAAA]',
                  ].join(' ')}
                >
                  {isCompleted ? (
                    <Check size={14} strokeWidth={3} />
                  ) : (
                    stepNumber
                  )}
                </div>
                {/* Right connector */}
                <div
                  className={[
                    'flex-1 h-0.5 transition-colors',
                    stepNumber === totalSteps ? 'invisible' : isCompleted ? 'bg-[#00B050]' : 'bg-[#E5E7EB]',
                  ].join(' ')}
                  aria-hidden="true"
                />
              </div>
              {/* Label */}
              <span
                className={[
                  'text-[10px] font-medium mt-1.5 text-center leading-tight',
                  isCurrent ? 'text-[#0077B6]' : isCompleted ? 'text-[#00B050]' : 'text-[#AAAAAA]',
                ].join(' ')}
              >
                {labels[i]}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

/**
 * Member onboarding wizard — 4-step flow collecting basic info, SDOH health
 * assessment, insurance details, and ending with a welcome/points screen.
 * Calls login() before routing to the member home so auth state is populated.
 */
export function MemberOnboarding() {
  const navigate = useNavigate();
  const { login } = useAuth();

  const [step, setStep] = useState(1);

  const [basicInfo, setBasicInfo] = useState<Step1Data>({
    firstName: '',
    zipCode: '',
    preferredLanguage: '',
  });

  const [healthData, setHealthData] = useState<Step2Data>({
    sdohChallenges: [],
    urgency: '',
  });

  const [insuranceData, setInsuranceData] = useState<Step3Data>({
    insuranceProvider: '',
  });

  const fullName = basicInfo.firstName.trim() || 'Member';

  function canProceed(): boolean {
    switch (step) {
      case 1:
        return (
          basicInfo.firstName.trim().length > 0 &&
          basicInfo.zipCode.trim().length === 5 &&
          basicInfo.preferredLanguage.length > 0
        );
      case 2:
        // At least one SDOH item OR urgency selected — or allow skipping with both empty
        return healthData.sdohChallenges.length > 0 || healthData.urgency !== '';
      case 3:
        // Insurance is optional — always allow proceeding
        return true;
      default:
        return false;
    }
  }

  function handleNext() {
    if (step === 3) {
      // Transition to welcome step — log in here
      login('member', fullName);
    }
    if (step < TOTAL_STEPS) {
      setStep((s) => s + 1);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  function handleBack() {
    if (step > 1) {
      setStep((s) => s - 1);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  function handleGetStarted() {
    navigate('/member/home');
  }

  const isWelcomeStep = step === TOTAL_STEPS;

  return (
    <div className="min-h-screen bg-[#F8FAFB] flex flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-lg bg-white rounded-[12px] shadow-sm border border-[#E5E7EB] px-6 sm:px-10 py-10">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-[#00B050] flex items-center justify-center">
              <Compass size={20} className="text-white" aria-hidden="true" />
            </div>
            <span className="text-lg font-bold text-[#1A1A1A] tracking-tight">
              Compass<span className="text-[#00B050]">CHW</span>
            </span>
          </div>
          <p className="text-xs text-[#AAAAAA] mt-1">
            {isWelcomeStep ? 'You\'re all set!' : 'New member setup — takes about 2 minutes'}
          </p>
        </div>

        {/* Step dots */}
        <StepDots currentStep={step} totalSteps={TOTAL_STEPS} labels={STEP_LABELS} />

        {/* Step content */}
        {step === 1 && (
          <StepBasicInfo data={basicInfo} onChange={setBasicInfo} />
        )}
        {step === 2 && (
          <StepHealthAssessment data={healthData} onChange={setHealthData} />
        )}
        {step === 3 && (
          <StepInsurance data={insuranceData} onChange={setInsuranceData} />
        )}
        {step === 4 && (
          <StepWelcome firstName={basicInfo.firstName.trim()} onGetStarted={handleGetStarted} />
        )}

        {/* Navigation — hidden on welcome step (it has its own CTA) */}
        {!isWelcomeStep && (
          <div className="flex items-center justify-between mt-8 pt-6 border-t border-[#E5E7EB]">
            <button
              type="button"
              onClick={handleBack}
              disabled={step === 1}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-[#555555] hover:text-[#1A1A1A] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ArrowLeft size={15} />
              Back
            </button>

            <span className="text-xs text-[#AAAAAA]">
              Step {step} of {TOTAL_STEPS - 1}
            </span>

            <button
              type="button"
              onClick={handleNext}
              disabled={!canProceed()}
              className="inline-flex items-center gap-1.5 bg-[#00B050] hover:bg-[#008F40] disabled:bg-[#D0F0D0] disabled:cursor-not-allowed text-white font-semibold px-5 py-2.5 rounded-[8px] text-sm transition-colors"
            >
              {step === 3 ? 'Finish' : 'Continue'}
              <ArrowRight size={15} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

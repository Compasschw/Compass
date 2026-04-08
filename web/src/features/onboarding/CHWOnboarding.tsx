import { useState, useCallback, type DragEvent, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Compass,
  Check,
  Home,
  HeartPulse,
  Salad,
  Brain,
  Stethoscope,
  Upload,
  FileText,
  CheckCircle2,
  ArrowRight,
  ArrowLeft,
  ChevronDown,
  Shield,
  Lock,
  UserCheck,
  BookOpen,
} from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import type { Vertical } from '../../data/mock';

// ─── Constants ────────────────────────────────────────────────────────────────

const TOTAL_STEPS = 4;

const STEP_LABELS = ['Basic Info', 'Specializations', 'Languages & Availability', 'Credentials'];

interface SpecializationOption {
  key: Vertical;
  label: string;
  icon: React.FC<{ size?: number; className?: string }>;
  description: string;
}

const SPECIALIZATION_OPTIONS: SpecializationOption[] = [
  {
    key: 'housing',
    label: 'Housing',
    icon: Home,
    description: 'Rental assistance, eviction prevention, shelter navigation',
  },
  {
    key: 'rehab',
    label: 'Rehab & Recovery',
    icon: HeartPulse,
    description: 'Substance use treatment, peer support, recovery resources',
  },
  {
    key: 'food',
    label: 'Food Security',
    icon: Salad,
    description: 'CalFresh enrollment, food pantries, nutrition programs',
  },
  {
    key: 'mental_health',
    label: 'Mental Health',
    icon: Brain,
    description: 'Therapy referrals, crisis support, wellness resources',
  },
  {
    key: 'healthcare',
    label: 'Healthcare Access',
    icon: Stethoscope,
    description: 'Medi-Cal enrollment, preventive care, specialist referrals',
  },
];

const LANGUAGE_OPTIONS = [
  'English',
  'Spanish',
  'Vietnamese',
  'Arabic',
  'Mandarin',
  'Korean',
  'Other',
];

const CERTIFICATION_TYPE_OPTIONS = [
  'State CHW',
  'Promotora',
  'Peer Support Specialist',
  'Other',
];

// ─── Sub-types ────────────────────────────────────────────────────────────────

interface Step1Data {
  firstName: string;
  lastName: string;
  phone: string;
  zipCode: string;
}

interface Step3Data {
  languages: string[];
  serviceRadiusMiles: number;
  bio: string;
}

interface Step4Data {
  // Section 1: CHW Certification
  certificationFile: File | null;
  certificationFileName: string;
  certificationType: string;
  // Section 2: HIPAA Training
  hipaaFile: File | null;
  hipaaFileName: string;
  // Section 3: Background Check
  backgroundCheckConsent: boolean;
  backgroundCheckFile: File | null;
  backgroundCheckFileName: string;
  // Section 4: Continuing Education
  ceFile: File | null;
  ceFileName: string;
  ceCreditHours: number;
}

// ─── Shared FileUploadZone ─────────────────────────────────────────────────────

interface FileUploadZoneProps {
  id: string;
  fileName: string;
  onFile: (file: File) => void;
  label: string;
  subtext?: string;
}

function FileUploadZone({
  id,
  fileName,
  onFile,
  label,
  subtext,
}: FileUploadZoneProps) {
  const [isDragOver, setIsDragOver] = useState(false);

  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragOver(true);
  }

  function handleDragLeave() {
    setIsDragOver(false);
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) onFile(file);
  }

  function handleInputChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) onFile(file);
  }

  return (
    <div>
      {subtext && (
        <p className="text-xs text-[#555555] mb-2">{subtext}</p>
      )}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={[
          'relative rounded-[20px] border-2 border-dashed transition-all',
          isDragOver
            ? 'border-[#6B8F71] bg-[rgba(107,143,113,0.08)]'
            : fileName
            ? 'border-[#6B8F71] bg-[rgba(107,143,113,0.08)]'
            : 'border-[#D1D5DB] bg-[#FBF7F0] hover:border-[#6B8F71]/60 hover:bg-[#FAFCFA]',
        ].join(' ')}
      >
        <label
          htmlFor={id}
          className="flex flex-col items-center gap-2.5 py-6 px-4 cursor-pointer"
        >
          {fileName ? (
            <>
              <div className="w-10 h-10 rounded-full bg-[rgba(107,143,113,0.15)] flex items-center justify-center">
                <FileText size={20} className="text-[#6B8F71]" />
              </div>
              <div className="text-center">
                <p className="text-sm font-semibold text-[#6B8F71]">{fileName}</p>
                <p className="text-xs text-[#555555] mt-0.5">File selected — click to replace</p>
              </div>
            </>
          ) : (
            <>
              <div className="w-10 h-10 rounded-full bg-white border border-[rgba(44,62,45,0.1)] flex items-center justify-center">
                <Upload size={20} className="text-[#555555]" />
              </div>
              <div className="text-center">
                <p className="text-sm font-semibold text-[#2C3E2D]">{label}</p>
                <p className="text-xs text-[#555555] mt-0.5">Drag & drop or click to browse</p>
                <p className="text-xs text-[#8B9B8D] mt-0.5">PDF, JPG, PNG (max 10 MB)</p>
              </div>
            </>
          )}
        </label>
        <input
          id={id}
          type="file"
          accept=".pdf,.jpg,.jpeg,.png"
          className="sr-only"
          onChange={handleInputChange}
        />
      </div>
    </div>
  );
}

// ─── Step components ──────────────────────────────────────────────────────────

interface StepBasicInfoProps {
  data: Step1Data;
  onChange: (data: Step1Data) => void;
}

function StepBasicInfo({ data, onChange }: StepBasicInfoProps) {
  function handleField(field: keyof Step1Data) {
    return (e: ChangeEvent<HTMLInputElement>) =>
      onChange({ ...data, [field]: e.target.value });
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold text-[#2C3E2D] mb-1">Tell us about yourself</h2>
        <p className="text-sm text-[#555555]">
          This information helps members find and trust their CHW.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="chw-first-name" className="block text-sm font-medium text-[#2C3E2D] mb-1.5">
            First name
          </label>
          <input
            id="chw-first-name"
            type="text"
            autoComplete="given-name"
            value={data.firstName}
            onChange={handleField('firstName')}
            placeholder="Maria"
            className="w-full rounded-[12px] border border-[rgba(44,62,45,0.1)] px-3.5 py-2.5 text-sm text-[#2C3E2D] placeholder:text-[#8B9B8D] focus:outline-none focus:ring-2 focus:ring-[#6B8F71] focus:border-transparent transition"
          />
        </div>
        <div>
          <label htmlFor="chw-last-name" className="block text-sm font-medium text-[#2C3E2D] mb-1.5">
            Last name
          </label>
          <input
            id="chw-last-name"
            type="text"
            autoComplete="family-name"
            value={data.lastName}
            onChange={handleField('lastName')}
            placeholder="Reyes"
            className="w-full rounded-[12px] border border-[rgba(44,62,45,0.1)] px-3.5 py-2.5 text-sm text-[#2C3E2D] placeholder:text-[#8B9B8D] focus:outline-none focus:ring-2 focus:ring-[#6B8F71] focus:border-transparent transition"
          />
        </div>
      </div>

      <div>
        <label htmlFor="chw-phone" className="block text-sm font-medium text-[#2C3E2D] mb-1.5">
          Phone number
        </label>
        <input
          id="chw-phone"
          type="tel"
          autoComplete="tel"
          value={data.phone}
          onChange={handleField('phone')}
          placeholder="(323) 555-0100"
          className="w-full rounded-[12px] border border-[rgba(44,62,45,0.1)] px-3.5 py-2.5 text-sm text-[#2C3E2D] placeholder:text-[#8B9B8D] focus:outline-none focus:ring-2 focus:ring-[#6B8F71] focus:border-transparent transition"
        />
      </div>

      <div>
        <label htmlFor="chw-zip" className="block text-sm font-medium text-[#2C3E2D] mb-1.5">
          Service area ZIP code
        </label>
        <input
          id="chw-zip"
          type="text"
          inputMode="numeric"
          maxLength={5}
          value={data.zipCode}
          onChange={handleField('zipCode')}
          placeholder="90033"
          className="w-full rounded-[12px] border border-[rgba(44,62,45,0.1)] px-3.5 py-2.5 text-sm text-[#2C3E2D] placeholder:text-[#8B9B8D] focus:outline-none focus:ring-2 focus:ring-[#6B8F71] focus:border-transparent transition"
        />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

interface StepSpecializationsProps {
  selected: Vertical[];
  onToggle: (key: Vertical) => void;
}

function StepSpecializations({ selected, onToggle }: StepSpecializationsProps) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold text-[#2C3E2D] mb-1">Your specializations</h2>
        <p className="text-sm text-[#555555]">
          Select all areas where you have training or experience. You can add more later.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3">
        {SPECIALIZATION_OPTIONS.map(({ key, label, icon: Icon, description }) => {
          const isSelected = selected.includes(key);
          return (
            <button
              key={key}
              type="button"
              onClick={() => onToggle(key)}
              aria-pressed={isSelected}
              className={[
                'w-full flex items-start gap-4 rounded-[20px] border-2 px-4 py-3.5 text-left transition-all',
                isSelected
                  ? 'border-[#6B8F71] bg-[rgba(107,143,113,0.08)]'
                  : 'border-[rgba(44,62,45,0.1)] bg-white hover:border-[#6B8F71]/40 hover:bg-[#FBF7F0]',
              ].join(' ')}
            >
              <div
                className={[
                  'mt-0.5 w-9 h-9 rounded-[12px] flex items-center justify-center flex-shrink-0',
                  isSelected ? 'bg-[#2C3E2D]' : 'bg-[#F0F4F8]',
                ].join(' ')}
              >
                <Icon
                  size={18}
                  className={isSelected ? 'text-white' : 'text-[#555555]'}
                />
              </div>
              <div className="flex-1 min-w-0">
                <span
                  className={[
                    'block text-sm font-semibold',
                    isSelected ? 'text-[#6B8F71]' : 'text-[#2C3E2D]',
                  ].join(' ')}
                >
                  {label}
                </span>
                <span className="block text-xs text-[#555555] mt-0.5 leading-relaxed">
                  {description}
                </span>
              </div>
              <div
                className={[
                  'mt-0.5 w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-colors',
                  isSelected
                    ? 'border-[#6B8F71] bg-[#2C3E2D]'
                    : 'border-[#D1D5DB] bg-white',
                ].join(' ')}
                aria-hidden="true"
              >
                {isSelected && <Check size={11} className="text-white" strokeWidth={3} />}
              </div>
            </button>
          );
        })}
      </div>

      {selected.length === 0 && (
        <p className="text-xs text-[#8B9B8D] text-center">Select at least one specialization to continue.</p>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

interface StepLanguagesProps {
  data: Step3Data;
  onChange: (data: Step3Data) => void;
}

function StepLanguagesAvailability({ data, onChange }: StepLanguagesProps) {
  function toggleLanguage(lang: string) {
    const next = data.languages.includes(lang)
      ? data.languages.filter((l) => l !== lang)
      : [...data.languages, lang];
    onChange({ ...data, languages: next });
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-[#2C3E2D] mb-1">Languages & availability</h2>
        <p className="text-sm text-[#555555]">
          Help members find a CHW who speaks their language.
        </p>
      </div>

      {/* Languages */}
      <div>
        <p className="text-sm font-medium text-[#2C3E2D] mb-3">Languages spoken</p>
        <div className="grid grid-cols-2 gap-2">
          {LANGUAGE_OPTIONS.map((lang) => {
            const checked = data.languages.includes(lang);
            return (
              <label
                key={lang}
                className={[
                  'flex items-center gap-2.5 rounded-[12px] border px-3.5 py-2.5 cursor-pointer transition-all select-none',
                  checked
                    ? 'border-[#6B8F71] bg-[rgba(107,143,113,0.08)]'
                    : 'border-[rgba(44,62,45,0.1)] bg-white hover:border-[#6B8F71]/40',
                ].join(' ')}
              >
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={checked}
                  onChange={() => toggleLanguage(lang)}
                />
                <span
                  className={[
                    'w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0',
                    checked ? 'border-[#6B8F71] bg-[#2C3E2D]' : 'border-[#D1D5DB] bg-white',
                  ].join(' ')}
                  aria-hidden="true"
                >
                  {checked && <Check size={9} className="text-white" strokeWidth={3} />}
                </span>
                <span className={`text-sm ${checked ? 'text-[#6B8F71] font-medium' : 'text-[#2C3E2D]'}`}>
                  {lang}
                </span>
              </label>
            );
          })}
        </div>
      </div>

      {/* Service radius */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-medium text-[#2C3E2D]">Service radius</p>
          <span className="text-sm font-semibold text-[#6B8F71]">
            {data.serviceRadiusMiles} miles
          </span>
        </div>
        <input
          type="range"
          min={5}
          max={50}
          step={5}
          value={data.serviceRadiusMiles}
          onChange={(e) => onChange({ ...data, serviceRadiusMiles: Number(e.target.value) })}
          aria-label="Service radius in miles"
          className="w-full h-2 rounded-full appearance-none bg-[rgba(44,62,45,0.1)] cursor-pointer accent-[#6B8F71]"
        />
        <div className="flex justify-between mt-1">
          <span className="text-xs text-[#8B9B8D]">5 mi</span>
          <span className="text-xs text-[#8B9B8D]">50 mi</span>
        </div>
      </div>

      {/* Bio */}
      <div>
        <label htmlFor="chw-bio" className="block text-sm font-medium text-[#2C3E2D] mb-1.5">
          Short bio{' '}
          <span className="text-[#8B9B8D] font-normal">(optional)</span>
        </label>
        <textarea
          id="chw-bio"
          rows={4}
          value={data.bio}
          onChange={(e) => onChange({ ...data, bio: e.target.value })}
          maxLength={400}
          placeholder="Share your background and how you help community members..."
          className="w-full rounded-[12px] border border-[rgba(44,62,45,0.1)] px-3.5 py-2.5 text-sm text-[#2C3E2D] placeholder:text-[#8B9B8D] focus:outline-none focus:ring-2 focus:ring-[#6B8F71] focus:border-transparent transition resize-none"
        />
        <p className="text-xs text-[#8B9B8D] text-right mt-1">
          {data.bio.length}/400
        </p>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

interface StepCredentialsProps {
  data: Step4Data;
  onChange: (data: Step4Data) => void;
}

/**
 * Step 4: Expanded credentials section with four card sections:
 * CHW Certification, HIPAA Training, Background Check, Continuing Education.
 */
function StepCredentials({ data, onChange }: StepCredentialsProps) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold text-[#2C3E2D] mb-1">Credentials</h2>
        <p className="text-sm text-[#555555]">
          Upload your credentials for compliance review. All documents are reviewed within 48 hours.
        </p>
      </div>

      {/* Section 1: CHW Certification */}
      <div className="bg-white rounded-[20px] border border-[rgba(44,62,45,0.1)] p-4 space-y-4">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-[12px] bg-[rgba(107,143,113,0.15)] flex items-center justify-center shrink-0">
            <Shield size={16} className="text-[#6B8F71]" aria-hidden="true" />
          </div>
          <h3 className="text-sm font-bold text-[#2C3E2D]">CHW Certification</h3>
        </div>

        <FileUploadZone
          id="cert-file-upload"
          fileName={data.certificationFileName}
          onFile={(file) =>
            onChange({
              ...data,
              certificationFile: file,
              certificationFileName: file.name,
            })
          }
          label="Drag & drop your CHW certificate"
        />

        {/* Certification type */}
        <div>
          <label
            htmlFor="cert-type"
            className="block text-sm font-medium text-[#2C3E2D] mb-1.5"
          >
            Certification type
            <span className="ml-1 text-red-500" aria-hidden="true">*</span>
          </label>
          <div className="relative">
            <select
              id="cert-type"
              value={data.certificationType}
              onChange={(e) => onChange({ ...data, certificationType: e.target.value })}
              className="w-full rounded-[12px] border border-[rgba(44,62,45,0.1)] px-3.5 py-2.5 pr-9 text-sm text-[#2C3E2D] bg-white appearance-none focus:outline-none focus:ring-2 focus:ring-[#6B8F71] focus:border-transparent transition cursor-pointer"
            >
              <option value="" disabled>
                Select your certification type
              </option>
              {CERTIFICATION_TYPE_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
            <ChevronDown
              size={16}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[#8B9B8D] pointer-events-none"
            />
          </div>
        </div>
      </div>

      {/* Section 2: HIPAA Training */}
      <div className="bg-white rounded-[20px] border border-[rgba(44,62,45,0.1)] p-4 space-y-4">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-[12px] bg-blue-50 flex items-center justify-center shrink-0">
            <Lock size={16} className="text-[#0077B6]" aria-hidden="true" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-[#2C3E2D]">HIPAA Training</h3>
            <p className="text-xs text-[#555555]">Required for compliance</p>
          </div>
        </div>

        <FileUploadZone
          id="hipaa-file-upload"
          fileName={data.hipaaFileName}
          onFile={(file) =>
            onChange({
              ...data,
              hipaaFile: file,
              hipaaFileName: file.name,
            })
          }
          label="Upload HIPAA Training Certificate"
          subtext="Upload your most recent HIPAA training completion certificate."
        />
      </div>

      {/* Section 3: Background Check */}
      <div className="bg-white rounded-[20px] border border-[rgba(44,62,45,0.1)] p-4 space-y-4">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-[12px] bg-amber-50 flex items-center justify-center shrink-0">
            <UserCheck size={16} className="text-amber-600" aria-hidden="true" />
          </div>
          <h3 className="text-sm font-bold text-[#2C3E2D]">Background Check</h3>
        </div>

        {/* Consent checkbox */}
        <label
          className={[
            'flex items-start gap-3 p-3 rounded-[12px] border cursor-pointer transition-colors',
            data.backgroundCheckConsent
              ? 'border-[#6B8F71] bg-[rgba(107,143,113,0.08)]'
              : 'border-[rgba(44,62,45,0.1)] bg-[#FBF7F0] hover:border-[#6B8F71]/40',
          ].join(' ')}
        >
          <input
            type="checkbox"
            className="sr-only"
            checked={data.backgroundCheckConsent}
            onChange={(e) =>
              onChange({ ...data, backgroundCheckConsent: e.target.checked })
            }
          />
          <span
            className={[
              'w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 mt-0.5 transition-colors',
              data.backgroundCheckConsent
                ? 'border-[#6B8F71] bg-[#2C3E2D]'
                : 'border-[#D1D5DB] bg-white',
            ].join(' ')}
            aria-hidden="true"
          >
            {data.backgroundCheckConsent && (
              <Check size={9} className="text-white" strokeWidth={3} />
            )}
          </span>
          <span className="text-sm text-[#2C3E2D] leading-relaxed">
            I consent to a background check as required for CHW credentialing.
            <span className="ml-1 text-red-500" aria-hidden="true">*</span>
          </span>
        </label>

        {/* Optional background check upload */}
        <div>
          <p className="text-xs font-medium text-[#555555] mb-2">
            Upload background check results{' '}
            <span className="text-[#8B9B8D] font-normal">(optional)</span>
          </p>
          <FileUploadZone
            id="bg-check-file-upload"
            fileName={data.backgroundCheckFileName}
            onFile={(file) =>
              onChange({
                ...data,
                backgroundCheckFile: file,
                backgroundCheckFileName: file.name,
              })
            }
            label="Upload background check results"
          />
        </div>
      </div>

      {/* Section 4: Continuing Education */}
      <div className="bg-white rounded-[20px] border border-[rgba(44,62,45,0.1)] p-4 space-y-4">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-[12px] bg-purple-50 flex items-center justify-center shrink-0">
            <BookOpen size={16} className="text-purple-600" aria-hidden="true" />
          </div>
          <h3 className="text-sm font-bold text-[#2C3E2D]">Continuing Education</h3>
        </div>

        <FileUploadZone
          id="ce-file-upload"
          fileName={data.ceFileName}
          onFile={(file) =>
            onChange({
              ...data,
              ceFile: file,
              ceFileName: file.name,
            })
          }
          label="Upload CE Certificate"
          subtext="Upload your most recent continuing education certificate."
        />

        {/* Credit hours */}
        <div>
          <label
            htmlFor="ce-credit-hours"
            className="block text-sm font-medium text-[#2C3E2D] mb-1.5"
          >
            Credit hours completed
          </label>
          <input
            id="ce-credit-hours"
            type="number"
            min={0}
            max={100}
            value={data.ceCreditHours}
            onChange={(e) =>
              onChange({
                ...data,
                ceCreditHours: Math.min(100, Math.max(0, parseInt(e.target.value, 10) || 0)),
              })
            }
            className="w-full rounded-[12px] border border-[rgba(44,62,45,0.1)] px-3.5 py-2.5 text-sm text-[#2C3E2D] focus:outline-none focus:ring-2 focus:ring-[#6B8F71] focus:border-transparent transition"
          />
          <p className="text-xs text-[#8B9B8D] mt-1">
            20 hours per year required
          </p>
        </div>
      </div>

      <p className="text-xs text-[#8B9B8D] leading-relaxed">
        Your credentials are reviewed by the CompassCHW compliance team within 48 hours.
        You will receive an email notification once approved.
      </p>
    </div>
  );
}

// ─── Stepper ──────────────────────────────────────────────────────────────────

interface StepperProps {
  currentStep: number;
  totalSteps: number;
  labels: string[];
}

function Stepper({ currentStep, totalSteps, labels }: StepperProps) {
  return (
    <nav aria-label="Onboarding progress" className="w-full mb-8">
      <ol className="flex items-center gap-0">
        {Array.from({ length: totalSteps }, (_, i) => {
          const stepNumber = i + 1;
          const isCompleted = stepNumber < currentStep;
          const isCurrent = stepNumber === currentStep;

          return (
            <li key={stepNumber} className="flex items-center flex-1">
              {/* Step dot */}
              <div className="flex flex-col items-center flex-shrink-0">
                <div
                  aria-current={isCurrent ? 'step' : undefined}
                  className={[
                    'w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-all',
                    isCompleted
                      ? 'bg-[#2C3E2D] text-white'
                      : isCurrent
                      ? 'bg-[#0077B6] text-white ring-4 ring-[#0077B6]/20'
                      : 'bg-[rgba(44,62,45,0.1)] text-[#8B9B8D]',
                  ].join(' ')}
                >
                  {isCompleted ? (
                    <Check size={14} strokeWidth={3} />
                  ) : (
                    stepNumber
                  )}
                </div>
                <span
                  className={[
                    'text-[10px] font-medium mt-1 text-center leading-tight max-w-[56px] hidden sm:block',
                    isCompleted || isCurrent ? 'text-[#2C3E2D]' : 'text-[#8B9B8D]',
                  ].join(' ')}
                >
                  {labels[i]}
                </span>
              </div>

              {/* Connector line (not after last step) */}
              {stepNumber < totalSteps && (
                <div
                  className={[
                    'flex-1 h-0.5 mx-1 transition-colors',
                    isCompleted ? 'bg-[#2C3E2D]' : 'bg-[rgba(44,62,45,0.1)]',
                  ].join(' ')}
                  aria-hidden="true"
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// ─── Success screen ───────────────────────────────────────────────────────────

interface SuccessScreenProps {
  name: string;
  onGoToDashboard: () => void;
}

function SuccessScreen({ name, onGoToDashboard }: SuccessScreenProps) {
  return (
    <div className="flex flex-col items-center text-center py-4">
      <div className="relative mb-6">
        <div className="w-20 h-20 rounded-full bg-[rgba(107,143,113,0.15)] flex items-center justify-center">
          <CheckCircle2 size={40} className="text-[#6B8F71]" />
        </div>
        {/* Decorative sparkle rings */}
        <div className="absolute inset-0 rounded-full border-4 border-[#6B8F71]/20 animate-ping" aria-hidden="true" />
      </div>

      <h2 className="text-2xl font-bold text-[#2C3E2D] mb-2">Application Submitted!</h2>
      <p className="text-sm text-[#555555] max-w-xs leading-relaxed mb-1">
        Thanks, <span className="font-semibold text-[#2C3E2D]">{name}</span>. Your application is under review.
      </p>
      <p className="text-sm text-[#555555] max-w-xs leading-relaxed mb-8">
        We'll review your credentials within{' '}
        <span className="font-semibold text-[#6B8F71]">48 hours</span> and notify
        you by email once approved.
      </p>

      <div className="w-full bg-[#FBF7F0] rounded-[20px] border border-[rgba(44,62,45,0.1)] px-5 py-4 mb-8 text-left">
        <p className="text-xs font-semibold text-[#8B9B8D] uppercase tracking-wide mb-3">What happens next</p>
        {[
          'Compliance team reviews your credentials',
          'Background check initiated (1–3 business days)',
          'You receive an approval email with onboarding next steps',
          'Your profile goes live and members can find you',
        ].map((step, i) => (
          <div key={i} className="flex items-start gap-3 mb-2 last:mb-0">
            <div className="w-5 h-5 rounded-full bg-[rgba(107,143,113,0.15)] flex items-center justify-center flex-shrink-0 mt-0.5">
              <span className="text-[10px] font-bold text-[#6B8F71]">{i + 1}</span>
            </div>
            <p className="text-sm text-[#555555]">{step}</p>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={onGoToDashboard}
        className="w-full inline-flex items-center justify-center gap-2 bg-[#2C3E2D] hover:bg-[#3A5240] text-white font-semibold py-2.5 rounded-[12px] text-sm transition-colors"
      >
        Go to Dashboard
        <ArrowRight size={16} />
      </button>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

/**
 * CHW onboarding wizard — 4-step flow collecting basic info, specializations,
 * languages & availability, and expanded credentials (CHW cert, HIPAA training,
 * background check consent, continuing education) before routing to the
 * CHW dashboard. Calls login() on completion so auth state is populated.
 */
export function CHWOnboarding() {
  const navigate = useNavigate();
  const { login } = useAuth();

  const [step, setStep] = useState(1);
  const [submitted, setSubmitted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Step 1 state
  const [basicInfo, setBasicInfo] = useState<Step1Data>({
    firstName: '',
    lastName: '',
    phone: '',
    zipCode: '',
  });

  // Step 2 state
  const [specializations, setSpecializations] = useState<Vertical[]>([]);

  // Step 3 state
  const [langAvail, setLangAvail] = useState<Step3Data>({
    languages: ['English'],
    serviceRadiusMiles: 15,
    bio: '',
  });

  // Step 4 state — expanded credentials
  const [credData, setCredData] = useState<Step4Data>({
    certificationFile: null,
    certificationFileName: '',
    certificationType: '',
    hipaaFile: null,
    hipaaFileName: '',
    backgroundCheckConsent: false,
    backgroundCheckFile: null,
    backgroundCheckFileName: '',
    ceFile: null,
    ceFileName: '',
    ceCreditHours: 0,
  });

  const fullName = [basicInfo.firstName, basicInfo.lastName].filter(Boolean).join(' ') || 'CHW';

  function canProceed(): boolean {
    switch (step) {
      case 1:
        return (
          basicInfo.firstName.trim().length > 0 &&
          basicInfo.lastName.trim().length > 0 &&
          basicInfo.phone.trim().length > 0 &&
          basicInfo.zipCode.trim().length === 5
        );
      case 2:
        return specializations.length > 0;
      case 3:
        return langAvail.languages.length > 0;
      case 4:
        return (
          credData.certificationType.length > 0 &&
          credData.backgroundCheckConsent
        );
      default:
        return false;
    }
  }

  function handleNext() {
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

  const toggleSpecialization = useCallback((key: Vertical) => {
    setSpecializations((prev) =>
      prev.includes(key) ? prev.filter((s) => s !== key) : [...prev, key],
    );
  }, []);

  function handleSubmit() {
    if (!canProceed() || isSubmitting) return;
    setIsSubmitting(true);
    // Simulate a brief async submission delay
    setTimeout(() => {
      login('chw', fullName);
      setSubmitted(true);
      setIsSubmitting(false);
    }, 800);
  }

  function handleGoToDashboard() {
    navigate('/chw/dashboard');
  }

  return (
    <div className="min-h-screen bg-[#FBF7F0] flex flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-lg bg-white rounded-[20px] shadow-sm border border-[rgba(44,62,45,0.1)] px-6 sm:px-10 py-10">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-[#2C3E2D] flex items-center justify-center">
              <Compass size={20} className="text-white" aria-hidden="true" />
            </div>
            <span className="text-lg font-bold text-[#2C3E2D] tracking-tight">
              Compass<span className="text-[#6B8F71]">CHW</span>
            </span>
          </div>
          <p className="text-xs text-[#8B9B8D] mt-1">Community Health Worker Application</p>
        </div>

        {/* Stepper (hidden on success) */}
        {!submitted && (
          <Stepper currentStep={step} totalSteps={TOTAL_STEPS} labels={STEP_LABELS} />
        )}

        {/* Step content */}
        {submitted ? (
          <SuccessScreen name={fullName} onGoToDashboard={handleGoToDashboard} />
        ) : (
          <>
            {step === 1 && <StepBasicInfo data={basicInfo} onChange={setBasicInfo} />}
            {step === 2 && (
              <StepSpecializations
                selected={specializations}
                onToggle={toggleSpecialization}
              />
            )}
            {step === 3 && (
              <StepLanguagesAvailability data={langAvail} onChange={setLangAvail} />
            )}
            {step === 4 && <StepCredentials data={credData} onChange={setCredData} />}

            {/* Navigation */}
            <div className="flex items-center justify-between mt-8 pt-6 border-t border-[rgba(44,62,45,0.1)]">
              <button
                type="button"
                onClick={handleBack}
                disabled={step === 1}
                className="inline-flex items-center gap-1.5 text-sm font-medium text-[#555555] hover:text-[#2C3E2D] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <ArrowLeft size={15} />
                Back
              </button>

              <span className="text-xs text-[#8B9B8D]">
                Step {step} of {TOTAL_STEPS}
              </span>

              {step < TOTAL_STEPS ? (
                <button
                  type="button"
                  onClick={handleNext}
                  disabled={!canProceed()}
                  className="inline-flex items-center gap-1.5 bg-[#2C3E2D] hover:bg-[#3A5240] disabled:bg-[rgba(107,143,113,0.15)] disabled:cursor-not-allowed text-white font-semibold px-5 py-2.5 rounded-[12px] text-sm transition-colors"
                >
                  Continue
                  <ArrowRight size={15} />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={!canProceed() || isSubmitting}
                  className="inline-flex items-center gap-1.5 bg-[#2C3E2D] hover:bg-[#3A5240] disabled:bg-[rgba(107,143,113,0.15)] disabled:cursor-not-allowed text-white font-semibold px-5 py-2.5 rounded-[12px] text-sm transition-colors"
                >
                  {isSubmitting ? (
                    <>
                      <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" aria-hidden="true" />
                      Submitting...
                    </>
                  ) : (
                    <>
                      Submit for Review
                      <ArrowRight size={15} />
                    </>
                  )}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

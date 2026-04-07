import { useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Star,
  CheckCircle,
  Edit2,
  Shield,
  MapPin,
  Clock,
  Mail,
  Phone,
  Hash,
  LogOut,
  Check,
  Lock,
  UserCheck,
  BookOpen,
  Upload,
  AlertTriangle,
  Camera,
  Pencil,
  X,
  Save,
  User,
} from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import {
  chwProfiles,
  mockCredentials,
  type Vertical,
  type CHWProfile as CHWProfileData,
  type Credential,
  type CredentialStatus,
} from '../../data/mock';

// ─── Constants ────────────────────────────────────────────────────────────────

const ALL_VERTICALS: { key: Vertical; label: string }[] = [
  { key: 'housing', label: 'Housing' },
  { key: 'food', label: 'Food Security' },
  { key: 'mental_health', label: 'Mental Health' },
  { key: 'rehab', label: 'Rehab & Recovery' },
  { key: 'healthcare', label: 'Healthcare Access' },
];

const ALL_LANGUAGES = [
  'English',
  'Spanish',
  'Vietnamese',
  'Arabic',
  'Mandarin',
  'Tagalog',
  'Korean',
  'Armenian',
];

const BIO_MAX_LENGTH = 400;

// ─── Draft state shape ────────────────────────────────────────────────────────

interface ProfileDraft {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  zipCode: string;
  bio: string;
  specializations: Vertical[];
  languages: string[];
  isAvailable: boolean;
}

// ─── Credential helpers ───────────────────────────────────────────────────────

const credentialStatusStyles: Record<CredentialStatus, string> = {
  verified: 'bg-green-100 text-green-700',
  pending: 'bg-yellow-100 text-yellow-800',
  expired: 'bg-red-100 text-red-700',
};

const credentialStatusLabels: Record<CredentialStatus, string> = {
  verified: 'Verified',
  pending: 'Pending Review',
  expired: 'Expired',
};

function CredentialIcon({ type }: { type: Credential['type'] }) {
  switch (type) {
    case 'chw_certification':
      return (
        <div className="w-9 h-9 rounded-[8px] bg-[#D0F0D0] flex items-center justify-center shrink-0">
          <Shield size={16} className="text-[#00B050]" aria-hidden="true" />
        </div>
      );
    case 'hipaa_training':
      return (
        <div className="w-9 h-9 rounded-[8px] bg-blue-50 flex items-center justify-center shrink-0">
          <Lock size={16} className="text-[#0077B6]" aria-hidden="true" />
        </div>
      );
    case 'background_check':
      return (
        <div className="w-9 h-9 rounded-[8px] bg-amber-50 flex items-center justify-center shrink-0">
          <UserCheck size={16} className="text-amber-600" aria-hidden="true" />
        </div>
      );
    case 'continuing_education':
      return (
        <div className="w-9 h-9 rounded-[8px] bg-purple-50 flex items-center justify-center shrink-0">
          <BookOpen size={16} className="text-purple-600" aria-hidden="true" />
        </div>
      );
  }
}

function formatCredentialDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// ─── Profile Picture ──────────────────────────────────────────────────────────

interface ProfilePictureProps {
  imageUrl: string | null;
  initials: string;
  onImageChange: (url: string) => void;
  onImageRemove: () => void;
}

function ProfilePicture({
  imageUrl,
  initials,
  onImageChange,
  onImageRemove,
}: ProfilePictureProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const objectUrl = URL.createObjectURL(file);
      onImageChange(objectUrl);
      // Reset so the same file can be selected again after removal
      e.target.value = '';
    },
    [onImageChange],
  );

  const handleClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  return (
    <div className="relative shrink-0">
      {/* Avatar container — 80px mobile, 96px desktop */}
      <div className="relative w-20 h-20 md:w-24 md:h-24">
        {imageUrl ? (
          <img
            src={imageUrl}
            alt="Profile picture"
            className="w-full h-full rounded-full object-cover border-4 border-white shadow-md"
          />
        ) : (
          <div
            className="w-full h-full rounded-full bg-[#D0F0D0] border-4 border-white shadow-md flex items-center justify-center font-bold text-[#00B050] text-2xl"
            aria-hidden="true"
          >
            {initials}
          </div>
        )}

        {/* Camera overlay on hover */}
        <button
          type="button"
          onClick={handleClick}
          className="absolute inset-0 bg-black/40 rounded-full flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity cursor-pointer focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00B050]"
          aria-label="Change profile picture"
        >
          <Camera size={20} className="text-white" aria-hidden="true" />
        </button>

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="sr-only"
          aria-label="Upload profile picture"
          onChange={handleFileChange}
        />
      </div>

      {/* Remove button — only visible when an image is set */}
      {imageUrl && (
        <button
          type="button"
          onClick={onImageRemove}
          className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-[#1A1A1A] border-2 border-white flex items-center justify-center hover:bg-red-600 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500"
          aria-label="Remove profile picture"
        >
          <X size={10} className="text-white" strokeWidth={3} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

// ─── StarRating ───────────────────────────────────────────────────────────────

function StarRating({ rating }: { rating: number }) {
  const full = Math.floor(rating);
  const hasHalf = rating - full >= 0.5;

  return (
    <div className="flex items-center gap-0.5" aria-label={`Rating: ${rating} out of 5`}>
      {Array.from({ length: 5 }, (_, i) => {
        const filled = i < full || (i === full && hasHalf);
        return (
          <Star
            key={i}
            size={14}
            className={
              filled ? 'text-yellow-400 fill-yellow-400' : 'text-[#E5E7EB] fill-[#E5E7EB]'
            }
            aria-hidden="true"
          />
        );
      })}
      <span className="ml-1 text-xs font-semibold text-[#555555]">{rating.toFixed(1)}</span>
    </div>
  );
}

// ─── AvailabilityToggle ───────────────────────────────────────────────────────

interface AvailabilityToggleProps {
  isAvailable: boolean;
  onChange: (value: boolean) => void;
}

function AvailabilityToggle({ isAvailable, onChange }: AvailabilityToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={isAvailable}
      aria-label={isAvailable ? 'Set offline' : 'Set available'}
      onClick={() => onChange(!isAvailable)}
      className={[
        'relative inline-flex h-8 w-14 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00B050]',
        isAvailable ? 'bg-[#00B050]' : 'bg-[#E5E7EB]',
      ].join(' ')}
    >
      <span
        className={[
          'pointer-events-none inline-block h-7 w-7 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out',
          isAvailable ? 'translate-x-6' : 'translate-x-0',
        ].join(' ')}
        aria-hidden="true"
      />
    </button>
  );
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function Toast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2.5 bg-[#1A1A1A] text-white text-sm font-medium px-5 py-3 rounded-[12px] shadow-lg cursor-pointer max-w-[calc(100vw-2rem)]"
      onClick={onDismiss}
    >
      <span className="w-5 h-5 rounded-full bg-[#00B050] flex items-center justify-center shrink-0">
        <Check size={11} className="text-white" strokeWidth={3} aria-hidden="true" />
      </span>
      {message}
    </div>
  );
}

// ─── CredentialRow ────────────────────────────────────────────────────────────

interface CredentialRowProps {
  credential: Credential;
  onAction: (credentialId: string) => void;
}

function CredentialRow({ credential, onAction }: CredentialRowProps) {
  const isCE = credential.type === 'continuing_education';
  const hasExpiry = credential.expirationDate != null;

  return (
    <div className="flex items-start gap-3 py-3 border-b border-[#F3F4F6] last:border-b-0">
      <CredentialIcon type={credential.type} />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap mb-0.5">
          <span className="text-sm font-semibold text-[#1A1A1A]">{credential.label}</span>
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${credentialStatusStyles[credential.status]}`}
            aria-label={`Status: ${credentialStatusLabels[credential.status]}`}
          >
            {credential.status === 'verified' && (
              <Check size={10} strokeWidth={3} className="mr-1" aria-hidden="true" />
            )}
            {credential.status === 'expired' && (
              <AlertTriangle size={10} className="mr-1" aria-hidden="true" />
            )}
            {credentialStatusLabels[credential.status]}
          </span>
        </div>

        <p className="text-xs text-[#AAAAAA]">
          {credential.uploadDate && (
            <span>Uploaded {formatCredentialDate(credential.uploadDate)}</span>
          )}
          {hasExpiry && credential.expirationDate && (
            <span className="ml-1">
              &middot; Expires {formatCredentialDate(credential.expirationDate)}
            </span>
          )}
          {credential.fileName && (
            <span className="ml-1 text-[#0077B6]">&middot; {credential.fileName}</span>
          )}
        </p>

        {isCE && credential.creditHours != null && credential.requiredHours != null && (
          <div className="mt-2">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-[#555555]">
                {credential.creditHours}/{credential.requiredHours} credit hours
              </span>
              <span className="text-xs font-semibold text-[#00B050]">
                {Math.round((credential.creditHours / credential.requiredHours) * 100)}%
              </span>
            </div>
            <div
              className="w-full h-1.5 bg-[#E5E7EB] rounded-full overflow-hidden"
              role="progressbar"
              aria-valuenow={credential.creditHours}
              aria-valuemin={0}
              aria-valuemax={credential.requiredHours}
              aria-label={`${credential.creditHours} of ${credential.requiredHours} CE credit hours completed`}
            >
              <div
                className="h-full bg-[#00B050] rounded-full transition-all"
                style={{
                  width: `${Math.min(100, (credential.creditHours / credential.requiredHours) * 100)}%`,
                }}
              />
            </div>
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={() => onAction(credential.id)}
        className="flex items-center gap-1.5 text-xs font-medium text-[#0077B6] hover:text-[#005A8C] border border-[#E5E7EB] hover:border-[#0077B6]/40 bg-white hover:bg-blue-50 px-3 py-1.5 rounded-[6px] transition-all shrink-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0077B6]"
        aria-label={
          credential.type === 'background_check'
            ? 'Request new background check'
            : `Upload new ${credential.label}`
        }
      >
        <Upload size={11} aria-hidden="true" />
        {credential.type === 'background_check' ? 'Request New' : 'Upload New'}
      </button>
    </div>
  );
}

// ─── Input helpers ────────────────────────────────────────────────────────────

const inputClass =
  'w-full rounded-[8px] border border-[#E5E7EB] px-3 py-2.5 text-sm text-[#1A1A1A] bg-white focus:outline-none focus:ring-2 focus:ring-[#00B050] focus:border-[#00B050] transition-colors placeholder:text-[#AAAAAA]';

interface FieldLabelProps {
  htmlFor: string;
  children: React.ReactNode;
}

function FieldLabel({ htmlFor, children }: FieldLabelProps) {
  return (
    <label
      htmlFor={htmlFor}
      className="block text-xs text-[#AAAAAA] uppercase tracking-wide font-medium mb-1"
    >
      {children}
    </label>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * CHW Profile page — view and edit profile details, availability, and settings.
 *
 * Sections:
 * 1. Profile header: avatar (with image upload), name, bio, rating
 * 2. Personal Info: name, phone, email, zip, bio — all editable in global edit mode
 * 3. Specializations: editable multi-select
 * 4. Languages: editable multi-select
 * 5. Availability: toggle + service radius
 * 6. Credentials & Compliance
 * 7. Danger zone: log out
 */
export function CHWProfile() {
  const { logout } = useAuth();
  const navigate = useNavigate();

  const profile: CHWProfileData = chwProfiles[0];

  // ── Profile picture ──
  const [profileImage, setProfileImage] = useState<string | null>(null);

  // ── Global edit mode ──
  const [isEditing, setIsEditing] = useState(false);

  // ── Draft + saved snapshot for discard ──
  const initialDraft: ProfileDraft = {
    firstName: 'Maria Guadalupe',
    lastName: 'Reyes',
    phone: '(323) 555-0192',
    email: 'maria.reyes@compasschw.org',
    zipCode: profile.zipCode,
    bio: profile.bio,
    specializations: profile.specializations,
    languages: profile.languages,
    isAvailable: profile.isAvailable,
  };

  const [draft, setDraft] = useState<ProfileDraft>(initialDraft);
  const [saved, setSaved] = useState<ProfileDraft>(initialDraft);

  // ── Availability toggle also lives in draft when editing ──
  const [isAvailable, setIsAvailable] = useState(profile.isAvailable);

  // ── Section-level edit flags (specializations + languages still have own toggle) ──
  const [editingSpecializations, setEditingSpecializations] = useState(false);
  const [editingLanguages, setEditingLanguages] = useState(false);

  // ── Toast ──
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // ── Credentials ──
  const [credentials] = useState<Credential[]>(mockCredentials);

  const verifiedCount = credentials.filter((c) => c.status === 'verified').length;
  const totalCount = credentials.length;
  const compliancePercent = Math.round((verifiedCount / totalCount) * 100);

  const overallComplianceStatus: 'good' | 'warning' | 'critical' =
    verifiedCount === totalCount
      ? 'good'
      : verifiedCount >= totalCount - 1
      ? 'warning'
      : 'critical';

  const complianceStatusConfig = {
    good: {
      bg: 'bg-green-50',
      border: 'border-green-200',
      textColor: 'text-green-700',
      barColor: 'bg-[#00B050]',
      label: 'Fully Compliant',
    },
    warning: {
      bg: 'bg-yellow-50',
      border: 'border-yellow-200',
      textColor: 'text-yellow-700',
      barColor: 'bg-yellow-500',
      label: 'Action Required',
    },
    critical: {
      bg: 'bg-red-50',
      border: 'border-red-200',
      textColor: 'text-red-700',
      barColor: 'bg-red-500',
      label: 'Non-Compliant',
    },
  }[overallComplianceStatus];

  // ── Handlers ──

  const handleStartEdit = useCallback(() => {
    setSaved({ ...draft });
    setIsEditing(true);
  }, [draft]);

  const handleSave = useCallback(() => {
    setSaved({ ...draft });
    setIsAvailable(draft.isAvailable);
    setIsEditing(false);
    setEditingSpecializations(false);
    setEditingLanguages(false);
    setToastMessage('Profile updated!');
    setTimeout(() => setToastMessage(null), 3500);
  }, [draft]);

  const handleDiscard = useCallback(() => {
    setDraft({ ...saved });
    setIsEditing(false);
    setEditingSpecializations(false);
    setEditingLanguages(false);
  }, [saved]);

  const handleDraftChange = useCallback(
    <K extends keyof ProfileDraft>(key: K, value: ProfileDraft[K]) => {
      setDraft((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const handleToggleSpecialization = useCallback((vertical: Vertical) => {
    setDraft((prev) => ({
      ...prev,
      specializations: prev.specializations.includes(vertical)
        ? prev.specializations.filter((v) => v !== vertical)
        : [...prev.specializations, vertical],
    }));
  }, []);

  const handleToggleLanguage = useCallback((lang: string) => {
    setDraft((prev) => ({
      ...prev,
      languages: prev.languages.includes(lang)
        ? prev.languages.filter((l) => l !== lang)
        : [...prev.languages, lang],
    }));
  }, []);

  // Non-edit-mode availability toggle (immediate)
  const handleAvailabilityChange = useCallback((value: boolean) => {
    setIsAvailable(value);
    setDraft((prev) => ({ ...prev, isAvailable: value }));
  }, []);

  const handleLogout = useCallback(() => {
    logout();
    navigate('/login');
  }, [logout, navigate]);

  const handleCredentialAction = useCallback(
    (credentialId: string) => {
      const cred = credentials.find((c) => c.id === credentialId);
      if (!cred) return;
      const action =
        cred.type === 'background_check' ? 'Request submitted' : 'Upload request sent';
      setToastMessage(
        `${action} for ${cred.label}. Our team will follow up within 24 hours.`,
      );
      setTimeout(() => setToastMessage(null), 4000);
    },
    [credentials],
  );

  // Derived display values (use saved when not editing, draft when editing)
  const display = isEditing ? draft : saved;
  const displayName = `${display.firstName} ${display.lastName}`;
  const initials = `${display.firstName[0] ?? ''}${display.lastName[0] ?? ''}`.toUpperCase();

  return (
    <div className="max-w-3xl mx-auto space-y-6 pb-28">
      {/* ── Profile header card ── */}
      <section
        aria-labelledby="profile-header-heading"
        className="bg-white rounded-[12px] border border-[#E5E7EB] p-5"
      >
        <div className="flex items-start gap-4">
          <ProfilePicture
            imageUrl={profileImage}
            initials={initials}
            onImageChange={setProfileImage}
            onImageRemove={() => setProfileImage(null)}
          />

          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2
                  id="profile-header-heading"
                  className="text-xl font-bold text-[#1A1A1A] leading-tight"
                >
                  {displayName}
                </h2>
                <StarRating rating={profile.rating} />
                <p className="text-xs text-[#AAAAAA] mt-1">
                  {profile.totalSessions} sessions &middot; {profile.yearsExperience} yrs
                  experience
                </p>
              </div>

              {/* Edit Profile button */}
              {!isEditing && (
                <button
                  type="button"
                  onClick={handleStartEdit}
                  className="flex items-center gap-1.5 text-sm font-semibold text-[#00B050] border border-[#00B050] hover:bg-[#00B050]/10 px-3 py-2 rounded-[8px] transition-colors shrink-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00B050]"
                  aria-label="Edit profile"
                >
                  <Pencil size={14} aria-hidden="true" />
                  Edit Profile
                </button>
              )}
            </div>

            {!isEditing && (
              <p className="text-sm text-[#555555] mt-2 leading-relaxed">{display.bio}</p>
            )}
          </div>
        </div>
      </section>

      {/* ── Personal Info ── */}
      <section
        aria-labelledby="personal-info-heading"
        className="bg-white rounded-[12px] border border-[#E5E7EB] p-4"
      >
        <div className="flex items-center justify-between mb-4">
          <h3
            id="personal-info-heading"
            className="text-sm font-semibold text-[#1A1A1A] uppercase tracking-wide"
          >
            Personal Info
          </h3>
          {isEditing && (
            <span className="text-xs text-[#00B050] font-medium">Editing</span>
          )}
        </div>

        {isEditing ? (
          <div className="space-y-4">
            {/* First + Last name side by side */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <FieldLabel htmlFor="chw-first-name">First Name</FieldLabel>
                <input
                  id="chw-first-name"
                  type="text"
                  value={draft.firstName}
                  onChange={(e) => handleDraftChange('firstName', e.target.value)}
                  className={inputClass}
                  placeholder="First name"
                />
              </div>
              <div>
                <FieldLabel htmlFor="chw-last-name">Last Name</FieldLabel>
                <input
                  id="chw-last-name"
                  type="text"
                  value={draft.lastName}
                  onChange={(e) => handleDraftChange('lastName', e.target.value)}
                  className={inputClass}
                  placeholder="Last name"
                />
              </div>
            </div>

            {/* Phone */}
            <div>
              <FieldLabel htmlFor="chw-phone">Phone Number</FieldLabel>
              <input
                id="chw-phone"
                type="tel"
                value={draft.phone}
                onChange={(e) => handleDraftChange('phone', e.target.value)}
                className={inputClass}
                placeholder="(323) 555-0000"
              />
            </div>

            {/* Email */}
            <div>
              <FieldLabel htmlFor="chw-email">Email Address</FieldLabel>
              <input
                id="chw-email"
                type="email"
                value={draft.email}
                onChange={(e) => handleDraftChange('email', e.target.value)}
                className={inputClass}
                placeholder="you@example.com"
              />
            </div>

            {/* ZIP */}
            <div>
              <FieldLabel htmlFor="chw-zip">ZIP Code</FieldLabel>
              <input
                id="chw-zip"
                type="text"
                value={draft.zipCode}
                onChange={(e) => handleDraftChange('zipCode', e.target.value)}
                maxLength={5}
                pattern="[0-9]{5}"
                className={inputClass}
                placeholder="90033"
              />
            </div>

            {/* Bio */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <FieldLabel htmlFor="chw-bio">Bio</FieldLabel>
                <span
                  className={`text-xs ${
                    draft.bio.length > BIO_MAX_LENGTH
                      ? 'text-red-500'
                      : 'text-[#AAAAAA]'
                  }`}
                  aria-live="polite"
                >
                  {draft.bio.length}/{BIO_MAX_LENGTH}
                </span>
              </div>
              <textarea
                id="chw-bio"
                value={draft.bio}
                onChange={(e) => handleDraftChange('bio', e.target.value)}
                maxLength={BIO_MAX_LENGTH}
                rows={4}
                className={`${inputClass} resize-none`}
                placeholder="Tell members about yourself..."
              />
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Full name */}
            <div className="flex items-center gap-3">
              <div
                className="w-9 h-9 rounded-[8px] bg-[#F8FAFB] border border-[#E5E7EB] flex items-center justify-center shrink-0"
                aria-hidden="true"
              >
                <User size={15} className="text-[#555555]" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-[#AAAAAA] uppercase tracking-wide font-medium">
                  Full Name
                </p>
                <p className="text-sm font-medium text-[#1A1A1A]">{displayName}</p>
              </div>
            </div>

            {/* Phone */}
            <div className="flex items-center gap-3">
              <div
                className="w-9 h-9 rounded-[8px] bg-[#F8FAFB] border border-[#E5E7EB] flex items-center justify-center shrink-0"
                aria-hidden="true"
              >
                <Phone size={15} className="text-[#555555]" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-[#AAAAAA] uppercase tracking-wide font-medium">
                  Phone
                </p>
                <p className="text-sm font-medium text-[#1A1A1A]">{display.phone}</p>
              </div>
            </div>

            {/* Email */}
            <div className="flex items-center gap-3">
              <div
                className="w-9 h-9 rounded-[8px] bg-[#F8FAFB] border border-[#E5E7EB] flex items-center justify-center shrink-0"
                aria-hidden="true"
              >
                <Mail size={15} className="text-[#555555]" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-[#AAAAAA] uppercase tracking-wide font-medium">
                  Email
                </p>
                <p className="text-sm font-medium text-[#1A1A1A] truncate">{display.email}</p>
              </div>
            </div>

            {/* ZIP */}
            <div className="flex items-center gap-3">
              <div
                className="w-9 h-9 rounded-[8px] bg-[#F8FAFB] border border-[#E5E7EB] flex items-center justify-center shrink-0"
                aria-hidden="true"
              >
                <Hash size={15} className="text-[#555555]" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-[#AAAAAA] uppercase tracking-wide font-medium">
                  ZIP Code
                </p>
                <p className="text-sm font-medium text-[#1A1A1A]">{display.zipCode}</p>
              </div>
            </div>

            {/* Bio */}
            <div className="flex items-start gap-3">
              <div
                className="w-9 h-9 rounded-[8px] bg-[#F8FAFB] border border-[#E5E7EB] flex items-center justify-center shrink-0 mt-0.5"
                aria-hidden="true"
              >
                <Edit2 size={15} className="text-[#555555]" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-[#AAAAAA] uppercase tracking-wide font-medium mb-0.5">
                  Bio
                </p>
                <p className="text-sm text-[#555555] leading-relaxed">{display.bio}</p>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* ── Specializations ── */}
      <section
        aria-labelledby="specializations-heading"
        className="bg-white rounded-[12px] border border-[#E5E7EB] p-4"
      >
        <div className="flex items-center justify-between mb-3">
          <h3
            id="specializations-heading"
            className="text-sm font-semibold text-[#1A1A1A] uppercase tracking-wide"
          >
            Specializations
          </h3>
          <button
            type="button"
            onClick={() => setEditingSpecializations((prev) => !prev)}
            className="flex items-center gap-1 text-xs font-medium text-[#0077B6] hover:text-[#005A8C] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0077B6] rounded"
            aria-label={
              editingSpecializations
                ? 'Done editing specializations'
                : 'Edit specializations'
            }
          >
            {editingSpecializations ? (
              <>
                <Check size={13} aria-hidden="true" />
                Done
              </>
            ) : (
              <>
                <Edit2 size={13} aria-hidden="true" />
                Edit
              </>
            )}
          </button>
        </div>

        {editingSpecializations ? (
          <div role="group" aria-label="Select specializations" className="flex flex-wrap gap-2">
            {ALL_VERTICALS.map(({ key, label }) => {
              const isSelected = (isEditing ? draft : saved).specializations.includes(key);
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => handleToggleSpecialization(key)}
                  aria-pressed={isSelected}
                  className={[
                    'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00B050]',
                    isSelected
                      ? 'bg-[#D0F0D0] border-[#00B050] text-[#00B050]'
                      : 'bg-white border-[#E5E7EB] text-[#AAAAAA] hover:border-[#00B050] hover:text-[#00B050]',
                  ].join(' ')}
                >
                  {isSelected && <CheckCircle size={12} aria-hidden="true" />}
                  {label}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {(isEditing ? draft : saved).specializations.length > 0 ? (
              (isEditing ? draft : saved).specializations.map((vertical) => {
                const label =
                  ALL_VERTICALS.find((v) => v.key === vertical)?.label ?? vertical;
                return (
                  <span
                    key={vertical}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-[#D0F0D0] text-[#00B050]"
                  >
                    <CheckCircle size={12} aria-hidden="true" />
                    {label}
                  </span>
                );
              })
            ) : (
              <p className="text-sm text-[#AAAAAA]">No specializations added yet.</p>
            )}
          </div>
        )}
      </section>

      {/* ── Languages ── */}
      <section
        aria-labelledby="languages-heading"
        className="bg-white rounded-[12px] border border-[#E5E7EB] p-4"
      >
        <div className="flex items-center justify-between mb-3">
          <h3
            id="languages-heading"
            className="text-sm font-semibold text-[#1A1A1A] uppercase tracking-wide"
          >
            Languages
          </h3>
          <button
            type="button"
            onClick={() => setEditingLanguages((prev) => !prev)}
            className="flex items-center gap-1 text-xs font-medium text-[#0077B6] hover:text-[#005A8C] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0077B6] rounded"
            aria-label={editingLanguages ? 'Done editing languages' : 'Edit languages'}
          >
            {editingLanguages ? (
              <>
                <Check size={13} aria-hidden="true" />
                Done
              </>
            ) : (
              <>
                <Edit2 size={13} aria-hidden="true" />
                Edit
              </>
            )}
          </button>
        </div>

        {editingLanguages ? (
          <div role="group" aria-label="Select languages" className="flex flex-wrap gap-2">
            {ALL_LANGUAGES.map((lang) => {
              const isSelected = (isEditing ? draft : saved).languages.includes(lang);
              return (
                <button
                  key={lang}
                  type="button"
                  onClick={() => handleToggleLanguage(lang)}
                  aria-pressed={isSelected}
                  className={[
                    'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0077B6]',
                    isSelected
                      ? 'bg-blue-50 border-[#0077B6] text-[#0077B6]'
                      : 'bg-white border-[#E5E7EB] text-[#AAAAAA] hover:border-[#0077B6] hover:text-[#0077B6]',
                  ].join(' ')}
                >
                  {isSelected && <Check size={12} aria-hidden="true" />}
                  {lang}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {(isEditing ? draft : saved).languages.length > 0 ? (
              (isEditing ? draft : saved).languages.map((lang) => (
                <span
                  key={lang}
                  className="inline-flex items-center px-3 py-1.5 rounded-full text-xs font-semibold bg-blue-50 text-[#0077B6]"
                >
                  {lang}
                </span>
              ))
            ) : (
              <p className="text-sm text-[#AAAAAA]">No languages listed.</p>
            )}
          </div>
        )}
      </section>

      {/* ── Availability ── */}
      <section
        aria-labelledby="availability-heading"
        className="bg-white rounded-[12px] border border-[#E5E7EB] p-4 space-y-4"
      >
        <h3
          id="availability-heading"
          className="text-sm font-semibold text-[#1A1A1A] uppercase tracking-wide"
        >
          Availability
        </h3>

        {/* Toggle row */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-[#1A1A1A]">
              {isAvailable ? 'Available for new requests' : 'Currently offline'}
            </p>
            <p className="text-xs text-[#AAAAAA] mt-0.5">
              {isAvailable
                ? 'Members can request sessions with you.'
                : 'You will not receive new requests.'}
            </p>
          </div>
          <AvailabilityToggle isAvailable={isAvailable} onChange={handleAvailabilityChange} />
        </div>

        {/* Service radius */}
        <div className="flex items-center gap-3 pt-1 border-t border-[#E5E7EB]">
          <div
            className="w-9 h-9 rounded-[8px] bg-[#F8FAFB] border border-[#E5E7EB] flex items-center justify-center shrink-0"
            aria-hidden="true"
          >
            <MapPin size={16} className="text-[#555555]" />
          </div>
          <div>
            <p className="text-xs text-[#AAAAAA] uppercase tracking-wide font-medium">
              Service Radius
            </p>
            <p className="text-sm font-semibold text-[#1A1A1A]">
              15 miles from {display.zipCode}
            </p>
          </div>
        </div>

        {/* Working hours */}
        <div className="flex items-center gap-3">
          <div
            className="w-9 h-9 rounded-[8px] bg-[#F8FAFB] border border-[#E5E7EB] flex items-center justify-center shrink-0"
            aria-hidden="true"
          >
            <Clock size={16} className="text-[#555555]" />
          </div>
          <div>
            <p className="text-xs text-[#AAAAAA] uppercase tracking-wide font-medium">
              Working Hours
            </p>
            <p className="text-sm font-semibold text-[#1A1A1A]">Mon – Fri, 9 AM – 5 PM</p>
          </div>
        </div>
      </section>

      {/* ── Credentials & Compliance ── */}
      <section
        aria-labelledby="credentials-heading"
        className="bg-white rounded-[12px] border border-[#E5E7EB] p-4 space-y-4"
      >
        <h3
          id="credentials-heading"
          className="text-sm font-semibold text-[#1A1A1A] uppercase tracking-wide"
        >
          Credentials &amp; Compliance
        </h3>

        {/* Compliance Status Card */}
        <div
          className={`rounded-[10px] border p-4 ${complianceStatusConfig.bg} ${complianceStatusConfig.border}`}
          aria-label={`Compliance status: ${complianceStatusConfig.label}`}
        >
          <div className="flex items-center justify-between mb-2">
            <div>
              <p className={`text-sm font-bold ${complianceStatusConfig.textColor}`}>
                {complianceStatusConfig.label}
              </p>
              <p className="text-xs text-[#555555] mt-0.5">
                {verifiedCount} of {totalCount} credentials verified
              </p>
            </div>
            <span
              className={`text-lg font-bold ${complianceStatusConfig.textColor}`}
              aria-hidden="true"
            >
              {compliancePercent}%
            </span>
          </div>

          <div
            className="w-full h-2 bg-white/60 rounded-full overflow-hidden"
            role="progressbar"
            aria-valuenow={verifiedCount}
            aria-valuemin={0}
            aria-valuemax={totalCount}
            aria-label={`${verifiedCount} of ${totalCount} credentials verified`}
          >
            <div
              className={`h-full rounded-full transition-all ${complianceStatusConfig.barColor}`}
              style={{ width: `${compliancePercent}%` }}
            />
          </div>
        </div>

        <div>
          {credentials.map((credential) => (
            <CredentialRow
              key={credential.id}
              credential={credential}
              onAction={handleCredentialAction}
            />
          ))}
        </div>
      </section>

      {/* ── Danger zone ── */}
      <section
        aria-labelledby="danger-zone-heading"
        className="bg-white rounded-[12px] border border-red-100 p-4"
      >
        <h3
          id="danger-zone-heading"
          className="text-sm font-semibold text-[#1A1A1A] uppercase tracking-wide mb-3"
        >
          Danger Zone
        </h3>
        <button
          type="button"
          onClick={handleLogout}
          className="flex items-center gap-2 px-4 py-2.5 rounded-[8px] border border-red-300 text-red-600 text-sm font-semibold hover:bg-red-50 active:bg-red-100 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-400"
          aria-label="Log out of your account"
        >
          <LogOut size={15} aria-hidden="true" />
          Log Out
        </button>
      </section>

      {/* ── Sticky Save Bar (visible when editing) ── */}
      {isEditing && (
        <div
          className="fixed bottom-0 left-0 right-0 bg-white border-t border-[#E5E7EB] p-4 flex justify-end gap-3 z-30 shadow-[0_-4px_16px_rgba(0,0,0,0.06)]"
          role="toolbar"
          aria-label="Profile edit actions"
        >
          <button
            type="button"
            onClick={handleDiscard}
            className="flex items-center gap-1.5 px-4 py-2.5 text-sm font-semibold text-[#555555] border border-[#E5E7EB] rounded-[8px] hover:bg-[#F8FAFB] active:bg-[#E5E7EB] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#555555]"
            aria-label="Discard profile changes"
          >
            <X size={14} aria-hidden="true" />
            Discard Changes
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="flex items-center gap-1.5 px-4 py-2.5 text-sm font-semibold text-white bg-[#00B050] hover:bg-[#008F40] active:bg-[#007035] rounded-[8px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00B050]"
            aria-label="Save profile changes"
          >
            <Save size={14} aria-hidden="true" />
            Save Changes
          </button>
        </div>
      )}

      {/* Toast notification */}
      {toastMessage && (
        <Toast message={toastMessage} onDismiss={() => setToastMessage(null)} />
      )}
    </div>
  );
}

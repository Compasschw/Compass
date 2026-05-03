import { useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Gift,
  MapPin,
  Globe,
  Check,
  X,
  Shield,
  Bell,
  LogOut,
  User,
  Heart,
  Phone,
  Monitor,
  PersonStanding,
  Star,
  ChevronDown,
  ChevronUp,
  Mail,
  Camera,
  Pencil,
  Save,
} from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { VerticalIcon } from '../../shared/components/VerticalIcon';
import {
  memberProfiles,
  verticalLabels,
  mockRewardHistory,
  redemptionCatalog,
  type Vertical,
  type SessionMode,
  type Urgency,
  type RewardHistoryEntry,
  type RedemptionItem,
} from '../../data/mock';

// ─── Types ────────────────────────────────────────────────────────────────────

type GenderPref = 'any' | 'female' | 'male';
type ModePref = SessionMode | 'any';

interface NotificationSettings {
  sessionReminders: boolean;
  goalUpdates: boolean;
  healthTips: boolean;
}

interface ProfileDraft {
  firstName: string;
  zipCode: string;
  preferredLanguage: string;
  phone: string;
  email: string;
  primaryNeed: Vertical;
  urgency: Urgency;
  insuranceProvider: string;
  genderPref: GenderPref;
  languagePref: string;
  modePref: ModePref;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const LANGUAGES = [
  'English', 'Spanish', 'Vietnamese', 'Arabic', 'Mandarin', 'Tagalog', 'Korean',
];

const INSURANCE_OPTIONS = [
  'Medi-Cal (LA Care)',
  'Medi-Cal (Health Net)',
  'Covered California',
  'Anthem Blue Cross',
  'Blue Shield of CA',
  'Kaiser Permanente',
  'No insurance',
  'Other',
];

const VERTICALS: { key: Vertical; label: string }[] = [
  { key: 'housing', label: 'Housing' },
  { key: 'food', label: 'Food Security' },
  { key: 'mental_health', label: 'Mental Health' },
  { key: 'rehab', label: 'Rehab & Recovery' },
  { key: 'healthcare', label: 'Healthcare Access' },
];

const URGENCY_OPTIONS: { key: Urgency; label: string; description: string }[] = [
  { key: 'routine', label: 'Routine', description: 'Regular check-ins, no urgency' },
  { key: 'soon', label: 'Soon', description: 'Needs attention within 2 weeks' },
  { key: 'urgent', label: 'Urgent', description: 'Immediate assistance needed' },
];

const GENDER_OPTIONS: { key: GenderPref; label: string }[] = [
  { key: 'any', label: 'Any' },
  { key: 'female', label: 'Female' },
  { key: 'male', label: 'Male' },
];

const MODE_OPTIONS: { key: ModePref; label: string; icon: React.ReactNode }[] = [
  { key: 'in_person', label: 'In Person', icon: <PersonStanding size={13} aria-hidden="true" /> },
  { key: 'virtual', label: 'Virtual', icon: <Monitor size={13} aria-hidden="true" /> },
  { key: 'phone', label: 'Phone', icon: <Phone size={13} aria-hidden="true" /> },
  { key: 'any', label: 'Any', icon: null },
];

const MEMBER_SINCE = 'January 2026';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getInitials(firstName: string): string {
  return firstName
    .trim()
    .split(' ')
    .slice(0, 2)
    .map((part) => part[0] ?? '')
    .join('')
    .toUpperCase();
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
      e.target.value = '';
    },
    [onImageChange],
  );

  const handleClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  return (
    <div className="relative shrink-0">
      <div className="relative w-16 h-16 md:w-20 md:h-20">
        {imageUrl ? (
          <img
            src={imageUrl}
            alt="Profile picture"
            className="w-full h-full rounded-full object-cover border-4 border-white shadow-md"
          />
        ) : (
          <div
            className="w-full h-full rounded-full bg-[rgba(107,143,113,0.15)] border-4 border-white shadow-md flex items-center justify-center font-bold text-[#6B8F71] text-xl"
            aria-hidden="true"
          >
            {initials}
          </div>
        )}

        {/* Camera overlay on hover */}
        <button
          type="button"
          onClick={handleClick}
          className="absolute inset-0 bg-black/40 rounded-full flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity cursor-pointer focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6B8F71]"
          aria-label="Change profile picture"
        >
          <Camera size={18} className="text-white" aria-hidden="true" />
        </button>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="sr-only"
          aria-label="Upload profile picture"
          onChange={handleFileChange}
        />
      </div>

      {imageUrl && (
        <button
          type="button"
          onClick={onImageRemove}
          className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-[#2C3E2D] border-2 border-white flex items-center justify-center hover:bg-red-600 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500"
          aria-label="Remove profile picture"
        >
          <X size={10} className="text-white" strokeWidth={3} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface SectionHeaderProps {
  id: string;
  children: React.ReactNode;
}

function SectionHeader({ id, children }: SectionHeaderProps) {
  return (
    <h3
      id={id}
      className="text-sm font-semibold text-[#2C3E2D] uppercase tracking-wide mb-3"
    >
      {children}
    </h3>
  );
}

interface InfoRowProps {
  icon: React.ReactNode;
  label: string;
  value: string;
}

function InfoRow({ icon, label, value }: InfoRowProps) {
  return (
    <div className="flex items-center gap-3">
      <div
        className="w-9 h-9 rounded-[12px] bg-[#FBF7F0] border border-[rgba(44,62,45,0.1)] flex items-center justify-center shrink-0"
        aria-hidden="true"
      >
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs text-[#8B9B8D] uppercase tracking-wide font-medium">{label}</p>
        <p className="text-sm font-medium text-[#2C3E2D] truncate">{value}</p>
      </div>
    </div>
  );
}

interface ToggleSwitchProps {
  id: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  description?: string;
}

function ToggleSwitch({ id, checked, onChange, label, description }: ToggleSwitchProps) {
  return (
    <div className="flex items-center justify-between gap-4">
      <label htmlFor={id} className="flex-1 cursor-pointer">
        <p className="text-sm font-medium text-[#2C3E2D]">{label}</p>
        {description && (
          <p className="text-xs text-[#8B9B8D] mt-0.5">{description}</p>
        )}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={[
          'relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6B8F71]',
          checked ? 'bg-[#2C3E2D]' : 'bg-[rgba(44,62,45,0.1)]',
        ].join(' ')}
      >
        <span
          className={[
            'pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out',
            checked ? 'translate-x-5' : 'translate-x-0',
          ].join(' ')}
          aria-hidden="true"
        />
      </button>
    </div>
  );
}

// ─── Input helpers ────────────────────────────────────────────────────────────

const inputClass =
  'w-full rounded-[12px] border border-[rgba(44,62,45,0.1)] px-3 py-2.5 text-sm text-[#2C3E2D] bg-white focus:outline-none focus:ring-2 focus:ring-[#6B8F71] focus:border-[#6B8F71] transition-colors placeholder:text-[#8B9B8D]';

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <label
      htmlFor={htmlFor}
      className="block text-xs text-[#8B9B8D] uppercase tracking-wide font-medium mb-1"
    >
      {children}
    </label>
  );
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function Toast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2.5 bg-[#2C3E2D] text-white text-sm font-medium px-5 py-3 rounded-[20px] shadow-lg cursor-pointer max-w-[calc(100vw-2rem)]"
      onClick={onDismiss}
    >
      <span className="w-5 h-5 rounded-full bg-[#2C3E2D] flex items-center justify-center shrink-0">
        <Check size={11} className="text-white" strokeWidth={3} aria-hidden="true" />
      </span>
      {message}
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * MemberProfile — the community member's profile, preferences, and settings page.
 *
 * Sections:
 * 1. Profile header: avatar (with image upload), name, member since, Edit Profile button
 * 2. Rewards balance with history and redeem panels
 * 3. Personal info — editable: firstName, zip, preferred language, phone, email
 * 4. Health Preferences — editable: primary need (dropdown), urgency (radio)
 * 5. Insurance — editable provider dropdown
 * 6. CHW Preferences — gender, language, mode (always interactive buttons)
 * 7. Notification toggles
 * 8. Danger zone: log out
 */
export function MemberProfile() {
  const { logout, userName } = useAuth();
  const navigate = useNavigate();

  // NOTE: this screen still pulls non-PII defaults (zipCode, language,
  // primary need) from memberProfiles[0] until full /member/profile
  // wiring lands on web. Name/phone/email come from auth context (or are
  // empty) so a real member never sees Rosa Delgado's contact info as
  // their own. Migration to the real API is tracked separately.
  const member = memberProfiles[0];

  // ── Profile picture ──
  const [profileImage, setProfileImage] = useState<string | null>(null);

  // ── Global edit mode ──
  const [isEditing, setIsEditing] = useState(false);

  // ── Draft and saved snapshot ──
  const initialDraft: ProfileDraft = {
    firstName: (userName ?? '').split(' ')[0] ?? '',
    zipCode: member.zipCode,
    preferredLanguage: member.primaryLanguage,
    phone: '',
    email: '',
    primaryNeed: member.primaryNeed,
    urgency: 'routine',
    insuranceProvider: 'Medi-Cal (LA Care)',
    genderPref: 'any',
    languagePref: 'Any',
    modePref: 'any',
  };

  const [draft, setDraft] = useState<ProfileDraft>(initialDraft);
  const [saved, setSaved] = useState<ProfileDraft>(initialDraft);

  // ── Notification state — independent of edit mode ──
  const [notifications, setNotifications] = useState<NotificationSettings>({
    sessionReminders: true,
    goalUpdates: true,
    healthTips: false,
  });

  // ── Reward panel state ──
  const [showHistory, setShowHistory] = useState(false);
  const [showCatalog, setShowCatalog] = useState(false);

  // ── Toast ──
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // ── Derived ──
  const display = isEditing ? draft : saved;
  const initials = getInitials(display.firstName);

  // ── Handlers ──

  const handleStartEdit = useCallback(() => {
    setSaved({ ...draft });
    setIsEditing(true);
  }, [draft]);

  const handleSave = useCallback(() => {
    setSaved({ ...draft });
    setIsEditing(false);
    setToastMessage('Profile updated!');
    setTimeout(() => setToastMessage(null), 3500);
  }, [draft]);

  const handleDiscard = useCallback(() => {
    setDraft({ ...saved });
    setIsEditing(false);
  }, [saved]);

  const handleDraftChange = useCallback(
    <K extends keyof ProfileDraft>(key: K, value: ProfileDraft[K]) => {
      setDraft((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const handleNotificationChange = useCallback(
    (key: keyof NotificationSettings) => (value: boolean) => {
      setNotifications((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const handleRedeem = useCallback(() => {
    setToastMessage('Rewards feature coming soon!');
    setTimeout(() => setToastMessage(null), 3000);
  }, []);

  const handleToggleHistory = useCallback(() => {
    setShowHistory((prev) => !prev);
    setShowCatalog(false);
  }, []);

  const handleToggleCatalog = useCallback(() => {
    setShowCatalog((prev) => !prev);
    setShowHistory(false);
  }, []);

  const handleLogout = useCallback(() => {
    logout();
    navigate('/login');
  }, [logout, navigate]);

  return (
    <div className="max-w-3xl mx-auto space-y-5 pb-28">

      {/* ── Profile header ── */}
      <section
        aria-labelledby="member-profile-heading"
        className="bg-white rounded-[20px] border border-[rgba(44,62,45,0.1)] p-5"
      >
        <div className="flex items-center gap-4">
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
                  id="member-profile-heading"
                  className="text-lg font-bold text-[#2C3E2D] truncate"
                >
                  {display.firstName}
                </h2>
                <p className="text-xs text-[#8B9B8D] mt-0.5">Member since {MEMBER_SINCE}</p>
                <div className="flex items-center gap-1.5 mt-1.5">
                  <VerticalIcon vertical={display.primaryNeed} size={13} />
                  <span className="text-xs text-[#555555]">
                    {verticalLabels[display.primaryNeed]}
                  </span>
                </div>
              </div>

              {/* Edit Profile button */}
              {!isEditing && (
                <button
                  type="button"
                  onClick={handleStartEdit}
                  className="flex items-center gap-1.5 text-sm font-semibold text-[#6B8F71] border border-[#6B8F71] hover:bg-[#2C3E2D]/10 px-3 py-2 rounded-[12px] transition-colors shrink-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6B8F71]"
                  aria-label="Edit profile"
                >
                  <Pencil size={14} aria-hidden="true" />
                  Edit Profile
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ── Rewards ── */}
      <section
        aria-labelledby="rewards-heading"
        className="bg-[rgba(107,143,113,0.15)]/50 border border-[#6B8F71]/20 rounded-[12px] p-4 space-y-4"
      >
        {/* Balance row */}
        <div className="flex items-center gap-3">
          <div
            className="w-9 h-9 rounded-[12px] bg-[#2C3E2D]/10 flex items-center justify-center shrink-0"
            aria-hidden="true"
          >
            <Gift size={18} className="text-[#6B8F71]" />
          </div>
          <div>
            <h3 id="rewards-heading" className="text-sm font-bold text-[#2C3E2D]">
              You have{' '}
              <span className="text-[#6B8F71]">{member.rewardsBalance} points!</span>
            </h3>
            <p className="text-xs text-[#555555]">
              Earned through completed sessions and goals
            </p>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleToggleHistory}
            aria-expanded={showHistory}
            className={[
              'flex-1 flex items-center justify-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-[12px] border transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6B8F71]',
              showHistory
                ? 'bg-[#2C3E2D] border-[#6B8F71] text-white'
                : 'border-[#6B8F71] text-[#6B8F71] hover:bg-[#2C3E2D]/10',
            ].join(' ')}
          >
            <Star size={13} aria-hidden="true" />
            View History
            {showHistory ? (
              <ChevronUp size={13} aria-hidden="true" />
            ) : (
              <ChevronDown size={13} aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            onClick={handleToggleCatalog}
            aria-expanded={showCatalog}
            className={[
              'flex-1 flex items-center justify-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-[12px] border transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6B8F71]',
              showCatalog
                ? 'bg-[#2C3E2D] border-[#6B8F71] text-white'
                : 'border-[#6B8F71] text-[#6B8F71] hover:bg-[#2C3E2D]/10',
            ].join(' ')}
          >
            <Gift size={13} aria-hidden="true" />
            Redeem Points
            {showCatalog ? (
              <ChevronUp size={13} aria-hidden="true" />
            ) : (
              <ChevronDown size={13} aria-hidden="true" />
            )}
          </button>
        </div>

        {/* Points History panel */}
        {showHistory && (
          <div
            className="bg-white rounded-[20px] border border-[rgba(44,62,45,0.1)] overflow-hidden"
            role="region"
            aria-label="Points history"
          >
            <div className="px-4 py-3 border-b border-[rgba(44,62,45,0.1)]">
              <p className="text-xs font-semibold text-[#2C3E2D] uppercase tracking-wide">
                Points History
              </p>
            </div>
            <ul className="divide-y divide-[rgba(44,62,45,0.1)]">
              {mockRewardHistory.map((entry: RewardHistoryEntry) => {
                const isEarned = entry.points > 0;
                return (
                  <li key={entry.id} className="flex items-center gap-3 px-4 py-3">
                    <span
                      className={[
                        'text-base leading-none shrink-0',
                        isEarned ? 'text-[#6B8F71]' : 'text-red-500',
                      ].join(' ')}
                      aria-hidden="true"
                    >
                      ●
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-[#2C3E2D] truncate">
                        {entry.description}
                      </p>
                      <p className="text-xs text-[#8B9B8D] mt-0.5">{entry.date}</p>
                    </div>
                    <span
                      className={[
                        'text-sm font-semibold shrink-0',
                        isEarned ? 'text-[#6B8F71]' : 'text-red-500',
                      ].join(' ')}
                    >
                      {isEarned ? `+${entry.points}` : entry.points}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* Redemption Catalog panel */}
        {showCatalog && (
          <div
            className="bg-white rounded-[20px] border border-[rgba(44,62,45,0.1)] overflow-hidden"
            role="region"
            aria-label="Redemption catalog"
          >
            <div className="px-4 py-3 border-b border-[rgba(44,62,45,0.1)]">
              <p className="text-xs font-semibold text-[#2C3E2D] uppercase tracking-wide">
                Redeem Points
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3 p-4">
              {redemptionCatalog.map((item: RedemptionItem) => {
                const canAfford = member.rewardsBalance >= item.pointsCost;
                return (
                  <div
                    key={item.id}
                    className="flex flex-col items-start gap-1.5 bg-[#FBF7F0] border border-[rgba(44,62,45,0.1)] rounded-[10px] p-3"
                  >
                    <span
                      className="text-2xl leading-none"
                      role="img"
                      aria-label={item.name}
                    >
                      {item.emoji}
                    </span>
                    <p className="text-sm font-bold text-[#2C3E2D] leading-snug">
                      {item.name}
                    </p>
                    <p className="text-xs text-[#8B9B8D] leading-snug">{item.description}</p>
                    <p className="text-xs font-semibold text-[#555555] mt-auto">
                      {item.pointsCost} pts
                    </p>
                    <button
                      type="button"
                      onClick={handleRedeem}
                      disabled={!canAfford}
                      aria-label={
                        canAfford
                          ? `Redeem ${item.name} for ${item.pointsCost} points`
                          : `Not enough points for ${item.name}`
                      }
                      className={[
                        'w-full mt-1 text-xs font-semibold py-1.5 rounded-[6px] border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
                        canAfford
                          ? 'border-[#6B8F71] text-[#6B8F71] hover:bg-[#2C3E2D]/10 focus-visible:outline-[#6B8F71]'
                          : 'border-[rgba(44,62,45,0.1)] text-[#8B9B8D] bg-[#FBF7F0] cursor-not-allowed',
                      ].join(' ')}
                    >
                      Redeem
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </section>

      {/* ── Personal Info ── */}
      <section
        aria-labelledby="personal-info-heading"
        className="bg-white rounded-[20px] border border-[rgba(44,62,45,0.1)] p-4"
      >
        <div className="flex items-center justify-between mb-4">
          <SectionHeader id="personal-info-heading">Personal Info</SectionHeader>
          {isEditing && (
            <span className="text-xs text-[#6B8F71] font-medium">Editing</span>
          )}
        </div>

        {isEditing ? (
          <div className="space-y-4">
            {/* First Name */}
            <div>
              <FieldLabel htmlFor="mem-first-name">Full Name</FieldLabel>
              <input
                id="mem-first-name"
                type="text"
                value={draft.firstName}
                onChange={(e) => handleDraftChange('firstName', e.target.value)}
                className={inputClass}
                placeholder="Your name"
              />
            </div>

            {/* ZIP */}
            <div>
              <FieldLabel htmlFor="mem-zip">ZIP Code</FieldLabel>
              <input
                id="mem-zip"
                type="text"
                value={draft.zipCode}
                onChange={(e) => handleDraftChange('zipCode', e.target.value)}
                maxLength={5}
                pattern="[0-9]{5}"
                className={inputClass}
                placeholder="90031"
              />
            </div>

            {/* Preferred Language */}
            <div>
              <FieldLabel htmlFor="mem-language">Preferred Language</FieldLabel>
              <select
                id="mem-language"
                value={draft.preferredLanguage}
                onChange={(e) => handleDraftChange('preferredLanguage', e.target.value)}
                className={inputClass}
              >
                {LANGUAGES.map((lang) => (
                  <option key={lang} value={lang}>
                    {lang}
                  </option>
                ))}
              </select>
            </div>

            {/* Phone */}
            <div>
              <FieldLabel htmlFor="mem-phone">Phone Number</FieldLabel>
              <input
                id="mem-phone"
                type="tel"
                value={draft.phone}
                onChange={(e) => handleDraftChange('phone', e.target.value)}
                className={inputClass}
                placeholder="(323) 555-0000"
              />
            </div>

            {/* Email */}
            <div>
              <FieldLabel htmlFor="mem-email">Email Address</FieldLabel>
              <input
                id="mem-email"
                type="email"
                value={draft.email}
                onChange={(e) => handleDraftChange('email', e.target.value)}
                className={inputClass}
                placeholder="you@example.com"
              />
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <InfoRow
              icon={<User size={15} className="text-[#555555]" />}
              label="Full Name"
              value={display.firstName}
            />
            <InfoRow
              icon={<MapPin size={15} className="text-[#555555]" />}
              label="ZIP Code"
              value={display.zipCode}
            />
            <InfoRow
              icon={<Globe size={15} className="text-[#555555]" />}
              label="Preferred Language"
              value={display.preferredLanguage}
            />
            <InfoRow
              icon={<Phone size={15} className="text-[#555555]" />}
              label="Phone"
              value={display.phone}
            />
            <InfoRow
              icon={<Mail size={15} className="text-[#555555]" />}
              label="Email"
              value={display.email}
            />
          </div>
        )}
      </section>

      {/* ── Health Preferences ── */}
      <section
        aria-labelledby="health-prefs-heading"
        className="bg-white rounded-[20px] border border-[rgba(44,62,45,0.1)] p-4"
      >
        <div className="flex items-center justify-between mb-3">
          <SectionHeader id="health-prefs-heading">Health Preferences</SectionHeader>
          {isEditing && (
            <span className="text-xs text-[#6B8F71] font-medium">Editing</span>
          )}
        </div>

        {isEditing ? (
          <div className="space-y-4">
            {/* Primary need dropdown */}
            <div>
              <FieldLabel htmlFor="mem-primary-need">Primary Need</FieldLabel>
              <select
                id="mem-primary-need"
                value={draft.primaryNeed}
                onChange={(e) =>
                  handleDraftChange('primaryNeed', e.target.value as Vertical)
                }
                className={inputClass}
              >
                {VERTICALS.map(({ key, label }) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </div>

            {/* Urgency radio */}
            <div>
              <p className="text-xs text-[#8B9B8D] uppercase tracking-wide font-medium mb-2">
                Urgency Preference
              </p>
              <div
                role="radiogroup"
                aria-label="Urgency preference"
                className="space-y-2"
              >
                {URGENCY_OPTIONS.map(({ key, label, description }) => {
                  const isSelected = draft.urgency === key;
                  return (
                    <label
                      key={key}
                      className={[
                        'flex items-start gap-3 p-3 rounded-[12px] border cursor-pointer transition-all',
                        isSelected
                          ? 'border-[#6B8F71] bg-[rgba(107,143,113,0.15)]/30'
                          : 'border-[rgba(44,62,45,0.1)] hover:border-[#6B8F71]/40',
                      ].join(' ')}
                    >
                      <input
                        type="radio"
                        name="urgency"
                        value={key}
                        checked={isSelected}
                        onChange={() => handleDraftChange('urgency', key)}
                        className="mt-0.5 accent-[#6B8F71]"
                        aria-label={label}
                      />
                      <div>
                        <p
                          className={`text-sm font-semibold ${
                            isSelected ? 'text-[#6B8F71]' : 'text-[#2C3E2D]'
                          }`}
                        >
                          {label}
                        </p>
                        <p className="text-xs text-[#8B9B8D]">{description}</p>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Primary need */}
            <div className="flex items-center gap-3">
              <div
                className="w-9 h-9 rounded-[12px] bg-[#FBF7F0] border border-[rgba(44,62,45,0.1)] flex items-center justify-center shrink-0"
                aria-hidden="true"
              >
                <VerticalIcon vertical={display.primaryNeed} size={16} />
              </div>
              <div>
                <p className="text-xs text-[#8B9B8D] uppercase tracking-wide font-medium">
                  Primary Need
                </p>
                <p className="text-sm font-medium text-[#2C3E2D]">
                  {verticalLabels[display.primaryNeed]}
                </p>
              </div>
            </div>

            {/* SDOH flags */}
            <div className="flex items-start gap-3">
              <div
                className="w-9 h-9 rounded-[12px] bg-[#FBF7F0] border border-[rgba(44,62,45,0.1)] flex items-center justify-center shrink-0"
                aria-hidden="true"
              >
                <Heart size={15} className="text-pink-500" />
              </div>
              <div>
                <p className="text-xs text-[#8B9B8D] uppercase tracking-wide font-medium mb-1">
                  SDOH Factors
                </p>
                <div className="flex flex-wrap gap-1">
                  {(['housing', 'food', 'mental_health'] as Vertical[]).map((v) => (
                    <span
                      key={v}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-[#FBF7F0] border border-[rgba(44,62,45,0.1)] text-[#555555]"
                    >
                      <VerticalIcon vertical={v} size={11} />
                      {verticalLabels[v]}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {/* Urgency */}
            <InfoRow
              icon={<Shield size={15} className="text-[#555555]" />}
              label="Urgency Preference"
              value={
                URGENCY_OPTIONS.find((o) => o.key === display.urgency)?.label ??
                'Routine'
              }
            />
          </div>
        )}
      </section>

      {/* ── Insurance ── */}
      <section
        aria-labelledby="insurance-heading"
        className="bg-white rounded-[20px] border border-[rgba(44,62,45,0.1)] p-4"
      >
        <div className="flex items-center justify-between mb-3">
          <SectionHeader id="insurance-heading">Insurance</SectionHeader>
          {isEditing && (
            <span className="text-xs text-[#6B8F71] font-medium">Editing</span>
          )}
        </div>

        {isEditing ? (
          <div>
            <FieldLabel htmlFor="mem-insurance">Insurance Provider</FieldLabel>
            <select
              id="mem-insurance"
              value={draft.insuranceProvider}
              onChange={(e) => handleDraftChange('insuranceProvider', e.target.value)}
              className={inputClass}
            >
              {INSURANCE_OPTIONS.map((provider) => (
                <option key={provider} value={provider}>
                  {provider}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <div
              className="w-9 h-9 rounded-[12px] bg-blue-50 border border-blue-100 flex items-center justify-center shrink-0"
              aria-hidden="true"
            >
              <Shield size={15} className="text-[#0077B6]" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs text-[#8B9B8D] uppercase tracking-wide font-medium">
                Provider
              </p>
              <p className="text-sm font-medium text-[#2C3E2D]">{display.insuranceProvider}</p>
            </div>
          </div>
        )}
      </section>

      {/* ── CHW Preferences ── */}
      <section
        aria-labelledby="chw-prefs-heading"
        className="bg-white rounded-[20px] border border-[rgba(44,62,45,0.1)] p-4"
      >
        <SectionHeader id="chw-prefs-heading">CHW Preferences</SectionHeader>

        <div className="space-y-4">
          {/* Gender preference */}
          <div>
            <p className="text-xs text-[#8B9B8D] uppercase tracking-wide font-medium mb-2">
              Gender Preference
            </p>
            <div role="group" aria-label="CHW gender preference" className="flex gap-2">
              {GENDER_OPTIONS.map((option) => {
                const isSelected = (isEditing ? draft : saved).genderPref === option.key;
                return (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => handleDraftChange('genderPref', option.key)}
                    aria-pressed={isSelected}
                    className={[
                      'flex-1 py-2 text-xs font-semibold rounded-[12px] border transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6B8F71]',
                      isSelected
                        ? 'bg-[rgba(107,143,113,0.15)]/40 border-[#6B8F71] text-[#6B8F71]'
                        : 'bg-white border-[rgba(44,62,45,0.1)] text-[#555555] hover:border-[#6B8F71]/50',
                    ].join(' ')}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Language preference */}
          <div>
            <p className="text-xs text-[#8B9B8D] uppercase tracking-wide font-medium mb-2">
              Language Preference
            </p>
            <select
              value={(isEditing ? draft : saved).languagePref}
              onChange={(e) => handleDraftChange('languagePref', e.target.value)}
              className="w-full px-3 py-2.5 rounded-[12px] border border-[rgba(44,62,45,0.1)] text-sm text-[#2C3E2D] bg-white focus:outline-none focus:ring-2 focus:ring-[#6B8F71]/30 focus:border-[#6B8F71] transition-colors"
              aria-label="Preferred CHW language"
            >
              <option value="Any">Any language</option>
              {LANGUAGES.map((lang) => (
                <option key={lang} value={lang}>
                  {lang}
                </option>
              ))}
            </select>
          </div>

          {/* Mode preference */}
          <div>
            <p className="text-xs text-[#8B9B8D] uppercase tracking-wide font-medium mb-2">
              Session Mode
            </p>
            <div
              role="group"
              aria-label="Preferred session mode"
              className="grid grid-cols-2 gap-2 sm:grid-cols-4"
            >
              {MODE_OPTIONS.map((option) => {
                const isSelected =
                  (isEditing ? draft : saved).modePref === option.key;
                return (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => handleDraftChange('modePref', option.key)}
                    aria-pressed={isSelected}
                    className={[
                      'flex items-center justify-center gap-1.5 py-2 text-xs font-semibold rounded-[12px] border transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0077B6]',
                      isSelected
                        ? 'bg-blue-50 border-[#0077B6] text-[#0077B6]'
                        : 'bg-white border-[rgba(44,62,45,0.1)] text-[#555555] hover:border-[#0077B6]/50',
                    ].join(' ')}
                  >
                    {option.icon}
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* ── Notification Settings ── */}
      <section
        aria-labelledby="notifications-heading"
        className="bg-white rounded-[20px] border border-[rgba(44,62,45,0.1)] p-4"
      >
        <div className="flex items-center gap-2 mb-3">
          <Bell size={15} className="text-[#555555]" aria-hidden="true" />
          <SectionHeader id="notifications-heading">Notifications</SectionHeader>
        </div>

        <div className="space-y-4">
          <ToggleSwitch
            id="toggle-session-reminders"
            checked={notifications.sessionReminders}
            onChange={handleNotificationChange('sessionReminders')}
            label="Session Reminders"
            description="Get notified 24 hrs before a session"
          />
          <div className="border-t border-[rgba(44,62,45,0.1)]" />
          <ToggleSwitch
            id="toggle-goal-updates"
            checked={notifications.goalUpdates}
            onChange={handleNotificationChange('goalUpdates')}
            label="Goal Updates"
            description="Progress milestones and new goals"
          />
          <div className="border-t border-[rgba(44,62,45,0.1)]" />
          <ToggleSwitch
            id="toggle-health-tips"
            checked={notifications.healthTips}
            onChange={handleNotificationChange('healthTips')}
            label="Health Tips"
            description="Weekly tips from your care team"
          />
        </div>
      </section>

      {/* ── Danger zone ── */}
      <section
        aria-labelledby="member-danger-zone-heading"
        className="bg-white rounded-[20px] border border-red-100 p-4"
      >
        <h3
          id="member-danger-zone-heading"
          className="text-sm font-semibold text-[#2C3E2D] uppercase tracking-wide mb-3"
        >
          Account
        </h3>
        <button
          type="button"
          onClick={handleLogout}
          className="flex items-center gap-2 px-4 py-2.5 rounded-[12px] border border-red-300 text-red-600 text-sm font-semibold hover:bg-red-50 active:bg-red-100 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-400"
          aria-label="Log out of your account"
        >
          <LogOut size={15} aria-hidden="true" />
          Log Out
        </button>
      </section>

      {/* ── Sticky Save Bar (visible when editing) ── */}
      {isEditing && (
        <div
          className="fixed bottom-0 left-0 right-0 bg-white border-t border-[rgba(44,62,45,0.1)] p-4 flex justify-end gap-3 z-30 shadow-[0_-4px_16px_rgba(0,0,0,0.06)]"
          role="toolbar"
          aria-label="Profile edit actions"
        >
          <button
            type="button"
            onClick={handleDiscard}
            className="flex items-center gap-1.5 px-4 py-2.5 text-sm font-semibold text-[#555555] border border-[rgba(44,62,45,0.1)] rounded-[12px] hover:bg-[#FBF7F0] active:bg-[rgba(44,62,45,0.1)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#555555]"
            aria-label="Discard profile changes"
          >
            <X size={14} aria-hidden="true" />
            Discard Changes
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="flex items-center gap-1.5 px-4 py-2.5 text-sm font-semibold text-white bg-[#2C3E2D] hover:bg-[#3A5240] active:bg-[#243D25] rounded-[12px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6B8F71]"
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

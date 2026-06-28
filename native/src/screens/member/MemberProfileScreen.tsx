/**
 * MemberProfileScreen — 3-column redesign (T22).
 *
 * Layout (3-column top card — mirrors T08's CHWMemberProfileScreen pattern):
 *   Left   — Demographics: name, DOB, gender, address, phone, ZIP, insurance, CIN.
 *             Pencil icon on the card header opens InsuranceCinEditModal.
 *   Center — Services Consent: verbatim disclaimer + Yes/No consent toggle.
 *             Flipping to refuse_services shows a confirm modal. No confirm on restore.
 *   Right  — Active Journeys list + Rewards balance + recent point activity preview.
 *
 * Below the top card (full-width):
 *   - CHW Preferences (gender, language, session mode)
 *   - Notification settings
 *   - Rewards history
 *   - Redemption catalog
 *   - Account (Sign Out, Delete Account)
 *
 * Web: PageWrap caps at 1280px. Native: full-width.
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Bell,
  Check,
  CheckCircle2,
  ClipboardList,
  Edit2,
  Gift,
  LogOut,
  Phone,
  ShoppingBag,
  Star,
  X,
} from 'lucide-react-native';

import { useAuth } from '../../context/AuthContext';
import { PhoneVerificationModal } from '../../components/shared/PhoneVerificationModal';
import { colors as legacyColors } from '../../theme/colors';
import { colors as tokens, spacing, radius, shadows } from '../../theme/tokens';
import { typography } from '../../theme/typography';
import {
  verticalLabels,
  type Vertical,
} from '../../data/mock';
import {
  useMemberProfile,
  useMemberRewards,
  useUpdateMemberProfile,
  useDeleteAccount,
  useOwnServicesConsent,
  useUpdateServicesConsent,
  useMemberJourneys,
  useRewardsCatalog,
  type MemberProfile,
  type RewardTransaction,
  type ServicesConsentValue,
  type MemberJourneyResponse,
  type RewardCatalogItem,
} from '../../hooks/useApiQueries';
import { Card } from '../../components/ui/Card';
import { PageWrap } from '../../components/ui/PageWrap';
import { PageHeader } from '../../components/ui/PageHeader';
import { SectionHeader } from '../../components/ui/SectionHeader';
import { Pill } from '../../components/ui/Pill';
import { ProfilePictureEditor } from '../../components/ui/ProfilePictureEditor';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';
import { DeleteAccountModal } from '../../components/profile/DeleteAccountModal';
import { confirmAsync } from '../../utils/confirm';
import {
  INSURANCE_OPTIONS,
  validateCinForCarrier,
  expectedFormatMessage,
} from '../../constants/insurance';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Verbatim disclaimer copy from the cofounder spec.
 * Do NOT rephrase or truncate. This is the exact string that must render above
 * the consent toggle per the T22 / T03 spec.
 */
const SERVICES_CONSENT_DISCLAIMER =
  'CHW services are provided to you at no cost by your health plan, do you consent to receive services?';

const NOT_PROVIDED = 'Not provided';

const ALL_LANGUAGES: string[] = [
  'English',
  'Spanish',
  'Vietnamese',
  'Arabic',
  'Cantonese',
  'Mandarin',
  'Tagalog',
  'Korean',
];

const ALL_VERTICALS: Vertical[] = [
  'housing',
  'rehab',
  'food',
  'mental_health',
  'healthcare',
];

const GENDER_OPTIONS: { key: GenderPreference; label: string }[] = [
  { key: 'any', label: 'Any' },
  { key: 'male', label: 'Male' },
  { key: 'female', label: 'Female' },
];

const SESSION_MODE_OPTIONS: { key: SessionModePreference; label: string }[] = [
  { key: 'in_person', label: 'In Person' },
  { key: 'virtual', label: 'Virtual' },
  { key: 'phone', label: 'Phone' },
];

/**
 * Returns the appropriate lucide icon for a reward action type.
 * Falls back to a ClipboardList icon for unknown actions.
 */
function RewardActionIcon({ action, size = 15 }: { action: string; size?: number }): React.JSX.Element {
  switch (action) {
    case 'session_completed':
      return (
        <CheckCircle2
          size={size}
          color={tokens.emerald700}
          strokeWidth={2}
          accessibilityLabel="session completed"
        />
      );
    case 'follow_through':
      return (
        <Star
          size={size}
          color={tokens.amber700}
          strokeWidth={2}
          accessibilityLabel="goal milestone achieved"
        />
      );
    case 'redeemed':
      return (
        <Gift
          size={size}
          color={tokens.primary}
          strokeWidth={2}
          accessibilityLabel="reward redeemed"
        />
      );
    default:
      return (
        <ClipboardList
          size={size}
          color={tokens.primary}
          strokeWidth={2}
        />
      );
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

type GenderPreference = 'any' | 'male' | 'female';
type SessionModePreference = 'in_person' | 'virtual' | 'phone';

interface CHWPreferences {
  genderPreference: GenderPreference;
  languagePreferences: string[];
  sessionModePreference: SessionModePreference;
}

interface NotificationSettings {
  sessionReminders: boolean;
  goalUpdates: boolean;
  healthTips: boolean;
}

interface ProfileDraft {
  firstName: string;
  lastName: string;
  zipCode: string;
  phone: string;
  email: string;
  primaryLanguage: string;
  primaryNeed: Vertical;
  insuranceProvider: string;
}

interface ProfileSource {
  zipCode: string;
  primaryLanguage: string;
  primaryNeed: string;
  insuranceProvider?: string;
  phone?: string;
  email?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getInitials(name: string): string {
  return name
    .split(' ')
    .slice(0, 2)
    .map((p) => p[0] ?? '')
    .join('')
    .toUpperCase();
}

function formatRewardDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

function buildDraft(name: string, profile: ProfileSource): ProfileDraft {
  const parts = name.split(' ');
  return {
    firstName: parts[0] ?? '',
    lastName: parts.slice(1).join(' '),
    zipCode: profile.zipCode,
    phone: profile.phone ?? '',
    email: profile.email ?? '',
    primaryLanguage: profile.primaryLanguage,
    primaryNeed: profile.primaryNeed as Vertical,
    insuranceProvider: profile.insuranceProvider ?? '',
  };
}

// ─── EditProfileModal ──────────────────────────────────────────────────────────

const SEX_OPTIONS = ['Male', 'Female', 'Other'] as const;

/** Convert an ISO date ("YYYY-MM-DD") to the MM/DD/YYYY a member types. */
function isoToMmddyyyy(iso: string | null | undefined): string {
  if (!iso) return '';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : '';
}

/** Parse MM/DD/YYYY → ISO "YYYY-MM-DD"; returns null when not a valid date. */
function mmddyyyyToIso(value: string): string | null {
  const m = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > 2100) {
    return null;
  }
  return `${m[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

interface EditProfileModalProps {
  visible: boolean;
  profile: MemberProfile | undefined;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Full demographics editor — every field a CHW can see on the member profile is
 * editable here: name, preferred name, DOB, sex, address, ZIP, primary language,
 * insurance carrier, and Medi-Cal CIN.
 *
 * Saves via PUT /member/profile (useUpdateMemberProfile). The backend validates
 * CIN (8 digits + 1 letter), gender enum, and 2-letter state. Phone is edited
 * separately through the SMS re-verification flow (PhoneVerificationModal);
 * email is the account identity and is read-only.
 */
function EditProfileModal({
  visible,
  profile,
  onClose,
  onSaved,
}: EditProfileModalProps): React.JSX.Element {
  const [fullName, setFullName] = useState('');
  const [preferredName, setPreferredName] = useState('');
  const [dob, setDob] = useState(''); // MM/DD/YYYY
  const [sex, setSex] = useState('');
  const [addr1, setAddr1] = useState('');
  const [addr2, setAddr2] = useState('');
  const [city, setCity] = useState('');
  const [stateCode, setStateCode] = useState('');
  const [zip, setZip] = useState('');
  const [language, setLanguage] = useState('');
  const [insurance, setInsurance] = useState('');
  const [cin, setCin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showSexPicker, setShowSexPicker] = useState(false);
  const [showCarrierPicker, setShowCarrierPicker] = useState(false);

  const updateProfile = useUpdateMemberProfile();

  // Hydrate the form from the current profile whenever the modal opens.
  React.useEffect(() => {
    if (visible && profile) {
      setFullName(profile.name ?? '');
      setPreferredName(profile.preferredName ?? '');
      setDob(isoToMmddyyyy(profile.dateOfBirth));
      setSex(profile.gender ?? '');
      setAddr1(profile.addressLine1 ?? '');
      setAddr2(profile.addressLine2 ?? '');
      setCity(profile.city ?? '');
      setStateCode(profile.state ?? '');
      setZip(profile.zipCode ?? '');
      setLanguage(profile.primaryLanguage ?? '');
      setInsurance(profile.insuranceCompany ?? profile.insuranceProvider ?? '');
      setCin(profile.mediCalId ?? '');
      setError(null);
      setShowSexPicker(false);
      setShowCarrierPicker(false);
    }
  }, [visible, profile]);

  /**
   * Live CIN format error — re-computes whenever `cin` or `insurance` changes.
   * Null when CIN is empty (optional field) or when it matches the carrier format.
   * Non-null string is an error message that blocks the Save button.
   *
   * Carrier-aware: switching the Insurance dropdown re-validates the current
   * CIN against the new carrier's format, so a mismatch caused by switching
   * insurance also triggers the error + block immediately.
   */
  const cinFormatError = useMemo((): string | null => {
    if (!cin.trim()) return null; // CIN field is empty — no error (optional on edit)
    const result = validateCinForCarrier(cin, insurance);
    if (result.valid) return null;
    return `${expectedFormatMessage(insurance)} Also accepted: commercial/Medicare IDs.`;
  }, [cin, insurance]);

  const handleSubmit = useCallback(async () => {
    setError(null);

    // Build a partial payload of ONLY the fields the member touched / has data
    // for. snake_case conversion + backend validation happen server-side.
    const payload: Record<string, unknown> = {};

    if (fullName.trim()) payload.name = fullName.trim();
    payload.preferredName = preferredName.trim() || null;

    if (dob.trim()) {
      const iso = mmddyyyyToIso(dob);
      if (!iso) {
        setError('Date of birth must be MM/DD/YYYY (e.g. 05/21/1990).');
        return;
      }
      payload.dateOfBirth = iso;
    }

    if (sex) payload.gender = sex;
    payload.addressLine1 = addr1.trim() || null;
    payload.addressLine2 = addr2.trim() || null;
    payload.city = city.trim() || null;
    if (stateCode.trim() && stateCode.trim().length !== 2) {
      setError('State must be a 2-letter code (e.g. CA).');
      return;
    }
    payload.state = stateCode.trim().toUpperCase() || null;
    payload.zipCode = zip.trim() || null;
    if (language.trim()) payload.primaryLanguage = language.trim();
    if (insurance.trim()) payload.insuranceCompany = insurance.trim();

    if (cin.trim()) {
      // Profile edit: BLOCK save when the CIN doesn't match the selected
      // insurance carrier's expected format. cinFormatError is the live
      // validation computed from the current cin + insurance values.
      if (cinFormatError) {
        setError(cinFormatError);
        return; // BLOCK the save — do not call the API until CIN is corrected
      }
      const result = validateCinForCarrier(cin, insurance);
      payload.mediCalId = result.normalized;
    }

    try {
      await updateProfile.mutateAsync(payload as Parameters<typeof updateProfile.mutateAsync>[0]);
      onSaved();
      onClose();
    } catch (err: unknown) {
      const detail =
        err != null && typeof err === 'object' && 'detail' in err &&
        typeof (err as { detail: unknown }).detail === 'string'
          ? (err as { detail: string }).detail
          : 'Could not save. Please check your entries and try again.';
      setError(detail);
    }
  }, [
    fullName, preferredName, dob, sex, addr1, addr2, city, stateCode, zip,
    language, insurance, cin, cinFormatError, updateProfile, onSaved, onClose,
  ]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      accessibilityViewIsModal
    >
      <Pressable style={cinModalStyles.backdrop} onPress={onClose} accessibilityLabel="Close modal" />
      <View style={cinModalStyles.sheet}>
        <View style={cinModalStyles.sheetHeader}>
          <Text style={cinModalStyles.sheetTitle}>Edit Profile</Text>
          <TouchableOpacity
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <X size={18} color={tokens.textSecondary} />
          </TouchableOpacity>
        </View>

        <ScrollView style={editModalStyles.scroll} keyboardShouldPersistTaps="handled">
          <Text style={cinModalStyles.fieldLabel}>Full Name</Text>
          <TextInput
            style={editModalStyles.input}
            value={fullName}
            onChangeText={setFullName}
            placeholder="Full name"
            placeholderTextColor={tokens.textMuted}
            accessibilityLabel="Full name"
          />

          <Text style={[cinModalStyles.fieldLabel, editModalStyles.spaced]}>Preferred Name</Text>
          <TextInput
            style={editModalStyles.input}
            value={preferredName}
            onChangeText={setPreferredName}
            placeholder="What you'd like to be called"
            placeholderTextColor={tokens.textMuted}
            accessibilityLabel="Preferred name"
          />

          <Text style={[cinModalStyles.fieldLabel, editModalStyles.spaced]}>Date of Birth</Text>
          <TextInput
            style={editModalStyles.input}
            value={dob}
            onChangeText={setDob}
            placeholder="MM/DD/YYYY"
            placeholderTextColor={tokens.textMuted}
            autoCorrect={false}
            maxLength={10}
            accessibilityLabel="Date of birth"
          />

          <Text style={[cinModalStyles.fieldLabel, editModalStyles.spaced]}>Sex</Text>
          <TouchableOpacity
            style={cinModalStyles.selectorBtn}
            onPress={() => { setShowSexPicker((p) => !p); setShowCarrierPicker(false); }}
            accessibilityRole="button"
            accessibilityLabel={`Sex: ${sex || 'Select'}`}
          >
            <Text style={[cinModalStyles.selectorText, !sex && cinModalStyles.selectorPlaceholder]}>
              {sex || 'Select…'}
            </Text>
            <Text style={cinModalStyles.selectorChevron}>{showSexPicker ? '▲' : '▼'}</Text>
          </TouchableOpacity>
          {showSexPicker && (
            <View style={cinModalStyles.pickerList}>
              {SEX_OPTIONS.map((opt) => {
                const isSelected = opt === sex;
                return (
                  <TouchableOpacity
                    key={opt}
                    style={[cinModalStyles.pickerItem, isSelected && cinModalStyles.pickerItemSelected]}
                    onPress={() => { setSex(opt); setShowSexPicker(false); }}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: isSelected }}
                    accessibilityLabel={opt}
                  >
                    <Text style={[cinModalStyles.pickerItemText, isSelected && cinModalStyles.pickerItemTextSelected]}>{opt}</Text>
                    {isSelected && <Check size={14} color={tokens.primary} />}
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          <Text style={[cinModalStyles.fieldLabel, editModalStyles.spaced]}>Address Line 1</Text>
          <TextInput
            style={editModalStyles.input}
            value={addr1}
            onChangeText={setAddr1}
            placeholder="Street address"
            placeholderTextColor={tokens.textMuted}
            accessibilityLabel="Address line 1"
          />
          <Text style={[cinModalStyles.fieldLabel, editModalStyles.spaced]}>Address Line 2</Text>
          <TextInput
            style={editModalStyles.input}
            value={addr2}
            onChangeText={setAddr2}
            placeholder="Apt, unit, etc. (optional)"
            placeholderTextColor={tokens.textMuted}
            accessibilityLabel="Address line 2"
          />
          <View style={editModalStyles.row}>
            <View style={editModalStyles.rowItemGrow}>
              <Text style={[cinModalStyles.fieldLabel, editModalStyles.spaced]}>City</Text>
              <TextInput
                style={editModalStyles.input}
                value={city}
                onChangeText={setCity}
                placeholder="City"
                placeholderTextColor={tokens.textMuted}
                accessibilityLabel="City"
              />
            </View>
            <View style={editModalStyles.rowItemState}>
              <Text style={[cinModalStyles.fieldLabel, editModalStyles.spaced]}>State</Text>
              <TextInput
                style={editModalStyles.input}
                value={stateCode}
                onChangeText={(t) => setStateCode(t.toUpperCase())}
                placeholder="CA"
                placeholderTextColor={tokens.textMuted}
                autoCapitalize="characters"
                maxLength={2}
                accessibilityLabel="State"
              />
            </View>
            <View style={editModalStyles.rowItemZip}>
              <Text style={[cinModalStyles.fieldLabel, editModalStyles.spaced]}>ZIP</Text>
              <TextInput
                style={editModalStyles.input}
                value={zip}
                onChangeText={setZip}
                placeholder="90001"
                placeholderTextColor={tokens.textMuted}
                keyboardType="number-pad"
                maxLength={10}
                accessibilityLabel="ZIP code"
              />
            </View>
          </View>

          <Text style={[cinModalStyles.fieldLabel, editModalStyles.spaced]}>Primary Language</Text>
          <TextInput
            style={editModalStyles.input}
            value={language}
            onChangeText={setLanguage}
            placeholder="English"
            placeholderTextColor={tokens.textMuted}
            accessibilityLabel="Primary language"
          />

          <Text style={[cinModalStyles.fieldLabel, editModalStyles.spaced]}>Insurance Carrier</Text>
          <TouchableOpacity
            style={cinModalStyles.selectorBtn}
            onPress={() => { setShowCarrierPicker((p) => !p); setShowSexPicker(false); }}
            accessibilityRole="button"
            accessibilityLabel={`Insurance carrier: ${insurance || 'Select carrier'}`}
          >
            <Text style={[cinModalStyles.selectorText, !insurance && cinModalStyles.selectorPlaceholder]} numberOfLines={1}>
              {insurance || 'Select carrier…'}
            </Text>
            <Text style={cinModalStyles.selectorChevron}>{showCarrierPicker ? '▲' : '▼'}</Text>
          </TouchableOpacity>
          {showCarrierPicker && (
            <View style={cinModalStyles.pickerList}>
              {INSURANCE_OPTIONS.map((carrier) => {
                const isSelected = carrier === insurance;
                return (
                  <TouchableOpacity
                    key={carrier}
                    style={[cinModalStyles.pickerItem, isSelected && cinModalStyles.pickerItemSelected]}
                    onPress={() => { setInsurance(carrier); setShowCarrierPicker(false); }}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: isSelected }}
                    accessibilityLabel={carrier}
                  >
                    <Text style={[cinModalStyles.pickerItemText, isSelected && cinModalStyles.pickerItemTextSelected]}>{carrier}</Text>
                    {isSelected && <Check size={14} color={tokens.primary} />}
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          <Text style={[cinModalStyles.fieldLabel, editModalStyles.spaced]}>Medi-Cal CIN</Text>
          <TextInput
            style={cinModalStyles.cinInput}
            value={cin}
            onChangeText={(t) => setCin(t.toUpperCase())}
            placeholder="e.g. 91234567A2"
            placeholderTextColor={tokens.textMuted}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={14}
            accessibilityLabel="Medi-Cal CIN"
            accessibilityHint="Medi-Cal CIN (91234567A2), 14-char BIC, or commercial/Medicare ID"
          />
          {/* Live CIN format error — shown as soon as the format looks wrong.
              Blocks Save until the user corrects the CIN or insurance. */}
          {cinFormatError !== null ? (
            <Text style={cinModalStyles.errorText} accessibilityRole="alert">
              {cinFormatError}
            </Text>
          ) : (
            <Text style={cinModalStyles.cinHint}>
              Medi-Cal CIN: 9 + 7 digits + letter + check digit (e.g. 91234567A2)
            </Text>
          )}

          {/* General form error (DOB format, state format, etc.) */}
          {error !== null && cinFormatError === null && (
            <Text style={cinModalStyles.errorText} accessibilityRole="alert">{error}</Text>
          )}
        </ScrollView>

        <View style={cinModalStyles.actions}>
          <TouchableOpacity
            style={cinModalStyles.cancelBtn}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
          >
            <Text style={cinModalStyles.cancelBtnText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              cinModalStyles.saveBtn,
              (updateProfile.isPending || cinFormatError !== null) && cinModalStyles.saveBtnDisabled,
            ]}
            onPress={() => void handleSubmit()}
            disabled={updateProfile.isPending || cinFormatError !== null}
            accessibilityRole="button"
            accessibilityLabel="Save profile"
          >
            {updateProfile.isPending ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Text style={cinModalStyles.saveBtnText}>Save</Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const editModalStyles = StyleSheet.create({
  scroll: {
    maxHeight: 420,
  } as ViewStyle,
  input: {
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    fontSize: 14,
    color: tokens.textPrimary,
    backgroundColor: tokens.cardBg,
  } as TextStyle,
  spaced: {
    marginTop: spacing.md,
  } as TextStyle,
  row: {
    flexDirection: 'row',
    gap: spacing.sm,
  } as ViewStyle,
  rowItemGrow: {
    flex: 1,
  } as ViewStyle,
  rowItemState: {
    width: 64,
  } as ViewStyle,
  rowItemZip: {
    width: 96,
  } as ViewStyle,
});

const cinModalStyles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
  } as ViewStyle,
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: tokens.cardBg,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: spacing.xl,
    paddingBottom: Platform.OS === 'ios' ? 36 : spacing.xl,
    ...(shadows.card as object),
  } as ViewStyle,
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.xl,
  } as ViewStyle,
  sheetTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: tokens.textPrimary,
  } as TextStyle,
  fieldLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: tokens.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: spacing.xs,
  } as TextStyle,
  selectorBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: tokens.cardBg,
  } as ViewStyle,
  selectorText: {
    flex: 1,
    fontSize: 14,
    color: tokens.textPrimary,
    fontWeight: '400',
  } as TextStyle,
  selectorPlaceholder: {
    color: tokens.textMuted,
  } as TextStyle,
  selectorChevron: {
    fontSize: 10,
    color: tokens.textSecondary,
    marginLeft: spacing.sm,
  } as TextStyle,
  pickerList: {
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    borderRadius: radius.md,
    marginTop: spacing.xs,
    overflow: 'hidden',
    backgroundColor: tokens.cardBg,
  } as ViewStyle,
  pickerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: tokens.cardBorder,
  } as ViewStyle,
  pickerItemSelected: {
    backgroundColor: `${tokens.primary}10`,
  } as ViewStyle,
  pickerItemText: {
    flex: 1,
    fontSize: 13,
    color: tokens.textPrimary,
  } as TextStyle,
  pickerItemTextSelected: {
    fontWeight: '600',
    color: tokens.primary,
  } as TextStyle,
  cinInput: {
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    fontSize: 15,
    fontWeight: '500',
    color: tokens.textPrimary,
    backgroundColor: tokens.cardBg,
    letterSpacing: 2,
  } as TextStyle,
  cinInputError: {
    borderColor: tokens.red700,
  } as ViewStyle,
  cinHint: {
    fontSize: 11,
    color: tokens.textMuted,
    marginTop: spacing.xs,
    marginBottom: spacing.xs,
  } as TextStyle,
  errorText: {
    fontSize: 12,
    color: tokens.red700,
    marginTop: spacing.xs,
    fontWeight: '500',
  } as TextStyle,
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.xl,
  } as ViewStyle,
  cancelBtn: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    alignItems: 'center',
  } as ViewStyle,
  cancelBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: tokens.textSecondary,
  } as TextStyle,
  saveBtn: {
    flex: 2,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    backgroundColor: tokens.primary,
    alignItems: 'center',
  } as ViewStyle,
  saveBtnDisabled: {
    opacity: 0.6,
  } as ViewStyle,
  saveBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#FFFFFF',
  } as TextStyle,
});

// ─── RefuseServicesConfirmModal ────────────────────────────────────────────────

interface RefuseServicesConfirmModalProps {
  visible: boolean;
  isPending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Shown when the member attempts to flip consent to `refuse_services`.
 * Requires explicit "Yes, refuse" confirmation because the consequence is
 * blocking ALL CHW↔member communication until consent is restored.
 */
function RefuseServicesConfirmModal({
  visible,
  isPending,
  onConfirm,
  onCancel,
}: RefuseServicesConfirmModalProps): React.JSX.Element {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
      accessibilityViewIsModal
    >
      <View style={refuseModalStyles.overlay}>
        <View style={refuseModalStyles.dialog}>
          <Text style={refuseModalStyles.title}>Refuse CHW Services?</Text>
          <Text style={refuseModalStyles.body}>
            If you refuse, you will be unable to call or message your CHW until you restore consent. Are you sure?
          </Text>
          <View style={refuseModalStyles.actions}>
            <TouchableOpacity
              style={refuseModalStyles.cancelBtn}
              onPress={onCancel}
              disabled={isPending}
              accessibilityRole="button"
              accessibilityLabel="Keep consent — do not refuse"
            >
              <Text style={refuseModalStyles.cancelBtnText}>Keep Consent</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[refuseModalStyles.refuseBtn, isPending && refuseModalStyles.btnDisabled]}
              onPress={onConfirm}
              disabled={isPending}
              accessibilityRole="button"
              accessibilityLabel="Confirm: refuse services"
            >
              {isPending ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Text style={refuseModalStyles.refuseBtnText}>Yes, Refuse</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const refuseModalStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
  } as ViewStyle,
  dialog: {
    backgroundColor: tokens.cardBg,
    borderRadius: radius.xl,
    padding: spacing.xl,
    width: '100%',
    maxWidth: 400,
    ...(shadows.card as object),
  } as ViewStyle,
  title: {
    fontSize: 17,
    fontWeight: '700',
    color: tokens.textPrimary,
    marginBottom: spacing.md,
  } as TextStyle,
  body: {
    fontSize: 14,
    fontWeight: '400',
    color: tokens.textSecondary,
    lineHeight: 21,
    marginBottom: spacing.xl,
  } as TextStyle,
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
  } as ViewStyle,
  cancelBtn: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    alignItems: 'center',
  } as ViewStyle,
  cancelBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: tokens.textSecondary,
  } as TextStyle,
  refuseBtn: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    backgroundColor: tokens.red700,
    alignItems: 'center',
  } as ViewStyle,
  btnDisabled: {
    opacity: 0.6,
  } as ViewStyle,
  refuseBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#FFFFFF',
  } as TextStyle,
});

// ─── DemographicsCard ──────────────────────────────────────────────────────────

interface DemographicsCardProps {
  name: string;
  profile: ProfileDraft;
  insuranceProvider: string;
  isPhoneVerified: boolean;
  onEditInsuranceCin: () => void;
  /** Current profile picture URL (null = none). Passed from the parent query. */
  profilePictureUrl: string | null | undefined;
  /** Called after a successful upload or removal so the parent can sync state. */
  onPhotoChange: (newUrl: string | null) => void;
  /** Full member profile from the API — source for DOB, sex, address, CIN, etc. */
  apiProfile: MemberProfile | undefined;
}

/**
 * Left card: demographics display with a pencil-icon action that opens the full
 * Edit Profile modal. Shows every field a CHW can see on the member profile.
 * Profile photo is editable inline.
 */
function DemographicsCard({
  name,
  profile,
  insuranceProvider,
  isPhoneVerified,
  onEditInsuranceCin,
  profilePictureUrl,
  onPhotoChange,
  apiProfile,
}: DemographicsCardProps): React.JSX.Element {
  const initials = getInitials(name);

  const addressLabel = [
    apiProfile?.addressLine1,
    apiProfile?.addressLine2,
    [apiProfile?.city, apiProfile?.state].filter(Boolean).join(', '),
  ]
    .filter((part) => part && part.trim().length > 0)
    .join('\n');
  const insuranceLabel = apiProfile?.insuranceCompany || insuranceProvider || NOT_PROVIDED;

  return (
    <View style={demoCardStyles.card}>
      {/* Card header row */}
      <View style={demoCardStyles.headerRow}>
        <Text style={demoCardStyles.cardTitle}>Demographics</Text>
        <TouchableOpacity
          style={demoCardStyles.editBtn}
          onPress={onEditInsuranceCin}
          accessibilityRole="button"
          accessibilityLabel="Edit insurance and CIN"
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
        >
          <Edit2 size={14} color={tokens.primary} />
        </TouchableOpacity>
      </View>

      {/* Body: avatar + name on the left, fields listed on the right */}
      <View style={demoCardStyles.body}>
        <View style={demoCardStyles.leftCol}>
          <ProfilePictureEditor
            currentUrl={profilePictureUrl}
            role="member"
            size={64}
            initials={initials}
            initialsBackground={`${tokens.primary}18`}
            onChange={onPhotoChange}
          />
          <Text style={demoCardStyles.displayName} numberOfLines={2}>{name}</Text>
          <View style={demoCardStyles.memberBadge}>
            <Text style={demoCardStyles.memberBadgeText}>Member</Text>
          </View>
        </View>

        <View style={demoCardStyles.fields}>
          <DemoRow label="Preferred Name" value={apiProfile?.preferredName || NOT_PROVIDED} />
          <DemoRow label="Date of Birth" value={isoToMmddyyyy(apiProfile?.dateOfBirth) || NOT_PROVIDED} />
          <DemoRow label="Sex" value={apiProfile?.gender || NOT_PROVIDED} />
          <DemoRow label="Address" value={addressLabel || NOT_PROVIDED} />
          <DemoRow label="ZIP" value={profile.zipCode || NOT_PROVIDED} />
          <DemoRow label="Primary Language" value={profile.primaryLanguage || NOT_PROVIDED} />
          <DemoRow
            label={isPhoneVerified ? 'Phone (verified)' : 'Phone'}
            value={profile.phone || NOT_PROVIDED}
          />
          <DemoRow label="Email" value={profile.email || NOT_PROVIDED} />
          <View style={demoCardStyles.divider} />
          <DemoRow label="Primary Need" value={verticalLabels[profile.primaryNeed] ?? profile.primaryNeed} />
          <DemoRow label="Insurance" value={insuranceLabel} />
          <DemoRow label="Medi-Cal CIN" value={apiProfile?.mediCalId || NOT_PROVIDED} />
        </View>
      </View>
    </View>
  );
}

interface DemoRowProps {
  label: string;
  value: string;
}

function DemoRow({ label, value }: DemoRowProps): React.JSX.Element {
  const isPlaceholder = value === NOT_PROVIDED;
  return (
    <View style={demoCardStyles.fieldRow}>
      <Text style={demoCardStyles.fieldLabel}>{label}</Text>
      <Text
        style={[demoCardStyles.fieldValue, isPlaceholder && demoCardStyles.fieldValueMuted]}
        numberOfLines={2}
      >
        {value}
      </Text>
    </View>
  );
}

const demoCardStyles = StyleSheet.create({
  card: {
    backgroundColor: tokens.cardBg,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    borderRadius: radius.xl,
    padding: spacing.lg,
    flex: 1,
    ...(shadows.card as object),
  } as ViewStyle,
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  } as ViewStyle,
  cardTitle: {
    fontSize: 11,
    fontWeight: '600',
    color: tokens.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  } as TextStyle,
  editBtn: {
    padding: spacing.xs,
    borderRadius: radius.sm,
    backgroundColor: `${tokens.primary}10`,
  } as ViewStyle,
  body: {
    flexDirection: 'row',
    gap: spacing.lg,
    alignItems: 'flex-start',
  } as ViewStyle,
  leftCol: {
    width: 120,
    alignItems: 'center',
    gap: spacing.xs,
  } as ViewStyle,
  displayName: {
    fontSize: 14,
    fontWeight: '700',
    color: tokens.textPrimary,
    textAlign: 'center',
  } as TextStyle,
  memberBadge: {
    backgroundColor: `${tokens.emerald100}`,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
  } as ViewStyle,
  memberBadgeText: {
    fontSize: 10,
    fontWeight: '600',
    color: tokens.emerald700,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  } as TextStyle,
  fields: {
    flex: 1,
  } as ViewStyle,
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingVertical: 3,
  } as ViewStyle,
  fieldLabel: {
    width: 116,
    fontSize: 12,
    fontWeight: '400',
    color: tokens.textSecondary,
  } as TextStyle,
  fieldValue: {
    flex: 1,
    fontSize: 13,
    fontWeight: '700',
    color: tokens.textPrimary,
  } as TextStyle,
  fieldValueMuted: {
    fontWeight: '400',
    color: tokens.textMuted,
    fontStyle: 'italic',
  } as TextStyle,
  divider: {
    height: 1,
    backgroundColor: tokens.cardBorder,
    marginVertical: 6,
  } as ViewStyle,
});

// ─── ServicesConsentCard ───────────────────────────────────────────────────────

interface ServicesConsentCardProps {
  consentValue: ServicesConsentValue | null | undefined;
  isLoading: boolean;
  isPending: boolean;
  onConsentToggle: (requestedValue: ServicesConsentValue) => void;
}

/**
 * Center card: verbatim disclaimer copy above a two-button Yes/No consent toggle.
 *
 * - Flipping to `refuse_services` is handled by the parent (which shows the
 *   confirm modal) — this component only surfaces the intent via onConsentToggle.
 * - Flipping back to `consent_to_services` calls onConsentToggle immediately
 *   without a confirm modal (per spec).
 * - While consent query is loading, the toggle renders in a neutral state.
 */
function ServicesConsentCard({
  consentValue,
  isLoading,
  isPending,
  onConsentToggle,
}: ServicesConsentCardProps): React.JSX.Element {
  const isConsented = consentValue !== 'refuse_services';

  return (
    <View style={consentCardStyles.card}>
      <Text style={consentCardStyles.cardTitle}>Services Consent</Text>

      {/* Verbatim disclaimer — do NOT rephrase */}
      <Text style={consentCardStyles.disclaimer} accessibilityRole="text">
        {SERVICES_CONSENT_DISCLAIMER}
      </Text>

      {isLoading ? (
        <View style={consentCardStyles.loadingRow}>
          <ActivityIndicator size="small" color={tokens.primary} />
          <Text style={consentCardStyles.loadingText}>Loading…</Text>
        </View>
      ) : (
        <>
          {/* Two-position consent selector */}
          <View style={consentCardStyles.toggleRow}>
            {/* "Yes, I consent" button */}
            <TouchableOpacity
              style={[
                consentCardStyles.consentBtn,
                isConsented && consentCardStyles.consentBtnActive,
                isPending && consentCardStyles.consentBtnDisabled,
              ]}
              onPress={() => {
                if (!isConsented) {
                  onConsentToggle('consent_to_services');
                }
              }}
              disabled={isPending || isConsented}
              accessibilityRole="radio"
              accessibilityState={{ selected: isConsented, disabled: isPending || isConsented }}
              accessibilityLabel="Yes, I consent to services"
            >
              {isPending && isConsented ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <>
                  {isConsented && <Check size={13} color="#FFFFFF" />}
                  <Text style={[consentCardStyles.consentBtnText, isConsented && consentCardStyles.consentBtnTextActive]}>
                    Yes, I consent
                  </Text>
                </>
              )}
            </TouchableOpacity>

            {/* "No, I refuse" button */}
            <TouchableOpacity
              style={[
                consentCardStyles.refuseBtn,
                !isConsented && consentCardStyles.refuseBtnActive,
                isPending && consentCardStyles.consentBtnDisabled,
              ]}
              onPress={() => {
                if (isConsented) {
                  onConsentToggle('refuse_services');
                }
              }}
              disabled={isPending || !isConsented}
              accessibilityRole="radio"
              accessibilityState={{ selected: !isConsented, disabled: isPending || !isConsented }}
              accessibilityLabel="No, I refuse services"
            >
              {isPending && !isConsented ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Text style={[consentCardStyles.refuseBtnText, !isConsented && consentCardStyles.refuseBtnTextActive]}>
                  No, I refuse
                </Text>
              )}
            </TouchableOpacity>
          </View>

          {/* Status indicator */}
          <View style={consentCardStyles.statusRow}>
            <View
              style={[
                consentCardStyles.statusDot,
                { backgroundColor: isConsented ? tokens.emerald500 : tokens.red700 },
              ]}
            />
            <Text style={consentCardStyles.statusText}>
              {isConsented ? 'Services active' : 'Services refused — call and messaging are blocked'}
            </Text>
          </View>
        </>
      )}
    </View>
  );
}

const consentCardStyles = StyleSheet.create({
  card: {
    backgroundColor: tokens.cardBg,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    borderRadius: radius.xl,
    padding: spacing.lg,
    flex: 1,
    ...(shadows.card as object),
  } as ViewStyle,
  cardTitle: {
    fontSize: 11,
    fontWeight: '600',
    color: tokens.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: spacing.md,
  } as TextStyle,
  disclaimer: {
    fontSize: 13,
    fontWeight: '400',
    color: tokens.textPrimary,
    lineHeight: 20,
    marginBottom: spacing.xl,
  } as TextStyle,
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
  } as ViewStyle,
  loadingText: {
    fontSize: 13,
    color: tokens.textSecondary,
  } as TextStyle,
  toggleRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.md,
  } as ViewStyle,
  consentBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    backgroundColor: tokens.pageBg,
  } as ViewStyle,
  consentBtnActive: {
    backgroundColor: tokens.primary,
    borderColor: tokens.primary,
  } as ViewStyle,
  consentBtnDisabled: {
    opacity: 0.5,
  } as ViewStyle,
  consentBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: tokens.textSecondary,
  } as TextStyle,
  consentBtnTextActive: {
    color: '#FFFFFF',
  } as TextStyle,
  refuseBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    backgroundColor: tokens.pageBg,
  } as ViewStyle,
  refuseBtnActive: {
    backgroundColor: tokens.red700,
    borderColor: tokens.red700,
  } as ViewStyle,
  refuseBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: tokens.textSecondary,
  } as TextStyle,
  refuseBtnTextActive: {
    color: '#FFFFFF',
  } as TextStyle,
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.xs,
  } as ViewStyle,
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    flexShrink: 0,
  } as ViewStyle,
  statusText: {
    fontSize: 11,
    fontWeight: '400',
    color: tokens.textSecondary,
    flex: 1,
    flexWrap: 'wrap',
  } as TextStyle,
});

// ─── JourneysRewardsCard ───────────────────────────────────────────────────────

interface JourneysRewardsCardProps {
  journeys: MemberJourneyResponse[];
  journeysLoading: boolean;
  rewardsBalance: number;
  recentTransactions: RewardTransaction[];
}

/**
 * Right card: Active Journeys list + Rewards balance + recent point activity preview.
 */
function JourneysRewardsCard({
  journeys,
  journeysLoading,
  rewardsBalance,
  recentTransactions,
}: JourneysRewardsCardProps): React.JSX.Element {
  const activeJourneys = useMemo(
    () => journeys.filter((j) => j.status !== 'completed' && j.status !== 'abandoned'),
    [journeys],
  );

  return (
    <View style={journeyCardStyles.card}>
      {/* Rewards balance tile */}
      <View style={journeyCardStyles.balanceTile}>
        <Gift size={16} color={tokens.amber700} />
        <View style={journeyCardStyles.balanceText}>
          <Text style={journeyCardStyles.balanceLabel}>Rewards</Text>
          <Text style={journeyCardStyles.balanceValue}>{rewardsBalance} pts</Text>
        </View>
      </View>

      <View style={journeyCardStyles.divider} />

      {/* Active journeys section */}
      <Text style={journeyCardStyles.sectionLabel}>Active Journeys</Text>

      {journeysLoading ? (
        <ActivityIndicator size="small" color={tokens.primary} style={{ marginVertical: spacing.md }} />
      ) : activeJourneys.length === 0 ? (
        <Text style={journeyCardStyles.emptyText}>No active journeys</Text>
      ) : (
        activeJourneys.slice(0, 3).map((journey) => (
          <View key={journey.id} style={journeyCardStyles.journeyRow}>
            <View style={journeyCardStyles.journeyDot} />
            <View style={journeyCardStyles.journeyInfo}>
              <Text style={journeyCardStyles.journeyName} numberOfLines={1}>
                {journey.template?.name ?? 'Journey'}
              </Text>
              {journey.currentStep !== null && (
                <Text style={journeyCardStyles.journeyStep} numberOfLines={1}>
                  {journey.currentStep.stepName}
                </Text>
              )}
            </View>
            {journey.progressPercent !== undefined && (
              <Text style={journeyCardStyles.journeyPct}>{journey.progressPercent}%</Text>
            )}
          </View>
        ))
      )}

      {activeJourneys.length > 3 && (
        <Text style={journeyCardStyles.moreText}>+{activeJourneys.length - 3} more</Text>
      )}

      <View style={journeyCardStyles.divider} />

      {/* Recent points activity */}
      <Text style={journeyCardStyles.sectionLabel}>Recent Points</Text>
      {recentTransactions.length === 0 ? (
        <Text style={journeyCardStyles.emptyText}>No recent activity</Text>
      ) : (
        recentTransactions.slice(0, 3).map((txn) => {
          const isPositive = txn.points > 0;
          return (
            <View key={txn.id} style={journeyCardStyles.pointsRow}>
              <View style={journeyCardStyles.pointsIconWrap}>
                <RewardActionIcon action={txn.action} size={14} />
              </View>
              <Text style={journeyCardStyles.pointsAction} numberOfLines={1}>
                {txn.action.replace(/_/g, ' ')}
              </Text>
              <Text style={[journeyCardStyles.pointsDelta, { color: isPositive ? tokens.emerald700 : tokens.red700 }]}>
                {isPositive ? '+' : ''}{txn.points}
              </Text>
            </View>
          );
        })
      )}
    </View>
  );
}

const journeyCardStyles = StyleSheet.create({
  card: {
    backgroundColor: tokens.cardBg,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    borderRadius: radius.xl,
    padding: spacing.lg,
    flex: 1,
    ...(shadows.card as object),
  } as ViewStyle,
  balanceTile: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: tokens.amber100,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.md,
  } as ViewStyle,
  balanceText: {
    flex: 1,
  } as ViewStyle,
  balanceLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: tokens.amber700,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  } as TextStyle,
  balanceValue: {
    fontSize: 16,
    fontWeight: '700',
    color: tokens.textPrimary,
  } as TextStyle,
  divider: {
    height: 1,
    backgroundColor: tokens.cardBorder,
    marginVertical: spacing.md,
  } as ViewStyle,
  sectionLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: tokens.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: spacing.sm,
  } as TextStyle,
  journeyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 5,
  } as ViewStyle,
  journeyDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: tokens.primary,
    flexShrink: 0,
  } as ViewStyle,
  journeyInfo: {
    flex: 1,
  } as ViewStyle,
  journeyName: {
    fontSize: 12,
    fontWeight: '600',
    color: tokens.textPrimary,
  } as TextStyle,
  journeyStep: {
    fontSize: 11,
    fontWeight: '400',
    color: tokens.textSecondary,
  } as TextStyle,
  journeyPct: {
    fontSize: 11,
    fontWeight: '600',
    color: tokens.primary,
  } as TextStyle,
  moreText: {
    fontSize: 11,
    color: tokens.textMuted,
    marginTop: spacing.xs,
  } as TextStyle,
  emptyText: {
    fontSize: 12,
    color: tokens.textMuted,
    fontStyle: 'italic',
    marginBottom: spacing.xs,
  } as TextStyle,
  pointsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
  } as ViewStyle,
  pointsIconWrap: {
    width: 20,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,
  pointsAction: {
    flex: 1,
    fontSize: 12,
    fontWeight: '400',
    color: tokens.textPrimary,
    textTransform: 'capitalize',
  } as TextStyle,
  pointsDelta: {
    fontSize: 12,
    fontWeight: '700',
    marginLeft: spacing.sm,
  } as TextStyle,
});

// ─── Legacy sub-components (retained for below-fold sections) ─────────────────

interface InfoRowProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  placeholder?: boolean;
}

function InfoRow({ icon, label, value, placeholder = false }: InfoRowProps): React.JSX.Element {
  return (
    <View style={infoRowStyles.container}>
      <View style={infoRowStyles.iconBox}>{icon}</View>
      <View style={infoRowStyles.textBox}>
        <Text style={infoRowStyles.label}>{label}</Text>
        <Text style={[infoRowStyles.value, placeholder && infoRowStyles.valuePlaceholder]}>
          {value}
        </Text>
      </View>
    </View>
  );
}

const infoRowStyles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: '#E5DFD615',
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.sm,
  } as ViewStyle,
  iconBox: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    backgroundColor: `${tokens.primary}12`,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  textBox: { flex: 1 } as ViewStyle,
  label: {
    fontSize: 10,
    fontWeight: '600',
    color: tokens.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 1,
  } as TextStyle,
  value: {
    fontSize: 13,
    fontWeight: '400',
    color: tokens.textPrimary,
  } as TextStyle,
  valuePlaceholder: {
    color: tokens.textMuted,
    fontStyle: 'italic',
  } as TextStyle,
});

interface EditFieldProps {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'email-address' | 'phone-pad' | 'numeric';
}

function EditField({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType = 'default',
}: EditFieldProps): React.JSX.Element {
  return (
    <View style={editFieldStyles.container}>
      <Text style={editFieldStyles.label}>{label}</Text>
      <TextInput
        style={editFieldStyles.input}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder ?? label}
        placeholderTextColor={tokens.textMuted}
        keyboardType={keyboardType}
        accessibilityLabel={label}
      />
    </View>
  );
}

const editFieldStyles = StyleSheet.create({
  container: { marginBottom: spacing.md } as ViewStyle,
  label: {
    fontSize: 10,
    fontWeight: '600',
    color: tokens.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 6,
  } as TextStyle,
  input: {
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: tokens.cardBg,
    fontSize: 14,
    fontWeight: '400',
    color: tokens.textPrimary,
  } as TextStyle,
});

interface SectionCardProps {
  title: string;
  children: React.ReactNode;
}

function SectionCard({ title, children }: SectionCardProps): React.JSX.Element {
  return (
    <View style={sectionCardStyles.container}>
      <Text style={sectionCardStyles.title}>{title}</Text>
      <View style={sectionCardStyles.body}>{children}</View>
    </View>
  );
}

const sectionCardStyles = StyleSheet.create({
  container: {
    backgroundColor: tokens.cardBg,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    marginBottom: spacing.lg,
    overflow: 'hidden',
    ...(shadows.card as object),
  } as ViewStyle,
  title: {
    fontSize: 11,
    fontWeight: '600',
    color: tokens.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: 6,
  } as TextStyle,
  body: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  } as ViewStyle,
});

interface NotificationToggleRowProps {
  label: string;
  description: string;
  value: boolean;
  onChange: (v: boolean) => void;
}

function NotificationToggleRow({
  label,
  description,
  value,
  onChange,
}: NotificationToggleRowProps): React.JSX.Element {
  return (
    <View style={notifRowStyles.container}>
      <View style={notifRowStyles.textBox}>
        <Text style={notifRowStyles.label}>{label}</Text>
        <Text style={notifRowStyles.desc}>{description}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: tokens.cardBorder, true: `${tokens.primary}80` }}
        thumbColor={value ? tokens.primary : '#FFFFFF'}
        accessibilityLabel={label}
      />
    </View>
  );
}

const notifRowStyles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
    gap: spacing.md,
  } as ViewStyle,
  textBox: { flex: 1 } as ViewStyle,
  label: {
    fontSize: 14,
    fontWeight: '700',
    color: tokens.textPrimary,
  } as TextStyle,
  desc: {
    fontSize: 12,
    fontWeight: '400',
    color: tokens.textSecondary,
    marginTop: 1,
  } as TextStyle,
});

function RewardRow({ item }: { item: RewardTransaction }): React.JSX.Element {
  const isPositive = item.points > 0;
  return (
    <View style={rewardRowStyles.container}>
      <View style={rewardRowStyles.iconBox}>
        <RewardActionIcon action={item.action} size={15} />
      </View>
      <View style={rewardRowStyles.info}>
        <Text style={rewardRowStyles.description} numberOfLines={2}>
          {item.action.replace(/_/g, ' ')}
        </Text>
        <Text style={rewardRowStyles.date}>{formatRewardDate(item.createdAt)}</Text>
      </View>
      <Text style={[rewardRowStyles.points, { color: isPositive ? tokens.emerald700 : tokens.red700 }]}>
        {isPositive ? '+' : ''}{item.points} pts
      </Text>
    </View>
  );
}

const rewardRowStyles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  } as ViewStyle,
  iconBox: {
    width: 34,
    height: 34,
    borderRadius: radius.sm,
    backgroundColor: tokens.amber100,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  info: { flex: 1, gap: 2 } as ViewStyle,
  description: {
    fontSize: 13,
    fontWeight: '600',
    color: tokens.textPrimary,
    textTransform: 'capitalize',
  } as TextStyle,
  date: {
    fontSize: 11,
    fontWeight: '400',
    color: tokens.textSecondary,
  } as TextStyle,
  points: {
    fontSize: 13,
    fontWeight: '700',
  } as TextStyle,
});

interface RedemptionCardProps {
  item: RewardCatalogItem;
  onRedeem: (item: RewardCatalogItem) => void;
  balance: number;
}

function RedemptionCard({ item, onRedeem, balance }: RedemptionCardProps): React.JSX.Element {
  const canAfford = balance >= item.costPoints;
  return (
    <View style={redemptionCardStyles.card}>
      <Text style={redemptionCardStyles.emoji}>{item.imageEmoji}</Text>
      <View style={redemptionCardStyles.info}>
        <Text style={redemptionCardStyles.name}>{item.name}</Text>
        <Text style={redemptionCardStyles.description} numberOfLines={2}>
          {item.description}
        </Text>
        <Text style={redemptionCardStyles.cost}>{item.costPoints} pts</Text>
      </View>
      <TouchableOpacity
        style={[redemptionCardStyles.redeemBtn, !canAfford && redemptionCardStyles.redeemBtnDisabled]}
        onPress={() => onRedeem(item)}
        disabled={!canAfford}
        accessibilityRole="button"
        accessibilityLabel={`Redeem ${item.name} for ${item.costPoints} points`}
        accessibilityState={{ disabled: !canAfford }}
      >
        <Text style={[redemptionCardStyles.redeemBtnText, !canAfford && redemptionCardStyles.redeemBtnTextDisabled]}>
          Redeem
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const redemptionCardStyles = StyleSheet.create({
  card: {
    backgroundColor: tokens.cardBg,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    padding: spacing.lg,
    marginBottom: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    ...(shadows.card as object),
  } as ViewStyle,
  emoji: {
    fontSize: 26,
    width: 40,
    textAlign: 'center',
  } as TextStyle,
  info: { flex: 1, gap: 2 } as ViewStyle,
  name: {
    fontSize: 14,
    fontWeight: '700',
    color: tokens.textPrimary,
  } as TextStyle,
  description: {
    fontSize: 12,
    fontWeight: '400',
    color: tokens.textSecondary,
    lineHeight: 17,
  } as TextStyle,
  cost: {
    fontSize: 11,
    fontWeight: '600',
    color: tokens.amber700,
    marginTop: 2,
  } as TextStyle,
  redeemBtn: {
    backgroundColor: tokens.amber700,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
  } as ViewStyle,
  redeemBtnDisabled: {
    backgroundColor: tokens.cardBorder,
  } as ViewStyle,
  redeemBtnText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#FFFFFF',
  } as TextStyle,
  redeemBtnTextDisabled: {
    color: tokens.textSecondary,
  } as TextStyle,
});

// ─── MemberProfileScreen ──────────────────────────────────────────────────────

/**
 * Member-facing profile screen — T22 3-column redesign.
 *
 * Top card: [Demographics | Services Consent | Journeys + Rewards]
 * Below fold: CHW Preferences, Notifications, Rewards history, Redemptions, Account.
 */
export function MemberProfileScreen(): React.JSX.Element {
  const { userName, logout } = useAuth();

  const profileQuery = useMemberProfile();
  const rewardsQuery = useMemberRewards();
  const rewardsCatalogQuery = useRewardsCatalog();
  const consentQuery = useOwnServicesConsent();
  const updateConsent = useUpdateServicesConsent();
  const updateProfile = useUpdateMemberProfile();

  const apiProfile = profileQuery.data;
  const displayName = apiProfile?.name ?? userName ?? 'Member';

  // ── Name + profile state ──
  const [name, setName] = useState(displayName);
  const [rewardsBalance, setRewardsBalance] = useState<number | null>(null);
  const [isEditing, setIsEditing] = useState(false);

  React.useEffect(() => {
    if (apiProfile?.rewardsBalance !== undefined) {
      setRewardsBalance(apiProfile.rewardsBalance);
    }
  }, [apiProfile?.rewardsBalance]);

  const effectiveBalance = rewardsBalance ?? apiProfile?.rewardsBalance ?? 0;

  const fallbackProfile: ProfileSource = {
    zipCode: apiProfile?.zipCode ?? '',
    primaryLanguage: apiProfile?.primaryLanguage ?? 'English',
    primaryNeed: apiProfile?.primaryNeed ?? 'healthcare',
    insuranceProvider: apiProfile?.insuranceProvider,
    phone: apiProfile?.phone,
    email: apiProfile?.email,
  };

  const [draft, setDraft] = useState<ProfileDraft>(() =>
    buildDraft(displayName, fallbackProfile),
  );

  React.useEffect(() => {
    if (apiProfile) {
      setDraft(buildDraft(displayName, {
        zipCode: apiProfile.zipCode,
        primaryLanguage: apiProfile.primaryLanguage,
        primaryNeed: apiProfile.primaryNeed,
        insuranceProvider: apiProfile.insuranceProvider,
      }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiProfile?.id]);

  const committedDraft = buildDraft(name, fallbackProfile);

  // ── Insurance/CIN edit modal ──
  const [isInsuranceCinModalVisible, setIsInsuranceCinModalVisible] = useState(false);

  // ── Services consent state ──
  const [isRefuseModalVisible, setIsRefuseModalVisible] = useState(false);

  /**
   * Called when the member taps a consent button.
   * Restore (`consent_to_services`): fire immediately, no confirm.
   * Refuse (`refuse_services`): show the confirm modal first.
   */
  const handleConsentToggle = useCallback((requestedValue: ServicesConsentValue) => {
    if (requestedValue === 'refuse_services') {
      setIsRefuseModalVisible(true);
    } else {
      void updateConsent.mutateAsync('consent_to_services').catch((err: unknown) => {
        Alert.alert(
          'Could not update consent',
          err instanceof Error ? err.message : 'Please try again.',
        );
      });
    }
  }, [updateConsent]);

  const handleRefuseConfirm = useCallback(async () => {
    try {
      await updateConsent.mutateAsync('refuse_services');
      setIsRefuseModalVisible(false);
    } catch (err: unknown) {
      Alert.alert(
        'Could not update consent',
        err instanceof Error ? err.message : 'Please try again.',
      );
      setIsRefuseModalVisible(false);
    }
  }, [updateConsent]);

  // ── Journeys ──
  const journeysQuery = useMemberJourneys(apiProfile?.id ?? '');

  // ── CHW preferences ──
  const [notifications, setNotifications] = useState<NotificationSettings>({
    sessionReminders: true,
    goalUpdates: true,
    healthTips: false,
  });

  const [chwPreferences, setChwPreferences] = useState<CHWPreferences>({
    genderPreference: 'any',
    languagePreferences: [apiProfile?.primaryLanguage ?? 'English'],
    sessionModePreference: (apiProfile?.preferredMode as SessionModePreference | undefined) ?? 'in_person',
  });

  const handleEditPress = useCallback(() => {
    setDraft(buildDraft(name, fallbackProfile));
    setIsEditing(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, apiProfile]);

  const handleCancel = useCallback(() => setIsEditing(false), []);

  // Phone verification flow
  const [isPhoneVerificationVisible, setIsPhoneVerificationVisible] = useState(false);
  const [pendingPhone, setPendingPhone] = useState<string>('');

  const handleSave = useCallback(() => {
    const updatedName = [draft.firstName.trim(), draft.lastName.trim()]
      .filter(Boolean)
      .join(' ');
    if (updatedName) setName(updatedName);

    void updateProfile.mutateAsync({
      zipCode: draft.zipCode,
      primaryLanguage: draft.primaryLanguage,
      primaryNeed: draft.primaryNeed,
      insuranceProvider: draft.insuranceProvider,
      preferredMode: chwPreferences.sessionModePreference,
    }).catch(() => {
      // Silent on network error — local state already updated
    });

    setIsEditing(false);

    const trimmedPhone = draft.phone.trim();
    const currentPhone = apiProfile?.phone ?? '';
    if (trimmedPhone && trimmedPhone !== currentPhone) {
      setPendingPhone(trimmedPhone);
      setIsPhoneVerificationVisible(true);
    }
  }, [draft, chwPreferences.sessionModePreference, updateProfile, apiProfile?.phone]);

  const handleToggleLanguagePref = useCallback((lang: string) => {
    setChwPreferences((prev) => {
      const isSelected = prev.languagePreferences.includes(lang);
      return {
        ...prev,
        languagePreferences: isSelected
          ? prev.languagePreferences.filter((l) => l !== lang)
          : [...prev.languagePreferences, lang],
      };
    });
  }, []);

  const handleToggleNotification = useCallback(
    (key: keyof NotificationSettings) => (value: boolean) => {
      setNotifications((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const handleRedeem = useCallback(
    (item: RewardCatalogItem) => {
      if (effectiveBalance < item.costPoints) {
        Alert.alert(
          'Insufficient Points',
          `You need ${item.costPoints - effectiveBalance} more points to redeem ${item.name}.`,
        );
        return;
      }
      Alert.alert(
        `Redeem ${item.name}?`,
        `This will use ${item.costPoints} points.\n\nCurrent balance: ${effectiveBalance} pts`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Confirm',
            onPress: () => {
              setRewardsBalance((prev) => (prev ?? effectiveBalance) - item.costPoints);
              Alert.alert('Redemption Submitted', `Your ${item.name} request has been submitted.`);
            },
          },
        ],
      );
    },
    [effectiveBalance],
  );

  const handleSignOut = useCallback(async () => {
    const confirmed = await confirmAsync({
      title: 'Sign Out',
      message: 'Are you sure you want to sign out?',
      confirmText: 'Sign Out',
      destructive: true,
    });
    if (confirmed) await logout();
  }, [logout]);

  const [isDeleteModalVisible, setIsDeleteModalVisible] = useState(false);
  const [deleteErrorMessage, setDeleteErrorMessage] = useState<string | null>(null);
  const deleteAccount = useDeleteAccount();

  const handleDeleteAccountConfirm = useCallback(async (password: string) => {
    setDeleteErrorMessage(null);
    try {
      await deleteAccount.mutateAsync({ password });
      setIsDeleteModalVisible(false);
      await logout();
    } catch (err: unknown) {
      const message =
        err != null &&
        typeof err === 'object' &&
        'detail' in err &&
        typeof (err as { detail: unknown }).detail === 'string'
          ? (err as { detail: string }).detail
          : 'Something went wrong. Please try again.';
      setDeleteErrorMessage(message);
      throw err;
    }
  }, [deleteAccount, logout]);

  // ── Loading / error states ──

  if (profileQuery.isLoading) {
    return (
      <SafeAreaView style={screenStyles.safeArea} edges={['top']}>
        <StatusBar barStyle="dark-content" backgroundColor={tokens.pageBg} />
        <ScrollView contentContainerStyle={screenStyles.loadingContainer}>
          <PageWrap>
            <LoadingSkeleton variant="card" />
            <LoadingSkeleton variant="rows" rows={4} />
          </PageWrap>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (profileQuery.error) {
    return (
      <SafeAreaView style={screenStyles.safeArea} edges={['top']}>
        <StatusBar barStyle="dark-content" backgroundColor={tokens.pageBg} />
        <ErrorState
          message="Could not load your profile. Please try again."
          onRetry={() => void profileQuery.refetch()}
        />
      </SafeAreaView>
    );
  }

  // ── Render ──

  const activeRewardItems = (rewardsCatalogQuery.data ?? []).filter((i) => i.isActive);

  return (
    <SafeAreaView style={screenStyles.safeArea} edges={['top']}>
      <StatusBar barStyle="dark-content" backgroundColor={tokens.pageBg} />

      {/* ── Header ── */}
      <View style={screenStyles.header}>
        <Text style={screenStyles.headerTitle}>My Profile</Text>
        {isEditing ? (
          <View style={screenStyles.headerActions}>
            <TouchableOpacity
              style={screenStyles.headerCancelBtn}
              onPress={handleCancel}
              accessibilityRole="button"
              accessibilityLabel="Cancel editing"
            >
              <X size={15} color={tokens.textSecondary} />
              <Text style={screenStyles.headerCancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={screenStyles.headerSaveBtn}
              onPress={handleSave}
              accessibilityRole="button"
              accessibilityLabel="Save profile changes"
            >
              <Check size={15} color="#FFFFFF" />
              <Text style={screenStyles.headerSaveText}>Save</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity
            style={screenStyles.headerEditBtn}
            onPress={handleEditPress}
            accessibilityRole="button"
            accessibilityLabel="Edit profile"
          >
            <Edit2 size={14} color={tokens.primary} />
            <Text style={screenStyles.headerEditText}>Edit</Text>
          </TouchableOpacity>
        )}
      </View>

      <ScrollView
        style={screenStyles.scroll}
        contentContainerStyle={screenStyles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* PageWrap — 560px cap on web, full-width on native */}
        <PageWrap style={screenStyles.pageWrap}>

          {/* ── Green banner ── */}
          <View style={screenStyles.banner} />

          {/* ── 3-column top card ── */}
          <View style={screenStyles.topCardGrid}>
            {/* Left: Demographics */}
            <DemographicsCard
              name={name}
              profile={committedDraft}
              insuranceProvider={apiProfile?.insuranceProvider ?? ''}
              isPhoneVerified={!!apiProfile?.phoneVerifiedAt}
              onEditInsuranceCin={() => setIsInsuranceCinModalVisible(true)}
              profilePictureUrl={apiProfile?.profilePictureUrl}
              apiProfile={apiProfile}
              onPhotoChange={() => {
                // The useUploadProfilePicture hook invalidates the memberProfile
                // query on success, causing profileQuery to refetch automatically.
              }}
            />

            {/* Center: Services Consent */}
            <ServicesConsentCard
              consentValue={consentQuery.data?.value}
              isLoading={consentQuery.isLoading}
              isPending={updateConsent.isPending}
              onConsentToggle={handleConsentToggle}
            />

            {/* Right: Journeys + Rewards */}
            <JourneysRewardsCard
              journeys={journeysQuery.data ?? []}
              journeysLoading={journeysQuery.isLoading}
              rewardsBalance={effectiveBalance}
              recentTransactions={rewardsQuery.data ?? []}
            />
          </View>

          {/* ── Below-fold: profile edit form ── */}
          {isEditing ? (
            <View style={screenStyles.editCard}>
              <Text style={screenStyles.editCardTitle}>Profile Information</Text>
              <EditField
                label="ZIP Code"
                value={draft.zipCode}
                onChangeText={(text) => setDraft((prev) => ({ ...prev, zipCode: text }))}
                keyboardType="numeric"
                placeholder="90031"
              />
              <EditField
                label="Phone"
                value={draft.phone}
                onChangeText={(text) => setDraft((prev) => ({ ...prev, phone: text }))}
                keyboardType="phone-pad"
                placeholder="(310) 555-0000"
              />
              <EditField
                label="Email"
                value={draft.email}
                onChangeText={(text) => setDraft((prev) => ({ ...prev, email: text }))}
                keyboardType="email-address"
                placeholder="your@email.com"
              />
              <Text style={editFieldStyles.label}>Primary Language</Text>
              <View style={screenStyles.pillRow}>
                {ALL_LANGUAGES.map((lang) => {
                  const isSelected = draft.primaryLanguage === lang;
                  return (
                    <TouchableOpacity
                      key={lang}
                      style={[
                        screenStyles.pill,
                        isSelected
                          ? { backgroundColor: `${tokens.primary}20`, borderColor: tokens.primary }
                          : { backgroundColor: tokens.pageBg, borderColor: tokens.cardBorder },
                      ]}
                      onPress={() => setDraft((prev) => ({ ...prev, primaryLanguage: lang }))}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: isSelected }}
                      accessibilityLabel={lang}
                    >
                      <Text style={[screenStyles.pillText, { color: isSelected ? tokens.primary : tokens.textSecondary }]}>
                        {lang}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <View style={{ height: spacing.md }} />
              <Text style={editFieldStyles.label}>Primary Need</Text>
              <View style={screenStyles.pillRow}>
                {ALL_VERTICALS.map((v) => {
                  const isSelected = draft.primaryNeed === v;
                  return (
                    <TouchableOpacity
                      key={v}
                      style={[
                        screenStyles.pill,
                        isSelected
                          ? { backgroundColor: `${tokens.primary}20`, borderColor: tokens.primary }
                          : { backgroundColor: tokens.pageBg, borderColor: tokens.cardBorder },
                      ]}
                      onPress={() => setDraft((prev) => ({ ...prev, primaryNeed: v }))}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: isSelected }}
                      accessibilityLabel={verticalLabels[v]}
                    >
                      <Text style={[screenStyles.pillText, { color: isSelected ? tokens.primary : tokens.textSecondary }]}>
                        {verticalLabels[v]}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          ) : null}

          {/* ── CHW Preferences ── */}
          <SectionCard title="CHW Preferences">
            <View style={screenStyles.prefSection}>
              <Text style={screenStyles.prefLabel}>Gender Preference</Text>
              <View style={screenStyles.segmentRow}>
                {GENDER_OPTIONS.map((opt) => {
                  const isSelected = chwPreferences.genderPreference === opt.key;
                  return (
                    <TouchableOpacity
                      key={opt.key}
                      style={[screenStyles.segmentBtn, isSelected && screenStyles.segmentBtnActive]}
                      onPress={() => setChwPreferences((prev) => ({ ...prev, genderPreference: opt.key }))}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: isSelected }}
                    >
                      <Text style={[screenStyles.segmentBtnText, isSelected && screenStyles.segmentBtnTextActive]}>
                        {opt.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            <View style={screenStyles.divider} />

            <View style={screenStyles.prefSection}>
              <Text style={screenStyles.prefLabel}>Language Preference</Text>
              <Text style={screenStyles.prefHint}>Select all languages you are comfortable with</Text>
              <View style={screenStyles.pillRow}>
                {ALL_LANGUAGES.map((lang) => {
                  const isSelected = chwPreferences.languagePreferences.includes(lang);
                  return (
                    <TouchableOpacity
                      key={lang}
                      style={[
                        screenStyles.pill,
                        isSelected
                          ? { backgroundColor: `${tokens.primary}20`, borderColor: tokens.primary }
                          : { backgroundColor: tokens.pageBg, borderColor: tokens.cardBorder },
                      ]}
                      onPress={() => handleToggleLanguagePref(lang)}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: isSelected }}
                      accessibilityLabel={lang}
                    >
                      <Text style={[screenStyles.pillText, { color: isSelected ? tokens.primary : tokens.textSecondary }]}>
                        {lang}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            <View style={screenStyles.divider} />

            <View style={screenStyles.prefSection}>
              <Text style={screenStyles.prefLabel}>Session Mode Preference</Text>
              <View style={screenStyles.segmentRow}>
                {SESSION_MODE_OPTIONS.map((opt) => {
                  const isSelected = chwPreferences.sessionModePreference === opt.key;
                  return (
                    <TouchableOpacity
                      key={opt.key}
                      style={[screenStyles.segmentBtn, isSelected && screenStyles.segmentBtnActive]}
                      onPress={() => setChwPreferences((prev) => ({ ...prev, sessionModePreference: opt.key }))}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: isSelected }}
                    >
                      <Text style={[screenStyles.segmentBtnText, isSelected && screenStyles.segmentBtnTextActive]}>
                        {opt.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          </SectionCard>

          {/* ── Notification settings ── */}
          <SectionCard title="Notifications">
            <NotificationToggleRow
              label="Session Reminders"
              description="Get reminded before upcoming sessions"
              value={notifications.sessionReminders}
              onChange={handleToggleNotification('sessionReminders')}
            />
            <View style={screenStyles.divider} />
            <NotificationToggleRow
              label="Goal Updates"
              description="Progress milestones and check-ins"
              value={notifications.goalUpdates}
              onChange={handleToggleNotification('goalUpdates')}
            />
            <View style={screenStyles.divider} />
            <NotificationToggleRow
              label="Health Tips"
              description="Weekly wellness and resource tips"
              value={notifications.healthTips}
              onChange={handleToggleNotification('healthTips')}
            />
          </SectionCard>

          {/* ── Rewards history ── */}
          <View style={screenStyles.rewardsHistoryCard}>
            <View style={screenStyles.rewardsHistoryHeader}>
              <Bell size={15} color={tokens.amber700} />
              <Text style={screenStyles.rewardsHistoryTitle}>Rewards History</Text>
            </View>
            <FlatList
              data={rewardsQuery.data ?? []}
              keyExtractor={(item) => item.id}
              renderItem={({ item, index }) => (
                <>
                  {index > 0 ? <View style={screenStyles.divider} /> : null}
                  <RewardRow item={item} />
                </>
              )}
              scrollEnabled={false}
              accessibilityLabel="Rewards history list"
            />
          </View>

          {/* ── Redemption catalog ── */}
          <View style={screenStyles.catalogSection}>
            <View style={screenStyles.catalogHeader}>
              <ShoppingBag size={15} color={tokens.primary} />
              <Text style={screenStyles.catalogTitle}>Redemption Catalog</Text>
            </View>
            <Text style={screenStyles.catalogBalance}>
              Your balance:{' '}
              <Text style={screenStyles.catalogBalanceBold}>{effectiveBalance} pts</Text>
            </Text>
            {rewardsCatalogQuery.isLoading ? (
              <LoadingSkeleton variant="rows" rows={3} />
            ) : rewardsCatalogQuery.isError ? (
              <ErrorState
                message="Could not load rewards catalog. Please try again."
                onRetry={() => void rewardsCatalogQuery.refetch()}
              />
            ) : activeRewardItems.length === 0 ? (
              <Text style={screenStyles.catalogEmptyText}>No rewards available yet.</Text>
            ) : (
              activeRewardItems.map((item) => (
                <RedemptionCard
                  key={item.id}
                  item={item}
                  onRedeem={handleRedeem}
                  balance={effectiveBalance}
                />
              ))
            )}
          </View>

          {/* ── Account ── */}
          <SectionCard title="Account">
            <TouchableOpacity
              onPress={() => void handleSignOut()}
              style={screenStyles.signOutBtn}
              accessibilityRole="button"
              accessibilityLabel="Sign out of your account"
            >
              <LogOut color={tokens.red700} size={17} />
              <Text style={screenStyles.signOutText}>Sign Out</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                setDeleteErrorMessage(null);
                setIsDeleteModalVisible(true);
              }}
              style={screenStyles.deleteAccountBtn}
              accessibilityRole="button"
              accessibilityLabel="Delete your account"
            >
              <Text style={screenStyles.deleteAccountText}>Delete Account</Text>
            </TouchableOpacity>
          </SectionCard>

          <Text style={screenStyles.versionText}>Compass CHW · v1.0.0</Text>
          <View style={{ height: spacing.xxxl }} />
        </PageWrap>
      </ScrollView>

      {/* ── Modals ── */}

      <EditProfileModal
        visible={isInsuranceCinModalVisible}
        profile={apiProfile}
        onClose={() => setIsInsuranceCinModalVisible(false)}
        onSaved={() => void profileQuery.refetch()}
      />

      <RefuseServicesConfirmModal
        visible={isRefuseModalVisible}
        isPending={updateConsent.isPending}
        onConfirm={() => void handleRefuseConfirm()}
        onCancel={() => setIsRefuseModalVisible(false)}
      />

      <DeleteAccountModal
        visible={isDeleteModalVisible}
        onClose={() => setIsDeleteModalVisible(false)}
        onConfirm={handleDeleteAccountConfirm}
        errorMessage={deleteErrorMessage}
      />

      <PhoneVerificationModal
        visible={isPhoneVerificationVisible}
        initialPhone={pendingPhone}
        onVerified={() => {
          setIsPhoneVerificationVisible(false);
          void profileQuery.refetch();
        }}
        onClose={() => setIsPhoneVerificationVisible(false)}
      />
    </SafeAreaView>
  );
}

// ─── Screen-level styles ──────────────────────────────────────────────────────

const screenStyles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: tokens.pageBg,
  } as ViewStyle,

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: tokens.pageBg,
    borderBottomWidth: 1,
    borderBottomColor: tokens.cardBorder,
  } as ViewStyle,
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: tokens.textPrimary,
  } as TextStyle,
  headerActions: {
    flexDirection: 'row',
    gap: spacing.sm,
  } as ViewStyle,
  headerEditBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: `${tokens.primary}40`,
    backgroundColor: `${tokens.primary}10`,
  } as ViewStyle,
  headerEditText: {
    fontSize: 13,
    fontWeight: '600',
    color: tokens.primary,
  } as TextStyle,
  headerSaveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: tokens.primary,
  } as ViewStyle,
  headerSaveText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#FFFFFF',
  } as TextStyle,
  headerCancelBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    backgroundColor: tokens.cardBg,
  } as ViewStyle,
  headerCancelText: {
    fontSize: 13,
    fontWeight: '600',
    color: tokens.textSecondary,
  } as TextStyle,

  scroll: { flex: 1 } as ViewStyle,
  scrollContent: {
    flexGrow: 1,
    alignItems: 'center',
    backgroundColor: tokens.pageBg,
  } as ViewStyle,
  loadingContainer: {
    flexGrow: 1,
    alignItems: 'center',
    paddingTop: spacing.xl,
  } as ViewStyle,

  pageWrap: {
    paddingHorizontal: spacing.lg,
    paddingTop: 0,
    paddingBottom: spacing.xl,
  } as ViewStyle,

  // Green banner (same as CHW profile screens)
  banner: {
    height: 72,
    backgroundColor: tokens.sidebarBg,
    marginHorizontal: -spacing.lg,
    marginBottom: spacing.lg,
  } as ViewStyle,

  // 3-column top card grid
  topCardGrid: {
    flexDirection: 'row',
    gap: spacing.md,
    marginBottom: spacing.xl,
    // On very narrow screens (< 480px), stack vertically
    flexWrap: Platform.OS === 'web' ? 'nowrap' : 'wrap',
    alignItems: 'stretch',
  } as ViewStyle,

  // Edit card (below 3-col when isEditing)
  editCard: {
    backgroundColor: tokens.cardBg,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    padding: spacing.lg,
    marginBottom: spacing.lg,
    ...(shadows.card as object),
  } as ViewStyle,
  editCardTitle: {
    fontSize: 11,
    fontWeight: '600',
    color: tokens.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: spacing.md,
  } as TextStyle,

  divider: {
    height: 1,
    backgroundColor: tokens.cardBorder,
  } as ViewStyle,

  // Pill toggles (language/need selectors)
  pillRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.sm,
  } as ViewStyle,
  pill: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
  } as ViewStyle,
  pillText: {
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 18,
  } as TextStyle,

  // CHW preference sections
  prefSection: {
    paddingVertical: spacing.md,
  } as ViewStyle,
  prefLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: tokens.textPrimary,
    marginBottom: 4,
  } as TextStyle,
  prefHint: {
    fontSize: 11,
    fontWeight: '400',
    color: tokens.textSecondary,
    marginBottom: 4,
  } as TextStyle,
  segmentRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
    flexWrap: 'wrap',
  } as ViewStyle,
  segmentBtn: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    backgroundColor: tokens.pageBg,
    alignItems: 'center',
    minWidth: 80,
  } as ViewStyle,
  segmentBtnActive: {
    backgroundColor: `${tokens.primary}15`,
    borderColor: tokens.primary,
  } as ViewStyle,
  segmentBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: tokens.textSecondary,
  } as TextStyle,
  segmentBtnTextActive: {
    color: tokens.primary,
  } as TextStyle,

  // Rewards history
  rewardsHistoryCard: {
    backgroundColor: tokens.cardBg,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    padding: spacing.lg,
    marginBottom: spacing.lg,
    ...(shadows.card as object),
  } as ViewStyle,
  rewardsHistoryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.md,
  } as ViewStyle,
  rewardsHistoryTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: tokens.textPrimary,
  } as TextStyle,

  // Redemption catalog
  catalogSection: {
    marginBottom: spacing.lg,
  } as ViewStyle,
  catalogHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: 6,
  } as ViewStyle,
  catalogTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: tokens.textPrimary,
  } as TextStyle,
  catalogBalance: {
    fontSize: 13,
    fontWeight: '400',
    color: tokens.textSecondary,
    marginBottom: spacing.md,
  } as TextStyle,
  catalogBalanceBold: {
    fontWeight: '700',
    color: tokens.amber700,
  } as TextStyle,
  catalogEmptyText: {
    fontSize: 13,
    color: tokens.textSecondary,
    textAlign: 'center',
    paddingVertical: spacing.lg,
  } as TextStyle,

  // Account
  signOutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
  } as ViewStyle,
  signOutText: {
    fontSize: 14,
    fontWeight: '600',
    color: tokens.red700,
  } as TextStyle,
  deleteAccountBtn: {
    paddingVertical: spacing.md,
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: tokens.cardBorder,
  } as ViewStyle,
  deleteAccountText: {
    fontSize: 14,
    fontWeight: '600',
    color: tokens.red700,
    textDecorationLine: 'underline',
  } as TextStyle,

  versionText: {
    fontSize: 11,
    fontWeight: '400',
    color: tokens.textMuted,
    textAlign: 'center',
    marginBottom: spacing.sm,
  } as TextStyle,
});

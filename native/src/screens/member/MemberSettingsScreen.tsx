/**
 * MemberSettingsScreen — settings, profile, and privacy for the member.
 *
 * Layout matches `_mockups/member-settings.html` 1:1 on web:
 *   - Page header (Settings + subtitle)
 *   - Main card showing the Profile tab's content. The underline-style tab
 *     strip (Profile / Notifications / Privacy & Security / Language / Help)
 *     is hidden until further notice (QA batch #7, same as CHWProfileScreen)
 *     — see TAB_ORDER below.
 *   - Below the main card: 2-column grid of always-visible cards —
 *     left: Privacy & Security summary (4 toggles + Deactivate + Delete);
 *     right: Need help? (3 contact buttons).
 *
 * Field-level editing is inline: each profile row shows label + value + an
 * "Edit" link. Tapping Edit converts that one row into a TextInput plus
 * Save / Cancel actions. Avoids the previous all-or-nothing form pattern.
 *
 * Account deactivation (reversible, `useDeactivateAccount`) and deletion
 * (permanent, `useDeleteAccount` via the shared `DeleteAccountModal`
 * 3-step flow) both use on-brand confirm UI — never `window.confirm` or
 * bare `Alert.alert` — and both end by calling `clearAfterDeletion()` since
 * neither a deactivated nor a deleted account can re-authenticate locally.
 *
 * Data: `useMemberProfile` (read), `useUpdateMemberProfile` (write).
 */

import React, { useCallback, useState } from 'react';
import {
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  useWindowDimensions,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import {
  Globe,
  HelpCircle,
  MessageSquare,
  Shield,
  ShieldOff,
  Trash2,
} from 'lucide-react-native';

import { useAuth } from '../../context/AuthContext';
import {
  useMemberProfile,
  useUpdateMemberProfile,
  useUpdateInsuranceCin,
  useDeleteAccount,
  useDeactivateAccount,
  useStartPhoneVerification,
  useConfirmPhoneVerification,
  type MemberProfile,
} from '../../hooks/useApiQueries';
import { ApiError } from '../../api/client';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { AppShell, PageHeader, Card, ProfilePictureEditor } from '../../components/ui';
import { DeleteAccountModal } from '../../components/profile/DeleteAccountModal';
import { colors as tokens } from '../../theme/tokens';
import { confirmAsync } from '../../utils/confirm';
import { BP_PHONE } from '../../constants/breakpoints';

// ─── Types & constants ────────────────────────────────────────────────────────

// QA batch #7 (Wave-2 B1): Notifications / Privacy & Security / Language /
// Help tabs are hidden until further notice — product wants Settings to be
// Profile-only for now, mirroring the identical change on CHWProfileScreen.
// Type + labels are kept as-is (not deleted) so the now-unreachable tab
// panels below still type-check and can be restored by re-adding the tab
// keys to TAB_ORDER; only TAB_ORDER (what's actually shown) is trimmed.
type SettingsTab = 'profile' | 'notifications' | 'privacy' | 'language' | 'help';

const TAB_LABELS: Record<SettingsTab, string> = {
  profile:       'Profile',
  notifications: 'Notifications',
  privacy:       'Privacy & Security',
  language:      'Language',
  help:          'Help',
};

// Hidden until further notice (QA batch #7) — was:
// ['profile', 'notifications', 'privacy', 'language', 'help']
const TAB_ORDER: SettingsTab[] = ['profile'];

const LANGUAGE_OPTIONS = [
  { value: 'English',    label: 'English' },
  { value: 'Spanish',    label: 'Español' },
  { value: 'Chinese',    label: '中文' },
  { value: 'Tagalog',    label: 'Tagalog' },
  { value: 'Vietnamese', label: 'Tiếng Việt' },
  { value: 'Korean',     label: '한국어' },
];

// QA batch (2026-07-14) Part 21 — matches the Pear Suite sex enum the
// backend's MemberProfileUpdate._validate_gender accepts (schemas/user.py).
const SEX_OPTIONS = ['Male', 'Female', 'Other'] as const;

// ─── TabBar ───────────────────────────────────────────────────────────────────

interface TabBarProps {
  active:   SettingsTab;
  onChange: (tab: SettingsTab) => void;
}

function TabBar({ active, onChange }: TabBarProps): React.JSX.Element {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={tabStyles.row}
      style={tabStyles.scroll}
    >
      {TAB_ORDER.map((tab) => {
        const isActive = tab === active;
        return (
          <Pressable
            key={tab}
            onPress={() => onChange(tab)}
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive }}
            accessibilityLabel={TAB_LABELS[tab]}
            style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
              tabStyles.tab,
              isActive && tabStyles.tabActive,
              !isActive && (hovered || pressed) && tabStyles.tabHover,
            ]}
          >
            <Text style={[tabStyles.label, isActive && tabStyles.labelActive]}>
              {TAB_LABELS[tab]}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const tabStyles = StyleSheet.create({
  scroll: {
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  } as ViewStyle,
  row: {
    flexDirection:     'row',
    paddingHorizontal: 24,
  } as ViewStyle,
  tab: {
    paddingVertical:   14,
    paddingHorizontal: 16,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
    marginBottom:      -1,
  } as ViewStyle,
  tabActive: {
    borderBottomColor: '#10B981',
  } as ViewStyle,
  tabHover: {
    borderBottomColor: '#A7F3D0',
  } as ViewStyle,
  label: {
    fontSize:   14,
    fontWeight: '600',
    color:      '#6B7280',
  } as TextStyle,
  labelActive: {
    color: '#10B981',
  } as TextStyle,
});

// ─── EditableField (Profile tab) ──────────────────────────────────────────────

interface EditableFieldProps {
  label:        string;
  value:        string;
  /** When set, renders a non-editable tag instead of an Edit button. */
  tagLabel?:    string;
  /** Hides the right-side action entirely (read-only field). */
  readOnly?:    boolean;
  isEditing:    boolean;
  onEditStart:  () => void;
  onEditCancel: () => void;
  onSave:       (next: string) => Promise<void> | void;
  placeholder?: string;
  keyboardType?: 'default' | 'email-address' | 'phone-pad' | 'numeric';
}

function EditableField({
  label,
  value,
  tagLabel,
  readOnly,
  isEditing,
  onEditStart,
  onEditCancel,
  onSave,
  placeholder,
  keyboardType = 'default',
}: EditableFieldProps): React.JSX.Element {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);

  // Reset draft whenever we enter edit mode (fresh value snapshot).
  React.useEffect(() => {
    if (isEditing) setDraft(value);
  }, [isEditing, value]);

  const handleSave = async (): Promise<void> => {
    if (draft === value) {
      onEditCancel();
      return;
    }
    setSaving(true);
    try {
      await onSave(draft);
    } finally {
      setSaving(false);
    }
  };

  if (isEditing) {
    return (
      <View style={fieldStyles.row}>
        <Text style={fieldStyles.label}>{label}</Text>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder={placeholder ?? label}
          placeholderTextColor="#9CA3AF"
          keyboardType={keyboardType}
          editable={!saving}
          autoFocus
          style={fieldStyles.input}
          accessibilityLabel={label}
        />
        <Pressable
          onPress={() => void handleSave()}
          disabled={saving}
          accessibilityRole="button"
          accessibilityLabel="Save"
          style={fieldStyles.editLink}
        >
          <Text style={fieldStyles.editLinkText}>{saving ? 'Saving…' : 'Save'}</Text>
        </Pressable>
        <Pressable
          onPress={onEditCancel}
          disabled={saving}
          accessibilityRole="button"
          accessibilityLabel="Cancel edit"
          style={fieldStyles.editLink}
        >
          <Text style={fieldStyles.cancelLinkText}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={fieldStyles.row}>
      <Text style={fieldStyles.label}>{label}</Text>
      <Text style={fieldStyles.value} numberOfLines={1}>
        {value || '—'}
      </Text>
      {tagLabel !== undefined ? (
        <Text style={fieldStyles.tag}>{tagLabel}</Text>
      ) : !readOnly ? (
        <Pressable
          onPress={onEditStart}
          accessibilityRole="button"
          accessibilityLabel={`Edit ${label}`}
          style={fieldStyles.editLink}
        >
          <Text style={fieldStyles.editLinkText}>Edit</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const fieldStyles = StyleSheet.create({
  row: {
    flexDirection:     'row',
    alignItems:        'center',
    gap:               12,
    paddingVertical:   12,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  } as ViewStyle,
  label: {
    fontSize:   12,
    fontWeight: '500',
    color:      '#6B7280',
    minWidth:   160,
  } as TextStyle,
  value: {
    flex:       1,
    fontSize:   14,
    fontWeight: '500',
    color:      '#111827',
  } as TextStyle,
  tag: {
    fontSize: 12,
    color:    '#9CA3AF',
  } as TextStyle,
  input: {
    flex:              1,
    fontSize:          14,
    color:             '#111827',
    backgroundColor:   '#F9FAFB',
    borderWidth:       1,
    borderColor:       '#E5E7EB',
    borderRadius:      8,
    paddingHorizontal: 10,
    paddingVertical:   8,
  } as ViewStyle,
  editLink: {
    paddingHorizontal: 4,
    paddingVertical:   4,
  } as ViewStyle,
  editLinkText: {
    fontSize:   12,
    fontWeight: '700',
    color:      '#10B981',
  } as TextStyle,
  cancelLinkText: {
    fontSize:   12,
    fontWeight: '600',
    color:      '#6B7280',
  } as TextStyle,
});

// ─── SexEditableField (Profile tab, Part 21) ───────────────────────────────────
//
// Mirrors EditableField's row layout, but edits via a 3-option pill picker
// (Male / Female / Other) instead of free text — the same closed enum the
// signup form's "Sex" picker offers and the backend's
// MemberProfileUpdate._validate_gender accepts. A free-text input would let
// a member type a value the backend then 422s on.

interface SexEditableFieldProps {
  value:        string | null | undefined;
  isEditing:    boolean;
  onEditStart:  () => void;
  onEditCancel: () => void;
  onSave:       (next: string) => Promise<void> | void;
}

function SexEditableField({
  value,
  isEditing,
  onEditStart,
  onEditCancel,
  onSave,
}: SexEditableFieldProps): React.JSX.Element {
  const [saving, setSaving] = useState(false);

  const handleSelect = async (next: string): Promise<void> => {
    if (next === value) {
      onEditCancel();
      return;
    }
    setSaving(true);
    try {
      await onSave(next);
    } finally {
      setSaving(false);
    }
  };

  if (isEditing) {
    return (
      <View style={fieldStyles.row}>
        <Text style={fieldStyles.label}>Sex</Text>
        <View style={{ flex: 1, flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {SEX_OPTIONS.map((option) => (
            <Pressable
              key={option}
              onPress={() => void handleSelect(option)}
              disabled={saving}
              accessibilityRole="radio"
              accessibilityState={{ checked: option === value }}
              accessibilityLabel={option}
              style={({ pressed }: { pressed: boolean }) => [
                sexFieldStyles.pill,
                option === value && sexFieldStyles.pillActive,
                pressed && { opacity: 0.7 },
              ]}
            >
              <Text
                style={[
                  sexFieldStyles.pillText,
                  option === value && sexFieldStyles.pillTextActive,
                ]}
              >
                {option}
              </Text>
            </Pressable>
          ))}
        </View>
        <Pressable
          onPress={onEditCancel}
          disabled={saving}
          accessibilityRole="button"
          accessibilityLabel="Cancel edit"
          style={fieldStyles.editLink}
        >
          <Text style={fieldStyles.cancelLinkText}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={fieldStyles.row}>
      <Text style={fieldStyles.label}>Sex</Text>
      <Text style={fieldStyles.value} numberOfLines={1}>
        {value || '—'}
      </Text>
      <Pressable
        onPress={onEditStart}
        accessibilityRole="button"
        accessibilityLabel="Edit Sex"
        style={fieldStyles.editLink}
      >
        <Text style={fieldStyles.editLinkText}>Edit</Text>
      </Pressable>
    </View>
  );
}

const sexFieldStyles = StyleSheet.create({
  pill: {
    paddingHorizontal: 12,
    paddingVertical:   6,
    borderRadius:      999,
    borderWidth:       1,
    borderColor:       '#E5E7EB',
    backgroundColor:   '#FFFFFF',
  } as ViewStyle,
  pillActive: {
    borderColor:     '#10B981',
    backgroundColor: '#ECFDF5',
  } as ViewStyle,
  pillText: {
    fontSize:   13,
    fontWeight: '500',
    color:      '#374151',
  } as TextStyle,
  pillTextActive: {
    color:      '#047857',
    fontWeight: '700',
  } as TextStyle,
});

// ─── ToggleRow (Privacy + Notifications tabs and bottom card) ────────────────

interface ToggleRowProps {
  label:         string;
  description:   string;
  value:         boolean;
  onValueChange: (val: boolean) => void;
}

function ToggleRow({ label, description, value, onValueChange }: ToggleRowProps): React.JSX.Element {
  return (
    <View style={toggleStyles.row}>
      <View style={toggleStyles.text}>
        <Text style={toggleStyles.label}>{label}</Text>
        <Text style={toggleStyles.desc}>{description}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        thumbColor="#FFFFFF"
        trackColor={{ false: '#D1D5DB', true: '#10B981' }}
        accessibilityRole="switch"
        accessibilityLabel={label}
        accessibilityState={{ checked: value }}
      />
    </View>
  );
}

const toggleStyles = StyleSheet.create({
  row: {
    flexDirection:     'row',
    alignItems:        'center',
    gap:               16,
    paddingVertical:   12,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  } as ViewStyle,
  text: {
    flex: 1,
    gap:  2,
  } as ViewStyle,
  label: {
    fontSize:   14,
    fontWeight: '600',
    color:      '#111827',
  } as TextStyle,
  desc: {
    fontSize:   12,
    color:      '#6B7280',
    lineHeight: 16,
  } as TextStyle,
});

// ─── ContactCard (Need help) ──────────────────────────────────────────────────

interface ContactCardProps {
  icon:        React.ReactNode;
  iconBgColor: string;
  title:       string;
  description: string;
  onPress:     () => void;
}

function ContactCard({ icon, iconBgColor, title, description, onPress }: ContactCardProps): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={title}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
        contactStyles.card,
        (pressed || hovered) && contactStyles.cardHover,
      ]}
    >
      <View style={[contactStyles.iconBox, { backgroundColor: iconBgColor }]}>
        {icon}
      </View>
      <View style={contactStyles.text}>
        <Text style={contactStyles.title}>{title}</Text>
        <Text style={contactStyles.desc} numberOfLines={2}>
          {description}
        </Text>
      </View>
    </Pressable>
  );
}

const contactStyles = StyleSheet.create({
  card: {
    flexDirection:    'row',
    alignItems:       'center',
    gap:              12,
    padding:          12,
    borderRadius:     12,
    borderWidth:      1,
    borderColor:      '#E5E7EB',
    backgroundColor:  '#FFFFFF',
  } as ViewStyle,
  cardHover: {
    backgroundColor: '#F9FAFB',
  } as ViewStyle,
  iconBox: {
    width:          40,
    height:         40,
    borderRadius:   8,
    alignItems:     'center',
    justifyContent: 'center',
    flexShrink:     0,
  } as ViewStyle,
  text: {
    flex: 1,
    gap:  2,
  } as ViewStyle,
  title: {
    fontSize:   14,
    fontWeight: '600',
    color:      '#111827',
  } as TextStyle,
  desc: {
    fontSize:   12,
    color:      '#6B7280',
    lineHeight: 16,
  } as TextStyle,
});

// ─── TextMessagesCard (SMS Output Spec 1 §1) ──────────────────────────────────
//
// Lets a member turn on CHW->member SMS by verifying their phone. Three states:
//   - Placeholder phone (555-555-5555) → no card at all (decision 2: fully
//     SMS-opted-out; the number can't receive texts).
//   - Verified (phone_verified_at set) → static "On" row with a masked number
//     and the standing STOP reminder.
//   - Unverified real phone → "Turn on text messages" + Send code → inline
//     6-digit entry → Confirm. On success the member profile query invalidates
//     and the card flips to the "On" state.

const SMS_SENTINEL_DIGITS = new Set(['5555555555', '15555555555']);
const SMS_CODE_LENGTH = 6;

/** Normalise a stored phone to E.164 for the /phone endpoints, or null when it
 *  isn't a plausible US number. */
function toE164OrNull(rawDigits: string): string | null {
  if (rawDigits.length === 10) return `+1${rawDigits}`;
  if (rawDigits.length === 11 && rawDigits.startsWith('1')) return `+${rawDigits}`;
  return null;
}

function extractErrorDetail(err: unknown): string | null {
  if (err instanceof ApiError) return err.message || null;
  if (
    err != null &&
    typeof err === 'object' &&
    'detail' in err &&
    typeof (err as { detail: unknown }).detail === 'string'
  ) {
    return (err as { detail: string }).detail;
  }
  return null;
}

function TextMessagesCard({ profile }: { profile: MemberProfile | undefined }): React.JSX.Element | null {
  const startVerification = useStartPhoneVerification();
  const confirmVerification = useConfirmPhoneVerification();
  const [entering, setEntering] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const phone = profile?.phone ?? '';
  const digits = phone.replace(/\D/g, '');
  const isSentinel = SMS_SENTINEL_DIGITS.has(digits);
  const e164 = toE164OrNull(digits);
  const isVerified = profile?.phoneVerifiedAt != null;
  const last4 = digits.slice(-4);

  // Placeholder phone → no SMS features whatsoever (decision 2).
  if (!phone || isSentinel) return null;

  const handleSendCode = (): void => {
    if (!e164) {
      setError('We need a valid mobile number before we can text you.');
      return;
    }
    setError(null);
    setEntering(true);
    startVerification.mutate(
      { phone: e164 },
      { onError: () => setError('Could not send a code. Please try again in a moment.') },
    );
  };

  const handleConfirm = async (): Promise<void> => {
    setError(null);
    if (!e164) return;
    if (code.length !== SMS_CODE_LENGTH) {
      setError('Enter the 6-digit code we texted you.');
      return;
    }
    try {
      await confirmVerification.mutateAsync({ phone: e164, code });
      // onSuccess invalidates the profile query; the refetch flips this card
      // to the verified "On" state. Reset local entry state.
      setEntering(false);
      setCode('');
    } catch (err) {
      setError(extractErrorDetail(err) ?? 'That code was not correct. Please try again.');
    }
  };

  return (
    <Card style={pageStyles.smsCard}>
      <Text style={pageStyles.bottomCardTitle}>Text messages</Text>

      {isVerified ? (
        <Text style={pageStyles.smsBody} accessibilityLabel="Text messages are on">
          On — we text you at •••{last4}. Reply STOP anytime to opt out.
        </Text>
      ) : !entering ? (
        <>
          <Text style={pageStyles.smsBody}>
            Turn on text messages so your CHW&apos;s messages and appointment updates
            also reach you by SMS. Reply STOP anytime to opt out.
          </Text>
          <Pressable
            onPress={handleSendCode}
            disabled={startVerification.isPending}
            accessibilityRole="button"
            accessibilityLabel="Send code"
            style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
              pageStyles.smsButton,
              (pressed || hovered) && pageStyles.smsButtonHover,
              startVerification.isPending && { opacity: 0.6 },
            ]}
          >
            <Text style={pageStyles.smsButtonText}>
              {startVerification.isPending ? 'Sending…' : 'Send code'}
            </Text>
          </Pressable>
        </>
      ) : (
        <>
          <Text style={pageStyles.smsBody}>
            Enter the 6-digit code we texted to •••{last4}.
          </Text>
          <TextInput
            value={code}
            onChangeText={(v) => {
              setCode(v.replace(/\D/g, '').slice(0, SMS_CODE_LENGTH));
              if (error) setError(null);
            }}
            placeholder="123456"
            placeholderTextColor="#9CA3AF"
            keyboardType="number-pad"
            maxLength={SMS_CODE_LENGTH}
            editable={!confirmVerification.isPending}
            accessibilityLabel="Verification code"
            style={pageStyles.smsInput}
          />
          <Pressable
            onPress={() => void handleConfirm()}
            disabled={confirmVerification.isPending}
            accessibilityRole="button"
            accessibilityLabel="Confirm code"
            style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
              pageStyles.smsButton,
              (pressed || hovered) && pageStyles.smsButtonHover,
              confirmVerification.isPending && { opacity: 0.6 },
            ]}
          >
            <Text style={pageStyles.smsButtonText}>
              {confirmVerification.isPending ? 'Confirming…' : 'Confirm'}
            </Text>
          </Pressable>
        </>
      )}

      {error && <Text style={pageStyles.smsError}>{error}</Text>}
    </Card>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export function MemberSettingsScreen(): React.JSX.Element {
  const { userName, logout, clearAfterDeletion } = useAuth();
  const deleteAccount = useDeleteAccount();
  const deactivateAccount = useDeactivateAccount();
  const profileQuery = useMemberProfile();
  const updateProfile = useUpdateMemberProfile();
  // QA batch (2026-07-14) Part 21 — CIN edits go through the dedicated
  // insurance-CIN PATCH (not the generic profile PUT), which validates CIN
  // format and (Part 4, separate PR) enforces cross-member CIN uniqueness.
  const updateInsuranceCin = useUpdateInsuranceCin();

  // Epic K (mobile web polish): pageWrap's 32px side padding plus the
  // profile/bottom grids' 320px minWidth columns force a wider-than-viewport
  // layout below phone width (360px - 64px padding = 296px < 320px minWidth,
  // so the page body scrolls sideways even after the grid wraps to a single
  // column). Tighten padding and drop the minWidth floor at phone width only
  // — desktop/tablet keep the existing 2-column grid untouched. Same
  // 0-width-before-measurement guard as MemberFindScreen's `isPhone`.
  const { width: windowWidth } = useWindowDimensions();
  const isPhone = Platform.OS === 'web' && windowWidth > 0 && windowWidth < BP_PHONE;

  const memberInitials = (userName ?? 'M')
    .split(' ')
    .slice(0, 2)
    .map((p) => p[0] ?? '')
    .join('')
    .toUpperCase();

  const [activeTab, setActiveTab] = useState<SettingsTab>('profile');
  const [editingField, setEditingField] = useState<string | null>(null);

  // QA batch (2026-07-14) Part 20: the four Privacy & Security toggles
  // (two-factor, biometric, AI transcription consent, research sharing)
  // were removed — they were local `useState` only, never persisted to any
  // backend setting, so they were misleading fake controls (the REAL
  // transcription consent is captured per-session in the consent flow, not
  // here). Deactivate/Delete account remain as the card's only actions.
  const [sessionReminders, setSessionReminders] = useState(true);
  const [pushNotifications, setPushNotifications] = useState(true);

  const profile = profileQuery.data;

  // ── SMS 2FA opt-in (Spec 2) ───────────────────────────────────────────────
  // A REAL toggle (unlike the four fake ones removed in QA batch Part 20):
  // PATCHes User.sms_2fa_enabled through the member-profile update path. Shown
  // ONLY to a member with a verified, non-sentinel phone — a sentinel or
  // unverified member can never be SMS-challenged, so the control would be dead
  // (and enabling it would strand them out of their own account).
  const twoFaDigits = (profile?.phone ?? '').replace(/\D/g, '');
  const twoFaPhoneEligible =
    !!profile?.phone &&
    !SMS_SENTINEL_DIGITS.has(twoFaDigits) &&
    profile?.phoneVerifiedAt != null;
  const [smsTwoFactorEnabled, setSmsTwoFactorEnabled] = useState(false);
  // Mirror the server value whenever the profile query settles or refetches.
  React.useEffect(() => {
    setSmsTwoFactorEnabled(profile?.sms_2faEnabled ?? false);
  }, [profile?.sms_2faEnabled]);

  const handleToggleSmsTwoFactor = useCallback(
    async (next: boolean) => {
      setSmsTwoFactorEnabled(next); // optimistic
      try {
        await updateProfile.mutateAsync({ sms_2faEnabled: next });
      } catch (err) {
        setSmsTwoFactorEnabled(!next); // roll back on failure
        const detail = err instanceof ApiError ? err.message : null;
        Alert.alert(
          'Could not update',
          detail ?? 'Two-factor authentication setting was not saved. Please try again.',
        );
      }
    },
    [updateProfile],
  );

  // ── Delete account (on-brand 3-step modal — shared with MemberProfileScreen) ──
  const [isDeleteModalVisible, setIsDeleteModalVisible] = useState(false);
  const [deleteErrorMessage, setDeleteErrorMessage] = useState<string | null>(null);

  // ── Deactivate account (reversible — lighter-weight single confirm) ──────────
  const [isDeactivating, setIsDeactivating] = useState(false);

  const handleSaveField = useCallback(
    async (field: string, payload: Record<string, unknown>) => {
      try {
        await updateProfile.mutateAsync(payload);
        setEditingField(null);
      } catch (err: unknown) {
        const detail =
          err != null &&
          typeof err === 'object' &&
          'detail' in err &&
          typeof (err as { detail: unknown }).detail === 'string'
            ? (err as { detail: string }).detail
            : null;
        Alert.alert('Could not save', detail ?? `${field} was not updated. Please try again.`);
      }
    },
    [updateProfile],
  );

  // QA batch (2026-07-14) Part 21 — the CIN row saves through the dedicated
  // insurance-CIN endpoint, which requires BOTH insuranceCompany and
  // mediCalId in the same request. We send the member's current insurance
  // company alongside the newly-typed CIN so a CIN-only edit doesn't
  // accidentally blank out (or fail validation on) the insurance company.
  const handleSaveCin = useCallback(
    async (nextCin: string) => {
      try {
        await updateInsuranceCin.mutateAsync({
          insuranceCompany: profile?.insuranceCompany ?? profile?.insuranceProvider ?? '',
          mediCalId: nextCin,
        });
        setEditingField(null);
      } catch (err: unknown) {
        const detail =
          err != null &&
          typeof err === 'object' &&
          'detail' in err &&
          typeof (err as { detail: unknown }).detail === 'string'
            ? (err as { detail: string }).detail
            : null;
        Alert.alert(
          'Could not save',
          detail ?? 'CIN (Medi-Cal ID) was not updated. Please try again.',
        );
      }
    },
    [updateInsuranceCin, profile?.insuranceCompany, profile?.insuranceProvider],
  );

  const handleDeleteAccountConfirm = useCallback(
    async (password: string) => {
      setDeleteErrorMessage(null);
      try {
        await deleteAccount.mutateAsync({ password });
        setIsDeleteModalVisible(false);
        // On success, clear local auth state without setting
        // hasJustSignedOut — that flag steers the next render to Login,
        // but the deleted account can't log back in.  clearAfterDeletion
        // lands the user on the marketing Landing page instead.
        await clearAfterDeletion();
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
    },
    [deleteAccount, clearAfterDeletion],
  );

  const handleDeactivateAccount = useCallback(async () => {
    const confirmed = await confirmAsync({
      title: 'Deactivate your account?',
      message:
        'Your account will be deactivated and you’ll be signed out. This is reversible — your data is retained, and you can contact support any time to reactivate.',
      confirmText: 'Deactivate',
      destructive: true,
    });
    if (!confirmed) return;

    setIsDeactivating(true);
    try {
      await deactivateAccount.mutateAsync();
      // Deactivation blocks the session server-side, so clear local auth
      // state the same way account deletion does.
      await clearAfterDeletion();
    } catch (err) {
      const message =
        err instanceof Error && err.message
          ? err.message
          : 'Could not deactivate your account. Please try again or contact support.';
      Alert.alert('Deactivation failed', message);
    } finally {
      setIsDeactivating(false);
    }
  }, [deactivateAccount, clearAfterDeletion]);

  const handleLogout = useCallback(() => {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign Out', style: 'destructive', onPress: () => void logout() },
    ]);
  }, [logout]);

  const shellUserBlock = {
    initials: memberInitials,
    name:     userName ?? 'Member',
    role:     'Member' as const,
  };

  if (profileQuery.isLoading) {
    return (
      <AppShell role="member" activeKey="settings" userBlock={shellUserBlock}>
        <LoadingSkeleton variant="card" />
        <LoadingSkeleton variant="rows" rows={5} />
      </AppShell>
    );
  }

  return (
    <AppShell role="member" activeKey="settings" userBlock={shellUserBlock}>
      <StatusBar barStyle="dark-content" backgroundColor={tokens.pageBg} />
      <ScrollView
        style={pageStyles.scroll}
        contentContainerStyle={pageStyles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={[pageStyles.pageWrap, isPhone && pageStyles.pageWrapPhone]}>
          <PageHeader
            title="Settings"
            subtitle="Manage your account, privacy, and notifications"
          />

          {/* Main card with tab strip */}
          <Card style={pageStyles.mainCard}>
            {/* QA batch #7: with only one tab (Profile) left in TAB_ORDER,
                the tab strip is pure visual noise — hide it entirely rather
                than render a single non-interactive "Profile" pill. Restore
                automatically once TAB_ORDER regains a 2nd entry. */}
            {TAB_ORDER.length > 1 && <TabBar active={activeTab} onChange={setActiveTab} />}

            <View style={pageStyles.tabContent}>
              {activeTab === 'profile' && (
                <View style={profileStyles.grid}>
                  {/* Avatar column — real photo upload (pick → crop → S3 → save).
                      The same ProfilePictureEditor the CHW profile uses, so both
                      sides share one upload/crop/remove flow. */}
                  <View style={profileStyles.avatarCol}>
                    <ProfilePictureEditor
                      currentUrl={profile?.profilePictureUrl ?? null}
                      role="member"
                      size={128}
                      initials={memberInitials}
                      initialsBackground="#94A3B8"
                      onChange={() => {
                        // The upload/remove hook invalidates the memberProfile
                        // query; useMemberProfile refetches and re-renders here.
                      }}
                    />
                    <Text style={profileStyles.photoHint}>JPEG/PNG, max 5MB</Text>
                  </View>

                  {/* Form column */}
                  <View style={[profileStyles.formCol, isPhone && profileStyles.formColPhone]}>
                    <Text style={profileStyles.formTitle}>Profile information</Text>

                    <EditableField
                      label="Name"
                      value={profile?.name ?? ''}
                      isEditing={editingField === 'name'}
                      onEditStart={() => setEditingField('name')}
                      onEditCancel={() => setEditingField(null)}
                      onSave={(v) => handleSaveField('Name', { name: v })}
                    />
                    {/* QA batch (2026-07-14) Part 21: the rows below fill out
                        Profile information with the rest of the data
                        captured at signup — previously only 6 rows rendered
                        even though GET /member/profile already returns every
                        field (MemberProfileResponse, schemas/user.py). */}
                    <EditableField
                      label="Preferred Name"
                      value={profile?.preferredName ?? ''}
                      isEditing={editingField === 'preferredName'}
                      onEditStart={() => setEditingField('preferredName')}
                      onEditCancel={() => setEditingField(null)}
                      onSave={(v) => handleSaveField('Preferred Name', { preferredName: v })}
                    />
                    <EditableField
                      label="Phone"
                      value={profile?.phone ?? ''}
                      keyboardType="phone-pad"
                      isEditing={editingField === 'phone'}
                      onEditStart={() => setEditingField('phone')}
                      onEditCancel={() => setEditingField(null)}
                      onSave={(v) => handleSaveField('Phone', { phone: v })}
                    />
                    <EditableField
                      label="Email"
                      value={profile?.email ?? ''}
                      keyboardType="email-address"
                      isEditing={editingField === 'email'}
                      onEditStart={() => setEditingField('email')}
                      onEditCancel={() => setEditingField(null)}
                      onSave={(v) => handleSaveField('Email', { email: v })}
                    />
                    <EditableField
                      label="Date of Birth"
                      value={profile?.dateOfBirth ?? ''}
                      placeholder="YYYY-MM-DD"
                      isEditing={editingField === 'dateOfBirth'}
                      onEditStart={() => setEditingField('dateOfBirth')}
                      onEditCancel={() => setEditingField(null)}
                      onSave={(v) => handleSaveField('Date of Birth', { dateOfBirth: v })}
                    />
                    <SexEditableField
                      value={profile?.gender}
                      isEditing={editingField === 'gender'}
                      onEditStart={() => setEditingField('gender')}
                      onEditCancel={() => setEditingField(null)}
                      onSave={(v) => handleSaveField('Sex', { gender: v })}
                    />
                    <EditableField
                      label="Address line 1"
                      value={profile?.addressLine1 ?? ''}
                      isEditing={editingField === 'addressLine1'}
                      onEditStart={() => setEditingField('addressLine1')}
                      onEditCancel={() => setEditingField(null)}
                      onSave={(v) => handleSaveField('Address line 1', { addressLine1: v })}
                    />
                    <EditableField
                      label="Address line 2"
                      value={profile?.addressLine2 ?? ''}
                      isEditing={editingField === 'addressLine2'}
                      onEditStart={() => setEditingField('addressLine2')}
                      onEditCancel={() => setEditingField(null)}
                      onSave={(v) => handleSaveField('Address line 2', { addressLine2: v })}
                    />
                    <EditableField
                      label="City"
                      value={profile?.city ?? ''}
                      isEditing={editingField === 'city'}
                      onEditStart={() => setEditingField('city')}
                      onEditCancel={() => setEditingField(null)}
                      onSave={(v) => handleSaveField('City', { city: v })}
                    />
                    <EditableField
                      label="State"
                      value={profile?.state ?? ''}
                      isEditing={editingField === 'state'}
                      onEditStart={() => setEditingField('state')}
                      onEditCancel={() => setEditingField(null)}
                      onSave={(v) => handleSaveField('State', { state: v })}
                    />
                    <EditableField
                      label="ZIP Code"
                      value={profile?.zipCode ?? ''}
                      keyboardType="numeric"
                      isEditing={editingField === 'zipCode'}
                      onEditStart={() => setEditingField('zipCode')}
                      onEditCancel={() => setEditingField(null)}
                      onSave={(v) => handleSaveField('ZIP Code', { zipCode: v })}
                    />
                    <EditableField
                      label="Preferred Language"
                      value={profile?.primaryLanguage ?? 'English'}
                      isEditing={editingField === 'primaryLanguage'}
                      onEditStart={() => setEditingField('primaryLanguage')}
                      onEditCancel={() => setEditingField(null)}
                      onSave={(v) => handleSaveField('Language', { primaryLanguage: v })}
                    />
                    <EditableField
                      label="Insurance Plan"
                      value={profile?.insuranceCompany ?? profile?.insuranceProvider ?? '—'}
                      tagLabel="From plan"
                      isEditing={false}
                      onEditStart={() => undefined}
                      onEditCancel={() => undefined}
                      onSave={() => undefined}
                    />
                    <EditableField
                      label="CIN (Medi-Cal ID)"
                      value={profile?.mediCalId ?? ''}
                      isEditing={editingField === 'mediCalId'}
                      onEditStart={() => setEditingField('mediCalId')}
                      onEditCancel={() => setEditingField(null)}
                      onSave={handleSaveCin}
                    />
                    <EditableField
                      label="Primary Need"
                      value={profile?.primaryNeed ?? ''}
                      isEditing={editingField === 'primaryNeed'}
                      onEditStart={() => setEditingField('primaryNeed')}
                      onEditCancel={() => setEditingField(null)}
                      onSave={(v) => handleSaveField('Primary Need', { primaryNeed: v })}
                    />
                  </View>
                </View>
              )}

              {activeTab === 'notifications' && (
                <View style={pageStyles.tabPanel}>
                  <Text style={pageStyles.tabPanelTitle}>Notifications</Text>
                  <ToggleRow
                    label="Session Reminders"
                    description="Get reminders 24 hours and 1 hour before each session."
                    value={sessionReminders}
                    onValueChange={setSessionReminders}
                  />
                  <ToggleRow
                    label="Push Notifications"
                    description="Receive push notifications for new messages and CHW updates."
                    value={pushNotifications}
                    onValueChange={setPushNotifications}
                  />
                </View>
              )}

              {activeTab === 'privacy' && (
                // QA batch (2026-07-14) Part 20: the four fake toggles this
                // panel used to show (two-factor, biometric, AI
                // transcription consent, research sharing) were local
                // `useState` only and never persisted — removed along with
                // the bottom Privacy & Security card's copy of the same
                // toggles. This panel is unreachable today (`'privacy'` is
                // not in TAB_ORDER above) but kept type-checked for a future
                // restore once real settings are backed by an endpoint.
                <View style={pageStyles.tabPanel}>
                  <Text style={pageStyles.tabPanelTitle}>Privacy & Security</Text>
                  <View style={pageStyles.privacyNote}>
                    <Shield size={14} color="#6B7280" />
                    <Text style={pageStyles.privacyNoteText}>
                      Your health information is protected under HIPAA and California CMIA. Compass never sells or shares your data without your consent.
                    </Text>
                  </View>
                </View>
              )}

              {activeTab === 'language' && (
                <View style={pageStyles.tabPanel}>
                  <Text style={pageStyles.tabPanelTitle}>Preferred Language</Text>
                  {LANGUAGE_OPTIONS.map((opt) => {
                    const isCurrent = profile?.primaryLanguage === opt.value;
                    return (
                      <Pressable
                        key={opt.value}
                        onPress={() => void handleSaveField('Language', { primaryLanguage: opt.value })}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: isCurrent }}
                        accessibilityLabel={opt.label}
                        style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
                          pageStyles.languageRow,
                          isCurrent && pageStyles.languageRowActive,
                          (pressed || hovered) && !isCurrent && { backgroundColor: '#F9FAFB' },
                        ]}
                      >
                        <Globe size={16} color="#6B7280" />
                        <Text style={pageStyles.languageLabel}>{opt.label}</Text>
                        {isCurrent && <Text style={pageStyles.languageCurrentTag}>Current</Text>}
                      </Pressable>
                    );
                  })}
                </View>
              )}

              {activeTab === 'help' && (
                <View style={pageStyles.tabPanel}>
                  <Text style={pageStyles.tabPanelTitle}>Help & Support</Text>
                  <ContactCard
                    icon={<MessageSquare size={18} color="#10B981" />}
                    iconBgColor="#D1FAE5"
                    title="Message Your CHW"
                    description="Send a message directly to your assigned Community Health Worker."
                    onPress={() => Alert.alert('Navigate', 'Switch to the Messages tab to contact your CHW.')}
                  />
                  <View style={{ height: 8 }} />
                  <ContactCard
                    icon={<HelpCircle size={18} color="#2563EB" />}
                    iconBgColor="#DBEAFE"
                    title="FAQs"
                    description="Find answers to common questions about Compass."
                    onPress={() =>
                      Linking.openURL('https://joincompasschw.com/faq').catch(() =>
                        Alert.alert(
                          'Could not open FAQ',
                          'Visit https://joincompasschw.com/faq from your browser.',
                        ),
                      )
                    }
                  />
                </View>
              )}
            </View>
          </Card>

          {/* Text messages (SMS Output Spec 1) — sits between the Profile card
              and the Privacy & Security summary. Hidden entirely for
              placeholder-phone members. */}
          <TextMessagesCard profile={profile} />

          {/* Bottom: 2-col grid (always visible) */}
          <View style={pageStyles.bottomGrid}>
            {/* Privacy & Security summary card.
                QA batch (2026-07-14) Part 20: the four toggles that used to
                render here (two-factor, biometric, AI session transcription
                consent, share data for research) were local `useState`
                only — never wired to any backend setting — so they were
                misleading fake controls. The real per-session transcription
                consent is captured in the session consent flow, not here.
                Removed; Deactivate/Delete remain the card's only actions. */}
            <Card style={[pageStyles.bottomCard, isPhone && pageStyles.bottomCardPhone]}>
              <Text style={pageStyles.bottomCardTitle}>Privacy & Security</Text>
              <Text style={pageStyles.bottomCardSubtitle}>Your data is protected. You're in control.</Text>

              {/* Real SMS 2FA opt-in (Spec 2) — only for a verified,
                  non-sentinel phone. PATCHes User.sms_2fa_enabled. */}
              {twoFaPhoneEligible && (
                <View style={pageStyles.twoFaRow}>
                  <ToggleRow
                    label="Two-factor authentication"
                    description="Text a code to your phone each time you sign in, for an extra layer of security."
                    value={smsTwoFactorEnabled}
                    onValueChange={(v) => void handleToggleSmsTwoFactor(v)}
                  />
                </View>
              )}

              <Pressable
                onPress={() => void handleDeactivateAccount()}
                disabled={isDeactivating}
                accessibilityRole="button"
                accessibilityLabel="Deactivate my account"
                style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
                  pageStyles.outlineBtn,
                  (pressed || hovered) && pageStyles.outlineBtnHover,
                  isDeactivating && { opacity: 0.6 },
                ]}
              >
                <ShieldOff size={16} color="#B45309" />
                <Text style={pageStyles.outlineBtnText}>
                  {isDeactivating ? 'Deactivating…' : 'Deactivate my account'}
                </Text>
              </Pressable>

              <Pressable
                onPress={() => setIsDeleteModalVisible(true)}
                accessibilityRole="button"
                accessibilityLabel="Delete my account"
                style={({ pressed }: { pressed: boolean }) => [
                  pageStyles.dangerLink,
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Trash2 size={16} color="#DC2626" />
                <Text style={pageStyles.dangerLinkText}>Delete my account</Text>
              </Pressable>
            </Card>

            {/* Need help card — slimmed to just "Sign out of this device"
                (QA batch 2026-07-14, Part 22). */}
            <Card style={[pageStyles.bottomCard, isPhone && pageStyles.bottomCardPhone, pageStyles.helpCard]}>
              {/* v2: Need help? contact section — commented out until support channels are real (Akram 2026-07-14). Restore by uncommenting.
              <Text style={pageStyles.bottomCardTitle}>Need help?</Text>
              <Text style={pageStyles.bottomCardSubtitle}>We're here for you 24/7</Text>

              <View style={{ gap: 8, marginTop: 8 }}>
                <ContactCard
                  icon={<Phone size={20} color="#2563EB" />}
                  iconBgColor="#DBEAFE"
                  title="Call support"
                  description="Mon–Sun 7 AM – 9 PM PT"
                  onPress={() =>
                    Linking.openURL('tel:+18005552667').catch(() =>
                      Alert.alert(
                        'Could not open dialer',
                        'Call (800) 555-COMPASS from your phone.',
                      ),
                    )
                  }
                />
                <ContactCard
                  icon={<MessageSquare size={20} color="#10B981" />}
                  iconBgColor="#D1FAE5"
                  title="Text us"
                  description="(800) 555-COMPASS · usually replies in 10 min"
                  onPress={() =>
                    Linking.openURL('sms:+18005552667').catch(() =>
                      Alert.alert(
                        'Could not open SMS app',
                        'Text (800) 555-COMPASS from your phone.',
                      ),
                    )
                  }
                />
                <ContactCard
                  icon={<Mail size={20} color="#7C3AED" />}
                  iconBgColor="#EDE9FE"
                  title="Email us"
                  description="help@joincompasschw.com"
                  onPress={() =>
                    Linking.openURL('mailto:help@joincompasschw.com').catch(() =>
                      Alert.alert(
                        'Could not open email app',
                        'Email help@joincompasschw.com from your inbox.',
                      ),
                    )
                  }
                />
              </View>
              */}

              <Pressable
                onPress={handleLogout}
                accessibilityRole="button"
                accessibilityLabel="Sign out of your account"
                style={({ pressed }: { pressed: boolean }) => [
                  pageStyles.dangerLink,
                  { marginTop: 16 },
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Text style={pageStyles.dangerLinkText}>Sign out of this device</Text>
              </Pressable>
            </Card>
          </View>
        </View>
      </ScrollView>

      <DeleteAccountModal
        visible={isDeleteModalVisible}
        onClose={() => setIsDeleteModalVisible(false)}
        onConfirm={handleDeleteAccountConfirm}
        errorMessage={deleteErrorMessage}
      />
    </AppShell>
  );
}

// ─── Page styles ──────────────────────────────────────────────────────────────

const profileStyles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    gap:           32,
    flexWrap:      'wrap',
  } as ViewStyle,
  avatarCol: {
    width:      192,
    alignItems: 'center',
  } as ViewStyle,
  photoHint: {
    marginTop:  8,
    fontSize:   11,
    color:      '#6B7280',
    alignSelf:  'flex-start',
  } as TextStyle,
  formCol: {
    flex:     1,
    minWidth: 320,
  } as ViewStyle,
  // Epic K (mobile web polish): same fix as pageStyles.bottomCardPhone —
  // 320px minWidth exceeds a phone viewport's available content width.
  formColPhone: {
    minWidth: 0,
  } as ViewStyle,
  formTitle: {
    fontSize:     16,
    fontWeight:   '600',
    color:        '#111827',
    marginBottom: 16,
  } as TextStyle,
});

const pageStyles = StyleSheet.create({
  scroll: { flex: 1 } as ViewStyle,
  scrollContent: { flexGrow: 1 } as ViewStyle,
  pageWrap: {
    padding: 32,
    width:   '100%',
    alignSelf: 'stretch',
  } as ViewStyle,
  // Epic K (mobile web polish): tighter side padding at phone width — see
  // `isPhone` above. Matches MemberFindScreen's pageContainerPhone.
  pageWrapPhone: {
    paddingHorizontal: 16,
    paddingVertical: 20,
  } as ViewStyle,

  // Main settings card
  mainCard: {
    padding:  0,
    overflow: 'hidden',
  } as ViewStyle,
  tabContent: {
    padding: 32,
  } as ViewStyle,
  tabPanel: {
    gap: 4,
  } as ViewStyle,
  tabPanelTitle: {
    fontSize:     16,
    fontWeight:   '600',
    color:        '#111827',
    marginBottom: 12,
  } as TextStyle,
  privacyNote: {
    flexDirection:   'row',
    alignItems:      'flex-start',
    gap:             8,
    marginTop:       16,
    backgroundColor: '#F9FAFB',
    borderRadius:    10,
    padding:         12,
  } as ViewStyle,
  privacyNoteText: {
    flex:       1,
    fontSize:   12,
    color:      '#6B7280',
    lineHeight: 16,
  } as TextStyle,
  languageRow: {
    flexDirection:     'row',
    alignItems:        'center',
    gap:               12,
    paddingVertical:   12,
    paddingHorizontal: 8,
    borderRadius:      8,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  } as ViewStyle,
  languageRowActive: {
    backgroundColor: '#ECFDF5',
  } as ViewStyle,
  languageLabel: {
    flex:     1,
    fontSize: 14,
    color:    '#111827',
  } as TextStyle,
  languageCurrentTag: {
    fontSize:          11,
    fontWeight:        '700',
    color:             '#10B981',
    backgroundColor:   '#D1FAE5',
    paddingHorizontal: 8,
    paddingVertical:   3,
    borderRadius:      999,
  } as TextStyle,

  // Bottom 2-col grid (always visible)
  bottomGrid: {
    flexDirection: 'row',
    gap:           20,
    marginTop:     24,
    flexWrap:      'wrap',
  } as ViewStyle,
  bottomCard: {
    flex:     1,
    minWidth: 320,
    padding:  24,
  } as ViewStyle,
  // Epic K (mobile web polish): the 320px minWidth above is wider than a
  // phone viewport's available content width even after `bottomGrid`'s
  // flexWrap stacks the cards to one per row (e.g. 360px - 32px padding =
  // 328px is close, but 390px - tighter chrome can still clip) — drop the
  // floor at phone width so `flex: 1` alone governs and the card shrinks to
  // fit instead of forcing the page body to scroll sideways.
  bottomCardPhone: {
    minWidth: 0,
    padding: 16,
  } as ViewStyle,
  helpCard: {
    backgroundColor: '#F0FDF4',
  } as ViewStyle,
  bottomCardTitle: {
    fontSize:   16,
    fontWeight: '600',
    color:      '#111827',
  } as TextStyle,
  bottomCardSubtitle: {
    marginTop: 4,
    fontSize:  12,
    color:     '#6B7280',
  } as TextStyle,
  twoFaRow: {
    marginTop: 4,
  } as ViewStyle,

  // ── Text messages card (SMS Output Spec 1) ────────────────────────────────
  smsCard: {
    marginTop: 24,
    padding:   24,
  } as ViewStyle,
  smsBody: {
    marginTop:  8,
    fontSize:   13,
    color:      '#374151',
    lineHeight: 18,
  } as TextStyle,
  smsButton: {
    marginTop:         14,
    alignSelf:         'flex-start',
    paddingHorizontal: 16,
    paddingVertical:   10,
    borderRadius:      10,
    backgroundColor:   '#10B981',
  } as ViewStyle,
  smsButtonHover: {
    backgroundColor: '#059669',
  } as ViewStyle,
  smsButtonText: {
    fontSize:   13,
    fontWeight: '700',
    color:      '#FFFFFF',
  } as TextStyle,
  smsInput: {
    marginTop:         12,
    width:             160,
    fontSize:          16,
    letterSpacing:     4,
    color:             '#111827',
    backgroundColor:   '#F9FAFB',
    borderWidth:       1,
    borderColor:       '#E5E7EB',
    borderRadius:      8,
    paddingHorizontal: 12,
    paddingVertical:   10,
  } as ViewStyle,
  smsError: {
    marginTop:  10,
    fontSize:   13,
    fontWeight: '500',
    color:      '#DC2626',
  } as TextStyle,
  outlineBtn: {
    flexDirection:     'row',
    alignItems:        'center',
    justifyContent:    'center',
    gap:               8,
    marginTop:         16,
    paddingHorizontal: 16,
    paddingVertical:   10,
    borderRadius:      10,
    borderWidth:       1,
    borderColor:       '#E5E7EB',
    backgroundColor:   '#FFFFFF',
    alignSelf:         'flex-start',
  } as ViewStyle,
  outlineBtnHover: {
    backgroundColor: '#F9FAFB',
  } as ViewStyle,
  outlineBtnText: {
    fontSize:   13,
    fontWeight: '600',
    color:      '#374151',
  } as TextStyle,
  dangerLink: {
    flexDirection:   'row',
    alignItems:      'center',
    gap:             6,
    marginTop:       8,
    paddingVertical: 6,
    alignSelf:       'flex-start',
  } as ViewStyle,
  dangerLinkText: {
    fontSize:   13,
    fontWeight: '600',
    color:      '#DC2626',
  } as TextStyle,
});

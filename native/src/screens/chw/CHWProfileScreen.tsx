/**
 * CHWProfileScreen — Settings, profile, and privacy for the authenticated CHW.
 *
 * Layout matches the MemberSettingsScreen visual language 1:1:
 *   - PageHeader (Settings + subtitle)
 *   - Main Card with underline-style tab strip (Profile / Notifications /
 *     Privacy & Security / Language / Help). Profile is the default tab.
 *   - Profile tab: 192px avatar column + inline-editable form column, plus
 *     specialization multi-select chips below the grid.
 *   - Always-visible bottom 2-column grid:
 *       left: Account & Security (sign out, download data, delete account)
 *       right: Earnings & Payouts (next payout stats + link to EarningsStack)
 *
 * Inline field editing: each row shows label + value + Edit link. Tapping Edit
 * converts that row into a TextInput + Save/Cancel. Avoids the previous
 * all-or-nothing draft-commit pattern.
 *
 * Data: `useChwProfile` (read), `useUpdateChwProfile` (write),
 *        `useChwEarnings` (earnings bottom card).
 *
 * Stubbed fields (backend ChwProfile shape does not expose them yet):
 *   - availableDays (mon…sun chips)
 *   - additionalLanguages (ChwProfile.languages[1+] used as a proxy)
 *   - primaryLanguage (ChwProfile.languages[0] used as a proxy)
 *
 * Intentional divergences from MemberSettingsScreen:
 *   - Bottom-right card is "Earnings & Payouts" (CHW-specific) instead of
 *     "Need help?". The help content is moved to the Help tab.
 *   - Profile tab includes specialization chips and multi-select day chips
 *     that Member Settings does not have (CHW-specific fields).
 *   - Bio is multi-line (TextInput multiline=true) instead of a single-line
 *     EditableField, to match the existing CHW UX expectation.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import {
  DollarSign,
  Download,
  Globe,
  HelpCircle,
  Mail,
  MessageSquare,
  Shield,
  Trash2,
} from 'lucide-react-native';
import { useNavigation } from '@react-navigation/native';

import { useAuth } from '../../context/AuthContext';
import {
  useChwProfile,
  useChwAvailability,
  useUpdateChwAvailability,
  useUpdateChwProfile,
  useChwEarnings,
  useDeleteAccount,
} from '../../hooks/useApiQueries';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { AppShell, PageHeader, Card, ProfilePictureEditor } from '../../components/ui';
import { colors as tokens } from '../../theme/tokens';

// ─── Types & constants ────────────────────────────────────────────────────────

type SettingsTab = 'profile' | 'notifications' | 'privacy' | 'language' | 'help';

const TAB_LABELS: Record<SettingsTab, string> = {
  profile:       'Profile',
  notifications: 'Notifications',
  privacy:       'Privacy & Security',
  language:      'Language',
  help:          'Help',
};

const TAB_ORDER: SettingsTab[] = ['profile', 'notifications', 'privacy', 'language', 'help'];

const LANGUAGE_OPTIONS = [
  { value: 'English',    label: 'English' },
  { value: 'Spanish',    label: 'Español' },
  { value: 'Chinese',    label: '中文' },
  { value: 'Tagalog',    label: 'Tagalog' },
  { value: 'Vietnamese', label: 'Tiếng Việt' },
  { value: 'Korean',     label: '한국어' },
  { value: 'Arabic',     label: 'العربية' },
  { value: 'Cantonese',  label: '粵語' },
];

type Vertical = 'housing' | 'food' | 'mental_health' | 'transportation' | 'healthcare' | 'employment';

const VERTICAL_LABELS: Record<Vertical, string> = {
  housing:        'Housing',
  food:           'Food Security',
  mental_health:  'Mental Health',
  transportation: 'Transportation',
  healthcare:     'Healthcare Access',
  employment:     'Employment',
};

const ALL_VERTICALS: Vertical[] = ['housing', 'food', 'mental_health', 'transportation', 'healthcare', 'employment'];

const VERTICAL_COLORS: Record<Vertical, string> = {
  housing:        '#3B82F6',
  food:           '#F59E0B',
  mental_health:  '#8B5CF6',
  transportation: '#14B8A6',
  healthcare:     '#06B6D4',
  employment:     '#6366F1',
};

type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

const DAY_LABELS: Record<DayKey, string> = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
};

const ALL_DAYS: DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

// ─── Background check (mirrors backend _BACKGROUND_CHECK_STATUSES) ─────────────
type BackgroundCheckStatus = 'not_started' | 'pending' | 'clear' | 'consider';

const BACKGROUND_CHECK_OPTIONS: BackgroundCheckStatus[] = [
  'not_started',
  'pending',
  'clear',
  'consider',
];

const BACKGROUND_CHECK_LABELS: Record<BackgroundCheckStatus, string> = {
  not_started: 'Not Started',
  pending:     'Pending',
  clear:       'Clear',
  consider:    'Consider',
};

const BACKGROUND_CHECK_COLORS: Record<BackgroundCheckStatus, string> = {
  not_started: '#6B7280', // gray
  pending:     '#F59E0B', // amber
  clear:       '#10B981', // green
  consider:    '#EF4444', // red
};

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
  /** Render a multiline TextInput (for Bio). */
  multiline?:   boolean;
  /** When set, caps input length and shows a live "N/max" character counter
   * (e.g. Bio — Epic C3, capped at 120 chars both client- and server-side). */
  maxLength?:   number;
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
  multiline = false,
  maxLength,
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
      <View style={[fieldStyles.row, multiline && fieldStyles.rowMultiline]}>
        <Text style={fieldStyles.label}>{label}</Text>
        <View style={fieldStyles.inputWrap}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={placeholder ?? label}
            placeholderTextColor="#9CA3AF"
            keyboardType={keyboardType}
            editable={!saving}
            autoFocus
            multiline={multiline}
            maxLength={maxLength}
            style={[fieldStyles.input, multiline && fieldStyles.inputMultiline]}
            accessibilityLabel={label}
          />
          {maxLength != null && (
            <Text
              style={fieldStyles.counter}
              accessibilityLabel={`${label} character count`}
            >
              {draft.length}/{maxLength}
            </Text>
          )}
        </View>
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
      <Text style={fieldStyles.value} numberOfLines={multiline ? 3 : 1}>
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
  rowMultiline: {
    alignItems: 'flex-start',
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
  inputMultiline: {
    minHeight:         80,
    textAlignVertical: 'top',
  } as ViewStyle,
  inputWrap: {
    flex: 1,
    gap:  4,
  } as ViewStyle,
  counter: {
    fontSize:   11,
    fontWeight: '500',
    color:      '#9CA3AF',
    alignSelf:  'flex-end',
  } as TextStyle,
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

// ─── ToggleRow (Privacy + Notifications tabs and bottom card) ─────────────────

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

// ─── ContactCard (Help tab) ───────────────────────────────────────────────────

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
    flexDirection:   'row',
    alignItems:      'center',
    gap:             12,
    padding:         12,
    borderRadius:    12,
    borderWidth:     1,
    borderColor:     '#E5E7EB',
    backgroundColor: '#FFFFFF',
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

// ─── ChipRow (multi-select chips for specializations and available days) ───────

interface ChipRowProps<T extends string> {
  items:     T[];
  labels:    Record<T, string>;
  selected:  T[];
  colors?:   Record<T, string>;
  onChange:  (next: T[]) => void;
}

function ChipRow<T extends string>({
  items,
  labels,
  selected,
  colors: chipColors,
  onChange,
}: ChipRowProps<T>): React.JSX.Element {
  const toggle = (item: T): void => {
    const isSelected = selected.includes(item);
    onChange(
      isSelected
        ? selected.filter((s) => s !== item)
        : [...selected, item],
    );
  };

  return (
    <View style={chipStyles.row}>
      {items.map((item) => {
        const isSelected = selected.includes(item);
        const accent = chipColors?.[item] ?? '#10B981';
        return (
          <Pressable
            key={item}
            onPress={() => toggle(item)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: isSelected }}
            accessibilityLabel={labels[item]}
            style={[
              chipStyles.chip,
              isSelected
                ? { backgroundColor: accent + '20', borderColor: accent }
                : chipStyles.chipInactive,
            ]}
          >
            <Text
              style={[
                chipStyles.chipText,
                { color: isSelected ? accent : '#6B7280' },
              ]}
            >
              {labels[item]}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const chipStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap:      'wrap',
    gap:           8,
    marginTop:     8,
  } as ViewStyle,
  chip: {
    paddingHorizontal: 12,
    paddingVertical:   6,
    borderRadius:      100,
    borderWidth:       1,
  } as ViewStyle,
  chipInactive: {
    backgroundColor: '#F9FAFB',
    borderColor:     '#E5E7EB',
  } as ViewStyle,
  chipText: {
    fontSize:   13,
    fontWeight: '600',
  } as TextStyle,
});

// ─── Screen ───────────────────────────────────────────────────────────────────

/**
 * CHW Settings screen — uses the same polished tab + inline-edit visual
 * language as MemberSettingsScreen, with CHW-specific fields and a bottom
 * Earnings & Payouts summary card instead of the member's "Need help?" card.
 */
export function CHWProfileScreen(): React.JSX.Element {
  const { userName, logout, clearAfterDeletion } = useAuth();
  const deleteAccount = useDeleteAccount();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const navigation = useNavigation<any>();
  const profileQuery = useChwProfile();
  const updateProfile = useUpdateChwProfile();
  const earningsQuery = useChwEarnings();

  const chwInitials = (userName ?? 'C')
    .split(' ')
    .slice(0, 2)
    .map((p) => p[0] ?? '')
    .join('')
    .toUpperCase();

  const [activeTab, setActiveTab] = useState<SettingsTab>('profile');
  const [editingField, setEditingField] = useState<string | null>(null);

  const profile = profileQuery.data;

  // ── Derived / stubbed profile fields ─────────────────────────────────────
  // primaryLanguage and additionalLanguages are not separate fields on
  // ChwProfile — use languages[0] / languages[1+] as a proxy until the backend
  // exposes them as first-class fields.
  const primaryLanguage   = profile?.languages?.[0] ?? '';
  const additionalLangs   = (profile?.languages ?? []).slice(1);

  // Specializations come directly from the profile.
  const [specializations, setSpecializations] = useState<Vertical[]>(
    () => (profile?.specializations ?? []) as Vertical[],
  );

  // Stubbed fields — not yet in ChwProfile shape.
  const [availableDays, setAvailableDays] = useState<DayKey[]>(['mon', 'tue', 'wed', 'thu', 'fri']);

  // ── Availability (working hours) — wired to GET/PUT /chw/availability ────────
  const availabilityQuery = useChwAvailability();
  const updateAvailability = useUpdateChwAvailability();
  const [workStart, setWorkStart] = useState('09:00');
  const [workEnd, setWorkEnd] = useState('17:00');
  const availabilityLoadedRef = useRef(false);

  // Transient "Availability saved ✓" confirmation shown next to the Save
  // Availability button. useUpdateChwAvailability already surfaces failures
  // via its onError alert (useApiQueries.ts) — this fills the missing
  // success-side feedback so a save doesn't look like a no-op.
  const [availabilitySaved, setAvailabilitySaved] = useState(false);
  const availabilitySavedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear any pending confirmation-hide timer on unmount to avoid setting
  // state on an unmounted component.
  useEffect(() => {
    return () => {
      if (availabilitySavedTimerRef.current) clearTimeout(availabilitySavedTimerRef.current);
    };
  }, []);

  // Load the saved windows into the editor once (days + a single hours window).
  useEffect(() => {
    const windows = availabilityQuery.data?.availabilityWindows;
    if (!windows || availabilityLoadedRef.current) return;
    const days = (Object.keys(windows) as DayKey[]).filter((d) => ALL_DAYS.includes(d));
    if (days.length > 0) {
      setAvailableDays(days);
      const [s, e] = (windows[days[0]] ?? '').split('-');
      if (s && e) {
        setWorkStart(s);
        setWorkEnd(e);
      }
    }
    availabilityLoadedRef.current = true;
  }, [availabilityQuery.data]);

  const handleSaveAvailability = useCallback(async () => {
    // One shared hours window applied to each selected day.
    const windows: Record<string, string> = {};
    for (const d of availableDays) windows[d] = `${workStart}-${workEnd}`;
    try {
      await updateAvailability.mutateAsync(windows);
      // Success feedback next to the button — fades on its own after 3s.
      // Reset any in-flight hide-timer so back-to-back saves each get the
      // full display duration instead of an early cutoff.
      if (availabilitySavedTimerRef.current) clearTimeout(availabilitySavedTimerRef.current);
      setAvailabilitySaved(true);
      availabilitySavedTimerRef.current = setTimeout(() => setAvailabilitySaved(false), 3_000);
    } catch {
      // useUpdateChwAvailability surfaces the error via its onError alert.
    }
  }, [availableDays, workStart, workEnd, updateAvailability]);

  // Sync specializations when profile loads.
  React.useEffect(() => {
    if (profile?.specializations != null) {
      setSpecializations(profile.specializations as Vertical[]);
    }
  }, [profile?.specializations]);

  // ── Local-only toggle state ───────────────────────────────────────────────
  const [twoFactor, setTwoFactor]             = useState(true);
  const [biometric, setBiometric]             = useState(false);
  const [showProfileByZip, setShowProfileByZip] = useState(true);
  const [aiDraftSummaries, setAiDraftSummaries] = useState(true);
  const [sessionReminders, setSessionReminders] = useState(true);
  const [memberRequestAlerts, setMemberRequestAlerts] = useState(true);
  const [messageNotifications, setMessageNotifications] = useState(true);
  const [earningsDeposit, setEarningsDeposit] = useState(true);

  /**
   * Save a single field to the backend. On success the query cache is
   * invalidated by the mutation's onSuccess handler. On error an Alert is
   * shown with the field name so the user knows what to retry.
   */
  const handleSaveField = useCallback(
    async (fieldLabel: string, payload: Record<string, unknown>) => {
      try {
        await updateProfile.mutateAsync(payload as Parameters<typeof updateProfile.mutateAsync>[0]);
        setEditingField(null);
      } catch {
        Alert.alert('Could not save', `${fieldLabel} was not updated. Please try again.`);
      }
    },
    [updateProfile],
  );

  /**
   * Save the specializations chip selection. Uses the same mutation endpoint;
   * the chip state is updated optimistically in local state via setSpecializations.
   */
  const handleSaveSpecializations = useCallback(
    async (next: Vertical[]) => {
      setSpecializations(next);
      try {
        await updateProfile.mutateAsync({ specializations: next });
      } catch {
        // Roll back optimistic update.
        setSpecializations((profile?.specializations ?? []) as Vertical[]);
        Alert.alert('Could not save', 'Specializations were not updated. Please try again.');
      }
    },
    [updateProfile, profile?.specializations],
  );

  const handleDeleteAccount = useCallback(() => {
    // Mirrors the member-side flow in MemberSettingsScreen.handleDeleteAccount.
    // Web uses window.confirm because RN-web's Alert.alert doesn't render
    // destructive buttons reliably; native uses Alert.alert.  Either way:
    // Yes → DELETE /auth/users/me → clearAfterDeletion → user lands on the
    // marketing Landing page.  Pear Suite member record (if any) is NOT
    // touched — admin handles Pear-side cleanup manually.
    const proceed = (): void => {
      void (async () => {
        try {
          await deleteAccount.mutateAsync(undefined);
          await clearAfterDeletion();
        } catch (err) {
          const message =
            err instanceof Error && err.message
              ? err.message
              : 'Could not delete your account. Please try again or contact support.';
          if (Platform.OS === 'web' && typeof window !== 'undefined') {
            window.alert(message);
          } else {
            Alert.alert('Deletion failed', message);
          }
        }
      })();
    };

    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      const confirmed = window.confirm(
        'Are you sure you want to delete this account?',
      );
      if (confirmed) proceed();
      return;
    }
    Alert.alert(
      'Delete account',
      'Are you sure you want to delete this account?',
      [
        { text: 'No', style: 'cancel' },
        { text: 'Yes', style: 'destructive', onPress: proceed },
      ],
    );
  }, [deleteAccount, clearAfterDeletion]);

  const handleDownloadData = useCallback(() => {
    Alert.alert('Data export', 'We will email a copy of your data to you within 24 hours.');
  }, []);

  const handleLogout = useCallback(() => {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign Out', style: 'destructive', onPress: () => void logout() },
    ]);
  }, [logout]);

  const shellUserBlock = {
    initials: chwInitials,
    name:     userName ?? 'CHW',
    role:     'CHW' as const,
  };

  if (profileQuery.isLoading) {
    return (
      <AppShell role="chw" activeKey="settings" userBlock={shellUserBlock}>
        <LoadingSkeleton variant="card" />
        <LoadingSkeleton variant="rows" rows={5} />
      </AppShell>
    );
  }

  const earnings = earningsQuery.data;

  return (
    <AppShell role="chw" activeKey="settings" userBlock={shellUserBlock}>
      <StatusBar barStyle="dark-content" backgroundColor={tokens.pageBg} />
      <ScrollView
        style={pageStyles.scroll}
        contentContainerStyle={pageStyles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={pageStyles.pageWrap}>
          <PageHeader
            title="Settings"
            subtitle="Manage your profile, privacy, and payout information"
          />

          {/* Main card with tab strip */}
          <Card style={pageStyles.mainCard}>
            <TabBar active={activeTab} onChange={setActiveTab} />

            <View style={pageStyles.tabContent}>

              {/* ── Profile tab ─────────────────────────────────────────── */}
              {activeTab === 'profile' && (
                <>
                  <View style={profileStyles.grid}>
                    {/* Avatar column */}
                    <View style={profileStyles.avatarCol}>
                      <ProfilePictureEditor
                        currentUrl={profile?.profilePictureUrl ?? null}
                        role="chw"
                        size={128}
                        initials={chwInitials}
                        initialsBackground="#3D5A3E"
                        onChange={() => {
                          // onChange fires after the hook invalidates the query —
                          // profileQuery will automatically refetch and re-render.
                        }}
                      />
                      <Text style={profileStyles.photoHint}>JPEG/PNG, max 5MB</Text>
                    </View>

                    {/* Form column */}
                    <View style={profileStyles.formCol}>
                      <Text style={profileStyles.formTitle}>Profile information</Text>

                      <EditableField
                        label="Full Name"
                        value={profile?.name ?? ''}
                        isEditing={editingField === 'name'}
                        onEditStart={() => setEditingField('name')}
                        onEditCancel={() => setEditingField(null)}
                        onSave={(v) => handleSaveField('Full Name', { name: v })}
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
                        label="Phone"
                        value={profile?.phone ?? ''}
                        keyboardType="phone-pad"
                        isEditing={editingField === 'phone'}
                        onEditStart={() => setEditingField('phone')}
                        onEditCancel={() => setEditingField(null)}
                        onSave={(v) => handleSaveField('Phone', { phone: v })}
                      />
                      <EditableField
                        label="ZIP Code"
                        value={profile?.zipCode ?? ''}
                        placeholder="90033"
                        keyboardType="default"
                        isEditing={editingField === 'serviceAreaZips'}
                        onEditStart={() => setEditingField('serviceAreaZips')}
                        onEditCancel={() => setEditingField(null)}
                        onSave={(v) => handleSaveField('ZIP Code', { zipCode: v.split(',')[0]?.trim() ?? v })}
                      />
                      <EditableField
                        label="Primary Language"
                        value={primaryLanguage}
                        isEditing={editingField === 'primaryLanguage'}
                        onEditStart={() => setEditingField('primaryLanguage')}
                        onEditCancel={() => setEditingField(null)}
                        onSave={async (v) => {
                          // Prepend new primary language, keep rest.
                          const rest = additionalLangs.filter((l) => l !== v);
                          await handleSaveField('Primary Language', { languages: [v, ...rest] });
                        }}
                      />
                      <EditableField
                        label="Additional Languages"
                        value={additionalLangs.join(', ')}
                        placeholder="Spanish, Vietnamese…"
                        isEditing={editingField === 'additionalLanguages'}
                        onEditStart={() => setEditingField('additionalLanguages')}
                        onEditCancel={() => setEditingField(null)}
                        onSave={async (v) => {
                          const extras = v
                            .split(',')
                            .map((s) => s.trim())
                            .filter(Boolean);
                          await handleSaveField('Additional Languages', {
                            languages: [primaryLanguage, ...extras].filter(Boolean),
                          });
                        }}
                      />
                      <EditableField
                        label="Years of Experience"
                        value={profile?.yearsExperience != null ? String(profile.yearsExperience) : ''}
                        keyboardType="numeric"
                        isEditing={editingField === 'yearsExperience'}
                        onEditStart={() => setEditingField('yearsExperience')}
                        onEditCancel={() => setEditingField(null)}
                        onSave={(v) =>
                          handleSaveField('Years of Experience', { yearsExperience: Number(v) || 0 })
                        }
                      />
                      <EditableField
                        label="Bio"
                        value={profile?.bio ?? ''}
                        placeholder="Tell members about your background and specializations…"
                        multiline
                        maxLength={120}
                        isEditing={editingField === 'bio'}
                        onEditStart={() => setEditingField('bio')}
                        onEditCancel={() => setEditingField(null)}
                        onSave={(v) => handleSaveField('Bio', { bio: v })}
                      />

                      {/* Availability — wired to /chw/availability. Members can
                          only book slots inside these days + hours. */}
                      <View style={profileStyles.chipsSection}>
                        <Text style={profileStyles.chipsSectionLabel}>Available Days</Text>
                        <ChipRow<DayKey>
                          items={ALL_DAYS}
                          labels={DAY_LABELS}
                          selected={availableDays}
                          onChange={setAvailableDays}
                        />
                        <Text style={[profileStyles.chipsSectionLabel, { marginTop: 12 }]}>
                          Working hours
                        </Text>
                        <View style={availStyles.hoursRow}>
                          <TextInput
                            style={availStyles.hoursInput}
                            value={workStart}
                            onChangeText={setWorkStart}
                            placeholder="09:00"
                            placeholderTextColor="#9CA3AF"
                            accessibilityLabel="Working hours start, 24-hour HH:MM"
                          />
                          <Text style={availStyles.hoursDash}>to</Text>
                          <TextInput
                            style={availStyles.hoursInput}
                            value={workEnd}
                            onChangeText={setWorkEnd}
                            placeholder="17:00"
                            placeholderTextColor="#9CA3AF"
                            accessibilityLabel="Working hours end, 24-hour HH:MM"
                          />
                        </View>
                        <Text style={profileStyles.stubNote}>
                          24-hour time (e.g. 09:00–17:00). Members can only book
                          slots within your available days + hours.
                        </Text>
                        <View style={availStyles.saveRow}>
                          <Pressable
                            onPress={() => void handleSaveAvailability()}
                            disabled={updateAvailability.isPending}
                            style={[
                              availStyles.saveBtn,
                              updateAvailability.isPending && { opacity: 0.6 },
                            ]}
                            accessibilityRole="button"
                            accessibilityLabel="Save availability"
                          >
                            <Text style={availStyles.saveBtnText}>
                              {updateAvailability.isPending ? 'Saving…' : 'Save availability'}
                            </Text>
                          </Pressable>
                          {availabilitySaved ? (
                            <Text
                              style={availStyles.savedConfirmation}
                              accessibilityRole="alert"
                              accessibilityLiveRegion="polite"
                            >
                              Availability saved ✓
                            </Text>
                          ) : null}
                        </View>
                      </View>
                    </View>
                  </View>

                  {/* Specialization chips — full-width below the grid */}
                  <View style={profileStyles.specializationsSection}>
                    <Text style={profileStyles.formTitle}>Specializations</Text>
                    <ChipRow<Vertical>
                      items={ALL_VERTICALS}
                      labels={VERTICAL_LABELS}
                      selected={specializations}
                      colors={VERTICAL_COLORS}
                      onChange={(next) => void handleSaveSpecializations(next)}
                    />
                  </View>

                  {/* Compliance — HIPAA training, certification, background check */}
                  <View style={profileStyles.specializationsSection}>
                    <Text style={profileStyles.formTitle}>Compliance</Text>
                    <ToggleRow
                      label="HIPAA training completed"
                      description="Confirms you have completed required HIPAA privacy & security training."
                      value={profile?.hipaaTrainingCompleted ?? false}
                      onValueChange={(v) =>
                        void handleSaveField('HIPAA Training', { hipaaTrainingCompleted: v })
                      }
                    />
                    <EditableField
                      label="CHW Certification"
                      value={profile?.chwCertification ?? ''}
                      placeholder="e.g. California CHW Certification #12345"
                      isEditing={editingField === 'chwCertification'}
                      onEditStart={() => setEditingField('chwCertification')}
                      onEditCancel={() => setEditingField(null)}
                      onSave={(v) =>
                        handleSaveField('CHW Certification', {
                          chwCertification: v.trim() || null,
                        })
                      }
                    />
                    <View style={profileStyles.chipsSection}>
                      <Text style={profileStyles.chipsSectionLabel}>Background Check</Text>
                      <View style={chipStyles.row}>
                        {BACKGROUND_CHECK_OPTIONS.map((status) => {
                          const isSelected =
                            (profile?.backgroundCheckStatus ?? 'not_started') === status;
                          const color = BACKGROUND_CHECK_COLORS[status];
                          return (
                            <Pressable
                              key={status}
                              onPress={() =>
                                void handleSaveField('Background Check', {
                                  backgroundCheckStatus: status,
                                })
                              }
                              accessibilityRole="radio"
                              accessibilityState={{ checked: isSelected }}
                              accessibilityLabel={BACKGROUND_CHECK_LABELS[status]}
                              style={[
                                chipStyles.chip,
                                isSelected
                                  ? { backgroundColor: `${color}20`, borderColor: color }
                                  : chipStyles.chipInactive,
                              ]}
                            >
                              <Text
                                style={[
                                  chipStyles.chipText,
                                  { color: isSelected ? color : '#6B7280' },
                                ]}
                              >
                                {BACKGROUND_CHECK_LABELS[status]}
                              </Text>
                            </Pressable>
                          );
                        })}
                      </View>
                    </View>
                  </View>
                </>
              )}

              {/* ── Notifications tab ───────────────────────────────────── */}
              {activeTab === 'notifications' && (
                <View style={pageStyles.tabPanel}>
                  <Text style={pageStyles.tabPanelTitle}>Notifications</Text>
                  <ToggleRow
                    label="New session reminders"
                    description="Get reminders 24 hours and 1 hour before each upcoming session."
                    value={sessionReminders}
                    onValueChange={setSessionReminders}
                  />
                  <ToggleRow
                    label="New member request alerts"
                    description="Notify me when a member requests to connect with me."
                    value={memberRequestAlerts}
                    onValueChange={setMemberRequestAlerts}
                  />
                  <ToggleRow
                    label="Message notifications"
                    description="Push notifications for new messages from members."
                    value={messageNotifications}
                    onValueChange={setMessageNotifications}
                  />
                  <ToggleRow
                    label="Earnings deposit confirmations"
                    description="Notify me when a payout is initiated to my bank account."
                    value={earningsDeposit}
                    onValueChange={setEarningsDeposit}
                  />
                </View>
              )}

              {/* ── Privacy & Security tab ──────────────────────────────── */}
              {activeTab === 'privacy' && (
                <View style={pageStyles.tabPanel}>
                  <Text style={pageStyles.tabPanelTitle}>Privacy & Security</Text>
                  <ToggleRow
                    label="Two-factor authentication"
                    description="SMS code on every login for an added layer of protection."
                    value={twoFactor}
                    onValueChange={setTwoFactor}
                  />
                  <ToggleRow
                    label="Biometric login"
                    description="Use Face ID or fingerprint to sign in on your device."
                    value={biometric}
                    onValueChange={setBiometric}
                  />
                  <ToggleRow
                    label="Show profile to members searching by ZIP"
                    description="Members can discover and request you by service area ZIP."
                    value={showProfileByZip}
                    onValueChange={setShowProfileByZip}
                  />
                  <ToggleRow
                    label="Allow AI to draft session summaries"
                    description="AI suggests session notes after each session. You review and approve before saving."
                    value={aiDraftSummaries}
                    onValueChange={setAiDraftSummaries}
                  />
                  <View style={pageStyles.privacyNote}>
                    <Shield size={14} color="#6B7280" />
                    <Text style={pageStyles.privacyNoteText}>
                      Member health information is protected under HIPAA and California CMIA.
                      Compass never sells or shares data without explicit consent.
                    </Text>
                  </View>
                </View>
              )}

              {/* ── Language tab ────────────────────────────────────────── */}
              {activeTab === 'language' && (
                <View style={pageStyles.tabPanel}>
                  <Text style={pageStyles.tabPanelTitle}>Primary Language</Text>
                  {LANGUAGE_OPTIONS.map((opt) => {
                    const isCurrent = primaryLanguage === opt.value;
                    return (
                      <Pressable
                        key={opt.value}
                        onPress={() =>
                          void handleSaveField('Primary Language', {
                            languages: [opt.value, ...additionalLangs.filter((l) => l !== opt.value)],
                          })
                        }
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

              {/* ── Help tab ────────────────────────────────────────────── */}
              {activeTab === 'help' && (
                <View style={pageStyles.tabPanel}>
                  <Text style={pageStyles.tabPanelTitle}>Help & Support</Text>
                  <ContactCard
                    icon={<MessageSquare size={18} color="#10B981" />}
                    iconBgColor="#D1FAE5"
                    title="Message Support"
                    description="Send a message to the Compass support team. Typically responds within a few hours."
                    onPress={() =>
                      Alert.alert('Support', 'Email help@joincompasschw.com or use the in-app chat.')
                    }
                  />
                  <View style={{ height: 8 }} />
                  <ContactCard
                    icon={<HelpCircle size={18} color="#2563EB" />}
                    iconBgColor="#DBEAFE"
                    title="FAQs"
                    description="Find answers to common questions about Compass CHW."
                    onPress={() => Alert.alert('FAQs', 'FAQ page coming soon.')}
                  />
                  <View style={{ height: 8 }} />
                  <ContactCard
                    icon={<Mail size={18} color="#7C3AED" />}
                    iconBgColor="#EDE9FE"
                    title="Report an Issue"
                    description="Found a bug or have feedback? Let us know."
                    onPress={() =>
                      Alert.alert('Report', 'Email bugs@joincompasschw.com with a description of the issue.')
                    }
                  />
                </View>
              )}
            </View>
          </Card>

          {/* Bottom: 2-col grid (always visible) */}
          <View style={pageStyles.bottomGrid}>
            {/* Account & Security card (left) */}
            <Card style={pageStyles.bottomCard}>
              <Text style={pageStyles.bottomCardTitle}>Account & Security</Text>
              <Text style={pageStyles.bottomCardSubtitle}>Your account settings and data</Text>

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

              <Pressable
                onPress={handleDownloadData}
                accessibilityRole="button"
                accessibilityLabel="Download all my data"
                style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
                  pageStyles.outlineBtn,
                  (pressed || hovered) && pageStyles.outlineBtnHover,
                ]}
              >
                <Download size={16} color="#374151" />
                <Text style={pageStyles.outlineBtnText}>Download all my data</Text>
              </Pressable>

              <Pressable
                onPress={handleDeleteAccount}
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

            {/* Earnings & Payouts card (right) */}
            <Card style={[pageStyles.bottomCard, pageStyles.earningsCard]}>
              <Text style={pageStyles.bottomCardTitle}>Earnings & Payouts</Text>
              <Text style={pageStyles.bottomCardSubtitle}>Your payout summary</Text>

              <View style={earningsStyles.statsGrid}>
                <View style={earningsStyles.statItem}>
                  <Text style={earningsStyles.statLabel}>Pending payout</Text>
                  <Text style={earningsStyles.statValue}>
                    {earnings != null
                      ? `$${earnings.pendingPayout.toFixed(2)}`
                      : earningsQuery.isLoading
                      ? '—'
                      : '—'}
                  </Text>
                </View>
                <View style={earningsStyles.statItem}>
                  <Text style={earningsStyles.statLabel}>This month</Text>
                  <Text style={earningsStyles.statValue}>
                    {earnings != null ? `$${earnings.thisMonth.toFixed(2)}` : '—'}
                  </Text>
                </View>
                <View style={earningsStyles.statItem}>
                  <Text style={earningsStyles.statLabel}>All time</Text>
                  <Text style={earningsStyles.statValue}>
                    {earnings != null ? `$${earnings.allTime.toFixed(2)}` : '—'}
                  </Text>
                </View>
                <View style={earningsStyles.statItem}>
                  <Text style={earningsStyles.statLabel}>Sessions this week</Text>
                  <Text style={earningsStyles.statValue}>
                    {earnings != null ? String(earnings.sessionsThisWeek) : '—'}
                  </Text>
                </View>
              </View>

              <Pressable
                onPress={() => navigation.navigate('EarningsStack')}
                accessibilityRole="button"
                accessibilityLabel="View full earnings and payout dashboard"
                style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
                  earningsStyles.earningsBtn,
                  (pressed || hovered) && earningsStyles.earningsBtnHover,
                ]}
              >
                <DollarSign size={16} color="#10B981" />
                <Text style={earningsStyles.earningsBtnText}>View earnings dashboard</Text>
              </Pressable>
            </Card>
          </View>
        </View>
      </ScrollView>
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
  avatar: {
    width:           128,
    height:          128,
    borderRadius:    64,
    backgroundColor: '#3D5A3E',
    alignItems:      'center',
    justifyContent:  'center',
  } as ViewStyle,
  avatarInitials: {
    fontSize:   36,
    fontWeight: '800',
    color:      '#FFFFFF',
  } as TextStyle,
  changePhotoBtn: {
    marginTop:         12,
    paddingHorizontal: 16,
    paddingVertical:   8,
    borderRadius:      8,
    borderWidth:       1,
    borderColor:       '#E5E7EB',
    backgroundColor:   '#FFFFFF',
    width:             '100%',
    alignItems:        'center',
  } as ViewStyle,
  changePhotoText: {
    fontSize:   13,
    fontWeight: '600',
    color:      '#374151',
  } as TextStyle,
  photoHint: {
    marginTop: 8,
    fontSize:  11,
    color:     '#6B7280',
    alignSelf: 'flex-start',
  } as TextStyle,
  formCol: {
    flex:     1,
    minWidth: 320,
  } as ViewStyle,
  formTitle: {
    fontSize:     16,
    fontWeight:   '600',
    color:        '#111827',
    marginBottom: 16,
  } as TextStyle,
  chipsSection: {
    paddingVertical:   12,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  } as ViewStyle,
  chipsSectionLabel: {
    fontSize:     12,
    fontWeight:   '500',
    color:        '#6B7280',
    marginBottom: 4,
  } as TextStyle,
  stubNote: {
    marginTop:  6,
    fontSize:   11,
    color:      '#9CA3AF',
    fontStyle:  'italic',
  } as TextStyle,
  specializationsSection: {
    marginTop:  24,
    paddingTop: 24,
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
  } as ViewStyle,
});

const earningsStyles = StyleSheet.create({
  statsGrid: {
    flexDirection: 'row',
    flexWrap:      'wrap',
    gap:           12,
    marginTop:     12,
  } as ViewStyle,
  statItem: {
    flex:    1,
    minWidth: 120,
  } as ViewStyle,
  statLabel: {
    fontSize:  11,
    color:     '#6B7280',
    marginBottom: 2,
  } as TextStyle,
  statValue: {
    fontSize:   18,
    fontWeight: '700',
    color:      '#111827',
  } as TextStyle,
  earningsBtn: {
    flexDirection:     'row',
    alignItems:        'center',
    gap:               8,
    marginTop:         16,
    paddingHorizontal: 16,
    paddingVertical:   10,
    borderRadius:      10,
    borderWidth:       1,
    borderColor:       '#10B981',
    backgroundColor:   '#ECFDF5',
    alignSelf:         'flex-start',
  } as ViewStyle,
  earningsBtnHover: {
    backgroundColor: '#D1FAE5',
  } as ViewStyle,
  earningsBtnText: {
    fontSize:   13,
    fontWeight: '600',
    color:      '#10B981',
  } as TextStyle,
});

const pageStyles = StyleSheet.create({
  scroll: { flex: 1 } as ViewStyle,
  scrollContent: { flexGrow: 1 } as ViewStyle,
  pageWrap: {
    // paddingTop intentionally omitted: AppShell's mainContent ScrollView
    // already applies 32px of top padding via contentContainerStyle. Adding
    // it here doubles the gap above "Settings" vs. screens that pass content
    // directly into AppShell without a nested ScrollView (e.g. CHWMembersScreen).
    paddingHorizontal: 32,
    paddingBottom:     32,
    width:             '100%',
    alignSelf:         'stretch',
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
  earningsCard: {
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

const availStyles = StyleSheet.create({
  hoursRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 6,
  },
  hoursInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#111827',
    backgroundColor: '#FFFFFF',
  },
  hoursDash: {
    fontSize: 13,
    color: '#6B7280',
  },
  saveBtn: {
    alignSelf: 'flex-start',
    backgroundColor: '#10B981',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 8,
  },
  saveBtnText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  saveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 12,
    marginTop: 12,
  },
  // C4: transient confirmation shown next to "Save availability" on success.
  // Cleared automatically ~3s after a successful save (see
  // handleSaveAvailability / availabilitySavedTimerRef).
  savedConfirmation: {
    fontSize: 13,
    fontWeight: '600',
    color: '#15803d',
  },
});

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
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
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
  CheckCircle2,
  Clock,
  DollarSign,
  ExternalLink,
  FileText,
  MessageSquare,
  // Globe, HelpCircle, Mail, Shield: only used by the Language / Help /
  // Privacy & Security tab panels, hidden until further notice (QA batch #7)
  // — see TAB_ORDER above. Re-add when those panels are restored.
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react-native';
import { useNavigation } from '@react-navigation/native';
import { useQueryClient } from '@tanstack/react-query';

import { useAuth } from '../../context/AuthContext';
import {
  useChwProfile,
  useChwAvailability,
  useUpdateChwAvailability,
  useUpdateChwProfile,
  useChwEarnings,
  useDeleteAccount,
  useChwChecklist,
  useStartPhoneVerification,
  useConfirmPhoneVerification,
  useSubmitChecklistCredential,
  queryKeys,
  type ChwChecklistItemCode,
  type ChwChecklistItemStatus,
  type ChwProfile,
} from '../../hooks/useApiQueries';
import { ApiError } from '../../api/client';
import { uploadFile, getPresignedUploadUrl } from '../../api/upload';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { AppShell, PageHeader, Card, ProfilePictureEditor } from '../../components/ui';
import { colors as tokens, radius, shadows, spacing } from '../../theme/tokens';

// ─── Types & constants ────────────────────────────────────────────────────────

// QA batch #7 (Wave-2 B1): Notifications / Privacy & Security / Language /
// Help tabs are hidden until further notice — product wants Settings to be
// Profile-only for now. Type + labels are kept as-is (not deleted) so the
// commented-out render blocks below still type-check and can be restored by
// re-adding the tab keys to TAB_ORDER; only TAB_ORDER (what's actually
// shown) is trimmed.
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
  { value: 'Arabic',     label: 'العربية' },
  { value: 'Cantonese',  label: '粵語' },
];

// Epic C5: 'housing' is grandfathered — kept in the type/label/colour maps so
// a CHW's pre-existing "Housing" specialization still renders, but removed
// from ALL_VERTICALS (the offered chip list) below. 'utilities' replaces it
// as the newly selectable specialization.
type Vertical = 'housing' | 'utilities' | 'food' | 'mental_health' | 'transportation' | 'healthcare' | 'employment';

const VERTICAL_LABELS: Record<Vertical, string> = {
  housing:        'Housing',
  utilities:      'Utilities',
  food:           'Food Security',
  mental_health:  'Mental Health',
  transportation: 'Transportation',
  healthcare:     'Healthcare Access',
  employment:     'Employment',
};

// Offered specialization chips — 'housing' is intentionally excluded
// (grandfathered, not newly selectable). See comment on the Vertical type
// above.
const ALL_VERTICALS: Vertical[] = ['utilities', 'food', 'mental_health', 'transportation', 'healthcare', 'employment'];

const VERTICAL_COLORS: Record<Vertical, string> = {
  housing:        '#3B82F6',
  utilities:      '#F97316',
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

// ─── Compliance checklist (Epic D) ─────────────────────────────────────────────
//
// Replaces the old self-editable "Background Check" chip picker (removed —
// a CHW could previously set their own background_check_status to "clear",
// which is now admin-only via PATCH /admin/chws/{id}/background-check).
//
// Mirrors backend/app/routers/credentials.py's _CREDENTIAL_TYPE_META constants
// and app/services/chw_compliance.py's ALL_REQUIREMENT_CODES. Single source of
// display copy/links so ops can update wording/URLs in one place.

/**
 * Real external link / asset URLs (Wave-2 B1, QA batch #4). Mirrors
 * backend/app/routers/credentials.py's HIPAA_TRAINING_LINK /
 * LIABILITY_INSURANCE_LINK / CHW_ATTESTATION_FORM_LINK constants — keep
 * both in sync if either changes.
 */
const HIPAA_TRAINING_LINK = 'https://hipaatraining.us/';
const LIABILITY_INSURANCE_LINK = 'https://www.hpso.com/Get-a-Quote/';
const CHW_ATTESTATION_FORM_LINK = 'https://joincompasschw.com/documents/chw-attestation-form.pdf';

interface ChecklistItemMeta {
  code: ChwChecklistItemCode;
  title: string;
  copy: string;
  linkLabel?: string;
  linkUrl?: string;
  /** True for the 4 document-upload types; false for background_check
   * (no CHW-facing upload UI — status is admin-controlled only). */
  uploadable: boolean;
}

const CHECKLIST_ITEMS: ChecklistItemMeta[] = [
  {
    code: 'hipaa_training',
    title: 'HIPAA Training',
    copy: 'Upload your HIPAA training certificate, or complete a free HIPAA training first.',
    linkLabel: 'Complete free HIPAA training',
    linkUrl: HIPAA_TRAINING_LINK,
    uploadable: true,
  },
  {
    code: 'professional_service_agreement',
    title: 'Professional Service Agreement',
    copy: 'Please sign the Professional Service Agreement and upload.',
    uploadable: true,
  },
  {
    code: 'liability_insurance',
    title: 'Professional Liability Insurance',
    copy: 'Upload your professional liability insurance, or purchase a policy first.',
    linkLabel: 'Purchase a policy',
    linkUrl: LIABILITY_INSURANCE_LINK,
    uploadable: true,
  },
  {
    code: 'chw_certification',
    title: 'CHW Certification',
    copy: 'Upload your CHW certificate, or download the Attestation Form and fill it out before uploading it.',
    linkLabel: 'Download the Attestation Form',
    linkUrl: CHW_ATTESTATION_FORM_LINK,
    uploadable: true,
  },
  {
    code: 'background_check',
    title: 'Background Check',
    copy: 'Your background check is reviewed by Compass. No action is needed from you unless we reach out.',
    uploadable: false,
  },
];

/** Status chip copy/colour, keyed by the raw status string returned by the
 * backend (shared across both the 4 document-upload states and the 4
 * background_check states — the two enums don't overlap in value). */
const CHECKLIST_STATUS_META: Record<
  ChwChecklistItemStatus,
  { label: string; color: string; bg: string; Icon: typeof CheckCircle2 }
> = {
  missing:     { label: 'Missing',     color: '#6B7280', bg: '#F3F4F6', Icon: FileText },
  pending:     { label: 'Pending',     color: '#F59E0B', bg: '#FFFBEB', Icon: Clock },
  verified:    { label: 'Verified',    color: '#10B981', bg: '#ECFDF5', Icon: CheckCircle2 },
  rejected:    { label: 'Rejected',    color: '#EF4444', bg: '#FEF2F2', Icon: XCircle },
  not_started: { label: 'Not Started', color: '#6B7280', bg: '#F3F4F6', Icon: FileText },
  clear:       { label: 'Clear',       color: '#10B981', bg: '#ECFDF5', Icon: CheckCircle2 },
  consider:    { label: 'Consider',    color: '#EF4444', bg: '#FEF2F2', Icon: XCircle },
};

interface ChecklistItemRowProps {
  meta: ChecklistItemMeta;
  status: ChwChecklistItemStatus;
  onUpload: (code: Exclude<ChwChecklistItemCode, 'background_check'>) => void;
  uploading: boolean;
}

function ChecklistItemRow({
  meta,
  status,
  onUpload,
  uploading,
}: ChecklistItemRowProps): React.JSX.Element {
  const statusMeta = CHECKLIST_STATUS_META[status];
  const StatusIcon = statusMeta.Icon;
  const canUpload = meta.uploadable && status !== 'verified';

  return (
    <View style={checklistStyles.row}>
      <View style={checklistStyles.rowHeader}>
        <Text style={checklistStyles.title}>{meta.title}</Text>
        <View
          style={[checklistStyles.statusChip, { backgroundColor: statusMeta.bg }]}
          accessibilityLabel={`${meta.title} status: ${statusMeta.label}`}
        >
          <StatusIcon size={12} color={statusMeta.color} />
          <Text style={[checklistStyles.statusChipText, { color: statusMeta.color }]}>
            {statusMeta.label}
          </Text>
        </View>
      </View>
      <Text style={checklistStyles.copy}>{meta.copy}</Text>
      <View style={checklistStyles.actions}>
        {meta.linkUrl != null && meta.linkLabel != null && (
          <Pressable
            onPress={() => void Linking.openURL(meta.linkUrl!).catch(() => null)}
            accessibilityRole="link"
            accessibilityLabel={meta.linkLabel}
            style={checklistStyles.linkButton}
          >
            <ExternalLink size={12} color="#2563EB" />
            <Text style={checklistStyles.linkText}>{meta.linkLabel}</Text>
          </Pressable>
        )}
        {canUpload && (
          <Pressable
            onPress={() => onUpload(meta.code as Exclude<ChwChecklistItemCode, 'background_check'>)}
            disabled={uploading}
            accessibilityRole="button"
            accessibilityLabel={`Upload ${meta.title}`}
            style={checklistStyles.uploadButton}
          >
            {uploading ? (
              <ActivityIndicator size="small" color="#10B981" />
            ) : (
              <>
                <Upload size={12} color="#10B981" />
                <Text style={checklistStyles.uploadButtonText}>
                  {status === 'missing' ? 'Upload' : 'Re-upload'}
                </Text>
              </>
            )}
          </Pressable>
        )}
      </View>
    </View>
  );
}

const checklistStyles = StyleSheet.create({
  row: {
    paddingVertical:   14,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
    gap:               6,
  } as ViewStyle,
  rowHeader: {
    flexDirection:  'row',
    alignItems:     'center',
    justifyContent: 'space-between',
    gap:            8,
  } as ViewStyle,
  title: {
    fontSize:   14,
    fontWeight: '600',
    color:      '#111827',
    flex:       1,
  } as TextStyle,
  statusChip: {
    flexDirection:     'row',
    alignItems:        'center',
    gap:               4,
    paddingHorizontal: 8,
    paddingVertical:   3,
    borderRadius:      999,
  } as ViewStyle,
  statusChipText: {
    fontSize:   11,
    fontWeight: '700',
  } as TextStyle,
  copy: {
    fontSize:   12,
    color:      '#6B7280',
    lineHeight: 17,
  } as TextStyle,
  actions: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           16,
    marginTop:     2,
  } as ViewStyle,
  linkButton: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           4,
  } as ViewStyle,
  linkText: {
    fontSize:   12,
    fontWeight: '600',
    color:      '#2563EB',
  } as TextStyle,
  uploadButton: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           4,
  } as ViewStyle,
  uploadButtonText: {
    fontSize:   12,
    fontWeight: '700',
    color:      '#10B981',
  } as TextStyle,
});

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

// ─── SignOutConfirmModal ────────────────────────────────────────────────────
//
// On-brand confirm dialog for "Sign out of this device?" — replaces a bare
// `Alert.alert`, which is a documented no-op on react-native-web (see
// src/utils/showAlert.ts's docstring), meaning Sign Out silently did nothing
// on the web app. Mirrors the visual language of AppDialogProvider /
// DeleteAccountModal (scrim + centered/bottom card, RN `Modal` — which DOES
// portal correctly on web) rather than `window.confirm`, which is explicitly
// disallowed for on-brand confirms.

interface SignOutConfirmModalProps {
  visible: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

function SignOutConfirmModal({
  visible,
  onCancel,
  onConfirm,
}: SignOutConfirmModalProps): React.JSX.Element | null {
  if (!visible) return null;

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      onRequestClose={onCancel}
      accessible
      accessibilityViewIsModal
    >
      <View style={signOutModalStyles.overlay} accessibilityViewIsModal accessibilityRole="alert">
        <View style={signOutModalStyles.card}>
          <Text style={signOutModalStyles.title}>Sign out of this device?</Text>
          <Text style={signOutModalStyles.message}>
            You'll need to sign back in to access your CompassCHW account.
          </Text>
          <View style={signOutModalStyles.buttonRow}>
            <Pressable
              onPress={onCancel}
              accessibilityRole="button"
              accessibilityLabel="Cancel sign out"
              style={({ pressed }: { pressed: boolean }) => [
                signOutModalStyles.cancelButton,
                pressed && { opacity: 0.7 },
              ]}
            >
              <Text style={signOutModalStyles.cancelButtonText}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={onConfirm}
              accessibilityRole="button"
              accessibilityLabel="Confirm sign out"
              style={({ pressed }: { pressed: boolean }) => [
                signOutModalStyles.confirmButton,
                pressed && { opacity: 0.85 },
              ]}
            >
              <Text style={signOutModalStyles.confirmButtonText}>Sign Out</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const signOutModalStyles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  } as ViewStyle,
  card: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: tokens.cardBg,
    borderRadius: radius.lg,
    padding: spacing.xl,
    gap: spacing.md,
    ...shadows.card,
  } as ViewStyle,
  title: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 17,
    color: tokens.textPrimary,
  } as TextStyle,
  message: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    lineHeight: 20,
    color: tokens.textSecondary,
  } as TextStyle,
  buttonRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.sm,
  } as ViewStyle,
  cancelButton: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
  } as ViewStyle,
  cancelButtonText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: tokens.textSecondary,
  } as TextStyle,
  confirmButton: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    backgroundColor: '#DC2626',
  } as ViewStyle,
  confirmButtonText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#FFFFFF',
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

// ─── VerifyPhoneCard (SMS 2FA — Spec 2, Task 9) ───────────────────────────────
//
// Mirror of the member "Text messages" card (MemberSettingsScreen), adapted for
// the CHW. Lets a CHW verify their phone so SMS 2FA codes (required at every
// CHW login) can reach them. Three states, keyed off the CHW profile:
//   - No phone / sentinel (555-555-5555) → prompt to add a real number in the
//     Phone field above (can't text a placeholder), no send affordance.
//   - Verified (phoneVerifiedAt set) → static "On" row with a masked number.
//   - Unverified real phone → "Verify your phone" + Send code → inline 6-digit
//     entry → Confirm. On success the CHW profile query invalidates and the
//     card flips to the verified state.
//
// Reuses useStartPhoneVerification / useConfirmPhoneVerification (Spec 1). The
// confirm hook invalidates the MEMBER profile query, so we additionally
// invalidate the CHW profile here to flip this card without a manual refetch.

const CHW_SMS_SENTINEL_DIGITS = new Set(['5555555555', '15555555555']);
const CHW_SMS_CODE_LENGTH = 6;

/** Normalise a stored phone to E.164 for the /phone endpoints, or null when it
 *  isn't a plausible US number. */
function chwToE164OrNull(rawDigits: string): string | null {
  if (rawDigits.length === 10) return `+1${rawDigits}`;
  if (rawDigits.length === 11 && rawDigits.startsWith('1')) return `+${rawDigits}`;
  return null;
}

function VerifyPhoneCard({ profile }: { profile: ChwProfile | undefined }): React.JSX.Element {
  const qc = useQueryClient();
  const startVerification = useStartPhoneVerification();
  const confirmVerification = useConfirmPhoneVerification();
  const [entering, setEntering] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const phone = profile?.phone ?? '';
  const digits = phone.replace(/\D/g, '');
  const isSentinel = CHW_SMS_SENTINEL_DIGITS.has(digits);
  const e164 = chwToE164OrNull(digits);
  const isVerified = profile?.phoneVerifiedAt != null;
  const last4 = digits.slice(-4);

  const handleSendCode = (): void => {
    if (!e164) {
      setError('Add a valid US mobile number in the Phone field above first.');
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
    if (code.length !== CHW_SMS_CODE_LENGTH) {
      setError('Enter the 6-digit code we texted you.');
      return;
    }
    try {
      await confirmVerification.mutateAsync({ phone: e164, code });
      // useConfirmPhoneVerification invalidates the MEMBER profile; the CHW
      // profile drives THIS card's verified state, so invalidate it too.
      await qc.invalidateQueries({ queryKey: queryKeys.chwProfile });
      setEntering(false);
      setCode('');
    } catch (err) {
      const detail = err instanceof ApiError ? err.message : null;
      setError(detail ?? 'That code was not correct. Please try again.');
    }
  };

  return (
    <Card style={verifyPhoneStyles.card}>
      <View style={verifyPhoneStyles.titleRow}>
        <MessageSquare size={18} color="#10B981" />
        <Text style={verifyPhoneStyles.title}>Phone verification</Text>
      </View>

      {!phone || isSentinel ? (
        <Text style={verifyPhoneStyles.body}>
          Add a real mobile number in the Phone field above, then verify it here.
          Compass texts a sign-in code to your phone every time you log in.
        </Text>
      ) : isVerified ? (
        <Text style={verifyPhoneStyles.body} accessibilityLabel="Phone verified">
          Verified — we text your sign-in codes to •••{last4}.
        </Text>
      ) : !entering ? (
        <>
          <Text style={verifyPhoneStyles.body}>
            Verify your phone so your sign-in codes can reach you by SMS.
          </Text>
          <Pressable
            onPress={handleSendCode}
            disabled={startVerification.isPending}
            accessibilityRole="button"
            accessibilityLabel="Send code"
            style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
              verifyPhoneStyles.button,
              (pressed || hovered) && verifyPhoneStyles.buttonHover,
              startVerification.isPending && { opacity: 0.6 },
            ]}
          >
            <Text style={verifyPhoneStyles.buttonText}>
              {startVerification.isPending ? 'Sending…' : 'Send code'}
            </Text>
          </Pressable>
        </>
      ) : (
        <>
          <Text style={verifyPhoneStyles.body}>
            Enter the 6-digit code we texted to •••{last4}.
          </Text>
          <TextInput
            value={code}
            onChangeText={(v) => {
              setCode(v.replace(/\D/g, '').slice(0, CHW_SMS_CODE_LENGTH));
              if (error) setError(null);
            }}
            placeholder="123456"
            placeholderTextColor="#9CA3AF"
            keyboardType="number-pad"
            maxLength={CHW_SMS_CODE_LENGTH}
            editable={!confirmVerification.isPending}
            accessibilityLabel="Verification code"
            style={verifyPhoneStyles.input}
          />
          <Pressable
            onPress={() => void handleConfirm()}
            disabled={confirmVerification.isPending}
            accessibilityRole="button"
            accessibilityLabel="Confirm code"
            style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
              verifyPhoneStyles.button,
              (pressed || hovered) && verifyPhoneStyles.buttonHover,
              confirmVerification.isPending && { opacity: 0.6 },
            ]}
          >
            <Text style={verifyPhoneStyles.buttonText}>
              {confirmVerification.isPending ? 'Confirming…' : 'Confirm'}
            </Text>
          </Pressable>
        </>
      )}

      {error && <Text style={verifyPhoneStyles.error}>{error}</Text>}
    </Card>
  );
}

const verifyPhoneStyles = StyleSheet.create({
  card: {
    marginTop: 24,
    padding:   24,
  } as ViewStyle,
  titleRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           8,
  } as ViewStyle,
  title: {
    fontSize:   16,
    fontWeight: '600',
    color:      '#111827',
  } as TextStyle,
  body: {
    marginTop:  8,
    fontSize:   13,
    color:      '#374151',
    lineHeight: 18,
  } as TextStyle,
  button: {
    marginTop:         14,
    alignSelf:         'flex-start',
    paddingHorizontal: 16,
    paddingVertical:   10,
    borderRadius:      10,
    backgroundColor:   '#10B981',
  } as ViewStyle,
  buttonHover: {
    backgroundColor: '#059669',
  } as ViewStyle,
  buttonText: {
    fontSize:   13,
    fontWeight: '700',
    color:      '#FFFFFF',
  } as TextStyle,
  input: {
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
  error: {
    marginTop:  10,
    fontSize:   13,
    fontWeight: '500',
    color:      '#DC2626',
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
  const checklistQuery = useChwChecklist();
  const submitChecklistCredential = useSubmitChecklistCredential();

  const chwInitials = (userName ?? 'C')
    .split(' ')
    .slice(0, 2)
    .map((p) => p[0] ?? '')
    .join('')
    .toUpperCase();

  const [activeTab, setActiveTab] = useState<SettingsTab>('profile');
  const [editingField, setEditingField] = useState<string | null>(null);
  const [isSignOutModalVisible, setIsSignOutModalVisible] = useState(false);

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
  // QA batch #7 (Wave-2 B1): only consumed by the Notifications / Privacy &
  // Security tab panels, which are hidden until further notice (see
  // TAB_ORDER above + the commented-out render blocks below). Commented out
  // together rather than deleted so restoring the tabs is a single revert.
  // const [twoFactor, setTwoFactor]             = useState(true);
  // const [biometric, setBiometric]             = useState(false);
  // const [showProfileByZip, setShowProfileByZip] = useState(true);
  // const [aiDraftSummaries, setAiDraftSummaries] = useState(true);
  // const [sessionReminders, setSessionReminders] = useState(true);
  // const [memberRequestAlerts, setMemberRequestAlerts] = useState(true);
  // const [messageNotifications, setMessageNotifications] = useState(true);
  // const [earningsDeposit, setEarningsDeposit] = useState(true);

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

  // ── Compliance checklist upload (Epic D / QA batch #4) ───────────────────
  //
  // Native: expo-document-picker + api/upload.ts's uploadFile (FormData PUT
  // — works fine on native's fetch implementation).
  //
  // Web: native's FormData-wrapped PUT does NOT work against an S3 presigned
  // PUT URL (a presigned PUT expects the raw file bytes as the body, not a
  // multipart envelope), which is why web previously showed a hard "mobile
  // app required" block. Fixed here by using a raw <input type="file"> ->
  // getPresignedUploadUrl -> PUT the File object directly (its `type` is
  // sent via the Content-Type header, matching how the URL was signed) ->
  // confirm via submitChecklistCredential — the same raw-blob-PUT approach
  // already proven working in hooks/useFileUpload.ts's web branch. The
  // remaining blocker for a live upload is S3 bucket CORS configuration
  // (compass-phi-dev — see backend/docs/S3_CORS_CREDENTIAL_UPLOADS.md),
  // which is an infra change outside this component.
  const [uploadingChecklistCode, setUploadingChecklistCode] = useState<
    Exclude<ChwChecklistItemCode, 'background_check'> | null
  >(null);
  /** Hidden <input type="file"> ref for the web upload path (one shared
   * input; `pendingWebUploadCodeRef` tracks which checklist item the next
   * onChange event belongs to). */
  const checklistFileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingWebUploadCodeRef = useRef<Exclude<ChwChecklistItemCode, 'background_check'> | null>(null);

  const uploadChecklistFileWeb = useCallback(
    async (code: Exclude<ChwChecklistItemCode, 'background_check'>, file: File) => {
      setUploadingChecklistCode(code);
      try {
        const { upload_url: uploadUrl, s3_key: s3Key } = await getPresignedUploadUrl(
          file.name,
          file.type || 'application/pdf',
          'credential',
          file.size,
        );

        const putResponse = await fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': file.type || 'application/pdf' },
          body: file,
        });
        if (!putResponse.ok) {
          throw new Error(`S3 upload failed: HTTP ${putResponse.status}`);
        }

        await submitChecklistCredential.mutateAsync({ type: code, s3Key });
      } catch {
        Alert.alert('Upload failed', 'We could not upload that file. Please try again.');
      } finally {
        setUploadingChecklistCode(null);
      }
    },
    [submitChecklistCredential],
  );

  const handleUploadChecklistItem = useCallback(
    async (code: Exclude<ChwChecklistItemCode, 'background_check'>) => {
      if (Platform.OS === 'web') {
        pendingWebUploadCodeRef.current = code;
        checklistFileInputRef.current?.click();
        return;
      }

      setUploadingChecklistCode(code);
      try {
        const DocumentPicker = await import('expo-document-picker');
        const result = await DocumentPicker.getDocumentAsync({
          type: ['application/pdf'],
          copyToCacheDirectory: true,
          multiple: false,
        });
        if (result.canceled) return;

        const asset = result.assets[0];
        if (asset == null) return;

        const s3Key = await uploadFile(
          {
            uri: asset.uri,
            name: asset.name,
            type: asset.mimeType ?? 'application/pdf',
            sizeBytes: asset.size ?? undefined,
          },
          'credential',
        );

        await submitChecklistCredential.mutateAsync({ type: code, s3Key });
      } catch {
        Alert.alert('Upload failed', 'We could not upload that file. Please try again.');
      } finally {
        setUploadingChecklistCode(null);
      }
    },
    [submitChecklistCredential],
  );

  const handleChecklistFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      const code = pendingWebUploadCodeRef.current;
      // Reset immediately so the same file can be re-selected later.
      e.target.value = '';
      pendingWebUploadCodeRef.current = null;
      if (file && code) void uploadChecklistFileWeb(code, file);
    },
    [uploadChecklistFileWeb],
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

  // On-brand confirm modal (SignOutConfirmModal above) instead of a bare
  // Alert.alert, which no-ops on react-native-web (see src/utils/showAlert.ts)
  // — the previous implementation silently did nothing when Sign Out was
  // tapped on the web app. Never uses window.confirm.
  const handleLogoutPress = useCallback(() => {
    setIsSignOutModalVisible(true);
  }, []);

  const handleLogoutCancel = useCallback(() => {
    setIsSignOutModalVisible(false);
  }, []);

  const handleLogoutConfirm = useCallback(() => {
    setIsSignOutModalVisible(false);
    void logout();
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
            {/* QA batch #7: with only one tab (Profile) left in TAB_ORDER,
                the tab strip is pure visual noise — hide it entirely rather
                than render a single non-interactive "Profile" pill. Restore
                automatically once TAB_ORDER regains a 2nd entry. */}
            {TAB_ORDER.length > 1 && <TabBar active={activeTab} onChange={setActiveTab} />}

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

                  {/* Compliance checklist (Epic D) — 5 items: 4 CHW-uploadable
                      documents + background_check (admin-controlled, read-only
                      here). Replaces the old self-editable HIPAA
                      toggle/certification field/background-check chips —
                      those let a CHW mark themselves "clear" on a background
                      check, which is now admin-only via
                      PATCH /admin/chws/{id}/background-check. */}
                  <View style={profileStyles.specializationsSection}>
                    <Text style={profileStyles.formTitle}>Compliance</Text>
                    {checklistQuery.isLoading ? (
                      <ActivityIndicator size="small" color="#10B981" />
                    ) : checklistQuery.isError ? (
                      <Text style={checklistStyles.copy}>
                        Could not load your compliance checklist. Pull to refresh to try again.
                      </Text>
                    ) : (
                      CHECKLIST_ITEMS.map((meta) => {
                        const item = checklistQuery.data?.items?.find((i) => i.code === meta.code);
                        return (
                          <ChecklistItemRow
                            key={meta.code}
                            meta={meta}
                            status={item?.status ?? 'missing'}
                            onUpload={(code) => void handleUploadChecklistItem(code)}
                            uploading={uploadingChecklistCode === meta.code}
                          />
                        );
                      })
                    )}
                  </View>

                  {/* Hidden web file input for the checklist upload web
                      path (QA batch #4) — triggered programmatically by
                      handleUploadChecklistItem via checklistFileInputRef. */}
                  {Platform.OS === 'web' ? (
                    <input
                      ref={checklistFileInputRef}
                      type="file"
                      accept="application/pdf,image/jpeg,image/png"
                      style={{ display: 'none' }}
                      onChange={handleChecklistFileInputChange}
                    />
                  ) : null}
                </>
              )}

              {/*
                QA batch #7 (Wave-2 B1): Notifications / Privacy & Security /
                Language / Help tabs are HIDDEN UNTIL FURTHER NOTICE — product
                wants Settings to be Profile-only for now. Code kept intact
                (not deleted) so it can be restored by un-commenting these
                blocks AND re-adding the tab keys to TAB_ORDER above.

              {/* ── Notifications tab ───────────────────────────────────── *}
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

              {/* ── Privacy & Security tab ──────────────────────────────── *}
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

              {/* ── Language tab ────────────────────────────────────────── *}
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

              {/* ── Help tab ────────────────────────────────────────────── *}
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
              */}
            </View>
          </Card>

          {/* Phone verification (SMS 2FA — Spec 2). Sits between the main
              Settings card and the bottom grid, mirroring the member "Text
              messages" card. */}
          <VerifyPhoneCard profile={profile} />

          {/* Bottom: 2-col grid (always visible) */}
          <View style={pageStyles.bottomGrid}>
            {/* Account & Security card (left) */}
            <Card style={pageStyles.bottomCard}>
              <Text style={pageStyles.bottomCardTitle}>Account & Security</Text>
              <Text style={pageStyles.bottomCardSubtitle}>Your account settings and data</Text>

              <Pressable
                onPress={handleLogoutPress}
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

      <SignOutConfirmModal
        visible={isSignOutModalVisible}
        onCancel={handleLogoutCancel}
        onConfirm={handleLogoutConfirm}
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

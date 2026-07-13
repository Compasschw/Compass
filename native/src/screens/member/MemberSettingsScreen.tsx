/**
 * MemberSettingsScreen — settings, profile, and privacy for the member.
 *
 * Layout matches `_mockups/member-settings.html` 1:1 on web:
 *   - Page header (Settings + subtitle)
 *   - Main card with underline-style tab strip (Profile / Notifications /
 *     Privacy & Security / Language / Help). Profile is the default tab.
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
  Mail,
  MessageSquare,
  Phone,
  Shield,
  ShieldOff,
  Trash2,
} from 'lucide-react-native';

import { useAuth } from '../../context/AuthContext';
import {
  useMemberProfile,
  useUpdateMemberProfile,
  useDeleteAccount,
  useDeactivateAccount,
} from '../../hooks/useApiQueries';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { AppShell, PageHeader, Card, ProfilePictureEditor } from '../../components/ui';
import { DeleteAccountModal } from '../../components/profile/DeleteAccountModal';
import { colors as tokens } from '../../theme/tokens';
import { confirmAsync } from '../../utils/confirm';
import { BP_PHONE } from '../../constants/breakpoints';

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
];

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

// ─── Screen ───────────────────────────────────────────────────────────────────

export function MemberSettingsScreen(): React.JSX.Element {
  const { userName, logout, clearAfterDeletion } = useAuth();
  const deleteAccount = useDeleteAccount();
  const deactivateAccount = useDeactivateAccount();
  const profileQuery = useMemberProfile();
  const updateProfile = useUpdateMemberProfile();

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

  // Local-only privacy toggles (no preferences endpoint yet — when one ships,
  // wire these to that hook the same way profile fields use updateProfile).
  const [twoFactor, setTwoFactor] = useState(true);
  const [biometric, setBiometric] = useState(false);
  const [aiTranscription, setAiTranscription] = useState(true);
  const [shareForResearch, setShareForResearch] = useState(false);
  const [sessionReminders, setSessionReminders] = useState(true);
  const [pushNotifications, setPushNotifications] = useState(true);

  const profile = profileQuery.data;

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
      } catch {
        Alert.alert('Could not save', `${field} was not updated. Please try again.`);
      }
    },
    [updateProfile],
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
            <TabBar active={activeTab} onChange={setActiveTab} />

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
                      value={profile?.insuranceProvider ?? '—'}
                      tagLabel="From plan"
                      isEditing={false}
                      onEditStart={() => undefined}
                      onEditCancel={() => undefined}
                      onSave={() => undefined}
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
                    label="AI session transcription"
                    description="Allow AI to transcribe your sessions for CHW notes. Required consent before each session."
                    value={aiTranscription}
                    onValueChange={setAiTranscription}
                  />
                  <ToggleRow
                    label="Share data for anonymous research"
                    description="Helps improve outcomes for other Medi-Cal members."
                    value={shareForResearch}
                    onValueChange={setShareForResearch}
                  />
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

          {/* Bottom: 2-col grid (always visible) */}
          <View style={pageStyles.bottomGrid}>
            {/* Privacy & Security summary card */}
            <Card style={[pageStyles.bottomCard, isPhone && pageStyles.bottomCardPhone]}>
              <Text style={pageStyles.bottomCardTitle}>Privacy & Security</Text>
              <Text style={pageStyles.bottomCardSubtitle}>Your data is protected. You're in control.</Text>

              <View style={{ marginTop: 8 }}>
                <ToggleRow
                  label="Two-factor authentication"
                  description="SMS code on every login"
                  value={twoFactor}
                  onValueChange={setTwoFactor}
                />
                <ToggleRow
                  label="Biometric login"
                  description="Face ID / fingerprint"
                  value={biometric}
                  onValueChange={setBiometric}
                />
                <ToggleRow
                  label="AI session transcription consent"
                  description="Granted · revoke anytime"
                  value={aiTranscription}
                  onValueChange={setAiTranscription}
                />
                <ToggleRow
                  label="Share data for anonymous research"
                  description="Helps improve outcomes for others"
                  value={shareForResearch}
                  onValueChange={setShareForResearch}
                />
              </View>

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

            {/* Need help card */}
            <Card style={[pageStyles.bottomCard, isPhone && pageStyles.bottomCardPhone, pageStyles.helpCard]}>
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

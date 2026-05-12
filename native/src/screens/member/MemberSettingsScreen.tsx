/**
 * MemberSettingsScreen — settings, profile, and privacy for the member.
 *
 * Tab strip at the top:
 *   Profile · Notifications · Privacy · Language · Help
 *
 * Default tab: Profile — form fields for name, phone, ZIP, preferred mode,
 * insurance provider, and language.
 *
 * Privacy tab: toggles for AI transcription, analytics, push notifications.
 *
 * Help tab: support cards (Contact CHW, FAQs, Report an Issue, Log Out).
 *
 * Data: reads from useMemberProfile, writes via useUpdateMemberProfile.
 * All mutations use optimistic UI with Alert-based error rollback.
 */

import React, { useCallback, useState } from 'react';
import {
  Alert,
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
  Globe,
  HelpCircle,
  LogOut,
  Mail,
  MessageSquare,
  Phone,
  Save,
  Shield,
} from 'lucide-react-native';

import { useAuth } from '../../context/AuthContext';
import {
  useMemberProfile,
  useUpdateMemberProfile,
} from '../../hooks/useApiQueries';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { AppShell, PageHeader, Card, Pill } from '../../components/ui';
import { colors as tokens } from '../../theme/tokens';

// ─── Types ────────────────────────────────────────────────────────────────────

type SettingsTab = 'profile' | 'notifications' | 'privacy' | 'language' | 'help';

const TAB_LABELS: Record<SettingsTab, string> = {
  profile: 'Profile',
  notifications: 'Notifications',
  privacy: 'Privacy',
  language: 'Language',
  help: 'Help',
};

const TAB_ORDER: SettingsTab[] = [
  'profile',
  'notifications',
  'privacy',
  'language',
  'help',
];

const PREFERRED_MODE_OPTIONS = [
  { value: 'in_person', label: 'In Person' },
  { value: 'virtual', label: 'Virtual' },
  { value: 'phone', label: 'Phone' },
];

const LANGUAGE_OPTIONS = [
  { value: 'English', label: 'English' },
  { value: 'Spanish', label: 'Español' },
  { value: 'Chinese', label: '中文' },
  { value: 'Tagalog', label: 'Tagalog' },
  { value: 'Vietnamese', label: 'Tiếng Việt' },
  { value: 'Korean', label: '한국어' },
];

// ─── Sub-components ───────────────────────────────────────────────────────────

interface TabButtonProps {
  tab: SettingsTab;
  isActive: boolean;
  onPress: () => void;
}

function TabButton({ tab, isActive, onPress }: TabButtonProps): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        tb.tab,
        isActive && tb.tabActive,
        pressed && { opacity: 0.75 },
      ]}
      accessibilityRole="tab"
      accessibilityState={{ selected: isActive }}
      accessibilityLabel={TAB_LABELS[tab]}
    >
      <Text style={[tb.label, isActive && tb.labelActive]}>
        {TAB_LABELS[tab]}
      </Text>
    </Pressable>
  );
}

const tb = StyleSheet.create({
  tab: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  } as ViewStyle,
  tabActive: {
    backgroundColor: tokens.primary,
  } as ViewStyle,
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: tokens.textSecondary,
  } as TextStyle,
  labelActive: {
    color: '#FFFFFF',
  } as TextStyle,
});

interface FormFieldProps {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'phone-pad' | 'email-address' | 'numeric';
  editable?: boolean;
}

function FormField({
  label,
  value,
  onChangeText,
  placeholder = '',
  keyboardType = 'default',
  editable = true,
}: FormFieldProps): React.JSX.Element {
  return (
    <View style={ff.container}>
      <Text style={ff.label}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        keyboardType={keyboardType}
        editable={editable}
        style={[ff.input, !editable && ff.inputDisabled]}
        placeholderTextColor={tokens.textMuted}
        accessibilityLabel={label}
      />
    </View>
  );
}

const ff = StyleSheet.create({
  container: {
    gap: 4,
    marginBottom: 14,
  } as ViewStyle,
  label: {
    fontSize: 11,
    fontWeight: '700',
    color: tokens.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  } as TextStyle,
  input: {
    backgroundColor: tokens.pageBg,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
    fontSize: 14,
    color: tokens.textPrimary,
  } as ViewStyle,
  inputDisabled: {
    opacity: 0.6,
  } as ViewStyle,
});

interface ToggleRowProps {
  label: string;
  description: string;
  value: boolean;
  onValueChange: (val: boolean) => void;
}

function ToggleRow({ label, description, value, onValueChange }: ToggleRowProps): React.JSX.Element {
  return (
    <View style={tr.row}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={tr.label}>{label}</Text>
        <Text style={tr.desc}>{description}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        thumbColor="#FFFFFF"
        trackColor={{ false: tokens.gray100, true: tokens.primary }}
        accessibilityRole="switch"
        accessibilityLabel={label}
        accessibilityState={{ checked: value }}
      />
    </View>
  );
}

const tr = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: tokens.cardBorder,
  } as ViewStyle,
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: tokens.textPrimary,
  } as TextStyle,
  desc: {
    fontSize: 12,
    color: tokens.textSecondary,
    lineHeight: 16,
  } as TextStyle,
});

interface SupportCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  onPress: () => void;
  variant?: 'default' | 'danger';
}

function SupportCard({ icon, title, description, onPress, variant = 'default' }: SupportCardProps): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        sc.card,
        variant === 'danger' && sc.cardDanger,
        pressed && { opacity: 0.75 },
      ]}
      accessibilityRole="button"
      accessibilityLabel={title}
    >
      <View style={[sc.iconCircle, variant === 'danger' && sc.iconCircleDanger]}>
        {icon}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[sc.title, variant === 'danger' && sc.titleDanger]}>{title}</Text>
        <Text style={sc.desc} numberOfLines={2}>{description}</Text>
      </View>
    </Pressable>
  );
}

const sc = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    backgroundColor: tokens.cardBg,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    marginBottom: 10,
  } as ViewStyle,
  cardDanger: {
    borderColor: `${tokens.red100}`,
    backgroundColor: `${tokens.red100}40`,
  } as ViewStyle,
  iconCircle: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: `${tokens.primary}12`,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,
  iconCircleDanger: {
    backgroundColor: `${tokens.red100}`,
  } as ViewStyle,
  title: {
    fontSize: 14,
    fontWeight: '600',
    color: tokens.textPrimary,
  } as TextStyle,
  titleDanger: {
    color: tokens.red700,
  } as TextStyle,
  desc: {
    fontSize: 12,
    color: tokens.textSecondary,
    lineHeight: 16,
  } as TextStyle,
});

// ─── Tab content components ───────────────────────────────────────────────────

interface ProfileTabProps {
  name: string;
  phone: string;
  zipCode: string;
  preferredMode: string;
  insurance: string;
  language: string;
  onChangeName: (v: string) => void;
  onChangePhone: (v: string) => void;
  onChangeZip: (v: string) => void;
  onChangeMode: (v: string) => void;
  onChangeInsurance: (v: string) => void;
  onSave: () => void;
  isSaving: boolean;
}

function ProfileTab({
  name,
  phone,
  zipCode,
  preferredMode,
  insurance,
  language,
  onChangeName,
  onChangePhone,
  onChangeZip,
  onChangeMode,
  onChangeInsurance,
  onSave,
  isSaving,
}: ProfileTabProps): React.JSX.Element {
  const initials = name
    .split(' ')
    .slice(0, 2)
    .map((p) => p[0] ?? '')
    .join('')
    .toUpperCase() || 'ME';

  return (
    <Card style={pt.card}>
      <View style={pt.twoCol}>
        {/* Avatar column */}
        <View style={pt.avatarCol}>
          <View style={pt.avatarCircle}>
            <Text style={pt.avatarInitials}>{initials}</Text>
          </View>
          <Text style={pt.avatarHint}>JPEG/PNG · max 5MB</Text>
        </View>

        {/* Form column */}
        <View style={pt.formCol}>
          <Text style={pt.sectionLabel}>PROFILE INFORMATION</Text>
          <FormField
            label="Full Name"
            value={name}
            onChangeText={onChangeName}
            placeholder="Your full name"
          />
          <FormField
            label="Phone Number"
            value={phone}
            onChangeText={onChangePhone}
            placeholder="+1 (555) 000-0000"
            keyboardType="phone-pad"
          />
          <FormField
            label="ZIP Code"
            value={zipCode}
            onChangeText={onChangeZip}
            placeholder="e.g. 90210"
            keyboardType="numeric"
          />
          <FormField
            label="Insurance Provider"
            value={insurance}
            onChangeText={onChangeInsurance}
            placeholder="e.g. Medi-Cal, Blue Shield"
          />

          <Text style={[pt.sectionLabel, { marginTop: 8 }]}>PREFERRED SESSION MODE</Text>
          <View style={pt.modeRow}>
            {PREFERRED_MODE_OPTIONS.map((opt) => (
              <Pressable
                key={opt.value}
                onPress={() => onChangeMode(opt.value)}
                style={[pt.modeBtn, preferredMode === opt.value && pt.modeBtnActive]}
                accessibilityRole="radio"
                accessibilityState={{ checked: preferredMode === opt.value }}
                accessibilityLabel={opt.label}
              >
                <Text style={[pt.modeBtnText, preferredMode === opt.value && pt.modeBtnTextActive]}>
                  {opt.label}
                </Text>
              </Pressable>
            ))}
          </View>

          <Pressable
            onPress={onSave}
            disabled={isSaving}
            style={({ pressed }) => [pt.saveBtn, (pressed || isSaving) && { opacity: 0.7 }]}
            accessibilityRole="button"
            accessibilityLabel="Save profile changes"
            accessibilityState={{ disabled: isSaving }}
          >
            <Save size={16} color="#FFFFFF" />
            <Text style={pt.saveBtnText}>{isSaving ? 'Saving…' : 'Save Changes'}</Text>
          </Pressable>
        </View>
      </View>
    </Card>
  );
}

const pt = StyleSheet.create({
  card: {
    padding: 20,
  } as ViewStyle,
  twoCol: {
    flexDirection: 'row',
    gap: 24,
    alignItems: 'flex-start',
  } as ViewStyle,
  avatarCol: {
    width: 96,
    alignItems: 'center',
    gap: 8,
  } as ViewStyle,
  avatarCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: '#94A3B8',
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  avatarInitials: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 28,
    color: '#FFFFFF',
  } as TextStyle,
  avatarHint: {
    fontSize: 10,
    color: tokens.textMuted,
    textAlign: 'center',
    lineHeight: 14,
  } as TextStyle,
  formCol: {
    flex: 1,
  } as ViewStyle,
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: tokens.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 12,
  } as TextStyle,
  modeRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 16,
    flexWrap: 'wrap',
  } as ViewStyle,
  modeBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    backgroundColor: tokens.cardBg,
  } as ViewStyle,
  modeBtnActive: {
    backgroundColor: tokens.primary,
    borderColor: tokens.primary,
  } as ViewStyle,
  modeBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: tokens.textSecondary,
  } as TextStyle,
  modeBtnTextActive: {
    color: '#FFFFFF',
  } as TextStyle,
  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: tokens.primary,
    borderRadius: 10,
    paddingVertical: 13,
    marginTop: 4,
  } as ViewStyle,
  saveBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#FFFFFF',
  } as TextStyle,
});

// ─── Screen ───────────────────────────────────────────────────────────────────

export function MemberSettingsScreen(): React.JSX.Element {
  const { userName, logout } = useAuth();
  const profileQuery = useMemberProfile();
  const updateProfile = useUpdateMemberProfile();

  const memberInitials = (userName ?? 'M')
    .split(' ')
    .slice(0, 2)
    .map((p) => p[0] ?? '')
    .join('')
    .toUpperCase();

  const [activeTab, setActiveTab] = useState<SettingsTab>('profile');

  // Profile form state — initialised from API data
  const [formName, setFormName] = useState(profileQuery.data?.name ?? '');
  const [formPhone, setFormPhone] = useState(profileQuery.data?.phone ?? '');
  const [formZip, setFormZip] = useState(profileQuery.data?.zipCode ?? '');
  const [formMode, setFormMode] = useState(profileQuery.data?.preferredMode ?? 'virtual');
  const [formInsurance, setFormInsurance] = useState(
    profileQuery.data?.insuranceProvider ?? '',
  );

  // Privacy toggles (local-only until a privacy-preferences endpoint ships)
  const [aiTranscription, setAiTranscription] = useState(true);
  const [analytics, setAnalytics] = useState(true);
  const [pushNotifications, setPushNotifications] = useState(true);
  const [sessionReminders, setSessionReminders] = useState(true);

  const handleSaveProfile = useCallback(async () => {
    try {
      await updateProfile.mutateAsync({
        name: formName,
        phone: formPhone,
        zipCode: formZip,
        preferredMode: formMode,
        insuranceProvider: formInsurance,
      });
      Alert.alert('Saved', 'Your profile has been updated.');
    } catch {
      Alert.alert('Error', 'Could not save changes. Please try again.');
    }
  }, [formName, formPhone, formZip, formMode, formInsurance, updateProfile]);

  const handleLogout = useCallback(() => {
    Alert.alert('Log Out', 'Are you sure you want to log out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log Out', style: 'destructive', onPress: () => void logout() },
    ]);
  }, [logout]);

  const shellUserBlock = {
    initials: memberInitials,
    name: userName ?? 'Member',
    role: 'Member' as const,
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
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.pageWrap}>
          <PageHeader
            title="Settings"
            subtitle="Manage your profile, privacy, and preferences"
          />

          {/* Tab strip */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.tabStrip}
          >
            {TAB_ORDER.map((tab) => (
              <TabButton
                key={tab}
                tab={tab}
                isActive={activeTab === tab}
                onPress={() => setActiveTab(tab)}
              />
            ))}
          </ScrollView>

          {/* Tab content */}
          <View style={styles.tabContent}>
            {activeTab === 'profile' && (
              <ProfileTab
                name={formName}
                phone={formPhone}
                zipCode={formZip}
                preferredMode={formMode}
                insurance={formInsurance}
                language={profileQuery.data?.primaryLanguage ?? 'English'}
                onChangeName={setFormName}
                onChangePhone={setFormPhone}
                onChangeZip={setFormZip}
                onChangeMode={setFormMode}
                onChangeInsurance={setFormInsurance}
                onSave={() => void handleSaveProfile()}
                isSaving={updateProfile.isPending}
              />
            )}

            {activeTab === 'notifications' && (
              <Card style={styles.tabCard}>
                <Text style={styles.sectionLabel}>NOTIFICATIONS</Text>
                <ToggleRow
                  label="Session Reminders"
                  description="Get reminders 24 hours and 1 hour before sessions."
                  value={sessionReminders}
                  onValueChange={setSessionReminders}
                />
                <ToggleRow
                  label="Push Notifications"
                  description="Receive push notifications for messages and updates."
                  value={pushNotifications}
                  onValueChange={setPushNotifications}
                />
              </Card>
            )}

            {activeTab === 'privacy' && (
              <Card style={styles.tabCard}>
                <Text style={styles.sectionLabel}>PRIVACY & SECURITY</Text>
                <ToggleRow
                  label="AI Session Transcription"
                  description="Allow AI to transcribe your sessions for CHW notes. Requires consent before each session."
                  value={aiTranscription}
                  onValueChange={setAiTranscription}
                />
                <ToggleRow
                  label="Analytics & Usage Data"
                  description="Help us improve Compass by sharing anonymized usage data."
                  value={analytics}
                  onValueChange={setAnalytics}
                />
                <View style={styles.privacyNote}>
                  <Shield size={13} color={tokens.textSecondary} />
                  <Text style={styles.privacyNoteText}>
                    Your health information is protected under HIPAA and California CMIA.
                    Compass never sells or shares your data without your consent.
                  </Text>
                </View>
              </Card>
            )}

            {activeTab === 'language' && (
              <Card style={styles.tabCard}>
                <Text style={styles.sectionLabel}>PREFERRED LANGUAGE</Text>
                {LANGUAGE_OPTIONS.map((opt) => (
                  <Pressable
                    key={opt.value}
                    style={({ pressed }) => [
                      styles.languageRow,
                      profileQuery.data?.primaryLanguage === opt.value && styles.languageRowActive,
                      pressed && { opacity: 0.75 },
                    ]}
                    onPress={() => {
                      Alert.alert(
                        'Language Change',
                        `Switch interface language to ${opt.label}? This will take effect on next app launch.`,
                        [
                          { text: 'Cancel', style: 'cancel' },
                          {
                            text: 'Switch',
                            onPress: async () => {
                              try {
                                await updateProfile.mutateAsync({ primaryLanguage: opt.value });
                              } catch {
                                Alert.alert('Error', 'Could not update language. Please try again.');
                              }
                            },
                          },
                        ],
                      );
                    }}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: profileQuery.data?.primaryLanguage === opt.value }}
                    accessibilityLabel={opt.label}
                  >
                    <Globe size={16} color={tokens.textSecondary} />
                    <Text style={styles.languageLabel}>{opt.label}</Text>
                    {profileQuery.data?.primaryLanguage === opt.value && (
                      <Pill variant="emerald" size="sm">Current</Pill>
                    )}
                  </Pressable>
                ))}
              </Card>
            )}

            {activeTab === 'help' && (
              <View>
                <SupportCard
                  icon={<MessageSquare size={18} color={tokens.primary} />}
                  title="Message Your CHW"
                  description="Send a message directly to your assigned Community Health Worker."
                  onPress={() =>
                    Alert.alert('Navigate', 'Switch to the Messages tab to contact your CHW.')
                  }
                />
                <SupportCard
                  icon={<HelpCircle size={18} color={tokens.blue700} />}
                  title="FAQs"
                  description="Find answers to common questions about Compass."
                  onPress={() =>
                    Alert.alert('FAQs', 'FAQ page coming soon.')
                  }
                />
                <SupportCard
                  icon={<Mail size={18} color={tokens.purple700} />}
                  title="Report an Issue"
                  description="Experiencing a problem? Let us know and we'll fix it fast."
                  onPress={() =>
                    Alert.alert('Report', 'Please email support@compass-health.app.')
                  }
                />
                <SupportCard
                  icon={<LogOut size={18} color={tokens.red700} />}
                  title="Log Out"
                  description="Sign out of your Compass account on this device."
                  onPress={handleLogout}
                  variant="danger"
                />
              </View>
            )}
          </View>

          {/* Privacy + Help below-cards — always visible regardless of tab */}
          <View style={styles.belowCards}>
            <Card style={styles.belowCard}>
              <Text style={styles.belowCardTitle}>Privacy &amp; Security</Text>
              <Text style={styles.belowCardSub}>Your data is protected. You're in control.</Text>
              <ToggleRow
                label="AI Session Transcription"
                description="Allow AI to transcribe your sessions for CHW notes."
                value={aiTranscription}
                onValueChange={setAiTranscription}
              />
              <ToggleRow
                label="Analytics &amp; Usage Data"
                description="Help us improve Compass by sharing anonymized usage data."
                value={analytics}
                onValueChange={setAnalytics}
              />
              <View style={styles.privacyNote}>
                <Shield size={13} color={tokens.textSecondary} />
                <Text style={styles.privacyNoteText}>
                  Your health information is protected under HIPAA and California CMIA.
                </Text>
              </View>
            </Card>

            <Card style={[styles.belowCard, { backgroundColor: '#F0FDF4' }]}>
              <Text style={styles.belowCardTitle}>Need help?</Text>
              <Text style={styles.belowCardSub}>We're here for you 24/7</Text>
              <SupportCard
                icon={<Phone size={18} color="#2563EB" />}
                title="Call support"
                description="Mon–Sun 7 AM – 9 PM PT"
                onPress={() => Alert.alert('Support', 'Call (800) 555-COMPASS')}
              />
              <SupportCard
                icon={<MessageSquare size={18} color={tokens.primary} />}
                title="Text us"
                description="(800) 555-COMPASS · usually replies in 10 min"
                onPress={() => Alert.alert('Support', 'Text (800) 555-COMPASS')}
              />
              <SupportCard
                icon={<Mail size={18} color="#7C3AED" />}
                title="Email us"
                description="help@joincompasschw.com"
                onPress={() => Alert.alert('Support', 'Email help@joincompasschw.com')}
              />
            </Card>
          </View>
        </View>
      </ScrollView>
    </AppShell>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  scrollContent: { flexGrow: 1 },
  pageWrap: {
    padding: 24,
    maxWidth: 720,
    width: '100%',
    alignSelf: 'center',
  } as ViewStyle,
  tabStrip: {
    flexDirection: 'row',
    gap: 4,
    backgroundColor: tokens.pageBg,
    borderRadius: 10,
    padding: 4,
    marginBottom: 20,
    alignSelf: 'flex-start',
  } as ViewStyle,
  tabContent: {
    flex: 1,
  } as ViewStyle,
  tabCard: {
    padding: 20,
  } as ViewStyle,
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: tokens.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 12,
  } as TextStyle,
  privacyNote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginTop: 12,
    backgroundColor: tokens.pageBg,
    borderRadius: 8,
    padding: 10,
  } as ViewStyle,
  privacyNoteText: {
    fontSize: 11,
    color: tokens.textSecondary,
    lineHeight: 16,
    flex: 1,
  } as TextStyle,
  languageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: tokens.cardBorder,
  } as ViewStyle,
  languageRowActive: {
    backgroundColor: `${tokens.primary}08`,
    borderRadius: 8,
  } as ViewStyle,
  languageLabel: {
    fontSize: 14,
    color: tokens.textPrimary,
    flex: 1,
  } as TextStyle,

  belowCards: {
    flexDirection: 'row',
    gap: 16,
    marginTop: 20,
    flexWrap: 'wrap',
  } as ViewStyle,
  belowCard: {
    flex: 1,
    minWidth: 280,
    padding: 20,
    gap: 4,
  } as ViewStyle,
  belowCardTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: tokens.textPrimary,
    marginBottom: 2,
  } as TextStyle,
  belowCardSub: {
    fontSize: 12,
    color: tokens.textSecondary,
    marginBottom: 10,
  } as TextStyle,
});

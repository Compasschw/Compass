/**
 * MemberProfileScreen — Member profile, settings, preferences, rewards, and account management.
 *
 * Sections:
 * - Avatar with initials + name (editable in edit mode)
 * - Profile info: name, zip, phone, email, primary language, primary need, insurance (editable)
 * - CHW preferences: gender preference, language preference (multi-select), session mode preference
 * - Notification settings with Switch toggles
 * - Rewards balance + history (FlatList of mockRewardHistory)
 * - Redemption catalog (cards with "Redeem" CTA)
 * - Sign out button
 *
 * Edit mode: draft state pattern — edits modify draft; Save commits, Cancel reverts.
 */

import React, { useCallback, useState } from 'react';
import {
  Alert,
  FlatList,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Bell,
  Check,
  Edit2,
  Gift,
  Globe,
  Heart,
  LogOut,
  Mail,
  MapPin,
  Phone,
  ShoppingBag,
  User,
  X,
} from 'lucide-react-native';

import { useAuth } from '../../context/AuthContext';
import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import {
  redemptionCatalog,
  verticalLabels,
  type RedemptionItem,
  type Vertical,
} from '../../data/mock';
import {
  useMemberProfile,
  useMemberRewards,
  useUpdateMemberProfile,
  type RewardTransaction,
} from '../../hooks/useApiQueries';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';

// ─── Types ────────────────────────────────────────────────────────────────────

interface NotificationSettings {
  sessionReminders: boolean;
  goalUpdates: boolean;
  healthTips: boolean;
}

type GenderPreference = 'any' | 'male' | 'female';
type SessionModePreference = 'in_person' | 'virtual' | 'phone';

interface CHWPreferences {
  genderPreference: GenderPreference;
  languagePreferences: string[];
  sessionModePreference: SessionModePreference;
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

// ─── Constants ────────────────────────────────────────────────────────────────

// Shown in place of a missing phone/email/insurance_provider on the profile.
// The backend now returns these when present (see MemberProfileResponse).
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

const REWARD_ACTION_ICONS: Record<string, string> = {
  session_completed: '✅',
  follow_through: '⭐',
  redeemed: '🎁',
};

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

interface ProfileSource {
  zipCode: string;
  primaryLanguage: string;
  primaryNeed: string;
  insuranceProvider?: string;
  phone?: string;
  email?: string;
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

// ─── Sub-components ───────────────────────────────────────────────────────────

interface InfoRowProps {
  icon: React.ReactNode;
  label: string;
  value: string;
}

function InfoRow({ icon, label, value }: InfoRowProps): React.JSX.Element {
  return (
    <View style={infoRowStyles.container}>
      <View style={infoRowStyles.iconBox}>{icon}</View>
      <View style={infoRowStyles.textBox}>
        <Text style={infoRowStyles.label}>{label}</Text>
        <Text style={infoRowStyles.value}>{value}</Text>
      </View>
    </View>
  );
}

const infoRowStyles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: '#E5DFD6',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
    marginBottom: 8,
  },
  iconBox: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: '#3D5A3E15',
    alignItems: 'center',
    justifyContent: 'center',
  },
  textBox: { flex: 1 },
  label: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 10,
    color: '#6B7280',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 1,
  },
  value: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#1E3320',
  },
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
        placeholderTextColor={colors.mutedForeground}
        keyboardType={keyboardType}
        accessibilityLabel={label}
      />
    </View>
  );
}

const editFieldStyles = StyleSheet.create({
  container: { marginBottom: 12 },
  label: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 10,
    color: '#6B7280',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: '#DDD6CC',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: '#FFFFFF',
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#1E3320',
  },
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
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    marginBottom: 16,
    overflow: 'hidden',
    ...Platform.select({
      ios: {
        shadowColor: '#3D5A3E',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.08,
        shadowRadius: 24,
      },
      android: { elevation: 3 },
    }),
  },
  title: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    color: '#6B7280',
    textTransform: 'uppercase',
    letterSpacing: 1,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 6,
  },
  body: {
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
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
        trackColor={{ false: colors.border, true: `${colors.primary}80` }}
        thumbColor={value ? colors.primary : '#FFFFFF'}
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
    paddingVertical: 12,
    gap: 12,
  },
  textBox: { flex: 1 },
  label: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
    color: '#1E3320',
  },
  desc: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: '#6B7280',
    marginTop: 1,
  },
});

// ─── Reward history row ───────────────────────────────────────────────────────

function RewardRow({ item }: { item: RewardTransaction }): React.JSX.Element {
  const isPositive = item.points > 0;
  return (
    <View style={rewardRowStyles.container}>
      <View style={rewardRowStyles.iconBox}>
        <Text style={rewardRowStyles.icon}>
          {REWARD_ACTION_ICONS[item.action] ?? '•'}
        </Text>
      </View>
      <View style={rewardRowStyles.info}>
        <Text style={rewardRowStyles.description} numberOfLines={2}>
          {item.action.replace(/_/g, ' ')}
        </Text>
        <Text style={rewardRowStyles.date}>{formatRewardDate(item.createdAt)}</Text>
      </View>
      <Text
        style={[
          rewardRowStyles.points,
          { color: isPositive ? colors.secondary : colors.destructive },
        ]}
      >
        {isPositive ? '+' : ''}{item.points} pts
      </Text>
    </View>
  );
}

const rewardRowStyles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
  },
  iconBox: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: '#D4A35415',
    alignItems: 'center',
    justifyContent: 'center',
  },
  icon: {
    fontSize: 16,
  },
  info: {
    flex: 1,
    gap: 2,
  },
  description: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: '#1E3320',
  },
  date: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#6B7280',
  },
  points: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
  },
});

// ─── Redemption card ──────────────────────────────────────────────────────────

interface RedemptionCardProps {
  item: RedemptionItem;
  onRedeem: (item: RedemptionItem) => void;
  balance: number;
}

function RedemptionCard({ item, onRedeem, balance }: RedemptionCardProps): React.JSX.Element {
  const canAfford = balance >= item.pointsCost;
  return (
    <View style={redemptionCardStyles.card}>
      <Text style={redemptionCardStyles.emoji}>{item.emoji}</Text>
      <View style={redemptionCardStyles.info}>
        <Text style={redemptionCardStyles.name}>{item.name}</Text>
        <Text style={redemptionCardStyles.description} numberOfLines={2}>
          {item.description}
        </Text>
        <Text style={redemptionCardStyles.cost}>{item.pointsCost} pts</Text>
      </View>
      <TouchableOpacity
        style={[
          redemptionCardStyles.redeemBtn,
          !canAfford && redemptionCardStyles.redeemBtnDisabled,
        ]}
        onPress={() => onRedeem(item)}
        disabled={!canAfford}
        accessibilityRole="button"
        accessibilityLabel={`Redeem ${item.name} for ${item.pointsCost} points`}
        accessibilityState={{ disabled: !canAfford }}
      >
        <Text
          style={[
            redemptionCardStyles.redeemBtnText,
            !canAfford && redemptionCardStyles.redeemBtnTextDisabled,
          ]}
        >
          Redeem
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const redemptionCardStyles = StyleSheet.create({
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    padding: 16,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    ...Platform.select({
      ios: {
        shadowColor: '#3D5A3E',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.08,
        shadowRadius: 24,
      },
      android: { elevation: 3 },
    }),
  },
  emoji: {
    fontSize: 28,
    width: 44,
    textAlign: 'center',
  },
  info: {
    flex: 1,
    gap: 2,
  },
  name: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
    color: '#1E3320',
  },
  description: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: '#6B7280',
    lineHeight: 18,
  },
  cost: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 11,
    color: '#D4A354',
    marginTop: 2,
  },
  redeemBtn: {
    backgroundColor: '#D4A354',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
  },
  redeemBtnDisabled: {
    backgroundColor: '#DDD6CC',
  },
  redeemBtnText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 11,
    color: '#FFFFFF',
  },
  redeemBtnTextDisabled: {
    color: '#6B7280',
  },
});

// ─── Screen ───────────────────────────────────────────────────────────────────

export function MemberProfileScreen(): React.JSX.Element {
  const { userName, logout } = useAuth();

  const profileQuery = useMemberProfile();
  const rewardsQuery = useMemberRewards();
  const updateProfile = useUpdateMemberProfile();

  const apiProfile = profileQuery.data;

  // Use API data when available, fall back to auth userName
  const displayName = userName ?? 'Member';

  // Committed name state
  const [name, setName] = useState(displayName);
  const [rewardsBalance, setRewardsBalance] = useState<number | null>(null);

  // Sync rewardsBalance from API once loaded
  React.useEffect(() => {
    if (apiProfile?.rewardsBalance !== undefined) {
      setRewardsBalance(apiProfile.rewardsBalance);
    }
  }, [apiProfile?.rewardsBalance]);

  const effectiveBalance = rewardsBalance ?? apiProfile?.rewardsBalance ?? 0;

  // Edit mode
  const [isEditing, setIsEditing] = useState(false);

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

  // Re-initialize draft when API data loads
  React.useEffect(() => {
    if (apiProfile) {
      setDraft(buildDraft(displayName, {
        zipCode: apiProfile.zipCode,
        primaryLanguage: apiProfile.primaryLanguage,
        primaryNeed: apiProfile.primaryNeed,
        insuranceProvider: apiProfile.insuranceProvider,
      }));
    }
  // Only run when profile data first arrives
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiProfile?.id]);

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

  const handleCancel = useCallback(() => {
    setIsEditing(false);
  }, []);

  const handleSave = useCallback(() => {
    const updatedName = [draft.firstName.trim(), draft.lastName.trim()]
      .filter(Boolean)
      .join(' ');
    if (updatedName) {
      setName(updatedName);
    }
    // Persist changes to the backend
    void updateProfile.mutateAsync({
      zipCode: draft.zipCode,
      primaryLanguage: draft.primaryLanguage,
      primaryNeed: draft.primaryNeed,
      insuranceProvider: draft.insuranceProvider,
      preferredMode: chwPreferences.sessionModePreference,
    }).catch(() => {
      // Silently ignore network errors — local state is already updated
    });
    setIsEditing(false);
  }, [draft, chwPreferences.sessionModePreference, updateProfile]);

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
    (item: RedemptionItem) => {
      if (effectiveBalance < item.pointsCost) {
        Alert.alert(
          'Insufficient Points',
          `You need ${item.pointsCost - effectiveBalance} more points to redeem ${item.name}.`,
        );
        return;
      }
      Alert.alert(
        `Redeem ${item.name}?`,
        `This will use ${item.pointsCost} points from your balance.\n\nCurrent balance: ${effectiveBalance} pts`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Confirm',
            onPress: () => {
              setRewardsBalance((prev) => (prev ?? effectiveBalance) - item.pointsCost);
              Alert.alert('Redemption Submitted', `Your ${item.name} request has been submitted.`);
            },
          },
        ],
      );
    },
    [effectiveBalance],
  );

  const handleSignOut = useCallback(() => {
    Alert.alert(
      'Sign Out',
      'Are you sure you want to sign out?',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Sign Out', style: 'destructive', onPress: () => void logout() },
      ],
    );
  }, [logout]);

  const initials = getInitials(name);

  const committedDraft = buildDraft(name, fallbackProfile);

  if (profileQuery.isLoading) {
    return (
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        <StatusBar barStyle="dark-content" backgroundColor={colors.background} />
        <View style={{ flex: 1, padding: 16, paddingTop: 20 }}>
          <LoadingSkeleton variant="card" />
          <LoadingSkeleton variant="rows" rows={4} />
        </View>
      </SafeAreaView>
    );
  }

  if (profileQuery.error) {
    return (
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        <StatusBar barStyle="dark-content" backgroundColor={colors.background} />
        <ErrorState
          message="Could not load your profile. Please try again."
          onRetry={() => void profileQuery.refetch()}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <StatusBar barStyle="dark-content" backgroundColor={colors.background} />

      {/* ── Header with Edit/Save/Cancel ── */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>My Profile</Text>
        {isEditing ? (
          <View style={styles.headerActions}>
            <TouchableOpacity
              style={styles.headerCancelBtn}
              onPress={handleCancel}
              accessibilityRole="button"
              accessibilityLabel="Cancel editing"
            >
              <X size={16} color={colors.mutedForeground} />
              <Text style={styles.headerCancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.headerSaveBtn}
              onPress={handleSave}
              accessibilityRole="button"
              accessibilityLabel="Save profile changes"
            >
              <Check size={16} color="#FFFFFF" />
              <Text style={styles.headerSaveText}>Save</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity
            style={styles.headerEditBtn}
            onPress={handleEditPress}
            accessibilityRole="button"
            accessibilityLabel="Edit profile"
          >
            <Edit2 size={15} color={colors.primary} />
            <Text style={styles.headerEditText}>Edit</Text>
          </TouchableOpacity>
        )}
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* Banner + Avatar + name */}
        <View style={styles.bannerContainer}>
          <View style={styles.banner} />
          <View style={styles.avatarSection}>
            <View style={styles.avatarWrapper}>
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{initials}</Text>
              </View>
            </View>
          {isEditing ? (
            <View style={styles.nameEditRow}>
              <TextInput
                style={[styles.nameInput, { flex: 1 }]}
                value={draft.firstName}
                onChangeText={(text) => setDraft((prev) => ({ ...prev, firstName: text }))}
                placeholder="First name"
                placeholderTextColor={colors.mutedForeground}
                accessibilityLabel="First name"
              />
              <TextInput
                style={[styles.nameInput, { flex: 1 }]}
                value={draft.lastName}
                onChangeText={(text) => setDraft((prev) => ({ ...prev, lastName: text }))}
                placeholder="Last name"
                placeholderTextColor={colors.mutedForeground}
                accessibilityLabel="Last name"
              />
            </View>
          ) : (
            <Text style={styles.displayName}>{name}</Text>
          )}
          <View style={styles.memberBadge}>
            <Text style={styles.memberBadgeText}>Member</Text>
          </View>
          </View>
        </View>

        {/* Rewards balance */}
        <View style={styles.rewardsCard}>
          <View style={styles.rewardsIconBox}>
            <Gift color={colors.compassGold} size={20} />
          </View>
          <View style={styles.rewardsInfo}>
            <Text style={styles.rewardsLabel}>Rewards Balance</Text>
            <Text style={styles.rewardsValue}>{effectiveBalance} points</Text>
          </View>
          <View style={styles.rewardsBadge}>
            <Text style={styles.rewardsBadgeText}>Active</Text>
          </View>
        </View>

        {/* Profile info */}
        {isEditing ? (
          <View style={styles.editCard}>
            <Text style={styles.editCardTitle}>Profile Information</Text>
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
            <View style={styles.pillRow}>
              {ALL_LANGUAGES.map((lang) => {
                const isSelected = draft.primaryLanguage === lang;
                return (
                  <TouchableOpacity
                    key={lang}
                    style={[
                      styles.pill,
                      isSelected
                        ? { backgroundColor: colors.primary + '20', borderColor: colors.primary }
                        : { backgroundColor: colors.card, borderColor: colors.border },
                    ]}
                    onPress={() => setDraft((prev) => ({ ...prev, primaryLanguage: lang }))}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: isSelected }}
                    accessibilityLabel={lang}
                  >
                    <Text
                      style={[
                        styles.pillText,
                        { color: isSelected ? colors.primary : colors.mutedForeground },
                      ]}
                    >
                      {lang}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <View style={{ height: 12 }} />
            <Text style={editFieldStyles.label}>Primary Need</Text>
            <View style={styles.pillRow}>
              {ALL_VERTICALS.map((v) => {
                const isSelected = draft.primaryNeed === v;
                return (
                  <TouchableOpacity
                    key={v}
                    style={[
                      styles.pill,
                      isSelected
                        ? { backgroundColor: colors.primary + '20', borderColor: colors.primary }
                        : { backgroundColor: colors.card, borderColor: colors.border },
                    ]}
                    onPress={() => setDraft((prev) => ({ ...prev, primaryNeed: v }))}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: isSelected }}
                    accessibilityLabel={verticalLabels[v]}
                  >
                    <Text
                      style={[
                        styles.pillText,
                        { color: isSelected ? colors.primary : colors.mutedForeground },
                      ]}
                    >
                      {verticalLabels[v]}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <View style={{ height: 12 }} />
            <EditField
              label="Insurance Provider"
              value={draft.insuranceProvider}
              onChangeText={(text) => setDraft((prev) => ({ ...prev, insuranceProvider: text }))}
              placeholder="Medi-Cal, Kaiser, etc."
            />
          </View>
        ) : (
          <SectionCard title="Profile Information">
            <InfoRow
              icon={<MapPin color={colors.primary} size={16} />}
              label="ZIP Code"
              value={committedDraft.zipCode}
            />
            <View style={styles.divider} />
            <InfoRow
              icon={<Globe color={colors.primary} size={16} />}
              label="Primary Language"
              value={committedDraft.primaryLanguage}
            />
            <View style={styles.divider} />
            <InfoRow
              icon={<Phone color={colors.primary} size={16} />}
              label="Phone"
              value={committedDraft.phone || NOT_PROVIDED}
            />
            <View style={styles.divider} />
            <InfoRow
              icon={<Mail color={colors.primary} size={16} />}
              label="Email"
              value={committedDraft.email || NOT_PROVIDED}
            />
            <View style={styles.divider} />
            <InfoRow
              icon={<Heart color={colors.primary} size={16} />}
              label="Primary Need"
              value={verticalLabels[committedDraft.primaryNeed]}
            />
            <View style={styles.divider} />
            <InfoRow
              icon={<User color={colors.primary} size={16} />}
              label="Insurance"
              value={committedDraft.insuranceProvider || NOT_PROVIDED}
            />
          </SectionCard>
        )}

        {/* CHW Preferences */}
        <SectionCard title="CHW Preferences">
          <View style={styles.prefSection}>
            <Text style={styles.prefLabel}>Gender Preference</Text>
            <View style={styles.segmentRow}>
              {GENDER_OPTIONS.map((opt) => {
                const isSelected = chwPreferences.genderPreference === opt.key;
                return (
                  <TouchableOpacity
                    key={opt.key}
                    style={[
                      styles.segmentBtn,
                      isSelected && styles.segmentBtnActive,
                    ]}
                    onPress={() =>
                      setChwPreferences((prev) => ({
                        ...prev,
                        genderPreference: opt.key,
                      }))
                    }
                    accessibilityRole="radio"
                    accessibilityState={{ selected: isSelected }}
                  >
                    <Text
                      style={[
                        styles.segmentBtnText,
                        isSelected && styles.segmentBtnTextActive,
                      ]}
                    >
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          <View style={styles.divider} />

          <View style={styles.prefSection}>
            <Text style={styles.prefLabel}>Language Preference</Text>
            <Text style={styles.prefHint}>Select all languages you are comfortable with</Text>
            <View style={styles.pillRow}>
              {ALL_LANGUAGES.map((lang) => {
                const isSelected = chwPreferences.languagePreferences.includes(lang);
                return (
                  <TouchableOpacity
                    key={lang}
                    style={[
                      styles.pill,
                      isSelected
                        ? { backgroundColor: colors.primary + '20', borderColor: colors.primary }
                        : { backgroundColor: colors.card, borderColor: colors.border },
                    ]}
                    onPress={() => handleToggleLanguagePref(lang)}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: isSelected }}
                    accessibilityLabel={lang}
                  >
                    <Text
                      style={[
                        styles.pillText,
                        { color: isSelected ? colors.primary : colors.mutedForeground },
                      ]}
                    >
                      {lang}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          <View style={styles.divider} />

          <View style={styles.prefSection}>
            <Text style={styles.prefLabel}>Session Mode Preference</Text>
            <View style={styles.segmentRow}>
              {SESSION_MODE_OPTIONS.map((opt) => {
                const isSelected = chwPreferences.sessionModePreference === opt.key;
                return (
                  <TouchableOpacity
                    key={opt.key}
                    style={[
                      styles.segmentBtn,
                      isSelected && styles.segmentBtnActive,
                    ]}
                    onPress={() =>
                      setChwPreferences((prev) => ({
                        ...prev,
                        sessionModePreference: opt.key,
                      }))
                    }
                    accessibilityRole="radio"
                    accessibilityState={{ selected: isSelected }}
                  >
                    <Text
                      style={[
                        styles.segmentBtnText,
                        isSelected && styles.segmentBtnTextActive,
                      ]}
                    >
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        </SectionCard>

        {/* Notification settings */}
        <SectionCard title="Notifications">
          <NotificationToggleRow
            label="Session Reminders"
            description="Get reminded before upcoming sessions"
            value={notifications.sessionReminders}
            onChange={handleToggleNotification('sessionReminders')}
          />
          <View style={styles.divider} />
          <NotificationToggleRow
            label="Goal Updates"
            description="Progress milestones and check-ins"
            value={notifications.goalUpdates}
            onChange={handleToggleNotification('goalUpdates')}
          />
          <View style={styles.divider} />
          <NotificationToggleRow
            label="Health Tips"
            description="Weekly wellness and resource tips"
            value={notifications.healthTips}
            onChange={handleToggleNotification('healthTips')}
          />
        </SectionCard>

        {/* Rewards history */}
        <View style={styles.rewardsHistoryCard}>
          <View style={styles.rewardsHistoryHeader}>
            <Bell size={16} color={colors.compassGold} />
            <Text style={styles.rewardsHistoryTitle}>Rewards History</Text>
          </View>
          <FlatList
            data={rewardsQuery.data ?? []}
            keyExtractor={(item) => item.id}
            renderItem={({ item, index }) => (
              <>
                {index > 0 ? <View style={styles.divider} /> : null}
                <RewardRow item={item} />
              </>
            )}
            scrollEnabled={false}
            accessibilityLabel="Rewards history list"
          />
        </View>

        {/* Redemption catalog */}
        <View style={styles.catalogSection}>
          <View style={styles.catalogHeader}>
            <ShoppingBag size={16} color={colors.primary} />
            <Text style={styles.catalogTitle}>Redemption Catalog</Text>
          </View>
          <Text style={styles.catalogBalance}>
            Your balance: <Text style={styles.catalogBalanceBold}>{effectiveBalance} pts</Text>
          </Text>
          {redemptionCatalog.map((item) => (
            <RedemptionCard
              key={item.id}
              item={item}
              onRedeem={handleRedeem}
              balance={effectiveBalance}
            />
          ))}
        </View>

        {/* Account */}
        <SectionCard title="Account">
          <TouchableOpacity
            onPress={handleSignOut}
            style={styles.signOutBtn}
            accessibilityRole="button"
            accessibilityLabel="Sign out of your account"
          >
            <LogOut color={colors.destructive} size={18} />
            <Text style={styles.signOutText}>Sign Out</Text>
          </TouchableOpacity>
        </SectionCard>

        <Text style={styles.versionText}>Compass CHW · v1.0.0</Text>
        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#F4F1ED',
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: '#F4F1ED',
    borderBottomWidth: 1,
    borderBottomColor: '#DDD6CC',
  },
  headerTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 18,
    color: '#1E3320',
  },
  headerActions: {
    flexDirection: 'row',
    gap: 8,
  },
  headerEditBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#3D5A3E40',
    backgroundColor: '#3D5A3E10',
  },
  headerEditText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: '#3D5A3E',
  },
  headerSaveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: '#3D5A3E',
  },
  headerSaveText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: '#FFFFFF',
  },
  headerCancelBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    backgroundColor: '#FFFFFF',
  },
  headerCancelText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: '#6B7280',
  },

  scroll: { flex: 1 },
  scrollContent: {
    paddingHorizontal: 16,
    paddingTop: 0,
  },

  // Banner + Avatar
  bannerContainer: {
    marginHorizontal: -16,
    marginBottom: 0,
  },
  banner: {
    height: 80,
    backgroundColor: '#3D5A3E',
  },
  avatarSection: {
    alignItems: 'center',
    marginBottom: 20,
    paddingHorizontal: 16,
    gap: 8,
  },
  avatarWrapper: {
    marginTop: -40,
    marginBottom: 4,
  },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#3D5A3E18',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 4,
    borderColor: '#FFFFFF',
    ...Platform.select({
      ios: {
        shadowColor: '#3D5A3E',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.18,
        shadowRadius: 12,
      },
      android: { elevation: 4 },
    }),
  },
  avatarText: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 24,
    color: '#3D5A3E',
  },
  nameEditRow: {
    flexDirection: 'row',
    gap: 10,
    width: '100%',
  },
  nameInput: {
    borderWidth: 1,
    borderColor: '#DDD6CC',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#FFFFFF',
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#1E3320',
    textAlign: 'center',
  },
  displayName: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 20,
    color: '#1E3320',
  },
  memberBadge: {
    backgroundColor: '#7A9F5A20',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 100,
  },
  memberBadgeText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 11,
    color: '#7A9F5A',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },

  // Rewards summary card
  rewardsCard: {
    backgroundColor: '#D4A35415',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#D4A35430',
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 16,
  },
  rewardsIconBox: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: '#D4A35420',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rewardsInfo: { flex: 1 },
  rewardsLabel: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 10,
    color: '#6B7280',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  rewardsValue: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    color: '#1E3320',
  },
  rewardsBadge: {
    backgroundColor: '#7A9F5A',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
  },
  rewardsBadgeText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 11,
    color: '#FFFFFF',
  },

  // Inline edit card
  editCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    padding: 16,
    marginBottom: 16,
    ...Platform.select({
      ios: {
        shadowColor: '#3D5A3E',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.08,
        shadowRadius: 24,
      },
      android: { elevation: 3 },
    }),
  },
  editCardTitle: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    color: '#6B7280',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 14,
  },

  divider: {
    height: 1,
    backgroundColor: '#DDD6CC',
  },

  // Pill toggles
  pillRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 8,
  },
  pill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 100,
    borderWidth: 1,
  },
  pillText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    lineHeight: 18,
  },

  // CHW preferences
  prefSection: {
    paddingVertical: 12,
  },
  prefLabel: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
    color: '#1E3320',
    marginBottom: 4,
  },
  prefHint: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#6B7280',
    marginBottom: 4,
  },
  segmentRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
    flexWrap: 'wrap',
  },
  segmentBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    backgroundColor: '#F4F1ED',
    alignItems: 'center',
    minWidth: 80,
  },
  segmentBtnActive: {
    backgroundColor: '#3D5A3E20',
    borderColor: '#3D5A3E',
  },
  segmentBtnText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 13,
    color: '#6B7280',
  },
  segmentBtnTextActive: {
    color: '#3D5A3E',
  },

  // Rewards history
  rewardsHistoryCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    padding: 16,
    marginBottom: 16,
    ...Platform.select({
      ios: {
        shadowColor: '#3D5A3E',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.08,
        shadowRadius: 24,
      },
      android: { elevation: 3 },
    }),
  },
  rewardsHistoryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  rewardsHistoryTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    color: '#1E3320',
  },

  // Redemption catalog
  catalogSection: {
    marginBottom: 16,
  },
  catalogHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  catalogTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    color: '#1E3320',
  },
  catalogBalance: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: '#6B7280',
    marginBottom: 12,
  },
  catalogBalanceBold: {
    fontFamily: 'DMSans_700Bold',
    color: '#D4A354',
  },

  // Sign out
  signOutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
  },
  signOutText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#DC2626',
  },

  versionText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#6B7280',
    textAlign: 'center',
    marginBottom: 8,
  },
});

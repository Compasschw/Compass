/**
 * CHWProfileScreen — Profile management for the authenticated CHW.
 *
 * Sections:
 *  - Avatar circle with initials + camera overlay (edit mode)
 *  - Profile info cards (name, email, phone, zip, bio w/ 400 char counter)
 *  - Specializations — toggle pills in edit mode
 *  - Languages — toggle pills in edit mode
 *  - Credentials section with Upload placeholder per credential
 *  - Availability toggle
 *  - Sign out button
 *
 * Edit mode:
 *  - "Edit" button in header opens inline editing of a `draft` state copy.
 *  - "Save" commits draft to profile state; "Cancel" reverts to previous.
 */

import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Switch,
  TextInput,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Mail,
  Phone,
  MapPin,
  Shield,
  Lock,
  UserCheck,
  BookOpen,
  LogOut,
  Star,
  Briefcase,
  Edit2,
  X,
  Check,
  Camera,
  Upload,
  ClipboardCheck,
  ChevronRight,
} from 'lucide-react-native';
import { useNavigation } from '@react-navigation/native';

import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import { useAuth } from '../../context/AuthContext';
import {
  mockCredentials,
  type Vertical,
  type Credential,
  type CredentialStatus,
} from '../../data/mock';
import {
  useChwProfile,
  useUpdateChwProfile,
  useCHWIntake,
  type ChwProfile,
} from '../../hooks/useApiQueries';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';

// ─── Constants ────────────────────────────────────────────────────────────────

const VERTICAL_LABELS: Record<Vertical, string> = {
  housing: 'Housing',
  rehab: 'Rehab & Recovery',
  food: 'Food Security',
  mental_health: 'Mental Health',
  healthcare: 'Healthcare Access',
};

const ALL_VERTICALS: Vertical[] = ['housing', 'rehab', 'food', 'mental_health', 'healthcare'];

const VERTICAL_COLORS: Record<Vertical, string> = {
  housing: '#3B82F6',
  rehab: '#EF4444',
  food: '#F59E0B',
  mental_health: '#8B5CF6',
  healthcare: '#06B6D4',
};

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

const CREDENTIAL_STATUS_COLORS: Record<CredentialStatus, string> = {
  verified: '#16A34A',
  pending: colors.compassGold,
  expired: colors.destructive,
};

const CREDENTIAL_STATUS_LABELS: Record<CredentialStatus, string> = {
  verified: 'Verified',
  pending: 'Pending Review',
  expired: 'Expired',
};

const BIO_MAX_CHARS = 400;

// ─── Draft profile shape ──────────────────────────────────────────────────────

interface ProfileDraft {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  zipCode: string;
  bio: string;
  specializations: Vertical[];
  languages: string[];
}

// ─── CredentialIcon helper ────────────────────────────────────────────────────

function CredentialIconComponent({
  type,
}: {
  type: Credential['type'];
}): React.JSX.Element {
  switch (type) {
    case 'chw_certification':
      return <Shield size={16} color={colors.primary} />;
    case 'hipaa_training':
      return <Lock size={16} color="#0077B6" />;
    case 'background_check':
      return <UserCheck size={16} color="#D97706" />;
    case 'continuing_education':
      return <BookOpen size={16} color="#7C3AED" />;
  }
}

const CREDENTIAL_ICON_BG: Record<Credential['type'], string> = {
  chw_certification: colors.primary + '18',
  hipaa_training: '#0077B618',
  background_check: '#D9770618',
  continuing_education: '#7C3AED18',
};

function formatCredentialDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// ─── InfoRow (view mode) ──────────────────────────────────────────────────────

interface InfoRowProps {
  icon: React.ReactNode;
  label: string;
  value: string;
}

function InfoRow({ icon, label, value }: InfoRowProps): React.JSX.Element {
  return (
    <View style={infoStyles.row}>
      <View style={infoStyles.iconCircle}>{icon}</View>
      <View style={infoStyles.textBlock}>
        <Text style={infoStyles.label}>{label}</Text>
        <Text style={infoStyles.value}>{value}</Text>
      </View>
    </View>
  );
}

const infoStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: '#E5DFD6',
    marginBottom: 8,
  },
  iconCircle: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: '#3D5A3E15',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  textBlock: {
    flex: 1,
  },
  label: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    letterSpacing: 1,
    color: '#6B7A6B',
    textTransform: 'uppercase',
  },
  value: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 16,
    lineHeight: 24,
    color: '#1E3320',
    marginTop: 1,
  },
});

// ─── EditField (edit mode) ────────────────────────────────────────────────────

interface EditFieldProps {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'email-address' | 'phone-pad' | 'numeric';
  multiline?: boolean;
  maxLength?: number;
}

function EditField({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType = 'default',
  multiline = false,
  maxLength,
}: EditFieldProps): React.JSX.Element {
  return (
    <View style={editFieldStyles.container}>
      <Text style={editFieldStyles.label}>{label}</Text>
      <TextInput
        style={[editFieldStyles.input, multiline && editFieldStyles.inputMultiline]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder ?? label}
        placeholderTextColor={colors.mutedForeground}
        keyboardType={keyboardType}
        multiline={multiline}
        maxLength={maxLength}
        accessibilityLabel={label}
      />
      {maxLength != null ? (
        <Text style={editFieldStyles.charCount}>
          {value.length}/{maxLength}
        </Text>
      ) : null}
    </View>
  );
}

const editFieldStyles = StyleSheet.create({
  container: {
    marginBottom: 12,
  },
  label: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    letterSpacing: 1,
    color: '#6B7A6B',
    textTransform: 'uppercase',
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
    lineHeight: 20,
    color: '#1E3320',
  },
  inputMultiline: {
    minHeight: 100,
    textAlignVertical: 'top',
  },
  charCount: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    letterSpacing: 1,
    color: '#6B7A6B',
    textAlign: 'right',
    marginTop: 4,
  },
});

// ─── Main Component ───────────────────────────────────────────────────────────

/**
 * CHW Profile screen — shows profile info, credentials, and account actions.
 * Supports inline editing via a draft state pattern.
 */
export function CHWProfileScreen(): React.JSX.Element {
  const { logout, userName } = useAuth();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const navigation = useNavigation<any>();

  const { data: apiProfile, isLoading, error, refetch } = useChwProfile();
  const updateProfile = useUpdateChwProfile();
  const { data: intake } = useCHWIntake();

  // Derive display name from auth context (API profile has no name field)
  const displayName = userName ?? 'My Profile';
  const nameParts = displayName.split(' ');
  const avatarInitials = nameParts
    .slice(0, 2)
    .map((p) => p[0] ?? '')
    .join('')
    .toUpperCase();

  // Local availability state synced from API on mount
  const [isAvailable, setIsAvailable] = useState(apiProfile?.isAvailable ?? true);
  useEffect(() => {
    if (apiProfile != null) {
      setIsAvailable(apiProfile.isAvailable);
    }
  }, [apiProfile]);

  // Edit mode state
  const [isEditing, setIsEditing] = useState(false);

  /**
   * Build a draft from the current API profile.
   */
  function buildDraft(p: ChwProfile | undefined): ProfileDraft {
    const authNameParts = displayName.split(' ');
    return {
      firstName: authNameParts[0] ?? '',
      lastName: authNameParts.slice(1).join(' '),
      phone: '(213) 555-0192',
      email: 'maria.reyes@compasschw.org',
      zipCode: p?.zipCode ?? '',
      bio: p?.bio ?? '',
      specializations: [...(p?.specializations ?? [])] as Vertical[],
      languages: [...(p?.languages ?? [])],
    };
  }

  const [draft, setDraft] = useState<ProfileDraft>(() => buildDraft(apiProfile));

  const handleEditPress = useCallback(() => {
    setDraft(buildDraft(apiProfile));
    setIsEditing(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiProfile]);

  const handleCancel = useCallback(() => {
    setIsEditing(false);
  }, []);

  const handleSave = useCallback(() => {
    void updateProfile.mutateAsync({
      zipCode: draft.zipCode.trim() || apiProfile?.zipCode,
      bio: draft.bio.trim() || apiProfile?.bio,
      specializations: draft.specializations,
      languages: draft.languages,
    });
    setIsEditing(false);
  }, [draft, apiProfile, updateProfile]);

  const handleToggleSpecialization = useCallback((vertical: Vertical) => {
    setDraft((prev) => {
      const isSelected = prev.specializations.includes(vertical);
      return {
        ...prev,
        specializations: isSelected
          ? prev.specializations.filter((v) => v !== vertical)
          : [...prev.specializations, vertical],
      };
    });
  }, []);

  const handleToggleLanguage = useCallback((lang: string) => {
    setDraft((prev) => {
      const isSelected = prev.languages.includes(lang);
      return {
        ...prev,
        languages: isSelected
          ? prev.languages.filter((l) => l !== lang)
          : [...prev.languages, lang],
      };
    });
  }, []);

  const handleAvatarPress = useCallback(() => {
    Alert.alert('Photo picker coming soon', 'Avatar upload will be available in a future release.');
  }, []);

  const handleCredentialUpload = useCallback((credLabel: string) => {
    Alert.alert('Upload coming soon', `Credential upload for "${credLabel}" will be available in a future release.`);
  }, []);

  const handleToggleAvailability = useCallback((value: boolean) => {
    setIsAvailable(value);
    void updateProfile.mutateAsync({ isAvailable: value });
  }, [updateProfile]);

  const handleSignOut = useCallback(async () => {
    await logout();
  }, [logout]);

  const displayEmail = 'maria.reyes@compasschw.org';
  const displayPhone = '(213) 555-0192';

  if (isLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>My Profile</Text>
        </View>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
          <LoadingSkeleton variant="card" />
          <LoadingSkeleton variant="rows" rows={4} />
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <ErrorState message="Failed to load profile" onRetry={() => void refetch()} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* ── Header with Edit/Save/Cancel buttons ── */}
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
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── Banner + Avatar header ── */}
        <View style={styles.bannerContainer}>
          <View style={styles.banner} />
          <View style={styles.avatarSection}>
            <TouchableOpacity
              onPress={isEditing ? handleAvatarPress : undefined}
              style={styles.avatarWrapper}
              accessibilityRole={isEditing ? 'button' : 'image'}
              accessibilityLabel={isEditing ? 'Change avatar photo' : 'Profile avatar'}
              disabled={!isEditing}
            >
              <View style={styles.avatarCircle}>
                <Text style={styles.avatarInitials}>{avatarInitials}</Text>
              </View>
              {isEditing ? (
                <View style={styles.cameraOverlay}>
                  <Camera size={16} color="#FFFFFF" />
                </View>
              ) : null}
            </TouchableOpacity>

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
            <Text style={styles.profileName}>{displayName}</Text>
          )}

          <View style={styles.statsRow}>
            <View style={styles.statPill}>
              <Star size={12} color={colors.compassGold} />
              <Text style={styles.statPillText}>{(apiProfile?.rating ?? 0).toFixed(1)} rating</Text>
            </View>
            <View style={styles.statPill}>
              <Briefcase size={12} color={colors.secondary} />
              <Text style={styles.statPillText}>{apiProfile?.yearsExperience ?? 0} yrs exp</Text>
            </View>
            <View style={styles.statPill}>
              <Text style={styles.statPillText}>{apiProfile?.totalSessions ?? 0} sessions</Text>
            </View>
          </View>
          </View>
        </View>

        {/* ── Personal info ── */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Personal Info</Text>
          {isEditing ? (
            <>
              <EditField
                label="Phone"
                value={draft.phone}
                onChangeText={(text) => setDraft((prev) => ({ ...prev, phone: text }))}
                keyboardType="phone-pad"
                placeholder="(213) 555-0000"
              />
              <EditField
                label="Email"
                value={draft.email}
                onChangeText={(text) => setDraft((prev) => ({ ...prev, email: text }))}
                keyboardType="email-address"
                placeholder="your@email.com"
              />
              <EditField
                label="Zip Code"
                value={draft.zipCode}
                onChangeText={(text) => setDraft((prev) => ({ ...prev, zipCode: text }))}
                keyboardType="numeric"
                placeholder="90033"
              />
            </>
          ) : (
            <>
              <View style={styles.divider} />
              <InfoRow
                icon={<Mail size={16} color={colors.primary} />}
                label="Email"
                value={displayEmail}
              />
              <View style={styles.divider} />
              <InfoRow
                icon={<Phone size={16} color={colors.primary} />}
                label="Phone"
                value={displayPhone}
              />
              <View style={styles.divider} />
              <InfoRow
                icon={<MapPin size={16} color={colors.primary} />}
                label="Zip Code"
                value={apiProfile?.zipCode ?? '—'}
              />
            </>
          )}
        </View>

        {/* ── Bio ── */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>About</Text>
          {isEditing ? (
            <EditField
              label="Bio"
              value={draft.bio}
              onChangeText={(text) => setDraft((prev) => ({ ...prev, bio: text }))}
              multiline
              maxLength={BIO_MAX_CHARS}
              placeholder="Tell members about your background and specializations..."
            />
          ) : (
            <Text style={styles.bioText}>{apiProfile?.bio ?? ''}</Text>
          )}
        </View>

        {/* ── Specializations ── */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Specializations</Text>
          {isEditing ? (
            <>
              <Text style={styles.toggleHint}>Tap to select your specializations</Text>
              <View style={styles.pillRow}>
                {ALL_VERTICALS.map((spec) => {
                  const isSelected = draft.specializations.includes(spec);
                  return (
                    <TouchableOpacity
                      key={spec}
                      style={[
                        styles.pill,
                        styles.pillBorder,
                        isSelected
                          ? { backgroundColor: colors.primary + '20', borderColor: colors.primary }
                          : { backgroundColor: colors.card, borderColor: colors.border },
                      ]}
                      onPress={() => handleToggleSpecialization(spec)}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: isSelected }}
                      accessibilityLabel={VERTICAL_LABELS[spec]}
                    >
                      <Text
                        style={[
                          styles.pillText,
                          { color: isSelected ? colors.primary : colors.mutedForeground },
                        ]}
                      >
                        {VERTICAL_LABELS[spec]}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </>
          ) : (
            <View style={styles.pillRow}>
              {(apiProfile?.specializations ?? []).map((spec) => (
                <View
                  key={spec}
                  style={[
                    styles.pill,
                    { backgroundColor: (VERTICAL_COLORS[spec as Vertical] ?? '#6B7A6B') + '18' },
                  ]}
                >
                  <Text style={[styles.pillText, { color: VERTICAL_COLORS[spec as Vertical] ?? '#6B7A6B' }]}>
                    {VERTICAL_LABELS[spec as Vertical] ?? spec}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </View>

        {/* ── Languages ── */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Languages</Text>
          {isEditing ? (
            <>
              <Text style={styles.toggleHint}>Tap to select the languages you speak</Text>
              <View style={styles.pillRow}>
                {ALL_LANGUAGES.map((lang) => {
                  const isSelected = draft.languages.includes(lang);
                  return (
                    <TouchableOpacity
                      key={lang}
                      style={[
                        styles.pill,
                        styles.pillBorder,
                        isSelected
                          ? { backgroundColor: colors.primary + '20', borderColor: colors.primary }
                          : { backgroundColor: colors.card, borderColor: colors.border },
                      ]}
                      onPress={() => handleToggleLanguage(lang)}
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
            </>
          ) : (
            <View style={styles.pillRow}>
              {(apiProfile?.languages ?? []).map((lang) => (
                <View key={lang} style={[styles.pill, { backgroundColor: colors.primary + '18' }]}>
                  <Text style={[styles.pillText, { color: colors.primary }]}>{lang}</Text>
                </View>
              ))}
            </View>
          )}
        </View>

        {/* ── Credentials ── */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Credentials</Text>
          {mockCredentials.map((cred, index) => {
            const statusColor = CREDENTIAL_STATUS_COLORS[cred.status];
            return (
              <View key={cred.id}>
                {index > 0 ? <View style={styles.divider} /> : null}
                <View style={styles.credRow}>
                  <View
                    style={[
                      styles.credIconCircle,
                      { backgroundColor: CREDENTIAL_ICON_BG[cred.type] },
                    ]}
                  >
                    <CredentialIconComponent type={cred.type} />
                  </View>
                  <View style={styles.credInfo}>
                    <View style={styles.credTitleRow}>
                      <Text style={styles.credLabel}>{cred.label}</Text>
                      <View style={[styles.badge, { backgroundColor: statusColor + '18' }]}>
                        <Text style={[styles.badgeText, { color: statusColor }]}>
                          {CREDENTIAL_STATUS_LABELS[cred.status]}
                        </Text>
                      </View>
                    </View>
                    {cred.expirationDate ? (
                      <Text style={styles.credMeta}>
                        Expires {formatCredentialDate(cred.expirationDate)}
                      </Text>
                    ) : cred.uploadDate ? (
                      <Text style={styles.credMeta}>
                        Uploaded {formatCredentialDate(cred.uploadDate)}
                      </Text>
                    ) : null}
                    {cred.type === 'continuing_education' &&
                    cred.creditHours != null &&
                    cred.requiredHours != null ? (
                      <Text style={styles.credMeta}>
                        {cred.creditHours}/{cred.requiredHours} credit hours
                      </Text>
                    ) : null}
                    {isEditing ? (
                      <TouchableOpacity
                        style={styles.uploadButton}
                        onPress={() => handleCredentialUpload(cred.label)}
                        accessibilityRole="button"
                        accessibilityLabel={`Upload ${cred.label}`}
                      >
                        <Upload size={13} color={colors.primary} />
                        <Text style={styles.uploadButtonText}>Upload</Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                </View>
              </View>
            );
          })}
        </View>

        {/* ── Professional intake ── */}
        <TouchableOpacity
          style={styles.intakeRowCard}
          onPress={() => navigation.navigate('Intake')}
          accessibilityRole="button"
          accessibilityLabel={
            intake?.completedAt
              ? 'Edit your professional intake'
              : 'Continue your professional intake'
          }
          activeOpacity={0.8}
        >
          <View style={styles.intakeRowIcon}>
            <ClipboardCheck size={18} color={colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.intakeRowTitle}>Professional Intake</Text>
            <Text style={styles.intakeRowSubtitle}>
              {intake?.completedAt
                ? 'Completed — tap to review or update answers'
                : intake && (intake.lastCompletedSection ?? 0) > 0
                ? `${intake.lastCompletedSection} of 6 sections — resume`
                : '27 questions help us match you with the right members'}
            </Text>
          </View>
          <ChevronRight size={18} color={colors.mutedForeground} />
        </TouchableOpacity>

        {/* ── Availability toggle ── */}
        <View style={styles.toggleCard}>
          <View style={styles.toggleInfo}>
            <Text style={styles.toggleTitle}>Available for Requests</Text>
            <Text style={styles.toggleSubtext}>
              {isAvailable
                ? 'You are visible to members seeking support.'
                : 'You are hidden from new requests.'}
            </Text>
          </View>
          <Switch
            value={isAvailable}
            onValueChange={handleToggleAvailability}
            trackColor={{ false: colors.border, true: colors.primary }}
            thumbColor="#FFFFFF"
            accessibilityLabel="Toggle availability"
          />
        </View>

        {/* ── Sign out ── */}
        <TouchableOpacity
          style={styles.signOutButton}
          onPress={handleSignOut}
          accessibilityRole="button"
          accessibilityLabel="Sign out"
        >
          <LogOut size={18} color={colors.destructive} />
          <Text style={styles.signOutText}>Sign Out</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#F4F1ED',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    backgroundColor: '#F4F1ED',
    borderBottomWidth: 1,
    borderBottomColor: '#DDD6CC',
  },
  headerTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    lineHeight: 22,
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
    borderColor: colors.primary + '40',
    backgroundColor: colors.primary + '10',
  },
  headerEditText: {
    ...typography.bodySm,
    fontWeight: '600',
    color: colors.primary,
  },
  headerSaveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: colors.primary,
  },
  headerSaveText: {
    ...typography.bodySm,
    fontWeight: '700',
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
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  headerCancelText: {
    ...typography.bodySm,
    fontWeight: '600',
    color: colors.mutedForeground,
  },
  scroll: {
    flex: 1,
  },
  content: {
    padding: 20,
    paddingBottom: 48,
  },
  bannerContainer: {
    marginBottom: 24,
  },
  banner: {
    height: 80,
    backgroundColor: '#3D5A3E',
    width: '100%',
  },
  avatarSection: {
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  avatarWrapper: {
    marginTop: -40,
    marginBottom: 12,
    position: 'relative',
  },
  avatarCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#3D5A3E',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 4,
    borderColor: '#FFFFFF',
    shadowColor: '#3D5A3E',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 4,
  },
  avatarInitials: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 24,
    lineHeight: 30,
    color: '#FFFFFF',
  },
  cameraOverlay: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.compassGold,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.background,
  },
  nameEditRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 10,
    paddingHorizontal: 20,
    width: '100%',
  },
  nameInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: colors.card,
    ...typography.bodyMd,
    color: colors.foreground,
    textAlign: 'center',
  },
  profileName: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 24,
    lineHeight: 30,
    color: '#1E3320',
    textAlign: 'center',
    marginBottom: 10,
  },
  statsRow: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
    justifyContent: 'center',
    marginBottom: 16,
  },
  statPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 100,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#DDD6CC',
  },
  statPillText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    letterSpacing: 1,
    color: '#6B7A6B',
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    padding: 16,
    marginBottom: 16,
    shadowColor: '#3D5A3E',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 24,
    elevation: 3,
  },
  sectionTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    lineHeight: 22,
    color: '#1E3320',
    marginBottom: 12,
  },
  toggleHint: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    letterSpacing: 1,
    color: '#6B7A6B',
    marginBottom: 10,
  },
  divider: {
    height: 1,
    backgroundColor: '#DDD6CC',
  },
  bioText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#6B7A6B',
    lineHeight: 22,
  },
  pillRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  pill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 100,
  },
  pillBorder: {
    borderWidth: 1,
  },
  pillText: {
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 18,
  },
  credRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 10,
  },
  credIconCircle: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  credInfo: {
    flex: 1,
    gap: 3,
  },
  credTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  credLabel: {
    ...typography.bodyMd,
    fontWeight: '600',
    color: colors.foreground,
    flex: 1,
  },
  credMeta: {
    ...typography.label,
    color: colors.mutedForeground,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 100,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 16,
  },
  uploadButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    alignSelf: 'flex-start',
    marginTop: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.primary + '40',
    backgroundColor: colors.primary + '10',
  },
  uploadButtonText: {
    ...typography.label,
    color: colors.primary,
  },
  intakeRowCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 16,
    shadowColor: '#3D5A3E',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 24,
    elevation: 3,
  },
  intakeRowIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: colors.primary + '18',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  intakeRowTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 14,
    color: colors.foreground,
  },
  intakeRowSubtitle: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: colors.mutedForeground,
    marginTop: 2,
    lineHeight: 16,
  },
  toggleCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 16,
    shadowColor: '#3D5A3E',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 24,
    elevation: 3,
  },
  toggleInfo: {
    flex: 1,
  },
  toggleTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    lineHeight: 22,
    color: '#1E3320',
  },
  toggleSubtext: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#6B7A6B',
    marginTop: 2,
  },
  signOutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#DC262640',
    paddingVertical: 16,
  },
  signOutText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 16,
    color: '#DC2626',
  },
});

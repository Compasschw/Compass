/**
 * MemberFacingCHWProfileScreen — Public-style CHW profile view for members.
 *
 * Symmetric counterpart to CHWMemberProfileScreen (CHW→member direction).
 * Members navigate here by tapping a CHW card in:
 *   - MemberFindScreen (tap "View Profile" on any CHW card)
 *   - Session card (future: tap CHW name)
 *   - In-app chat header (future: tap CHW name)
 *
 * What is shown:
 *   - Hero: avatar initials, first name + last initial, language chips
 *   - Hero badge row: primary specialization, years experience, CA cert badge
 *   - "About" card: languages, modality, service area ZIPs, available days
 *   - "Sessions Together" card: shared_session_count + navigation to history
 *   - Testimonials section — STUB only (feat/testimonials branch owns this)
 *   - Call/Text buttons — DISABLED "Soon" pills (feat/bidirectional-comms owns this)
 *
 * What is deliberately NOT shown:
 *   - CHW phone / email (members contact via the platform, not directly)
 *   - Stripe / payout state (irrelevant to members)
 *   - Other members' session details from the CHW's caseload
 *
 * Route param: { chwId: string }
 * Navigator: MemberFindStack (registered in MemberTabNavigator)
 */

import React, { useCallback } from 'react';
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  ArrowLeft,
  Award,
  Calendar,
  Globe,
  MessageSquare,
  Phone,
  ShieldOff,
  Sparkles,
  Star,
} from 'lucide-react-native';

import { colors } from '../../theme/colors';
import { fonts } from '../../theme/typography';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { useMemberFacingCHWProfile } from '../../hooks/useApiQueries';
import type { MemberFindStackParamList } from '../../navigation/MemberTabNavigator';

// ─── Navigation types ─────────────────────────────────────────────────────────

type CHWProfileRouteProp = RouteProp<MemberFindStackParamList, 'CHWProfile'>;
type CHWProfileNavProp = NativeStackNavigationProp<
  MemberFindStackParamList,
  'CHWProfile'
>;

// ─── Constants ────────────────────────────────────────────────────────────────

const MODALITY_LABELS: Record<string, string> = {
  in_person: 'In Person',
  virtual: 'Virtual',
  hybrid: 'Hybrid (In Person + Virtual)',
};

const DAY_LABELS: Record<string, string> = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
};

const SPECIALIZATION_LABELS: Record<string, string> = {
  housing: 'Housing',
  food: 'Food Security',
  mental_health: 'Mental Health',
  rehab: 'Rehab',
  healthcare: 'Healthcare',
};

// ─── Helper functions ─────────────────────────────────────────────────────────

/**
 * Returns a deterministic avatar background color based on the CHW's initials.
 * Uses the same palette as MemberFindScreen CHWCard for visual consistency.
 */
function getAvatarBgColor(initials: string): string {
  const palette = [
    `${colors.primary}20`,
    '#EBF5FB',
    '#F3E5F5',
    '#FFF3E0',
    '#FCE4EC',
  ];
  const charCode = initials.charCodeAt(0) || 0;
  return palette[charCode % palette.length] ?? `${colors.primary}20`;
}

function getAvatarTextColor(initials: string): string {
  const palette = [
    colors.primary,
    '#0077B6',
    '#7B1FA2',
    '#E65100',
    '#C2185B',
  ];
  const charCode = initials.charCodeAt(0) || 0;
  return palette[charCode % palette.length] ?? colors.primary;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface SectionCardProps {
  title: string;
  children: React.ReactNode;
  titleRight?: React.ReactNode;
}

function SectionCard({
  title,
  children,
  titleRight,
}: SectionCardProps): React.JSX.Element {
  return (
    <View style={sectionCardStyles.container}>
      <View style={sectionCardStyles.titleRow}>
        <Text style={sectionCardStyles.title}>{title}</Text>
        {titleRight}
      </View>
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
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 6,
  },
  title: {
    fontFamily: fonts.bodySemibold,
    fontSize: 12,
    color: '#6B7280',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  body: {
    paddingHorizontal: 16,
    paddingBottom: 14,
  },
});

interface InfoRowProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  placeholder?: boolean;
}

function InfoRow({
  icon,
  label,
  value,
  placeholder = false,
}: InfoRowProps): React.JSX.Element {
  return (
    <View style={infoRowStyles.container}>
      <View style={infoRowStyles.iconBox}>{icon}</View>
      <View style={infoRowStyles.textBox}>
        <Text style={infoRowStyles.label}>{label}</Text>
        <Text
          style={[
            infoRowStyles.value,
            placeholder && infoRowStyles.valuePlaceholder,
          ]}
        >
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
    backgroundColor: '#F4F1ED',
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
    fontFamily: fonts.bodySemibold,
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
  valuePlaceholder: {
    color: '#A0A6AB',
    fontStyle: 'italic',
  },
});

// ─── Main screen ──────────────────────────────────────────────────────────────

/**
 * MemberFacingCHWProfileScreen
 *
 * Route params: { chwId: string }
 */
export function MemberFacingCHWProfileScreen(): React.JSX.Element {
  const route = useRoute<CHWProfileRouteProp>();
  const navigation = useNavigation<CHWProfileNavProp>();
  const { chwId } = route.params;

  const { data: profile, isLoading, error } = useMemberFacingCHWProfile(chwId);

  // ── Back navigation ─────────────────────────────────────────────────────────
  const handleGoBack = useCallback(() => {
    navigation.goBack();
  }, [navigation]);

  // ── Derive display values ───────────────────────────────────────────────────

  const initials = profile
    ? `${profile.firstName[0] ?? ''}${profile.lastNameInitial[0] ?? ''}`.toUpperCase()
    : '??';

  const displayName = profile
    ? `${profile.firstName} ${profile.lastNameInitial}`.trim()
    : '';

  // ── Loading skeleton ────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <SafeAreaView style={s.safeArea} edges={['top']}>
        <StatusBar barStyle="dark-content" backgroundColor="#F4F1ED" />
        <View style={s.header}>
          <TouchableOpacity
            style={s.backBtn}
            onPress={handleGoBack}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <ArrowLeft size={20} color={colors.foreground} />
          </TouchableOpacity>
          <Text style={s.headerTitle}>CHW Profile</Text>
          <View style={{ width: 40 }} />
        </View>
        <View style={s.pageWrap}>
          <LoadingSkeleton variant="card" />
          <LoadingSkeleton variant="rows" rows={4} />
        </View>
      </SafeAreaView>
    );
  }

  // ── 404 / error state ───────────────────────────────────────────────────────

  if (error != null || !profile) {
    return (
      <SafeAreaView style={s.safeArea} edges={['top']}>
        <StatusBar barStyle="dark-content" backgroundColor="#F4F1ED" />
        <View style={s.header}>
          <TouchableOpacity
            style={s.backBtn}
            onPress={handleGoBack}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <ArrowLeft size={20} color={colors.foreground} />
          </TouchableOpacity>
          <Text style={s.headerTitle}>CHW Profile</Text>
          <View style={{ width: 40 }} />
        </View>
        <View style={s.emptyState}>
          <View style={s.emptyIconCircle}>
            <ShieldOff size={28} color={colors.mutedForeground} />
          </View>
          <Text style={s.emptyTitle}>Profile not found</Text>
          <Text style={s.emptySubtext}>
            This CHW profile is no longer available. They may have left the platform.
          </Text>
          <TouchableOpacity
            style={s.backButton}
            onPress={handleGoBack}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Text style={s.backButtonText}>Go Back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ── Avatar colors ───────────────────────────────────────────────────────────
  const avatarBg = getAvatarBgColor(initials);
  const avatarTextColor = getAvatarTextColor(initials);

  // ── All languages ───────────────────────────────────────────────────────────
  const allLanguages = [
    profile.primaryLanguage,
    ...profile.additionalLanguages,
  ].filter(Boolean);

  return (
    <SafeAreaView style={s.safeArea} edges={['top']}>
      <StatusBar barStyle="dark-content" backgroundColor="#F4F1ED" />

      {/* ── Screen header ── */}
      <View style={s.header}>
        <TouchableOpacity
          style={s.backBtn}
          onPress={handleGoBack}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <ArrowLeft size={20} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={s.headerTitle} numberOfLines={1}>
          CHW Profile
        </Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={s.pageWrap}>

          {/* ── Hero — green banner, avatar, name, language + cert chips ── */}
          <View style={s.bannerContainer}>
            <View style={s.banner} />
            <View style={s.heroSection}>
              <View style={s.avatarWrapper}>
                <View style={[s.avatar, { backgroundColor: avatarBg }]}>
                  <Text style={[s.avatarText, { color: avatarTextColor }]}>
                    {initials}
                  </Text>
                </View>
              </View>

              <Text style={s.displayName}>{displayName}</Text>

              {/* Specialization + experience headline */}
              {profile.primarySpecialization != null && (
                <Text style={s.heroSpecialization}>
                  {SPECIALIZATION_LABELS[profile.primarySpecialization] ??
                    profile.primarySpecialization}
                  {profile.yearsExperience != null
                    ? `  ·  ${profile.yearsExperience}`
                    : ''}
                </Text>
              )}

              {/* Badge row: primary language + CA cert */}
              <View style={s.heroBadgesRow}>
                {allLanguages.slice(0, 3).map((lang) => (
                  <View key={lang} style={s.languageBadge}>
                    <Globe size={11} color="#3D5A3E" />
                    <Text style={s.languageBadgeText}>{lang}</Text>
                  </View>
                ))}
                {allLanguages.length > 3 && (
                  <View style={s.languageBadge}>
                    <Text style={s.languageBadgeText}>
                      +{allLanguages.length - 3} more
                    </Text>
                  </View>
                )}
                {profile.caChwCertified && (
                  <View
                    style={s.certBadge}
                    accessibilityLabel="California CHW Certified"
                  >
                    <Award size={11} color="#1D4ED8" />
                    <Text style={s.certBadgeText}>CA Certified</Text>
                  </View>
                )}
              </View>
            </View>
          </View>

          {/* ── Call / Text — DISABLED "Soon" pills ── */}
          {/* TODO(merge): swap for ProfileContactButtons component from feat/bidirectional-comms branch */}
          <View
            style={s.actionRow}
            accessibilityRole="group"
            accessibilityLabel="Contact CHW — coming soon"
          >
            <TouchableOpacity
              style={[s.actionBtn, s.actionBtnDisabled]}
              disabled
              accessibilityRole="button"
              accessibilityLabel="Call CHW — coming soon"
              accessibilityHint="Direct calling is not yet available"
            >
              <Phone size={16} color="#94A3B8" />
              <Text style={s.actionBtnDisabledText}>Call</Text>
              <View style={s.comingSoonPill}>
                <Text style={s.comingSoonText}>Soon</Text>
              </View>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.actionBtn, s.actionBtnDisabled]}
              disabled
              accessibilityRole="button"
              accessibilityLabel="Text CHW — coming soon"
              accessibilityHint="Texting is not yet available"
            >
              <MessageSquare size={16} color="#94A3B8" />
              <Text style={s.actionBtnDisabledText}>Text</Text>
              <View style={s.comingSoonPill}>
                <Text style={s.comingSoonText}>Soon</Text>
              </View>
            </TouchableOpacity>
          </View>

          {/* ── About ── */}
          <SectionCard title="About">
            {/* Languages */}
            <InfoRow
              icon={<Globe size={16} color={colors.primary} />}
              label={allLanguages.length > 1 ? 'Languages' : 'Language'}
              value={allLanguages.length > 0 ? allLanguages.join(', ') : 'Not specified'}
              placeholder={allLanguages.length === 0}
            />

            {/* Modality */}
            <InfoRow
              icon={<Calendar size={16} color={colors.primary} />}
              label="Session Type"
              value={
                profile.modality != null
                  ? (MODALITY_LABELS[profile.modality] ?? profile.modality)
                  : 'Not specified'
              }
              placeholder={profile.modality == null}
            />

            {/* Service area ZIPs */}
            {profile.serviceAreaZips.length > 0 && (
              <View style={s.chipsBlock}>
                <Text style={s.chipsLabel}>Service Area ZIPs</Text>
                <View style={s.chipsRow}>
                  {profile.serviceAreaZips.map((zip) => (
                    <View key={zip} style={s.zipChip}>
                      <Text style={s.zipChipText}>{zip}</Text>
                    </View>
                  ))}
                </View>
              </View>
            )}

            {/* Available days */}
            {profile.availableDays.length > 0 && (
              <View style={s.chipsBlock}>
                <Text style={s.chipsLabel}>Availability</Text>
                <View style={s.chipsRow}>
                  {profile.availableDays.map((day) => (
                    <View key={day} style={s.dayChip}>
                      <Text style={s.dayChipText}>
                        {DAY_LABELS[day] ?? day}
                      </Text>
                    </View>
                  ))}
                </View>
              </View>
            )}
          </SectionCard>

          {/* ── Sessions Together ── */}
          <SectionCard
            title="Sessions Together"
            titleRight={
              profile.sharedSessionCount > 0 ? (
                <View style={s.countBadge}>
                  <Text style={s.countBadgeText}>
                    {profile.sharedSessionCount}{' '}
                    {profile.sharedSessionCount === 1 ? 'session' : 'sessions'}
                  </Text>
                </View>
              ) : undefined
            }
          >
            {profile.sharedSessionCount > 0 ? (
              <View style={s.sessionsTogether}>
                <Star size={15} color={colors.primary} />
                <Text style={s.sessionsTogetherText}>
                  You have had{' '}
                  <Text style={s.sessionsTogetherBold}>
                    {profile.sharedSessionCount}{' '}
                    {profile.sharedSessionCount === 1 ? 'session' : 'sessions'}
                  </Text>{' '}
                  together.
                </Text>
              </View>
            ) : (
              <View style={s.sessionsTogether}>
                <Text
                  style={[s.sessionsTogetherText, { fontStyle: 'italic', color: '#A0A6AB' }]}
                >
                  No sessions together yet. Schedule your first session to get started.
                </Text>
              </View>
            )}
          </SectionCard>

          {/* ── Testimonials — STUB ── */}
          {/* TODO(merge): swap for TestimonialsList component from feat/testimonials branch */}
          <SectionCard
            title="Testimonials"
            titleRight={
              <View style={s.betaBadge}>
                <Sparkles size={10} color={colors.secondary} />
                <Text style={s.betaBadgeText}>Coming soon</Text>
              </View>
            }
          >
            <View style={s.testimonialStub}>
              <ActivityIndicator
                size="small"
                color={colors.mutedForeground}
                style={{ opacity: 0 }}
              />
              <Text style={s.testimonialStubText}>
                Testimonials loading...
              </Text>
            </View>
          </SectionCard>

          <View style={{ height: 40 }} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#F4F1ED',
  },

  // ── Header
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
    flex: 1,
    textAlign: 'center',
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#DDD6CC',
    alignItems: 'center',
    justifyContent: 'center',
  },

  // ── Scroll
  scroll: { flex: 1 },
  scrollContent: {
    flexGrow: 1,
    alignItems: 'center',
  },
  pageWrap: {
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingTop: 0,
  },

  // ── Hero
  bannerContainer: {
    marginHorizontal: -16,
  },
  banner: {
    height: 80,
    backgroundColor: '#3D5A3E',
  },
  heroSection: {
    alignItems: 'center',
    marginBottom: 20,
    paddingHorizontal: 16,
    gap: 6,
  },
  avatarWrapper: {
    marginTop: -40,
    marginBottom: 4,
  },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
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
  },
  displayName: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 20,
    color: '#1E3320',
  },
  heroSpecialization: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: '#6B7280',
    textAlign: 'center',
  },
  heroBadgesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
    justifyContent: 'center',
    marginTop: 2,
  },
  languageBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#3D5A3E20',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 100,
  },
  languageBadgeText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 12,
    color: '#3D5A3E',
  },
  certBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#1D4ED810',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 100,
    borderWidth: 1,
    borderColor: '#1D4ED840',
  },
  certBadgeText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 12,
    color: '#1D4ED8',
  },

  // ── Call / Text buttons (disabled)
  actionRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 20,
  },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingVertical: 13,
    borderRadius: 13,
  },
  actionBtnDisabled: {
    backgroundColor: '#F1F5F9',
    borderWidth: 1,
    borderColor: '#DDD6CC',
  },
  actionBtnDisabledText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 14,
    color: '#94A3B8',
  },
  comingSoonPill: {
    backgroundColor: '#E2E8F0',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 100,
  },
  comingSoonText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 9,
    color: '#64748B',
    letterSpacing: 0.3,
  },

  // ── ZIP / day chips
  chipsBlock: {
    marginBottom: 8,
  },
  chipsLabel: {
    fontFamily: fonts.bodySemibold,
    fontSize: 10,
    color: '#6B7280',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 8,
  },
  chipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
  },
  zipChip: {
    backgroundColor: colors.primary + '18',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 100,
  },
  zipChipText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 12,
    color: colors.primary,
  },
  dayChip: {
    backgroundColor: '#F4F1ED',
    borderWidth: 1,
    borderColor: '#DDD6CC',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 100,
  },
  dayChipText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 12,
    color: '#6B7280',
  },

  // ── Sessions together
  sessionsTogether: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 6,
  },
  sessionsTogetherText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#1E3320',
    flex: 1,
    lineHeight: 22,
  },
  sessionsTogetherBold: {
    fontFamily: fonts.bodySemibold,
    color: colors.primary,
  },

  // ── Count badge (shared)
  countBadge: {
    backgroundColor: colors.primary + '15',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 100,
  },
  countBadgeText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 10,
    color: colors.primary,
  },

  // ── Beta / coming-soon badge
  betaBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.secondary + '20',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 100,
  },
  betaBadgeText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 10,
    color: colors.secondary,
  },

  // ── Testimonial stub
  testimonialStub: {
    alignItems: 'center',
    paddingVertical: 20,
    gap: 8,
  },
  testimonialStubText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: '#A0A6AB',
    fontStyle: 'italic',
  },

  // ── Error / not found state
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
    gap: 14,
  },
  emptyIconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#3D5A3E15',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 18,
    color: '#1E3320',
    textAlign: 'center',
  },
  emptySubtext: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#6B7280',
    textAlign: 'center',
    maxWidth: 300,
    lineHeight: 22,
  },
  backButton: {
    backgroundColor: '#3D5A3E',
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 12,
    marginTop: 4,
  },
  backButtonText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 14,
    color: '#FFFFFF',
  },
});

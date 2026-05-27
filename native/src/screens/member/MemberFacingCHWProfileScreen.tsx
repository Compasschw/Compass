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
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  ArrowLeft,
  Award,
  BadgeCheck,
  Briefcase,
  Calendar,
  CalendarPlus,
  Clock,
  Globe,
  MapPin,
  MessageSquare,
  Phone,
  ShieldOff,
  Star,
  UserX,
} from 'lucide-react-native';

import { colors } from '../../theme/colors';
import { fonts } from '../../theme/typography';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { useMemberFacingCHWProfile } from '../../hooks/useApiQueries';
import type { MemberFindStackParamList } from '../../navigation/MemberTabNavigator';
import { ProfileContactButtons } from '../../components/comms/ProfileContactButtons';
import { TestimonialsList } from '../../components/testimonials/TestimonialsList';
import { AppShell, Card, Pill, StickyActionBar } from '../../components/ui';
import { useAuth } from '../../context/AuthContext';

// ─── Navigation types ─────────────────────────────────────────────────────────

type CHWProfileRouteProp = RouteProp<MemberFindStackParamList, 'CHWProfile'>;
type CHWProfileNavProp = NativeStackNavigationProp<
  MemberFindStackParamList,
  'CHWProfile'
>;

// ─── Component props ──────────────────────────────────────────────────────────

interface MemberFacingCHWProfileScreenProps {
  /** When provided, overrides the route param. Used by MyCHWScreen to render
   *  the member's *assigned* CHW inline without a stack push. */
  chwId?: string;
  /** Hide the inline back button (used when this screen is the entry point,
   *  not a detail pushed from the find list). */
  hideBack?: boolean;
}

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
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 8,
  },
  title: {
    fontFamily: fonts.bodySemibold,
    // mock: font-semibold text-gray-900 text-sm = 14px/600
    fontSize: 14,
    color: '#111827',
  },
  body: {
    paddingHorizontal: 20,
    paddingBottom: 16,
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
export function MemberFacingCHWProfileScreen(
  { chwId: chwIdProp, hideBack = false }: MemberFacingCHWProfileScreenProps = {},
): React.JSX.Element {
  const navigation = useNavigation<CHWProfileNavProp>();
  // useRoute is safe when this screen is mounted as a stack screen; when
  // rendered inline (e.g. by MyCHWScreen) the active route is FindMain and
  // params is undefined, so we coalesce against the prop.
  const route = useRoute<CHWProfileRouteProp>();
  const chwId = chwIdProp ?? (route.params as { chwId?: string } | undefined)?.chwId ?? '';
  const { userName } = useAuth();

  const { data: profile, isLoading, error } = useMemberFacingCHWProfile(chwId);

  const memberInitials = (userName ?? 'M')
    .split(' ')
    .slice(0, 2)
    .map((p) => p[0] ?? '')
    .join('')
    .toUpperCase();

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

  const shellProps = {
    role: 'member' as const,
    activeKey: 'myChw',
    userBlock: { initials: memberInitials, name: userName ?? 'Member', role: 'Member' as const },
  };

  if (isLoading) {
    return (
      <AppShell {...shellProps}>
        <StatusBar barStyle="dark-content" backgroundColor="#F4F1ED" />
        <View style={s.pageWrap}>
          {!hideBack && (
            <TouchableOpacity
              style={s.backBtn}
              onPress={handleGoBack}
              accessibilityRole="button"
              accessibilityLabel="Go back"
            >
              <ArrowLeft size={20} color={colors.foreground} />
            </TouchableOpacity>
          )}
          <LoadingSkeleton variant="card" />
          <LoadingSkeleton variant="rows" rows={4} />
        </View>
      </AppShell>
    );
  }

  // ── 404 / error state ───────────────────────────────────────────────────────

  if (error != null || !profile) {
    return (
      <AppShell {...shellProps}>
        <StatusBar barStyle="dark-content" backgroundColor="#F4F1ED" />
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
      </AppShell>
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
    <AppShell {...shellProps}>
      <StatusBar barStyle="dark-content" backgroundColor="#F4F1ED" />

      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={s.pageWrap}>
          {/* Back button — hidden when this is the My CHW landing page itself. */}
          {!hideBack && (
            <TouchableOpacity
              style={[s.backBtn, s.backBtnInline]}
              onPress={handleGoBack}
              accessibilityRole="button"
              accessibilityLabel="Go back"
            >
              <ArrowLeft size={18} color={colors.foreground} />
              <Text style={s.backBtnLabel}>My CHW</Text>
            </TouchableOpacity>
          )}

          {/* ── Hero card — avatar, name, Verified pill, star rating, stats ── */}
          <View style={s.heroCard}>
            <View style={s.heroIdentityRow}>
              {/* Avatar with online dot */}
              <View style={s.heroAvatarWrap}>
                <View style={[s.avatar, { backgroundColor: avatarBg }]}>
                  <Text style={[s.avatarText, { color: avatarTextColor }]}>
                    {initials}
                  </Text>
                </View>
                <View style={s.heroOnlineDot} />
              </View>

              <View style={s.heroIdentityInfo}>
                {/* Name + Verified pill */}
                <View style={s.heroNameRow}>
                  <Text style={s.displayName}>{displayName}</Text>
                  <View style={s.verifiedPill}>
                    <BadgeCheck size={12} color="#059669" />
                    <Text style={s.verifiedPillText}>Verified CHW</Text>
                  </View>
                </View>

                {/* Star rating */}
                <View style={s.starRow}>
                  {[1, 2, 3, 4, 5].map((i) => (
                    <Text key={i} style={{ color: '#F59E0B', fontSize: 14 }}>★</Text>
                  ))}
                  <Text style={s.starScore}>4.9</Text>
                  <Text style={s.starReviews}>(48 member reviews)</Text>
                </View>

                {/* Quick stats */}
                <View style={s.heroStatsGrid}>
                  {profile.yearsExperience != null && (
                    <View style={s.heroStatRow}>
                      <Briefcase size={14} color="#9CA3AF" />
                      <Text style={s.heroStatLabel}>Experience</Text>
                      <Text style={s.heroStatValue}>{profile.yearsExperience} yrs as a CHW</Text>
                    </View>
                  )}
                  {profile.serviceAreaZips.length > 0 && (
                    <View style={s.heroStatRow}>
                      <MapPin size={14} color="#9CA3AF" />
                      <Text style={s.heroStatLabel}>Service Area</Text>
                      <Text style={s.heroStatValue}>ZIP {profile.serviceAreaZips.slice(0, 2).join(', ')}</Text>
                    </View>
                  )}
                  <View style={s.heroStatRow}>
                    <Clock size={14} color="#9CA3AF" />
                    <Text style={s.heroStatLabel}>Avg Response</Text>
                    <Text style={s.heroStatValue}>Under 2 hours</Text>
                  </View>
                  {profile.sharedSessionCount > 0 && (
                    <View style={s.heroStatRow}>
                      <Calendar size={14} color="#9CA3AF" />
                      <Text style={s.heroStatLabel}>Your Sessions</Text>
                      <Text style={s.heroStatValue}>{profile.sharedSessionCount} completed</Text>
                    </View>
                  )}
                </View>
              </View>
            </View>

            {/* Language + cert chips */}
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

          {/* ── Call / Text — bidirectional masked Vonage call + in-app message ── */}
          <ProfileContactButtons
            targetUserId={profile.id}
            targetUserRole="chw"
            sharedSessionCount={profile.sharedSessionCount}
            targetDisplayName={`${profile.firstName} ${profile.lastNameInitial}`}
            onNavigateToConversation={() => {
              // Navigate the member to their Sessions/Messages tab — the
              // screen resolves the active conversation from route state.
              navigation.navigate('Sessions' as never);
            }}
          />

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

          {/* ── Testimonials — admin-moderated 1-5 star ratings ── */}
          <SectionCard title="Testimonials">
            <TestimonialsList chwId={profile.id} limit={3} />
          </SectionCard>

          <View style={{ height: 80 }} />
        </View>
      </ScrollView>

      {/* ── Sticky action bar — 5 actions matching mockup ── */}
      <StickyActionBar
        primary={{
          label: `Message ${profile.firstName}`,
          onPress: () => navigation.navigate('Sessions' as never),
        }}
        actions={[
          {
            icon: <Phone size={18} color={colors.foreground} />,
            label: 'Call',
            onPress: () => navigation.navigate('Sessions' as never),
          },
          {
            icon: <CalendarPlus size={18} color={colors.foreground} />,
            label: 'Schedule',
            onPress: () => navigation.goBack(),
          },
          {
            icon: <Star size={18} color={colors.foreground} />,
            label: 'Leave Review',
            onPress: () => navigation.navigate('Sessions' as never),
          },
          {
            icon: <UserX size={18} color={colors.foreground} />,
            label: 'Reassign',
            // Members with existing sessions can't reach the find/match
            // flow because MyCHWScreen auto-renders this profile when any
            // session exists. Navigate to the explicit FindList route on
            // the FindStack to bypass that gate. After picking a CHW
            // (could be the same one) and submitting a new request, a
            // fresh Session is created — fixes the "no way to start a
            // new session with the same CHW" blocker.
            onPress: () => navigation.navigate('FindList' as never),
          },
        ]}
      />
    </AppShell>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#F4F1ED',
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
  /** Inline back button used inside the scroll area instead of a fixed header. */
  backBtnInline: {
    flexDirection: 'row',
    width: 'auto' as unknown as number,
    paddingHorizontal: 12,
    gap: 6,
    marginBottom: 16,
  },
  backBtnLabel: {
    fontFamily: fonts.bodySemibold,
    fontSize: 13,
    color: '#1E3320',
  },

  // ── Scroll
  scroll: { flex: 1 },
  scrollContent: {
    flexGrow: 1,
    alignItems: 'center',
  },
  pageWrap: {
    width: '100%',
    maxWidth: undefined as unknown as number,
    alignSelf: 'center',
    paddingHorizontal: 24,
    paddingTop: 24,
  },

  // ── Hero card
  heroCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    padding: 20,
    marginBottom: 16,
    gap: 14,
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
  heroIdentityRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 16,
  },
  heroAvatarWrap: {
    position: 'relative',
  },
  heroOnlineDot: {
    position: 'absolute',
    bottom: 2,
    right: 2,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#10B981',
    borderWidth: 2,
    borderColor: '#FFFFFF',
  },
  heroIdentityInfo: {
    flex: 1,
    gap: 6,
  },
  heroNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  verifiedPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#D1FAE5',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  verifiedPillText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 11,
    color: '#059669',
  },
  starRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  starScore: {
    fontFamily: fonts.bodySemibold,
    fontSize: 13,
    color: '#111827',
    marginLeft: 2,
  },
  starReviews: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#6B7280',
  },
  heroStatsGrid: {
    gap: 4,
    marginTop: 2,
  },
  heroStatRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  heroStatLabel: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: '#6B7280',
    // w-32 = 128px from mockup
    width: 128,
  },
  heroStatValue: {
    fontFamily: fonts.bodySemibold,
    fontSize: 13,
    color: '#111827',
  },
  avatar: {
    // w-28 = 112px from mockup
    width: 112,
    height: 112,
    borderRadius: 56,
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
    // text-3xl from mockup
    fontSize: 30,
  },
  displayName: {
    fontFamily: 'DMSans_700Bold',
    // text-2xl from mockup
    fontSize: 24,
    color: '#111827',
  },
  heroBadgesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
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

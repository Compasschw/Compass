/**
 * CHWMemberProfileScreen — HIPAA-gated member context view for CHWs.
 *
 * Access gate: the backend returns 403 when the authenticated CHW has no
 * active relationship (session or accepted request) with this member. The
 * screen renders a friendly empty state for that case rather than a generic
 * error, because 403 is an expected, non-exceptional outcome (e.g. a CHW
 * tapping a stale link to a member they no longer have a relationship with).
 *
 * Fields rendered — HIPAA minimum-necessary only:
 *   name, phone (masked-call only), primary language, primary need, ZIP code,
 *   session counts (with this CHW / all-time), last session date.
 *
 * Explicitly NOT rendered:
 *   medi_cal_id, insurance_provider, session notes from any CHW, transcripts.
 *
 * Navigation param: { memberId: string }
 */

import React, { useCallback } from 'react';
import {
  Alert,
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
  Globe,
  Heart,
  MapPin,
  Phone,
  ShieldOff,
  User,
} from 'lucide-react-native';

import { colors } from '../../theme/colors';
import { fonts } from '../../theme/typography';
import { useChwMemberProfile } from '../../hooks/useApiQueries';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import type { CHWSessionsStackParamList } from '../../navigation/CHWTabNavigator';
import { phone as phoneDial } from '../../services/phone';

// ─── Navigation types ─────────────────────────────────────────────────────────

type MemberProfileRouteProp = RouteProp<CHWSessionsStackParamList, 'MemberProfile'>;
type MemberProfileNavProp = NativeStackNavigationProp<
  CHWSessionsStackParamList,
  'MemberProfile'
>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Derive two-letter initials from a display name.
 * Falls back to "?" when the name is blank (shouldn't happen in practice).
 */
function getInitials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '';
  const last = parts[1]?.[0] ?? '';
  return `${first}${last}`.toUpperCase() || '?';
}

/**
 * Format an ISO date string for display (e.g. "Apr 12, 2026").
 * Returns "—" when the value is null/undefined.
 */
function formatDate(isoString: string | null | undefined): string {
  if (!isoString) return '—';
  return new Date(isoString).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Map a raw vertical key to a human-readable label.
 * Falls back to the raw key if it's an unrecognised value.
 */
function formatPrimaryNeed(need: string | null): string {
  if (!need) return 'Not specified';
  const labels: Record<string, string> = {
    housing: 'Housing',
    food: 'Food Security',
    mental_health: 'Mental Health',
    rehab: 'Rehab & Recovery',
    healthcare: 'Healthcare',
  };
  return labels[need] ?? need;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface InfoRowProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  /** When true, renders the value in muted italic — used for "Not provided". */
  placeholder?: boolean;
}

/**
 * Single labelled data row used in the profile cards.
 * Mirrors the InfoRow pattern from MemberProfileScreen for visual consistency.
 */
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

interface SectionCardProps {
  title: string;
  children: React.ReactNode;
}

/**
 * Titled card wrapper used throughout the profile.
 * Mirrors the SectionCard pattern from MemberProfileScreen.
 */
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
    fontFamily: fonts.bodySemibold,
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

// ─── Screen ───────────────────────────────────────────────────────────────────

/**
 * CHWMemberProfileScreen
 *
 * Route params: { memberId: string }
 *
 * Reachable from:
 *   - CHWSessionsScreen: member name tap on any session card
 *   - CHWRequestsScreen: "View Member Profile" on accepted request cards
 *   - CHWSessionReviewScreen: member name tap in the header
 */
export function CHWMemberProfileScreen(): React.JSX.Element {
  const route = useRoute<MemberProfileRouteProp>();
  const navigation = useNavigation<MemberProfileNavProp>();
  const { memberId } = route.params;

  const { data: profile, isLoading, error } = useChwMemberProfile(memberId);

  // ── Call handler ─────────────────────────────────────────────────────────────
  // Initiates a Vonage masked call if the member has a phone on file.
  // We use the same phone.dial() path as CHWSessionsScreen so the UX
  // is consistent and the real phone number is never surfaced on device.

  const handleCallMember = useCallback(async (): Promise<void> => {
    if (!profile?.phone) {
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.alert('No phone number on file for this member.');
      } else {
        Alert.alert('No phone number', 'This member has not provided a phone number.');
      }
      return;
    }

    try {
      // phone.dial() routes through the Vonage bridge — the CHW's device
      // dials the masked proxy number, never the member's real number.
      // No sessionId here: the call is initiated from the profile view, not
      // from within an active session. The Vonage bridge handles bridging
      // based on the relationship established at the API layer.
      await phoneDial.dial({
        callerId: memberId,   // used as context; bridge resolves the CHW from auth
        recipientId: memberId,
      });
    } catch (err) {
      const reason =
        err instanceof Error && err.message.trim().length > 0
          ? err.message
          : 'Unable to connect the call. Please try again.';
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.alert(`Call failed\n\n${reason}`);
      } else {
        Alert.alert('Call failed', reason);
      }
    }
  }, [profile?.phone, memberId]);

  // ── Loading state ─────────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <SafeAreaView style={s.safeArea} edges={['top']}>
        <StatusBar barStyle="dark-content" backgroundColor={colors.background} />
        <View style={s.header}>
          <TouchableOpacity
            style={s.backBtn}
            onPress={() => navigation.goBack()}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <ArrowLeft size={20} color={colors.foreground} />
          </TouchableOpacity>
          <Text style={s.headerTitle}>Member Profile</Text>
          <View style={{ width: 40 }} />
        </View>
        <View style={s.pageWrap}>
          <LoadingSkeleton variant="card" />
          <LoadingSkeleton variant="rows" rows={4} />
        </View>
      </SafeAreaView>
    );
  }

  // ── 403 / no-relationship empty state ────────────────────────────────────────
  // A 403 is not an error — it's the backend correctly enforcing the gate.
  // We render a clear explanation rather than a generic error screen.

  const is403 =
    error != null &&
    typeof error === 'object' &&
    'status' in error &&
    (error as { status: number }).status === 403;

  if (is403 || (error != null && !profile)) {
    return (
      <SafeAreaView style={s.safeArea} edges={['top']}>
        <StatusBar barStyle="dark-content" backgroundColor={colors.background} />
        <View style={s.header}>
          <TouchableOpacity
            style={s.backBtn}
            onPress={() => navigation.goBack()}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <ArrowLeft size={20} color={colors.foreground} />
          </TouchableOpacity>
          <Text style={s.headerTitle}>Member Profile</Text>
          <View style={{ width: 40 }} />
        </View>
        <View style={s.emptyState}>
          <View style={s.emptyIconCircle}>
            <ShieldOff size={28} color={colors.mutedForeground} />
          </View>
          <Text style={s.emptyTitle}>
            {is403 ? "Profile not accessible" : "Could not load profile"}
          </Text>
          <Text style={s.emptySubtext}>
            {is403
              ? "You don't have access to this member's profile yet. You need an active session or accepted request with this member to view their profile."
              : "Check your connection and try again."}
          </Text>
          <TouchableOpacity
            style={s.backButton}
            onPress={() => navigation.goBack()}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Text style={s.backButtonText}>Go Back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ── Profile loaded ────────────────────────────────────────────────────────────

  if (!profile) return <></>;

  const initials = getInitials(profile.name);

  return (
    <SafeAreaView style={s.safeArea} edges={['top']}>
      <StatusBar barStyle="dark-content" backgroundColor={colors.background} />

      {/* ── Screen header ── */}
      <View style={s.header}>
        <TouchableOpacity
          style={s.backBtn}
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <ArrowLeft size={20} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={s.headerTitle} numberOfLines={1}>
          Member Profile
        </Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={s.pageWrap}>

          {/* ── Hero — avatar, name, language badge ── */}
          <View style={s.bannerContainer}>
            <View style={s.banner} />
            <View style={s.heroSection}>
              <View style={s.avatarWrapper}>
                <View style={s.avatar}>
                  <Text style={s.avatarText}>{initials}</Text>
                </View>
              </View>
              <Text style={s.displayName}>{profile.name}</Text>
              {/* Primary language badge — always present (defaults to English) */}
              <View style={s.languageBadge}>
                <Globe size={11} color="#3D5A3E" />
                <Text style={s.languageBadgeText}>{profile.primaryLanguage}</Text>
              </View>
            </View>
          </View>

          {/* ── Quick action: Call Member (masked) ── */}
          <TouchableOpacity
            style={[s.callButton, !profile.phone && s.callButtonDisabled]}
            onPress={() => { void handleCallMember(); }}
            disabled={!profile.phone}
            accessibilityRole="button"
            accessibilityLabel={
              profile.phone
                ? `Call ${profile.name} using masked number`
                : `${profile.name} has no phone number on file`
            }
            accessibilityState={{ disabled: !profile.phone }}
          >
            <Phone size={16} color="#FFFFFF" />
            <Text style={s.callButtonText}>Call Member (masked)</Text>
          </TouchableOpacity>

          {/* ── About this member ── */}
          <SectionCard title="About This Member">
            <InfoRow
              icon={<Heart size={16} color={colors.primary} />}
              label="Primary Need"
              value={formatPrimaryNeed(profile.primaryNeed)}
              placeholder={!profile.primaryNeed}
            />
            <InfoRow
              icon={<MapPin size={16} color={colors.primary} />}
              label="ZIP Code"
              value={profile.zipCode ?? 'Not provided'}
              placeholder={!profile.zipCode}
            />
            <InfoRow
              icon={<Globe size={16} color={colors.primary} />}
              label="Primary Language"
              value={profile.primaryLanguage}
            />
          </SectionCard>

          {/* ── Session context ── */}
          <SectionCard title="Session Context">
            <View style={s.statRow}>
              {/* Sessions with you */}
              <View style={s.statCard}>
                <Text style={s.statValue}>{profile.totalSessionsWithYou}</Text>
                <Text style={s.statLabel}>Sessions{'\n'}with you</Text>
              </View>
              {/* Divider */}
              <View style={s.statDivider} />
              {/* All-time sessions */}
              <View style={s.statCard}>
                <Text style={s.statValue}>{profile.totalSessionsAllTime}</Text>
                <Text style={s.statLabel}>Sessions{'\n'}all-time</Text>
              </View>
            </View>
            <InfoRow
              icon={<User size={16} color={colors.primary} />}
              label="Last Session With You"
              value={formatDate(profile.lastSessionAt)}
              placeholder={!profile.lastSessionAt}
            />
          </SectionCard>

          {/* ── HIPAA disclosure notice ── */}
          <View style={s.hipaaNotice}>
            <Text style={s.hipaaNoticeText}>
              This view shows only the information needed for care delivery.
              Member identifiers, insurance details, and notes from other CHWs
              are not displayed (HIPAA minimum necessary — 45 CFR §164.514(d)).
            </Text>
          </View>

          <View style={{ height: 32 }} />
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

  scroll: { flex: 1 },
  scrollContent: {
    flexGrow: 1,
    alignItems: 'center',
  },
  // Matches the pageWrap pattern from MemberProfileScreen / PR #48
  pageWrap: {
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingTop: 0,
  },

  // Banner + avatar hero
  bannerContainer: {
    marginHorizontal: -16,
    marginBottom: 0,
  },
  banner: {
    height: 80,
    backgroundColor: '#3D5A3E',
  },
  heroSection: {
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
  displayName: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 20,
    color: '#1E3320',
  },
  languageBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#3D5A3E20',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 100,
  },
  languageBadgeText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 12,
    color: '#3D5A3E',
  },

  // Call button
  callButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#1D4ED8',
    paddingVertical: 14,
    borderRadius: 14,
    marginBottom: 20,
    ...Platform.select({
      ios: {
        shadowColor: '#1D4ED8',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.2,
        shadowRadius: 12,
      },
      android: { elevation: 4 },
    }),
  },
  callButtonDisabled: {
    backgroundColor: '#94A3B8',
  },
  callButtonText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 15,
    color: '#FFFFFF',
  },

  // Session stats
  statRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
    backgroundColor: '#E5DFD6',
    borderRadius: 12,
    overflow: 'hidden',
  },
  statCard: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 16,
    gap: 4,
  },
  statDivider: {
    width: 1,
    height: 48,
    backgroundColor: '#DDD6CC',
  },
  statValue: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 28,
    color: '#1E3320',
    lineHeight: 34,
  },
  statLabel: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#6B7280',
    textAlign: 'center',
    lineHeight: 16,
  },

  // HIPAA notice
  hipaaNotice: {
    backgroundColor: '#F4F1ED',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 8,
  },
  hipaaNoticeText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: '#6B7280',
    lineHeight: 17,
    textAlign: 'center',
  },

  // Empty / access-denied state
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

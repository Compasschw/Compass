/**
 * MemberFacingCHWProfileScreen — Read-only CHW profile for members.
 *
 * Mirrors the CHW-side CHWMemberProfileScreen 3-column top-card pattern but
 * is fully read-only. Members reach this screen via:
 *   - MyCHWScreen (assigned CHW, rendered inline — hideBack=true)
 *   - MemberFindScreen "View Profile" (stack push — hideBack=false)
 *
 * Layout (3-column on web, stacked on native):
 *   Left card  — CHW identity: avatar, name, role pill, specializations, languages, location
 *   Center card — Performance & About: star rating, sessions completed, "About me" bio
 *   Right card  — Relationship context: date assigned, journey progress, Schedule CTA
 *
 * Call / Message wiring (mirrors T15 CHW-side contract):
 *   Tap Call    → navigate Sessions with { chwId, autoCall: true }
 *   Tap Message → navigate Sessions with { chwId }
 *
 * Uses existing `phone` provider (Vonage masked-number). No new BE endpoints.
 *
 * Route param: { chwId: string }
 * Navigator: MemberFindStack (MemberTabNavigator)
 */

import React, { useCallback, useMemo } from 'react';
import {
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type ViewStyle,
  type TextStyle,
  type ImageStyle,
} from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  Award,
  BadgeCheck,
  Calendar,
  CalendarPlus,
  Globe,
  MapPin,
  MessageSquare,
  Phone,
  ShieldOff,
  Star,
  TrendingUp,
} from 'lucide-react-native';

import { colors as tokens, spacing, radius, shadows } from '../../theme/tokens';
import { fonts } from '../../theme/typography';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { useMemberFacingCHWProfile, useSessions } from '../../hooks/useApiQueries';
import type { MemberFindStackParamList, MemberTabParamList } from '../../navigation/MemberTabNavigator';
import {
  AppShell,
  Card,
  PageHeader,
  PageWrap,
  Pill,
  SectionHeader,
  StatTile,
} from '../../components/ui';
import { useAuth } from '../../context/AuthContext';

// ─── Navigation types ─────────────────────────────────────────────────────────

type CHWProfileRouteProp = RouteProp<MemberFindStackParamList, 'CHWProfile'>;

/**
 * The screen lives inside MemberFindStack; but it also needs to navigate to
 * the Sessions tab which sits in the parent MemberTabParamList. Using `any`
 * for the tab navigation prop is the standard cross-stack pattern — the
 * navigator resolves the route at runtime.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RootNavProp = NativeStackNavigationProp<any>;

// ─── Component props ──────────────────────────────────────────────────────────

export interface MemberFacingCHWProfileScreenProps {
  /**
   * When provided, overrides the route param. Used by MyCHWScreen to render
   * the member's assigned CHW inline without a stack push.
   */
  chwId?: string;
  /**
   * Hide the inline back button — set true when this screen IS the landing
   * page (MyCHWScreen renders it with hideBack), false when pushed from
   * the find list.
   */
  hideBack?: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MODALITY_LABELS: Record<string, string> = {
  in_person: 'In Person',
  virtual: 'Virtual',
  hybrid: 'Hybrid (In Person + Virtual)',
} as const;

const DAY_LABELS: Record<string, string> = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
} as const;

// Epic C5: 'housing' is grandfathered (a CHW's pre-existing specialization
// still renders); 'utilities' is the new selectable specialization.
const SPECIALIZATION_LABELS: Record<string, string> = {
  housing: 'Housing',
  utilities: 'Utilities',
  food: 'Food Security',
  mental_health: 'Mental Health',
  transportation: 'Transportation',
  healthcare: 'Healthcare',
  employment: 'Employment',
} as const;

/** Avatar background + text colour palette — deterministic by initial char code. */
const AVATAR_BG_PALETTE = [
  `${tokens.emerald100}`,
  '#EBF5FB',
  '#F3E5F5',
  '#FFF3E0',
  '#FCE4EC',
] as const;

const AVATAR_TEXT_PALETTE = [
  tokens.primary,
  tokens.blue700,
  '#7B1FA2',
  '#E65100',
  '#C2185B',
] as const;

// ─── Helper functions ─────────────────────────────────────────────────────────

/**
 * Returns a deterministic avatar background colour from the first character
 * of the CHW's initials. Matches the palette used in MemberFindScreen cards.
 */
function getAvatarBgColor(initials: string): string {
  const idx = (initials.charCodeAt(0) || 0) % AVATAR_BG_PALETTE.length;
  return AVATAR_BG_PALETTE[idx] ?? tokens.emerald100;
}

function getAvatarTextColor(initials: string): string {
  const idx = (initials.charCodeAt(0) || 0) % AVATAR_TEXT_PALETTE.length;
  return AVATAR_TEXT_PALETTE[idx] ?? tokens.primary;
}

/**
 * Formats an ISO8601 date string to "Month D, YYYY" for the "Assigned since"
 * display in the relationship context card.
 */
function formatAssignedDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Returns the earliest session date (first assignment) from the session list
 * for the given CHW ID. Sessions are expected to be in newest-first order from
 * the API, so we take the last element matching the chwId.
 */
function deriveAssignedDate(
  sessions: Array<{ chwId: string; createdAt: string }>,
  chwId: string,
): string | null {
  const matching = sessions.filter((s) => s.chwId === chwId);
  if (matching.length === 0) return null;
  // Sort ascending to find the earliest.
  const sorted = [...matching].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
  return sorted[0]?.createdAt ?? null;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface InfoRowProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  isPlaceholder?: boolean;
}

/**
 * Labelled icon row inside the Left card. Renders an icon badge, a
 * caps label, and a value line.
 */
function InfoRow({
  icon,
  label,
  value,
  isPlaceholder = false,
}: InfoRowProps): React.JSX.Element {
  return (
    <View style={infoRowStyles.container}>
      <View style={infoRowStyles.iconBadge}>{icon}</View>
      <View style={infoRowStyles.textBlock}>
        <Text style={infoRowStyles.label}>{label}</Text>
        <Text
          style={[
            infoRowStyles.value,
            isPlaceholder && infoRowStyles.valuePlaceholder,
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
    gap: spacing.md,
    backgroundColor: tokens.pageBg,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.sm,
  } as ViewStyle,
  iconBadge: {
    width: 36,
    height: 36,
    borderRadius: radius.lg,
    backgroundColor: `${tokens.primary}18`,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  textBlock: { flex: 1 } as ViewStyle,
  label: {
    fontFamily: fonts.bodySemibold,
    fontSize: 10,
    color: tokens.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 1,
  } as TextStyle,
  value: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: tokens.textPrimary,
    lineHeight: 20,
  } as TextStyle,
  valuePlaceholder: {
    color: tokens.textMuted,
    fontStyle: 'italic',
  } as TextStyle,
});

// ─── Action button ────────────────────────────────────────────────────────────

interface ActionButtonProps {
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
  variant: 'primary' | 'secondary';
  accessibilityLabel: string;
}

/**
 * Tappable action button used in the Call / Message row and the right card CTA.
 */
function ActionButton({
  icon,
  label,
  onPress,
  variant,
  accessibilityLabel,
}: ActionButtonProps): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        actionButtonStyles.base,
        variant === 'primary'
          ? actionButtonStyles.primary
          : actionButtonStyles.secondary,
        pressed && actionButtonStyles.pressed,
      ]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      {icon}
      <Text
        style={[
          actionButtonStyles.label,
          variant === 'primary'
            ? actionButtonStyles.labelPrimary
            : actionButtonStyles.labelSecondary,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const actionButtonStyles = StyleSheet.create({
  base: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: 13,
    borderRadius: radius.lg,
  } as ViewStyle,
  primary: {
    backgroundColor: tokens.primary,
  } as ViewStyle,
  secondary: {
    backgroundColor: tokens.cardBg,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    ...shadows.card,
  } as ViewStyle,
  pressed: {
    opacity: 0.75,
  } as ViewStyle,
  label: {
    fontFamily: fonts.bodySemibold,
    fontSize: 14,
  } as TextStyle,
  labelPrimary: {
    color: tokens.cardBg,
  } as TextStyle,
  labelSecondary: {
    color: tokens.textPrimary,
  } as TextStyle,
});

// ─── Left card — CHW identity ─────────────────────────────────────────────────

interface IdentityCardProps {
  initials: string;
  displayName: string;
  /** CHW's self-uploaded avatar (presigned). Null → fall back to initials. */
  photoUrl?: string | null;
  specializations: string[];
  languages: string[];
  serviceAreaZips: string[];
  caChwCertified: boolean;
  modality: string | null;
}

function IdentityCard({
  initials,
  displayName,
  photoUrl,
  specializations,
  languages,
  serviceAreaZips,
  caChwCertified,
  modality,
}: IdentityCardProps): React.JSX.Element {
  const avatarBg = getAvatarBgColor(initials);
  const avatarText = getAvatarTextColor(initials);

  return (
    <Card style={[cardStyles.base, cardStyles.left]}>
      {/* Avatar + identity */}
      <View style={cardStyles.avatarRow}>
        {photoUrl ? (
          <Image
            source={{ uri: photoUrl }}
            style={cardStyles.avatarImage}
            accessibilityLabel={`${displayName} profile photo`}
          />
        ) : (
          <View style={[cardStyles.avatar, { backgroundColor: avatarBg }]}>
            <Text style={[cardStyles.avatarText, { color: avatarText }]}>
              {initials}
            </Text>
          </View>
        )}
        <View style={cardStyles.onlineDot} />
      </View>

      <Text style={cardStyles.displayName}>{displayName}</Text>

      {/* Role + verified pill */}
      <View style={cardStyles.pillRow}>
        <View style={cardStyles.verifiedPill}>
          <BadgeCheck size={12} color={tokens.emerald700} />
          <Text style={cardStyles.verifiedPillText}>Verified CHW</Text>
        </View>
        {caChwCertified && (
          <View style={cardStyles.certPill}>
            <Award size={11} color={tokens.blue700} />
            <Text style={cardStyles.certPillText}>CA Certified</Text>
          </View>
        )}
      </View>

      <View style={cardStyles.divider} />

      {/* Specializations */}
      {specializations.length > 0 && (
        <View style={cardStyles.chipBlock}>
          <Text style={cardStyles.chipBlockLabel}>Specializations</Text>
          <View style={cardStyles.chipRow}>
            {specializations.map((spec) => (
              <Pill key={spec} variant="emerald" size="sm">
                {SPECIALIZATION_LABELS[spec] ?? spec}
              </Pill>
            ))}
          </View>
        </View>
      )}

      {/* Languages */}
      {languages.length > 0 && (
        <View style={cardStyles.chipBlock}>
          <Text style={cardStyles.chipBlockLabel}>Languages</Text>
          <View style={cardStyles.chipRow}>
            {languages.map((lang) => (
              <Pill key={lang} variant="blue" size="sm">
                {lang}
              </Pill>
            ))}
          </View>
        </View>
      )}

      {/* Info rows */}
      {serviceAreaZips.length > 0 && (
        <InfoRow
          icon={<MapPin size={16} color={tokens.primary} />}
          label="Service Area"
          value={`ZIP ${serviceAreaZips.slice(0, 3).join(', ')}`}
        />
      )}

      {modality != null && (
        <InfoRow
          icon={<Calendar size={16} color={tokens.primary} />}
          label="Session Type"
          value={MODALITY_LABELS[modality] ?? modality}
        />
      )}

      {modality == null && (
        <InfoRow
          icon={<Calendar size={16} color={tokens.primary} />}
          label="Session Type"
          value="Not specified"
          isPlaceholder
        />
      )}
    </Card>
  );
}

// ─── Center card — Performance & About ───────────────────────────────────────

interface PerformanceCardProps {
  sharedSessionCount: number;
  yearsExperience: string | null;
  availableDays: string[];
  /**
   * QA batch (2026-07-14) Part 18 — average of THIS member's own
   * post-session ratings (1-5) for this CHW, or `null` when the member has
   * never rated them. No approval-status gate: this is the member's own
   * scores shown back to them, not public display copy.
   */
  ratingAvg: number | null;
  /** Count of this member's own ratings contributing to `ratingAvg`. */
  ratingCount: number;
}

/**
 * Build a filled/empty 5-star glyph string for the delta pill, e.g. "★★★★★"
 * for a 4.9 avg (rounds to nearest star) or "★★★★☆" for a 4.4 avg.
 */
function starGlyphs(avg: number): string {
  const filled = Math.min(5, Math.max(0, Math.round(avg)));
  return '★'.repeat(filled) + '☆'.repeat(5 - filled);
}

function PerformanceCard({
  sharedSessionCount,
  yearsExperience,
  availableDays,
  ratingAvg,
  ratingCount,
}: PerformanceCardProps): React.JSX.Element {
  // Never fabricate a rating — only render a number once at least one
  // approved testimonial exists. Otherwise show an explicit empty state.
  const hasRatings = ratingCount > 0 && ratingAvg != null;

  return (
    <Card style={[cardStyles.base, cardStyles.center]}>
      <SectionHeader title="Performance" marginBottom={spacing.lg} />

      {/* StatTile grid — rating + sessions */}
      <View style={cardStyles.statRow}>
        <StatTile
          icon={<Star size={18} color={tokens.emerald700} />}
          iconBg={tokens.emerald100}
          label="Member Rating"
          value={hasRatings ? ratingAvg.toFixed(1) : 'No ratings yet'}
          delta={
            hasRatings
              ? `${starGlyphs(ratingAvg)} · ${ratingCount} review${ratingCount === 1 ? '' : 's'}`
              : undefined
          }
          deltaColor={tokens.amber700}
          deltaBg={tokens.amber100}
          style={cardStyles.statTile}
          accessibilityLabel={
            hasRatings
              ? `Rating ${ratingAvg.toFixed(1)} out of 5, from ${ratingCount} review${ratingCount === 1 ? '' : 's'}`
              : 'No ratings yet'
          }
        />
        <StatTile
          icon={<TrendingUp size={18} color={tokens.blue700} />}
          iconBg={tokens.blue100}
          label="Sessions Together"
          value={sharedSessionCount}
          delta={sharedSessionCount > 0 ? `${sharedSessionCount} completed` : undefined}
          deltaColor={tokens.emerald700}
          deltaBg={tokens.emerald100}
          style={cardStyles.statTile}
          accessibilityLabel={`${sharedSessionCount} sessions completed together`}
        />
      </View>

      <View style={cardStyles.divider} />

      <SectionHeader title="About" marginBottom={spacing.md} />

      {/* Experience */}
      {yearsExperience != null && (
        <InfoRow
          icon={<Globe size={16} color={tokens.primary} />}
          label="Experience"
          value={`${yearsExperience} as a Community Health Worker`}
        />
      )}

      {/* Availability */}
      {availableDays.length > 0 && (
        <View style={cardStyles.chipBlock}>
          <Text style={cardStyles.chipBlockLabel}>Availability</Text>
          <View style={cardStyles.chipRow}>
            {availableDays.map((day) => (
              <Pill key={day} variant="gray" size="sm">
                {DAY_LABELS[day] ?? day}
              </Pill>
            ))}
          </View>
        </View>
      )}

      {yearsExperience == null && availableDays.length === 0 && (
        <Text style={cardStyles.emptyBody}>
          Bio and experience details are filled in by your CHW once their profile is complete.
        </Text>
      )}
    </Card>
  );
}

// ─── Right card — Relationship context ───────────────────────────────────────

interface RelationshipCardProps {
  chwFirstName: string;
  assignedDate: string | null;
  sharedSessionCount: number;
  onCall: () => void;
  onMessage: () => void;
  onSchedule: () => void;
}

function RelationshipCard({
  chwFirstName,
  assignedDate,
  sharedSessionCount,
  onCall,
  onMessage,
  onSchedule,
}: RelationshipCardProps): React.JSX.Element {
  return (
    <Card style={[cardStyles.base, cardStyles.right]}>
      <SectionHeader
        title="Your Relationship"
        subtitle={assignedDate != null ? `Since ${formatAssignedDate(assignedDate)}` : undefined}
        marginBottom={spacing.lg}
      />

      {/* Date assigned stat */}
      <StatTile
        icon={<CalendarPlus size={18} color={tokens.primary} />}
        iconBg={tokens.emerald100}
        label="Assigned Since"
        value={
          assignedDate != null
            ? new Date(assignedDate).toLocaleDateString('en-US', {
                month: 'short',
                year: 'numeric',
              })
            : '—'
        }
        style={{ marginBottom: spacing.md }}
        accessibilityLabel={
          assignedDate != null
            ? `Assigned since ${formatAssignedDate(assignedDate)}`
            : 'Assignment date unavailable'
        }
      />

      {/* Journey progress — compact pill row */}
      <View style={cardStyles.journeyRow}>
        <View style={cardStyles.journeyTextBlock}>
          <Text style={cardStyles.journeyLabel}>Journey Progress</Text>
          <Text style={cardStyles.journeyValue}>
            {sharedSessionCount > 0
              ? `${sharedSessionCount} session${sharedSessionCount === 1 ? '' : 's'} completed`
              : 'No sessions yet — get started below'}
          </Text>
        </View>
        {sharedSessionCount > 0 && (
          <Pill variant="emerald" size="sm" withDot>
            Active
          </Pill>
        )}
      </View>

      <View style={cardStyles.divider} />

      <SectionHeader title="Connect" marginBottom={spacing.md} />

      {/* Call / Message action row */}
      <View style={cardStyles.actionRow}>
        <ActionButton
          icon={<Phone size={17} color={tokens.cardBg} />}
          label="Call"
          onPress={onCall}
          variant="primary"
          accessibilityLabel={`Call ${chwFirstName}`}
        />
        <ActionButton
          icon={<MessageSquare size={17} color={tokens.textPrimary} />}
          label="Message"
          onPress={onMessage}
          variant="secondary"
          accessibilityLabel={`Message ${chwFirstName}`}
        />
      </View>

      {/* Schedule next session CTA */}
      <TouchableOpacity
        style={cardStyles.scheduleCta}
        onPress={onSchedule}
        accessibilityRole="button"
        accessibilityLabel="Schedule next session"
      >
        <CalendarPlus size={15} color={tokens.primary} />
        <Text style={cardStyles.scheduleCtaText}>Schedule next session</Text>
      </TouchableOpacity>
    </Card>
  );
}

// ─── Shared card-level styles ─────────────────────────────────────────────────

const cardStyles = StyleSheet.create({
  base: {
    padding: spacing.xl,
    marginBottom: spacing.lg,
  } as ViewStyle,

  // On web the three cards sit side-by-side; on native they stack.
  left: {
    ...(Platform.OS === 'web' ? { flex: 3, minWidth: 180 } : {}),
  } as ViewStyle,
  center: {
    ...(Platform.OS === 'web' ? { flex: 4, minWidth: 220 } : {}),
  } as ViewStyle,
  right: {
    ...(Platform.OS === 'web' ? { flex: 3, minWidth: 180 } : {}),
  } as ViewStyle,

  // Avatar block
  avatarRow: {
    position: 'relative',
    alignSelf: 'center',
    marginBottom: spacing.md,
  } as ViewStyle,
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: tokens.cardBg,
    ...(shadows.card as ViewStyle),
  } as ViewStyle,
  // Same dimensions + ring as the initials avatar, typed for <Image>.
  avatarImage: {
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 3,
    borderColor: tokens.cardBg,
    ...(shadows.card as object),
  } as ImageStyle,
  avatarText: {
    fontFamily: fonts.display,
    fontSize: 28,
  } as TextStyle,
  onlineDot: {
    position: 'absolute',
    bottom: 3,
    right: 3,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#10B981',
    borderWidth: 2,
    borderColor: tokens.cardBg,
  } as ViewStyle,

  displayName: {
    fontFamily: fonts.display,
    fontSize: 20,
    color: tokens.textPrimary,
    textAlign: 'center',
    marginBottom: spacing.sm,
  } as TextStyle,

  // Pills row
  pillRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    flexWrap: 'wrap',
    marginBottom: spacing.md,
  } as ViewStyle,
  verifiedPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: tokens.emerald100,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.pill,
  } as ViewStyle,
  verifiedPillText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 11,
    color: tokens.emerald700,
  } as TextStyle,
  certPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: tokens.blue100,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: `${tokens.blue700}30`,
  } as ViewStyle,
  certPillText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 11,
    color: tokens.blue700,
  } as TextStyle,

  // Divider
  divider: {
    height: 1,
    backgroundColor: tokens.cardBorder,
    marginVertical: spacing.md,
  } as ViewStyle,

  // Chip group
  chipBlock: {
    marginBottom: spacing.md,
  } as ViewStyle,
  chipBlockLabel: {
    fontFamily: fonts.bodySemibold,
    fontSize: 10,
    color: tokens.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: spacing.sm,
  } as TextStyle,
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  } as ViewStyle,

  // Stat grid
  statRow: {
    flexDirection: 'row',
    gap: spacing.md,
    marginBottom: spacing.md,
  } as ViewStyle,
  statTile: {
    flex: 1,
  } as ViewStyle,

  // Relationship card specifics
  journeyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: tokens.pageBg,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.md,
  } as ViewStyle,
  journeyTextBlock: {
    flex: 1,
    marginRight: spacing.sm,
  } as ViewStyle,
  journeyLabel: {
    fontFamily: fonts.bodySemibold,
    fontSize: 10,
    color: tokens.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 2,
  } as TextStyle,
  journeyValue: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: tokens.textPrimary,
    lineHeight: 18,
  } as TextStyle,

  // Action row
  actionRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.md,
  } as ViewStyle,

  // Schedule CTA
  scheduleCta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: tokens.primary,
    borderStyle: 'dashed',
  } as ViewStyle,
  scheduleCtaText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 14,
    color: tokens.primary,
  } as TextStyle,

  // Empty / placeholder body text
  emptyBody: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: tokens.textMuted,
    lineHeight: 20,
    fontStyle: 'italic',
  } as TextStyle,
});

// ─── Main screen ──────────────────────────────────────────────────────────────

/**
 * MemberFacingCHWProfileScreen
 *
 * Read-only view of the assigned or browsed CHW. Accepts `chwId` either via
 * route params (stack push from Find list) or via a direct prop (rendered
 * inline by MyCHWScreen).
 */
export function MemberFacingCHWProfileScreen(
  { chwId: chwIdProp, hideBack = false }: MemberFacingCHWProfileScreenProps = {},
): React.JSX.Element {
  const navigation = useNavigation<RootNavProp>();

  // `useRoute` is safe when mounted as a stack screen; when rendered inline
  // by MyCHWScreen the active route is FindMain and params is undefined, so we
  // coalesce against the prop.
  const route = useRoute<CHWProfileRouteProp>();
  const chwId =
    chwIdProp ??
    (route.params as { chwId?: string } | undefined)?.chwId ??
    '';

  const { userName } = useAuth();

  const memberInitials = (userName ?? 'M')
    .split(' ')
    .slice(0, 2)
    .map((p) => p[0] ?? '')
    .join('')
    .toUpperCase();

  const shellUserBlock = {
    initials: memberInitials,
    name: userName ?? 'Member',
    role: 'Member' as const,
  };

  // ── Data fetching ───────────────────────────────────────────────────────────

  const { data: profile, isLoading: profileLoading, error } = useMemberFacingCHWProfile(chwId);
  const sessionsQuery = useSessions();
  // QA batch (2026-07-14) Part 18: "Member Rating" is THIS member's own
  // post-session scores for THIS CHW (myRatingAvg/myRatingCount on the
  // profile response), not the CHW's global approved-testimonial summary —
  // that summary stayed "No ratings yet" right after the member rated a
  // session because it excluded unapproved rows. The former
  // `useTestimonialSummary(chwId)` call was dropped here for that reason;
  // it's still used by the CHW-side dashboard's satisfaction snapshot.

  const isLoading = profileLoading || sessionsQuery.isLoading;

  // Derive the earliest session date with this CHW (= "date assigned").
  const assignedDate = useMemo<string | null>(() => {
    const sessions = sessionsQuery.data ?? [];
    return deriveAssignedDate(sessions, chwId);
  }, [sessionsQuery.data, chwId]);

  // ── Derived display values ──────────────────────────────────────────────────

  // QA2 #11 hardening: every field here can arrive undefined/null from the
  // wire (a CHW with a barely-filled profile crashed this whole screen into
  // the app error boundary — `profile.firstName[0]` on undefined, spreading a
  // non-array `additionalLanguages`). Treat all of them as optional.
  const safeFirstName = profile?.firstName ?? '';
  const safeLastInitial = profile?.lastNameInitial ?? '';

  const initials = profile
    ? `${safeFirstName[0] ?? ''}${safeLastInitial[0] ?? ''}`.toUpperCase() || '??'
    : '??';

  const displayName = profile
    ? `${safeFirstName} ${safeLastInitial}`.trim()
    : '';

  const allLanguages = profile
    ? [
        profile.primaryLanguage,
        ...(Array.isArray(profile.additionalLanguages) ? profile.additionalLanguages : []),
      ].filter(Boolean)
    : [];

  // The API surface exposes only `primarySpecialization` (singular). Compose a
  // display list from it so the IdentityCard chip row always works with an array.
  const specializations: string[] = profile?.primarySpecialization != null
    ? [profile.primarySpecialization]
    : [];

  // ── Navigation handlers ─────────────────────────────────────────────────────

  const handleGoBack = useCallback(() => {
    if (navigation.canGoBack()) {
      navigation.goBack();
    }
  }, [navigation]);

  /** Navigate to Sessions tab pre-selecting this CHW's thread + auto-call. */
  const handleCall = useCallback(() => {
    navigation.navigate('Sessions', { chwId, autoCall: true } satisfies MemberTabParamList['Sessions']);
  }, [navigation, chwId]);

  /** Navigate to Sessions tab pre-selecting this CHW's thread (no call). */
  const handleMessage = useCallback(() => {
    navigation.navigate('Sessions', { chwId } satisfies MemberTabParamList['Sessions']);
  }, [navigation, chwId]);

  /** Navigate to the Calendar tab for scheduling. */
  const handleSchedule = useCallback(() => {
    navigation.navigate('Calendar');
  }, [navigation]);

  // ── Loading state ───────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <AppShell role="member" activeKey="myChw" userBlock={shellUserBlock}>
        <ScrollView
          style={s.scroll}
          contentContainerStyle={s.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <PageWrap style={s.pageWrapPadding}>
            <LoadingSkeleton variant="card" />
            <LoadingSkeleton variant="rows" rows={5} />
          </PageWrap>
        </ScrollView>
      </AppShell>
    );
  }

  // ── Error / not-found state ─────────────────────────────────────────────────

  if (error != null || profile == null) {
    return (
      <AppShell role="member" activeKey="myChw" userBlock={shellUserBlock}>
        <ScrollView
          style={s.scroll}
          contentContainerStyle={s.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <PageWrap style={s.pageWrapPadding}>
            <View style={s.emptyState}>
              <View style={s.emptyIconCircle}>
                <ShieldOff size={28} color={tokens.textMuted} />
              </View>
              <Text style={s.emptyTitle}>Profile not found</Text>
              <Text style={s.emptySubtext}>
                This CHW profile is no longer available. They may have left the platform.
              </Text>
              {!hideBack && (
                <TouchableOpacity
                  style={s.backButton}
                  onPress={handleGoBack}
                  accessibilityRole="button"
                  accessibilityLabel="Go back"
                >
                  <Text style={s.backButtonText}>Go Back</Text>
                </TouchableOpacity>
              )}
            </View>
          </PageWrap>
        </ScrollView>
      </AppShell>
    );
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <AppShell role="member" activeKey="myChw" userBlock={shellUserBlock}>
      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <PageWrap style={s.pageWrapPadding}>
          {/* ── Page header ─────────────────────────────────────────────────── */}
          <PageHeader
            title={`Your CHW`}
            subtitle={`${displayName} · Community Health Worker`}
            right={
              !hideBack ? (
                <TouchableOpacity
                  onPress={handleGoBack}
                  style={s.backBtn}
                  accessibilityRole="button"
                  accessibilityLabel="Go back"
                >
                  <Text style={s.backBtnText}>← Back</Text>
                </TouchableOpacity>
              ) : undefined
            }
          />

          {/* ── 3-column card row (row on web / column on native) ──────────── */}
          <View style={s.columnRow}>
            {/* Left — identity */}
            <IdentityCard
              initials={initials}
              displayName={displayName}
              photoUrl={profile.profilePictureUrl}
              specializations={specializations}
              languages={allLanguages}
              serviceAreaZips={
                Array.isArray(profile.serviceAreaZips) ? profile.serviceAreaZips : []
              }
              caChwCertified={profile.caChwCertified ?? false}
              modality={profile.modality}
            />

            {/* Center — performance & about */}
            <PerformanceCard
              sharedSessionCount={profile.sharedSessionCount ?? 0}
              yearsExperience={profile.yearsExperience ?? null}
              availableDays={
                Array.isArray(profile.availableDays) ? profile.availableDays : []
              }
              ratingAvg={profile.myRatingAvg ?? null}
              ratingCount={profile.myRatingCount ?? 0}
            />

            {/* Right — relationship context + actions */}
            <RelationshipCard
              chwFirstName={profile.firstName}
              assignedDate={assignedDate}
              sharedSessionCount={profile.sharedSessionCount}
              onCall={handleCall}
              onMessage={handleMessage}
              onSchedule={handleSchedule}
            />
          </View>

          <View style={s.bottomPadding} />
        </PageWrap>
      </ScrollView>
    </AppShell>
  );
}

// ─── Screen-level styles ──────────────────────────────────────────────────────

const s = StyleSheet.create({
  scroll: {
    flex: 1,
    backgroundColor: tokens.pageBg,
  } as ViewStyle,

  scrollContent: {
    flexGrow: 1,
    // Web: align to top. Native: center (matches visual-language.md §8.1).
    alignItems: Platform.OS === 'web' ? undefined : 'center',
  } as ViewStyle,

  pageWrapPadding: {
    // paddingTop intentionally omitted: AppShell's mainContent already applies
    // 32px of top padding via its ScrollView contentContainerStyle. Adding top
    // padding here doubled the gap above the CHW profile header vs. screens that
    // don't own a nested ScrollView (e.g. CHWMembersScreen).
    paddingHorizontal: Platform.OS === 'web' ? spacing.xxxl : spacing.xl,
    paddingBottom: 48,
  } as ViewStyle,

  // 3-column row — row on web, column-stacked on native
  columnRow: {
    flexDirection: Platform.OS === 'web' ? 'row' : 'column',
    gap: spacing.lg,
    alignItems: Platform.OS === 'web' ? 'flex-start' : undefined,
  } as ViewStyle,

  // Back button (appears in PageHeader.right slot)
  backBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: tokens.cardBg,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
  } as ViewStyle,
  backBtnText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 13,
    color: tokens.textPrimary,
  } as TextStyle,

  // Error / not-found state
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 64,
    gap: spacing.md,
  } as ViewStyle,
  emptyIconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: `${tokens.primary}15`,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  emptyTitle: {
    fontFamily: fonts.display,
    fontSize: 18,
    color: tokens.textPrimary,
    textAlign: 'center',
  } as TextStyle,
  emptySubtext: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: tokens.textSecondary,
    textAlign: 'center',
    maxWidth: 300,
    lineHeight: 22,
  } as TextStyle,
  backButton: {
    backgroundColor: tokens.primary,
    paddingHorizontal: 28,
    paddingVertical: spacing.md,
    borderRadius: radius.lg,
    marginTop: spacing.xs,
  } as ViewStyle,
  backButtonText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 14,
    color: tokens.cardBg,
  } as TextStyle,

  bottomPadding: {
    height: spacing.xxxl,
  } as ViewStyle,
});

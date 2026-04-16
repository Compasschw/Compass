/**
 * WaitlistScreen — join the CompassCHW waitlist.
 *
 * Layout adapts at 1024 px (isDesktop):
 *   - Desktop: sticky navbar + 2-column layout (left marketing copy | right form card)
 *   - Mobile:  sticky navbar + single column vertical stack
 *
 * Navbar:
 *   - Compass icon + "CompassCHW" wordmark on the left (CHW in secondary green)
 *   - Nav links on desktop only (Home, Services, How It Works, For CHWs)
 *   - "Back to Home" button on the right navigates to Landing
 *
 * Left column (desktop):
 *   - Pulsing green dot + "LAUNCHING SOON IN LOS ANGELES" eyebrow
 *   - Headline "Community health, connected." (connected. in secondary green)
 *   - Description with bold "Community Health Workers"
 *   - 3 trust badge pills: HIPAA Compliant, Medi-Cal Accepted, No Cost to Members
 *
 * Right column: form card with gradient top bar, role dropdown modal, success state.
 */

import React, { useState, useCallback, useRef } from 'react';
import {
  ActivityIndicator,
  Animated,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Shield, CheckCircle, Star, ChevronDown } from 'lucide-react-native';

import { submitWaitlist, type WaitlistPayload } from '../../api/waitlist';
import { colors } from '../../theme/colors';
import { fonts } from '../../theme/typography';
import { shadows } from '../../theme/shadows';
import { radii, spacing } from '../../theme/spacing';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { AuthStackParamList } from '../../navigation/AppNavigator';

// ─── Assets ───────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-var-requires
const compassIcon = require('../../../assets/compass-icon.png') as number;

// ─── Types ────────────────────────────────────────────────────────────────────

type Props = NativeStackScreenProps<AuthStackParamList, 'Waitlist'>;

type WaitlistRole = 'chw' | 'member' | 'organization' | 'other' | '';

// ─── Storage key for offline fallback ────────────────────────────────────────

const WAITLIST_STORAGE_KEY = 'compass_waitlist_submission';

/** Viewport width at which the 2-column desktop layout activates. */
const DESKTOP_BREAKPOINT = 1024;

/** Maximum content width on desktop — mirrors LandingScreen. */
const MAX_CONTENT_WIDTH = 1280;

// ─── Trust badges ─────────────────────────────────────────────────────────────

interface TrustBadge {
  icon: React.ComponentType<{ size: number; color: string }>;
  label: string;
}

const TRUST_BADGES: TrustBadge[] = [
  { icon: Shield, label: 'HIPAA Compliant' },
  { icon: CheckCircle, label: 'Medi-Cal Accepted' },
  { icon: Star, label: 'No Cost to Members' },
];

// ─── Role options ─────────────────────────────────────────────────────────────

interface RoleOption {
  value: WaitlistRole;
  label: string;
}

const ROLE_OPTIONS: RoleOption[] = [
  { value: 'chw', label: 'CHW — I want to provide care' },
  { value: 'member', label: 'Member — I need support' },
  { value: 'organization', label: 'Organization — We employ CHWs' },
  { value: 'other', label: 'Other' },
];

/** Desktop nav links shown only when viewport >= DESKTOP_BREAKPOINT. */
const NAV_LINKS = ['Home', 'Services', 'How It Works', 'For CHWs'];

// ─── Pulsing dot ──────────────────────────────────────────────────────────────

/**
 * Animated pulsing green dot for the "Launching Soon" eyebrow badge.
 */
function PulsingDot({ size = 10 }: { size?: number }): React.JSX.Element {
  const opacity = useRef(new Animated.Value(1)).current;

  React.useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.2, duration: 900, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 900, useNativeDriver: true }),
      ]),
    );
    pulse.start();
    return () => pulse.stop();
  }, [opacity]);

  return (
    <Animated.View
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: colors.secondary,
        },
        { opacity },
      ]}
    />
  );
}

// ─── Role Dropdown Modal ──────────────────────────────────────────────────────

interface RoleDropdownProps {
  /** Currently selected role value, or '' for unselected. */
  selectedRole: WaitlistRole;
  /** Called when the user picks a role. */
  onSelect: (role: WaitlistRole) => void;
  /** Whether the parent form is in a loading state (disables interaction). */
  disabled: boolean;
}

/**
 * Single-field role selector that opens a Modal overlay with a list of options.
 * Matches the visual style of the other form inputs (border, background, radius).
 */
function RoleDropdown({ selectedRole, onSelect, disabled }: RoleDropdownProps): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false);

  const selectedLabel =
    selectedRole !== ''
      ? (ROLE_OPTIONS.find((o) => o.value === selectedRole)?.label ?? 'Select your role')
      : 'Select your role';

  const handleOpen = useCallback((): void => {
    if (!disabled) {
      Keyboard.dismiss();
      setIsOpen(true);
    }
  }, [disabled]);

  const handleSelect = useCallback(
    (value: WaitlistRole): void => {
      onSelect(value);
      setIsOpen(false);
    },
    [onSelect],
  );

  const handleClose = useCallback((): void => {
    setIsOpen(false);
  }, []);

  return (
    <>
      {/* ── Trigger field ── */}
      <TouchableOpacity
        style={[s.dropdownTrigger, disabled && s.dropdownTriggerDisabled]}
        onPress={handleOpen}
        activeOpacity={0.7}
        accessibilityLabel="Select your role"
        accessibilityRole="button"
        accessibilityState={{ expanded: isOpen }}
        disabled={disabled}
      >
        <Text
          style={[
            s.dropdownTriggerText,
            selectedRole !== '' && s.dropdownTriggerTextSelected,
          ]}
          numberOfLines={1}
        >
          {selectedLabel}
        </Text>
        <ChevronDown
          size={16}
          color={selectedRole !== '' ? colors.foreground : `${colors.mutedForeground}88`}
        />
      </TouchableOpacity>

      {/* ── Modal overlay ── */}
      <Modal
        visible={isOpen}
        transparent
        animationType="fade"
        onRequestClose={handleClose}
        statusBarTranslucent
        accessibilityViewIsModal
      >
        {/* Dark scrim — tap outside to close */}
        <Pressable
          style={s.modalScrim}
          onPress={handleClose}
          accessibilityLabel="Close role selector"
          accessibilityRole="button"
        >
          {/* Card — stop propagation so tapping the card doesn't close modal */}
          <Pressable
            style={s.modalCard}
            onPress={(e) => e.stopPropagation()}
          >
            <Text style={s.modalTitle}>Select your role</Text>

            {ROLE_OPTIONS.map((option, index) => (
              <TouchableOpacity
                key={option.value}
                style={[
                  s.modalOption,
                  index < ROLE_OPTIONS.length - 1 && s.modalOptionBorder,
                  option.value === selectedRole && s.modalOptionSelected,
                ]}
                onPress={() => handleSelect(option.value)}
                activeOpacity={0.7}
                accessibilityLabel={option.label}
                accessibilityRole="radio"
                accessibilityState={{ selected: option.value === selectedRole }}
              >
                <Text
                  style={[
                    s.modalOptionText,
                    option.value === selectedRole && s.modalOptionTextSelected,
                  ]}
                >
                  {option.label}
                </Text>
                {option.value === selectedRole && (
                  <View style={s.modalOptionCheck}>
                    <CheckCircle size={16} color={colors.primary} />
                  </View>
                )}
              </TouchableOpacity>
            ))}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * WaitlistScreen displays the waitlist signup form.
 * On success, transitions to an inline confirmation state.
 * On API failure, persists to AsyncStorage so the lead is not lost.
 */
export function WaitlistScreen({ navigation }: Props): React.JSX.Element {
  const { width } = useWindowDimensions();
  const isDesktop = width >= DESKTOP_BREAKPOINT;

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<WaitlistRole>('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSuccess, setIsSuccess] = useState(false);

  // ── Validation ────────────────────────────────────────────────────────────

  const validate = useCallback((): string | null => {
    if (!firstName.trim()) return 'First name is required.';
    if (!lastName.trim()) return 'Last name is required.';
    if (!email.trim()) return 'Email address is required.';
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) return 'Enter a valid email address.';
    if (!role) return 'Please select your role.';
    return null;
  }, [firstName, lastName, email, role]);

  // ── Submit handler ────────────────────────────────────────────────────────

  const handleSubmit = useCallback(async (): Promise<void> => {
    Keyboard.dismiss();

    const validationError = validate();
    if (validationError !== null) {
      setError(validationError);
      return;
    }

    setIsLoading(true);
    setError(null);

    const payload: WaitlistPayload = {
      first_name: firstName.trim(),
      last_name: lastName.trim(),
      email: email.trim().toLowerCase(),
      role: role as string,
    };

    try {
      await submitWaitlist(payload);
      setIsSuccess(true);
    } catch {
      // API failed — persist locally so the lead is not lost.
      try {
        const existingRaw = await AsyncStorage.getItem(WAITLIST_STORAGE_KEY);
        const existing: WaitlistPayload[] = existingRaw
          ? (JSON.parse(existingRaw) as WaitlistPayload[])
          : [];
        existing.push(payload);
        await AsyncStorage.setItem(WAITLIST_STORAGE_KEY, JSON.stringify(existing));
        setIsSuccess(true);
      } catch {
        setError('Unable to submit right now. Please check your connection and try again.');
      }
    } finally {
      setIsLoading(false);
    }
  }, [firstName, lastName, email, role, validate]);

  const handleNavigateHome = useCallback((): void => {
    navigation.navigate('Landing');
  }, [navigation]);

  // ── Navbar (shared across all layout branches) ────────────────────────────

  const navbar = (
    <View style={[s.navbar, isDesktop && s.navbarDesktop]}>
      <View
        style={[
          s.navbarInner,
          isDesktop && {
            maxWidth: MAX_CONTENT_WIDTH,
            alignSelf: 'center',
            width: '100%',
            paddingHorizontal: 48,
          },
        ]}
      >
        {/* Logo + wordmark */}
        <View style={s.navbarLeft}>
          <Image
            source={compassIcon}
            style={s.navLogo}
            accessibilityIgnoresInvertColors
            accessibilityLabel="Compass icon"
          />
          <Text style={s.navWordmark}>
            Compass<Text style={s.navWordmarkAccent}>CHW</Text>
          </Text>
        </View>

        {/* Desktop-only nav links */}
        {isDesktop && (
          <View style={s.navLinks}>
            {NAV_LINKS.map((link) => (
              <TouchableOpacity
                key={link}
                onPress={handleNavigateHome}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={link}
              >
                <Text style={s.navLinkText}>{link}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Right CTA — navigates back to Landing since we are already on Waitlist */}
        <TouchableOpacity
          style={s.navHomeButton}
          onPress={handleNavigateHome}
          activeOpacity={0.82}
          accessibilityLabel="Back to home"
          accessibilityRole="button"
        >
          <Text style={s.navHomeButtonText}>Back to Home</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  // ── Success state ─────────────────────────────────────────────────────────

  if (isSuccess) {
    return (
      <SafeAreaView style={s.safeArea}>
        {navbar}
        <View style={s.successFullScreen}>
          <View style={[s.formCard, shadows.elevated, isDesktop && { maxWidth: 480 }]}>
            {/* Gradient top bar */}
            <View style={s.cardGradientBar}>
              <View style={s.cardGradientLeft} />
              <View style={s.cardGradientRight} />
            </View>

            <View style={s.successCardBody}>
              <View style={s.successIconWrapper}>
                <CheckCircle size={40} color={colors.primary} />
              </View>
              <Text style={s.successTitle}>You're on the list!</Text>
              <Text style={s.successSubtitle}>
                We'll notify you when Compass launches in your area.
              </Text>

              <TouchableOpacity
                style={s.backButton}
                onPress={() => navigation.navigate('Login')}
                activeOpacity={0.85}
                accessibilityLabel="Go to sign in"
                accessibilityRole="button"
              >
                <Text style={s.backButtonText}>Back to Sign In</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  // ── Shared form card ──────────────────────────────────────────────────────

  const formCard = (
    <View style={[s.formCard, shadows.elevated]}>
      {/* Gradient top bar: primary → compassNude */}
      <View style={s.cardGradientBar}>
        <View style={s.cardGradientLeft} />
        <View style={s.cardGradientRight} />
      </View>

      <View style={s.cardBody}>
        <View style={s.cardHeader}>
          <Text style={s.cardTitle}>Get early access</Text>
          <Text style={s.cardSubtitle}>
            Be the first to know when Compass launches in your area.
            Join the waitlist — it takes 10 seconds.
          </Text>
        </View>

        {/* Error */}
        {error !== null && (
          <View style={s.errorContainer}>
            <Text style={s.errorText}>{error}</Text>
          </View>
        )}

        {/* First + Last name row */}
        <View style={s.nameRow}>
          <View style={[s.inputGroup, s.inputHalf]}>
            <Text style={s.inputLabel}>First Name</Text>
            <TextInput
              style={s.textInput}
              placeholder="Maria"
              placeholderTextColor={`${colors.mutedForeground}88`}
              value={firstName}
              onChangeText={setFirstName}
              autoCapitalize="words"
              autoComplete="given-name"
              returnKeyType="next"
              editable={!isLoading}
              accessibilityLabel="First name"
            />
          </View>
          <View style={[s.inputGroup, s.inputHalf]}>
            <Text style={s.inputLabel}>Last Name</Text>
            <TextInput
              style={s.textInput}
              placeholder="Garcia"
              placeholderTextColor={`${colors.mutedForeground}88`}
              value={lastName}
              onChangeText={setLastName}
              autoCapitalize="words"
              autoComplete="family-name"
              returnKeyType="next"
              editable={!isLoading}
              accessibilityLabel="Last name"
            />
          </View>
        </View>

        {/* Email */}
        <View style={s.inputGroup}>
          <Text style={s.inputLabel}>Email Address</Text>
          <TextInput
            style={s.textInput}
            placeholder="maria@example.com"
            placeholderTextColor={`${colors.mutedForeground}88`}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            returnKeyType="next"
            editable={!isLoading}
            accessibilityLabel="Email address"
          />
        </View>

        {/* Role — dropdown modal */}
        <View style={s.inputGroup}>
          <Text style={s.inputLabel}>I am a…</Text>
          <RoleDropdown
            selectedRole={role}
            onSelect={setRole}
            disabled={isLoading}
          />
        </View>

        {/* Submit */}
        <TouchableOpacity
          style={[s.submitButton, isLoading && s.submitButtonDisabled]}
          onPress={handleSubmit}
          disabled={isLoading}
          activeOpacity={0.85}
          accessibilityLabel="Join the waitlist"
          accessibilityRole="button"
        >
          {isLoading ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Text style={s.submitButtonText}>Join the Waitlist →</Text>
          )}
        </TouchableOpacity>

        {/* Footer copy */}
        <Text style={s.footerNote}>No spam, ever. Unsubscribe anytime.</Text>

        {/* Social proof */}
        <View style={s.socialProofRow}>
          <PulsingDot size={8} />
          <Text style={s.socialProofText}>Join hundreds of CHWs and community members</Text>
        </View>

        {/* Already have account */}
        <View style={s.signInRow}>
          <Text style={s.signInText}>Already have an account?  </Text>
          <TouchableOpacity
            onPress={() => navigation.navigate('Login')}
            accessibilityRole="button"
            accessibilityLabel="Go to sign in"
          >
            <Text style={s.signInLink}>Sign in</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );

  // ── Desktop 2-column layout ───────────────────────────────────────────────

  if (isDesktop) {
    return (
      <SafeAreaView style={s.safeArea}>
        {navbar}
        <KeyboardAvoidingView
          style={s.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <ScrollView
            style={s.flex}
            contentContainerStyle={s.desktopScrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={s.desktopColumns}>
              {/* ── Left column — marketing copy ──────────────────────────── */}
              <View style={s.desktopLeftCol}>
                {/* Wordmark */}
                <View style={s.logoRow}>
                  <Image
                    source={compassIcon}
                    style={s.logoImage}
                    accessibilityIgnoresInvertColors
                    accessibilityLabel="Compass icon"
                  />
                  <Text style={s.wordmark}>
                    Compass<Text style={s.wordmarkAccent}>CHW</Text>
                  </Text>
                </View>

                {/* Eyebrow */}
                <View style={s.eyebrowRow}>
                  <PulsingDot size={10} />
                  <Text style={s.eyebrowText}>LAUNCHING SOON IN LOS ANGELES</Text>
                </View>

                {/* Headline */}
                <Text
                  style={[
                    s.heroTitle,
                    { fontSize: 64, lineHeight: 68, letterSpacing: -1.5 },
                  ]}
                >
                  Community health,{' '}
                  <Text style={s.heroTitleAccent}>connected.</Text>
                </Text>

                {/* Description */}
                <Text style={[s.heroSubtitle, { fontSize: 18, lineHeight: 28 }]}>
                  Compass CHW is a marketplace connecting Los Angeles residents with trusted{' '}
                  <Text style={s.heroSubtitleBold}>Community Health Workers</Text>
                  {' '}— neighbors trained to help with housing, recovery, food, mental health, and healthcare navigation.
                </Text>

                {/* Trust badges */}
                <View style={s.trustBadgesRow}>
                  {TRUST_BADGES.map(({ icon: Icon, label }) => (
                    <View key={label} style={s.trustBadge}>
                      <Icon size={14} color={colors.primary} />
                      <Text style={s.trustBadgeText}>{label}</Text>
                    </View>
                  ))}
                </View>
              </View>

              {/* ── Right column — form card ───────────────────────────────── */}
              <View style={s.desktopRightCol}>
                {formCard}
              </View>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  // ── Mobile single-column layout ───────────────────────────────────────────

  return (
    <SafeAreaView style={s.safeArea}>
      {navbar}
      <KeyboardAvoidingView
        style={s.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          style={s.flex}
          contentContainerStyle={s.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Hero copy */}
          <View style={s.heroSection}>
            <View style={s.eyebrowRow}>
              <PulsingDot size={8} />
              <Text style={s.eyebrowText}>LAUNCHING SOON IN LOS ANGELES</Text>
            </View>

            <Text
              style={[
                s.heroTitle,
                { fontSize: 40, lineHeight: 44, letterSpacing: -1.5 },
              ]}
            >
              Community health,{' '}
              <Text style={s.heroTitleAccent}>connected.</Text>
            </Text>

            <Text style={[s.heroSubtitle, { fontSize: 16, lineHeight: 24 }]}>
              Compass CHW is a marketplace connecting Los Angeles residents with trusted{' '}
              <Text style={s.heroSubtitleBold}>Community Health Workers</Text>
              {' '}— neighbors trained to help with housing, recovery, food, mental health, and healthcare navigation.
            </Text>
          </View>

          {/* Trust badges */}
          <View style={s.trustBadgesRow}>
            {TRUST_BADGES.map(({ icon: Icon, label }) => (
              <View key={label} style={s.trustBadge}>
                <Icon size={14} color={colors.primary} />
                <Text style={s.trustBadgeText}>{label}</Text>
              </View>
            ))}
          </View>

          {/* Form card */}
          {formCard}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  flex: {
    flex: 1,
  },

  // ── Navbar ────────────────────────────────────────────────────────────────
  navbar: {
    height: 64,
    backgroundColor: colors.background,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    elevation: 2,
    zIndex: 10,
    justifyContent: 'center',
    ...Platform.select({
      ios: {
        shadowColor: colors.foreground,
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.06,
        shadowRadius: 4,
      },
    }),
  },
  navbarDesktop: {
    height: 72,
  },
  navbarInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
  },
  navbarLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  navLogo: {
    width: 28,
    height: 28,
    borderRadius: 7,
  },
  navWordmark: {
    fontFamily: fonts.display,
    fontSize: 20,
    color: colors.foreground,
    letterSpacing: -0.4,
  },
  navWordmarkAccent: {
    color: colors.secondary,
  },
  navLinks: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xl,
  },
  navLinkText: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.mutedForeground,
    letterSpacing: 0.1,
  },
  navHomeButton: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
  },
  navHomeButtonText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 13,
    color: colors.foreground,
    letterSpacing: 0.1,
  },

  // ── Mobile scroll layout ───────────────────────────────────────────────────
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
    paddingBottom: spacing.xl,
    gap: spacing.xl,
  },

  // ── Desktop scroll layout ──────────────────────────────────────────────────
  desktopScrollContent: {
    flexGrow: 1,
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.xxl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  desktopColumns: {
    flexDirection: 'row',
    gap: 64,
    width: '100%',
    maxWidth: 1184,
    alignItems: 'center',
  },
  desktopLeftCol: {
    flex: 1,
    gap: spacing.xl,
  },
  desktopRightCol: {
    width: 440,
  },

  // ── Logo ──────────────────────────────────────────────────────────────────
  logoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  logoImage: {
    width: 28,
    height: 28,
    borderRadius: 7,
  },
  wordmark: {
    fontFamily: fonts.display,
    fontSize: 22,
    color: colors.foreground,
    letterSpacing: -0.5,
  },
  wordmarkAccent: {
    color: colors.secondary,
  },

  // ── Hero copy ─────────────────────────────────────────────────────────────
  heroSection: {
    gap: spacing.md,
  },
  eyebrowRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  eyebrowText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 11,
    letterSpacing: 1.2,
    color: colors.mutedForeground,
  },
  heroTitle: {
    fontFamily: fonts.display,
    color: colors.foreground,
  },
  heroTitleAccent: {
    color: colors.secondary,
  },
  heroSubtitle: {
    fontFamily: fonts.body,
    color: colors.mutedForeground,
  },
  heroSubtitleBold: {
    fontFamily: fonts.bodyBold,
    color: colors.foreground,
  },

  // ── Trust badges ──────────────────────────────────────────────────────────
  trustBadgesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  trustBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 2,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    borderRadius: radii.full,
    backgroundColor: `${colors.primary}1A`,
    borderWidth: 1,
    borderColor: `${colors.primary}33`,
  },
  trustBadgeText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 12,
    letterSpacing: 0.3,
    color: colors.primary,
  },

  // ── Form card ─────────────────────────────────────────────────────────────
  formCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: radii.xl,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  cardGradientBar: {
    height: 3,
    flexDirection: 'row',
  },
  cardGradientLeft: {
    flex: 3,
    backgroundColor: colors.primary,
  },
  cardGradientRight: {
    flex: 2,
    backgroundColor: colors.compassNude,
  },
  cardBody: {
    padding: spacing.xl,
    gap: spacing.md,
  },
  cardHeader: {
    gap: spacing.xs + 2,
    marginBottom: spacing.xs,
  },
  cardTitle: {
    fontFamily: fonts.display,
    fontSize: 24,
    color: colors.foreground,
    letterSpacing: -0.3,
  },
  cardSubtitle: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.mutedForeground,
    lineHeight: 20,
  },

  // ── Error ─────────────────────────────────────────────────────────────────
  errorContainer: {
    backgroundColor: 'rgba(220,38,38,0.08)',
    borderRadius: radii.md,
    paddingHorizontal: spacing.md - 2,
    paddingVertical: spacing.md,
  },
  errorText: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.destructive,
  },

  // ── Inputs ────────────────────────────────────────────────────────────────
  nameRow: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  inputGroup: {
    gap: spacing.xs - 2,
  },
  inputHalf: {
    flex: 1,
  },
  inputLabel: {
    fontFamily: fonts.bodySemibold,
    fontSize: 12,
    letterSpacing: 0.2,
    color: colors.mutedForeground,
    marginBottom: 2,
  },
  textInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: `${colors.muted}4D`,
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.foreground,
  },

  // ── Role dropdown trigger ─────────────────────────────────────────────────
  dropdownTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: `${colors.muted}4D`,
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
  },
  dropdownTriggerDisabled: {
    opacity: 0.5,
  },
  dropdownTriggerText: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: `${colors.mutedForeground}88`,
    flex: 1,
    marginRight: spacing.sm,
  },
  dropdownTriggerTextSelected: {
    color: colors.foreground,
  },

  // ── Role dropdown modal ───────────────────────────────────────────────────
  modalScrim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  modalCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: radii.xl,
    width: '100%',
    maxWidth: 400,
    overflow: 'hidden',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.15,
        shadowRadius: 24,
      },
      android: {
        elevation: 12,
      },
    }),
  },
  modalTitle: {
    fontFamily: fonts.display,
    fontSize: 16,
    color: colors.foreground,
    letterSpacing: -0.2,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
    paddingBottom: spacing.md,
  },
  modalOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md + 2,
  },
  modalOptionBorder: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  modalOptionSelected: {
    backgroundColor: `${colors.primary}08`,
  },
  modalOptionText: {
    fontFamily: fonts.body,
    fontSize: 15,
    color: colors.foreground,
    flex: 1,
  },
  modalOptionTextSelected: {
    fontFamily: fonts.bodySemibold,
    color: colors.primary,
  },
  modalOptionCheck: {
    marginLeft: spacing.sm,
  },

  // ── Submit button ─────────────────────────────────────────────────────────
  submitButton: {
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.xs,
    minHeight: 52,
  },
  submitButtonDisabled: {
    opacity: 0.6,
  },
  submitButtonText: {
    fontFamily: fonts.bodyBold,
    fontSize: 16,
    color: '#FFFFFF',
  },

  // ── Footer ────────────────────────────────────────────────────────────────
  footerNote: {
    fontFamily: fonts.bodySemibold,
    fontSize: 11,
    letterSpacing: 0.5,
    color: `${colors.mutedForeground}99`,
    textAlign: 'center',
  },
  socialProofRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  socialProofText: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.mutedForeground,
  },
  signInRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
  },
  signInText: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.mutedForeground,
  },
  signInLink: {
    fontFamily: fonts.bodySemibold,
    fontSize: 14,
    color: colors.primary,
  },

  // ── Success card ──────────────────────────────────────────────────────────
  successFullScreen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  successCardBody: {
    padding: spacing.xl,
    alignItems: 'center',
    gap: spacing.md,
  },
  successIconWrapper: {
    width: 80,
    height: 80,
    borderRadius: radii.full,
    backgroundColor: `${colors.primary}14`,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  successTitle: {
    fontFamily: fonts.display,
    fontSize: 24,
    color: colors.foreground,
    textAlign: 'center',
  },
  successSubtitle: {
    fontFamily: fonts.body,
    fontSize: 15,
    color: colors.mutedForeground,
    textAlign: 'center',
    lineHeight: 22,
  },
  backButton: {
    marginTop: spacing.sm,
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingVertical: spacing.md - 2,
    paddingHorizontal: spacing.xl,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backButtonText: {
    fontFamily: fonts.display,
    fontSize: 15,
    color: '#FFFFFF',
  },
});

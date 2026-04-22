/**
 * LoginScreen — sign in / sign up toggle styled to match the Lovable /auth page.
 *
 * Layout:
 *   - Sticky navbar (64px, matching LandingScreen pattern) with desktop nav links
 *   - 2-column layout on desktop (marketing copy left / form card right)
 *   - Single column on mobile (form card below marketing copy)
 *   - No Full Name field — register call derives display name from email
 *   - Demo buttons below the card, separated by a "DEMO" divider
 */

import React, { useState, useCallback } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Keyboard,
  KeyboardAvoidingView,
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
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Svg, { Path } from 'react-native-svg';
import { Mail, Lock, Eye, EyeOff, ArrowRight } from 'lucide-react-native';

import { useAuth } from '../../context/AuthContext';
import { colors } from '../../theme/colors';
import { fonts } from '../../theme/typography';
import { shadows } from '../../theme/shadows';
import { radii, spacing } from '../../theme/spacing';
import type { UserRole } from '../../data/mock';
import type { AuthStackParamList } from '../../navigation/AppNavigator';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const compassIcon = require('../../../assets/compass-icon.png') as number;

// ─── Constants ────────────────────────────────────────────────────────────────

/** Viewport width at which the 2-column desktop layout activates. */
const DESKTOP_BREAKPOINT = 1024;

/** Maximum content width — mirrors Lovable's max-w-6xl / max-w-7xl. */
const MAX_CONTENT_WIDTH = 1280;

type LoginNavProp = NativeStackNavigationProp<AuthStackParamList>;

// ─── Demo accounts ────────────────────────────────────────────────────────────

interface DemoAccount {
  role: UserRole;
  name: string;
  label: string;
  email: string;
  password: string;
}

const DEMO_ACCOUNTS: DemoAccount[] = [
  {
    role: 'chw',
    name: 'Maria Guadalupe Reyes',
    label: 'Demo as CHW',
    email: 'maria@demo.compasschw.com',
    password: 'demo1234',
  },
  {
    role: 'member',
    name: 'Rosa Delgado',
    label: 'Demo as Member',
    email: 'rosa@demo.compasschw.com',
    password: 'demo1234',
  },
];

// ─── Value proposition bullets ────────────────────────────────────────────────

const VALUE_PROPS = [
  'Set your own schedule and work flexibly',
  'Earn $32+/hour via Medi-Cal reimbursement',
  'Make a real impact in your community',
] as const;

// ─── Google SVG icon ──────────────────────────────────────────────────────────

function GoogleIcon(): React.JSX.Element {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24">
      <Path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
        fill="#4285F4"
      />
      <Path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <Path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <Path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </Svg>
  );
}

// ─── Apple SVG icon ───────────────────────────────────────────────────────────

function AppleIcon(): React.JSX.Element {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24" fill={colors.foreground}>
      <Path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
    </Svg>
  );
}

// ─── ContentWrapper ───────────────────────────────────────────────────────────

/**
 * Constrains children to MAX_CONTENT_WIDTH and centers them on desktop.
 * On mobile it passes through as a plain View with no max-width constraint.
 */
function ContentWrapper({
  children,
  style,
  isDesktop,
}: {
  children: React.ReactNode;
  style?: object;
  isDesktop: boolean;
}): React.JSX.Element {
  if (!isDesktop) {
    return <View style={style}>{children}</View>;
  }
  return (
    <View
      style={[
        {
          maxWidth: MAX_CONTENT_WIDTH,
          width: '100%',
          alignSelf: 'center',
          paddingHorizontal: 48,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

// ─── LoginScreen ──────────────────────────────────────────────────────────────

/**
 * LoginScreen handles both sign-in and sign-up in a single toggle view.
 *
 * On successful auth the AuthContext state change triggers AppNavigator
 * to swap to the authenticated stack — no explicit navigation call needed.
 *
 * On desktop (≥1024 px) the layout mirrors Lovable's 2-column /auth page:
 *   - Left: marketing headline + value props
 *   - Right: auth form card (max-width 450)
 */
export function LoginScreen(): React.JSX.Element {
  const { login, register, loginMock } = useAuth();
  const navigation = useNavigation<LoginNavProp>();
  const { width } = useWindowDimensions();
  const isDesktop = width >= DESKTOP_BREAKPOINT;

  const [isSignUp, setIsSignUp] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Submit handler ───────────────────────────────────────────────────────

  const handleSubmit = useCallback(async (): Promise<void> => {
    Keyboard.dismiss();
    if (!email.trim() || !password.trim()) {
      setError('Email and password are required.');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      if (isSignUp) {
        // Derive a display name from the local part of the email address.
        const derivedName = email.trim().split('@')[0];
        await register(email.trim(), password, derivedName, 'chw');
      } else {
        await login(email.trim(), password);
      }
      // Navigation happens automatically via AppNavigator watching isAuthenticated.
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Authentication failed.';
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, [email, password, isSignUp, login, register]);

  // ── Demo login ───────────────────────────────────────────────────────────

  const handleDemoLogin = useCallback(async (account: DemoAccount): Promise<void> => {
    setIsLoading(true);
    setError(null);

    try {
      await login(account.email, account.password);
    } catch (err) {
      // Backend unavailable — fall back to mock login, but ONLY in dev builds.
      // Production users who hit this code path should see the real error so
      // we never silently fabricate a session against a missing backend.
      if (__DEV__) {
        await loginMock(account.role, account.name);
      } else {
        setError(
          err instanceof Error
            ? err.message
            : 'Sign-in failed. Please check your connection and try again.',
        );
      }
    } finally {
      setIsLoading(false);
    }
  }, [login, loginMock]);

  // ── Social login (coming soon) ───────────────────────────────────────────

  const handleSocialLogin = useCallback((provider: 'Google' | 'Apple'): void => {
    Alert.alert(
      `${provider} Sign-In`,
      `${provider} sign-in is coming soon. Use email/password or a demo account for now.`,
      [{ text: 'OK' }],
    );
  }, []);

  // ── Toggle between sign in / sign up ────────────────────────────────────

  const toggleMode = useCallback((): void => {
    setIsSignUp((prev) => !prev);
    setError(null);
    setEmail('');
    setPassword('');
  }, []);

  // ── Navigate back to Landing ─────────────────────────────────────────────

  const handleNavToLanding = useCallback((): void => {
    navigation.navigate('Landing');
  }, [navigation]);

  // ── Derived layout values ────────────────────────────────────────────────

  const headlineFontSize = isDesktop ? 72 : 40;
  const headlineLineHeight = isDesktop ? 76 : 44;

  return (
    <SafeAreaView style={s.safeArea} edges={['top']}>
      {/* ── Sticky navbar ─────────────────────────────────────────────────── */}
      <View style={[s.navbar, isDesktop && s.navbarDesktop]}>
        <ContentWrapper isDesktop={isDesktop} style={s.navbarInner}>
          {/* Left: compass icon + wordmark */}
          <TouchableOpacity
            style={s.navbarLeft}
            onPress={handleNavToLanding}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Go to home"
          >
            <Image source={compassIcon} style={s.navLogo} accessibilityIgnoresInvertColors />
            <Text style={s.navWordmark}>
              Compass<Text style={s.navWordmarkAccent}>CHW</Text>
            </Text>
          </TouchableOpacity>

          {/* Desktop-only center nav links */}
          {isDesktop && (
            <View style={s.navbarCenter}>
              <TouchableOpacity
                style={s.navLink}
                onPress={handleNavToLanding}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Home"
              >
                <Text style={s.navLinkText}>Home</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={s.navLink}
                onPress={handleNavToLanding}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Services"
              >
                <Text style={s.navLinkText}>Services</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={s.navLink}
                onPress={handleNavToLanding}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="How It Works"
              >
                <Text style={s.navLinkText}>How It Works</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={s.navLink}
                onPress={handleNavToLanding}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="For CHWs"
              >
                <Text style={s.navLinkText}>For CHWs</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Spacer on mobile so wordmark stays left-aligned */}
          {!isDesktop && <View />}
        </ContentWrapper>
      </View>

      {/* ── Scrollable body ───────────────────────────────────────────────── */}
      <KeyboardAvoidingView
        style={s.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          style={s.flex}
          contentContainerStyle={[
            s.scrollContent,
            { paddingHorizontal: isDesktop ? 0 : spacing.lg },
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* ── 2-column content area ──────────────────────────────────────── */}
          <ContentWrapper isDesktop={isDesktop} style={s.contentWrapper}>
            <View
              style={[
                s.twoColumnRow,
                {
                  flexDirection: isDesktop ? 'row' : 'column',
                  gap: isDesktop ? 64 : 40,
                },
              ]}
            >
              {/* ── LEFT COLUMN — marketing copy ──────────────────────────── */}
              <View style={[s.leftColumn, isDesktop && s.leftColumnDesktop]}>
                {/* Eyebrow */}
                <View style={s.eyebrowRow}>
                  <View style={s.eyebrowDot} />
                  <Text style={s.eyebrowText}>START YOUR CHW JOURNEY</Text>
                </View>

                {/* Headline */}
                <Text
                  style={[
                    s.headline,
                    {
                      fontSize: headlineFontSize,
                      lineHeight: headlineLineHeight,
                    },
                  ]}
                >
                  Your career in community health{' '}
                  <Text style={s.headlineAccent}>starts here.</Text>
                </Text>

                {/* Description */}
                <Text style={s.description}>
                  Join Compass and start earning by connecting with community members
                  who need your help navigating housing, food, recovery, and healthcare.
                </Text>

                {/* Value props */}
                <View style={s.valuePropsContainer}>
                  {VALUE_PROPS.map((prop) => (
                    <View key={prop} style={s.valuePropRow}>
                      <View style={s.valuePropIcon}>
                        <ArrowRight size={12} color={colors.primary} />
                      </View>
                      <Text style={s.valuePropText}>{prop}</Text>
                    </View>
                  ))}
                </View>
              </View>

              {/* ── RIGHT COLUMN — auth form card ─────────────────────────── */}
              <View style={[s.rightColumn, isDesktop && s.rightColumnDesktop]}>
                <View style={[s.card, shadows.elevated]}>
                  {/* Gradient top bar: primary → compassNude (two-segment approximation) */}
                  <View style={s.cardGradientBar}>
                    <View style={s.cardGradientLeft} />
                    <View style={s.cardGradientRight} />
                  </View>

                  <View style={s.cardBody}>
                    {/* Heading */}
                    <View style={s.cardHeader}>
                      <Text style={s.cardTitle}>
                        {isSignUp ? 'Create your account' : 'Welcome back'}
                      </Text>
                      <Text style={s.cardSubtitle}>
                        {isSignUp
                          ? 'Sign up to start earning as a Community Health Worker.'
                          : 'Sign in to access your Compass dashboard.'}
                      </Text>
                    </View>

                    {/* Error message */}
                    {error !== null && (
                      <View style={s.errorContainer}>
                        <Text style={s.errorText}>{error}</Text>
                      </View>
                    )}

                    {/* Social login buttons */}
                    <View style={s.socialButtonsContainer}>
                      <TouchableOpacity
                        style={s.socialButton}
                        onPress={() => handleSocialLogin('Google')}
                        activeOpacity={0.7}
                        accessibilityLabel="Continue with Google"
                        accessibilityRole="button"
                      >
                        <GoogleIcon />
                        <Text style={s.socialButtonText}>Continue with Google</Text>
                      </TouchableOpacity>

                      <TouchableOpacity
                        style={s.socialButton}
                        onPress={() => handleSocialLogin('Apple')}
                        activeOpacity={0.7}
                        accessibilityLabel="Continue with Apple"
                        accessibilityRole="button"
                      >
                        <AppleIcon />
                        <Text style={s.socialButtonText}>Continue with Apple</Text>
                      </TouchableOpacity>
                    </View>

                    {/* OR divider */}
                    <View style={s.dividerRow}>
                      <View style={s.dividerLine} />
                      <Text style={s.dividerLabel}>OR</Text>
                      <View style={s.dividerLine} />
                    </View>

                    {/* Email input */}
                    <View style={s.inputGroup}>
                      <Text style={s.inputLabel}>EMAIL ADDRESS</Text>
                      <View style={s.inputWrapper}>
                        <Mail size={16} color={colors.mutedForeground} style={s.inputIcon} />
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
                    </View>

                    {/* Password input */}
                    <View style={s.inputGroup}>
                      <Text style={s.inputLabel}>PASSWORD</Text>
                      <View style={s.inputWrapper}>
                        <Lock size={16} color={colors.mutedForeground} style={s.inputIcon} />
                        <TextInput
                          style={[s.textInput, s.passwordInput]}
                          placeholder="••••••••"
                          placeholderTextColor={`${colors.mutedForeground}88`}
                          value={password}
                          onChangeText={setPassword}
                          secureTextEntry={!showPassword}
                          autoComplete={isSignUp ? 'new-password' : 'current-password'}
                          returnKeyType="done"
                          onSubmitEditing={handleSubmit}
                          editable={!isLoading}
                          accessibilityLabel="Password"
                        />
                        <Pressable
                          onPress={() => setShowPassword((prev) => !prev)}
                          style={s.eyeButton}
                          accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
                          accessibilityRole="button"
                        >
                          {showPassword ? (
                            <EyeOff size={16} color={colors.mutedForeground} />
                          ) : (
                            <Eye size={16} color={colors.mutedForeground} />
                          )}
                        </Pressable>
                      </View>
                    </View>

                    {/* Primary submit button */}
                    <TouchableOpacity
                      style={[s.submitButton, isLoading && s.submitButtonDisabled]}
                      onPress={handleSubmit}
                      disabled={isLoading}
                      activeOpacity={0.85}
                      accessibilityLabel={isSignUp ? 'Create account' : 'Sign in'}
                      accessibilityRole="button"
                    >
                      {isLoading ? (
                        <ActivityIndicator size="small" color="#FFFFFF" />
                      ) : (
                        <Text style={s.submitButtonText}>
                          {isSignUp ? 'Create Account' : 'Sign In'}
                        </Text>
                      )}
                    </TouchableOpacity>

                    {/* Toggle sign in / sign up */}
                    <View style={s.toggleRow}>
                      <Text style={s.toggleText}>
                        {isSignUp ? 'Already have an account? ' : "Don't have an account? "}
                      </Text>
                      <TouchableOpacity
                        onPress={toggleMode}
                        accessibilityRole="button"
                        accessibilityLabel={isSignUp ? 'Switch to sign in' : 'Switch to sign up'}
                      >
                        <Text style={s.toggleLink}>
                          {isSignUp ? 'Sign in' : 'Sign up'}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                </View>

                {/* ── Demo buttons (below card, border-only) ─────────────── */}
                <View style={s.demoDividerRow}>
                  <View style={s.dividerLine} />
                  <Text style={s.demoDividerLabel}>DEMO</Text>
                  <View style={s.dividerLine} />
                </View>

                <View style={s.demoButtonsRow}>
                  {DEMO_ACCOUNTS.map((account) => (
                    <TouchableOpacity
                      key={account.role}
                      style={s.demoButton}
                      onPress={() => handleDemoLogin(account)}
                      disabled={isLoading}
                      activeOpacity={0.7}
                      accessibilityLabel={account.label}
                      accessibilityRole="button"
                    >
                      <Text style={s.demoButtonText}>{account.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            </View>
          </ContentWrapper>
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
    justifyContent: 'center',
    zIndex: 10,
    ...Platform.select({
      ios: {
        shadowColor: colors.foreground,
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.05,
        shadowRadius: 3,
      },
      android: {
        elevation: 2,
      },
    }),
  },
  navbarDesktop: {
    height: 64,
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
  navbarCenter: {
    flexDirection: 'row',
    gap: 32,
    alignItems: 'center',
  },
  navLink: {
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  navLinkText: {
    fontSize: 14,
    fontFamily: fonts.body,
    color: colors.mutedForeground,
  },

  // ── Scroll / content ──────────────────────────────────────────────────────
  scrollContent: {
    flexGrow: 1,
    paddingTop: spacing.xxl,
    paddingBottom: spacing.xxl,
  },
  contentWrapper: {
    // Additional styles applied inline via ContentWrapper + paddingHorizontal
  },

  // ── 2-column row ──────────────────────────────────────────────────────────
  twoColumnRow: {
    alignItems: 'center',
  },

  // ── Left column (marketing copy) ─────────────────────────────────────────
  leftColumn: {
    width: '100%',
    gap: spacing.md,
  },
  leftColumnDesktop: {
    flex: 1,
    gap: spacing.lg,
  },
  eyebrowRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  eyebrowDot: {
    width: 10,
    height: 10,
    borderRadius: radii.full,
    backgroundColor: colors.secondary,
  },
  eyebrowText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 11,
    letterSpacing: 1.2,
    color: colors.mutedForeground,
    textTransform: 'uppercase',
  },
  headline: {
    fontFamily: fonts.display,
    letterSpacing: -2,
    color: colors.foreground,
  },
  headlineAccent: {
    color: colors.secondary,
  },
  description: {
    fontFamily: fonts.body,
    fontSize: 16,
    lineHeight: 26,
    color: colors.mutedForeground,
    maxWidth: 480,
  },
  valuePropsContainer: {
    gap: spacing.sm + 4,
    marginTop: spacing.xs,
  },
  valuePropRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  valuePropIcon: {
    width: 24,
    height: 24,
    borderRadius: radii.full,
    backgroundColor: `${colors.primary}18`,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  valuePropText: {
    fontFamily: fonts.body,
    fontSize: 15,
    color: colors.foreground,
    flex: 1,
  },

  // ── Right column (form card) ──────────────────────────────────────────────
  rightColumn: {
    width: '100%',
    gap: spacing.md,
  },
  rightColumnDesktop: {
    width: 450,
    flexShrink: 0,
    gap: spacing.md,
  },

  // ── Auth card ─────────────────────────────────────────────────────────────
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: radii.xl,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  // Two-segment color bar simulating a CSS gradient (primary → compassNude)
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
    fontFamily: fonts.displaySemibold,
    fontSize: 24,
    color: colors.foreground,
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

  // ── Social buttons ────────────────────────────────────────────────────────
  socialButtonsContainer: {
    gap: spacing.sm + 2,
  },
  socialButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md - 2,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: '#FFFFFF',
    paddingVertical: 14,
    paddingHorizontal: spacing.md,
  },
  socialButtonText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 14,
    color: colors.foreground,
  },

  // ── OR divider ────────────────────────────────────────────────────────────
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginVertical: spacing.xs,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: colors.border,
  },
  dividerLabel: {
    fontFamily: fonts.bodySemibold,
    fontSize: 11,
    letterSpacing: 1.2,
    color: colors.mutedForeground,
  },

  // ── Inputs ────────────────────────────────────────────────────────────────
  inputGroup: {
    gap: spacing.xs - 2,
  },
  inputLabel: {
    fontFamily: fonts.bodySemibold,
    fontSize: 11,
    letterSpacing: 1,
    color: colors.mutedForeground,
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
    gap: spacing.sm + 2,
  },
  inputIcon: {
    flexShrink: 0,
  },
  textInput: {
    flex: 1,
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.foreground,
    padding: 0,
    margin: 0,
  },
  passwordInput: {
    paddingRight: spacing.xl,
  },
  eyeButton: {
    padding: spacing.xs,
    marginLeft: 'auto',
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
    fontFamily: fonts.display,
    fontSize: 16,
    color: '#FFFFFF',
  },

  // ── Toggle sign in / sign up ──────────────────────────────────────────────
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    flexWrap: 'wrap',
    marginTop: spacing.xs,
  },
  toggleText: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.mutedForeground,
  },
  toggleLink: {
    fontFamily: fonts.bodySemibold,
    fontSize: 14,
    color: colors.primary,
  },

  // ── Demo section ──────────────────────────────────────────────────────────
  demoDividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.xs,
  },
  demoDividerLabel: {
    fontFamily: fonts.bodySemibold,
    fontSize: 11,
    letterSpacing: 1.2,
    color: colors.mutedForeground,
    opacity: 0.6,
  },
  demoButtonsRow: {
    flexDirection: 'row',
    gap: spacing.sm + 2,
  },
  demoButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.background,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
  },
  demoButtonText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 12,
    letterSpacing: 0.3,
    color: colors.mutedForeground,
  },
});

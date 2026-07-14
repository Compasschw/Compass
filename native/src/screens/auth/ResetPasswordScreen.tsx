/**
 * ResetPasswordScreen — forgot-password reset flow.
 *
 * Two modes:
 *   1. Request mode (token not in route params): user enters their email, we
 *      POST /auth/password-reset/request, then show a neutral "check your
 *      email" confirmation. The endpoint always returns 202 regardless of
 *      whether the account exists (anti-enumeration) — the copy here must
 *      never imply otherwise.
 *   2. Confirm mode (token in route params from a deep link): user chooses a
 *      new password, we POST /auth/password-reset/confirm. On success there
 *      is NO auto-login — the user is sent to sign in with the new password.
 *      A 401 means the token is unknown/expired/already-used; we show an
 *      inline error with an affordance to request a new link.
 *
 * Arrives via two paths:
 *   - User taps "Forgot password?" on LoginScreen → request mode
 *   - User taps link in email → compasschw://auth/reset-password?token=... →
 *     confirm mode
 *
 * Modeled directly on MagicLinkScreen.tsx (same card/layout/styling
 * conventions) — kept as a distinct screen/route since the two flows
 * (passwordless sign-in vs. password reset) are product-distinct and
 * MagicLinkScreen must remain untouched.
 */

import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CheckCircle, Lock, Eye, EyeOff, ArrowLeft, KeyRound } from 'lucide-react-native';

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { AuthStackParamList } from '../../navigation/AppNavigator';
import { colors } from '../../theme/colors';
import { fonts } from '../../theme/typography';
import { radii, spacing } from '../../theme/spacing';
import { shadows } from '../../theme/shadows';
import { ApiError } from '../../api/client';
import {
  useRequestPasswordReset,
  useConfirmPasswordReset,
} from '../../hooks/useApiQueries';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const compassIcon = require('../../../assets/compass-icon.png') as number;

type Props = NativeStackScreenProps<AuthStackParamList, 'ResetPassword'>;

type Mode = 'request' | 'requesting' | 'sent' | 'confirm' | 'confirming' | 'confirmed' | 'expired';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

const EXPIRED_TOKEN_MESSAGE =
  'This link has expired or was already used. Request a new one.';

export function ResetPasswordScreen({ route, navigation }: Props): React.JSX.Element {
  const routeToken = route.params?.token;

  const [email, setEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [mode, setMode] = useState<Mode>(routeToken ? 'confirm' : 'request');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const requestMutation = useRequestPasswordReset();
  const confirmMutation = useConfirmPasswordReset();

  // ── Request mode: email → POST /auth/password-reset/request ────────────────

  const handleRequest = useCallback(async () => {
    const normalized = email.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(normalized)) {
      setErrorMessage('Please enter a valid email address.');
      return;
    }
    setErrorMessage(null);
    setMode('requesting');
    try {
      await requestMutation.mutateAsync(normalized);
      setMode('sent');
    } catch {
      // The endpoint always returns 202 (anti-enumeration), so the only
      // failure path here is a network error.
      setMode('request');
      setErrorMessage('Could not send the email. Check your connection and try again.');
    }
  }, [email, requestMutation]);

  // ── Confirm mode: token + new password → POST /auth/password-reset/confirm ─

  const handleConfirm = useCallback(async () => {
    setFieldError(null);
    setErrorMessage(null);

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setFieldError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setFieldError('Passwords do not match.');
      return;
    }
    if (!routeToken) {
      // Defensive — confirm mode should never be reached without a token.
      setMode('expired');
      setErrorMessage(EXPIRED_TOKEN_MESSAGE);
      return;
    }

    setMode('confirming');
    try {
      await confirmMutation.mutateAsync({ token: routeToken, newPassword });
      setMode('confirmed');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setMode('expired');
        setErrorMessage(EXPIRED_TOKEN_MESSAGE);
        return;
      }
      if (err instanceof ApiError && err.status === 422) {
        setMode('confirm');
        setFieldError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
        return;
      }
      // Network error or anything unexpected — never crash, show inline error.
      setMode('confirm');
      setErrorMessage('Could not reset your password. Check your connection and try again.');
    }
  }, [newPassword, confirmPassword, routeToken, confirmMutation]);

  // ── "Request a new one" affordance from the expired-token panel ────────────

  const handleRequestAgain = useCallback(() => {
    setErrorMessage(null);
    setFieldError(null);
    setNewPassword('');
    setConfirmPassword('');
    navigation.setParams({ token: undefined });
    setMode('request');
  }, [navigation]);

  const handleGoToLogin = useCallback(() => {
    navigation.navigate('Login');
  }, [navigation]);

  const handleBack = useCallback(() => {
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.navigate('Landing');
  }, [navigation]);

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {/* Back */}
          <TouchableOpacity
            style={styles.backButton}
            onPress={handleBack}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <ArrowLeft size={20} color={colors.mutedForeground} />
            <Text style={styles.backButtonText}>Back</Text>
          </TouchableOpacity>

          {/* Header */}
          <View style={styles.header}>
            <Image source={compassIcon} style={styles.logo} resizeMode="contain" />
            <Text style={styles.brand}>
              Compass<Text style={styles.brandAccent}>CHW</Text>
            </Text>
          </View>

          {/* Body */}
          <View style={styles.card}>
            {mode === 'request' || mode === 'requesting' ? (
              <>
                <View style={styles.iconBadge}>
                  <KeyRound size={24} color={colors.primary} />
                </View>
                <Text style={styles.title}>Reset your password</Text>
                <Text style={styles.subtitle}>
                  Enter your email and we'll send you a link to reset your password.
                </Text>

                <TextInput
                  style={styles.input}
                  value={email}
                  onChangeText={(v) => {
                    setEmail(v);
                    if (errorMessage) setErrorMessage(null);
                  }}
                  placeholder="you@example.com"
                  placeholderTextColor={colors.mutedForeground}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="email"
                  textContentType="emailAddress"
                  editable={mode !== 'requesting'}
                  accessibilityLabel="Email address"
                />

                {errorMessage && (
                  <Text style={styles.errorText}>{errorMessage}</Text>
                )}

                <TouchableOpacity
                  style={[
                    styles.primaryButton,
                    mode === 'requesting' && styles.primaryButtonDisabled,
                  ]}
                  onPress={handleRequest}
                  disabled={mode === 'requesting'}
                  accessibilityRole="button"
                  accessibilityLabel="Send reset link"
                >
                  {mode === 'requesting' ? (
                    <ActivityIndicator color={colors.background} />
                  ) : (
                    <Text style={styles.primaryButtonText}>Send reset link</Text>
                  )}
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.secondaryButton}
                  onPress={handleGoToLogin}
                  accessibilityRole="button"
                  accessibilityLabel="Back to sign in"
                >
                  <Text style={styles.secondaryButtonText}>Back to sign in</Text>
                </TouchableOpacity>
              </>
            ) : mode === 'sent' ? (
              <>
                <View style={[styles.iconBadge, styles.iconBadgeSuccess]}>
                  <CheckCircle size={28} color={colors.secondary} />
                </View>
                <Text style={styles.title}>Check your email</Text>
                <Text style={styles.subtitle}>
                  If an account exists for{'\n'}
                  <Text style={styles.emailHighlight}>{email}</Text>
                  {'\n'}a reset link is on its way.
                </Text>
                <Text style={styles.helperText}>
                  It expires in 30 minutes. You can close this screen while you wait.
                </Text>

                <TouchableOpacity
                  style={styles.secondaryButton}
                  onPress={handleGoToLogin}
                  accessibilityRole="button"
                  accessibilityLabel="Back to sign in"
                >
                  <Text style={styles.secondaryButtonText}>Back to sign in</Text>
                </TouchableOpacity>
              </>
            ) : mode === 'confirm' || mode === 'confirming' ? (
              <>
                <View style={styles.iconBadge}>
                  <Lock size={24} color={colors.primary} />
                </View>
                <Text style={styles.title}>Choose a new password</Text>
                <Text style={styles.subtitle}>
                  Your new password must be at least {MIN_PASSWORD_LENGTH} characters.
                </Text>

                <View style={styles.passwordInputWrapper}>
                  <TextInput
                    style={[styles.input, styles.passwordInput]}
                    value={newPassword}
                    onChangeText={(v) => {
                      setNewPassword(v);
                      if (fieldError) setFieldError(null);
                      if (errorMessage) setErrorMessage(null);
                    }}
                    placeholder="New password"
                    placeholderTextColor={colors.mutedForeground}
                    secureTextEntry={!showNewPassword}
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="new-password"
                    textContentType="newPassword"
                    editable={mode !== 'confirming'}
                    accessibilityLabel="New password"
                  />
                  <Pressable
                    onPress={() => setShowNewPassword((prev) => !prev)}
                    style={styles.eyeButton}
                    accessibilityLabel={showNewPassword ? 'Hide new password' : 'Show new password'}
                    accessibilityRole="button"
                  >
                    {showNewPassword ? (
                      <EyeOff size={16} color={colors.mutedForeground} />
                    ) : (
                      <Eye size={16} color={colors.mutedForeground} />
                    )}
                  </Pressable>
                </View>

                <View style={styles.passwordInputWrapper}>
                  <TextInput
                    style={[styles.input, styles.passwordInput]}
                    value={confirmPassword}
                    onChangeText={(v) => {
                      setConfirmPassword(v);
                      if (fieldError) setFieldError(null);
                      if (errorMessage) setErrorMessage(null);
                    }}
                    placeholder="Confirm new password"
                    placeholderTextColor={colors.mutedForeground}
                    secureTextEntry={!showConfirmPassword}
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="new-password"
                    textContentType="newPassword"
                    editable={mode !== 'confirming'}
                    accessibilityLabel="Confirm new password"
                    onSubmitEditing={handleConfirm}
                  />
                  <Pressable
                    onPress={() => setShowConfirmPassword((prev) => !prev)}
                    style={styles.eyeButton}
                    accessibilityLabel={
                      showConfirmPassword ? 'Hide confirm password' : 'Show confirm password'
                    }
                    accessibilityRole="button"
                  >
                    {showConfirmPassword ? (
                      <EyeOff size={16} color={colors.mutedForeground} />
                    ) : (
                      <Eye size={16} color={colors.mutedForeground} />
                    )}
                  </Pressable>
                </View>

                {fieldError && <Text style={styles.errorText}>{fieldError}</Text>}
                {errorMessage && <Text style={styles.errorText}>{errorMessage}</Text>}

                <TouchableOpacity
                  style={[
                    styles.primaryButton,
                    mode === 'confirming' && styles.primaryButtonDisabled,
                  ]}
                  onPress={handleConfirm}
                  disabled={mode === 'confirming'}
                  accessibilityRole="button"
                  accessibilityLabel="Reset password"
                >
                  {mode === 'confirming' ? (
                    <ActivityIndicator color={colors.background} />
                  ) : (
                    <Text style={styles.primaryButtonText}>Reset password</Text>
                  )}
                </TouchableOpacity>
              </>
            ) : mode === 'confirmed' ? (
              <>
                <View style={[styles.iconBadge, styles.iconBadgeSuccess]}>
                  <CheckCircle size={28} color={colors.secondary} />
                </View>
                <Text style={styles.title}>Password updated</Text>
                <Text style={styles.subtitle}>
                  Sign in with your new password.
                </Text>

                <TouchableOpacity
                  style={styles.primaryButton}
                  onPress={handleGoToLogin}
                  accessibilityRole="button"
                  accessibilityLabel="Go to sign in"
                >
                  <Text style={styles.primaryButtonText}>Go to sign in</Text>
                </TouchableOpacity>
              </>
            ) : mode === 'expired' ? (
              <>
                <View style={styles.iconBadge}>
                  <KeyRound size={24} color={colors.destructive} />
                </View>
                <Text style={styles.title}>Link expired</Text>
                <Text style={styles.errorText}>{errorMessage ?? EXPIRED_TOKEN_MESSAGE}</Text>

                <TouchableOpacity
                  style={styles.primaryButton}
                  onPress={handleRequestAgain}
                  accessibilityRole="button"
                  accessibilityLabel="Request a new reset link"
                >
                  <Text style={styles.primaryButtonText}>Request a new link</Text>
                </TouchableOpacity>
              </>
            ) : null}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xxl,
  },

  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    gap: spacing.xs,
    alignSelf: 'flex-start',
  },
  backButtonText: {
    fontFamily: fonts.bodyMedium,
    fontSize: 14,
    color: colors.mutedForeground,
  },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.lg,
    marginBottom: spacing.xl,
  },
  logo: { width: 36, height: 36 },
  brand: {
    fontFamily: fonts.bodyBold,
    fontSize: 22,
    color: colors.primary,
  },
  brandAccent: { color: colors.secondary },

  card: {
    backgroundColor: colors.card,
    borderRadius: radii.xl,
    padding: spacing.xl,
    alignItems: 'center',
    ...shadows.card,
  },
  iconBadge: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: `${colors.primary}15`,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  iconBadgeSuccess: { backgroundColor: `${colors.secondary}15` },
  title: {
    fontFamily: fonts.bodyBold,
    fontSize: 22,
    color: colors.foreground,
    textAlign: 'center',
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },
  subtitle: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.mutedForeground,
    textAlign: 'center',
    marginBottom: spacing.lg,
    lineHeight: 20,
  },
  emailHighlight: {
    fontFamily: fonts.bodySemibold,
    color: colors.foreground,
  },
  helperText: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.mutedForeground,
    textAlign: 'center',
    marginBottom: spacing.md,
  },

  input: {
    width: '100%',
    height: 52,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    fontFamily: fonts.body,
    fontSize: 16,
    color: colors.foreground,
    marginBottom: spacing.sm,
  },
  passwordInputWrapper: {
    width: '100%',
    position: 'relative',
    justifyContent: 'center',
  },
  passwordInput: {
    paddingRight: spacing.xl + spacing.md,
  },
  eyeButton: {
    position: 'absolute',
    right: spacing.md,
    top: 0,
    bottom: 0,
    marginBottom: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
  },
  errorText: {
    fontFamily: fonts.bodyMedium,
    fontSize: 13,
    color: colors.destructive,
    marginBottom: spacing.sm,
    textAlign: 'center',
  },

  primaryButton: {
    width: '100%',
    height: 52,
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.sm,
  },
  primaryButtonDisabled: { opacity: 0.6 },
  primaryButtonText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 16,
    color: colors.background,
  },
  secondaryButton: {
    paddingVertical: spacing.md,
  },
  secondaryButtonText: {
    fontFamily: fonts.bodyMedium,
    fontSize: 14,
    color: colors.primary,
  },
});

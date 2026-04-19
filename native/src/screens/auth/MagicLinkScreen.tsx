/**
 * MagicLinkScreen — passwordless email login.
 *
 * Two modes:
 *   1. Request mode (token not in route params): user enters email, we POST
 *      /auth/magic/request, then show a "check your email" confirmation.
 *   2. Verify mode (token in route params from a deep link): we POST
 *      /auth/magic/verify, hand the resulting JWT pair to AuthContext, and
 *      the app transitions into the authenticated stack.
 *
 * Arrives via two paths:
 *   - User taps "Email me a login link" on LoginScreen → request mode
 *   - User taps link in email → compasschw://auth/magic?token=... → verify mode
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CheckCircle, Mail, ArrowLeft } from 'lucide-react-native';

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { AuthStackParamList } from '../../navigation/AppNavigator';
import { colors } from '../../theme/colors';
import { fonts } from '../../theme/typography';
import { radii, spacing } from '../../theme/spacing';
import { shadows } from '../../theme/shadows';
import { useAuth } from '../../context/AuthContext';
import {
  useRequestMagicLink,
  useVerifyMagicLink,
} from '../../hooks/useApiQueries';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const compassIcon = require('../../../assets/compass-icon.png') as number;

type Props = NativeStackScreenProps<AuthStackParamList, 'MagicLink'>;

type Mode = 'request' | 'requesting' | 'sent' | 'verifying' | 'error';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function MagicLinkScreen({ route, navigation }: Props): React.JSX.Element {
  const routeToken = route.params?.token;
  const { signInWithTokens } = useAuth();

  const [email, setEmail] = useState('');
  const [mode, setMode] = useState<Mode>(routeToken ? 'verifying' : 'request');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const requestMutation = useRequestMagicLink();
  const verifyMutation = useVerifyMagicLink();
  const verifiedRef = useRef(false);

  // Auto-verify if the screen was opened with a token param (email deep link path)
  useEffect(() => {
    if (!routeToken || verifiedRef.current) return;
    verifiedRef.current = true;
    (async () => {
      try {
        const tokens = await verifyMutation.mutateAsync(routeToken);
        await signInWithTokens({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          role: tokens.role as 'chw' | 'member',
          name: tokens.name,
        });
        // AuthContext flip will cause the navigator to swap stacks; no manual nav needed.
      } catch {
        setMode('error');
        setErrorMessage(
          'This link has expired or been used already. Please request a new one.',
        );
      }
    })();
  }, [routeToken, verifyMutation, signInWithTokens]);

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
      // The endpoint returns 202 for unknown emails too (anti-enumeration), so
      // the only failure path here is a network error.
      setMode('error');
      setErrorMessage('Could not send the email. Check your connection and try again.');
    }
  }, [email, requestMutation]);

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
            {mode === 'request' || mode === 'requesting' || mode === 'error' ? (
              <>
                <View style={styles.iconBadge}>
                  <Mail size={24} color={colors.primary} />
                </View>
                <Text style={styles.title}>Sign in with email</Text>
                <Text style={styles.subtitle}>
                  We'll send you a secure link that signs you in. No password needed.
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
                  accessibilityLabel="Send login link"
                >
                  {mode === 'requesting' ? (
                    <ActivityIndicator color={colors.background} />
                  ) : (
                    <Text style={styles.primaryButtonText}>Send login link</Text>
                  )}
                </TouchableOpacity>
              </>
            ) : mode === 'sent' ? (
              <>
                <View style={[styles.iconBadge, styles.iconBadgeSuccess]}>
                  <CheckCircle size={28} color={colors.secondary} />
                </View>
                <Text style={styles.title}>Check your email</Text>
                <Text style={styles.subtitle}>
                  We sent a login link to{'\n'}
                  <Text style={styles.emailHighlight}>{email}</Text>
                </Text>
                <Text style={styles.helperText}>
                  The link expires in 15 minutes. You can close this screen while you wait.
                </Text>

                <TouchableOpacity
                  style={styles.secondaryButton}
                  onPress={() => {
                    setMode('request');
                    setEmail('');
                  }}
                  accessibilityRole="button"
                >
                  <Text style={styles.secondaryButtonText}>Use a different email</Text>
                </TouchableOpacity>
              </>
            ) : mode === 'verifying' ? (
              <>
                <ActivityIndicator size="large" color={colors.primary} />
                <Text style={[styles.title, styles.centered]}>Signing you in…</Text>
                <Text style={styles.subtitle}>This will only take a moment.</Text>
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
  centered: { marginTop: spacing.md },
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

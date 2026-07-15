/**
 * VerifyPhoneScreen — post-signup "Confirm your phone" step (SMS Output Spec 1 §1).
 *
 * Shown to a newly-registered member whose submitted phone is a real number
 * (never the 555-555-5555 placeholder). The member is already authenticated —
 * RegisterScreen fired POST /phone/start-verification before navigating here —
 * so this screen only collects the 6-digit code and confirms it.
 *
 * Confirming sets User.phone_verified_at server-side, which is the exact gate
 * check_sms_eligibility reads: once verified, the member's CHW messages and
 * confirmations also arrive as SMS. The step is fully skippable ("Verify
 * later") — an unverified member stays app-only and can turn on texts later
 * from Member Settings (the "Text messages" card re-launches this same flow).
 *
 * On mount it does NOT auto-send a code — RegisterScreen triggers the first
 * send before navigating, so this screen never double-texts. "Resend code"
 * re-triggers a send and is throttled for 30s after each tap.
 *
 * Modeled on ResetPasswordScreen.tsx (same card/layout/error conventions).
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
import { MessageSquare } from 'lucide-react-native';

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { AuthStackParamList } from '../../navigation/AppNavigator';
import { colors } from '../../theme/colors';
import { fonts } from '../../theme/typography';
import { radii, spacing } from '../../theme/spacing';
import { shadows } from '../../theme/shadows';
import { ApiError } from '../../api/client';
import {
  useStartPhoneVerification,
  useConfirmPhoneVerification,
} from '../../hooks/useApiQueries';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const compassIcon = require('../../../assets/compass-icon.png') as number;

type Props = NativeStackScreenProps<AuthStackParamList, 'VerifyPhone'>;

const CODE_LENGTH = 6;
const RESEND_COOLDOWN_MS = 30_000;

export function VerifyPhoneScreen({ route, navigation }: Props): React.JSX.Element {
  const phone = route.params?.phone ?? '';

  const [code, setCode] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [resendDisabled, setResendDisabled] = useState(false);

  const confirmMutation = useConfirmPhoneVerification();
  const startMutation = useStartPhoneVerification();

  const resendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (resendTimerRef.current) clearTimeout(resendTimerRef.current);
    },
    [],
  );

  // Dismiss the verify step and continue into the (already-authenticated) app.
  // The root navigator swapped to the Member stack the moment registration
  // succeeded, so leaving this step lands the member on their home screen.
  const proceed = useCallback((): void => {
    if (navigation.canGoBack()) navigation.goBack();
  }, [navigation]);

  const handleConfirm = useCallback(async (): Promise<void> => {
    setFieldError(null);
    if (code.length !== CODE_LENGTH) {
      setFieldError('Enter the 6-digit code we texted you.');
      return;
    }
    try {
      await confirmMutation.mutateAsync({ phone, code });
      proceed();
    } catch (err) {
      if (err instanceof ApiError) {
        // 400 (wrong code, attempts remaining), 410 (expired/exhausted),
        // 422 (bad format) — surface the server's readable detail inline.
        setFieldError(err.message || 'That code was not correct. Please try again.');
        return;
      }
      setFieldError('Could not verify the code. Check your connection and try again.');
    }
  }, [code, phone, confirmMutation, proceed]);

  const handleResend = useCallback((): void => {
    if (resendDisabled) return;
    setFieldError(null);
    setResendDisabled(true);
    // Best-effort — a failed resend surfaces inline but never blocks the flow.
    startMutation.mutate(
      { phone },
      {
        onError: () =>
          setFieldError('Could not resend the code. Please try again in a moment.'),
      },
    );
    resendTimerRef.current = setTimeout(() => setResendDisabled(false), RESEND_COOLDOWN_MS);
  }, [phone, resendDisabled, startMutation]);

  const isConfirming = confirmMutation.isPending;

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
          {/* Header */}
          <View style={styles.header}>
            <Image source={compassIcon} style={styles.logo} resizeMode="contain" />
            <Text style={styles.brand}>
              Compass<Text style={styles.brandAccent}>CHW</Text>
            </Text>
          </View>

          <View style={styles.card}>
            <View style={styles.iconBadge}>
              <MessageSquare size={24} color={colors.primary} />
            </View>
            <Text style={styles.title}>Confirm your phone</Text>
            <Text style={styles.subtitle}>
              We texted a 6-digit code to{' '}
              <Text style={styles.phoneHighlight}>{phone}</Text>. Enter it below to
              turn on text messages from your CHW.
            </Text>

            <TextInput
              style={styles.input}
              value={code}
              onChangeText={(v) => {
                setCode(v.replace(/\D/g, '').slice(0, CODE_LENGTH));
                if (fieldError) setFieldError(null);
              }}
              placeholder="123456"
              placeholderTextColor={colors.mutedForeground}
              keyboardType="number-pad"
              maxLength={CODE_LENGTH}
              editable={!isConfirming}
              accessibilityLabel="Verification code"
              onSubmitEditing={handleConfirm}
            />

            {fieldError && <Text style={styles.errorText}>{fieldError}</Text>}

            <TouchableOpacity
              style={[styles.primaryButton, isConfirming && styles.primaryButtonDisabled]}
              onPress={handleConfirm}
              disabled={isConfirming}
              accessibilityRole="button"
              accessibilityLabel="Confirm"
            >
              {isConfirming ? (
                <ActivityIndicator color={colors.background} />
              ) : (
                <Text style={styles.primaryButtonText}>Confirm</Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.resendButton}
              onPress={handleResend}
              disabled={resendDisabled}
              accessibilityRole="button"
              accessibilityLabel="Resend code"
            >
              <Text style={[styles.resendText, resendDisabled && styles.resendTextDisabled]}>
                {resendDisabled ? 'Code sent — check your messages' : 'Resend code'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={proceed}
              accessibilityRole="button"
              accessibilityLabel="Skip verification"
            >
              <Text style={styles.secondaryButtonText}>Verify later</Text>
            </TouchableOpacity>
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
    justifyContent: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
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
  phoneHighlight: {
    fontFamily: fonts.bodySemibold,
    color: colors.foreground,
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
    fontSize: 20,
    letterSpacing: 6,
    textAlign: 'center',
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
  resendButton: {
    paddingVertical: spacing.md,
  },
  resendText: {
    fontFamily: fonts.bodyMedium,
    fontSize: 14,
    color: colors.primary,
    textAlign: 'center',
  },
  resendTextDisabled: {
    color: colors.mutedForeground,
  },
  secondaryButton: {
    paddingVertical: spacing.sm,
  },
  secondaryButtonText: {
    fontFamily: fonts.bodyMedium,
    fontSize: 14,
    color: colors.mutedForeground,
  },
});

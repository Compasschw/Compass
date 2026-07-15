/**
 * TwoFactorScreen — SMS 2FA challenge after a correct password (Spec 2, Task 7).
 *
 * Reached from LoginScreen when `POST /auth/login` returns a 2FA challenge
 * (CHWs always; opted-in members with a verified, non-sentinel phone) and no
 * trusted device short-circuited it. Two variants, chosen by the
 * `phoneVerificationRequired` route param:
 *
 *   • Code entry (verified phone on file) — auto-sends the first code on mount,
 *     shows "Enter the 6-digit code we texted to •••1234", and verifies.
 *   • Phone entry (enrollment / recovery — no verified number yet) — collects a
 *     phone first, sends the code to it, then falls through to code entry.
 *
 * "Remember this device for 30 days" defaults CHECKED; when left checked and
 * the code verifies, the raw device token the backend returns is persisted
 * (trustedDevice util) and replayed as `X-Device-Token` on the next login to
 * skip the challenge. Resend is throttled 30s. Inline destructive-colour errors
 * cover wrong (422) / expired (410) codes; a 401 (pending token expired) shows
 * "Your session expired" and routes back to Login — the pending token is
 * single-use and short-lived, so re-authenticating is the only recovery.
 *
 * On success the tokens are stored via AuthContext.signInWithTokens (identical
 * to every other sign-in path), which flips auth state and lets the root
 * navigator swap to the CHW/Member stack — this screen simply unmounts.
 *
 * Modeled on VerifyPhoneScreen.tsx (same card/layout/error conventions).
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
import { Check, ShieldCheck } from 'lucide-react-native';

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { AuthStackParamList } from '../../navigation/AppNavigator';
import { useAuth } from '../../context/AuthContext';
import { ApiError } from '../../api/client';
import { sendTwoFactorCode, verifyTwoFactorCode } from '../../api/auth';
import { setTrustedDeviceToken } from '../../utils/trustedDevice';
import type { UserRole } from '../../data/mock';
import { colors } from '../../theme/colors';
import { fonts } from '../../theme/typography';
import { radii, spacing } from '../../theme/spacing';
import { shadows } from '../../theme/shadows';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const compassIcon = require('../../../assets/compass-icon.png') as number;

type Props = NativeStackScreenProps<AuthStackParamList, 'TwoFactor'>;

const CODE_LENGTH = 6;
const RESEND_COOLDOWN_MS = 30_000;

/** Normalise a raw US phone to E.164, or null when it isn't a plausible
 *  10-digit US number. Mirrors RegisterScreen.normalizeUsPhoneToE164 so the
 *  enrollment path sends the exact E.164 the OTP endpoint expects. */
function normalizeUsPhoneToE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

export function TwoFactorScreen({ route, navigation }: Props): React.JSX.Element {
  const { pendingToken, phoneLast4, phoneVerificationRequired } = route.params;
  const { signInWithTokens } = useAuth();

  // 'phone' (enrollment: collect a number first) or 'code' (enter the OTP).
  const [step, setStep] = useState<'phone' | 'code'>(
    phoneVerificationRequired ? 'phone' : 'code',
  );
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [last4, setLast4] = useState<string | null>(phoneLast4);
  const [rememberDevice, setRememberDevice] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [resendDisabled, setResendDisabled] = useState(false);

  const resendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (resendTimerRef.current) clearTimeout(resendTimerRef.current);
    },
    [],
  );

  const startResendCooldown = useCallback((): void => {
    setResendDisabled(true);
    if (resendTimerRef.current) clearTimeout(resendTimerRef.current);
    resendTimerRef.current = setTimeout(() => setResendDisabled(false), RESEND_COOLDOWN_MS);
  }, []);

  // A 401 means the single-use pending token is expired/spent — the only
  // recovery is a fresh password login, so bounce back to the Login screen.
  const expireToLogin = useCallback((): void => {
    setError('Your session expired. Please sign in again.');
    navigation.navigate('Login');
  }, [navigation]);

  const surfaceError = useCallback(
    (err: unknown): void => {
      if (err instanceof ApiError) {
        if (err.status === 401) {
          expireToLogin();
          return;
        }
        // 410 (expired/exhausted), 422 (wrong code / invalid phone), 409
        // (duplicate phone), 429 (rate limited) — surface the server's
        // readable detail inline in destructive colour.
        setError(err.message || 'That did not work. Please try again.');
        return;
      }
      setError('Could not reach the server. Check your connection and try again.');
    },
    [expireToLogin],
  );

  /** Send (or resend) a code. On the enrollment path it carries the entered
   *  phone; on the verified-phone path it carries none (the backend texts the
   *  number on file). Advances to the code step on success. */
  const runSendCode = useCallback(async (): Promise<void> => {
    setError(null);
    let phoneArg: string | undefined;
    if (phoneVerificationRequired) {
      const e164 = normalizeUsPhoneToE164(phone);
      if (!e164) {
        setError('Enter a valid US mobile number.');
        return;
      }
      phoneArg = e164;
    }
    setSending(true);
    try {
      const response = await sendTwoFactorCode(pendingToken, phoneArg);
      setLast4(response.phone_last4);
      setStep('code');
      startResendCooldown();
    } catch (err) {
      surfaceError(err);
    } finally {
      setSending(false);
    }
  }, [phone, phoneVerificationRequired, pendingToken, startResendCooldown, surfaceError]);

  // Verified-phone variant: fire the first code once on mount (the login
  // challenge does NOT auto-send — send-code is a separate endpoint). The
  // enrollment variant waits for the user to enter a number first.
  const didAutoSendRef = useRef(false);
  useEffect(() => {
    if (!phoneVerificationRequired && !didAutoSendRef.current) {
      didAutoSendRef.current = true;
      void runSendCode();
    }
    // Intentionally mount-only: params are stable route props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleVerify = useCallback(async (): Promise<void> => {
    setError(null);
    if (code.length !== CODE_LENGTH) {
      setError('Enter the 6-digit code we texted you.');
      return;
    }
    setVerifying(true);
    try {
      const response = await verifyTwoFactorCode(pendingToken, code, rememberDevice);
      // Persist the device-trust token only when the user opted in AND the
      // backend actually issued one (it omits it when remember_device=false).
      if (rememberDevice && response.device_token) {
        await setTrustedDeviceToken(response.device_token);
      }
      await signInWithTokens({
        accessToken: response.access_token,
        refreshToken: response.refresh_token,
        role: response.role as UserRole,
        name: response.name,
      });
      // Auth-state flip swaps the navigator to the authenticated stack; this
      // screen unmounts. No explicit navigation call needed.
    } catch (err) {
      surfaceError(err);
    } finally {
      setVerifying(false);
    }
  }, [code, pendingToken, rememberDevice, signInWithTokens, surfaceError]);

  const busy = sending || verifying;
  const maskedLast4 = last4 ?? '••••';

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
              <ShieldCheck size={24} color={colors.primary} />
            </View>

            {step === 'phone' ? (
              <>
                <Text style={styles.title}>Add your phone to secure your account</Text>
                <Text style={styles.subtitle}>
                  Compass texts a one-time code every time you sign in. Enter the
                  mobile number where we should send your codes.
                </Text>

                <TextInput
                  style={styles.input}
                  value={phone}
                  onChangeText={(v) => {
                    setPhone(v);
                    if (error) setError(null);
                  }}
                  placeholder="(555) 123-4567"
                  placeholderTextColor={colors.mutedForeground}
                  keyboardType="phone-pad"
                  editable={!busy}
                  accessibilityLabel="Mobile phone number"
                  onSubmitEditing={() => void runSendCode()}
                />

                {error && <Text style={styles.errorText}>{error}</Text>}

                <TouchableOpacity
                  style={[styles.primaryButton, busy && styles.primaryButtonDisabled]}
                  onPress={() => void runSendCode()}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel="Send code"
                >
                  {sending ? (
                    <ActivityIndicator color={colors.background} />
                  ) : (
                    <Text style={styles.primaryButtonText}>Send code</Text>
                  )}
                </TouchableOpacity>
              </>
            ) : (
              <>
                <Text style={styles.title}>Enter your sign-in code</Text>
                <Text style={styles.subtitle}>
                  Enter the 6-digit code we texted to{' '}
                  <Text style={styles.phoneHighlight}>•••{maskedLast4}</Text>.
                </Text>

                <TextInput
                  style={styles.input}
                  value={code}
                  onChangeText={(v) => {
                    setCode(v.replace(/\D/g, '').slice(0, CODE_LENGTH));
                    if (error) setError(null);
                  }}
                  placeholder="123456"
                  placeholderTextColor={colors.mutedForeground}
                  keyboardType="number-pad"
                  maxLength={CODE_LENGTH}
                  editable={!verifying}
                  accessibilityLabel="Verification code"
                  onSubmitEditing={() => void handleVerify()}
                />

                {/* Remember this device — default checked. */}
                <TouchableOpacity
                  style={styles.rememberRow}
                  onPress={() => setRememberDevice((v) => !v)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: rememberDevice }}
                  accessibilityLabel="Remember this device for 30 days"
                >
                  <View
                    style={[styles.checkbox, rememberDevice && styles.checkboxChecked]}
                  >
                    {rememberDevice && <Check size={14} color={colors.background} />}
                  </View>
                  <Text style={styles.rememberText}>Remember this device for 30 days</Text>
                </TouchableOpacity>

                {error && <Text style={styles.errorText}>{error}</Text>}

                <TouchableOpacity
                  style={[styles.primaryButton, verifying && styles.primaryButtonDisabled]}
                  onPress={() => void handleVerify()}
                  disabled={verifying}
                  accessibilityRole="button"
                  accessibilityLabel="Verify"
                >
                  {verifying ? (
                    <ActivityIndicator color={colors.background} />
                  ) : (
                    <Text style={styles.primaryButtonText}>Verify</Text>
                  )}
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.resendButton}
                  onPress={() => void runSendCode()}
                  disabled={resendDisabled || busy}
                  accessibilityRole="button"
                  accessibilityLabel="Resend code"
                >
                  <Text
                    style={[
                      styles.resendText,
                      (resendDisabled || busy) && styles.resendTextDisabled,
                    ]}
                  >
                    {resendDisabled ? 'Code sent — check your messages' : 'Resend code'}
                  </Text>
                </TouchableOpacity>
              </>
            )}
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
  rememberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: spacing.sm,
    marginTop: spacing.xs,
    marginBottom: spacing.sm,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  rememberText: {
    fontFamily: fonts.bodyMedium,
    fontSize: 14,
    color: colors.foreground,
    flexShrink: 1,
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
});

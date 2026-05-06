/**
 * PhoneVerificationModal — reusable SMS OTP challenge sheet.
 *
 * Usage:
 *   <PhoneVerificationModal
 *     visible={showModal}
 *     initialPhone="+1"                // pre-filled value
 *     onVerified={(phone) => { ... }}  // called with the confirmed E.164 number
 *     onClose={() => setShowModal(false)}
 *   />
 *
 * Flow:
 *   1. User types a US phone number (+1 is prepended for the MVP).
 *   2. Tap "Send Code" → POST /phone/start-verification → OTP input appears.
 *   3. User types the 6-digit code → POST /phone/confirm-verification.
 *   4. On success, onVerified is called with the verified E.164 number.
 *   5. Errors (invalid code, expired, too many attempts) show inline.
 *   6. "Resend code" becomes available after the code expires or on a
 *      delivery error; tapping it resets to step 1 (phone input).
 *
 * HIPAA: phone numbers are never logged by this component.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Phone, X, ShieldCheck, RefreshCw } from 'lucide-react-native';

import { api } from '../../api/client';
import { colors } from '../../theme/colors';
import { fonts } from '../../theme/typography';
import { radii, spacing } from '../../theme/spacing';

// ─── Types ────────────────────────────────────────────────────────────────────

interface StartVerificationResponse {
  expires_at: string;
}

interface ConfirmVerificationResponse {
  verified: boolean;
}

type VerificationStep = 'phone' | 'code';

export interface PhoneVerificationModalProps {
  /** Controls visibility. */
  visible: boolean;
  /**
   * Pre-populated phone value. Pass the user's current phone (if any) or
   * "+1" as the US-only MVP default. The user can edit it.
   */
  initialPhone?: string;
  /** Called with the verified E.164 phone string on success. */
  onVerified: (verifiedPhone: string) => void;
  /** Called when the user dismisses the modal without completing verification. */
  onClose: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalise a raw user-typed phone to E.164 for the US MVP.
 * Strips all non-digit characters and prepends +1 if missing.
 * Returns null when the result is not a plausible 10-digit US number.
 */
function toE164US(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  // Accept "10 digits" (no country code) or "11 digits starting with 1"
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }
  return null;
}

function formatCountdown(expiresAt: Date): string {
  const secondsLeft = Math.max(
    0,
    Math.floor((expiresAt.getTime() - Date.now()) / 1000),
  );
  if (secondsLeft <= 0) return 'Expired';
  const m = Math.floor(secondsLeft / 60);
  const s = secondsLeft % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function PhoneVerificationModal({
  visible,
  initialPhone = '+1',
  onVerified,
  onClose,
}: PhoneVerificationModalProps): React.JSX.Element {
  const [step, setStep] = useState<VerificationStep>('phone');
  const [phone, setPhone] = useState(initialPhone);
  const [code, setCode] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);
  const [countdown, setCountdown] = useState('');
  const [isExpired, setIsExpired] = useState(false);

  const codeInputRef = useRef<TextInput>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Reset to initial state whenever the modal opens.
  useEffect(() => {
    if (visible) {
      setStep('phone');
      setPhone(initialPhone);
      setCode('');
      setError(null);
      setExpiresAt(null);
      setIsExpired(false);
    }
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [visible, initialPhone]);

  // Countdown ticker: updates every second once we have an expiresAt.
  useEffect(() => {
    if (countdownRef.current) clearInterval(countdownRef.current);
    if (expiresAt === null) return;

    const tick = (): void => {
      const label = formatCountdown(expiresAt);
      setCountdown(label);
      if (label === 'Expired') {
        setIsExpired(true);
        if (countdownRef.current) clearInterval(countdownRef.current);
      }
    };

    tick();
    countdownRef.current = setInterval(tick, 1000);

    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [expiresAt]);

  // ── Actions ────────────────────────────────────────────────────────────────

  const handleSendCode = useCallback(async (): Promise<void> => {
    setError(null);
    const e164 = toE164US(phone);
    if (!e164) {
      setError('Please enter a valid 10-digit US phone number.');
      return;
    }

    setIsSending(true);
    try {
      const res = await api<StartVerificationResponse>(
        '/phone/start-verification',
        {
          method: 'POST',
          body: JSON.stringify({ phone: e164 }),
        },
      );
      setExpiresAt(new Date(res.expires_at));
      setIsExpired(false);
      setCode('');
      setStep('code');
      // Focus code input on next tick after the field mounts.
      setTimeout(() => codeInputRef.current?.focus(), 100);
    } catch (err: unknown) {
      const detail =
        err instanceof Error ? err.message : 'Could not send SMS. Please try again.';
      setError(detail);
    } finally {
      setIsSending(false);
    }
  }, [phone]);

  const handleConfirmCode = useCallback(async (): Promise<void> => {
    if (code.length !== 6) {
      setError('Enter the 6-digit code from your SMS.');
      return;
    }
    setError(null);

    const e164 = toE164US(phone);
    if (!e164) {
      setError('Invalid phone number. Please restart.');
      return;
    }

    setIsConfirming(true);
    try {
      const res = await api<ConfirmVerificationResponse>(
        '/phone/confirm-verification',
        {
          method: 'POST',
          body: JSON.stringify({ phone: e164, code }),
        },
      );
      if (res.verified) {
        onVerified(e164);
      }
    } catch (err: unknown) {
      const detail =
        err instanceof Error
          ? err.message
          : 'Incorrect code. Please try again.';
      setError(detail);
    } finally {
      setIsConfirming(false);
    }
  }, [code, phone, onVerified]);

  const handleResend = useCallback((): void => {
    setStep('phone');
    setCode('');
    setError(null);
    setExpiresAt(null);
    setIsExpired(false);
  }, []);

  // ── Derived state ──────────────────────────────────────────────────────────

  const e164Preview = toE164US(phone);
  const canSend = e164Preview !== null && !isSending;
  const canConfirm = code.length === 6 && !isConfirming && !isExpired;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable style={s.backdrop} onPress={onClose}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={s.sheet}
        >
          {/* Prevent backdrop tap from closing the inner sheet */}
          <Pressable onPress={() => {}}>
            {/* Handle bar */}
            <View style={s.handleBar} />

            {/* Header */}
            <View style={s.header}>
              <View style={s.headerIconBox}>
                <ShieldCheck size={20} color={colors.primary} />
              </View>
              <Text style={s.headerTitle}>Verify your phone</Text>
              <TouchableOpacity
                onPress={onClose}
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel="Close"
              >
                <X size={20} color={colors.mutedForeground} />
              </TouchableOpacity>
            </View>

            {/* Error banner */}
            {error !== null && (
              <View style={s.errorBanner}>
                <Text style={s.errorText}>{error}</Text>
              </View>
            )}

            {step === 'phone' ? (
              /* ── Step 1: phone input ── */
              <View style={s.body}>
                <Text style={s.bodyLabel}>
                  Enter your US mobile number. We'll send a 6-digit code.
                </Text>

                <View style={s.inputRow}>
                  <View style={s.inputIconBox}>
                    <Phone size={18} color={colors.mutedForeground} />
                  </View>
                  <TextInput
                    value={phone}
                    onChangeText={setPhone}
                    placeholder="+1 (555) 000-0000"
                    placeholderTextColor={colors.mutedForeground}
                    keyboardType="phone-pad"
                    autoComplete="tel"
                    style={s.input}
                    accessibilityLabel="Phone number"
                    returnKeyType="send"
                    onSubmitEditing={handleSendCode}
                  />
                </View>

                <Pressable
                  onPress={handleSendCode}
                  disabled={!canSend}
                  style={({ pressed }) => [
                    s.primaryBtn,
                    !canSend && s.primaryBtnDisabled,
                    pressed && canSend && s.primaryBtnPressed,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="Send verification code"
                >
                  {isSending ? (
                    <ActivityIndicator color="#FFFFFF" />
                  ) : (
                    <Text style={s.primaryBtnText}>Send code</Text>
                  )}
                </Pressable>
              </View>
            ) : (
              /* ── Step 2: OTP input ── */
              <View style={s.body}>
                <Text style={s.bodyLabel}>
                  Enter the 6-digit code sent to{' '}
                  <Text style={s.boldText}>{e164Preview ?? phone}</Text>.
                </Text>

                {/* Countdown */}
                <Text
                  style={[
                    s.countdownText,
                    isExpired && s.countdownExpired,
                  ]}
                >
                  {isExpired ? 'Code expired' : `Expires in ${countdown}`}
                </Text>

                {/* OTP input */}
                <TextInput
                  ref={codeInputRef}
                  value={code}
                  onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
                  placeholder="123456"
                  placeholderTextColor={colors.mutedForeground}
                  keyboardType="number-pad"
                  maxLength={6}
                  style={[s.input, s.codeInput]}
                  accessibilityLabel="Verification code"
                  returnKeyType="done"
                  onSubmitEditing={handleConfirmCode}
                />

                <Pressable
                  onPress={handleConfirmCode}
                  disabled={!canConfirm}
                  style={({ pressed }) => [
                    s.primaryBtn,
                    !canConfirm && s.primaryBtnDisabled,
                    pressed && canConfirm && s.primaryBtnPressed,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="Confirm code"
                >
                  {isConfirming ? (
                    <ActivityIndicator color="#FFFFFF" />
                  ) : (
                    <Text style={s.primaryBtnText}>Confirm code</Text>
                  )}
                </Pressable>

                {/* Resend link */}
                <TouchableOpacity
                  onPress={handleResend}
                  style={s.resendRow}
                  accessibilityRole="button"
                  accessibilityLabel="Resend verification code"
                >
                  <RefreshCw size={14} color={colors.primary} />
                  <Text style={s.resendText}>Resend code</Text>
                </TouchableOpacity>
              </View>
            )}
          </Pressable>
        </KeyboardAvoidingView>
      </Pressable>
    </Modal>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    paddingBottom: Platform.OS === 'ios' ? 34 : 24,
  },
  handleBar: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    alignSelf: 'center',
    marginTop: 12,
    marginBottom: 4,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerIconBox: {
    width: 36,
    height: 36,
    borderRadius: radii.md,
    backgroundColor: `${colors.primary}18`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    flex: 1,
    fontSize: 16,
    fontFamily: fonts.displaySemibold,
    color: colors.foreground,
  },
  errorBanner: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    backgroundColor: '#FEE2E2',
    borderColor: '#FCA5A5',
    borderWidth: 1,
    borderRadius: radii.md,
    padding: 10,
  },
  errorText: {
    fontSize: 13,
    fontFamily: fonts.body,
    color: '#B91C1C',
  },
  body: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    gap: spacing.sm,
  },
  bodyLabel: {
    fontSize: 14,
    fontFamily: fonts.body,
    color: colors.mutedForeground,
    lineHeight: 20,
  },
  boldText: {
    fontFamily: fonts.bodySemibold,
    color: colors.foreground,
  },
  countdownText: {
    fontSize: 12,
    fontFamily: fonts.body,
    color: colors.mutedForeground,
  },
  countdownExpired: {
    color: '#DC2626',
  },
  inputRow: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'center',
  },
  inputIconBox: {
    position: 'absolute',
    left: 12,
    zIndex: 1,
  },
  input: {
    flex: 1,
    height: 44,
    paddingLeft: 38,
    paddingRight: 12,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    fontSize: 15,
    fontFamily: fonts.body,
    color: colors.foreground,
  },
  codeInput: {
    paddingLeft: 16,
    letterSpacing: 8,
    fontFamily: fonts.bodySemibold,
    fontSize: 20,
    textAlign: 'center',
  },
  primaryBtn: {
    height: 48,
    borderRadius: radii.md,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.xs,
  },
  primaryBtnDisabled: {
    backgroundColor: `${colors.primary}60`,
  },
  primaryBtnPressed: {
    opacity: 0.85,
  },
  primaryBtnText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontFamily: fonts.bodySemibold,
  },
  resendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: spacing.sm,
  },
  resendText: {
    fontSize: 13,
    fontFamily: fonts.bodySemibold,
    color: colors.primary,
  },
});

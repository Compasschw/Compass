/**
 * DeleteAccountModal — three-step destructive-action flow for account deletion.
 *
 * Step 1 (warning):  Displays a plain-language HIPAA disclosure about what is
 *                    deleted and what is retained for 6 years.
 * Step 2 (password): User enters their current password.
 * Step 3 (confirm):  User types "DELETE" to confirm — mirrors the App Store /
 *                    Google Play requirement for explicit user action.
 *
 * On successful confirmation the modal calls the `onConfirm` callback which
 * is responsible for making the API call, clearing tokens, and routing away.
 * The modal itself is stateless with respect to the API call — all async
 * state is managed by the parent screen via the `useDeleteAccount` hook.
 */

import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { AlertTriangle, ChevronRight, Lock, Trash2, X } from 'lucide-react-native';

import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DeleteAccountModalProps {
  /** Controls modal visibility. */
  visible: boolean;
  /** Called when the user taps the X or "Cancel". */
  onClose: () => void;
  /**
   * Called with the confirmed password once the user completes all three steps.
   * The parent screen is responsible for making the API call and handling errors.
   */
  onConfirm: (password: string) => Promise<void>;
  /** Error message to display on step 2/3 (e.g. "Incorrect password"). */
  errorMessage?: string | null;
}

type Step = 'warning' | 'password' | 'confirm';

const CONFIRM_WORD = 'DELETE';

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Multi-step account-deletion modal satisfying Apple App Store §5.1.1 and
 * Google Play's "in-app account deletion with explicit user action" policy.
 */
export function DeleteAccountModal({
  visible,
  onClose,
  onConfirm,
  errorMessage,
}: DeleteAccountModalProps): React.JSX.Element {
  const [step, setStep] = useState<Step>('warning');
  const [password, setPassword] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Reset internal state whenever the modal is opened.
  const handleClose = useCallback(() => {
    setStep('warning');
    setPassword('');
    setConfirmText('');
    setIsSubmitting(false);
    onClose();
  }, [onClose]);

  const handleNextFromWarning = useCallback(() => {
    setStep('password');
  }, []);

  const handleNextFromPassword = useCallback(() => {
    if (password.trim().length === 0) return;
    setStep('confirm');
  }, [password]);

  const handleSubmit = useCallback(async () => {
    if (confirmText !== CONFIRM_WORD) return;
    setIsSubmitting(true);
    try {
      await onConfirm(password);
      // Parent takes over routing — modal will be unmounted.
    } catch {
      // Error is surfaced via the `errorMessage` prop from the parent.
    } finally {
      setIsSubmitting(false);
    }
  }, [confirmText, onConfirm, password]);

  const confirmButtonDisabled =
    confirmText !== CONFIRM_WORD || isSubmitting;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={handleClose}
      statusBarTranslucent
    >
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          {/* ── Close button ── */}
          <TouchableOpacity
            style={styles.closeButton}
            onPress={handleClose}
            accessibilityRole="button"
            accessibilityLabel="Close"
            disabled={isSubmitting}
          >
            <X size={20} color={colors.mutedForeground} />
          </TouchableOpacity>

          {/* ── Step 1: Warning ──────────────────────────────────────────── */}
          {step === 'warning' && (
            <>
              <View style={styles.iconContainer}>
                <AlertTriangle size={32} color={colors.destructive} />
              </View>

              <Text style={styles.title}>Delete Your Account?</Text>
              <Text style={styles.body}>
                This action{' '}
                <Text style={styles.emphasis}>cannot be undone.</Text>
                {' '}Your account will be permanently deactivated and all
                personal information will be removed.
              </Text>

              <View style={styles.hipaaBox}>
                <Text style={styles.hipaaTitle}>HIPAA Retention Notice</Text>
                <Text style={styles.hipaaBody}>
                  Per federal law (45 CFR §164.530), your service history,
                  session records, and billing claims are retained for{' '}
                  <Text style={styles.emphasis}>6 years</Text> for audit
                  and Medi-Cal claim purposes. This data is anonymised and
                  cannot be used to identify you.
                </Text>
              </View>

              <TouchableOpacity
                style={styles.destructiveButton}
                onPress={handleNextFromWarning}
                accessibilityRole="button"
                accessibilityLabel="Continue to account deletion"
              >
                <Text style={styles.destructiveButtonText}>
                  I Understand — Continue
                </Text>
                <ChevronRight size={16} color={colors.destructiveForeground} />
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.cancelButton}
                onPress={handleClose}
                accessibilityRole="button"
                accessibilityLabel="Cancel account deletion"
              >
                <Text style={styles.cancelButtonText}>Keep My Account</Text>
              </TouchableOpacity>
            </>
          )}

          {/* ── Step 2: Password ─────────────────────────────────────────── */}
          {step === 'password' && (
            <>
              <View style={styles.iconContainer}>
                <Lock size={32} color={colors.destructive} />
              </View>

              <Text style={styles.title}>Confirm Your Password</Text>
              <Text style={styles.body}>
                Enter your current password to verify your identity before
                deleting your account.
              </Text>

              <View style={styles.fieldContainer}>
                <Text style={styles.fieldLabel}>Current Password</Text>
                <TextInput
                  style={[
                    styles.textInput,
                    errorMessage != null && styles.textInputError,
                  ]}
                  value={password}
                  onChangeText={setPassword}
                  placeholder="Enter your password"
                  placeholderTextColor={colors.mutedForeground}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  accessibilityLabel="Current password"
                  editable={!isSubmitting}
                />
                {errorMessage != null && (
                  <Text style={styles.errorText}>{errorMessage}</Text>
                )}
              </View>

              <TouchableOpacity
                style={[
                  styles.destructiveButton,
                  password.trim().length === 0 && styles.buttonDisabled,
                ]}
                onPress={handleNextFromPassword}
                disabled={password.trim().length === 0}
                accessibilityRole="button"
                accessibilityLabel="Continue to final confirmation"
              >
                <Text style={styles.destructiveButtonText}>Continue</Text>
                <ChevronRight size={16} color={colors.destructiveForeground} />
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.cancelButton}
                onPress={handleClose}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
                disabled={isSubmitting}
              >
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>
            </>
          )}

          {/* ── Step 3: Confirm ──────────────────────────────────────────── */}
          {step === 'confirm' && (
            <>
              <View style={styles.iconContainer}>
                <Trash2 size={32} color={colors.destructive} />
              </View>

              <Text style={styles.title}>Final Confirmation</Text>
              <Text style={styles.body}>
                Type{' '}
                <Text style={[styles.emphasis, { color: colors.destructive }]}>
                  {CONFIRM_WORD}
                </Text>
                {' '}in the field below to permanently delete your account.
              </Text>

              <View style={styles.fieldContainer}>
                <Text style={styles.fieldLabel}>Type DELETE to confirm</Text>
                <TextInput
                  style={[
                    styles.textInput,
                    confirmText.length > 0 &&
                      confirmText !== CONFIRM_WORD &&
                      styles.textInputError,
                  ]}
                  value={confirmText}
                  onChangeText={setConfirmText}
                  placeholder={CONFIRM_WORD}
                  placeholderTextColor={colors.mutedForeground}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  accessibilityLabel={`Type ${CONFIRM_WORD} to confirm deletion`}
                  editable={!isSubmitting}
                />
              </View>

              {errorMessage != null && (
                <Text style={[styles.errorText, { marginBottom: 12 }]}>
                  {errorMessage}
                </Text>
              )}

              <TouchableOpacity
                style={[
                  styles.destructiveButton,
                  confirmButtonDisabled && styles.buttonDisabled,
                ]}
                onPress={() => void handleSubmit()}
                disabled={confirmButtonDisabled}
                accessibilityRole="button"
                accessibilityLabel="Permanently delete account"
              >
                {isSubmitting ? (
                  <ActivityIndicator size="small" color={colors.destructiveForeground} />
                ) : (
                  <>
                    <Trash2 size={16} color={colors.destructiveForeground} />
                    <Text style={styles.destructiveButtonText}>
                      Delete My Account
                    </Text>
                  </>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.cancelButton}
                onPress={handleClose}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
                disabled={isSubmitting}
              >
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.background,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    paddingBottom: 40,
  },
  closeButton: {
    alignSelf: 'flex-end',
    padding: 4,
    marginBottom: 8,
  },
  iconContainer: {
    alignSelf: 'center',
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.destructive + '15',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  title: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 20,
    lineHeight: 26,
    color: colors.foreground,
    textAlign: 'center',
    marginBottom: 12,
  },
  body: {
    ...typography.bodyMd,
    color: colors.mutedForeground,
    textAlign: 'center',
    marginBottom: 20,
    lineHeight: 22,
  },
  emphasis: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    color: colors.foreground,
  },
  hipaaBox: {
    backgroundColor: colors.muted,
    borderRadius: 12,
    padding: 14,
    marginBottom: 24,
    borderWidth: 1,
    borderColor: colors.border,
  },
  hipaaTitle: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: colors.mutedForeground,
    marginBottom: 6,
  },
  hipaaBody: {
    ...typography.bodySm,
    color: colors.mutedForeground,
    lineHeight: 20,
  },
  fieldContainer: {
    marginBottom: 20,
  },
  fieldLabel: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: colors.mutedForeground,
    marginBottom: 8,
  },
  textInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: '#FFFFFF',
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    lineHeight: 20,
    color: colors.foreground,
  },
  textInputError: {
    borderColor: colors.destructive,
  },
  errorText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: colors.destructive,
    marginTop: 6,
  },
  destructiveButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: colors.destructive,
    borderRadius: 14,
    paddingVertical: 16,
    marginBottom: 12,
  },
  destructiveButtonText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 16,
    color: colors.destructiveForeground,
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  cancelButton: {
    alignItems: 'center',
    paddingVertical: 14,
  },
  cancelButtonText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 15,
    color: colors.mutedForeground,
  },
});

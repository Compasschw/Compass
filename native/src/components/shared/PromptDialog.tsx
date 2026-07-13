/**
 * PromptDialog — reusable on-brand modal for collecting one or more labeled
 * text inputs with a Confirm / (optional) Cancel action.
 *
 * Built for Epic G2's mandatory first-login password change (see
 * `MemberHomeScreen.tsx`), but deliberately generic — nothing here is
 * password-specific. The caller supplies an arbitrary list of `fields`
 * (label + key + input behavior) and owns the values/validation, so this
 * same component is meant to be reused for the planned B2/B3 rating-prompt
 * work later (a "star" field type can be added to `PromptDialogField` at
 * that point without touching this component's shape or any existing
 * caller).
 *
 * Visual language matches `AppDialogProvider` (src/components/shared/
 * AppDialogProvider.tsx) — the same `showAlert()` dialog every other
 * in-app popup uses: `rgba(15, 23, 42, 0.45)` scrim, white card, emerald
 * primary button, PlusJakartaSans type. Rendered via RN's `Modal` (only
 * while `visible`), matching the same web-portal-stacking behavior
 * AppDialogProvider documents.
 *
 * Usage:
 *   <PromptDialog
 *     visible={mustChangePassword}
 *     title="Set your password"
 *     message="Please set a new password before continuing."
 *     fields={[
 *       { key: 'currentPassword', label: 'Current password', secureTextEntry: true },
 *       { key: 'newPassword', label: 'New password', secureTextEntry: true },
 *       { key: 'confirmPassword', label: 'Confirm new password', secureTextEntry: true },
 *     ]}
 *     values={values}
 *     onChangeValue={(key, value) => setValues((prev) => ({ ...prev, [key]: value }))}
 *     onConfirm={handleSubmit}
 *     confirmLabel="Update password"
 *     submitting={isPending}
 *     errorText={error}
 *   />
 *
 * Omitting `onCancel` renders no Cancel button and ignores the hardware
 * back / backdrop dismiss request — use this for a mandatory gate (like the
 * first-login password change, which the member cannot skip). Pass
 * `onCancel` for a dismissable prompt.
 */
import React from 'react';
import {
  ActivityIndicator,
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type KeyboardTypeOptions,
  type TextInputProps,
} from 'react-native';

import { colors as tokens, radius, shadows, spacing } from '../../theme/tokens';

/** One labeled input rendered inside the dialog. */
export interface PromptDialogField {
  /** Stable key used to read/write this field's value in `values`/`onChangeValue`. */
  key: string;
  label: string;
  placeholder?: string;
  /** Inline validation/error message shown directly under this field. */
  errorText?: string | null;
  secureTextEntry?: boolean;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  autoComplete?: TextInputProps['autoComplete'];
  keyboardType?: KeyboardTypeOptions;
}

export interface PromptDialogProps {
  visible: boolean;
  title: string;
  message?: string;
  fields: PromptDialogField[];
  /** Current value for each field, keyed by `PromptDialogField.key`. */
  values: Record<string, string>;
  onChangeValue: (key: string, value: string) => void;
  onConfirm: () => void;
  /** Omit to render a non-dismissable (mandatory) prompt — no Cancel button. */
  onCancel?: () => void;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Disables inputs/buttons and shows a spinner on the confirm button. */
  submitting?: boolean;
  /** Form-level error banner shown above the action buttons. */
  errorText?: string | null;
  testID?: string;
}

export function PromptDialog({
  visible,
  title,
  message,
  fields,
  values,
  onChangeValue,
  onConfirm,
  onCancel,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  submitting = false,
  errorText = null,
  testID,
}: PromptDialogProps): React.JSX.Element | null {
  if (!visible) return null;

  const handleRequestClose = () => {
    if (onCancel && !submitting) onCancel();
    // No onCancel supplied → this is a mandatory prompt; swallow the
    // dismiss request (hardware back / Android back gesture / Esc).
  };

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      onRequestClose={handleRequestClose}
      accessible
      accessibilityViewIsModal
      testID={testID}
    >
      <View style={styles.overlay} accessibilityViewIsModal accessibilityRole="alert">
        <View style={styles.card}>
          <Text style={styles.title}>{title}</Text>
          {message ? <Text style={styles.message}>{message}</Text> : null}

          <View style={styles.fields}>
            {fields.map((field) => (
              <View key={field.key} style={styles.field}>
                <Text style={styles.fieldLabel}>{field.label}</Text>
                <TextInput
                  style={[
                    styles.input,
                    field.errorText ? styles.inputError : null,
                  ]}
                  value={values[field.key] ?? ''}
                  onChangeText={(text) => onChangeValue(field.key, text)}
                  placeholder={field.placeholder}
                  placeholderTextColor={tokens.textSecondary}
                  secureTextEntry={field.secureTextEntry}
                  autoCapitalize={field.autoCapitalize ?? 'none'}
                  autoCorrect={false}
                  autoComplete={field.autoComplete}
                  keyboardType={field.keyboardType}
                  editable={!submitting}
                  accessibilityLabel={field.label}
                />
                {field.errorText ? (
                  <Text style={styles.fieldErrorText}>{field.errorText}</Text>
                ) : null}
              </View>
            ))}
          </View>

          {errorText ? <Text style={styles.errorText}>{errorText}</Text> : null}

          <View style={styles.buttonRow}>
            {onCancel ? (
              <TouchableOpacity
                style={[styles.button, styles.cancelButton]}
                onPress={onCancel}
                disabled={submitting}
                accessibilityRole="button"
                accessibilityLabel={cancelLabel}
              >
                <Text style={styles.cancelButtonText}>{cancelLabel}</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity
              style={[
                styles.button,
                styles.confirmButton,
                submitting && styles.buttonDisabled,
              ]}
              onPress={onConfirm}
              disabled={submitting}
              accessibilityRole="button"
              accessibilityLabel={confirmLabel}
            >
              {submitting ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Text style={styles.confirmButtonText}>{confirmLabel}</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: tokens.cardBg,
    borderRadius: radius.lg,
    padding: spacing.xl,
    gap: spacing.md,
    ...shadows.card,
  },
  title: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 17,
    color: tokens.textPrimary,
  },
  message: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    lineHeight: 20,
    color: tokens.textSecondary,
  },
  fields: {
    gap: spacing.md,
  },
  field: {
    gap: spacing.xs,
  },
  fieldLabel: {
    fontFamily: 'PlusJakartaSans_500Medium',
    fontSize: 13,
    color: tokens.textSecondary,
  },
  input: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: radius.md,
    paddingVertical: 11,
    paddingHorizontal: 14,
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 15,
    color: tokens.textPrimary,
    backgroundColor: '#FFFFFF',
  },
  inputError: {
    borderColor: tokens.red700,
  },
  fieldErrorText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: tokens.red700,
  },
  errorText: {
    fontFamily: 'PlusJakartaSans_500Medium',
    fontSize: 13,
    color: tokens.red700,
  },
  buttonRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  button: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 96,
  },
  confirmButton: {
    backgroundColor: tokens.primary,
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  confirmButtonText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#FFFFFF',
  },
  cancelButton: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  cancelButtonText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: tokens.textSecondary,
  },
});

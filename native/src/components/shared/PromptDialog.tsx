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
 * Epic B3 added optional `maxLength` + `multiline` per-field props (and a
 * live "N/max" counter rendered under the field when `maxLength` is set) for
 * the post-close member review capture — the CHW close flow's 120-char
 * feedback field. Both are additive/opt-in: fields that omit them render
 * exactly as before (single-line, uncapped), so Epic G2's password prompt
 * usage and tests are unaffected.
 *
 * Epic B2 added an opt-in `type: 'star'` field variant (with `maxStars`,
 * default 5) for the post-session rating prompt — a row of tappable
 * `lucide-react-native` Star icons rendered instead of a TextInput. The
 * selected count is still stored as a STRING in `values`/`onChangeValue`
 * (e.g. `'4'`) to keep the component's single value contract; callers
 * `Number(...)` it back out. Each star has its own accessibilityRole="radio"
 * + accessibilityLabel ("N stars") inside an accessibilityRole="radiogroup"
 * wrapper, and responds to a plain press (mouse click / tap / Enter-on-focus
 * via the underlying Pressable-in-TouchableOpacity semantics on web) — no
 * drag gesture required. Fields that omit `type` (every existing G2/B3
 * caller) are completely unaffected — they still render as a TextInput.
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
import { Star } from 'lucide-react-native';

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
  /** Renders a taller multiline input (e.g. free-text feedback). Additive —
   *  omit for the default single-line input. */
  multiline?: boolean;
  /** Caps input length and renders a live "N/max" counter under the field.
   *  Additive — omit for an uncapped field with no counter (Epic G2's
   *  password fields are unaffected). */
  maxLength?: number;
  /**
   * Epic B2: renders a 1-5 tappable star-rating row instead of a text
   * input when set to `'star'`. Additive/opt-in — omit (the default) for
   * every existing text-field usage (G2 password prompt, B3 closure-review
   * text field), which render exactly as before.
   *
   * The field's value in `values`/`onChangeValue` is still a string (the
   * component's shared value contract), holding the selected star count
   * as `''` (unset) or `'1'`..`'5'`. Callers coerce with `Number(...)`
   * when reading it back out for submission.
   */
  type?: 'text' | 'star';
  /** Star count for the `'star'` field type. Defaults to 5. */
  maxStars?: number;
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
            {fields.map((field) => {
              const currentValue = values[field.key] ?? '';

              if (field.type === 'star') {
                const maxStars = field.maxStars ?? 5;
                const selected = Number(currentValue) || 0;
                return (
                  <View key={field.key} style={styles.field}>
                    <Text style={styles.fieldLabel}>{field.label}</Text>
                    <View
                      style={styles.starRow}
                      accessibilityRole="radiogroup"
                      accessibilityLabel={field.label}
                    >
                      {Array.from({ length: maxStars }, (_, idx) => {
                        const starValue = idx + 1;
                        const filled = starValue <= selected;
                        return (
                          <TouchableOpacity
                            key={starValue}
                            onPress={() => onChangeValue(field.key, String(starValue))}
                            disabled={submitting}
                            style={styles.starButton}
                            accessibilityRole="radio"
                            accessibilityState={{ checked: filled, disabled: submitting }}
                            accessibilityLabel={`${starValue} star${starValue === 1 ? '' : 's'}`}
                            testID={`${testID ?? 'prompt-dialog'}-star-${starValue}`}
                          >
                            <Star
                              size={32}
                              color={filled ? tokens.amber700 : tokens.textSecondary}
                              fill={filled ? tokens.amber700 : 'transparent'}
                              strokeWidth={1.5}
                            />
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                    {field.errorText ? (
                      <Text style={styles.fieldErrorText}>{field.errorText}</Text>
                    ) : null}
                  </View>
                );
              }

              return (
                <View key={field.key} style={styles.field}>
                  <Text style={styles.fieldLabel}>{field.label}</Text>
                  <TextInput
                    style={[
                      styles.input,
                      field.multiline ? styles.inputMultiline : null,
                      field.errorText ? styles.inputError : null,
                    ]}
                    value={currentValue}
                    onChangeText={(text) => onChangeValue(field.key, text)}
                    placeholder={field.placeholder}
                    placeholderTextColor={tokens.textSecondary}
                    secureTextEntry={field.secureTextEntry}
                    autoCapitalize={field.autoCapitalize ?? 'none'}
                    autoCorrect={false}
                    autoComplete={field.autoComplete}
                    keyboardType={field.keyboardType}
                    editable={!submitting}
                    multiline={field.multiline}
                    maxLength={field.maxLength}
                    accessibilityLabel={field.label}
                  />
                  {field.maxLength ? (
                    <Text style={styles.fieldCounter}>
                      {`${currentValue.length}/${field.maxLength}`}
                    </Text>
                  ) : null}
                  {field.errorText ? (
                    <Text style={styles.fieldErrorText}>{field.errorText}</Text>
                  ) : null}
                </View>
              );
            })}
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
  inputMultiline: {
    minHeight: 80,
    paddingTop: 11,
    textAlignVertical: 'top',
  },
  inputError: {
    borderColor: tokens.red700,
  },
  // ── Epic B2: star-rating field variant ──────────────────────────────────
  starRow: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  starButton: {
    padding: 4,
  },
  fieldCounter: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 11,
    color: tokens.textSecondary,
    textAlign: 'right',
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

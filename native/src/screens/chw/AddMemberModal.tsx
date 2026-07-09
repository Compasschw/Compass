/**
 * AddMemberModal — CHW-facing "Add New Member" onboarding dialog.
 *
 * Opened from the CHW Dashboard header ("Add New Member"). Collects the four
 * fields the backend needs to stand up a brand-new member account that is
 * immediately wired to the calling CHW:
 *   - Full name (first + last — the backend rejects a single token)
 *   - Login email
 *   - Phone (optional)
 *   - Temporary password the CHW shares with the member out-of-band
 *
 * On success the member appears in the CHW's roster (the hook invalidates it)
 * and the CHW can message / schedule / start journeys immediately.
 *
 * Styling mirrors CloseMemberModal (emerald header, centered card, full-screen
 * dimmed backdrop) so the dialog reads consistently across the CHW surface. A
 * React Native <Modal> is used on both web and native — on web it portals to
 * the document root, escaping any transformed ancestor.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Pressable,
  ActivityIndicator,
  StyleSheet,
  Platform,
  type ViewStyle,
  type TextStyle,
} from 'react-native';

import { colors as tokens } from '../../theme/tokens';
import { ApiError } from '../../api/client';
import { useCreateChwMember, type CreatedChwMember } from '../../hooks/useApiQueries';

interface AddMemberModalProps {
  visible: boolean;
  onClose: () => void;
  /** Fired after a member is successfully created (e.g. to surface a toast). */
  onCreated?: (member: CreatedChwMember) => void;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

/**
 * Local, synchronous form validation. Returns the first user-facing error
 * message, or null when the form is submittable. Mirrors the backend contract
 * (first + last name, valid email, ≥8-char password) so the CHW gets instant
 * feedback before the round-trip.
 */
function validate(name: string, email: string, password: string): string | null {
  const nameTokens = name.trim().split(/\s+/).filter(Boolean);
  if (nameTokens.length < 2) {
    return 'Enter the member’s first and last name.';
  }
  if (!EMAIL_RE.test(email.trim())) {
    return 'Enter a valid email address.';
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Temporary password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

export function AddMemberModal({
  visible,
  onClose,
  onCreated,
}: AddMemberModalProps): React.JSX.Element {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const createMember = useCreateChwMember();

  // Reset the form each time the modal opens so stale input never lingers.
  useEffect(() => {
    if (visible) {
      setName('');
      setEmail('');
      setPhone('');
      setPassword('');
      setError(null);
    }
  }, [visible]);

  const isSubmitting = createMember.isPending;

  const clientError = useMemo(
    () => validate(name, email, password),
    [name, email, password],
  );
  const canSubmit = clientError === null && !isSubmitting;

  const handleSubmit = (): void => {
    const validationError = validate(name, email, password);
    if (validationError !== null) {
      setError(validationError);
      return;
    }
    setError(null);
    createMember.mutate(
      {
        name: name.trim(),
        email: email.trim(),
        phone: phone.trim() ? phone.trim() : undefined,
        tempPassword: password,
      },
      {
        onSuccess: (member) => {
          onCreated?.(member);
          onClose();
        },
        onError: (err: unknown) => {
          // Surface the backend's duplicate-email 400 (and any other error)
          // inline next to the form rather than as a disruptive alert.
          if (err instanceof ApiError && err.status === 400) {
            setError('That email is already registered.');
            return;
          }
          const message =
            err instanceof Error && err.message
              ? err.message
              : 'Could not add the member. Please try again.';
          setError(message);
        },
      },
    );
  };

  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent
      onRequestClose={onClose}
      accessibilityViewIsModal
    >
      <View style={styles.overlay}>
        <Pressable
          style={styles.backdrop}
          onPress={isSubmitting ? undefined : onClose}
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
        />
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.headerTitle}>Add New Member</Text>
          </View>

          <View style={styles.content}>
            <Text style={styles.subtitle}>
              Create an account for a member and connect them to you. You’ll
              share the temporary password with them so they can log in.
            </Text>

            <View style={styles.field}>
              <Text style={styles.fieldLabel}>Full name</Text>
              <TextInput
                style={styles.input}
                value={name}
                onChangeText={setName}
                placeholder="Jordan Rivera"
                placeholderTextColor={tokens.textSecondary}
                autoCapitalize="words"
                editable={!isSubmitting}
                accessibilityLabel="Member full name"
                returnKeyType="next"
              />
            </View>

            <View style={styles.field}>
              <Text style={styles.fieldLabel}>Email</Text>
              <TextInput
                style={styles.input}
                value={email}
                onChangeText={setEmail}
                placeholder="member@example.com"
                placeholderTextColor={tokens.textSecondary}
                autoCapitalize="none"
                keyboardType="email-address"
                autoComplete="email"
                editable={!isSubmitting}
                accessibilityLabel="Member email"
                returnKeyType="next"
              />
            </View>

            <View style={styles.field}>
              <Text style={styles.fieldLabel}>
                Phone <Text style={styles.optional}>(optional)</Text>
              </Text>
              <TextInput
                style={styles.input}
                value={phone}
                onChangeText={setPhone}
                placeholder="(310) 555-0142"
                placeholderTextColor={tokens.textSecondary}
                keyboardType="phone-pad"
                editable={!isSubmitting}
                accessibilityLabel="Member phone"
              />
            </View>

            <View style={styles.field}>
              <Text style={styles.fieldLabel}>Temporary password</Text>
              <TextInput
                style={styles.input}
                value={password}
                onChangeText={setPassword}
                placeholder="At least 8 characters"
                placeholderTextColor={tokens.textSecondary}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!isSubmitting}
                accessibilityLabel="Temporary password"
                returnKeyType="done"
                onSubmitEditing={canSubmit ? handleSubmit : undefined}
              />
              <Text style={styles.hint}>
                Share this with the member — they can change it after signing in.
              </Text>
            </View>

            {error !== null && (
              <Text style={styles.errorText} accessibilityLiveRegion="polite">
                {error}
              </Text>
            )}

            <View style={styles.actions}>
              <TouchableOpacity
                style={[styles.actionBtn, styles.cancelBtn]}
                onPress={onClose}
                disabled={isSubmitting}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
              >
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.actionBtn,
                  styles.confirmBtn,
                  !canSubmit && styles.confirmBtnDisabled,
                ]}
                onPress={handleSubmit}
                disabled={!canSubmit}
                accessibilityRole="button"
                accessibilityLabel="Add member"
                accessibilityState={{ disabled: !canSubmit }}
              >
                {isSubmitting ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Text style={styles.confirmBtnText}>Add Member</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  } as ViewStyle,
  backdrop: {
    position: 'absolute',
    inset: 0,
    backgroundColor: 'rgba(17,24,39,0.55)',
  } as ViewStyle,
  card: {
    width: '100%',
    maxWidth: 460,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    overflow: 'hidden',
    zIndex: 1,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.25,
    shadowRadius: 32,
    elevation: 12,
  } as ViewStyle,
  header: {
    backgroundColor: tokens.emerald700,
    paddingVertical: 16,
    paddingHorizontal: 20,
  } as ViewStyle,
  headerTitle: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 18,
    color: '#FFFFFF',
  } as TextStyle,
  content: {
    padding: 20,
    gap: 14,
  } as ViewStyle,
  subtitle: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    lineHeight: 19,
    color: tokens.textSecondary,
  } as TextStyle,
  field: {
    gap: 6,
  } as ViewStyle,
  fieldLabel: {
    fontFamily: 'PlusJakartaSans_500Medium',
    fontSize: 13,
    color: tokens.textSecondary,
  } as TextStyle,
  optional: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: tokens.textSecondary,
  } as TextStyle,
  input: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 10,
    paddingVertical: Platform.OS === 'web' ? 10 : 11,
    paddingHorizontal: 14,
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 15,
    color: tokens.textPrimary,
    backgroundColor: '#FFFFFF',
  } as TextStyle,
  hint: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: tokens.textSecondary,
  } as TextStyle,
  errorText: {
    fontFamily: 'PlusJakartaSans_500Medium',
    fontSize: 13,
    color: '#DC2626',
  } as TextStyle,
  actions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 4,
  } as ViewStyle,
  actionBtn: {
    flex: 1,
    height: 44,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  cancelBtn: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#FFFFFF',
  } as ViewStyle,
  cancelBtnText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 15,
    color: tokens.textPrimary,
  } as TextStyle,
  confirmBtn: {
    backgroundColor: tokens.emerald700,
  } as ViewStyle,
  confirmBtnDisabled: {
    opacity: 0.5,
  } as ViewStyle,
  confirmBtnText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 15,
    color: '#FFFFFF',
  } as TextStyle,
});

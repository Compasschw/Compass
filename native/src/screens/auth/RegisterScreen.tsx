/**
 * RegisterScreen — self-service account creation for new CHWs and members.
 *
 * Single-step form: role chooser, then name + email + password + ZIP + phone.
 * On submit, calls AuthContext.register which POSTs /auth/register and stores
 * the JWT pair. The root navigator picks up the resulting role and routes the
 * user to their respective tab navigator (CHW → CHWTabNavigator with the
 * intake banner, Member → MemberTabNavigator).
 *
 * Self sign-up was previously suppressed on the LoginScreen and routed to the
 * waitlist instead. That gate has been lifted for the v1 launch — Jemal and
 * JT need to be able to onboard as real users, and waitlist mode does not
 * provision accounts. CHWs still complete the rich intake questionnaire
 * (CHWIntakeScreen) after registration; members complete profile fields
 * (Medi-Cal ID, primary need) via the Profile screen.
 */

import React, { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
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
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Mail, Lock, User as UserIcon, MapPin, Phone, Eye, EyeOff, ArrowRight } from 'lucide-react-native';

import { useAuth } from '../../context/AuthContext';
import { colors } from '../../theme/colors';
import { fonts } from '../../theme/typography';
import { radii, spacing } from '../../theme/spacing';
import type { AuthStackParamList } from '../../navigation/AppNavigator';

type RegisterNavProp = NativeStackNavigationProp<AuthStackParamList>;

type Role = 'chw' | 'member';

interface FieldRefs {
  name: React.RefObject<TextInput | null>;
  email: React.RefObject<TextInput | null>;
  password: React.RefObject<TextInput | null>;
  zip: React.RefObject<TextInput | null>;
  phone: React.RefObject<TextInput | null>;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function RegisterScreen(): React.JSX.Element {
  const navigation = useNavigation<RegisterNavProp>();
  const { register } = useAuth();

  const [role, setRole] = useState<Role>('member');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [zip, setZip] = useState('');
  const [phone, setPhone] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refs: FieldRefs = {
    name: useRef<TextInput>(null),
    email: useRef<TextInput>(null),
    password: useRef<TextInput>(null),
    zip: useRef<TextInput>(null),
    phone: useRef<TextInput>(null),
  };

  const canSubmit =
    name.trim().length > 1 &&
    EMAIL_PATTERN.test(email.trim()) &&
    password.length >= 8 &&
    zip.trim().length === 5 &&
    !isSubmitting;

  const handleSubmit = useCallback(async (): Promise<void> => {
    if (!canSubmit) return;
    setError(null);
    setIsSubmitting(true);
    try {
      await register(
        email.trim().toLowerCase(),
        password,
        name.trim(),
        role,
        phone.trim() || undefined,
      );
      // AuthContext.register flips authState; the root navigator swaps to the
      // role-appropriate stack automatically. CHW intake banner appears on
      // CHWDashboardScreen; members land on MemberHome.
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Could not create your account.';
      setError(
        message.includes('Email already registered')
          ? 'This email is already registered. Try signing in instead.'
          : message,
      );
    } finally {
      setIsSubmitting(false);
    }
  }, [canSubmit, email, password, name, role, phone, register]);

  const handleNavToLogin = useCallback((): void => {
    navigation.navigate('Login');
  }, [navigation]);

  return (
    <SafeAreaView style={s.safeArea} edges={['top']}>
      <KeyboardAvoidingView
        style={s.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={s.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <View style={s.card}>
            <Text style={s.heading}>Create your account</Text>
            <Text style={s.subheading}>
              Join Compass to {role === 'chw' ? 'start earning' : 'connect with a CHW'}.
            </Text>

            {/* Role chooser */}
            <View style={s.roleRow}>
              <RoleButton
                label="I need help (Member)"
                active={role === 'member'}
                onPress={() => setRole('member')}
              />
              <RoleButton
                label="I'm a CHW"
                active={role === 'chw'}
                onPress={() => setRole('chw')}
              />
            </View>

            {/* Error banner */}
            {error && (
              <View style={s.errorBanner}>
                <Text style={s.errorText}>{error}</Text>
              </View>
            )}

            {/* Name */}
            <FormField label="Full name" icon={<UserIcon size={18} color={colors.mutedForeground} />}>
              <TextInput
                ref={refs.name}
                value={name}
                onChangeText={setName}
                placeholder="Your full name"
                placeholderTextColor={colors.mutedForeground}
                autoCapitalize="words"
                autoComplete="name"
                returnKeyType="next"
                onSubmitEditing={() => refs.email.current?.focus()}
                style={s.input}
              />
            </FormField>

            {/* Email */}
            <FormField label="Email address" icon={<Mail size={18} color={colors.mutedForeground} />}>
              <TextInput
                ref={refs.email}
                value={email}
                onChangeText={setEmail}
                placeholder="you@example.com"
                placeholderTextColor={colors.mutedForeground}
                autoCapitalize="none"
                autoComplete="email"
                keyboardType="email-address"
                returnKeyType="next"
                onSubmitEditing={() => refs.password.current?.focus()}
                style={s.input}
              />
            </FormField>

            {/* Password */}
            <FormField label="Password" icon={<Lock size={18} color={colors.mutedForeground} />}>
              <View style={s.passwordRow}>
                <TextInput
                  ref={refs.password}
                  value={password}
                  onChangeText={setPassword}
                  placeholder="At least 8 characters"
                  placeholderTextColor={colors.mutedForeground}
                  secureTextEntry={!showPassword}
                  autoComplete="new-password"
                  returnKeyType="next"
                  onSubmitEditing={() => refs.zip.current?.focus()}
                  style={[s.input, s.passwordInput]}
                />
                <TouchableOpacity
                  onPress={() => setShowPassword((v) => !v)}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
                  style={s.eyeButton}
                >
                  {showPassword ? (
                    <EyeOff size={18} color={colors.mutedForeground} />
                  ) : (
                    <Eye size={18} color={colors.mutedForeground} />
                  )}
                </TouchableOpacity>
              </View>
            </FormField>

            {/* ZIP */}
            <FormField label="ZIP code" icon={<MapPin size={18} color={colors.mutedForeground} />}>
              <TextInput
                ref={refs.zip}
                value={zip}
                onChangeText={(v) => setZip(v.replace(/[^0-9]/g, '').slice(0, 5))}
                placeholder="90031"
                placeholderTextColor={colors.mutedForeground}
                keyboardType="number-pad"
                maxLength={5}
                returnKeyType="next"
                onSubmitEditing={() => refs.phone.current?.focus()}
                style={s.input}
              />
            </FormField>

            {/* Phone (optional) */}
            <FormField
              label="Phone (optional)"
              icon={<Phone size={18} color={colors.mutedForeground} />}
            >
              <TextInput
                ref={refs.phone}
                value={phone}
                onChangeText={setPhone}
                placeholder="(555) 123-4567"
                placeholderTextColor={colors.mutedForeground}
                keyboardType="phone-pad"
                returnKeyType="done"
                onSubmitEditing={handleSubmit}
                style={s.input}
              />
            </FormField>

            {/* Submit */}
            <Pressable
              onPress={handleSubmit}
              disabled={!canSubmit}
              style={({ pressed }) => [
                s.submitButton,
                !canSubmit && s.submitButtonDisabled,
                pressed && canSubmit && s.submitButtonPressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel="Create account"
            >
              {isSubmitting ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <>
                  <Text style={s.submitText}>Create account</Text>
                  <ArrowRight size={18} color="#FFFFFF" />
                </>
              )}
            </Pressable>

            <Text style={s.disclaimer}>
              By creating an account, you agree to our Terms and acknowledge that
              Medi-Cal sessions may be recorded for billing and quality purposes.
            </Text>

            {/* Sign-in link */}
            <View style={s.signInRow}>
              <Text style={s.signInPrompt}>Already have an account?</Text>
              <TouchableOpacity onPress={handleNavToLogin} hitSlop={8}>
                <Text style={s.signInLink}>Sign in</Text>
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ─── Subcomponents ────────────────────────────────────────────────────────────

interface RoleButtonProps {
  label: string;
  active: boolean;
  onPress: () => void;
}

function RoleButton({ label, active, onPress }: RoleButtonProps): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      style={[s.roleButton, active && s.roleButtonActive]}
      accessibilityRole="radio"
      accessibilityState={{ selected: active }}
    >
      <Text style={[s.roleButtonText, active && s.roleButtonTextActive]}>{label}</Text>
    </Pressable>
  );
}

interface FormFieldProps {
  label: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}

function FormField({ label, icon, children }: FormFieldProps): React.JSX.Element {
  return (
    <View style={s.field}>
      <Text style={s.fieldLabel}>{label}</Text>
      <View style={s.inputWrapper}>
        <View style={s.inputIcon}>{icon}</View>
        {children}
      </View>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  scrollContent: {
    flexGrow: 1,
    padding: spacing.md,
    justifyContent: 'center',
  },
  card: {
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
    backgroundColor: colors.card,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  heading: {
    fontSize: 24,
    fontFamily: fonts.displaySemibold,
    color: colors.foreground,
    textAlign: 'center',
  },
  subheading: {
    marginTop: 4,
    fontSize: 14,
    fontFamily: fonts.body,
    color: colors.mutedForeground,
    textAlign: 'center',
    marginBottom: spacing.md,
  },
  roleRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    marginBottom: spacing.md,
  },
  roleButton: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    alignItems: 'center',
  },
  roleButtonActive: {
    borderColor: colors.primary,
    backgroundColor: 'rgba(107,143,113,0.12)',
  },
  roleButtonText: {
    fontSize: 13,
    fontFamily: fonts.bodySemibold,
    color: colors.mutedForeground,
  },
  roleButtonTextActive: {
    color: colors.primary,
  },
  errorBanner: {
    backgroundColor: '#FEE2E2',
    borderColor: '#FCA5A5',
    borderWidth: 1,
    borderRadius: radii.md,
    padding: 10,
    marginBottom: spacing.sm,
  },
  errorText: {
    fontSize: 13,
    fontFamily: fonts.body,
    color: '#B91C1C',
  },
  field: { marginBottom: spacing.sm },
  fieldLabel: {
    fontSize: 13,
    fontFamily: fonts.bodySemibold,
    color: colors.foreground,
    marginBottom: 4,
  },
  inputWrapper: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'center',
  },
  inputIcon: {
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
    fontSize: 14,
    fontFamily: fonts.body,
    color: colors.foreground,
  },
  passwordRow: { flex: 1, position: 'relative' },
  passwordInput: { paddingRight: 40 },
  eyeButton: {
    position: 'absolute',
    right: 10,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
  },
  submitButton: {
    marginTop: spacing.md,
    height: 48,
    borderRadius: radii.md,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  submitButtonDisabled: {
    backgroundColor: 'rgba(107,143,113,0.4)',
  },
  submitButtonPressed: {
    opacity: 0.85,
  },
  submitText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontFamily: fonts.bodySemibold,
  },
  disclaimer: {
    marginTop: spacing.sm,
    fontSize: 11,
    fontFamily: fonts.body,
    color: colors.mutedForeground,
    textAlign: 'center',
    lineHeight: 16,
  },
  signInRow: {
    marginTop: spacing.md,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
  },
  signInPrompt: {
    fontSize: 13,
    fontFamily: fonts.body,
    color: colors.mutedForeground,
  },
  signInLink: {
    fontSize: 13,
    fontFamily: fonts.bodySemibold,
    color: colors.primary,
  },
});

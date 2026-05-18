/**
 * RegisterScreen — self-service account creation for new CHWs and members.
 *
 * Single-step form: role chooser, then name + email + password + ZIP + phone.
 * On submit, calls AuthContext.register which POSTs /auth/register and stores
 * the JWT pair.
 *
 * Post-registration phone verification
 * -------------------------------------
 * If the user entered a phone number, a PhoneVerificationModal is shown
 * immediately after the account is created (while the user is already
 * authenticated via the issued JWT).  Completing verification stores the
 * verified number on the server.  Dismissing or skipping the modal is
 * permitted — the number remains unverified until the user visits their
 * profile screen.
 *
 * The root navigator picks up the resulting role and routes the user to their
 * respective tab navigator once the modal is closed (CHW → CHWTabNavigator
 * with the intake banner, Member → MemberTabNavigator).
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
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
import { Mail, Lock, User as UserIcon, MapPin, Phone, Eye, EyeOff, ArrowRight, Cake, Users, Building2, IdCard, Home as HomeIcon, ChevronDown, Globe } from 'lucide-react-native';

import { useAuth } from '../../context/AuthContext';
import { PhoneVerificationModal } from '../../components/shared/PhoneVerificationModal';
import { colors } from '../../theme/colors';
import { fonts } from '../../theme/typography';
import { radii, spacing } from '../../theme/spacing';
import type { AuthStackParamList } from '../../navigation/AppNavigator';

type RegisterNavProp = NativeStackNavigationProp<AuthStackParamList>;

type Role = 'chw' | 'member';
type Sex = 'Male' | 'Female' | 'Other';

interface FieldRefs {
  name: React.RefObject<TextInput | null>;
  email: React.RefObject<TextInput | null>;
  password: React.RefObject<TextInput | null>;
  zip: React.RefObject<TextInput | null>;
  phone: React.RefObject<TextInput | null>;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// DOB input format: MM/DD/YYYY entered, ISO YYYY-MM-DD sent to backend.
// Inline format because adding a native date-picker library risks the
// Expo-managed web build; plain TextInput + parse is the lighter path.
const DOB_INPUT_PATTERN = /^(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\/(19|20)\d{2}$/;

function parseDobInputToIso(value: string): string | null {
  if (!DOB_INPUT_PATTERN.test(value)) return null;
  const [mm, dd, yyyy] = value.split('/');
  // Construct via Date to detect impossible calendar dates (Feb 30 etc).
  const probe = new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`);
  if (
    probe.getUTCFullYear() !== Number(yyyy) ||
    probe.getUTCMonth() + 1 !== Number(mm) ||
    probe.getUTCDate() !== Number(dd)
  ) {
    return null;
  }
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Auto-formats MM/DD/YYYY as the user types: digits only, inserts slashes
 * after positions 2 and 4. Keeps backspace behavior intact (no trailing
 * slashes on partial input).
 */
function formatDobInput(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}

// Curated insurance dropdown — matches the 6 contracted carriers + the
// backend's carrier→costId map in app.services.billing.pear_cost_ids.
// Order here is alphabetical by display name; first entry is shown as
// the default placeholder hint.
const INSURANCE_OPTIONS: readonly string[] = [
  'Anthem Blue Cross Blue Shield',
  'Blue Shield of California - Promise Plan',
  'Health Net',
  'Independent Living Systems (Kaiser)',
  'LA Care Health Plan',
  'Molina Healthcare California',
] as const;

const SEX_OPTIONS: readonly Sex[] = ['Male', 'Female', 'Other'] as const;

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

  // ── Expanded member-signup fields ──────────────────────────────────────
  // Only required when role === 'member'.  DOB + Sex gate the submit;
  // everything else is captured optionally so a partial signup still works.
  const [dob, setDob] = useState('');             // MM/DD/YYYY
  const [sex, setSex] = useState<Sex | null>(null);
  const [insuranceCompany, setInsuranceCompany] = useState('');
  const [primaryCin, setPrimaryCin] = useState('');
  const [addressLine1, setAddressLine1] = useState('');
  const [addressLine2, setAddressLine2] = useState('');
  const [city, setCity] = useState('');
  const [stateCode, setStateCode] = useState('');
  // Modal pickers for the two enum-style fields.  Plain Modal + list avoids
  // pulling in a third-party Picker / SelectInput dependency that we don't
  // need anywhere else.
  const [sexPickerOpen, setSexPickerOpen] = useState(false);
  const [insurancePickerOpen, setInsurancePickerOpen] = useState(false);

  // Pre-parsed DOB for both validation and submit.  null when invalid /
  // incomplete; the submit button stays disabled until this is non-null
  // for member signups.
  const dobIso = useMemo(() => parseDobInputToIso(dob), [dob]);

  // Phone verification modal — shown after successful registration when the
  // user provided a phone number.  The modal fires against the live backend
  // using the JWT already stored by AuthContext.register.
  const [showPhoneVerification, setShowPhoneVerification] = useState(false);
  const [registeredPhone, setRegisteredPhone] = useState<string>('');

  const refs: FieldRefs = {
    name: useRef<TextInput>(null),
    email: useRef<TextInput>(null),
    password: useRef<TextInput>(null),
    zip: useRef<TextInput>(null),
    phone: useRef<TextInput>(null),
  };

  // Hard-required gate by role:
  //   - CHW: name + valid email + 8-char password (unchanged from before).
  //   - Member: name + valid email + 8-char password + valid DOB + Sex
  //     (everything else is captured optionally and persists to the
  //     MemberProfile but doesn't block submission).
  // ZIP is no longer required at signup — it's part of the optional
  // address block.  Phone label no longer says "(optional)" but the
  // submit gate still doesn't enforce it.
  const accountBasicsOk =
    name.trim().length > 1 &&
    EMAIL_PATTERN.test(email.trim()) &&
    password.length >= 8 &&
    !isSubmitting;
  const memberProfileOk = role !== 'member' || (dobIso !== null && sex !== null);
  const canSubmit = accountBasicsOk && memberProfileOk;

  const handleSubmit = useCallback(async (): Promise<void> => {
    if (!canSubmit) return;
    setError(null);
    setIsSubmitting(true);
    try {
      const trimmedPhone = phone.trim();
      // Build the optional member-extras payload only when registering as a
      // member.  Empty strings are omitted client-side too (the api/auth
      // layer skips them, but doing it here keeps the network shape tidy).
      const memberExtras =
        role === 'member'
          ? {
              date_of_birth: dobIso ?? undefined,
              gender: sex ?? undefined,
              address_line1: addressLine1.trim() || undefined,
              address_line2: addressLine2.trim() || undefined,
              city: city.trim() || undefined,
              state: stateCode.trim().toUpperCase().slice(0, 2) || undefined,
              zip_code: zip.trim() || undefined,
              insurance_company: insuranceCompany.trim() || undefined,
              medi_cal_id: primaryCin.trim() || undefined,
            }
          : undefined;
      await register(
        email.trim().toLowerCase(),
        password,
        name.trim(),
        role,
        trimmedPhone || undefined,
        memberExtras,
      );
      // AuthContext.register stores JWT tokens and flips authState.
      // If the user provided a phone number, show the verification modal
      // before the root navigator swaps to the role-appropriate stack.
      // The modal runs authenticated API calls using the newly-stored JWT.
      if (trimmedPhone) {
        setRegisteredPhone(trimmedPhone);
        setShowPhoneVerification(true);
        // Note: we intentionally do NOT set isSubmitting = false here.
        // The spinner keeps the form disabled while the modal is open,
        // preventing double-submission.
        return;
      }
      // No phone — navigate immediately (authState flip triggers the
      // root navigator to swap to CHW/Member tabs).
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
  }, [
    canSubmit, email, password, name, role, phone, register,
    dobIso, sex, addressLine1, addressLine2, city, stateCode, zip,
    insuranceCompany, primaryCin,
  ]);

  const handleNavToLogin = useCallback((): void => {
    navigation.navigate('Login');
  }, [navigation]);

  // Called when phone verification succeeds.  The root navigator will already
  // be swapping to the authenticated stack (authState was flipped by register);
  // we just close the modal.
  const handlePhoneVerified = useCallback((): void => {
    setShowPhoneVerification(false);
    setIsSubmitting(false);
  }, []);

  // Called when the user closes the verification modal without completing it.
  // The account already exists and the JWT is stored, so navigation proceeds
  // normally.  The phone field will remain unverified.
  const handlePhoneVerificationClose = useCallback((): void => {
    setShowPhoneVerification(false);
    setIsSubmitting(false);
  }, []);

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
            {/* The eye toggle is absolute-positioned over the TextInput so the
                input itself stays a sibling of the icon View — same layout
                contract as every other field. The previous nested wrapper
                broke the height inheritance and made this row visibly thinner
                than the others. */}
            <FormField label="Password" icon={<Lock size={18} color={colors.mutedForeground} />}>
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
            </FormField>

            {/* Phone */}
            <FormField
              label="Phone"
              icon={<Phone size={18} color={colors.mutedForeground} />}
            >
              <TextInput
                ref={refs.phone}
                value={phone}
                onChangeText={setPhone}
                placeholder="(555) 123-4567"
                placeholderTextColor={colors.mutedForeground}
                keyboardType="phone-pad"
                returnKeyType={role === 'member' ? 'next' : 'done'}
                onSubmitEditing={handleSubmit}
                style={s.input}
              />
            </FormField>

            {/* ── Member-only profile fields (DOB, sex, insurance, address) ── */}
            {role === 'member' && (
              <>
                <SectionDivider label="About you" />

                {/* Date of birth */}
                <FormField label="Date of birth" icon={<Cake size={18} color={colors.mutedForeground} />}>
                  <TextInput
                    value={dob}
                    onChangeText={(v) => setDob(formatDobInput(v))}
                    placeholder="MM/DD/YYYY"
                    placeholderTextColor={colors.mutedForeground}
                    keyboardType="number-pad"
                    maxLength={10}
                    style={s.input}
                    accessibilityLabel="Date of birth in MM/DD/YYYY format"
                  />
                </FormField>

                {/* Sex — modal-picker dropdown */}
                <FormField label="Sex" icon={<Users size={18} color={colors.mutedForeground} />}>
                  <Pressable
                    style={s.input}
                    onPress={() => setSexPickerOpen(true)}
                    accessibilityRole="button"
                    accessibilityLabel="Select sex"
                  >
                    <Text style={[s.pickerValue, !sex && s.pickerPlaceholder]}>
                      {sex ?? 'Select…'}
                    </Text>
                    <ChevronDown size={16} color={colors.mutedForeground} style={s.pickerChevron} />
                  </Pressable>
                </FormField>

                <SectionDivider label="Insurance" />

                {/* Primary Insurance Company — modal-picker dropdown */}
                <FormField label="Primary insurance company" icon={<Building2 size={18} color={colors.mutedForeground} />}>
                  <Pressable
                    style={s.input}
                    onPress={() => setInsurancePickerOpen(true)}
                    accessibilityRole="button"
                    accessibilityLabel="Select primary insurance company"
                  >
                    <Text
                      numberOfLines={1}
                      style={[s.pickerValue, !insuranceCompany && s.pickerPlaceholder]}
                    >
                      {insuranceCompany || 'Select…'}
                    </Text>
                    <ChevronDown size={16} color={colors.mutedForeground} style={s.pickerChevron} />
                  </Pressable>
                </FormField>

                {/* Primary CIN (Medi-Cal ID) */}
                <FormField label="Primary CIN (Medi-Cal ID)" icon={<IdCard size={18} color={colors.mutedForeground} />}>
                  <TextInput
                    value={primaryCin}
                    onChangeText={setPrimaryCin}
                    placeholder="9-character Medi-Cal CIN"
                    placeholderTextColor={colors.mutedForeground}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    style={s.input}
                  />
                </FormField>

                <SectionDivider label="Address" />

                <FormField label="Address line 1" icon={<HomeIcon size={18} color={colors.mutedForeground} />}>
                  <TextInput
                    value={addressLine1}
                    onChangeText={setAddressLine1}
                    placeholder="Street address"
                    placeholderTextColor={colors.mutedForeground}
                    autoCapitalize="words"
                    autoComplete="address-line1"
                    style={s.input}
                  />
                </FormField>

                <FormField label="Address line 2" icon={<HomeIcon size={18} color={colors.mutedForeground} />}>
                  <TextInput
                    value={addressLine2}
                    onChangeText={setAddressLine2}
                    placeholder="Apt, suite, unit (optional)"
                    placeholderTextColor={colors.mutedForeground}
                    autoCapitalize="words"
                    autoComplete="address-line2"
                    style={s.input}
                  />
                </FormField>

                {/* Country — read-only US per product decision */}
                <FormField label="Country" icon={<Globe size={18} color={colors.mutedForeground} />}>
                  <View style={[s.input, s.readOnlyInput]}>
                    <Text style={s.readOnlyText}>United States</Text>
                  </View>
                </FormField>

                {/* State + City side-by-side on wider viewports */}
                <FormField label="State" icon={<MapPin size={18} color={colors.mutedForeground} />}>
                  <TextInput
                    value={stateCode}
                    onChangeText={(v) => setStateCode(v.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 2))}
                    placeholder="CA"
                    placeholderTextColor={colors.mutedForeground}
                    autoCapitalize="characters"
                    maxLength={2}
                    style={s.input}
                  />
                </FormField>

                <FormField label="City" icon={<MapPin size={18} color={colors.mutedForeground} />}>
                  <TextInput
                    value={city}
                    onChangeText={setCity}
                    placeholder="Los Angeles"
                    placeholderTextColor={colors.mutedForeground}
                    autoCapitalize="words"
                    autoComplete="postal-address-locality"
                    style={s.input}
                  />
                </FormField>

                <FormField label="ZIP code" icon={<MapPin size={18} color={colors.mutedForeground} />}>
                  <TextInput
                    ref={refs.zip}
                    value={zip}
                    onChangeText={(v) => setZip(v.replace(/[^0-9]/g, '').slice(0, 5))}
                    placeholder="90031"
                    placeholderTextColor={colors.mutedForeground}
                    keyboardType="number-pad"
                    maxLength={5}
                    style={s.input}
                  />
                </FormField>
              </>
            )}

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

      {/* Phone verification — slides up after successful registration when
          the user provided a phone number.  Runs authenticated because the
          JWT is already stored in secure-store by AuthContext.register. */}
      <PhoneVerificationModal
        visible={showPhoneVerification}
        initialPhone={registeredPhone}
        onVerified={handlePhoneVerified}
        onClose={handlePhoneVerificationClose}
      />

      {/* Sex picker — minimal modal with the three Pear-enum options. */}
      <OptionPickerModal
        visible={sexPickerOpen}
        title="Sex"
        options={SEX_OPTIONS}
        selected={sex}
        onSelect={(value) => {
          setSex(value as Sex);
          setSexPickerOpen(false);
        }}
        onClose={() => setSexPickerOpen(false)}
      />

      {/* Insurance picker — curated 6-carrier dropdown.  Mirrors the
          backend's carrier→costId map; do NOT add free-text here without
          a corresponding map entry or claim generation will fail. */}
      <OptionPickerModal
        visible={insurancePickerOpen}
        title="Primary insurance company"
        options={INSURANCE_OPTIONS}
        selected={insuranceCompany || null}
        onSelect={(value) => {
          setInsuranceCompany(value);
          setInsurancePickerOpen(false);
        }}
        onClose={() => setInsurancePickerOpen(false)}
      />
    </SafeAreaView>
  );
}

// ─── Section divider (visual group within the long member form) ──────────────

function SectionDivider({ label }: { label: string }): React.JSX.Element {
  return (
    <View style={s.sectionDivider}>
      <View style={s.sectionRule} />
      <Text style={s.sectionLabel}>{label}</Text>
      <View style={s.sectionRule} />
    </View>
  );
}

// ─── Generic option-picker modal (Sex, Insurance) ────────────────────────────

interface OptionPickerModalProps {
  visible: boolean;
  title: string;
  options: readonly string[];
  selected: string | null;
  onSelect: (value: string) => void;
  onClose: () => void;
}

function OptionPickerModal({
  visible,
  title,
  options,
  selected,
  onSelect,
  onClose,
}: OptionPickerModalProps): React.JSX.Element {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={s.modalBackdrop} onPress={onClose}>
        <Pressable style={s.modalCard} onPress={(e) => e.stopPropagation()}>
          <Text style={s.modalTitle}>{title}</Text>
          {options.map((option) => {
            const isSelected = option === selected;
            return (
              <TouchableOpacity
                key={option}
                style={[s.modalOption, isSelected && s.modalOptionSelected]}
                onPress={() => onSelect(option)}
                accessibilityRole="button"
                accessibilityState={{ selected: isSelected }}
              >
                <Text style={[s.modalOptionText, isSelected && s.modalOptionTextSelected]}>
                  {option}
                </Text>
              </TouchableOpacity>
            );
          })}
        </Pressable>
      </Pressable>
    </Modal>
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

  // ── Expanded member signup additions ───────────────────────────────────
  sectionDivider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  sectionRule: {
    flex: 1,
    height: 1,
    backgroundColor: colors.border,
  },
  sectionLabel: {
    fontSize: 11,
    fontFamily: fonts.bodySemibold,
    color: colors.mutedForeground,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  // Dropdown pickers reuse the input chrome but the inner content is a
  // Text label instead of a TextInput; the chevron sits at the right edge.
  pickerValue: {
    flex: 1,
    fontSize: 14,
    fontFamily: fonts.body,
    color: colors.foreground,
    alignSelf: 'center',
  },
  pickerPlaceholder: {
    color: colors.mutedForeground,
  },
  pickerChevron: {
    position: 'absolute',
    right: 12,
    top: '50%',
    marginTop: -8,
  },
  // Country read-only display — same visual chrome as inputs to keep the
  // form rhythm consistent, just non-interactive.
  readOnlyInput: {
    justifyContent: 'center',
    backgroundColor: colors.muted ?? '#F3F4F6',
  },
  readOnlyText: {
    fontSize: 14,
    fontFamily: fonts.body,
    color: colors.foreground,
  },
  // Picker modal — centered card with the option list.  Backdrop is a
  // pressable so tapping outside the card dismisses without selecting.
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.md,
  },
  modalCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: colors.card,
    borderRadius: radii.lg,
    padding: spacing.md,
    gap: 4,
  },
  modalTitle: {
    fontSize: 16,
    fontFamily: fonts.displaySemibold,
    color: colors.foreground,
    marginBottom: spacing.xs,
    textAlign: 'center',
  },
  modalOption: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  modalOptionSelected: {
    backgroundColor: 'rgba(107,143,113,0.12)',
    borderColor: colors.primary,
  },
  modalOptionText: {
    fontSize: 14,
    fontFamily: fonts.body,
    color: colors.foreground,
  },
  modalOptionTextSelected: {
    fontFamily: fonts.bodySemibold,
    color: colors.primary,
  },
});

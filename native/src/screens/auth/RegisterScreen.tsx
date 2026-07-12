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
import Svg, { Path } from 'react-native-svg';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Mail, Lock, User as UserIcon, MapPin, Phone, Eye, EyeOff, ArrowRight, Cake, Users, Building2, IdCard, Home as HomeIcon, ChevronDown, Globe } from 'lucide-react-native';

import { useAuth } from '../../context/AuthContext';
import { isAppleConfigured, isGoogleConfigured, OAuthError } from '../../services/oauth';
import { PhoneVerificationModal } from '../../components/shared/PhoneVerificationModal';
import { ConsentCheckboxes } from '../../components/shared/ConsentCheckboxes';
import { colors } from '../../theme/colors';
import { fonts } from '../../theme/typography';
import { radii, spacing } from '../../theme/spacing';
import type { AuthStackParamList } from '../../navigation/AppNavigator';
import {
  INSURANCE_OPTIONS,
  validateCinForCarrier,
  expectedFormatMessage,
  type CinValidationResult,
} from '../../constants/insurance';

type RegisterNavProp = NativeStackNavigationProp<AuthStackParamList>;

type Role = 'chw' | 'member';
type Sex = 'Male' | 'Female' | 'Other';

interface FieldRefs {
  firstName: React.RefObject<TextInput | null>;
  lastName: React.RefObject<TextInput | null>;
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

const SEX_OPTIONS: readonly Sex[] = ['Male', 'Female', 'Other'] as const;

// ─── Google icon (inline SVG) ─────────────────────────────────────────────────

function GoogleIcon(): React.JSX.Element {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24">
      <Path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
      <Path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
      <Path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
      <Path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
    </Svg>
  );
}

// ─── Apple icon (inline SVG) ──────────────────────────────────────────────────

function AppleIcon(): React.JSX.Element {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill={colors.foreground}>
      <Path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
    </Svg>
  );
}

// ─── RegisterScreen ───────────────────────────────────────────────────────────

export function RegisterScreen(): React.JSX.Element {
  const navigation = useNavigation<RegisterNavProp>();
  const { register, signInWithGoogle, signInWithApple } = useAuth();

  // Social button visibility — hidden when env vars not provisioned or on native.
  const googleEnabled = Platform.OS === 'web' && isGoogleConfigured();
  const appleEnabled = Platform.OS === 'web' && isAppleConfigured();
  const showSocialSection = googleEnabled || appleEnabled;

  const [role, setRole] = useState<Role>('member');
  // First + Last collected separately. Pear Suite requires both for members;
  // CHWs are kept consistent so the User.name column always carries a full
  // name. Combined into "first last" with a single space before submit.
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [zip, setZip] = useState('');
  const [phone, setPhone] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSocialLoading, setIsSocialLoading] = useState<'google' | 'apple' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── Expanded member-signup fields ──────────────────────────────────────
  // Only required when role === 'member'.  DOB + Sex gate the submit;
  // everything else is captured optionally so a partial signup still works.
  const [dob, setDob] = useState('');             // MM/DD/YYYY
  const [sex, setSex] = useState<Sex | null>(null);
  const [insuranceCompany, setInsuranceCompany] = useState('');
  const [primaryCin, setPrimaryCin] = useState('');
  // Carrier-aware CIN validation result — updated in the cinIsValid useMemo.
  // Separated so the hint text is accessible to the JSX without re-computing.
  const [cinValidation, setCinValidation] = useState<CinValidationResult | null>(null);
  const [addressLine1, setAddressLine1] = useState('');
  const [addressLine2, setAddressLine2] = useState('');
  const [city, setCity] = useState('');
  const [stateCode, setStateCode] = useState('');
  // Modal pickers for the two enum-style fields.  Plain Modal + list avoids
  // pulling in a third-party Picker / SelectInput dependency that we don't
  // need anywhere else.
  const [sexPickerOpen, setSexPickerOpen] = useState(false);
  const [insurancePickerOpen, setInsurancePickerOpen] = useState(false);

  // ── Required signup consent (members only) ──────────────────────────────
  // Both must be checked before submit enables; the backend independently
  // enforces both (422 otherwise) and persists timestamped consent.
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [communicationsConsent, setCommunicationsConsent] = useState(false);

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
    firstName: useRef<TextInput>(null),
    lastName: useRef<TextInput>(null),
    email: useRef<TextInput>(null),
    password: useRef<TextInput>(null),
    zip: useRef<TextInput>(null),
    phone: useRef<TextInput>(null),
  };

  // Hard-required gate by role (T15 — paired with T07 BE schema relaxation):
  //   - CHW: first + last name + valid email + 8-char password.
  //   - Member: same as CHW + DOB + Sex + Insurance + CIN (8 digits + 1
  //     letter) + ZIP (any non-empty string; format validated by BE).
  //
  // Dropped from the member gate (T15): phone, addressLine1, city, state,
  // and the ZIP >= 5 length check.  Phone/address are now optional at
  // registration and can be completed in the member profile.  ZIP format
  // validation is owned by the backend (commit 724130f on main).
  //
  // Both first AND last are required at the form layer because the backend
  // rejects single-token names for members (Pear requires both) and we want
  // CHW.name to carry a full name too for consistent display.
  const accountBasicsOk =
    firstName.trim().length > 0 &&
    lastName.trim().length > 0 &&
    EMAIL_PATTERN.test(email.trim()) &&
    password.length >= 8 &&
    !isSubmitting;
  // Signup CIN validation — WARN only, never blocks submit.
  // Re-runs when either the CIN or the insurance selection changes so a
  // carrier switch that invalidates the current CIN immediately shows the hint.
  const cinIsPresent = useMemo(() => {
    if (!primaryCin.trim()) {
      setCinValidation(null);
      return false;
    }
    const result = validateCinForCarrier(primaryCin, insuranceCompany);
    setCinValidation(result);
    // Always return true when a non-empty CIN is entered — we never block
    // submit at signup regardless of format (lenient-warn policy).
    return true;
  }, [primaryCin, insuranceCompany]);
  const memberProfileOk =
    role !== 'member' ||
    (
      dobIso !== null &&
      sex !== null &&
      insuranceCompany.trim().length > 0 &&
      cinIsPresent &&
      zip.trim().length > 0 &&
      // Both consent boxes are hard-required for member signups.
      termsAccepted &&
      communicationsConsent
    );
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
      const fullName = `${firstName.trim()} ${lastName.trim()}`;
      await register(
        email.trim().toLowerCase(),
        password,
        fullName,
        role,
        trimmedPhone || undefined,
        memberExtras,
        role === 'member'
          ? { termsAccepted, communicationsConsent }
          : undefined,
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
    canSubmit, email, password, firstName, lastName, role, phone, register,
    dobIso, sex, addressLine1, addressLine2, city, stateCode, zip,
    insuranceCompany, primaryCin, termsAccepted, communicationsConsent,
  ]);

  // Legal links open the in-app Terms / Privacy pages (Auth-stack 'Legal'
  // route — the same destination LandingScreen's footer links use).
  const openTerms = useCallback((): void => {
    navigation.navigate('Legal', { page: 'terms' });
  }, [navigation]);
  const openPrivacy = useCallback((): void => {
    navigation.navigate('Legal', { page: 'privacy' });
  }, [navigation]);

  // ── Social sign-up handlers (web-only) ────────────────────────────────────
  //
  // OAuth is the same sign-in / sign-up endpoint on the backend — the account
  // is created on first call with needsOnboarding=true, and the navigator gates
  // on CompleteProfileScreen automatically.

  const handleGoogleSignIn = useCallback(async (): Promise<void> => {
    setError(null);
    setIsSocialLoading('google');
    try {
      await signInWithGoogle();
    } catch (err) {
      if (err instanceof OAuthError && err.code === 'user_cancelled') {
        return;
      }
      const message = err instanceof Error ? err.message : 'Google sign-in failed.';
      setError(message);
    } finally {
      setIsSocialLoading(null);
    }
  }, [signInWithGoogle]);

  const handleAppleSignIn = useCallback(async (): Promise<void> => {
    setError(null);
    setIsSocialLoading('apple');
    try {
      await signInWithApple();
    } catch (err) {
      if (err instanceof OAuthError && err.code === 'user_cancelled') {
        return;
      }
      const message = err instanceof Error ? err.message : 'Apple sign-in failed.';
      setError(message);
    } finally {
      setIsSocialLoading(null);
    }
  }, [signInWithApple]);

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

            {/* First name */}
            <FormField label="First name" icon={<UserIcon size={18} color={colors.mutedForeground} />}>
              <TextInput
                ref={refs.firstName}
                value={firstName}
                onChangeText={setFirstName}
                placeholder="First name"
                placeholderTextColor={colors.mutedForeground}
                autoCapitalize="words"
                autoComplete="name-given"
                textContentType="givenName"
                returnKeyType="next"
                onSubmitEditing={() => refs.lastName.current?.focus()}
                style={s.input}
              />
            </FormField>

            {/* Last name — required for members (Pear rejects without) and
                enforced at the schema layer too. */}
            <FormField label="Last name" icon={<UserIcon size={18} color={colors.mutedForeground} />}>
              <TextInput
                ref={refs.lastName}
                value={lastName}
                onChangeText={setLastName}
                placeholder="Last name"
                placeholderTextColor={colors.mutedForeground}
                autoCapitalize="words"
                autoComplete="name-family"
                textContentType="familyName"
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
                    style={[s.input, s.pickerTrigger]}
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
                    style={[s.input, s.pickerTrigger]}
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
                    onChangeText={(v) => setPrimaryCin(v.toUpperCase())}
                    placeholder="e.g. 91234567A2"
                    placeholderTextColor={colors.mutedForeground}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    maxLength={14}
                    style={[s.input, cinValidation !== null && !cinValidation.valid && s.inputWarning]}
                  />
                </FormField>
                {cinValidation !== null && !cinValidation.valid && (
                  <View style={s.cinWarningBanner}>
                    <Text style={s.cinWarningText}>
                      {expectedFormatMessage(insuranceCompany)}
                      {'\n'}
                      <Text style={s.cinWarningSubtext}>
                        You can still register — verify the ID and update it in your profile if needed.
                      </Text>
                    </Text>
                  </View>
                )}

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

            {/* Required consent — members only. Both boxes gate the submit. */}
            {role === 'member' && (
              <ConsentCheckboxes
                intro="Before creating your account, please review and agree:"
                termsPrefix="I agree to the Compass"
                communicationsLabel="I consent to receive calls and text messages from Compass and my Community Health Worker about my care, and for Compass to bill my insurance for covered services — always at no cost to me."
                termsAccepted={termsAccepted}
                communicationsConsent={communicationsConsent}
                onToggleTerms={() => setTermsAccepted((v) => !v)}
                onToggleCommunications={() => setCommunicationsConsent((v) => !v)}
                onPressTerms={openTerms}
                onPressPrivacy={openPrivacy}
                disabled={isSubmitting}
                palette={{
                  accent: colors.primary,
                  text: colors.foreground,
                  muted: colors.mutedForeground,
                  border: colors.border,
                  checkmark: '#FFFFFF',
                  fontRegular: fonts.body,
                  fontSemibold: fonts.bodySemibold,
                }}
              />
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

            {/* Social sign-up — only shown when at least one provider is
                configured via EXPO_PUBLIC_* env vars and we are on web. */}
            {showSocialSection && (
              <>
                <View style={s.dividerRow}>
                  <View style={s.dividerLine} />
                  <Text style={s.dividerLabel}>OR SIGN UP WITH</Text>
                  <View style={s.dividerLine} />
                </View>

                <View style={s.socialButtonsContainer}>
                  {googleEnabled && (
                    <TouchableOpacity
                      style={[
                        s.socialButton,
                        isSocialLoading === 'google' && s.socialButtonLoading,
                      ]}
                      onPress={handleGoogleSignIn}
                      disabled={isSocialLoading !== null || isSubmitting}
                      activeOpacity={0.7}
                      accessibilityLabel="Sign up with Google"
                      accessibilityRole="button"
                    >
                      {isSocialLoading === 'google' ? (
                        <ActivityIndicator size="small" color={colors.mutedForeground} />
                      ) : (
                        <GoogleIcon />
                      )}
                      <Text style={s.socialButtonText}>Continue with Google</Text>
                    </TouchableOpacity>
                  )}

                  {appleEnabled && (
                    <TouchableOpacity
                      style={[
                        s.socialButton,
                        isSocialLoading === 'apple' && s.socialButtonLoading,
                      ]}
                      onPress={handleAppleSignIn}
                      disabled={isSocialLoading !== null || isSubmitting}
                      activeOpacity={0.7}
                      accessibilityLabel="Sign up with Apple"
                      accessibilityRole="button"
                    >
                      {isSocialLoading === 'apple' ? (
                        <ActivityIndicator size="small" color={colors.mutedForeground} />
                      ) : (
                        <AppleIcon />
                      )}
                      <Text style={s.socialButtonText}>Continue with Apple</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </>
            )}

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

  // ── Social sign-up section ────────────────────────────────────────────────
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: colors.border,
  },
  dividerLabel: {
    fontFamily: fonts.bodySemibold,
    fontSize: 10,
    letterSpacing: 1.1,
    color: colors.mutedForeground,
    textTransform: 'uppercase',
  },
  socialButtonsContainer: {
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  socialButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.background,
    paddingVertical: 13,
    paddingHorizontal: spacing.md,
    minHeight: 44,
  },
  socialButtonText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 14,
    color: colors.foreground,
  },
  socialButtonLoading: {
    opacity: 0.6,
  },

  // Warning border on the CIN input when the format looks incorrect.
  inputWarning: {
    borderColor: '#D97706', // amber-600
  },
  // Visible warning banner below the CIN field — more prominent than the old
  // soft amber hint. Never blocks submit (lenient-warn policy at signup).
  cinWarningBanner: {
    backgroundColor: '#FFFBEB', // amber-50
    borderColor: '#F59E0B',     // amber-400
    borderWidth: 1,
    borderRadius: radii.md,
    padding: 10,
    marginTop: 6,
    marginBottom: 2,
  },
  cinWarningText: {
    fontSize: 13,
    color: '#92400E', // amber-800
    fontFamily: fonts.bodySemibold,
    lineHeight: 18,
  },
  cinWarningSubtext: {
    fontSize: 12,
    color: '#78350F', // amber-900
    fontFamily: fonts.body,
    fontWeight: '400',
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
    textAlign: 'center',
  },
  pickerPlaceholder: {
    color: colors.mutedForeground,
  },
  pickerTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
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

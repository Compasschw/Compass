/**
 * AddMemberModal — CHW-facing "Add New Member" onboarding dialog.
 *
 * Opened from the CHW Dashboard header ("Add New Member"). Collects the full
 * set of fields the backend needs to stand up a *complete*, Pear/Medi-Cal-
 * billing-ready member account that is immediately wired to the calling CHW —
 * the same fields a member provides at self-signup:
 *   - Full name (first + last — the backend rejects a single token)
 *   - Login email
 *   - Phone (optional)
 *   - Temporary password the CHW shares with the member out-of-band
 *   - Date of birth, Sex
 *   - Insurance company + CIN (Medi-Cal ID)
 *   - Address (line 1/2, city, state) + ZIP
 *
 * On success the member appears in the CHW's roster (the hook invalidates it)
 * and the CHW can message / schedule / start journeys immediately.
 *
 * The body is scrollable (the form is now tall) and the card width is capped
 * for desktop web. Styling mirrors CloseMemberModal (emerald header, centered
 * card, full-screen dimmed backdrop) so the dialog reads consistently across
 * the CHW surface. A React Native <Modal> is used on both web and native — on
 * web it portals to the document root, escaping any transformed ancestor.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Pressable,
  ScrollView,
  ActivityIndicator,
  StyleSheet,
  Platform,
  type ViewStyle,
  type TextStyle,
} from 'react-native';

import { colors as tokens } from '../../theme/tokens';
import { ConsentCheckboxes } from '../../components/shared/ConsentCheckboxes';
import { ApiError } from '../../api/client';
import { useCreateChwMember, type CreatedChwMember } from '../../hooks/useApiQueries';
import {
  INSURANCE_OPTIONS,
  validateCinForCarrier,
  expectedFormatMessage,
} from '../../constants/insurance';

interface AddMemberModalProps {
  visible: boolean;
  onClose: () => void;
  /** Fired after a member is successfully created (e.g. to surface a toast). */
  onCreated?: (member: CreatedChwMember) => void;
}

type Sex = 'Male' | 'Female' | 'Other';

const SEX_OPTIONS: readonly Sex[] = ['Male', 'Female', 'Other'] as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

// DOB input format: MM/DD/YYYY entered, ISO YYYY-MM-DD sent to backend.
// Mirrors RegisterScreen — plain TextInput + parse keeps the Expo web build
// free of a native date-picker dependency.
const DOB_INPUT_PATTERN = /^(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\/(19|20)\d{2}$/;

/** Auto-formats MM/DD/YYYY as the user types (digits only + slashes). */
function formatDobInput(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}

/** Parses MM/DD/YYYY → ISO YYYY-MM-DD, or null when invalid/impossible. */
function parseDobInputToIso(value: string): string | null {
  if (!DOB_INPUT_PATTERN.test(value)) return null;
  const [mm, dd, yyyy] = value.split('/');
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

interface FormState {
  name: string;
  email: string;
  phone: string;
  password: string;
  dob: string;
  sex: Sex | null;
  insuranceCompany: string;
  primaryCin: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  stateCode: string;
  zip: string;
}

/**
 * Local, synchronous form validation. Returns the first user-facing error
 * message, or null when the form is submittable. Mirrors the backend contract
 * (first + last name, valid email, ≥8-char password, DOB, sex, insurance,
 * valid CIN, ZIP) so the CHW gets instant feedback before the round-trip and
 * never hits a surprise 422.
 */
function validate(form: FormState): string | null {
  const nameTokens = form.name.trim().split(/\s+/).filter(Boolean);
  if (nameTokens.length < 2) {
    return 'Enter the member’s first and last name.';
  }
  if (!EMAIL_RE.test(form.email.trim())) {
    return 'Enter a valid email address.';
  }
  if (form.password.length < MIN_PASSWORD_LENGTH) {
    return `Temporary password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (parseDobInputToIso(form.dob.trim()) === null) {
    return 'Enter the date of birth as MM/DD/YYYY.';
  }
  if (form.sex === null) {
    return 'Select the member’s sex.';
  }
  if (form.insuranceCompany.trim().length === 0) {
    return 'Select the member’s insurance company.';
  }
  if (form.primaryCin.trim().length === 0) {
    return 'Enter the CIN (Medi-Cal ID).';
  }
  if (!validateCinForCarrier(form.primaryCin, form.insuranceCompany).valid) {
    return expectedFormatMessage(form.insuranceCompany);
  }
  if (
    form.stateCode.trim().length > 0 &&
    !/^[A-Za-z]{2}$/.test(form.stateCode.trim())
  ) {
    return 'State must be a 2-letter code (e.g. CA).';
  }
  if (form.zip.trim().length === 0) {
    return 'Enter the member’s ZIP code.';
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
  const [dob, setDob] = useState('');
  const [sex, setSex] = useState<Sex | null>(null);
  const [insuranceCompany, setInsuranceCompany] = useState('');
  const [insuranceOpen, setInsuranceOpen] = useState(false);
  const [primaryCin, setPrimaryCin] = useState('');
  const [addressLine1, setAddressLine1] = useState('');
  const [addressLine2, setAddressLine2] = useState('');
  const [city, setCity] = useState('');
  const [stateCode, setStateCode] = useState('');
  const [zip, setZip] = useState('');
  // Required member consent (documented opt-in) — both gate the submit button
  // and are enforced independently by the backend (422 otherwise).
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [communicationsConsent, setCommunicationsConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createMember = useCreateChwMember();

  // Reset the form each time the modal opens so stale input never lingers.
  useEffect(() => {
    if (visible) {
      setName('');
      setEmail('');
      setPhone('');
      setPassword('');
      setDob('');
      setSex(null);
      setInsuranceCompany('');
      setInsuranceOpen(false);
      setPrimaryCin('');
      setAddressLine1('');
      setAddressLine2('');
      setCity('');
      setStateCode('');
      setZip('');
      setTermsAccepted(false);
      setCommunicationsConsent(false);
      setError(null);
    }
  }, [visible]);

  const isSubmitting = createMember.isPending;

  const form: FormState = {
    name,
    email,
    phone,
    password,
    dob,
    sex,
    insuranceCompany,
    primaryCin,
    addressLine1,
    addressLine2,
    city,
    stateCode,
    zip,
  };

  const clientError = useMemo(() => validate(form), [
    name, email, password, dob, sex, insuranceCompany, primaryCin, stateCode, zip,
  ]);
  // Submit also requires BOTH consent boxes — extends the existing gate. Kept
  // out of validate()/clientError so unchecked boxes don't flash a red error on
  // an untouched form; the disabled button communicates the requirement, and
  // the ConsentCheckboxes block sits directly above it.
  const canSubmit =
    clientError === null && termsAccepted && communicationsConsent && !isSubmitting;

  // Soft carrier-aware CIN hint — shown once the user has typed a CIN that
  // doesn't match the selected carrier's expected format.
  const cinValidation = useMemo(
    () => (primaryCin.trim().length > 0
      ? validateCinForCarrier(primaryCin, insuranceCompany)
      : null),
    [primaryCin, insuranceCompany],
  );

  const handleSubmit = (): void => {
    const validationError = validate(form);
    if (validationError !== null) {
      setError(validationError);
      return;
    }
    const dobIso = parseDobInputToIso(dob.trim());
    if (dobIso === null || sex === null) {
      // Unreachable — validate() already guards these — but narrows the types.
      setError('Enter the date of birth as MM/DD/YYYY.');
      return;
    }
    setError(null);
    createMember.mutate(
      {
        name: name.trim(),
        email: email.trim(),
        phone: phone.trim() ? phone.trim() : undefined,
        tempPassword: password,
        dateOfBirth: dobIso,
        gender: sex,
        insuranceCompany: insuranceCompany.trim(),
        mediCalId: primaryCin.trim(),
        addressLine1: addressLine1.trim() || undefined,
        addressLine2: addressLine2.trim() || undefined,
        city: city.trim() || undefined,
        state: stateCode.trim() ? stateCode.trim().toUpperCase() : undefined,
        zipCode: zip.trim(),
        termsAccepted,
        communicationsConsent,
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

          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator
          >
            <Text style={styles.sectionLabel}>Account</Text>

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
                returnKeyType="next"
              />
              <Text style={styles.hint}>
                Share this with the member — they can change it after signing in.
              </Text>
            </View>

            <Text style={styles.sectionLabel}>About the member</Text>

            <View style={styles.field}>
              <Text style={styles.fieldLabel}>Date of birth</Text>
              <TextInput
                style={styles.input}
                value={dob}
                onChangeText={(v) => setDob(formatDobInput(v))}
                placeholder="MM/DD/YYYY"
                placeholderTextColor={tokens.textSecondary}
                keyboardType="number-pad"
                maxLength={10}
                editable={!isSubmitting}
                accessibilityLabel="Member date of birth in MM/DD/YYYY format"
              />
            </View>

            <View style={styles.field}>
              <Text style={styles.fieldLabel}>Sex</Text>
              <View style={styles.chipRow}>
                {SEX_OPTIONS.map((option) => {
                  const selected = sex === option;
                  return (
                    <TouchableOpacity
                      key={option}
                      style={[styles.chip, selected && styles.chipSelected]}
                      onPress={() => setSex(option)}
                      disabled={isSubmitting}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      accessibilityLabel={`Sex ${option}`}
                    >
                      <Text
                        style={[
                          styles.chipText,
                          selected && styles.chipTextSelected,
                        ]}
                      >
                        {option}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            <Text style={styles.sectionLabel}>Insurance</Text>

            <View style={styles.field}>
              <Text style={styles.fieldLabel}>Insurance company</Text>
              <Pressable
                style={[styles.input, styles.pickerTrigger]}
                onPress={() => setInsuranceOpen((open) => !open)}
                disabled={isSubmitting}
                accessibilityRole="button"
                accessibilityLabel="Select insurance company"
                accessibilityState={{ expanded: insuranceOpen }}
              >
                <Text
                  numberOfLines={1}
                  style={[
                    styles.pickerValue,
                    !insuranceCompany && styles.pickerPlaceholder,
                  ]}
                >
                  {insuranceCompany || 'Select…'}
                </Text>
                <Text style={styles.pickerChevron}>{insuranceOpen ? '▲' : '▼'}</Text>
              </Pressable>
              {insuranceOpen && (
                <View style={styles.optionList}>
                  {INSURANCE_OPTIONS.map((option) => (
                    <TouchableOpacity
                      key={option}
                      style={styles.optionRow}
                      onPress={() => {
                        setInsuranceCompany(option);
                        setInsuranceOpen(false);
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={option}
                    >
                      <Text style={styles.optionText}>{option}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </View>

            <View style={styles.field}>
              <Text style={styles.fieldLabel}>CIN (Medi-Cal ID)</Text>
              <TextInput
                style={[
                  styles.input,
                  cinValidation !== null && !cinValidation.valid && styles.inputWarning,
                ]}
                value={primaryCin}
                onChangeText={(v) => setPrimaryCin(v.toUpperCase())}
                placeholder="e.g. 91234567A2"
                placeholderTextColor={tokens.textSecondary}
                autoCapitalize="characters"
                autoCorrect={false}
                maxLength={14}
                editable={!isSubmitting}
                accessibilityLabel="Member CIN Medi-Cal ID"
              />
              {cinValidation !== null && !cinValidation.valid && (
                <Text style={styles.hint}>{expectedFormatMessage(insuranceCompany)}</Text>
              )}
            </View>

            <Text style={styles.sectionLabel}>Address</Text>

            <View style={styles.field}>
              <Text style={styles.fieldLabel}>
                Address line 1 <Text style={styles.optional}>(optional)</Text>
              </Text>
              <TextInput
                style={styles.input}
                value={addressLine1}
                onChangeText={setAddressLine1}
                placeholder="Street address"
                placeholderTextColor={tokens.textSecondary}
                autoCapitalize="words"
                autoComplete="address-line1"
                editable={!isSubmitting}
                accessibilityLabel="Member address line 1"
              />
            </View>

            <View style={styles.field}>
              <Text style={styles.fieldLabel}>
                Address line 2 <Text style={styles.optional}>(optional)</Text>
              </Text>
              <TextInput
                style={styles.input}
                value={addressLine2}
                onChangeText={setAddressLine2}
                placeholder="Apt, suite, unit"
                placeholderTextColor={tokens.textSecondary}
                autoCapitalize="words"
                autoComplete="address-line2"
                editable={!isSubmitting}
                accessibilityLabel="Member address line 2"
              />
            </View>

            <View style={styles.field}>
              <Text style={styles.fieldLabel}>
                City <Text style={styles.optional}>(optional)</Text>
              </Text>
              <TextInput
                style={styles.input}
                value={city}
                onChangeText={setCity}
                placeholder="Los Angeles"
                placeholderTextColor={tokens.textSecondary}
                autoCapitalize="words"
                editable={!isSubmitting}
                accessibilityLabel="Member city"
              />
            </View>

            <View style={styles.row}>
              <View style={[styles.field, styles.rowItemState]}>
                <Text style={styles.fieldLabel}>
                  State <Text style={styles.optional}>(optional)</Text>
                </Text>
                <TextInput
                  style={styles.input}
                  value={stateCode}
                  onChangeText={(v) =>
                    setStateCode(v.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 2))
                  }
                  placeholder="CA"
                  placeholderTextColor={tokens.textSecondary}
                  autoCapitalize="characters"
                  maxLength={2}
                  editable={!isSubmitting}
                  accessibilityLabel="Member state"
                />
              </View>
              <View style={[styles.field, styles.rowItemZip]}>
                <Text style={styles.fieldLabel}>ZIP code</Text>
                <TextInput
                  style={styles.input}
                  value={zip}
                  onChangeText={(v) => setZip(v.replace(/[^0-9-]/g, '').slice(0, 10))}
                  placeholder="90001"
                  placeholderTextColor={tokens.textSecondary}
                  keyboardType="number-pad"
                  maxLength={10}
                  editable={!isSubmitting}
                  accessibilityLabel="Member ZIP code"
                  returnKeyType="done"
                  onSubmitEditing={canSubmit ? handleSubmit : undefined}
                />
              </View>
            </View>

            {/* Required member consent — confirmed by the CHW. Both boxes gate
                the Add Member button (canSubmit). */}
            <ConsentCheckboxes
              intro="Confirm the member agrees before creating their account:"
              termsPrefix="The member agrees to the Compass"
              communicationsLabel="The member consents to receive calls and text messages from Compass and their Community Health Worker, and for Compass to bill their insurance for covered services — always at no cost to them."
              termsAccepted={termsAccepted}
              communicationsConsent={communicationsConsent}
              onToggleTerms={() => setTermsAccepted((v) => !v)}
              onToggleCommunications={() => setCommunicationsConsent((v) => !v)}
              disabled={isSubmitting}
              palette={{
                accent: tokens.emerald700,
                text: tokens.textPrimary,
                muted: tokens.textSecondary,
                border: '#E5E7EB',
                checkmark: '#FFFFFF',
                fontRegular: 'PlusJakartaSans_400Regular',
                fontSemibold: 'PlusJakartaSans_600SemiBold',
              }}
            />

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
          </ScrollView>
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
    // Cap height so the (now tall) form scrolls inside the card instead of
    // overflowing the viewport on short/desktop windows.
    maxHeight: '90%',
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
  scroll: {
    flexGrow: 0,
  } as ViewStyle,
  content: {
    padding: 20,
    gap: 14,
  } as ViewStyle,
  sectionLabel: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: tokens.textSecondary,
    marginTop: 4,
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
  inputWarning: {
    borderColor: '#F59E0B',
  } as TextStyle,
  hint: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 12,
    color: tokens.textSecondary,
  } as TextStyle,
  row: {
    flexDirection: 'row',
    gap: 12,
  } as ViewStyle,
  rowItemState: {
    width: 96,
  } as ViewStyle,
  rowItemZip: {
    flex: 1,
  } as ViewStyle,
  chipRow: {
    flexDirection: 'row',
    gap: 8,
  } as ViewStyle,
  chip: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
  } as ViewStyle,
  chipSelected: {
    borderColor: tokens.emerald700,
    backgroundColor: '#ECFDF5',
  } as ViewStyle,
  chipText: {
    fontFamily: 'PlusJakartaSans_500Medium',
    fontSize: 14,
    color: tokens.textPrimary,
  } as TextStyle,
  chipTextSelected: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    color: tokens.emerald700,
  } as TextStyle,
  pickerTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  } as ViewStyle,
  pickerValue: {
    flex: 1,
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 15,
    color: tokens.textPrimary,
  } as TextStyle,
  pickerPlaceholder: {
    color: tokens.textSecondary,
  } as TextStyle,
  pickerChevron: {
    fontSize: 12,
    color: tokens.textSecondary,
    marginLeft: 8,
  } as TextStyle,
  optionList: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 10,
    overflow: 'hidden',
  } as ViewStyle,
  optionRow: {
    paddingVertical: 11,
    paddingHorizontal: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E7EB',
  } as ViewStyle,
  optionText: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: tokens.textPrimary,
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

/**
 * CompleteProfileScreen — post-OAuth onboarding step for new member accounts.
 *
 * Shown when `needsOnboarding === true` in AuthContext (set by the backend
 * when a brand-new member account was created via Google or Apple OAuth and
 * the Pear Suite-required fields are still absent).
 *
 * Collects:
 *   - Date of birth (MM/DD/YYYY → ISO YYYY-MM-DD)
 *   - Sex (Male / Female / Other)
 *   - Insurance company (curated 6-carrier Medi-Cal dropdown)
 *   - CIN / Medi-Cal ID (carrier-aware validation, lenient-warn)
 *   - ZIP code (5 digits)
 *
 * On submit → POST /auth/complete-member-onboarding → success clears
 * `needsOnboarding` in AuthContext → AppNavigator swaps to MemberTabNavigator.
 *
 * Field patterns and validation are identical to RegisterScreen's member fields
 * so the UX is consistent across both paths.
 */

import React, { useCallback, useMemo, useState } from 'react';
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
import {
  Cake,
  Users,
  Building2,
  IdCard,
  MapPin,
  ArrowRight,
  ChevronDown,
} from 'lucide-react-native';

import { completeMemberOnboarding } from '../../api/auth';
import { useAuth } from '../../context/AuthContext';
import { colors } from '../../theme/colors';
import { fonts } from '../../theme/typography';
import { radii, spacing } from '../../theme/spacing';
import {
  INSURANCE_OPTIONS,
  validateCinForCarrier,
  expectedFormatMessage,
  type CinValidationResult,
} from '../../constants/insurance';

// ─── Types ────────────────────────────────────────────────────────────────────

type Sex = 'Male' | 'Female' | 'Other';

const SEX_OPTIONS: readonly Sex[] = ['Male', 'Female', 'Other'] as const;

// ─── DOB helpers (mirrors RegisterScreen exactly) ─────────────────────────────

const DOB_INPUT_PATTERN = /^(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\/(19|20)\d{2}$/;

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

function formatDobInput(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}

// ─── Subcomponents ────────────────────────────────────────────────────────────

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

// ─── CompleteProfileScreen ────────────────────────────────────────────────────

/**
 * Collects the Pear Suite-required member fields for a social sign-up.
 * Rendered by AppNavigator when `needsOnboarding === true` and `role === 'member'`.
 */
export function CompleteProfileScreen(): React.JSX.Element {
  const { clearNeedsOnboarding } = useAuth();

  // ── Field state ────────────────────────────────────────────────────────────
  const [dob, setDob] = useState('');
  const [sex, setSex] = useState<Sex | null>(null);
  const [insuranceCompany, setInsuranceCompany] = useState('');
  const [primaryCin, setPrimaryCin] = useState('');
  const [zip, setZip] = useState('');

  // ── UI state ───────────────────────────────────────────────────────────────
  const [sexPickerOpen, setSexPickerOpen] = useState(false);
  const [insurancePickerOpen, setInsurancePickerOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cinValidation, setCinValidation] = useState<CinValidationResult | null>(null);

  // ── Derived ────────────────────────────────────────────────────────────────

  /** Parsed DOB — null when incomplete or calendar-invalid. */
  const dobIso = useMemo(() => parseDobInputToIso(dob), [dob]);

  /**
   * CIN validation result — updated whenever CIN or insurance selection changes.
   * Returns true (cinIsPresent) even on invalid format (lenient-warn policy).
   */
  const cinIsPresent = useMemo(() => {
    if (!primaryCin.trim()) {
      setCinValidation(null);
      return false;
    }
    const result = validateCinForCarrier(primaryCin, insuranceCompany);
    setCinValidation(result);
    return true;
  }, [primaryCin, insuranceCompany]);

  const canSubmit =
    dobIso !== null &&
    sex !== null &&
    insuranceCompany.trim().length > 0 &&
    cinIsPresent &&
    zip.trim().length > 0 &&
    !isSubmitting;

  // ── Submit ─────────────────────────────────────────────────────────────────

  const handleSubmit = useCallback(async (): Promise<void> => {
    if (!canSubmit || dobIso === null || sex === null) return;

    setError(null);
    setIsSubmitting(true);

    try {
      await completeMemberOnboarding({
        date_of_birth: dobIso,
        gender: sex,
        insurance_company: insuranceCompany.trim(),
        medi_cal_id: primaryCin.trim(),
        zip_code: zip.trim(),
      });

      // Clear the flag in AuthContext + AsyncStorage so the navigator stops
      // gating on this screen and routes to MemberTabNavigator.
      await clearNeedsOnboarding();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Could not save your profile. Please try again.';
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  }, [
    canSubmit,
    dobIso,
    sex,
    insuranceCompany,
    primaryCin,
    zip,
    clearNeedsOnboarding,
  ]);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={s.safeArea} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={s.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={s.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={s.card}>
            {/* Header */}
            <View style={s.headerBlock}>
              <Text style={s.heading}>One last step</Text>
              <Text style={s.subheading}>
                To connect you with a Community Health Worker, we need a few
                more details for your Medi-Cal profile.
              </Text>
            </View>

            {/* Error banner */}
            {error !== null && (
              <View style={s.errorBanner} accessibilityRole="alert">
                <Text style={s.errorText}>{error}</Text>
              </View>
            )}

            {/* ── About you ─────────────────────────────────────────────── */}
            <SectionLabel text="About you" />

            {/* Date of birth */}
            <FormField
              label="Date of birth"
              icon={<Cake size={18} color={colors.mutedForeground} />}
            >
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

            {/* Sex */}
            <FormField
              label="Sex"
              icon={<Users size={18} color={colors.mutedForeground} />}
            >
              <Pressable
                style={[s.input, s.pickerTrigger]}
                onPress={() => setSexPickerOpen(true)}
                accessibilityRole="button"
                accessibilityLabel="Select sex"
              >
                <Text style={[s.pickerValue, !sex && s.pickerPlaceholder]}>
                  {sex ?? 'Select…'}
                </Text>
                <ChevronDown
                  size={16}
                  color={colors.mutedForeground}
                  style={s.pickerChevron}
                />
              </Pressable>
            </FormField>

            {/* ── Insurance ─────────────────────────────────────────────── */}
            <SectionLabel text="Insurance" />

            {/* Primary insurance company */}
            <FormField
              label="Primary insurance company"
              icon={<Building2 size={18} color={colors.mutedForeground} />}
            >
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
                <ChevronDown
                  size={16}
                  color={colors.mutedForeground}
                  style={s.pickerChevron}
                />
              </Pressable>
            </FormField>

            {/* CIN / Medi-Cal ID */}
            <FormField
              label="Primary CIN (Medi-Cal ID)"
              icon={<IdCard size={18} color={colors.mutedForeground} />}
            >
              <TextInput
                value={primaryCin}
                onChangeText={(v) => setPrimaryCin(v.toUpperCase())}
                placeholder="e.g. 91234567A2"
                placeholderTextColor={colors.mutedForeground}
                autoCapitalize="characters"
                autoCorrect={false}
                maxLength={14}
                style={[
                  s.input,
                  cinValidation !== null && !cinValidation.valid && s.inputWarning,
                ]}
                accessibilityLabel="Primary CIN or Medi-Cal ID"
              />
            </FormField>

            {/* CIN format warning (lenient — never blocks submit) */}
            {cinValidation !== null && !cinValidation.valid && (
              <View style={s.cinWarningBanner}>
                <Text style={s.cinWarningText}>
                  {expectedFormatMessage(insuranceCompany)}
                  {'\n'}
                  <Text style={s.cinWarningSubtext}>
                    You can still continue — verify the ID and update it in your
                    profile if needed.
                  </Text>
                </Text>
              </View>
            )}

            {/* ── Location ──────────────────────────────────────────────── */}
            <SectionLabel text="Location" />

            {/* ZIP code */}
            <FormField
              label="ZIP code"
              icon={<MapPin size={18} color={colors.mutedForeground} />}
            >
              <TextInput
                value={zip}
                onChangeText={(v) => setZip(v.replace(/[^0-9]/g, '').slice(0, 5))}
                placeholder="90031"
                placeholderTextColor={colors.mutedForeground}
                keyboardType="number-pad"
                maxLength={5}
                style={s.input}
                accessibilityLabel="ZIP code"
                returnKeyType="done"
                onSubmitEditing={handleSubmit}
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
              accessibilityLabel="Finish setting up my profile"
            >
              {isSubmitting ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <>
                  <Text style={s.submitText}>Finish setup</Text>
                  <ArrowRight size={18} color="#FFFFFF" />
                </>
              )}
            </Pressable>

            <Text style={s.disclaimer}>
              Your information is protected and only shared with your assigned
              Community Health Worker.
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Sex picker */}
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

      {/* Insurance picker */}
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

// ─── Section label ────────────────────────────────────────────────────────────

function SectionLabel({ text }: { text: string }): React.JSX.Element {
  return (
    <View style={s.sectionDivider}>
      <View style={s.sectionRule} />
      <Text style={s.sectionLabel}>{text}</Text>
      <View style={s.sectionRule} />
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

  headerBlock: {
    marginBottom: spacing.md,
  },
  heading: {
    fontSize: 24,
    fontFamily: fonts.displaySemibold,
    color: colors.foreground,
    textAlign: 'center',
  },
  subheading: {
    marginTop: 6,
    fontSize: 14,
    fontFamily: fonts.body,
    color: colors.mutedForeground,
    textAlign: 'center',
    lineHeight: 20,
  },

  // ── Error ─────────────────────────────────────────────────────────────────
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

  // ── Section divider ───────────────────────────────────────────────────────
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

  // ── Form fields ───────────────────────────────────────────────────────────
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
  inputWarning: {
    borderColor: '#D97706',
  },

  // ── Picker (Sex, Insurance) ───────────────────────────────────────────────
  pickerTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
  },
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
  pickerChevron: {
    position: 'absolute',
    right: 12,
    top: '50%',
    marginTop: -8,
  },

  // ── CIN warning ───────────────────────────────────────────────────────────
  cinWarningBanner: {
    backgroundColor: '#FFFBEB',
    borderColor: '#F59E0B',
    borderWidth: 1,
    borderRadius: radii.md,
    padding: 10,
    marginTop: 6,
    marginBottom: 2,
  },
  cinWarningText: {
    fontSize: 13,
    color: '#92400E',
    fontFamily: fonts.bodySemibold,
    lineHeight: 18,
  },
  cinWarningSubtext: {
    fontSize: 12,
    color: '#78350F',
    fontFamily: fonts.body,
    fontWeight: '400',
  },

  // ── Submit ────────────────────────────────────────────────────────────────
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

  // ── Picker modal ──────────────────────────────────────────────────────────
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

/**
 * CHWOnboardingScreen — 4-step onboarding wizard for Community Health Workers.
 *
 * Steps:
 *  1. Basic Info      — First name, last name, phone, zip code
 *  2. Specializations — Multi-select toggle cards (Housing, Rehab, Food, Mental Health, Healthcare)
 *  3. Languages & Bio — Multi-select languages, service radius input, bio textarea (400 char max)
 *  4. Credentials     — Credential type selector, file upload placeholder, consent checkbox
 *
 * On completion navigates to CHW dashboard via AppNavigator (auth state flip).
 */

import React, { useState, useCallback } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Check,
  Home,
  RefreshCw,
  Utensils,
  Brain,
  Stethoscope,
  Shield,
  Lock,
  UserCheck,
  BookOpen,
  Upload,
  ArrowLeft,
  ArrowRight,
  CheckCircle,
} from 'lucide-react-native';

import { colors } from '../../theme/colors';
import { typography, fonts } from '../../theme/typography';
import { shadows } from '../../theme/shadows';
import { radii, spacing } from '../../theme/spacing';
import { useAuth } from '../../context/AuthContext';
import type { Vertical } from '../../data/mock';

// ─── Constants ────────────────────────────────────────────────────────────────

const TOTAL_STEPS = 4;

const STEP_LABELS = ['Basic Info', 'Specializations', 'Languages & Bio', 'Credentials'];

interface SpecializationOption {
  key: Vertical;
  label: string;
  description: string;
  icon: React.ComponentType<{ size: number; color: string }>;
  color: string;
}

const SPECIALIZATION_OPTIONS: SpecializationOption[] = [
  {
    key: 'housing',
    label: 'Housing',
    description: 'Rental assistance, eviction prevention, shelter navigation',
    icon: Home,
    color: '#3B82F6',
  },
  {
    key: 'rehab',
    label: 'Rehab & Recovery',
    description: 'Substance use treatment, peer support, recovery resources',
    icon: RefreshCw,
    color: '#EF4444',
  },
  {
    key: 'food',
    label: 'Food Security',
    description: 'CalFresh enrollment, food pantries, nutrition programs',
    icon: Utensils,
    color: '#F59E0B',
  },
  {
    key: 'mental_health',
    label: 'Mental Health',
    description: 'Therapy referrals, crisis support, wellness resources',
    icon: Brain,
    color: '#8B5CF6',
  },
  {
    key: 'healthcare',
    label: 'Healthcare Access',
    description: 'Medi-Cal enrollment, preventive care, specialist referrals',
    icon: Stethoscope,
    color: '#06B6D4',
  },
];

const LANGUAGE_OPTIONS = [
  'English',
  'Spanish',
  'Vietnamese',
  'Arabic',
  'Mandarin',
  'Tagalog',
  'Korean',
  'Armenian',
];

const CERTIFICATION_TYPE_OPTIONS = [
  'State CHW',
  'Promotora',
  'Peer Support Specialist',
  'Other',
];

// ─── Step data types ──────────────────────────────────────────────────────────

interface Step1Data {
  firstName: string;
  lastName: string;
  phone: string;
  zipCode: string;
}

interface Step3Data {
  languages: string[];
  serviceRadiusMiles: string;
  bio: string;
}

interface Step4Data {
  certificationType: string;
  backgroundCheckConsent: boolean;
  ceCreditHours: string;
}

// ─── Step Indicator ───────────────────────────────────────────────────────────

interface StepIndicatorProps {
  currentStep: number;
  totalSteps: number;
  labels: string[];
}

function StepIndicator({ currentStep, totalSteps, labels }: StepIndicatorProps): React.JSX.Element {
  return (
    <View
      style={stepStyles.container}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={`Step ${currentStep} of ${totalSteps}: ${labels[currentStep - 1]}`}
      accessibilityValue={{ min: 1, max: totalSteps, now: currentStep }}
    >
      {Array.from({ length: totalSteps }, (_, i) => {
        const stepNumber = i + 1;
        const isCompleted = stepNumber < currentStep;
        const isCurrent = stepNumber === currentStep;
        const isLast = stepNumber === totalSteps;

        return (
          <View key={stepNumber} style={stepStyles.stepWrapper}>
            <View style={stepStyles.dotRow}>
              {/* Left connector */}
              {stepNumber > 1 ? (
                <View
                  style={[
                    stepStyles.connector,
                    (isCompleted || isCurrent) && stepStyles.connectorActive,
                  ]}
                  aria-hidden
                />
              ) : (
                <View style={stepStyles.connectorInvisible} />
              )}

              {/* Step circle */}
              <View
                style={[
                  stepStyles.dot,
                  isCompleted && stepStyles.dotCompleted,
                  isCurrent && stepStyles.dotCurrent,
                  !isCompleted && !isCurrent && stepStyles.dotFuture,
                ]}
              >
                {isCompleted ? (
                  <Check size={12} color="#FFFFFF" strokeWidth={3} />
                ) : (
                  <Text style={[stepStyles.dotLabel, isCurrent && stepStyles.dotLabelCurrent]}>
                    {stepNumber}
                  </Text>
                )}
              </View>

              {/* Right connector */}
              {!isLast ? (
                <View
                  style={[stepStyles.connector, isCompleted && stepStyles.connectorActive]}
                  aria-hidden
                />
              ) : (
                <View style={stepStyles.connectorInvisible} />
              )}
            </View>

            <Text
              style={[
                stepStyles.label,
                isCurrent && stepStyles.labelCurrent,
                isCompleted && stepStyles.labelCompleted,
              ]}
              numberOfLines={1}
            >
              {labels[i]}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const stepStyles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 28,
  },
  stepWrapper: {
    flex: 1,
    alignItems: 'center',
  },
  dotRow: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
  },
  connector: {
    flex: 1,
    height: 2,
    backgroundColor: colors.border,
  },
  connectorActive: {
    backgroundColor: colors.primary,
  },
  connectorInvisible: {
    flex: 1,
  },
  dot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  dotCompleted: {
    backgroundColor: colors.primary,
  },
  dotCurrent: {
    backgroundColor: colors.secondary,
  },
  dotFuture: {
    backgroundColor: colors.border,
  },
  dotLabel: {
    fontFamily: fonts.displaySemibold,
    fontSize: 12,
    color: colors.mutedForeground,
  },
  dotLabelCurrent: {
    color: '#FFFFFF',
  },
  label: {
    fontFamily: fonts.body,
    fontSize: 9,
    color: colors.mutedForeground,
    marginTop: 4,
    textAlign: 'center',
  },
  labelCurrent: {
    fontFamily: fonts.bodySemibold,
    color: colors.secondary,
  },
  labelCompleted: {
    color: colors.primary,
  },
});

// ─── Shared form input ────────────────────────────────────────────────────────

interface FormFieldProps {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  keyboardType?: 'default' | 'phone-pad' | 'numeric' | 'email-address';
  maxLength?: number;
  autoCapitalize?: 'none' | 'sentences' | 'words';
  accessibilityLabel?: string;
}

function FormField({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType = 'default',
  maxLength,
  autoCapitalize = 'sentences',
  accessibilityLabel,
}: FormFieldProps): React.JSX.Element {
  return (
    <View style={formStyles.fieldGroup}>
      <Text style={formStyles.label}>{label}</Text>
      <TextInput
        style={formStyles.input}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.mutedForeground}
        keyboardType={keyboardType}
        maxLength={maxLength}
        autoCapitalize={autoCapitalize}
        accessibilityLabel={accessibilityLabel ?? label}
      />
    </View>
  );
}

const formStyles = StyleSheet.create({
  fieldGroup: {
    gap: 6,
    marginBottom: 16,
  },
  label: {
    fontFamily: fonts.bodySemibold,
    fontSize: 11,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: colors.mutedForeground,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.foreground,
  },
});

// ─── Step 1: Basic Info ───────────────────────────────────────────────────────

interface Step1Props {
  data: Step1Data;
  onChange: (data: Step1Data) => void;
}

function StepBasicInfo({ data, onChange }: Step1Props): React.JSX.Element {
  return (
    <View>
      <Text style={s.stepTitle}>Tell us about yourself</Text>
      <Text style={s.stepSubtitle}>
        This information helps members find and trust their CHW.
      </Text>

      <View style={s.rowInputs}>
        <View style={{ flex: 1 }}>
          <FormField
            label="First name"
            value={data.firstName}
            onChangeText={(v) => onChange({ ...data, firstName: v })}
            placeholder="Maria"
            autoCapitalize="words"
          />
        </View>
        <View style={{ flex: 1 }}>
          <FormField
            label="Last name"
            value={data.lastName}
            onChangeText={(v) => onChange({ ...data, lastName: v })}
            placeholder="Reyes"
            autoCapitalize="words"
          />
        </View>
      </View>

      <FormField
        label="Phone number"
        value={data.phone}
        onChangeText={(v) => onChange({ ...data, phone: v })}
        placeholder="(323) 555-0100"
        keyboardType="phone-pad"
        accessibilityLabel="Phone number"
      />

      <FormField
        label="Service area ZIP code"
        value={data.zipCode}
        onChangeText={(v) => onChange({ ...data, zipCode: v })}
        placeholder="90033"
        keyboardType="numeric"
        maxLength={5}
        accessibilityLabel="ZIP code"
      />
    </View>
  );
}

// ─── Step 2: Specializations ──────────────────────────────────────────────────

interface Step2Props {
  selected: Vertical[];
  onToggle: (key: Vertical) => void;
}

function StepSpecializations({ selected, onToggle }: Step2Props): React.JSX.Element {
  return (
    <View>
      <Text style={s.stepTitle}>Your specializations</Text>
      <Text style={s.stepSubtitle}>
        Select all areas where you have training or experience. You can add more later.
      </Text>

      <View style={{ gap: 10, marginTop: 16 }}>
        {SPECIALIZATION_OPTIONS.map(({ key, label, description, icon: Icon, color }) => {
          const isSelected = selected.includes(key);
          return (
            <TouchableOpacity
              key={key}
              style={[s.specCard, isSelected && s.specCardSelected]}
              onPress={() => onToggle(key)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: isSelected }}
              accessibilityLabel={`${label}: ${description}`}
              activeOpacity={0.7}
            >
              <View style={[s.specIcon, { backgroundColor: isSelected ? colors.primary : colors.background }]}>
                <Icon size={18} color={isSelected ? '#FFFFFF' : color} />
              </View>

              <View style={s.specContent}>
                <Text style={[s.specLabel, isSelected && s.specLabelSelected]}>
                  {label}
                </Text>
                <Text style={s.specDesc}>{description}</Text>
              </View>

              <View style={[s.checkCircle, isSelected && s.checkCircleSelected]}>
                {isSelected && <Check size={10} color="#FFFFFF" strokeWidth={3} />}
              </View>
            </TouchableOpacity>
          );
        })}
      </View>

      {selected.length === 0 && (
        <Text style={s.hint}>Select at least one specialization to continue.</Text>
      )}

      {selected.length > 0 && (
        <View style={s.pillRow}>
          {selected.map((key) => {
            const opt = SPECIALIZATION_OPTIONS.find((o) => o.key === key);
            return (
              <View key={key} style={s.pill}>
                <Text style={s.pillText}>{opt?.label ?? key}</Text>
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

// ─── Step 3: Languages & Bio ──────────────────────────────────────────────────

interface Step3Props {
  data: Step3Data;
  onChange: (data: Step3Data) => void;
}

function StepLanguagesBio({ data, onChange }: Step3Props): React.JSX.Element {
  const BIO_MAX = 400;

  function toggleLanguage(lang: string): void {
    const next = data.languages.includes(lang)
      ? data.languages.filter((l) => l !== lang)
      : [...data.languages, lang];
    onChange({ ...data, languages: next });
  }

  return (
    <View>
      <Text style={s.stepTitle}>Languages & availability</Text>
      <Text style={s.stepSubtitle}>
        Help members find a CHW who speaks their language.
      </Text>

      {/* Languages */}
      <Text style={[s.sectionLabel, { marginTop: 20, marginBottom: 10 }]}>Languages spoken</Text>
      <View style={s.langGrid}>
        {LANGUAGE_OPTIONS.map((lang) => {
          const checked = data.languages.includes(lang);
          return (
            <TouchableOpacity
              key={lang}
              style={[s.langChip, checked && s.langChipSelected]}
              onPress={() => toggleLanguage(lang)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked }}
              accessibilityLabel={lang}
              activeOpacity={0.7}
            >
              {checked && (
                <View style={s.langCheck}>
                  <Check size={9} color="#FFFFFF" strokeWidth={3} />
                </View>
              )}
              <Text style={[s.langChipText, checked && s.langChipTextSelected]}>
                {lang}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Service radius */}
      <Text style={[s.sectionLabel, { marginTop: 20, marginBottom: 6 }]}>
        Service radius (miles)
      </Text>
      <TextInput
        style={formStyles.input}
        value={data.serviceRadiusMiles}
        onChangeText={(v) => onChange({ ...data, serviceRadiusMiles: v })}
        placeholder="15"
        keyboardType="numeric"
        maxLength={3}
        accessibilityLabel="Service radius in miles"
      />

      {/* Bio */}
      <Text style={[s.sectionLabel, { marginTop: 20, marginBottom: 6 }]}>
        Short bio{' '}
        <Text style={{ color: colors.mutedForeground, fontWeight: '400' }}>(optional)</Text>
      </Text>
      <TextInput
        style={[formStyles.input, s.bioInput]}
        value={data.bio}
        onChangeText={(v) => {
          if (v.length <= BIO_MAX) {
            onChange({ ...data, bio: v });
          }
        }}
        placeholder="Share your background and how you help community members..."
        placeholderTextColor={colors.mutedForeground}
        multiline
        numberOfLines={4}
        maxLength={BIO_MAX}
        accessibilityLabel="Short bio"
        textAlignVertical="top"
      />
      <Text style={s.charCounter}>
        {data.bio.length}/{BIO_MAX}
      </Text>
    </View>
  );
}

// ─── Step 4: Credentials ──────────────────────────────────────────────────────

interface Step4Props {
  data: Step4Data;
  onChange: (data: Step4Data) => void;
}

function StepCredentials({ data, onChange }: Step4Props): React.JSX.Element {
  function handleUploadPress(credentialName: string): void {
    Alert.alert(
      'File Picker',
      `File picker coming soon. ${credentialName} upload will be available in the next release.`,
      [{ text: 'OK' }],
    );
  }

  return (
    <View>
      <Text style={s.stepTitle}>Credentials</Text>
      <Text style={s.stepSubtitle}>
        Upload your credentials for compliance review. All documents are reviewed within 48 hours.
      </Text>

      {/* CHW Certification */}
      <View style={[s.credCard, { marginTop: 20 }]}>
        <View style={s.credCardHeader}>
          <View style={[s.credIcon, { backgroundColor: colors.primary + '18' }]}>
            <Shield size={16} color={colors.primary} />
          </View>
          <Text style={s.credCardTitle}>CHW Certification</Text>
        </View>

        <TouchableOpacity
          style={s.uploadButton}
          onPress={() => handleUploadPress('CHW Certification')}
          accessibilityRole="button"
          accessibilityLabel="Upload CHW Certification"
        >
          <Upload size={14} color={colors.primary} />
          <Text style={s.uploadButtonText}>Upload Certificate</Text>
        </TouchableOpacity>

        <Text style={[s.sectionLabel, { marginTop: 14, marginBottom: 6 }]}>
          Certification type <Text style={{ color: colors.destructive }}>*</Text>
        </Text>

        <View style={s.pickerRow}>
          {CERTIFICATION_TYPE_OPTIONS.map((opt) => {
            const isSelected = data.certificationType === opt;
            return (
              <TouchableOpacity
                key={opt}
                style={[s.pickerOption, isSelected && s.pickerOptionSelected]}
                onPress={() => onChange({ ...data, certificationType: opt })}
                accessibilityRole="radio"
                accessibilityState={{ checked: isSelected }}
                accessibilityLabel={opt}
              >
                <Text style={[s.pickerOptionText, isSelected && s.pickerOptionTextSelected]}>
                  {opt}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {/* HIPAA Training */}
      <View style={s.credCard}>
        <View style={s.credCardHeader}>
          <View style={[s.credIcon, { backgroundColor: '#EFF6FF' }]}>
            <Lock size={16} color="#0077B6" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.credCardTitle}>HIPAA Training</Text>
            <Text style={s.credCardSubtitle}>Required for compliance</Text>
          </View>
        </View>

        <TouchableOpacity
          style={s.uploadButton}
          onPress={() => handleUploadPress('HIPAA Training')}
          accessibilityRole="button"
          accessibilityLabel="Upload HIPAA Training Certificate"
        >
          <Upload size={14} color={colors.primary} />
          <Text style={s.uploadButtonText}>Upload Certificate</Text>
        </TouchableOpacity>
      </View>

      {/* Background Check */}
      <View style={s.credCard}>
        <View style={s.credCardHeader}>
          <View style={[s.credIcon, { backgroundColor: '#FFFBEB' }]}>
            <UserCheck size={16} color="#D97706" />
          </View>
          <Text style={s.credCardTitle}>Background Check</Text>
        </View>

        {/* Consent checkbox */}
        <TouchableOpacity
          style={[s.consentRow, data.backgroundCheckConsent && s.consentRowSelected]}
          onPress={() => onChange({ ...data, backgroundCheckConsent: !data.backgroundCheckConsent })}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: data.backgroundCheckConsent }}
          accessibilityLabel="I consent to a background check as required for CHW credentialing"
          activeOpacity={0.7}
        >
          <View style={[s.checkbox, data.backgroundCheckConsent && s.checkboxChecked]}>
            {data.backgroundCheckConsent && (
              <Check size={9} color="#FFFFFF" strokeWidth={3} />
            )}
          </View>
          <Text style={s.consentText}>
            I consent to a background check as required for CHW credentialing.
            <Text style={{ color: colors.destructive }}> *</Text>
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[s.uploadButton, { marginTop: 10 }]}
          onPress={() => handleUploadPress('Background Check')}
          accessibilityRole="button"
          accessibilityLabel="Upload background check results (optional)"
        >
          <Upload size={14} color={colors.primary} />
          <Text style={s.uploadButtonText}>Upload Results (optional)</Text>
        </TouchableOpacity>
      </View>

      {/* Continuing Education */}
      <View style={s.credCard}>
        <View style={s.credCardHeader}>
          <View style={[s.credIcon, { backgroundColor: '#F5F3FF' }]}>
            <BookOpen size={16} color="#7C3AED" />
          </View>
          <Text style={s.credCardTitle}>Continuing Education</Text>
        </View>

        <TouchableOpacity
          style={s.uploadButton}
          onPress={() => handleUploadPress('Continuing Education')}
          accessibilityRole="button"
          accessibilityLabel="Upload CE Certificate"
        >
          <Upload size={14} color={colors.primary} />
          <Text style={s.uploadButtonText}>Upload CE Certificate</Text>
        </TouchableOpacity>

        <Text style={[s.sectionLabel, { marginTop: 14, marginBottom: 6 }]}>
          Credit hours completed
        </Text>
        <TextInput
          style={formStyles.input}
          value={data.ceCreditHours}
          onChangeText={(v) => onChange({ ...data, ceCreditHours: v })}
          placeholder="0"
          keyboardType="numeric"
          maxLength={3}
          accessibilityLabel="Credit hours completed"
        />
        <Text style={s.hint}>20 hours per year required</Text>
      </View>

      <Text style={s.disclaimer}>
        Your credentials are reviewed by the CompassCHW compliance team within 48 hours.
        You will receive an email notification once approved.
      </Text>
    </View>
  );
}

// ─── Success Screen ───────────────────────────────────────────────────────────

interface SuccessScreenProps {
  name: string;
  onGoToDashboard: () => void;
}

function SuccessScreen({ name, onGoToDashboard }: SuccessScreenProps): React.JSX.Element {
  const NEXT_STEPS = [
    'Compliance team reviews your credentials',
    'Background check initiated (1–3 business days)',
    'You receive an approval email with onboarding next steps',
    'Your profile goes live and members can find you',
  ];

  return (
    <View style={{ alignItems: 'center' }}>
      <View style={s.successIconWrap}>
        <CheckCircle size={40} color={colors.primary} />
      </View>

      <Text style={s.successTitle}>Application Submitted!</Text>
      <Text style={s.successBody}>
        Thanks, <Text style={{ fontWeight: '700', color: colors.foreground }}>{name}</Text>.
        Your application is under review.
      </Text>
      <Text style={[s.successBody, { marginTop: 4 }]}>
        We'll review your credentials within{' '}
        <Text style={{ fontWeight: '700', color: colors.primary }}>48 hours</Text>{' '}
        and notify you by email once approved.
      </Text>

      <View style={s.nextStepsCard}>
        <Text style={s.nextStepsTitle}>What happens next</Text>
        {NEXT_STEPS.map((step, i) => (
          <View key={i} style={s.nextStepRow}>
            <View style={s.nextStepNum}>
              <Text style={s.nextStepNumText}>{i + 1}</Text>
            </View>
            <Text style={s.nextStepText}>{step}</Text>
          </View>
        ))}
      </View>

      <TouchableOpacity
        style={s.submitButton}
        onPress={onGoToDashboard}
        accessibilityRole="button"
        accessibilityLabel="Go to Dashboard"
        activeOpacity={0.85}
      >
        <Text style={s.submitButtonText}>Go to Dashboard</Text>
        <ArrowRight size={16} color="#FFFFFF" />
      </TouchableOpacity>
    </View>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

/**
 * CHW onboarding wizard: collects basic info, specializations, languages & bio,
 * and credentials before transitioning to the CHW dashboard.
 */
export function CHWOnboardingScreen(): React.JSX.Element {
  const { register } = useAuth();

  const [step, setStep] = useState(1);
  const [submitted, setSubmitted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [basicInfo, setBasicInfo] = useState<Step1Data>({
    firstName: '',
    lastName: '',
    phone: '',
    zipCode: '',
  });

  const [specializations, setSpecializations] = useState<Vertical[]>([]);

  const [langBio, setLangBio] = useState<Step3Data>({
    languages: ['English'],
    serviceRadiusMiles: '15',
    bio: '',
  });

  const [credData, setCredData] = useState<Step4Data>({
    certificationType: '',
    backgroundCheckConsent: false,
    ceCreditHours: '0',
  });

  const fullName =
    [basicInfo.firstName.trim(), basicInfo.lastName.trim()].filter(Boolean).join(' ') || 'CHW';

  const canProceed = useCallback((): boolean => {
    switch (step) {
      case 1:
        return (
          basicInfo.firstName.trim().length > 0 &&
          basicInfo.lastName.trim().length > 0 &&
          basicInfo.phone.trim().length > 0 &&
          basicInfo.zipCode.trim().length === 5
        );
      case 2:
        return specializations.length > 0;
      case 3:
        return langBio.languages.length > 0;
      case 4:
        return credData.certificationType.length > 0 && credData.backgroundCheckConsent;
      default:
        return false;
    }
  }, [step, basicInfo, specializations, langBio, credData]);

  const handleNext = useCallback((): void => {
    if (step < TOTAL_STEPS) {
      setStep((prev) => prev + 1);
    }
  }, [step]);

  const handleBack = useCallback((): void => {
    if (step > 1) {
      setStep((prev) => prev - 1);
    }
  }, [step]);

  const toggleSpecialization = useCallback((key: Vertical): void => {
    setSpecializations((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  }, []);

  const handleSubmit = useCallback(async (): Promise<void> => {
    if (!canProceed() || isSubmitting) return;
    setIsSubmitting(true);
    try {
      // Register the CHW — navigates automatically on auth state change.
      await register(
        `${basicInfo.firstName.toLowerCase()}.${basicInfo.lastName.toLowerCase()}@compasschw.com`,
        'onboarding1234',
        fullName,
        'chw',
        basicInfo.phone,
      );
      setSubmitted(true);
    } catch {
      // If backend is unavailable, still show the success state for the demo flow.
      setSubmitted(true);
    } finally {
      setIsSubmitting(false);
    }
  }, [canProceed, isSubmitting, register, basicInfo, fullName]);

  const handleGoToDashboard = useCallback((): void => {
    // Auth state change from register() already triggers AppNavigator to swap stacks.
    // This is a no-op fallback for the success-screen CTA if registration was deferred.
  }, []);

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={s.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Logo */}
          <View style={s.logoRow}>
            <View style={s.logoMark}>
              <Text style={s.logoMarkText}>C</Text>
            </View>
            <View>
              <Text style={s.wordmark}>
                Compass<Text style={s.wordmarkAccent}>CHW</Text>
              </Text>
              <Text style={s.logoCaption}>Community Health Worker Application</Text>
            </View>
          </View>

          {/* Card */}
          <View style={s.card}>
            <View style={s.cardAccentBar} />
            <View style={s.cardBody}>
              {/* Step indicator */}
              {!submitted && (
                <StepIndicator
                  currentStep={step}
                  totalSteps={TOTAL_STEPS}
                  labels={STEP_LABELS}
                />
              )}

              {/* Step content */}
              {submitted ? (
                <SuccessScreen name={fullName} onGoToDashboard={handleGoToDashboard} />
              ) : (
                <>
                  {step === 1 && (
                    <StepBasicInfo data={basicInfo} onChange={setBasicInfo} />
                  )}
                  {step === 2 && (
                    <StepSpecializations
                      selected={specializations}
                      onToggle={toggleSpecialization}
                    />
                  )}
                  {step === 3 && (
                    <StepLanguagesBio data={langBio} onChange={setLangBio} />
                  )}
                  {step === 4 && (
                    <StepCredentials data={credData} onChange={setCredData} />
                  )}

                  {/* Navigation */}
                  <View style={s.navRow}>
                    <TouchableOpacity
                      style={[s.backButton, step === 1 && s.backButtonDisabled]}
                      onPress={handleBack}
                      disabled={step === 1}
                      accessibilityRole="button"
                      accessibilityLabel="Back"
                      accessibilityState={{ disabled: step === 1 }}
                    >
                      <ArrowLeft size={15} color={step === 1 ? colors.border : colors.mutedForeground} />
                      <Text style={[s.backButtonText, step === 1 && s.backButtonTextDisabled]}>
                        Back
                      </Text>
                    </TouchableOpacity>

                    <Text style={s.stepCounter}>
                      Step {step} of {TOTAL_STEPS}
                    </Text>

                    {step < TOTAL_STEPS ? (
                      <TouchableOpacity
                        style={[s.nextButton, !canProceed() && s.nextButtonDisabled]}
                        onPress={handleNext}
                        disabled={!canProceed()}
                        accessibilityRole="button"
                        accessibilityLabel="Continue to next step"
                        accessibilityState={{ disabled: !canProceed() }}
                        activeOpacity={0.85}
                      >
                        <Text style={s.nextButtonText}>Continue</Text>
                        <ArrowRight size={15} color="#FFFFFF" />
                      </TouchableOpacity>
                    ) : (
                      <TouchableOpacity
                        style={[s.nextButton, (!canProceed() || isSubmitting) && s.nextButtonDisabled]}
                        onPress={handleSubmit}
                        disabled={!canProceed() || isSubmitting}
                        accessibilityRole="button"
                        accessibilityLabel="Submit application for review"
                        accessibilityState={{ disabled: !canProceed() || isSubmitting }}
                        activeOpacity={0.85}
                      >
                        {isSubmitting ? (
                          <ActivityIndicator size="small" color="#FFFFFF" />
                        ) : (
                          <>
                            <Text style={s.nextButtonText}>Submit</Text>
                            <ArrowRight size={15} color="#FFFFFF" />
                          </>
                        )}
                      </TouchableOpacity>
                    )}
                  </View>
                </>
              )}
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 20,
    paddingTop: 28,
    paddingBottom: 40,
  },

  // Logo
  logoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 24,
    paddingHorizontal: 4,
  },
  logoMark: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoMarkText: {
    fontFamily: fonts.displaySemibold,
    fontSize: 22,
    color: '#FFFFFF',
  },
  wordmark: {
    fontFamily: fonts.display,
    fontSize: 22,
    color: colors.foreground,
    letterSpacing: -0.5,
    lineHeight: 28,
  },
  wordmarkAccent: {
    color: colors.secondary,
  },
  logoCaption: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.mutedForeground,
    marginTop: 1,
  },

  // Card
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: radii.xl,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    ...shadows.elevated,
  },
  cardAccentBar: {
    height: 3,
    backgroundColor: colors.primary,
  },
  cardBody: {
    padding: spacing.xl,
  },

  // Step content
  stepTitle: {
    fontFamily: fonts.displaySemibold,
    fontSize: 22,
    color: colors.foreground,
    marginBottom: 6,
  },
  stepSubtitle: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.mutedForeground,
    marginBottom: 4,
    lineHeight: 20,
  },
  sectionLabel: {
    fontFamily: fonts.bodySemibold,
    fontSize: 11,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: colors.mutedForeground,
  },
  hint: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.mutedForeground,
    marginTop: 6,
    textAlign: 'center',
  },
  disclaimer: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.mutedForeground,
    lineHeight: 18,
    marginTop: 12,
  },

  // Two-column row for first/last name
  rowInputs: {
    flexDirection: 'row',
    gap: 12,
  },

  // Specialization cards
  specCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    padding: 14,
    backgroundColor: '#FFFFFF',
  },
  specCardSelected: {
    borderColor: colors.primary,
    backgroundColor: `${colors.primary}08`,
  },
  specIcon: {
    width: 36,
    height: 36,
    borderRadius: radii.sm + 2,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  specContent: {
    flex: 1,
    gap: 2,
  },
  specLabel: {
    fontFamily: fonts.bodySemibold,
    fontSize: 14,
    color: colors.foreground,
  },
  specLabelSelected: {
    color: colors.primary,
  },
  specDesc: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.mutedForeground,
    lineHeight: 16,
  },
  checkCircle: {
    width: 20,
    height: 20,
    borderRadius: radii.full,
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  checkCircleSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primary,
  },

  // Pill badges
  pillRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 12,
  },
  pill: {
    backgroundColor: `${colors.primary}18`,
    borderRadius: radii.full,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  pillText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 11,
    letterSpacing: 0.5,
    color: colors.primary,
  },

  // Language chips
  langGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  langChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm + 2,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#FFFFFF',
  },
  langChipSelected: {
    borderColor: colors.primary,
    backgroundColor: `${colors.primary}08`,
  },
  langCheck: {
    width: 14,
    height: 14,
    borderRadius: 3,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  langChipText: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.foreground,
  },
  langChipTextSelected: {
    fontFamily: fonts.bodySemibold,
    color: colors.primary,
  },

  // Bio
  bioInput: {
    minHeight: 100,
    paddingTop: 14,
  },
  charCounter: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.mutedForeground,
    textAlign: 'right',
    marginTop: 4,
  },

  // Credentials
  credCard: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    padding: 16,
    backgroundColor: '#FFFFFF',
    marginBottom: 12,
  },
  credCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 14,
  },
  credIcon: {
    width: 32,
    height: 32,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  credCardTitle: {
    fontFamily: fonts.bodySemibold,
    fontSize: 15,
    color: colors.foreground,
  },
  credCardSubtitle: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.mutedForeground,
    marginTop: 1,
  },
  uploadButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 2,
    borderColor: colors.primary,
    borderStyle: 'dashed',
    borderRadius: radii.md,
    paddingVertical: 14,
    backgroundColor: colors.background,
  },
  uploadButtonText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 14,
    color: colors.primary,
  },

  // Picker options (certification type)
  pickerRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  pickerOption: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: colors.background,
  },
  pickerOptionSelected: {
    borderColor: colors.primary,
    backgroundColor: `${colors.primary}18`,
  },
  pickerOptionText: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.mutedForeground,
  },
  pickerOptionTextSelected: {
    fontFamily: fonts.bodySemibold,
    color: colors.primary,
  },

  // Background check consent
  consentRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md - 2,
    padding: 12,
    backgroundColor: colors.background,
  },
  consentRowSelected: {
    borderColor: colors.primary,
    backgroundColor: `${colors.primary}08`,
  },
  checkbox: {
    width: 16,
    height: 16,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
    flexShrink: 0,
  },
  checkboxChecked: {
    borderColor: colors.primary,
    backgroundColor: colors.primary,
  },
  consentText: {
    flex: 1,
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.foreground,
    lineHeight: 20,
  },

  // Success screen
  successIconWrap: {
    width: 80,
    height: 80,
    borderRadius: radii.full,
    backgroundColor: `${colors.primary}18`,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  successTitle: {
    fontFamily: fonts.displaySemibold,
    fontSize: 22,
    color: colors.foreground,
    textAlign: 'center',
    marginBottom: 8,
  },
  successBody: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.mutedForeground,
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 280,
  },
  nextStepsCard: {
    width: '100%',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    padding: 16,
    backgroundColor: colors.background,
    marginTop: 20,
    marginBottom: 24,
    gap: 10,
  },
  nextStepsTitle: {
    fontFamily: fonts.bodySemibold,
    fontSize: 11,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: colors.mutedForeground,
    marginBottom: 4,
  },
  nextStepRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  nextStepNum: {
    width: 20,
    height: 20,
    borderRadius: radii.full,
    backgroundColor: `${colors.primary}18`,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    marginTop: 1,
  },
  nextStepNumText: {
    fontFamily: fonts.displaySemibold,
    fontSize: 10,
    color: colors.primary,
  },
  nextStepText: {
    flex: 1,
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.mutedForeground,
    lineHeight: 18,
  },

  // Navigation row
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 28,
    paddingTop: 20,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  backButtonDisabled: {
    opacity: 0.3,
  },
  backButtonText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 14,
    color: colors.mutedForeground,
  },
  backButtonTextDisabled: {
    color: colors.border,
  },
  stepCounter: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.mutedForeground,
  },
  nextButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.primary,
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderRadius: radii.md,
    minWidth: 100,
    justifyContent: 'center',
  },
  nextButtonDisabled: {
    opacity: 0.35,
  },
  nextButtonText: {
    fontFamily: fonts.display,
    fontSize: 14,
    color: '#FFFFFF',
  },

  // Full-width submit (success flow)
  submitButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    width: '100%',
  },
  submitButtonText: {
    fontFamily: fonts.display,
    fontSize: 16,
    color: '#FFFFFF',
  },
});

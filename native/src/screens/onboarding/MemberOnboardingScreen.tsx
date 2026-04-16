/**
 * MemberOnboardingScreen — 4-step onboarding wizard for members.
 *
 * Steps:
 *  1. Basic Info      — First name, ZIP code, preferred language
 *  2. Health Needs    — SDOH checkboxes (Housing, Food, Transportation, Employment,
 *                       Insurance, Mental Health) + urgency radio buttons
 *  3. Insurance       — Insurance provider selector + urgency level radio buttons
 *  4. Welcome         — Completion screen with reward points earned and "What's next" list
 *
 * On step 4, navigates to member dashboard via AppNavigator (auth state flip).
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Check,
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  Sparkles,
  Star,
  Zap,
  Search,
  Calendar,
  Target,
} from 'lucide-react-native';

import { colors } from '../../theme/colors';
import { typography, fonts } from '../../theme/typography';
import { shadows } from '../../theme/shadows';
import { radii, spacing } from '../../theme/spacing';
import { useAuth } from '../../context/AuthContext';

// ─── Constants ────────────────────────────────────────────────────────────────

const TOTAL_STEPS = 4;

const STEP_LABELS = ['Basic Info', 'Health', 'Insurance', 'Welcome'];

const LANGUAGE_OPTIONS = [
  'English',
  'Spanish',
  'Vietnamese',
  'Arabic',
  'Mandarin',
  'Korean',
  'Tagalog',
  'Other',
];

const INSURANCE_PROVIDER_OPTIONS = [
  'Medi-Cal',
  'LA Care',
  'Molina Healthcare',
  'Health Net',
  'Blue Shield of CA',
  'Kaiser Permanente',
  'Other',
  'None / Uninsured',
];

interface SdohItem {
  key: string;
  label: string;
  sublabel: string;
}

const SDOH_ITEMS: SdohItem[] = [
  {
    key: 'housing',
    label: 'Housing stability',
    sublabel: 'Difficulty paying rent, eviction risk, or unsafe living conditions',
  },
  {
    key: 'food',
    label: 'Food access',
    sublabel: 'Trouble affording or obtaining enough food for your household',
  },
  {
    key: 'transportation',
    label: 'Transportation',
    sublabel: 'Difficulty getting to medical appointments or work',
  },
  {
    key: 'employment',
    label: 'Employment',
    sublabel: 'Unemployment, job instability, or income challenges',
  },
  {
    key: 'insurance',
    label: 'Health insurance',
    sublabel: 'Uninsured or trouble navigating your coverage',
  },
  {
    key: 'mental_health',
    label: 'Mental health support',
    sublabel: 'Access to counseling, therapy, or crisis resources',
  },
];

type UrgencyLevel = 'low' | 'medium' | 'high';

interface UrgencyOption {
  value: UrgencyLevel;
  label: string;
  description: string;
  color: string;
}

const URGENCY_OPTIONS: UrgencyOption[] = [
  {
    value: 'low',
    label: 'I can plan ahead',
    description: 'No immediate crisis — looking to improve my situation over time',
    color: colors.mutedForeground,
  },
  {
    value: 'medium',
    label: 'I need help soon',
    description: 'Challenging situation that needs attention in the next few weeks',
    color: '#F59E0B',
  },
  {
    value: 'high',
    label: 'I need help urgently',
    description: 'In crisis or facing an immediate threat to housing, health, or safety',
    color: colors.destructive,
  },
];

const REWARDS_POINTS = 100;

// ─── Step data types ──────────────────────────────────────────────────────────

interface Step1Data {
  firstName: string;
  zipCode: string;
  preferredLanguage: string;
}

interface Step2Data {
  sdohChallenges: string[];
  urgency: UrgencyLevel | '';
}

interface Step3Data {
  insuranceProvider: string;
  urgency: UrgencyLevel | '';
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
              {stepNumber > 1 ? (
                <View
                  style={[
                    stepStyles.connector,
                    (isCompleted || isCurrent) && stepStyles.connectorActive,
                  ]}
                />
              ) : (
                <View style={stepStyles.connectorInvisible} />
              )}

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

              {!isLast ? (
                <View
                  style={[stepStyles.connector, isCompleted && stepStyles.connectorActive]}
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

// ─── Language picker (custom dropdown-style list) ─────────────────────────────

interface LanguagePickerProps {
  value: string;
  onChange: (lang: string) => void;
}

function LanguagePicker({ value, onChange }: LanguagePickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <View>
      <TouchableOpacity
        style={s.pickerTrigger}
        onPress={() => setOpen((prev) => !prev)}
        accessibilityRole="combobox"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={value ? `Selected language: ${value}` : 'Select a language'}
        activeOpacity={0.7}
      >
        <Text style={[s.pickerTriggerText, !value && s.pickerTriggerPlaceholder]}>
          {value || 'Select a language'}
        </Text>
        <ChevronDown size={16} color={colors.mutedForeground} />
      </TouchableOpacity>

      {open && (
        <View style={s.pickerDropdown}>
          {LANGUAGE_OPTIONS.map((lang) => (
            <TouchableOpacity
              key={lang}
              style={[s.pickerItem, value === lang && s.pickerItemSelected]}
              onPress={() => {
                onChange(lang);
                setOpen(false);
              }}
              accessibilityRole="menuitem"
              accessibilityState={{ selected: value === lang }}
              accessibilityLabel={lang}
            >
              <Text style={[s.pickerItemText, value === lang && s.pickerItemTextSelected]}>
                {lang}
              </Text>
              {value === lang && <Check size={14} color={colors.primary} />}
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
}

// ─── Insurance provider picker ────────────────────────────────────────────────

interface InsurancePickerProps {
  value: string;
  onChange: (provider: string) => void;
}

function InsurancePicker({ value, onChange }: InsurancePickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <View>
      <TouchableOpacity
        style={s.pickerTrigger}
        onPress={() => setOpen((prev) => !prev)}
        accessibilityRole="combobox"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={value ? `Selected insurance: ${value}` : 'Select insurance provider'}
        activeOpacity={0.7}
      >
        <Text style={[s.pickerTriggerText, !value && s.pickerTriggerPlaceholder]}>
          {value || 'Select your provider (or skip)'}
        </Text>
        <ChevronDown size={16} color={colors.mutedForeground} />
      </TouchableOpacity>

      {open && (
        <View style={s.pickerDropdown}>
          {INSURANCE_PROVIDER_OPTIONS.map((opt) => (
            <TouchableOpacity
              key={opt}
              style={[s.pickerItem, value === opt && s.pickerItemSelected]}
              onPress={() => {
                onChange(opt);
                setOpen(false);
              }}
              accessibilityRole="menuitem"
              accessibilityState={{ selected: value === opt }}
              accessibilityLabel={opt}
            >
              <Text style={[s.pickerItemText, value === opt && s.pickerItemTextSelected]}>
                {opt}
              </Text>
              {value === opt && <Check size={14} color={colors.primary} />}
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
}

// ─── Step 1: Basic Info ───────────────────────────────────────────────────────

interface Step1Props {
  data: Step1Data;
  onChange: (data: Step1Data) => void;
}

function StepBasicInfo({ data, onChange }: Step1Props): React.JSX.Element {
  return (
    <View>
      <Text style={s.stepTitle}>Welcome to CompassCHW</Text>
      <Text style={s.stepSubtitle}>
        Let's get you set up. A few quick questions to connect you with the right support.
      </Text>

      <View style={s.fieldGroup}>
        <Text style={s.fieldLabel}>First name</Text>
        <TextInput
          style={s.input}
          value={data.firstName}
          onChangeText={(v) => onChange({ ...data, firstName: v })}
          placeholder="Rosa"
          placeholderTextColor={colors.mutedForeground}
          autoCapitalize="words"
          autoComplete="given-name"
          accessibilityLabel="First name"
        />
      </View>

      <View style={s.fieldGroup}>
        <Text style={s.fieldLabel}>ZIP code</Text>
        <TextInput
          style={s.input}
          value={data.zipCode}
          onChangeText={(v) => onChange({ ...data, zipCode: v })}
          placeholder="90031"
          placeholderTextColor={colors.mutedForeground}
          keyboardType="numeric"
          maxLength={5}
          accessibilityLabel="ZIP code"
        />
        <Text style={s.fieldHint}>Used to find CHWs near you.</Text>
      </View>

      <View style={s.fieldGroup}>
        <Text style={s.fieldLabel}>Preferred language</Text>
        <LanguagePicker
          value={data.preferredLanguage}
          onChange={(lang) => onChange({ ...data, preferredLanguage: lang })}
        />
      </View>
    </View>
  );
}

// ─── Step 2: Health Needs ─────────────────────────────────────────────────────

interface Step2Props {
  data: Step2Data;
  onChange: (data: Step2Data) => void;
}

function StepHealthNeeds({ data, onChange }: Step2Props): React.JSX.Element {
  function toggleChallenge(key: string): void {
    const next = data.sdohChallenges.includes(key)
      ? data.sdohChallenges.filter((k) => k !== key)
      : [...data.sdohChallenges, key];
    onChange({ ...data, sdohChallenges: next });
  }

  return (
    <View>
      <Text style={s.stepTitle}>Health & needs assessment</Text>
      <Text style={s.stepSubtitle}>
        In the past 12 months, have you had difficulty with any of the following?{' '}
        (select all that apply)
      </Text>

      <View style={{ gap: 8, marginTop: 16 }}>
        {SDOH_ITEMS.map(({ key, label, sublabel }) => {
          const checked = data.sdohChallenges.includes(key);
          return (
            <TouchableOpacity
              key={key}
              style={[s.sdohCard, checked && s.sdohCardChecked]}
              onPress={() => toggleChallenge(key)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked }}
              accessibilityLabel={`${label}: ${sublabel}`}
              activeOpacity={0.7}
            >
              <View style={[s.checkbox, checked && s.checkboxChecked]}>
                {checked && <Check size={9} color="#FFFFFF" strokeWidth={3} />}
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={[s.sdohLabel, checked && s.sdohLabelChecked]}>{label}</Text>
                <Text style={s.sdohSublabel}>{sublabel}</Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </View>

      <Text style={[s.fieldLabel, { marginTop: 20, marginBottom: 10 }]}>
        How urgent is your need for support?
      </Text>

      <View style={{ gap: 8 }}>
        {URGENCY_OPTIONS.map(({ value, label, description, color }) => {
          const selected = data.urgency === value;
          return (
            <TouchableOpacity
              key={value}
              style={[s.urgencyCard, selected && s.urgencyCardSelected]}
              onPress={() => onChange({ ...data, urgency: value })}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              accessibilityLabel={`${label}: ${description}`}
              activeOpacity={0.7}
            >
              <View style={[s.radioCircle, selected && s.radioCircleSelected]}>
                {selected && <View style={s.radioInner} />}
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={[s.urgencyLabel, selected && { color }]}>{label}</Text>
                <Text style={s.urgencyDesc}>{description}</Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

// ─── Step 3: Insurance ────────────────────────────────────────────────────────

interface Step3Props {
  data: Step3Data;
  onChange: (data: Step3Data) => void;
}

function StepInsurance({ data, onChange }: Step3Props): React.JSX.Element {
  return (
    <View>
      <Text style={s.stepTitle}>Insurance information</Text>
      <Text style={s.stepSubtitle}>
        Optional — sharing your insurance helps CHWs coordinate care that's covered for you.
      </Text>

      <View style={[s.fieldGroup, { marginTop: 20 }]}>
        <Text style={s.fieldLabel}>
          Insurance provider{' '}
          <Text style={{ color: colors.mutedForeground, fontWeight: '400' }}>(optional)</Text>
        </Text>
        <InsurancePicker
          value={data.insuranceProvider}
          onChange={(v) => onChange({ ...data, insuranceProvider: v })}
        />
      </View>

      <View style={s.infoCallout}>
        <Text style={s.infoCalloutTitle}>Why we ask</Text>
        <Text style={s.infoCalloutBody}>
          CHWs can bill Medi-Cal for services on your behalf. Knowing your plan lets them
          check covered services before your session — at no cost to you.
        </Text>
      </View>
    </View>
  );
}

// ─── Step 4: Welcome ──────────────────────────────────────────────────────────

interface Step4Props {
  firstName: string;
  onGetStarted: () => void;
}

function StepWelcome({ firstName, onGetStarted }: Step4Props): React.JSX.Element {
  const [pointsDisplayed, setPointsDisplayed] = useState(0);

  // Count-up animation for reward points
  useEffect(() => {
    const DURATION = 1200;
    const STEP_COUNT = 40;
    const stepValue = REWARDS_POINTS / STEP_COUNT;
    const stepTime = DURATION / STEP_COUNT;
    let current = 0;

    const timer = setInterval(() => {
      current += stepValue;
      if (current >= REWARDS_POINTS) {
        setPointsDisplayed(REWARDS_POINTS);
        clearInterval(timer);
      } else {
        setPointsDisplayed(Math.floor(current));
      }
    }, stepTime);

    return () => clearInterval(timer);
  }, []);

  const WHATS_NEXT = [
    { icon: Search, text: 'Browse CHWs matched to your needs and location' },
    { icon: Calendar, text: 'Schedule a free intro session in person, virtual, or by phone' },
    { icon: Target, text: 'Set goals and track your progress over time' },
    { icon: Star, text: 'Earn more points for every session and milestone' },
  ];

  return (
    <View style={{ alignItems: 'center' }}>
      {/* Sparkle icon */}
      <View style={s.welcomeIconWrap}>
        <Sparkles size={36} color={colors.primary} />
      </View>

      <Text style={s.welcomeTitle}>
        Welcome to CompassCHW{firstName ? `, ${firstName}` : ''}!
      </Text>
      <Text style={s.welcomeSubtitle}>
        Your profile is all set. We're matching you with Community Health Workers in
        your area who speak your language.
      </Text>

      {/* Points award card */}
      <View style={s.pointsCard}>
        <View style={s.pointsCardHeader}>
          <Zap size={16} color={colors.compassGold} />
          <Text style={s.pointsCardLabel}>Engagement Points Earned</Text>
          <Zap size={16} color={colors.compassGold} />
        </View>

        <View style={s.pointsRow}>
          <Text
            style={s.pointsNumber}
            accessibilityLabel={`${pointsDisplayed} engagement points earned`}
            accessibilityLiveRegion="polite"
          >
            {pointsDisplayed}
          </Text>
          <Text style={s.pointsUnit}>pts</Text>
        </View>

        <Text style={s.pointsSubtext}>for completing your profile</Text>

        <View style={s.starsRow}>
          {Array.from({ length: 5 }).map((_, i) => (
            <Star key={i} size={14} color={colors.compassGold} fill={colors.compassGold} />
          ))}
        </View>
      </View>

      {/* What's next */}
      <Text style={s.whatsNextTitle}>What's next</Text>
      <View style={s.whatsNextList}>
        {WHATS_NEXT.map(({ icon: Icon, text }, i) => (
          <View key={i} style={s.whatsNextItem}>
            <Icon size={16} color={colors.secondary} />
            <Text style={s.whatsNextText}>{text}</Text>
          </View>
        ))}
      </View>

      <TouchableOpacity
        style={s.getStartedButton}
        onPress={onGetStarted}
        accessibilityRole="button"
        accessibilityLabel="Get Started"
        activeOpacity={0.85}
      >
        <Text style={s.getStartedButtonText}>Get Started</Text>
        <ArrowRight size={16} color="#FFFFFF" />
      </TouchableOpacity>
    </View>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

/**
 * Member onboarding wizard — 4-step flow: basic info, health assessment,
 * insurance, and welcome screen. Registers member via AuthContext then
 * AppNavigator swaps to the authenticated member stack.
 */
export function MemberOnboardingScreen(): React.JSX.Element {
  const { register } = useAuth();

  const [step, setStep] = useState(1);

  const [basicInfo, setBasicInfo] = useState<Step1Data>({
    firstName: '',
    zipCode: '',
    preferredLanguage: '',
  });

  const [healthData, setHealthData] = useState<Step2Data>({
    sdohChallenges: [],
    urgency: '',
  });

  const [insuranceData, setInsuranceData] = useState<Step3Data>({
    insuranceProvider: '',
    urgency: '',
  });

  const isWelcomeStep = step === TOTAL_STEPS;

  const canProceed = useCallback((): boolean => {
    switch (step) {
      case 1:
        return (
          basicInfo.firstName.trim().length > 0 &&
          basicInfo.zipCode.trim().length === 5 &&
          basicInfo.preferredLanguage.length > 0
        );
      case 2:
        return healthData.sdohChallenges.length > 0 || healthData.urgency !== '';
      case 3:
        return true; // Insurance is optional
      default:
        return false;
    }
  }, [step, basicInfo, healthData]);

  const handleNext = useCallback(async (): Promise<void> => {
    if (step === 3) {
      // Register before welcome step
      try {
        await register(
          `${basicInfo.firstName.toLowerCase().replace(/\s+/g, '.')}@compasschw.com`,
          'onboarding1234',
          basicInfo.firstName.trim(),
          'member',
        );
      } catch {
        // Continue to welcome step even if backend is unavailable (demo mode).
      }
    }
    if (step < TOTAL_STEPS) {
      setStep((prev) => prev + 1);
    }
  }, [step, basicInfo, register]);

  const handleBack = useCallback((): void => {
    if (step > 1) {
      setStep((prev) => prev - 1);
    }
  }, [step]);

  const handleGetStarted = useCallback((): void => {
    // Auth state already flipped by register() — AppNavigator handles navigation.
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
              <Text style={s.logoCaption}>
                {isWelcomeStep ? "You're all set!" : 'New member setup — takes about 2 minutes'}
              </Text>
            </View>
          </View>

          {/* Card */}
          <View style={s.card}>
            <View style={s.cardAccentBar} />
            <View style={s.cardBody}>
              {/* Step indicator */}
              <StepIndicator
                currentStep={step}
                totalSteps={TOTAL_STEPS}
                labels={STEP_LABELS}
              />

              {/* Step content */}
              {step === 1 && (
                <StepBasicInfo data={basicInfo} onChange={setBasicInfo} />
              )}
              {step === 2 && (
                <StepHealthNeeds data={healthData} onChange={setHealthData} />
              )}
              {step === 3 && (
                <StepInsurance data={insuranceData} onChange={setInsuranceData} />
              )}
              {step === 4 && (
                <StepWelcome
                  firstName={basicInfo.firstName.trim()}
                  onGetStarted={handleGetStarted}
                />
              )}

              {/* Navigation — hidden on welcome step (it has its own CTA) */}
              {!isWelcomeStep && (
                <View style={s.navRow}>
                  <TouchableOpacity
                    style={[s.backButton, step === 1 && s.backButtonDisabled]}
                    onPress={handleBack}
                    disabled={step === 1}
                    accessibilityRole="button"
                    accessibilityLabel="Back"
                    accessibilityState={{ disabled: step === 1 }}
                  >
                    <ArrowLeft
                      size={15}
                      color={step === 1 ? colors.border : colors.mutedForeground}
                    />
                    <Text style={[s.backButtonText, step === 1 && s.backButtonTextDisabled]}>
                      Back
                    </Text>
                  </TouchableOpacity>

                  <Text style={s.stepCounter}>
                    Step {step} of {TOTAL_STEPS - 1}
                  </Text>

                  <TouchableOpacity
                    style={[s.nextButton, !canProceed() && s.nextButtonDisabled]}
                    onPress={handleNext}
                    disabled={!canProceed()}
                    accessibilityRole="button"
                    accessibilityLabel={step === 3 ? 'Finish setup' : 'Continue to next step'}
                    accessibilityState={{ disabled: !canProceed() }}
                    activeOpacity={0.85}
                  >
                    <Text style={s.nextButtonText}>{step === 3 ? 'Finish' : 'Continue'}</Text>
                    <ArrowRight size={15} color="#FFFFFF" />
                  </TouchableOpacity>
                </View>
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

  // Form fields
  fieldGroup: {
    marginBottom: 16,
    gap: 6,
  },
  fieldLabel: {
    fontFamily: fonts.bodySemibold,
    fontSize: 11,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: colors.mutedForeground,
  },
  fieldHint: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.mutedForeground,
    marginTop: 4,
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

  // Custom picker
  pickerTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
  },
  pickerTriggerText: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.foreground,
    flex: 1,
  },
  pickerTriggerPlaceholder: {
    color: colors.mutedForeground,
  },
  pickerDropdown: {
    marginTop: 4,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: '#FFFFFF',
    overflow: 'hidden',
  },
  pickerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  pickerItemSelected: {
    backgroundColor: `${colors.primary}08`,
  },
  pickerItemText: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.foreground,
  },
  pickerItemTextSelected: {
    fontFamily: fonts.bodySemibold,
    color: colors.primary,
  },

  // SDOH cards
  sdohCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    padding: 14,
    backgroundColor: '#FFFFFF',
  },
  sdohCardChecked: {
    borderColor: colors.primary,
    backgroundColor: `${colors.primary}06`,
  },
  sdohLabel: {
    fontFamily: fonts.bodySemibold,
    fontSize: 14,
    color: colors.foreground,
  },
  sdohLabelChecked: {
    color: colors.primary,
  },
  sdohSublabel: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.mutedForeground,
    lineHeight: 16,
  },
  checkbox: {
    width: 18,
    height: 18,
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

  // Urgency radio cards
  urgencyCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    padding: 14,
    backgroundColor: '#FFFFFF',
  },
  urgencyCardSelected: {
    borderColor: colors.secondary,
    backgroundColor: `${colors.secondary}08`,
  },
  radioCircle: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
    flexShrink: 0,
  },
  radioCircleSelected: {
    borderColor: colors.secondary,
    backgroundColor: colors.secondary,
  },
  radioInner: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#FFFFFF',
  },
  urgencyLabel: {
    fontFamily: fonts.bodySemibold,
    fontSize: 14,
    color: colors.foreground,
  },
  urgencyDesc: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.mutedForeground,
    lineHeight: 16,
  },

  // Insurance info callout
  infoCallout: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    padding: 16,
    backgroundColor: colors.background,
    marginTop: 20,
  },
  infoCalloutTitle: {
    fontFamily: fonts.bodySemibold,
    fontSize: 12,
    letterSpacing: 0.5,
    color: colors.foreground,
    marginBottom: 6,
  },
  infoCalloutBody: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.mutedForeground,
    lineHeight: 18,
  },

  // Welcome step
  welcomeIconWrap: {
    width: 80,
    height: 80,
    borderRadius: radii.full,
    backgroundColor: `${colors.primary}14`,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  welcomeTitle: {
    fontFamily: fonts.displaySemibold,
    fontSize: 22,
    color: colors.foreground,
    textAlign: 'center',
    marginBottom: 8,
  },
  welcomeSubtitle: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.mutedForeground,
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 280,
    marginBottom: 24,
  },

  // Points card
  pointsCard: {
    width: '100%',
    borderWidth: 2,
    borderColor: colors.primary,
    borderRadius: radii.lg,
    padding: 20,
    backgroundColor: `${colors.primary}06`,
    alignItems: 'center',
    marginBottom: 24,
  },
  pointsCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  pointsCardLabel: {
    fontFamily: fonts.bodySemibold,
    fontSize: 11,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: colors.mutedForeground,
  },
  pointsRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 4,
    marginBottom: 4,
  },
  pointsNumber: {
    fontFamily: fonts.display,
    fontSize: 52,
    color: colors.primary,
    lineHeight: 56,
  },
  pointsUnit: {
    fontFamily: fonts.displaySemibold,
    fontSize: 22,
    color: colors.primary,
    marginBottom: 4,
  },
  pointsSubtext: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.mutedForeground,
    marginBottom: 12,
  },
  starsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },

  // What's next
  whatsNextTitle: {
    fontFamily: fonts.bodySemibold,
    fontSize: 11,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: colors.mutedForeground,
    textAlign: 'center',
    marginBottom: 12,
  },
  whatsNextList: {
    width: '100%',
    gap: 8,
    marginBottom: 24,
  },
  whatsNextItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: colors.background,
  },
  whatsNextText: {
    flex: 1,
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.foreground,
    lineHeight: 18,
  },

  // Get started button
  getStartedButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    width: '100%',
  },
  getStartedButtonText: {
    fontFamily: fonts.display,
    fontSize: 16,
    color: '#FFFFFF',
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
});

/**
 * CHWIntakeScreen — 27-question professional intake questionnaire.
 *
 * Presented as a 6-section guided flow (one screen per section) with a
 * progress bar, save-as-you-go, and a final review step. Matches TJ's
 * "CHW Profile & Intake Questionnaire" PDF verbatim.
 *
 * Sections:
 *   1. About You               (Q1-Q4)
 *   2. Credentials             (Q5-Q9)
 *   3. Languages & Culture     (Q10-Q14)
 *   4. Expertise               (Q15-Q19)
 *   5. Work Setting            (Q20-Q24)
 *   6. Schedule & Availability (Q25-Q27)
 *   7. Review & submit
 */

import React, { useCallback, useMemo, useState, useEffect } from 'react';
import {
  ActivityIndicator,
  Alert,
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
import { ArrowLeft, ArrowRight, Check, CheckCircle, X } from 'lucide-react-native';
import { useNavigation } from '@react-navigation/native';

import { colors } from '../../theme/colors';
import { fonts } from '../../theme/typography';
import { shadows } from '../../theme/shadows';
import { radii, spacing } from '../../theme/spacing';
import {
  useCHWIntake,
  useUpdateCHWIntake,
  useSubmitCHWIntake,
  type CHWIntakeState,
} from '../../hooks/useApiQueries';

// ─── Data: questions + option sets ────────────────────────────────────────────

export type IntakeOption = { value: string; label: string };
export type IntakeQuestion = {
  id: keyof CHWIntakeState;
  number: number;
  label: string;
  hint?: string;
  options: IntakeOption[];
  /** When value = this, show the free-text "Other" input under field `otherField`. */
  otherValue?: string;
  otherField?: keyof CHWIntakeState;
  /** When set, the question doesn't gate section-completion or submit. */
  optional?: boolean;
  /**
   * When set, the question only renders + counts toward completion when the
   * predicate returns true against the current draft. Used for conditional
   * follow-ups (e.g. "training pathway" only matters if the CHW has or is
   * pursuing a CHW certificate).
   */
  showWhen?: (draft: Partial<CHWIntakeState>) => boolean;
};

export type IntakeSection = {
  index: number;          // 1..6
  tag: string;            // ABOUT YOU
  title: string;          // Professional background
  accentColor: string;    // section badge + progress accent
  description: string;
  questions: IntakeQuestion[];
};

// Re-exports for demo / preview screens that want to render the same flow
// without hitting the backend.
type Option = IntakeOption;
type Question = IntakeQuestion;
type Section = IntakeSection;

/**
 * Returns true when a question is satisfied by the current draft.
 * Honours `optional` (always passes) and `showWhen` (passes when hidden).
 * Used by section-completion + submit-eligibility checks.
 */
function questionComplete(q: IntakeQuestion, draft: Partial<CHWIntakeState>): boolean {
  // Hidden by predicate? Not required.
  if (q.showWhen && !q.showWhen(draft)) return true;
  // Optional questions never block.
  if (q.optional) return true;
  const v = draft[q.id] as string | undefined;
  if (!v) return false;
  // "Other — please specify" requires the free-text follow-up too.
  if (q.otherValue && v === q.otherValue && q.otherField) {
    const other = draft[q.otherField] as string | undefined;
    return !!other && other.trim().length > 0;
  }
  return true;
}

// Palette for section badges — each derived from the PDF's colored rule.
const SECTION_COLORS = {
  aboutYou: '#5B8C5A',       // green
  credentials: '#7E6DB5',    // purple
  languages: '#2F7FB5',      // blue
  expertise: '#D08A2F',      // orange
  workSetting: '#C25E8A',    // pink
  availability: '#5B8C5A',   // green
};

export const INTAKE_SECTIONS: Section[] = [
  {
    index: 1,
    tag: 'ABOUT YOU',
    title: 'Professional background',
    accentColor: SECTION_COLORS.aboutYou,
    description: 'A few quick questions about your experience and training.',
    questions: [
      {
        // Per Jemal Figma feedback: copy now mentions "case management" so
        // candidates from adjacent backgrounds (case workers, social workers)
        // aren't excluded by the question framing. `no_experience` option
        // added for candidates who are new to the role entirely.
        id: 'yearsExperience',
        number: 1,
        label: 'How many years of experience do you have as a Community Health Worker or in case management?',
        options: [
          { value: 'no_experience', label: "I'm new to this — no formal CHW or case-management experience yet" },
          { value: 'less_than_1_year', label: 'Less than 1 year' },
          { value: '1_2_years', label: '1–2 years' },
          { value: '3_5_years', label: '3–5 years' },
          { value: '6_10_years', label: '6–10 years' },
          { value: 'more_than_10_years', label: 'More than 10 years' },
        ],
      },
      {
        id: 'employmentStatus',
        number: 2,
        label: 'Which best describes your current employment status?',
        options: [
          { value: 'full_time', label: 'Full-time CHW (employed)' },
          { value: 'part_time', label: 'Part-time CHW (employed)' },
          { value: 'contract', label: 'Contract or per diem CHW' },
          { value: 'volunteer', label: 'Volunteer CHW' },
          { value: 'seeking', label: 'Currently seeking CHW employment' },
        ],
      },
      {
        // `middle_school` added per Jemal Figma feedback. We don't gate
        // matching on this — it's informational, used by the matching service
        // to surface entry-level training resources when relevant.
        id: 'educationLevel',
        number: 3,
        label: 'What is your highest level of education?',
        options: [
          { value: 'middle_school', label: 'Middle school' },
          { value: 'hs_ged', label: 'High school diploma or GED' },
          { value: 'some_college', label: 'Some college or vocational training' },
          { value: 'associates', label: "Associate's degree" },
          { value: 'bachelors', label: "Bachelor's degree" },
          { value: 'graduate', label: 'Graduate or professional degree' },
        ],
      },
      {
        // `case_management` added per Jemal Figma feedback so case workers
        // and social-work practitioners don't have to pick the closest
        // analogue.
        id: 'primarySetting',
        number: 4,
        label: 'In which setting have you primarily worked as a CHW or case manager?',
        options: [
          { value: 'cbo', label: 'Community-based organization' },
          { value: 'mcp', label: 'Health plan or managed care (Medi-Cal)' },
          { value: 'fqhc', label: 'Federally Qualified Health Center (FQHC)' },
          { value: 'hospital', label: 'Hospital or health system' },
          { value: 'county_public_health', label: 'County public health department' },
          { value: 'case_management', label: 'Case management or social work setting' },
        ],
      },
    ],
  },
  {
    index: 2,
    tag: 'CREDENTIALS',
    title: 'Credentials & certifications',
    accentColor: SECTION_COLORS.credentials,
    description: 'Share your training background and formal credentials.',
    questions: [
      {
        id: 'caChwCertificate',
        number: 5,
        label: 'Do you hold a California Community Health Worker certificate?',
        options: [
          { value: 'yes_accredited', label: 'Yes, from a California accredited program' },
          { value: 'in_progress', label: 'In progress — currently completing requirements' },
          { value: 'no_not_pursued', label: 'No, I have not yet pursued CA certification' },
          { value: 'related_not_chw', label: 'I hold a related certificate but not CHW-specific' },
        ],
      },
      {
        // Per Jemal Figma feedback: only show this question if the CHW has
        // or is pursuing a CHW certificate. Hiding it when Q5 is
        // "no_not_pursued" — they have no pathway to describe yet. The
        // optional flag + showWhen predicate are what make the section /
        // submit gates happy when the question is hidden.
        id: 'trainingPathway',
        number: 6,
        label: 'Which best describes your CHW training pathway?',
        optional: true,
        showWhen: (d) =>
          d.caChwCertificate === 'yes_accredited'
          || d.caChwCertificate === 'in_progress'
          || d.caChwCertificate === 'related_not_chw',
        options: [
          { value: 'ca_accredited', label: 'California accredited CHW training program (community college)' },
          { value: 'employer_sponsored', label: 'Employer-sponsored training through a CA health plan or FQHC' },
          { value: 'county_local', label: 'County or local public health department training' },
          { value: 'on_the_job', label: 'On-the-job training only' },
          { value: 'self_directed', label: 'Self-directed or online training' },
        ],
      },
      {
        id: 'additionalCertification',
        number: 7,
        label: 'Do you hold any of the following additional certifications?',
        hint: 'Select the one that best applies',
        options: [
          { value: 'cpss', label: 'Certified Peer Support Specialist (CPSS — DHCS recognized)' },
          { value: 'medical_assistant', label: 'Medical Assistant (CMA or RMA)' },
          { value: 'cna', label: 'Certified Nursing Assistant (CNA)' },
          { value: 'ches', label: 'Health Education Specialist (CHES)' },
          { value: 'none', label: 'None of the above' },
        ],
      },
      {
        id: 'mediCalFamiliarity',
        number: 8,
        label: 'Are you familiar with Medi-Cal Community Supports and Enhanced Care Management (ECM) program requirements?',
        options: [
          { value: 'yes_direct', label: 'Yes, I have worked directly in ECM or Community Supports' },
          { value: 'somewhat', label: 'Somewhat — I have general familiarity' },
          { value: 'heard_need_training', label: 'I have heard of it but need more training' },
          { value: 'not_familiar', label: 'No, I am not familiar' },
          { value: 'being_trained', label: 'I am currently being trained' },
        ],
      },
      {
        id: 'ehrExperience',
        number: 9,
        label: 'Do you have experience using Electronic Health Records (EHR) or care management platforms?',
        options: [
          { value: 'proficient_multiple', label: 'Yes, proficient in multiple systems' },
          { value: 'familiar_one', label: 'Yes, familiar with one system' },
          { value: 'basic', label: 'Basic familiarity only' },
          { value: 'limited', label: 'Limited hands-on experience' },
          { value: 'none', label: 'No EHR experience' },
        ],
      },
    ],
  },
  {
    index: 3,
    tag: 'LANGUAGES',
    title: 'Languages & cultural competency',
    accentColor: SECTION_COLORS.languages,
    description: 'Helps us match you with members who share your language and background.',
    questions: [
      {
        id: 'primaryLanguage',
        number: 10,
        label: 'What is your primary language?',
        options: [
          { value: 'english', label: 'English' },
          { value: 'spanish', label: 'Spanish' },
          { value: 'mandarin_cantonese', label: 'Mandarin or Cantonese' },
          { value: 'vietnamese', label: 'Vietnamese' },
          { value: 'other', label: 'Other — please specify' },
        ],
        otherValue: 'other',
        otherField: 'primaryLanguageOther',
      },
      {
        // Marked optional per Jemal Figma feedback ("Remove this question,
        // similar to Q12") — Q12 already captures which additional language
        // the CHW speaks, so this gate question is redundant. Leaving it
        // visible-but-optional so existing seeded responses stay valid and
        // CHWs who DO want to specify fluency level still can.
        id: 'otherLanguageFluency',
        number: 11,
        label: 'Are you able to provide services in a language other than English?',
        hint: 'Optional — skip if you only speak the language above.',
        optional: true,
        options: [
          { value: 'fluent_one', label: 'Yes, fluent in one additional language' },
          { value: 'fluent_two_plus', label: 'Yes, fluent in two or more additional languages' },
          { value: 'conversational', label: 'Conversational in one additional language' },
          { value: 'basic_phrases', label: 'Basic phrases only' },
          { value: 'english_only', label: 'English only' },
        ],
      },
      {
        id: 'additionalLanguage',
        number: 12,
        label: 'Which additional language do you speak most fluently?',
        options: [
          { value: 'spanish', label: 'Spanish' },
          { value: 'mandarin_cantonese', label: 'Mandarin or Cantonese' },
          { value: 'vietnamese', label: 'Vietnamese' },
          { value: 'tagalog', label: 'Tagalog / Filipino' },
          { value: 'korean', label: 'Korean' },
          { value: 'hmong', label: 'Hmong' },
          { value: 'armenian', label: 'Armenian' },
          { value: 'other', label: 'Other — please specify' },
        ],
        otherValue: 'other',
        otherField: 'additionalLanguageOther',
      },
      {
        id: 'culturalCompetencyTraining',
        number: 13,
        label: 'Have you completed any formal cultural competency training?',
        options: [
          { value: 'formal_employer', label: 'Yes, formal employer or accredited training' },
          { value: 'certificate_program', label: 'Yes, through a certificate program' },
          { value: 'informal', label: 'Informal or self-directed learning only' },
          { value: 'in_progress', label: 'Currently completing training' },
          { value: 'none', label: 'No formal training' },
        ],
      },
      {
        id: 'livedExperience',
        number: 14,
        label: 'Do you have lived experience in the communities you serve?',
        options: [
          { value: 'current_member', label: 'Yes, I am a current community member' },
          { value: 'former_member', label: 'Yes, I was formerly a community member' },
          { value: 'shared_cultural', label: 'Shared cultural or linguistic background' },
          { value: 'limited', label: 'Limited shared experience' },
          { value: 'professional_only', label: 'No, but I have extensive professional experience serving this community' },
        ],
      },
    ],
  },
  {
    index: 4,
    tag: 'EXPERTISE',
    title: 'Areas of expertise & specialization',
    accentColor: SECTION_COLORS.expertise,
    description: 'The types of care you are most experienced supporting.',
    questions: [
      {
        id: 'primarySpecialization',
        number: 15,
        label: 'Which best describes your primary area of CHW specialization?',
        options: [
          { value: 'chronic_disease', label: 'Chronic disease management (diabetes, hypertension, asthma)' },
          { value: 'behavioral_health', label: 'Behavioral health & substance use recovery' },
          { value: 'maternal_child', label: 'Maternal & child health' },
          { value: 'housing_social', label: 'Housing & social services navigation' },
          { value: 'cancer_prevention', label: 'Cancer prevention & screenings' },
        ],
      },
      {
        id: 'sdohExperience',
        number: 16,
        label: 'Do you have experience conducting SDOH screenings and community referrals?',
        options: [
          { value: 'extensive', label: 'Yes, extensive experience' },
          { value: 'some', label: 'Yes, some experience' },
          { value: 'trained_limited', label: 'Trained but limited hands-on practice' },
          { value: 'currently_learning', label: 'Currently learning' },
          { value: 'none', label: 'No experience yet' },
        ],
      },
      {
        id: 'populationExperience',
        number: 17,
        label: 'Have you worked with any of the following specific populations?',
        hint: 'Select the one that best applies',
        options: [
          { value: 'older_adults', label: 'Older adults and Medi-Cal seniors' },
          { value: 'children_adolescents', label: 'Children and adolescents (Medi-Cal/CHIP)' },
          { value: 'homelessness_calaim', label: 'Individuals experiencing homelessness (CalAIM)' },
          { value: 'justice_jcip', label: 'Justice-involved individuals (JCIP)' },
          { value: 'refugee_immigrant', label: 'Refugee or immigrant communities' },
        ],
      },
      {
        id: 'motivationalInterviewing',
        number: 18,
        label: 'Are you experienced in motivational interviewing or health coaching techniques?',
        options: [
          { value: 'trained_regular', label: 'Yes, formally trained and regularly practice' },
          { value: 'trained_occasional', label: 'Yes, trained and use occasionally' },
          { value: 'familiar_limited', label: 'Familiar with concepts but limited formal training' },
          { value: 'being_trained', label: 'Currently being trained' },
          { value: 'none', label: 'No experience' },
        ],
      },
      {
        id: 'hedisExperience',
        number: 19,
        label: 'Do you have experience supporting HEDIS measure completion or care gap closure?',
        options: [
          { value: 'extensive', label: 'Yes, extensive HEDIS-specific experience' },
          { value: 'some', label: 'Yes, some familiarity with HEDIS measures' },
          { value: 'general_care_gap', label: 'General care gap work but not HEDIS-specific' },
          { value: 'learning', label: 'Learning about HEDIS' },
          { value: 'none', label: 'No experience with HEDIS' },
        ],
      },
    ],
  },
  {
    index: 5,
    tag: 'WORK SETTING',
    title: 'Work setting & modality preference',
    accentColor: SECTION_COLORS.workSetting,
    description: 'How and where you prefer to deliver services.',
    questions: [
      {
        id: 'preferredModality',
        number: 20,
        label: 'What is your preferred work modality?',
        options: [
          { value: 'in_person', label: 'Fully in-person / field-based' },
          { value: 'remote', label: 'Fully remote / virtual' },
          { value: 'hybrid_in_person', label: 'Hybrid — primarily in-person with some remote' },
          { value: 'hybrid_remote', label: 'Hybrid — primarily remote with some in-person' },
          { value: 'flexible', label: 'No preference — flexible to any setting' },
        ],
      },
      {
        id: 'homeVisitComfort',
        number: 21,
        label: 'Are you comfortable conducting home visits in your service area?',
        options: [
          { value: 'prefer', label: 'Yes, I prefer home visits' },
          { value: 'comfortable_safety', label: 'Yes, comfortable with appropriate safety protocols' },
          { value: 'certain_only', label: 'Yes, in certain neighborhoods or circumstances only' },
          { value: 'rarely', label: 'Rarely — prefer clinic or office settings' },
          { value: 'no', label: 'No, I prefer not to conduct home visits' },
        ],
      },
      {
        id: 'telehealthComfort',
        number: 22,
        label: 'Are you comfortable providing services via telehealth or phone outreach?',
        options: [
          { value: 'highly_experienced', label: 'Yes, highly experienced with virtual outreach' },
          { value: 'comfortable', label: 'Yes, comfortable with telehealth platforms' },
          { value: 'somewhat', label: 'Somewhat comfortable — still building confidence' },
          { value: 'prefer_in_person', label: 'Prefer in-person but can do virtual if needed' },
          { value: 'no', label: 'No, I prefer in-person only' },
        ],
      },
      {
        id: 'transportation',
        number: 23,
        label: 'Do you have reliable transportation for field-based work within your California service area?',
        options: [
          { value: 'personal_vehicle', label: 'Yes, personal vehicle with current CA auto insurance' },
          { value: 'public_transit', label: 'Yes, public transit is accessible in my area' },
          { value: 'reimbursement_required', label: 'Mileage reimbursement or transit stipend required' },
          { value: 'limited', label: 'Limited transportation — need employer support' },
          { value: 'not_applicable', label: 'Not applicable — remote work only preferred' },
        ],
      },
      {
        id: 'preferredCaseload',
        number: 24,
        label: 'What is your preferred caseload size?',
        options: [
          { value: 'small', label: 'Small — fewer than 20 members' },
          { value: 'moderate', label: 'Moderate — 20 to 40 members' },
          { value: 'large', label: 'Large — 41 to 60 members' },
          { value: 'high_volume', label: 'High volume — more than 60 members' },
          { value: 'flexible', label: 'Flexible — depends on member complexity' },
        ],
      },
    ],
  },
  {
    index: 6,
    tag: 'AVAILABILITY',
    title: 'Schedule & availability',
    accentColor: SECTION_COLORS.availability,
    description: 'Your working hours and response to urgent outreach.',
    questions: [
      {
        id: 'preferredSchedule',
        number: 25,
        label: 'What is your preferred work schedule?',
        options: [
          { value: 'weekdays_standard', label: 'Standard weekdays — Monday through Friday, 8am to 5pm' },
          { value: 'flexible_weekday', label: 'Flexible weekday hours' },
          { value: 'evenings', label: 'Evenings available (after 5pm on weekdays)' },
          { value: 'weekends', label: 'Weekends available' },
          { value: 'rotating', label: 'Rotating or on-call schedule' },
        ],
      },
      {
        id: 'preferredEmploymentType',
        number: 26,
        label: 'What is your preferred employment type?',
        options: [
          { value: 'full_time_40', label: 'Full-time (40 hours per week)' },
          { value: 'part_time_20_32', label: 'Part-time (20–32 hours per week)' },
          { value: 'per_diem', label: 'Per diem or as-needed only' },
          { value: 'contract_temporary', label: 'Contract or temporary' },
          { value: 'flexible', label: 'Flexible — open to any arrangement' },
        ],
      },
      {
        id: 'urgentOutreach',
        number: 27,
        label: 'Are you available for urgent or same-day member outreach when needed?',
        options: [
          { value: 'regularly', label: 'Yes, regularly available' },
          { value: 'occasionally', label: 'Yes, occasionally available' },
          { value: 'rarely', label: 'Rarely — prefer planned outreach only' },
          { value: 'scheduled_only', label: 'No, scheduled work only' },
          { value: 'depends_caseload', label: 'Depends on current caseload' },
        ],
      },
    ],
  },
];

const TOTAL_SECTIONS = INTAKE_SECTIONS.length; // 6

// Helper — total question count for the subtitle counter
const TOTAL_QUESTIONS = INTAKE_SECTIONS.reduce((sum, s) => sum + s.questions.length, 0);

// ─── Sub-components ──────────────────────────────────────────────────────────

function ProgressBar({ step }: { step: number }): React.JSX.Element {
  return (
    <View style={styles.progressRow}>
      {Array.from({ length: TOTAL_SECTIONS }, (_, i) => {
        const done = i + 1 < step;
        const current = i + 1 === step;
        return (
          <View
            key={i}
            style={[
              styles.progressDot,
              done && styles.progressDotDone,
              current && styles.progressDotCurrent,
            ]}
          />
        );
      })}
    </View>
  );
}

function RadioOption({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <TouchableOpacity
      style={[styles.optionCard, selected && styles.optionCardSelected]}
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={label}
    >
      <View style={[styles.optionDot, selected && styles.optionDotSelected]}>
        {selected && <Check size={12} color="#FFFFFF" strokeWidth={3} />}
      </View>
      <Text style={[styles.optionLabel, selected && styles.optionLabelSelected]}>{label}</Text>
    </TouchableOpacity>
  );
}

function QuestionBlock({
  question,
  value,
  otherValue,
  accentColor,
  onChange,
  onOtherChange,
}: {
  question: Question;
  value: string | undefined;
  otherValue: string | undefined;
  accentColor: string;
  onChange: (next: string) => void;
  onOtherChange: (next: string) => void;
}): React.JSX.Element {
  const showOther =
    question.otherValue !== undefined && value === question.otherValue;

  return (
    <View style={styles.questionBlock}>
      <View style={styles.qHeaderRow}>
        <View style={[styles.qNumberPill, { backgroundColor: accentColor + '22' }]}>
          <Text style={[styles.qNumberText, { color: accentColor }]}>
            Q{question.number}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.qLabel}>{question.label}</Text>
          {question.hint && <Text style={styles.qHint}>{question.hint}</Text>}
        </View>
      </View>

      <View style={{ gap: 8 }}>
        {question.options.map((opt) => (
          <RadioOption
            key={opt.value}
            label={opt.label}
            selected={value === opt.value}
            onPress={() => onChange(opt.value)}
          />
        ))}
      </View>

      {showOther && (
        <View style={{ marginTop: 10 }}>
          <Text style={styles.otherLabel}>Please specify</Text>
          <TextInput
            style={styles.otherInput}
            value={otherValue ?? ''}
            onChangeText={onOtherChange}
            placeholder="Type your answer…"
            placeholderTextColor={colors.mutedForeground}
            maxLength={100}
            accessibilityLabel={`${question.label} — other, please specify`}
          />
        </View>
      )}
    </View>
  );
}

// ─── Review screen ───────────────────────────────────────────────────────────

function ReviewPage({
  state,
  onEdit,
}: {
  state: CHWIntakeState;
  onEdit: (sectionIndex: number) => void;
}): React.JSX.Element {
  function labelFor(q: Question, value: string | undefined): string {
    if (!value) return '—';
    return q.options.find((o) => o.value === value)?.label ?? value;
  }

  return (
    <View>
      <Text style={styles.stepTitle}>Review your answers</Text>
      <Text style={styles.stepSubtitle}>
        Tap any section to jump back and make changes. Submit when you're ready.
      </Text>

      {INTAKE_SECTIONS.map((section) => (
        <View key={section.index} style={styles.reviewSection}>
          <View style={styles.reviewSectionHeader}>
            <View style={styles.reviewSectionTitleWrap}>
              <View style={[styles.tagPill, { backgroundColor: section.accentColor + '22' }]}>
                <Text style={[styles.tagPillText, { color: section.accentColor }]}>
                  {section.tag}
                </Text>
              </View>
              <Text style={styles.reviewSectionTitle}>{section.title}</Text>
            </View>
            <TouchableOpacity
              onPress={() => onEdit(section.index)}
              accessibilityRole="button"
              accessibilityLabel={`Edit ${section.title}`}
            >
              <Text style={styles.editLink}>Edit</Text>
            </TouchableOpacity>
          </View>

          {section.questions.map((q) => {
            const v = state[q.id] as string | undefined;
            const isOther =
              q.otherValue !== undefined && v === q.otherValue && q.otherField;
            const detail = isOther ? (state[q.otherField!] as string | undefined) : undefined;
            return (
              <View key={q.id as string} style={styles.reviewRow}>
                <Text style={styles.reviewQ}>{q.label}</Text>
                <Text style={styles.reviewA}>
                  {labelFor(q, v)}
                  {detail ? ` — ${detail}` : ''}
                </Text>
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

// ─── Main screen ─────────────────────────────────────────────────────────────

interface CHWIntakeScreenProps {
  /**
   * When true, skip all API calls and run entirely off local state.
   * Used by the marketing-site preview so anyone can see the UI without
   * signing up. Do not set this in production flows.
   */
  previewMode?: boolean;
}

export function CHWIntakeScreen({
  previewMode = false,
}: CHWIntakeScreenProps = {}): React.JSX.Element {
  const navigation = useNavigation();

  const { data: apiInitial, isLoading: apiLoading } = useCHWIntake(!previewMode);
  const patchMutation = useUpdateCHWIntake();
  const submitMutation = useSubmitCHWIntake();

  const initial = previewMode ? undefined : apiInitial;
  const isLoading = previewMode ? false : apiLoading;

  // Local draft — prefilled from server, edited in-screen, patched on Continue.
  const [draft, setDraft] = useState<CHWIntakeState>({});
  const [step, setStep] = useState<number>(1); // 1..6 sections, 7 = review
  const [submitted, setSubmitted] = useState(false);
  /** Inline submit-error message (shown above the Submit button). Replaces
   *  the previous Alert.alert which fires unreliably on web. */
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Hydrate local draft once when the server response arrives. Resume on the
  // section AFTER the last completed one so CHWs don't re-answer finished work.
  useEffect(() => {
    if (!initial) return;
    setDraft(initial);
    if (initial.completedAt) {
      setSubmitted(true);
      return;
    }
    const resumeAt = (initial.lastCompletedSection ?? 0) + 1;
    setStep(Math.min(Math.max(resumeAt, 1), TOTAL_SECTIONS));
  }, [initial]);

  const currentSection = useMemo(
    () => (step <= TOTAL_SECTIONS ? INTAKE_SECTIONS[step - 1] : null),
    [step],
  );

  // Did the user answer every question in the current section? Required before
  // they can advance.
  const currentSectionComplete = useMemo(() => {
    if (!currentSection) return true;
    return currentSection.questions.every((q) => questionComplete(q, draft));
  }, [currentSection, draft]);

  const allSectionsComplete = useMemo(
    () =>
      INTAKE_SECTIONS.every((s) =>
        s.questions.every((q) => questionComplete(q, draft)),
      ),
    [draft],
  );

  const setField = useCallback((key: keyof CHWIntakeState, value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleBack = useCallback(() => {
    if (step > 1) {
      setStep((prev) => prev - 1);
    } else {
      navigation.goBack();
    }
  }, [step, navigation]);

  const handleContinue = useCallback(async () => {
    if (!currentSection) return;

    // Collect just this section's fields + bump the completed-section marker
    const patch: Partial<CHWIntakeState> = { lastCompletedSection: step };
    for (const q of currentSection.questions) {
      const v = draft[q.id] as string | undefined;
      if (v !== undefined) (patch as Record<string, unknown>)[q.id as string] = v;
      if (q.otherField) {
        const other = draft[q.otherField] as string | undefined;
        if (other !== undefined)
          (patch as Record<string, unknown>)[q.otherField as string] = other;
      }
    }

    if (previewMode) {
      setDraft((prev) => ({ ...prev, ...patch }));
      setStep((prev) => prev + 1);
      return;
    }
    try {
      await patchMutation.mutateAsync(patch);
      setStep((prev) => prev + 1);
    } catch (e) {
      Alert.alert(
        'Could not save progress',
        'We couldn\'t save your answers. Check your connection and try again.',
      );
    }
  }, [currentSection, draft, step, patchMutation, previewMode]);

  const handleSubmit = useCallback(async () => {
    if (previewMode) {
      setSubmitted(true);
      return;
    }
    setSubmitError(null);
    // Save any outstanding edits one more time, then submit
    try {
      if (Object.keys(draft).length > 0) {
        await patchMutation.mutateAsync(draft);
      }
      await submitMutation.mutateAsync();
      setSubmitted(true);
    } catch (e) {
      // Surface the backend's specific message inline (Alert.alert was
      // unreliable on web — the destructive button never fired). The
      // backend now returns a friendly string like "Intake is incomplete.
      // Missing: Years Experience, Employment Status (and 3 more)." via
      // the api client's dict-detail handling.
      const message =
        e instanceof Error && e.message
          ? e.message
          : 'Could not submit your intake. Please review your answers and try again.';
      setSubmitError(message);
    }
  }, [draft, patchMutation, submitMutation, previewMode]);

  const handleSaveAndExit = useCallback(() => {
    Alert.alert(
      'Save and exit?',
      'Your progress is saved automatically at the end of each section.',
      [
        { text: 'Keep going', style: 'cancel' },
        { text: 'Exit', onPress: () => navigation.goBack() },
      ],
    );
  }, [navigation]);

  // ─── Render states ─────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.loading}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.loadingText}>Loading your intake…</Text>
        </View>
      </SafeAreaView>
    );
  }

  // Already completed — show a confirmation with back to dashboard button
  if (submitted) {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
        <View style={styles.successWrap}>
          <View style={styles.successIconWrap}>
            <CheckCircle size={44} color={colors.primary} />
          </View>
          <Text style={styles.successTitle}>Thanks for completing your intake</Text>
          <Text style={styles.successBody}>
            We use your answers to match you with the right members. You can update
            your intake anytime from your Profile.
          </Text>
          <TouchableOpacity
            style={styles.submitBtn}
            onPress={() => {
              // navigation.goBack() is a no-op on web when this screen was
              // entered via a direct URL (no history to pop). Explicitly
              // navigate to the Dashboard route inside the same nested stack
              // so the button always lands somewhere useful regardless of
              // entry path.
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const nav = navigation as any;
              if (typeof nav?.navigate === 'function') {
                nav.navigate('Dashboard');
              } else {
                nav?.goBack?.();
              }
            }}
            accessibilityRole="button"
            accessibilityLabel="Back to dashboard"
            activeOpacity={0.85}
          >
            <Text style={styles.submitBtnText}>Back to Dashboard</Text>
            <ArrowRight size={16} color="#FFFFFF" />
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const isReview = step > TOTAL_SECTIONS;

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={styles.pageWrap}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        {/* Top bar */}
        <View style={styles.topBar}>
          <TouchableOpacity
            style={styles.iconBtn}
            onPress={handleBack}
            accessibilityRole="button"
            accessibilityLabel="Back"
          >
            <ArrowLeft size={20} color={colors.foreground} />
          </TouchableOpacity>
          <View style={{ alignItems: 'center', flex: 1 }}>
            <Text style={styles.topBarTitle}>Professional Intake</Text>
            <Text style={styles.topBarSubtitle}>
              {isReview
                ? 'Review & submit'
                : `Section ${step} of ${TOTAL_SECTIONS} · ${TOTAL_QUESTIONS} questions total`}
            </Text>
          </View>
          <TouchableOpacity
            style={styles.iconBtn}
            onPress={handleSaveAndExit}
            accessibilityRole="button"
            accessibilityLabel="Save and exit"
          >
            <X size={20} color={colors.foreground} />
          </TouchableOpacity>
        </View>

        <ProgressBar step={Math.min(step, TOTAL_SECTIONS)} />

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {!isReview && currentSection && (
            <>
              {/* Section header */}
              <View style={styles.sectionHeader}>
                <View
                  style={[styles.tagPill, { backgroundColor: currentSection.accentColor + '22' }]}
                >
                  <Text style={[styles.tagPillText, { color: currentSection.accentColor }]}>
                    {currentSection.tag}
                  </Text>
                </View>
                <Text style={styles.stepTitle}>{currentSection.title}</Text>
                <Text style={styles.stepSubtitle}>{currentSection.description}</Text>
              </View>

              {/* Questions — skip those whose `showWhen` predicate is false
                  for the current draft (e.g. trainingPathway when the CHW has
                  no certificate). */}
              {currentSection.questions
                .filter((q) => !q.showWhen || q.showWhen(draft))
                .map((q) => (
                  <QuestionBlock
                    key={q.id as string}
                    question={q}
                    value={draft[q.id] as string | undefined}
                    otherValue={
                      q.otherField ? (draft[q.otherField] as string | undefined) : undefined
                    }
                    accentColor={currentSection.accentColor}
                    onChange={(v) => setField(q.id, v)}
                    onOtherChange={(v) => q.otherField && setField(q.otherField, v)}
                  />
                ))}
            </>
          )}

          {isReview && <ReviewPage state={draft} onEdit={(idx) => setStep(idx)} />}
        </ScrollView>

        {/* Submit-error banner (replaces the unreliable Alert.alert) */}
        {submitError !== null && isReview && (
          <View style={styles.submitErrorBanner} accessibilityRole="alert" accessibilityLiveRegion="polite">
            <Text style={styles.submitErrorText}>{submitError}</Text>
          </View>
        )}

        {/* Sticky bottom nav */}
        <View style={styles.bottomBar}>
          <TouchableOpacity
            style={styles.backBtn}
            onPress={handleBack}
            accessibilityRole="button"
            accessibilityLabel="Back"
          >
            <ArrowLeft size={16} color={colors.mutedForeground} />
            <Text style={styles.backBtnText}>Back</Text>
          </TouchableOpacity>

          {!isReview ? (
            <TouchableOpacity
              style={[
                styles.primaryBtn,
                (!currentSectionComplete || patchMutation.isPending) && styles.primaryBtnDisabled,
              ]}
              onPress={handleContinue}
              disabled={!currentSectionComplete || patchMutation.isPending}
              accessibilityRole="button"
              accessibilityLabel="Continue to next section"
              accessibilityState={{
                disabled: !currentSectionComplete || patchMutation.isPending,
              }}
              activeOpacity={0.85}
            >
              {patchMutation.isPending ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <>
                  <Text style={styles.primaryBtnText}>
                    {step === TOTAL_SECTIONS ? 'Review' : 'Continue'}
                  </Text>
                  <ArrowRight size={16} color="#FFFFFF" />
                </>
              )}
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[
                styles.primaryBtn,
                (!allSectionsComplete || submitMutation.isPending) && styles.primaryBtnDisabled,
              ]}
              onPress={handleSubmit}
              disabled={!allSectionsComplete || submitMutation.isPending}
              accessibilityRole="button"
              accessibilityLabel="Submit intake"
              activeOpacity={0.85}
            >
              {submitMutation.isPending ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <>
                  <Text style={styles.primaryBtnText}>Submit</Text>
                  <Check size={16} color="#FFFFFF" strokeWidth={3} />
                </>
              )}
            </TouchableOpacity>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.background,
  },
  // Constrains the whole intake flow to a mobile-sized column even on
  // wide desktop browsers so the option cards don't stretch edge-to-edge.
  pageWrap: {
    flex: 1,
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
  },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  loadingText: {
    fontFamily: fonts.body,
    color: colors.mutedForeground,
    fontSize: 14,
  },

  // Top bar
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.card,
  },
  iconBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.sm,
  },
  topBarTitle: {
    fontFamily: fonts.displaySemibold,
    fontSize: 15,
    color: colors.foreground,
  },
  topBarSubtitle: {
    fontFamily: fonts.body,
    fontSize: 11,
    color: colors.mutedForeground,
    marginTop: 2,
  },

  // Progress bar
  progressRow: {
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  progressDot: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
  },
  progressDotCurrent: {
    backgroundColor: colors.primary,
  },
  progressDotDone: {
    backgroundColor: colors.secondary,
  },

  // Scroll body
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 28,
  },
  sectionHeader: {
    marginBottom: 20,
    gap: 8,
  },
  tagPill: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radii.full,
  },
  tagPillText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 10,
    letterSpacing: 1,
  },
  stepTitle: {
    fontFamily: fonts.displaySemibold,
    fontSize: 22,
    color: colors.foreground,
    lineHeight: 28,
  },
  stepSubtitle: {
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.mutedForeground,
    lineHeight: 20,
  },

  // Question block
  questionBlock: {
    marginBottom: 22,
  },
  qHeaderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginBottom: 10,
  },
  qNumberPill: {
    borderRadius: radii.sm,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginTop: 2,
  },
  qNumberText: {
    fontFamily: fonts.displaySemibold,
    fontSize: 11,
    letterSpacing: 0.5,
  },
  qLabel: {
    fontFamily: fonts.bodySemibold,
    fontSize: 15,
    color: colors.foreground,
    lineHeight: 20,
  },
  qHint: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.mutedForeground,
    fontStyle: 'italic',
    marginTop: 2,
  },

  // Option card
  optionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: '#FFFFFF',
  },
  optionCardSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primary + '08',
  },
  optionDot: {
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
  optionDotSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primary,
  },
  optionLabel: {
    flex: 1,
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.foreground,
    lineHeight: 20,
  },
  optionLabelSelected: {
    fontFamily: fonts.bodySemibold,
    color: colors.primary,
  },

  // "Other" free-text
  otherLabel: {
    fontFamily: fonts.bodySemibold,
    fontSize: 11,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: colors.mutedForeground,
    marginBottom: 6,
  },
  otherInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    fontFamily: fonts.body,
    fontSize: 14,
    color: colors.foreground,
  },

  // Review page
  reviewSection: {
    marginTop: 18,
    padding: 14,
    borderRadius: radii.md,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: colors.border,
  },
  reviewSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  reviewSectionTitleWrap: {
    flex: 1,
    gap: 4,
  },
  reviewSectionTitle: {
    fontFamily: fonts.displaySemibold,
    fontSize: 15,
    color: colors.foreground,
  },
  editLink: {
    fontFamily: fonts.bodySemibold,
    fontSize: 13,
    color: colors.primary,
  },
  reviewRow: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: 3,
  },
  reviewQ: {
    fontFamily: fonts.body,
    fontSize: 12,
    color: colors.mutedForeground,
    lineHeight: 16,
  },
  reviewA: {
    fontFamily: fonts.bodySemibold,
    fontSize: 14,
    color: colors.foreground,
    lineHeight: 18,
  },

  // Submit-error banner — sits between the scroll and the sticky bottom bar.
  submitErrorBanner: {
    marginHorizontal: 20,
    marginBottom: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: `${colors.destructive}10`,
    borderWidth: 1,
    borderColor: `${colors.destructive}50`,
  },
  submitErrorText: {
    fontFamily: fonts.body,
    fontSize: 13,
    color: colors.destructive,
    lineHeight: 18,
  },

  // Bottom bar
  bottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.card,
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  backBtnText: {
    fontFamily: fonts.bodySemibold,
    fontSize: 14,
    color: colors.mutedForeground,
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.primary,
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: radii.md,
    minWidth: 130,
    ...shadows.elevated,
  },
  primaryBtnDisabled: {
    opacity: 0.4,
  },
  primaryBtnText: {
    fontFamily: fonts.display,
    fontSize: 14,
    color: '#FFFFFF',
  },

  // Success
  successWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  successIconWrap: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: colors.primary + '18',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
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
    maxWidth: 320,
    marginBottom: 24,
  },
  submitBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingHorizontal: 22,
    paddingVertical: 14,
  },
  submitBtnText: {
    fontFamily: fonts.display,
    fontSize: 16,
    color: '#FFFFFF',
  },
});

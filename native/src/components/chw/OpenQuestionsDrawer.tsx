/**
 * OpenQuestionsDrawer — slide-in overlay with suggested call questions.
 *
 * Renders inside the existing RightDrawer shell (handles all platform
 * differences: web fixed-overlay vs. native Modal). The drawer owns:
 *
 *   - Member context strip  (avatar, name/age, language, last contact, engagement)
 *   - 4-section checklist   (questions toggled via a Set<string> of ids)
 *   - "Add Custom Question" dashed button   (presentation-only for v1)
 *   - Compass Insight AI footer            (static; no LLM calls)
 *   - Sticky footer: Copy Script · Save as Note · Mark Call Completed
 *
 * Question data is seeded deterministically from `journey.vertical`.
 * No backend calls — fully static for v1.
 *
 * Platform note:
 *   RightDrawer already handles web (Animated translateX fixed overlay) vs.
 *   native (Modal formSheet). This component only supplies the content.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Platform,
  useWindowDimensions,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import {
  Check,
  Copy,
  NotebookPen,
  CheckCircle2,
  Plus,
  Sparkles,
} from 'lucide-react-native';

import { RightDrawer } from '../ui/RightDrawer';
import { Pill }        from '../ui/Pill';
import { Card }        from '../ui/Card';
import { colors, spacing, radius } from '../../theme/tokens';

// ─── Public types ─────────────────────────────────────────────────────────────

/** Minimum member data the drawer needs. */
export interface OpenQuestionsMember {
  name: string;
  /** Null when age is not available. */
  age: number | null;
  /** Two-letter initials for the avatar chip. */
  initials: string;
  primaryLanguage?: string;
  /** Human-readable relative string e.g. "2 days ago". */
  lastContactRelative?: string;
  /** Short engagement label e.g. "Highly Engaged". */
  engagementLabel?: string;
}

/** Active journey context used to seed questions. All fields optional. */
export interface OpenQuestionsJourney {
  /** Display name of the journey template e.g. "Food Assistance Journey". */
  templateName: string;
  /** Current step name e.g. "Upload Documents". */
  currentStepName: string;
  /**
   * Determines which question bank to load.
   * Recognised values: food | housing | mental_health | healthcare | transportation | employment.
   * Unknown values fall back to _default.
   */
  vertical: string;
}

export interface OpenQuestionsDrawerProps {
  visible: boolean;
  onClose: () => void;
  member: OpenQuestionsMember;
  /** When absent the drawer shows generic check-in questions. */
  journey?: OpenQuestionsJourney;
  onMarkComplete?: () => void;
  onCopyScript?: () => void;
  onSaveNote?: () => void;
}

// ─── Question bank ────────────────────────────────────────────────────────────

interface QuestionSection {
  section: string;
  questions: string[];
}

/**
 * Static question banks keyed by journey vertical.
 * All banks share the same four-section structure from the mockup.
 */
const QUESTIONS_BY_VERTICAL: Record<string, QuestionSection[]> = {
  food: [
    {
      section: '1 · Confirm Current Situation',
      questions: [
        'Do you currently have enough food for the next 2–3 days?',
        'Has anything changed with your household size or income?',
      ],
    },
    {
      section: '2 · Document Support',
      questions: [
        "Do you have access to your ID or driver's license?",
        'Do you have proof of address available?',
        'Would you like me to walk you through how to upload the documents?',
      ],
    },
    {
      section: '3 · Barriers',
      questions: [
        'Is transportation, internet access, or phone access making this harder?',
        'Is there anyone else helping you with this application?',
      ],
    },
    {
      section: '4 · Close the Call',
      questions: [
        'Can we set a follow-up time to confirm the upload was completed?',
        'Would you like a reminder text?',
      ],
    },
  ],

  housing: [
    {
      section: '1 · Confirm Current Situation',
      questions: [
        'Have there been any changes to your living situation since we last spoke?',
        'Are you currently on any housing waitlists?',
        'Do you have concerns about keeping your current housing?',
      ],
    },
    {
      section: '2 · Document Support',
      questions: [
        'Do you have the required ID and income documents ready for the application?',
        'Has your landlord provided the necessary rental verification forms?',
        'Would you like help scanning or uploading any documents?',
      ],
    },
    {
      section: '3 · Barriers',
      questions: [
        'Are there language or literacy barriers making paperwork difficult?',
        'Is anyone else in the household also involved in the housing process?',
      ],
    },
    {
      section: '4 · Close the Call',
      questions: [
        'Shall we schedule a follow-up call to check on the application status?',
        'Is there a specific time of day that works best for future calls?',
      ],
    },
  ],

  mental_health: [
    {
      section: '1 · Confirm Current Situation',
      questions: [
        'How have you been feeling since our last conversation?',
        'Have there been any changes to your medication or therapy schedule?',
      ],
    },
    {
      section: '2 · Document Support',
      questions: [
        'Do you have your insurance card and ID ready for your next appointment?',
        'Would you like help filling out any intake or authorization forms?',
      ],
    },
    {
      section: '3 · Barriers',
      questions: [
        'Is getting to appointments by transportation a challenge right now?',
        'Are there any family or work stressors making it harder to prioritize your care?',
      ],
    },
    {
      section: '4 · Close the Call',
      questions: [
        'Can we confirm your next appointment date and time before we hang up?',
        'Would a reminder text or call the day before the appointment be helpful?',
      ],
    },
  ],

  healthcare: [
    {
      section: '1 · Confirm Current Situation',
      questions: [
        'Have you had any urgent medical needs since our last session?',
        'Are all of your current medications still the same?',
      ],
    },
    {
      section: '2 · Document Support',
      questions: [
        'Do you have your insurance card and referral forms for your upcoming visit?',
        'Would you like help requesting medical records from a prior provider?',
      ],
    },
    {
      section: '3 · Barriers',
      questions: [
        'Is cost or insurance coverage a concern for any of your upcoming services?',
        'Are you able to reach your prescribing provider when you have questions?',
      ],
    },
    {
      section: '4 · Close the Call',
      questions: [
        'Let us confirm your next appointment and any follow-up labs before we end the call.',
        'Would you like a care summary sent to you by text after this call?',
      ],
    },
  ],

  transportation: [
    {
      section: '1 · Confirm Current Situation',
      questions: [
        'How have you been getting to your appointments since we last spoke?',
        'Do you have any upcoming appointments you need a ride to?',
      ],
    },
    {
      section: '2 · Document Support',
      questions: [
        'Would you like help setting up non-emergency medical transportation (NEMT) through your plan?',
        'Do you have a bus pass or transit card, or would you like help getting one?',
      ],
    },
    {
      section: '3 · Barriers',
      questions: [
        'Has a lack of transportation caused you to miss any appointments recently?',
        'Are cost, distance, or mobility making it hard to get where you need to go?',
      ],
    },
    {
      section: '4 · Close the Call',
      questions: [
        'Can we confirm your ride for your next appointment before we end the call?',
        'Would you like me to text you the transit or NEMT details?',
      ],
    },
  ],

  employment: [
    {
      section: '1 · Confirm Current Situation',
      questions: [
        'How has your job search been going since we last spoke?',
        'Are you currently working, actively looking, or getting ready to apply?',
      ],
    },
    {
      section: '2 · Document Support',
      questions: [
        'Do you have an up-to-date resume, or would you like help building one?',
        'Would you like help gathering what you need to apply (ID, references, certifications)?',
      ],
    },
    {
      section: '3 · Barriers',
      questions: [
        'Is anything getting in the way of working right now — childcare, transportation, or scheduling?',
        'Would training or a certification help you reach the kind of job you want?',
      ],
    },
    {
      section: '4 · Close the Call',
      questions: [
        'Can we set a goal for the next step in your job search before we end the call?',
        'Would you like me to text you a few local job or training leads?',
      ],
    },
  ],

  _default: [
    {
      section: '1 · Confirm Current Situation',
      questions: [
        'How have things been going since we last spoke?',
        'Have there been any major changes in your living or family situation?',
      ],
    },
    {
      section: '2 · Document Support',
      questions: [
        'Are there any forms or documents you need help gathering or completing?',
        'Would you like a list of what documents are typically needed for your program?',
      ],
    },
    {
      section: '3 · Barriers',
      questions: [
        'Is anything making it harder to follow through on the steps we discussed?',
        'Do you have reliable phone or internet access to stay in touch?',
      ],
    },
    {
      section: '4 · Close the Call',
      questions: [
        'Can we agree on one or two action steps before we end the call today?',
        'What is the best day and time for our next check-in?',
      ],
    },
  ],
};

/**
 * Returns the question bank for a given vertical,
 * falling back to _default when the vertical is unrecognised.
 */
function resolveQuestions(vertical: string | undefined): QuestionSection[] {
  if (!vertical) return QUESTIONS_BY_VERTICAL['_default']!;
  return QUESTIONS_BY_VERTICAL[vertical] ?? QUESTIONS_BY_VERTICAL['_default']!;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface MemberContextStripProps {
  member: OpenQuestionsMember;
}

/**
 * Green-tinted strip showing member identity, language, recency, and engagement.
 */
function MemberContextStrip({ member }: MemberContextStripProps): React.JSX.Element {
  const nameAge = member.age != null
    ? `${member.name} · ${member.age}`
    : member.name;

  const metaParts: string[] = [];
  if (member.primaryLanguage) metaParts.push(member.primaryLanguage);
  if (member.lastContactRelative) metaParts.push(`Last contact ${member.lastContactRelative}`);
  const metaLine = metaParts.join(' · ');

  return (
    <View style={stripStyles.container}>
      {/* Avatar chip */}
      <View style={stripStyles.avatar}>
        <Text style={stripStyles.avatarText}>{member.initials}</Text>
      </View>

      {/* Name + meta */}
      <View style={stripStyles.info}>
        <Text style={stripStyles.nameAge}>{nameAge}</Text>
        {metaLine.length > 0 && (
          <Text style={stripStyles.meta}>{metaLine}</Text>
        )}
      </View>

      {/* Engagement pill */}
      {member.engagementLabel != null && member.engagementLabel.length > 0 && (
        <Pill variant="emerald" size="sm">{member.engagementLabel}</Pill>
      )}
    </View>
  );
}

const stripStyles = StyleSheet.create({
  container: {
    flexDirection:    'row',
    alignItems:       'center',
    gap:              spacing.md,
    marginTop:        spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical:  spacing.sm + 2,
    borderRadius:     radius.lg,
    // emerald-50 / emerald-100 equivalent — closest tokens are teal100/emerald100
    backgroundColor:  colors.teal100,
    borderWidth:      1,
    borderColor:      colors.emerald100,
  } as ViewStyle,

  avatar: {
    width:           32,
    height:          32,
    borderRadius:    16,
    // emerald-200 — use emerald300 (closest lighter token)
    backgroundColor: colors.emerald300,
    alignItems:      'center',
    justifyContent:  'center',
    flexShrink:      0,
  } as ViewStyle,

  avatarText: {
    fontSize:   12,
    fontWeight: '700',
    color:      colors.emerald900,
  } as TextStyle,

  info: {
    flex: 1,
    gap:  2,
  } as ViewStyle,

  nameAge: {
    fontSize:   14,
    fontWeight: '600',
    color:      colors.textPrimary,
  } as TextStyle,

  meta: {
    fontSize:  12,
    color:     colors.textSecondary,
    lineHeight: 16,
  } as TextStyle,
});

// ── Question row ──────────────────────────────────────────────────────────────

interface QuestionRowProps {
  questionId: string;
  text: string;
  checked: boolean;
  onToggle: (id: string) => void;
}

function QuestionRow({
  questionId,
  text,
  checked,
  onToggle,
}: QuestionRowProps): React.JSX.Element {
  return (
    <TouchableOpacity
      style={[qRowStyles.row, checked && qRowStyles.rowChecked]}
      onPress={() => onToggle(questionId)}
      activeOpacity={0.7}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={text}
    >
      {/* Checkbox indicator */}
      <View style={[qRowStyles.checkbox, checked && qRowStyles.checkboxChecked]}>
        {checked && <Check size={11} color={colors.cardBg} strokeWidth={3} />}
      </View>

      {/* Question text */}
      <Text style={[qRowStyles.text, checked && qRowStyles.textChecked]}>
        {text}
      </Text>
    </TouchableOpacity>
  );
}

const qRowStyles = StyleSheet.create({
  row: {
    flexDirection:  'row',
    alignItems:     'flex-start',
    gap:            spacing.sm + 2,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.sm + 2,
    borderRadius:   radius.md,
  } as ViewStyle,

  rowChecked: {
    backgroundColor: colors.teal100,
  } as ViewStyle,

  checkbox: {
    width:          18,
    height:         18,
    borderRadius:   5,
    borderWidth:    2,
    borderColor:    colors.cardBorder,
    flexShrink:     0,
    marginTop:      1,
    alignItems:     'center',
    justifyContent: 'center',
  } as ViewStyle,

  checkboxChecked: {
    backgroundColor: colors.emerald500,
    borderColor:     colors.emerald500,
  } as ViewStyle,

  text: {
    flex:       1,
    fontSize:   14,
    color:      colors.textPrimary,
    lineHeight: 20,
  } as TextStyle,

  textChecked: {
    color: colors.gray700,
  } as TextStyle,
});

// ── Section block ─────────────────────────────────────────────────────────────

interface QuestionSectionBlockProps {
  section: QuestionSection;
  checkedIds: Set<string>;
  onToggle: (id: string) => void;
}

function QuestionSectionBlock({
  section,
  checkedIds,
  onToggle,
}: QuestionSectionBlockProps): React.JSX.Element {
  return (
    <View style={sectionStyles.container}>
      <Text style={sectionStyles.label}>{section.section}</Text>

      <Card style={sectionStyles.card}>
        {section.questions.map((question) => {
          const id = `${section.section}::${question}`;
          return (
            <QuestionRow
              key={id}
              questionId={id}
              text={question}
              checked={checkedIds.has(id)}
              onToggle={onToggle}
            />
          );
        })}
      </Card>
    </View>
  );
}

const sectionStyles = StyleSheet.create({
  container: {
    gap: spacing.sm,
  } as ViewStyle,

  label: {
    fontSize:        11,
    fontWeight:      '700',
    textTransform:   'uppercase',
    letterSpacing:   0.6,
    color:           colors.emerald500,
    paddingLeft:     4,
  } as TextStyle,

  card: {
    padding: spacing.xs,
    gap:     2,
  } as ViewStyle,
});

// ── Compass Insight footer ────────────────────────────────────────────────────

interface InsightFooterProps {
  vertical: string | undefined;
}

function InsightFooter({ vertical }: InsightFooterProps): React.JSX.Element {
  const verticalLabel = vertical
    ? vertical.replace('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    : 'this member';

  return (
    <View style={insightStyles.container}>
      <View style={insightStyles.header}>
        <Sparkles size={14} color={colors.primary} />
        <Text style={insightStyles.title}>Compass Insight</Text>
        <Pill variant="emerald" size="sm">BETA</Pill>
      </View>
      <Text style={insightStyles.body}>
        These suggestions are tuned to{' '}
        <Text style={insightStyles.bodyBold}>{verticalLabel}</Text>.{' '}
        AI-personalized prompts using Anthropic + session history are coming next.
      </Text>
    </View>
  );
}

const insightStyles = StyleSheet.create({
  container: {
    padding:         spacing.lg,
    borderRadius:    radius.lg,
    backgroundColor: colors.teal100,
    borderWidth:     1,
    borderColor:     colors.emerald100,
    gap:             spacing.xs,
  } as ViewStyle,

  header: {
    flexDirection:  'row',
    alignItems:     'center',
    gap:            spacing.sm,
    marginBottom:   2,
  } as ViewStyle,

  title: {
    fontSize:   12,
    fontWeight: '600',
    color:      colors.textPrimary,
    flex:       1,
  } as TextStyle,

  body: {
    fontSize:   12,
    color:      colors.gray700,
    lineHeight: 18,
  } as TextStyle,

  bodyBold: {
    fontWeight: '600',
  } as TextStyle,
});

// ── Drawer footer (sticky) ────────────────────────────────────────────────────

interface DrawerFooterProps {
  onCopyScript?: () => void;
  onSaveNote?:   () => void;
  onMarkComplete?: () => void;
  onClose: () => void;
}

function DrawerFooter({
  onCopyScript,
  onSaveNote,
  onMarkComplete,
  onClose,
}: DrawerFooterProps): React.JSX.Element {
  return (
    <View style={footerStyles.container}>
      {/* 2-col action row */}
      <View style={footerStyles.row}>
        <TouchableOpacity
          style={footerStyles.secondaryBtn}
          onPress={onCopyScript}
          accessibilityRole="button"
          accessibilityLabel="Copy script"
        >
          <Copy size={15} color={colors.gray700} />
          <Text style={footerStyles.secondaryBtnText}>Copy Script</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={footerStyles.secondaryBtn}
          onPress={onSaveNote}
          accessibilityRole="button"
          accessibilityLabel="Save as note"
        >
          <NotebookPen size={15} color={colors.gray700} />
          <Text style={footerStyles.secondaryBtnText}>Save as Note</Text>
        </TouchableOpacity>
      </View>

      {/* Full-width primary CTA */}
      <TouchableOpacity
        style={footerStyles.primaryBtn}
        onPress={() => {
          onMarkComplete?.();
          onClose();
        }}
        accessibilityRole="button"
        accessibilityLabel="Mark call completed"
      >
        <CheckCircle2 size={18} color={colors.cardBg} />
        <Text style={footerStyles.primaryBtnText}>Mark Call Completed</Text>
      </TouchableOpacity>
    </View>
  );
}

const footerStyles = StyleSheet.create({
  container: {
    gap: spacing.sm,
  } as ViewStyle,

  row: {
    flexDirection: 'row',
    gap:           spacing.sm,
  } as ViewStyle,

  secondaryBtn: {
    flex:            1,
    flexDirection:   'row',
    alignItems:      'center',
    justifyContent:  'center',
    gap:             6,
    paddingVertical: spacing.sm + 2,
    borderWidth:     1,
    borderColor:     colors.cardBorder,
    borderRadius:    radius.md,
    backgroundColor: colors.cardBg,
  } as ViewStyle,

  secondaryBtnText: {
    fontSize:   13,
    fontWeight: '600',
    color:      colors.gray700,
  } as TextStyle,

  primaryBtn: {
    flexDirection:   'row',
    alignItems:      'center',
    justifyContent:  'center',
    gap:             8,
    paddingVertical: spacing.md,
    borderRadius:    radius.lg,
    backgroundColor: colors.primary,
  } as ViewStyle,

  primaryBtnText: {
    fontSize:   15,
    fontWeight: '700',
    color:      colors.cardBg,
  } as TextStyle,
});

// ─── Main component ───────────────────────────────────────────────────────────

/**
 * OpenQuestionsDrawer
 *
 * Right-side overlay with suggested call questions for the active member.
 * Uses the existing RightDrawer shell for all platform-level animation and
 * modal behaviour; this component supplies only the content.
 *
 * ```tsx
 * <OpenQuestionsDrawer
 *   visible={open}
 *   onClose={() => setOpen(false)}
 *   member={{ name: 'Ana Garcia', age: 38, initials: 'AG', primaryLanguage: 'English', lastContactRelative: '2 days ago', engagementLabel: 'Highly Engaged' }}
 *   journey={{ templateName: 'Food Assistance Journey', currentStepName: 'Upload Documents', vertical: 'food' }}
 *   onMarkComplete={() => console.log('call marked complete')}
 * />
 * ```
 */
/**
 * Viewport breakpoint (px) above which the drawer renders inline (no backdrop)
 * rather than as a fixed overlay. Matches the CHWMessages 3-pane threshold.
 *
 * Exported so consumer screens can use the same value to conditionally place
 * the drawer inside the content flex-row vs outside the scroll.
 */
export const OPEN_QUESTIONS_INLINE_BREAKPOINT = 1024;

/**
 * Fixed pixel width of the inline panel on wide viewports.
 * Exported so consumer screens can reserve space in their flex layout.
 */
export const OPEN_QUESTIONS_INLINE_WIDTH = 360;

export function OpenQuestionsDrawer({
  visible,
  onClose,
  member,
  journey,
  onMarkComplete,
  onCopyScript,
  onSaveNote,
}: OpenQuestionsDrawerProps): React.JSX.Element {
  const { width: windowWidth } = useWindowDimensions();

  /**
   * On web viewports >= 1024px the drawer is an inline side panel with no
   * backdrop. Below 1024px (or on native) it falls back to the modal/overlay
   * behaviour so mobile users get the conventional sheet UX.
   */
  const isInline =
    Platform.OS === 'web' && windowWidth >= OPEN_QUESTIONS_INLINE_BREAKPOINT;

  // Checked question ids. Key = `${section}::${question}`.
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());

  // Reset checkboxes whenever a new member/journey is surfaced.
  useEffect(() => {
    if (visible) {
      setCheckedIds(new Set());
    }
  }, [visible, member.name, journey?.vertical]);

  /**
   * Dismiss on Escape key (web only).
   * Works in both inline and overlay modes — the user explicitly presses Esc.
   */
  useEffect(() => {
    if (Platform.OS !== 'web') return;

    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }

    if (visible) {
      document.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [visible, onClose]);

  const handleToggle = useCallback((id: string): void => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const sections = resolveQuestions(journey?.vertical);

  // Drawer subtitle line reflects the active journey if present.
  const subtitle = journey
    ? `Based on ${journey.templateName} · ${journey.currentStepName}`
    : 'General check-in questions';

  return (
    <RightDrawer
      isOpen={visible}
      onClose={onClose}
      title="Suggested Questions for Today's Call"
      subtitle={subtitle}
      inline={isInline}
      inlineWidth={OPEN_QUESTIONS_INLINE_WIDTH}
      footer={
        <DrawerFooter
          onCopyScript={onCopyScript}
          onSaveNote={onSaveNote}
          onMarkComplete={onMarkComplete}
          onClose={onClose}
        />
      }
    >
      {/* Member context strip — rendered inside the scrollable body */}
      <MemberContextStrip member={member} />

      {/* Spacing between strip and first section */}
      <View style={{ height: spacing.xl }} />

      {/* Question sections */}
      <View style={bodyStyles.sections}>
        {sections.map((sec) => (
          <QuestionSectionBlock
            key={sec.section}
            section={sec}
            checkedIds={checkedIds}
            onToggle={handleToggle}
          />
        ))}
      </View>

      {/* Add Custom Question — dashed button (presentation-only v1) */}
      <TouchableOpacity
        style={bodyStyles.addCustomBtn}
        activeOpacity={0.6}
        accessibilityRole="button"
        accessibilityLabel="Add custom question"
        onPress={() => {
          // v1 placeholder — custom question UI is deferred.
        }}
      >
        <Plus size={15} color={colors.textMuted} />
        <Text style={bodyStyles.addCustomText}>Add Custom Question</Text>
      </TouchableOpacity>

      {/* Compass Insight AI footer */}
      <InsightFooter vertical={journey?.vertical} />

      {/* Bottom padding so the last element clears the sticky footer */}
      <View style={{ height: spacing.xxl }} />
    </RightDrawer>
  );
}

// ─── Body styles ──────────────────────────────────────────────────────────────

const bodyStyles = StyleSheet.create({
  sections: {
    gap: spacing.xl,
  } as ViewStyle,

  addCustomBtn: {
    flexDirection:   'row',
    alignItems:      'center',
    justifyContent:  'center',
    gap:             spacing.sm,
    marginTop:       spacing.xl,
    marginBottom:    spacing.xl,
    paddingVertical: spacing.md,
    borderWidth:     2,
    borderStyle:     'dashed',
    borderColor:     colors.cardBorder,
    borderRadius:    radius.lg,
  } as ViewStyle,

  addCustomText: {
    fontSize:   13,
    fontWeight: '500',
    color:      colors.textMuted,
  } as TextStyle,
});

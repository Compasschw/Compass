/**
 * AssessmentForm — renders a questionnaire template one section at a time.
 *
 * Features
 * --------
 * - Section-by-section navigation with a progress bar
 *   "Section 3 of 17 · 11 of 39 questions"
 * - Per-answer save: tapping an option POSTs the response immediately
 *   (optimistic UI — the option shows as selected instantly)
 * - Per-question Skip (Epic W2): every question also renders a "Skip this
 *   question" affordance. Tapping it persists a response with
 *   `skipped: true` — distinct from both a real answer and an unanswered
 *   question — via the same per-answer POST + optimistic-UI + retry path as
 *   a normal answer. A skipped question counts toward the "X of 39" progress
 *   total exactly like an answered one.
 * - Partial save + resume (Epic W3): `initialAnswers` seeds the form's local
 *   answer state on mount so reopening an in-progress assessment shows prior
 *   answers AND prior skips already selected, not a blank form. The actual
 *   per-answer persistence this hydrates from already happened on a previous
 *   visit — this prop only affects the initial render, never triggers a POST.
 * - On POST failure: toast "Couldn't save — tap to retry" with retry tap
 *   (works identically for a failed answer or a failed skip)
 * - "Save & Close" button — persists nothing new itself (every answer/skip is
 *   already saved the moment it's tapped); it simply leaves the assessment
 *   in_progress and hands control back to the caller so the CHW can stop and
 *   resume later. No API call.
 * - "Done" button at the last section — calls /complete
 * - "Next" / "Back" navigation between sections
 * - Mobile + web responsive (max-width capped at 640px on wide screens)
 *
 * Props
 * -----
 * assessmentId    — UUID of the in_progress assessment
 * template        — full template dict from the API
 * onComplete      — called when the CHW taps Done and /complete succeeds
 * onPause         — called when the CHW taps "Save & Close" (no API call — stays in_progress)
 * initialAnswers  — optional prior answers/skips to hydrate on mount (resume support)
 *
 * HIPAA: question text and answer values are PHI-adjacent. They are never
 * logged. Error toasts do NOT include question or answer content.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { CheckCircle, Circle, ChevronLeft, ChevronRight, Save, SkipForward } from 'lucide-react-native';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { colors } from '../../theme/colors';
import { fonts } from '../../theme/typography';

// ─── Types ────────────────────────────────────────────────────────────────────

interface TemplateOption {
  value: string;
  label: string;
}

interface TemplateQuestion {
  id: string;
  section_id: string;
  source_q_num: number;
  text: string;
  category: string;
  subcategory: string;
  tags: string[];
  options: TemplateOption[];
}

interface TemplateSection {
  id: string;
  title: string;
  part: number;
  part_label: string;
  category: string;
}

interface Template {
  id: string;
  name: string;
  total_questions: number;
  sections: TemplateSection[];
  questions: TemplateQuestion[];
}

/**
 * Per-question save state used by the optimistic UI layer.
 * 'idle'    — not yet answered in this session
 * 'saving'  — POST in-flight
 * 'saved'   — POST succeeded
 * 'error'   — POST failed; show retry toast
 */
type AnswerSaveState = 'idle' | 'saving' | 'saved' | 'error';

interface LocalAnswer {
  questionId: string;
  value: string;
  label: string;
  /** Epic W2 — true if this answer was recorded via "Skip", not a real selection. */
  skipped: boolean;
  saveState: AnswerSaveState;
}

/**
 * A prior answer (or skip) to hydrate into the form on mount — Epic W3
 * resume support. Shape matches the persisted response, trimmed to just
 * what the form needs to seed local state.
 */
export interface AssessmentFormInitialAnswer {
  questionId: string;
  value: string;
  label: string;
  skipped: boolean;
}

interface AssessmentFormProps {
  assessmentId: string;
  template: Template;
  onComplete: () => void;
  onPause: () => void;
  /** Prior answers/skips to seed the form with on mount (Epic W3 resume). */
  initialAnswers?: AssessmentFormInitialAnswer[];
}

/** Sentinel value/label written for a skipped question (Epic W2). Mirrors the
 * backend's reserved placeholder (see backend/app/schemas/assessment.py) —
 * sent explicitly rather than relying on the server default so the contract
 * is self-documenting end-to-end. */
const SKIP_SENTINEL = { value: 'skipped', label: 'Skipped' } as const;

// ─── API helpers ──────────────────────────────────────────────────────────────

interface AnswerSelection {
  value: string;
  label: string;
  /** Epic W2 — true when this POST represents a "Skip" tap, not a real answer. */
  skipped: boolean;
}

async function postResponse(
  assessmentId: string,
  question: TemplateQuestion,
  selection: AnswerSelection,
): Promise<void> {
  await api(`/assessments/${assessmentId}/responses`, {
    method: 'POST',
    body: JSON.stringify({
      question_id: question.id,
      question_text: question.text,
      answer_value: selection.value,
      answer_label: selection.label,
      skipped: selection.skipped,
      category: question.category,
      subcategory: question.subcategory,
      tags: question.tags,
      // captured_at intentionally omitted — server stamps UTC
    }),
  });
}

async function postComplete(assessmentId: string): Promise<void> {
  await api(`/assessments/${assessmentId}/complete`, { method: 'POST' });
}

// ─── Retry toast ──────────────────────────────────────────────────────────────

interface RetryToastProps {
  visible: boolean;
  onRetry: () => void;
  onDismiss: () => void;
}

function RetryToast({ visible, onRetry, onDismiss }: RetryToastProps): React.ReactElement | null {
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(opacity, {
      toValue: visible ? 1 : 0,
      duration: 200,
      useNativeDriver: true,
    }).start();
  }, [visible, opacity]);

  if (!visible) return null;

  return (
    <Animated.View style={[styles.retryToast, { opacity }]}>
      <Text style={styles.retryToastText}>Couldn't save — </Text>
      <TouchableOpacity onPress={onRetry} accessibilityRole="button" accessibilityLabel="Retry saving answer">
        <Text style={styles.retryToastAction}>tap to retry</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={onDismiss} style={styles.retryDismiss}>
        <Text style={styles.retryDismissText}>✕</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function AssessmentForm({
  assessmentId,
  template,
  onComplete,
  onPause,
  initialAnswers,
}: AssessmentFormProps): React.ReactElement {
  const { width } = useWindowDimensions();
  const qc = useQueryClient();

  // Build a section → questions map for navigation
  const sectionQuestions = useMemo<Map<string, TemplateQuestion[]>>(() => {
    const map = new Map<string, TemplateQuestion[]>();
    for (const q of template.questions) {
      const arr = map.get(q.section_id) ?? [];
      arr.push(q);
      map.set(q.section_id, arr);
    }
    return map;
  }, [template.questions]);

  const sections = template.sections;
  const totalQuestions = template.total_questions;

  const [sectionIndex, setSectionIndex] = useState<number>(0);
  // Epic W3 — seed prior answers/skips on mount. This runs once: callers are
  // documented to mount a fresh AssessmentForm instance per assessment (see
  // useAssessmentBootstrap's header comment), so initialAnswers never changes
  // mid-lifetime and re-seeding on every render would be wrong (it would
  // stomp in-flight local edits with stale server state).
  const [answers, setAnswers] = useState<Map<string, LocalAnswer>>(() => {
    const seeded = new Map<string, LocalAnswer>();
    for (const prior of initialAnswers ?? []) {
      seeded.set(prior.questionId, {
        questionId: prior.questionId,
        value: prior.value,
        label: prior.label,
        skipped: prior.skipped,
        saveState: 'saved',
      });
    }
    return seeded;
  });
  const [retryQid, setRetryQid] = useState<string | null>(null);
  const [isCompleting, setIsCompleting] = useState<boolean>(false);
  const scrollRef = useRef<ScrollView>(null);

  const currentSection = sections[sectionIndex];
  const questionsInSection = sectionQuestions.get(currentSection?.id ?? '') ?? [];
  const isFirstSection = sectionIndex === 0;
  const isLastSection = sectionIndex === sections.length - 1;

  // Count total questions answered so far across all sections
  const answeredCount = answers.size;

  // Count questions answered in the current section (for progress display)
  const answeredInSection = questionsInSection.filter((q) => answers.has(q.id)).length;

  // Questions answered before this section (for absolute count)
  const answeredBeforeSection = useMemo(() => {
    let count = 0;
    for (let i = 0; i < sectionIndex; i++) {
      const qs = sectionQuestions.get(sections[i]?.id ?? '') ?? [];
      count += qs.length;
    }
    return count;
  }, [sectionIndex, sectionQuestions, sections]);

  const absoluteQuestionOffset = answeredBeforeSection;

  // ── Answer / Skip submission with optimistic UI ─────────────────────────────

  /**
   * Shared submit path for both a real answer and a "Skip" tap — identical
   * optimistic-UI + POST + retry-on-failure behavior either way, so a
   * skipped question gets exactly the same reliability guarantees as an
   * answered one.
   */
  const submitAnswer = useCallback(
    async (question: TemplateQuestion, selection: AnswerSelection) => {
      // Optimistic update — show as selected/skipped immediately
      setAnswers((prev) => {
        const next = new Map(prev);
        next.set(question.id, {
          questionId: question.id,
          value: selection.value,
          label: selection.label,
          skipped: selection.skipped,
          saveState: 'saving',
        });
        return next;
      });
      setRetryQid(null);

      try {
        await postResponse(assessmentId, question, selection);
        setAnswers((prev) => {
          const next = new Map(prev);
          const existing = next.get(question.id);
          if (existing) {
            next.set(question.id, { ...existing, saveState: 'saved' });
          }
          return next;
        });
      } catch {
        setAnswers((prev) => {
          const next = new Map(prev);
          const existing = next.get(question.id);
          if (existing) {
            next.set(question.id, { ...existing, saveState: 'error' });
          }
          return next;
        });
        setRetryQid(question.id);
      }
    },
    [assessmentId],
  );

  const handleSelectOption = useCallback(
    (question: TemplateQuestion, option: TemplateOption) => {
      const prev = answers.get(question.id);
      // If tapping the same option that is already saved (and it wasn't a
      // skip), no-op.
      if (!prev?.skipped && prev?.value === option.value && prev?.saveState === 'saved') return;
      void submitAnswer(question, { value: option.value, label: option.label, skipped: false });
    },
    [answers, submitAnswer],
  );

  const handleSkipQuestion = useCallback(
    (question: TemplateQuestion) => {
      const prev = answers.get(question.id);
      // Already skipped and saved — repeat taps are a no-op.
      if (prev?.skipped && prev.saveState === 'saved') return;
      void submitAnswer(question, { ...SKIP_SENTINEL, skipped: true });
    },
    [answers, submitAnswer],
  );

  const handleRetry = useCallback(() => {
    if (!retryQid) return;
    const answer = answers.get(retryQid);
    const question = template.questions.find((q) => q.id === retryQid);
    if (!answer || !question) return;

    setRetryQid(null);

    if (answer.skipped) {
      handleSkipQuestion(question);
      return;
    }

    const option = question.options.find((o) => o.value === answer.value);
    if (!option) return;
    handleSelectOption(question, option);
  }, [retryQid, answers, template.questions, handleSelectOption, handleSkipQuestion]);

  // ── Navigation ─────────────────────────────────────────────────────────────

  const handleNext = useCallback(() => {
    if (isLastSection) return;
    setSectionIndex((prev) => prev + 1);
    scrollRef.current?.scrollTo({ y: 0, animated: true });
  }, [isLastSection]);

  const handleBack = useCallback(() => {
    if (isFirstSection) return;
    setSectionIndex((prev) => prev - 1);
    scrollRef.current?.scrollTo({ y: 0, animated: true });
  }, [isFirstSection]);

  // ── Complete ───────────────────────────────────────────────────────────────

  const handleComplete = useCallback(async () => {
    if (isCompleting) return;
    setIsCompleting(true);
    try {
      await postComplete(assessmentId);
      void qc.invalidateQueries({ queryKey: ['assessments', assessmentId] });
      onComplete();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Please try again.';
      Alert.alert('Something went wrong', message);
      setIsCompleting(false);
    }
  }, [assessmentId, isCompleting, onComplete, qc]);

  // ─── Render ────────────────────────────────────────────────────────────────

  if (!currentSection) {
    return (
      <View style={styles.centerState}>
        <Text style={styles.emptyText}>No sections in template.</Text>
      </View>
    );
  }

  const containerMaxWidth = Math.min(width, 640);

  return (
    <View style={[styles.root, { maxWidth: containerMaxWidth, alignSelf: 'center', width: '100%' }]}>
      {/* Retry toast — floats above content */}
      <RetryToast
        visible={retryQid !== null}
        onRetry={handleRetry}
        onDismiss={() => setRetryQid(null)}
      />

      {/* Progress header */}
      <View style={styles.progressHeader}>
        <Text style={styles.progressLabel}>
          Section {sectionIndex + 1} of {sections.length}{'  ·  '}
          {absoluteQuestionOffset + answeredInSection} of {totalQuestions} questions
        </Text>
        <View style={styles.progressBarTrack}>
          <View
            style={[
              styles.progressBarFill,
              { width: `${((absoluteQuestionOffset + answeredInSection) / totalQuestions) * 100}%` as any },
            ]}
          />
        </View>
        <Text style={styles.progressHelperText}>
          Answers save automatically — tap Save &amp; Close anytime to pause and resume later.
        </Text>
      </View>

      {/* Section title */}
      <View style={styles.sectionHeader}>
        <Text style={styles.partLabel}>
          Part {currentSection.part} — {currentSection.part_label}
        </Text>
        <Text style={styles.sectionTitle}>{currentSection.title}</Text>
      </View>

      {/* Questions */}
      <ScrollView
        ref={scrollRef}
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {questionsInSection.map((question, idx) => {
          const answer = answers.get(question.id);
          return (
            <View key={question.id} style={styles.questionCard}>
              <Text style={styles.questionNumber}>
                Q{absoluteQuestionOffset + idx + 1}
              </Text>
              <Text style={styles.questionText}>{question.text}</Text>

              {question.tags.length > 0 && (
                <View style={styles.tagRow}>
                  {question.tags.map((tag) => (
                    <View key={tag} style={styles.tag}>
                      <Text style={styles.tagText}>{tag}</Text>
                    </View>
                  ))}
                </View>
              )}

              <View style={styles.optionsContainer}>
                {question.options.map((option) => {
                  // A skipped answer must never visually collide with a real
                  // option, even if a template option's value happened to
                  // equal the skip sentinel — `skipped` is authoritative.
                  const isSelected = !answer?.skipped && answer?.value === option.value;
                  const isSaving = isSelected && answer?.saveState === 'saving';
                  const isError = isSelected && answer?.saveState === 'error';
                  return (
                    <TouchableOpacity
                      key={option.value}
                      onPress={() => handleSelectOption(question, option)}
                      style={[
                        styles.optionRow,
                        isSelected && styles.optionRowSelected,
                        isError && styles.optionRowError,
                      ]}
                      accessibilityRole="radio"
                      accessibilityLabel={option.label}
                      accessibilityState={{ selected: isSelected }}
                    >
                      <View style={styles.optionIconWrapper}>
                        {isSaving ? (
                          <ActivityIndicator size="small" color={colors.primary} />
                        ) : isSelected ? (
                          <CheckCircle size={20} color={colors.primary} />
                        ) : (
                          <Circle size={20} color={colors.mutedForeground} />
                        )}
                      </View>
                      <Text
                        style={[
                          styles.optionLabel,
                          isSelected && styles.optionLabelSelected,
                        ]}
                      >
                        {option.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}

                {/* Epic W2 — per-question Skip. Distinct row, deliberately
                    quieter styling than a real option so it doesn't read as
                    an equally-weighted answer choice. */}
                {(() => {
                  const isSkipped = answer?.skipped === true;
                  const isSkipSaving = isSkipped && answer?.saveState === 'saving';
                  const isSkipError = isSkipped && answer?.saveState === 'error';
                  return (
                    <TouchableOpacity
                      onPress={() => handleSkipQuestion(question)}
                      style={[
                        styles.skipRow,
                        isSkipped && styles.skipRowActive,
                        isSkipError && styles.optionRowError,
                      ]}
                      accessibilityRole="button"
                      accessibilityLabel="Skip this question"
                      accessibilityState={{ selected: isSkipped }}
                    >
                      <View style={styles.optionIconWrapper}>
                        {isSkipSaving ? (
                          <ActivityIndicator size="small" color={colors.mutedForeground} />
                        ) : (
                          <SkipForward size={16} color={isSkipped ? colors.foreground : colors.mutedForeground} />
                        )}
                      </View>
                      <Text style={[styles.skipLabel, isSkipped && styles.skipLabelActive]}>
                        {isSkipped ? 'Skipped' : 'Skip this question'}
                      </Text>
                    </TouchableOpacity>
                  );
                })()}
              </View>
            </View>
          );
        })}

        {/* Bottom navigation */}
        <View style={styles.navRow}>
          {/* Back */}
          <TouchableOpacity
            onPress={handleBack}
            disabled={isFirstSection}
            style={[styles.navButton, isFirstSection && styles.navButtonDisabled]}
            accessibilityRole="button"
            accessibilityLabel="Previous section"
          >
            <ChevronLeft size={18} color={isFirstSection ? '#D1D5DB' : colors.foreground} />
            <Text style={[styles.navButtonText, isFirstSection && styles.navButtonTextDisabled]}>
              Back
            </Text>
          </TouchableOpacity>

          {/* Save & Close (Epic W3) — explicit "stop here, resume later" affordance.
              Every answer/skip is already persisted the instant it's tapped;
              this button makes that guarantee visible and hands control back
              to the caller (no API call — the assessment stays in_progress). */}
          <TouchableOpacity
            onPress={onPause}
            style={styles.pauseButton}
            accessibilityRole="button"
            accessibilityLabel="Save and close assessment"
          >
            <Save size={16} color={colors.mutedForeground} />
            <Text style={styles.pauseButtonText}>Save &amp; Close</Text>
          </TouchableOpacity>

          {/* Next or Done */}
          {isLastSection ? (
            <TouchableOpacity
              onPress={handleComplete}
              disabled={isCompleting}
              style={[styles.doneButton, isCompleting && styles.doneButtonDisabled]}
              accessibilityRole="button"
              accessibilityLabel="Complete assessment"
            >
              {isCompleting ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Text style={styles.doneButtonText}>Done</Text>
              )}
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              onPress={handleNext}
              style={styles.nextButton}
              accessibilityRole="button"
              accessibilityLabel="Next section"
            >
              <Text style={styles.nextButtonText}>Next</Text>
              <ChevronRight size={18} color="#FFFFFF" />
            </TouchableOpacity>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  centerState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: {
    color: colors.mutedForeground,
    fontSize: 14,
  },

  // Progress header
  progressHeader: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  progressLabel: {
    fontSize: 12,
    color: colors.mutedForeground,
    marginBottom: 6,
    fontWeight: '500',
  },
  progressBarTrack: {
    height: 4,
    backgroundColor: colors.border,
    borderRadius: 2,
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: colors.primary,
    borderRadius: 2,
  },
  progressHelperText: {
    fontSize: 11,
    color: colors.mutedForeground,
    marginTop: 6,
    lineHeight: 15,
  },

  // Section header
  sectionHeader: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 10,
  },
  partLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.primary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.foreground,
    fontFamily: fonts.display,
  },

  // Scroll
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingBottom: 32,
  },

  // Question card
  questionCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    marginBottom: 12,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 2 },
      android: { elevation: 1 },
    }),
  },
  questionNumber: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.mutedForeground,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  questionText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.foreground,
    lineHeight: 22,
    marginBottom: 8,
  },
  tagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginBottom: 10,
  },
  tag: {
    backgroundColor: '#F3F4F6',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  tagText: {
    fontSize: 10,
    fontWeight: '600',
    color: '#4B5563',
  },
  optionsContainer: {
    gap: 6,
  },

  // Option rows
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: '#FAFAFA',
  },
  optionRowSelected: {
    borderColor: colors.primary,
    backgroundColor: '#F5F3FF',
  },
  optionRowError: {
    borderColor: '#EF4444',
    backgroundColor: '#FEF2F2',
  },
  optionIconWrapper: {
    width: 24,
    alignItems: 'center',
    marginRight: 10,
  },
  optionLabel: {
    flex: 1,
    fontSize: 14,
    color: colors.foreground,
    lineHeight: 20,
  },
  optionLabelSelected: {
    fontWeight: '600',
    color: colors.primary,
  },

  // Skip row (Epic W2) — deliberately quieter than a real option: dashed
  // border, muted colors, so it doesn't read as an equally-weighted choice.
  skipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.border,
    backgroundColor: 'transparent',
    marginTop: 2,
  },
  skipRowActive: {
    borderStyle: 'solid',
    borderColor: colors.mutedForeground,
    backgroundColor: colors.muted,
  },
  skipLabel: {
    flex: 1,
    fontSize: 13,
    color: colors.mutedForeground,
    lineHeight: 18,
  },
  skipLabelActive: {
    fontWeight: '600',
    color: colors.foreground,
  },

  // Navigation row
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 16,
    gap: 8,
  },
  navButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: '#FFFFFF',
  },
  navButtonDisabled: {
    opacity: 0.4,
  },
  navButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.foreground,
    marginLeft: 2,
  },
  navButtonTextDisabled: {
    color: '#D1D5DB',
  },
  pauseButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 10,
    gap: 4,
  },
  pauseButtonText: {
    fontSize: 13,
    color: colors.mutedForeground,
    fontWeight: '500',
  },
  nextButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    backgroundColor: colors.primary,
    gap: 4,
  },
  nextButtonText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  doneButton: {
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 8,
    backgroundColor: '#10B981',
    minWidth: 80,
    alignItems: 'center',
  },
  doneButtonDisabled: {
    opacity: 0.6,
  },
  doneButtonText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#FFFFFF',
  },

  // Retry toast
  retryToast: {
    position: 'absolute',
    top: 60,
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1F2937',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    zIndex: 999,
  },
  retryToastText: {
    color: '#F9FAFB',
    fontSize: 13,
  },
  retryToastAction: {
    color: '#FCD34D',
    fontSize: 13,
    fontWeight: '700',
    textDecorationLine: 'underline',
  },
  retryDismiss: {
    marginLeft: 'auto',
    paddingLeft: 12,
  },
  retryDismissText: {
    color: '#9CA3AF',
    fontSize: 14,
  },
});

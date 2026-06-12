/**
 * IntroductionScriptPanel — CHW-facing introduction script sidebar.
 *
 * Displays the 7-step Compass CHW Introduction Script as expandable step cards
 * alongside the health questionnaire. Each card shows:
 *   - The verbatim CHW-facing script text (italic)
 *   - Colour-coded tip boxes:
 *       hesitant → purple   "If the member seems hesitant"
 *       digital  → blue     "If the member is unfamiliar with digital tools"
 *       policy   → amber    "Important — Know Your Policy"
 *       crisis   → red      "If the member discloses a crisis"
 *   - Sample transition phrases (monospace, collapsed by default)
 *   - A checkbox the CHW can tap to mark the step done
 *
 * Layout:
 *   - Web / tablet (width ≥ 768): rendered as a fixed-width side panel (320px)
 *     alongside the questionnaire form.
 *   - Mobile (width < 768): rendered as a slide-up Modal triggered from the
 *     "Open intro script" button in the header.
 *
 * Props:
 *   visible      — controls Modal visibility on mobile
 *   onClose      — called when the user dismisses the panel on mobile
 *   steps        — array of intro script step objects from the template
 *   quickPhrases — quick reference phrase library from the template
 *
 * HIPAA note: this panel contains no PHI — it is CHW reference material only.
 */

import React, { useState, useCallback } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { CheckSquare, ChevronDown, ChevronRight, Square, X as XIcon } from 'lucide-react-native';
import { colors } from '../../theme/colors';
import { fonts } from '../../theme/typography';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface IntroTip {
  type: 'hesitant' | 'digital' | 'policy' | 'crisis';
  label: string;
  text: string;
}

export interface IntroStep {
  step: number;
  title: string;
  script_text: string;
  tips: IntroTip[];
  phrases: string[];
}

export interface QuickPhrases {
  opening: string[];
  encouragement: string[];
  pacing: string[];
  transitions: string[];
  closing: string[];
  crisis_bridge: string[];
}

interface IntroductionScriptPanelProps {
  visible: boolean;
  onClose: () => void;
  steps: IntroStep[];
  quickPhrases?: QuickPhrases;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PANEL_WIDTH = 320;
const TABLET_BREAKPOINT = 768;

const TIP_COLORS: Record<IntroTip['type'], { bg: string; border: string; labelColor: string }> = {
  hesitant: { bg: '#F3E8FF', border: '#A855F7', labelColor: '#7E22CE' },
  digital:  { bg: '#EFF6FF', border: '#3B82F6', labelColor: '#1D4ED8' },
  policy:   { bg: '#FFFBEB', border: '#F59E0B', labelColor: '#92400E' },
  crisis:   { bg: '#FEF2F2', border: '#EF4444', labelColor: '#991B1B' },
};

// ─── Sub-components ───────────────────────────────────────────────────────────

interface TipBoxProps {
  tip: IntroTip;
}

function TipBox({ tip }: TipBoxProps): React.ReactElement {
  const palette = TIP_COLORS[tip.type];
  return (
    <View
      style={[
        styles.tipBox,
        { backgroundColor: palette.bg, borderLeftColor: palette.border },
      ]}
    >
      <Text style={[styles.tipLabel, { color: palette.labelColor }]}>
        {tip.label}
      </Text>
      <Text style={styles.tipText}>{tip.text}</Text>
    </View>
  );
}

interface StepCardProps {
  step: IntroStep;
  isCompleted: boolean;
  onToggleCompleted: (stepNum: number) => void;
}

function StepCard({ step, isCompleted, onToggleCompleted }: StepCardProps): React.ReactElement {
  const [isExpanded, setIsExpanded] = useState<boolean>(step.step === 1);
  const [showPhrases, setShowPhrases] = useState<boolean>(false);

  const handleToggleExpand = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  const handleTogglePhrases = useCallback(() => {
    setShowPhrases((prev) => !prev);
  }, []);

  const handleCheckbox = useCallback(() => {
    onToggleCompleted(step.step);
  }, [step.step, onToggleCompleted]);

  return (
    <View style={[styles.stepCard, isCompleted && styles.stepCardCompleted]}>
      {/* Step header row */}
      <Pressable
        onPress={handleToggleExpand}
        style={styles.stepHeader}
        accessibilityRole="button"
        accessibilityLabel={`Step ${step.step}: ${step.title}. ${isExpanded ? 'Collapse' : 'Expand'}`}
      >
        <View style={styles.stepHeaderLeft}>
          {/* Checkbox */}
          <TouchableOpacity
            onPress={handleCheckbox}
            accessibilityRole="checkbox"
            accessibilityLabel={`Mark step ${step.step} as ${isCompleted ? 'incomplete' : 'complete'}`}
            style={styles.checkboxTouchable}
          >
            {isCompleted ? (
              <CheckSquare size={20} color={colors.primary} />
            ) : (
              /* No `textSecondary` token exists on the palette — the icon has
                 always rendered with the library default colour. */
              <Square size={20} />
            )}
          </TouchableOpacity>

          <View style={styles.stepTitleGroup}>
            <Text style={styles.stepNumber}>Step {step.step}</Text>
            <Text
              style={[styles.stepTitle, isCompleted && styles.stepTitleCompleted]}
              numberOfLines={2}
            >
              {step.title}
            </Text>
          </View>
        </View>

        {/* No `textSecondary` token exists on the palette — these chevrons have
            always rendered with the library default colour. */}
        {isExpanded ? (
          <ChevronDown size={16} />
        ) : (
          <ChevronRight size={16} />
        )}
      </Pressable>

      {/* Expanded content */}
      {isExpanded && (
        <View style={styles.stepBody}>
          {/* Script text — verbatim CHW language */}
          <Text style={styles.scriptText}>{step.script_text}</Text>

          {/* Tip boxes */}
          {step.tips.map((tip, idx) => (
            <TipBox key={idx} tip={tip} />
          ))}

          {/* Sample phrases — collapsible */}
          {step.phrases.length > 0 && (
            <View style={styles.phrasesSection}>
              <Pressable
                onPress={handleTogglePhrases}
                style={styles.phrasesToggle}
                accessibilityRole="button"
              >
                <Text style={styles.phrasesToggleText}>
                  {showPhrases ? 'Hide sample phrases' : 'Show sample phrases'}
                </Text>
                {showPhrases ? (
                  <ChevronDown size={14} color={colors.primary} />
                ) : (
                  <ChevronRight size={14} color={colors.primary} />
                )}
              </Pressable>

              {showPhrases && (
                <View style={styles.phrasesList}>
                  {step.phrases.map((phrase, idx) => (
                    <Text key={idx} style={styles.phraseItem}>
                      {'“'}{phrase}{'”'}
                    </Text>
                  ))}
                </View>
              )}
            </View>
          )}
        </View>
      )}
    </View>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function IntroductionScriptPanel({
  visible,
  onClose,
  steps,
  quickPhrases,
}: IntroductionScriptPanelProps): React.ReactElement | null {
  const { width } = useWindowDimensions();
  const isTablet = width >= TABLET_BREAKPOINT;

  const [completedSteps, setCompletedSteps] = useState<Set<number>>(new Set());
  const [showQuickRef, setShowQuickRef] = useState<boolean>(false);

  const completedCount = completedSteps.size;
  const totalSteps = steps.length;

  const handleToggleCompleted = useCallback((stepNum: number) => {
    setCompletedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(stepNum)) {
        next.delete(stepNum);
      } else {
        next.add(stepNum);
      }
      return next;
    });
  }, []);

  const panelContent = (
    <View style={styles.panelInner}>
      {/* Panel header */}
      <View style={styles.panelHeader}>
        <View>
          <Text style={styles.panelTitle}>Introduction Script</Text>
          <Text style={styles.panelSubtitle}>
            {completedCount} of {totalSteps} steps completed
          </Text>
        </View>
        {!isTablet && (
          <TouchableOpacity
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close introduction script"
            style={styles.closeButton}
          >
            {/* No `textSecondary` token exists on the palette — the icon has
                always rendered with the library default colour. */}
            <XIcon size={20} />
          </TouchableOpacity>
        )}
      </View>

      {/* Progress bar */}
      <View style={styles.progressBarTrack}>
        <View
          style={[
            styles.progressBarFill,
            { width: `${(completedCount / totalSteps) * 100}%` as any },
          ]}
        />
      </View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Step cards */}
        {steps.map((step) => (
          <StepCard
            key={step.step}
            step={step}
            isCompleted={completedSteps.has(step.step)}
            onToggleCompleted={handleToggleCompleted}
          />
        ))}

        {/* Quick Reference section */}
        {quickPhrases && (
          <View style={styles.quickRefSection}>
            <Pressable
              onPress={() => setShowQuickRef((prev) => !prev)}
              style={styles.quickRefHeader}
              accessibilityRole="button"
            >
              <Text style={styles.quickRefTitle}>Quick Reference Phrases</Text>
              {showQuickRef ? (
                <ChevronDown size={16} color={colors.primary} />
              ) : (
                <ChevronRight size={16} color={colors.primary} />
              )}
            </Pressable>

            {showQuickRef && (
              <View style={styles.quickRefContent}>
                {Object.entries(quickPhrases).map(([category, phrases]) => (
                  <View key={category} style={styles.quickRefCategory}>
                    <Text style={styles.quickRefCategoryLabel}>
                      {category.replace('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                    </Text>
                    {(phrases as string[]).map((phrase, idx) => (
                      <Text key={idx} style={styles.quickRefPhrase}>
                        {'•'} {phrase}
                      </Text>
                    ))}
                  </View>
                ))}
              </View>
            )}
          </View>
        )}
      </ScrollView>
    </View>
  );

  // On tablet/web: render inline (caller controls visibility via CSS/layout)
  if (isTablet) {
    if (!visible) return null;
    return <View style={styles.panelContainer}>{panelContent}</View>;
  }

  // On mobile: render as a slide-up modal
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.modalContainer}>{panelContent}</View>
    </Modal>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  panelContainer: {
    width: PANEL_WIDTH,
    borderLeftWidth: 1,
    borderLeftColor: colors.border,
    backgroundColor: colors.card,
    height: '100%',
  },
  modalContainer: {
    flex: 1,
    backgroundColor: colors.card,
  },
  panelInner: {
    flex: 1,
  },
  panelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  panelTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.foreground,
    fontFamily: fonts.displayMedium,
  },
  panelSubtitle: {
    fontSize: 12,
    color: colors.mutedForeground,
    marginTop: 2,
  },
  closeButton: {
    padding: 4,
  },
  progressBarTrack: {
    height: 3,
    backgroundColor: colors.border,
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: 2,
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: colors.primary,
    borderRadius: 2,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 12,
    paddingBottom: 24,
  },

  // Step card
  stepCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    marginVertical: 4,
    overflow: 'hidden',
  },
  stepCardCompleted: {
    borderColor: colors.primary,
    opacity: 0.85,
  },
  stepHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  stepHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  checkboxTouchable: {
    padding: 2,
    marginRight: 8,
  },
  stepTitleGroup: {
    flex: 1,
  },
  stepNumber: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.primary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  stepTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.foreground,
    marginTop: 1,
  },
  stepTitleCompleted: {
    color: colors.mutedForeground,
    textDecorationLine: 'line-through',
  },
  stepBody: {
    paddingHorizontal: 12,
    paddingBottom: 12,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },

  // Script text — verbatim CHW language, italic
  scriptText: {
    fontSize: 13,
    lineHeight: 20,
    // No `text` token exists on the palette — the `colors.text ?? '#1F2937'`
    // fallback always resolved to the literal below.
    color: '#1F2937',
    fontStyle: 'italic',
    marginTop: 10,
    marginBottom: 8,
  },

  // Tip boxes
  tipBox: {
    borderLeftWidth: 3,
    borderRadius: 4,
    padding: 10,
    marginVertical: 4,
  },
  tipLabel: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 4,
  },
  tipText: {
    fontSize: 12,
    lineHeight: 18,
    color: '#374151',
  },

  // Sample phrases
  phrasesSection: {
    marginTop: 8,
  },
  phrasesToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  phrasesToggleText: {
    fontSize: 12,
    color: colors.primary,
    fontWeight: '600',
  },
  phrasesList: {
    marginTop: 6,
    paddingLeft: 4,
  },
  phraseItem: {
    fontSize: 12,
    lineHeight: 18,
    color: '#374151',
    fontFamily: Platform.OS === 'ios' ? 'Courier New' : 'monospace',
    marginBottom: 4,
  },

  // Quick reference
  quickRefSection: {
    marginTop: 12,
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  quickRefHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 12,
  },
  quickRefTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.foreground,
  },
  quickRefContent: {
    paddingHorizontal: 12,
    paddingBottom: 12,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  quickRefCategory: {
    marginTop: 10,
  },
  quickRefCategoryLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.primary,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 4,
  },
  quickRefPhrase: {
    fontSize: 12,
    lineHeight: 18,
    color: '#374151',
    marginBottom: 2,
  },
});

/**
 * InlineSdohPanel — SDOH / Health Screening questionnaire surfaced INSIDE the
 * CHW Messages page, instead of navigating away to a full screen.
 *
 * Two render variants, chosen by the caller based on viewport width:
 *
 *   'pane'  — Wide desktop (see `SDOH_PANEL_PANE_BREAKPOINT`). Renders as a
 *             fixed-width, in-flow flex column — a genuine 4th pane alongside
 *             [ThreadListPane] [ConversationPane] [MemberContextRail]. No
 *             backdrop. The thread stays visible/interactive and every rail
 *             control (including "Add Case Note") stays reachable, because
 *             this panel is a sibling of the rail, never an overlay on top of
 *             it. This is the primary, non-blocking design the feature asked
 *             for.
 *
 *   'sheet' — Narrow web / native fallback, where there usually isn't a
 *             visible rail to sit beside (see CHWMessagesScreen's
 *             `BP_HIDE_RAIL`). Renders as a dismissible, fixed-position
 *             overlay with a backdrop — the same on-brand look as
 *             `CaseNoteModal` / `OpenQuestionsDrawer`'s narrow mode. This is
 *             a deliberate, documented tradeoff: on these widths the panel
 *             temporarily covers the thread while open (tap the backdrop or
 *             the X to dismiss and return to it). There simply isn't room for
 *             a 4th column below the pane breakpoint.
 *
 * Persistence: this component owns NO answer-saving logic. Bootstrapping
 * (fetch template + start/resume the assessment) is `useAssessmentBootstrap`;
 * per-answer save + completion is `AssessmentForm`, reused completely
 * unmodified — both are the same single source of truth the old full-screen
 * `CHWMemberAssessmentScreen` used, so answers still land in the exact same
 * place and still surface in the member profile's Screening Results.
 *
 * On-brand styling: emerald primary / card tokens from `theme/tokens`,
 * matching `DocumentationModal`'s in-app confirm/success panels and
 * `AppDialogProvider`.
 */
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import { CheckCircle2, X } from 'lucide-react-native';

import { AssessmentForm } from './AssessmentForm';
import { useAssessmentBootstrap } from '../../hooks/useAssessmentBootstrap';
import { colors as tokens, radius, shadows, spacing } from '../../theme/tokens';

// ─── Layout constants ──────────────────────────────────────────────────────────

/** Fixed pixel width of the panel in 'pane' mode. */
export const SDOH_PANEL_WIDTH = 420;

/**
 * Viewport width (px) at/above which the SDOH panel renders as a true 4th
 * pane ('pane' variant) instead of a dismissible overlay ('sheet' variant).
 *
 * CHWMessagesScreen already hides the member context rail below 1280px
 * (`BP_HIDE_RAIL`). This threshold adds `SDOH_PANEL_WIDTH` of headroom on top
 * of that so the conversation pane still has reasonable breathing room with
 * the thread list + rail + SDOH panel all on screen at once.
 */
export const SDOH_PANEL_PANE_BREAKPOINT = 1280 + SDOH_PANEL_WIDTH;

// ─── Props ────────────────────────────────────────────────────────────────────

export type SdohPanelVariant = 'pane' | 'sheet';

export interface InlineSdohPanelProps {
  /** The active session id. Caller must gate on `conv.activeSessionId` before rendering this. */
  sessionId: string;
  /** Member display name, shown in the panel subtitle. */
  memberName?: string | null;
  /** Called when the CHW dismisses the panel (X, backdrop tap, "Pause for now", or "Done" after completion). */
  onClose: () => void;
  variant: SdohPanelVariant;
}

export function InlineSdohPanel({
  sessionId,
  memberName,
  onClose,
  variant,
}: InlineSdohPanelProps): React.JSX.Element {
  const [completed, setCompleted] = useState(false);
  const handleComplete = useCallback(() => setCompleted(true), []);

  const body = completed ? (
    <SdohSuccessState onDone={onClose} />
  ) : (
    <SdohBootstrapBody sessionId={sessionId} onComplete={handleComplete} onPause={onClose} />
  );

  const subtitle = memberName ? `For ${memberName}` : undefined;

  if (variant === 'sheet') {
    return (
      <View style={sheetStyles.root} accessibilityViewIsModal>
        <Pressable
          style={sheetStyles.backdrop}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Dismiss SDOH panel backdrop"
        />
        <View style={[sheetStyles.panel, shadows.card as ViewStyle]}>
          <PanelHeader title="SDOH / Health Screening" subtitle={subtitle} onClose={onClose} />
          <View style={sheetStyles.body}>{body}</View>
        </View>
      </View>
    );
  }

  return (
    <View style={[paneStyles.root, { width: SDOH_PANEL_WIDTH }]} role="region" aria-label="SDOH / Health Screening">
      <PanelHeader title="SDOH / Health Screening" subtitle={subtitle} onClose={onClose} />
      <View style={paneStyles.body}>{body}</View>
    </View>
  );
}

// ─── Bootstrap body — loading / error / ready(AssessmentForm) ─────────────────

interface SdohBootstrapBodyProps {
  sessionId: string;
  onComplete: () => void;
  onPause: () => void;
}

function SdohBootstrapBody({ sessionId, onComplete, onPause }: SdohBootstrapBodyProps): React.JSX.Element {
  const { state, template, assessmentId, errorMessage } = useAssessmentBootstrap(sessionId);

  if (state === 'loading') {
    return (
      <View style={bodyStyles.centerState}>
        <ActivityIndicator size="large" color={tokens.primary} />
        <Text style={bodyStyles.centerText}>Loading questionnaire…</Text>
      </View>
    );
  }

  if (state === 'error') {
    return (
      <View style={bodyStyles.centerState}>
        <Text style={bodyStyles.errorTitle}>Something went wrong</Text>
        <Text style={bodyStyles.centerText}>{errorMessage ?? 'An unexpected error occurred.'}</Text>
        <TouchableOpacity
          onPress={onPause}
          style={bodyStyles.closeErrorBtn}
          accessibilityRole="button"
          accessibilityLabel="Dismiss SDOH error"
        >
          <Text style={bodyStyles.closeErrorBtnText}>Close</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // state === 'ready' — template + assessmentId are guaranteed non-null.
  return (
    <AssessmentForm
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Template shape matches AssessmentForm's local Template type structurally.
      template={template as any}
      assessmentId={assessmentId as string}
      onComplete={onComplete}
      onPause={onPause}
    />
  );
}

// ─── Success state (shown after "Done") ────────────────────────────────────────

function SdohSuccessState({ onDone }: { onDone: () => void }): React.JSX.Element {
  return (
    <View style={bodyStyles.successWrap}>
      <View style={bodyStyles.successIconCircle}>
        <CheckCircle2 size={30} color="#FFFFFF" strokeWidth={3} />
      </View>
      <Text style={bodyStyles.successTitle}>Assessment Complete</Text>
      <Text style={bodyStyles.successBody}>
        All answers have been saved. The member profile&apos;s Screening Results now reflect this session.
      </Text>
      <TouchableOpacity
        style={bodyStyles.successDoneBtn}
        onPress={onDone}
        accessibilityRole="button"
        accessibilityLabel="Done"
      >
        <Text style={bodyStyles.successDoneText}>Done</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── Shared header ────────────────────────────────────────────────────────────

interface PanelHeaderProps {
  title: string;
  subtitle?: string;
  onClose: () => void;
}

function PanelHeader({ title, subtitle, onClose }: PanelHeaderProps): React.JSX.Element {
  const [hovered, setHovered] = useState(false);

  return (
    <View style={headerStyles.header}>
      <View style={headerStyles.textBlock}>
        <Text style={headerStyles.title}>{title}</Text>
        {subtitle ? <Text style={headerStyles.subtitle}>{subtitle}</Text> : null}
      </View>

      <Pressable
        onPress={onClose}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        accessibilityRole="button"
        accessibilityLabel="Close SDOH panel"
        style={({ pressed }: { pressed: boolean }) => [
          headerStyles.closeBtn,
          (pressed || hovered) && headerStyles.closeBtnActive,
        ]}
      >
        <X color={tokens.textSecondary} size={18} />
      </Pressable>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const headerStyles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    padding: spacing.xl,
    borderBottomWidth: 1,
    borderBottomColor: tokens.cardBorder,
  } as ViewStyle,
  textBlock: {
    flex: 1,
    gap: 4,
  } as ViewStyle,
  title: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 18,
    color: tokens.textPrimary,
    lineHeight: 24,
  } as TextStyle,
  subtitle: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 13,
    color: tokens.textSecondary,
    lineHeight: 18,
  } as TextStyle,
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: spacing.md,
  } as ViewStyle,
  closeBtnActive: {
    backgroundColor: tokens.gray100,
  } as ViewStyle,
});

// 'pane' variant — genuine in-flow flex column, sibling of the member context rail.
const paneStyles = StyleSheet.create({
  root: {
    backgroundColor: tokens.cardBg,
    borderLeftWidth: 1,
    borderLeftColor: tokens.cardBorder,
    flexShrink: 0,
    flexDirection: 'column',
  } as ViewStyle,
  body: {
    flex: 1,
    minHeight: 0,
  } as ViewStyle,
});

// 'sheet' variant — fixed-position dismissible overlay (narrow / native fallback).
const sheetStyles = StyleSheet.create({
  root: {
    position: 'fixed' as 'absolute',
    inset: 0,
    // Above app chrome (zIndex 100) and in line with RightDrawer's overlay (1000).
    zIndex: 1000,
  } as ViewStyle,
  backdrop: {
    position: 'absolute' as 'absolute',
    inset: 0,
    backgroundColor: 'rgba(0,0,0,0.4)',
  } as ViewStyle,
  panel: {
    position: 'absolute' as 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: 520,
    maxWidth: '100%',
    backgroundColor: tokens.cardBg,
    borderLeftWidth: 1,
    borderLeftColor: tokens.cardBorder,
    flexDirection: 'column',
    zIndex: 1,
  } as ViewStyle,
  body: {
    flex: 1,
    minHeight: 0,
  } as ViewStyle,
});

const bodyStyles = StyleSheet.create({
  centerState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    gap: spacing.md,
  } as ViewStyle,
  centerText: {
    fontSize: 14,
    color: tokens.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
  } as TextStyle,
  errorTitle: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 16,
    color: tokens.textPrimary,
    textAlign: 'center',
  } as TextStyle,
  closeErrorBtn: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.md,
    backgroundColor: tokens.primary,
    marginTop: spacing.sm,
  } as ViewStyle,
  closeErrorBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#FFFFFF',
  } as TextStyle,

  // Success state — mirrors DocumentationModal's submitted-for-billing panel.
  successWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    gap: spacing.xl,
  } as ViewStyle,
  successIconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: tokens.emerald700,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  successTitle: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 18,
    lineHeight: 26,
    color: tokens.textPrimary,
    textAlign: 'center',
    maxWidth: 360,
  } as TextStyle,
  successBody: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    lineHeight: 20,
    color: tokens.textSecondary,
    textAlign: 'center',
    maxWidth: 340,
  } as TextStyle,
  successDoneBtn: {
    paddingHorizontal: spacing.xxl,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    backgroundColor: tokens.primary,
  } as ViewStyle,
  successDoneText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 15,
    color: '#FFFFFF',
  } as TextStyle,
});

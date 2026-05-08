/**
 * CHWMemberAssessmentScreen — combined health assessment + intro script view.
 *
 * Layout
 * ------
 * On tablet/web (width ≥ 768):
 *   [AssessmentForm (flex: 1)] | [IntroductionScriptPanel (320px)]
 *   Both rendered side by side. Intro script is always visible.
 *
 * On mobile (width < 768):
 *   [AssessmentForm (full screen)]
 *   Intro script accessible via "Open intro script" button in the header,
 *   which opens IntroductionScriptPanel as a Modal.
 *
 * Navigation
 * ----------
 * Route params: { sessionId: string }
 * The screen fetches both the template and creates/resumes an assessment on mount.
 *
 * Launched from SessionChat via a "Start health assessment" button.
 *
 * Auth: CHW only. The assessment router enforces this; the screen assumes the
 * user is a CHW (renders only in CHW navigator).
 *
 * HIPAA: no PHI is logged here. Member ID is resolved from the session row
 * (server-side), not stored in nav params.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { ArrowLeft, BookOpen, CheckCircle } from 'lucide-react-native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import { api } from '../../api/client';
import { colors } from '../../theme/colors';
import { fonts, typography } from '../../theme/typography';
import { AssessmentForm } from '../../components/assessment/AssessmentForm';
import {
  IntroductionScriptPanel,
  type IntroStep,
  type QuickPhrases,
} from '../../components/assessment/IntroductionScriptPanel';

// ─── Navigation types ─────────────────────────────────────────────────────────

type CHWSessionsStackParamList = {
  CHWMemberAssessment: { sessionId: string };
  [key: string]: object | undefined;
};

type AssessmentScreenRouteProp = RouteProp<CHWSessionsStackParamList, 'CHWMemberAssessment'>;
type AssessmentScreenNavProp = NativeStackNavigationProp<CHWSessionsStackParamList>;

// ─── API calls ────────────────────────────────────────────────────────────────

interface TemplateResponse {
  id: string;
  name: string;
  total_questions: number;
  sections: object[];
  questions: object[];
  metadata?: Record<string, number>;
}

interface IntroScriptResponse {
  id: string;
  name: string;
  total_steps: number;
  steps: IntroStep[];
  quick_reference_phrases: QuickPhrases;
}

interface AssessmentResponse {
  id: string;
  status: string;
  template_id: string;
  session_id: string;
  member_id: string;
}

async function fetchTemplate(templateId: string): Promise<TemplateResponse> {
  const data = await api(`/assessment-templates/${templateId}`) as TemplateResponse;
  return data;
}

async function fetchIntroScript(): Promise<IntroScriptResponse> {
  const data = await api('/assessment-templates/compass_intro_script_v1') as IntroScriptResponse;
  return data;
}

async function startOrResumeAssessment(sessionId: string): Promise<AssessmentResponse> {
  const data = await api(`/sessions/${sessionId}/assessments`, {
    method: 'POST',
    body: JSON.stringify({ template_id: 'compass_member_v1' }),
  }) as AssessmentResponse;
  return data;
}

// ─── Screen states ────────────────────────────────────────────────────────────

type ScreenState =
  | 'loading'       // fetching template + script + starting assessment
  | 'ready'         // assessment in_progress, form visible
  | 'completed'     // CHW tapped Done, /complete succeeded
  | 'error';        // unrecoverable fetch error

// ─── Screen component ─────────────────────────────────────────────────────────

const TABLET_BREAKPOINT = 768;
const TEMPLATE_ID = 'compass_member_v1';

export function CHWMemberAssessmentScreen(): React.ReactElement {
  const navigation = useNavigation<AssessmentScreenNavProp>();
  const route = useRoute<AssessmentScreenRouteProp>();
  const { sessionId } = route.params;
  const { width } = useWindowDimensions();
  const isTablet = width >= TABLET_BREAKPOINT;

  const [screenState, setScreenState] = useState<ScreenState>('loading');
  const [assessmentId, setAssessmentId] = useState<string | null>(null);
  const [introScriptVisible, setIntroScriptVisible] = useState<boolean>(false);
  const [initError, setInitError] = useState<string | null>(null);

  // ── Fetch template ──────────────────────────────────────────────────────────

  const { data: template, isLoading: templateLoading, error: templateError } = useQuery({
    queryKey: ['assessment-template', TEMPLATE_ID],
    queryFn: () => fetchTemplate(TEMPLATE_ID),
    staleTime: 5 * 60 * 1000, // templates rarely change
  });

  const { data: introScript, isLoading: introLoading } = useQuery({
    queryKey: ['assessment-template', 'compass_intro_script_v1'],
    queryFn: fetchIntroScript,
    staleTime: 5 * 60 * 1000,
  });

  // ── Start/resume assessment on mount ───────────────────────────────────────

  useEffect(() => {
    if (templateLoading || introLoading) return;
    if (templateError) {
      setInitError('Failed to load the questionnaire. Please try again.');
      setScreenState('error');
      return;
    }

    startOrResumeAssessment(sessionId)
      .then((assessment) => {
        setAssessmentId(assessment.id);
        setScreenState('ready');
      })
      .catch(() => {
        setInitError('Failed to start assessment. Please try again.');
        setScreenState('error');
      });
  }, [sessionId, templateLoading, introLoading, templateError]);

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleComplete = useCallback(() => {
    setScreenState('completed');
  }, []);

  const handlePause = useCallback(() => {
    // Assessment stays in_progress — CHW will resume next session.
    // Navigate back to the session chat.
    navigation.goBack();
  }, [navigation]);

  const handleBack = useCallback(() => {
    navigation.goBack();
  }, [navigation]);

  // ── Loading state ───────────────────────────────────────────────────────────

  if (screenState === 'loading') {
    return (
      <SafeAreaView style={styles.root} edges={['top']}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.loadingText}>Loading questionnaire…</Text>
        </View>
      </SafeAreaView>
    );
  }

  // ── Error state ─────────────────────────────────────────────────────────────

  if (screenState === 'error') {
    return (
      <SafeAreaView style={styles.root} edges={['top']}>
        <View style={styles.errorContainer}>
          <Text style={styles.errorTitle}>Something went wrong</Text>
          <Text style={styles.errorBody}>{initError ?? 'An unexpected error occurred.'}</Text>
          <TouchableOpacity onPress={handleBack} style={styles.retryButton}>
            <Text style={styles.retryButtonText}>Go back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ── Completed state ─────────────────────────────────────────────────────────

  if (screenState === 'completed') {
    return (
      <SafeAreaView style={styles.root} edges={['top']}>
        <View style={styles.completedContainer}>
          <CheckCircle size={56} color="#10B981" />
          <Text style={styles.completedTitle}>Assessment Complete</Text>
          <Text style={styles.completedBody}>
            All answers have been saved. The member profile will reflect this screening.
          </Text>
          <TouchableOpacity
            onPress={handleBack}
            style={styles.completedBackButton}
            accessibilityRole="button"
          >
            <Text style={styles.completedBackButtonText}>Back to session</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ── Ready state — main layout ───────────────────────────────────────────────

  if (!template || !assessmentId) {
    return (
      <SafeAreaView style={styles.root} edges={['top']}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={handleBack}
          style={styles.backButton}
          accessibilityRole="button"
          accessibilityLabel="Back to session"
        >
          <ArrowLeft size={20} color={colors.foreground} />
        </TouchableOpacity>

        <Text style={styles.headerTitle} numberOfLines={1}>
          Health & Wellness Questionnaire
        </Text>

        {/* Open intro script button (mobile only; tablet shows panel inline) */}
        {!isTablet && (
          <TouchableOpacity
            onPress={() => setIntroScriptVisible(true)}
            style={styles.scriptButton}
            accessibilityRole="button"
            accessibilityLabel="Open introduction script"
          >
            <BookOpen size={18} color={colors.primary} />
            <Text style={styles.scriptButtonText}>Script</Text>
          </TouchableOpacity>
        )}

        {/* On tablet: toggle intro script panel visibility */}
        {isTablet && (
          <TouchableOpacity
            onPress={() => setIntroScriptVisible((prev) => !prev)}
            style={styles.scriptButton}
            accessibilityRole="button"
            accessibilityLabel={introScriptVisible ? 'Hide intro script' : 'Open intro script'}
          >
            <BookOpen size={18} color={colors.primary} />
            <Text style={styles.scriptButtonText}>
              {introScriptVisible ? 'Hide script' : 'Intro script'}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Body — split layout on tablet */}
      <View style={styles.body}>
        {/* Assessment form — always visible */}
        <View style={styles.formContainer}>
          <AssessmentForm
            assessmentId={assessmentId}
            template={template as any}
            onComplete={handleComplete}
            onPause={handlePause}
          />
        </View>

        {/* Intro script panel — inline on tablet, modal on mobile */}
        {introScript && (
          <IntroductionScriptPanel
            visible={introScriptVisible}
            onClose={() => setIntroScriptVisible(false)}
            steps={introScript.steps}
            quickPhrases={introScript.quick_reference_phrases}
          />
        )}
      </View>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.card,
  },
  backButton: {
    padding: 4,
    marginRight: 8,
  },
  headerTitle: {
    flex: 1,
    fontSize: 16,
    fontFamily: fonts.displayMedium,
    fontWeight: '600',
    color: colors.foreground,
  },
  scriptButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: '#F5F3FF',
  },
  scriptButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.primary,
  },

  // Body layout
  body: {
    flex: 1,
    flexDirection: 'row',
  },
  formContainer: {
    flex: 1,
  },

  // Loading state
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  loadingText: {
    fontSize: 14,
    color: colors.mutedForeground,
    fontFamily: fonts.body,
  },

  // Error state
  errorContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 12,
  },
  errorTitle: {
    fontSize: 18,
    fontFamily: fonts.displaySemibold,
    color: colors.foreground,
    textAlign: 'center',
  },
  errorBody: {
    fontSize: 14,
    fontFamily: fonts.body,
    color: colors.mutedForeground,
    textAlign: 'center',
    lineHeight: 20,
  },
  retryButton: {
    paddingVertical: 10,
    paddingHorizontal: 24,
    borderRadius: 8,
    backgroundColor: colors.primary,
    marginTop: 8,
  },
  retryButtonText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#FFFFFF',
  },

  // Completed state
  completedContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 16,
  },
  completedTitle: {
    fontSize: 22,
    fontFamily: fonts.display,
    color: colors.foreground,
    textAlign: 'center',
  },
  completedBody: {
    fontSize: 15,
    fontFamily: fonts.body,
    color: colors.mutedForeground,
    textAlign: 'center',
    lineHeight: 22,
  },
  completedBackButton: {
    paddingVertical: 12,
    paddingHorizontal: 28,
    borderRadius: 8,
    backgroundColor: colors.primary,
    marginTop: 4,
  },
  completedBackButtonText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#FFFFFF',
  },
});

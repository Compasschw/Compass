/**
 * LegalScreen — scrollable legal / policy content pages.
 *
 * Accepts a `page` route param: 'privacy' | 'terms' | 'hipaa' | 'contact'.
 * Falls back to the privacy page for unknown values.
 *
 * Content mirrors the web LegalPage component exactly.
 */

import React from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ArrowLeft } from 'lucide-react-native';
import { useNavigation } from '@react-navigation/native';
import { colors } from '../theme/colors';

// ─── Types ────────────────────────────────────────────────────────────────────

export type LegalPage = 'privacy' | 'terms' | 'hipaa' | 'contact';

export interface LegalScreenProps {
  /** Route param — which legal page to display. Defaults to 'privacy'. */
  page?: LegalPage;
}

interface PageContent {
  title: string;
  paragraphs: string[];
}

// ─── Content ──────────────────────────────────────────────────────────────────

const PAGES: Record<LegalPage, PageContent> = {
  privacy: {
    title: 'Privacy Policy',
    paragraphs: [
      'Compass CHW is committed to protecting your privacy. We collect only the information necessary to connect you with Community Health Workers and process Medi-Cal reimbursements. We never sell your data to third parties.',
      'All personal health information (PHI) is encrypted and handled in accordance with HIPAA regulations. For questions, contact privacy@joincompasschw.com.',
    ],
  },
  terms: {
    title: 'Terms of Service',
    paragraphs: [
      'By using Compass CHW, you agree to these terms. Compass CHW is a marketplace connecting community members with trained Community Health Workers. We are not a medical provider and do not provide medical advice, diagnosis, or treatment.',
      'CHW services are reimbursed through Medi-Cal at no cost to eligible members. Compass CHW reserves the right to modify these terms at any time.',
    ],
  },
  hipaa: {
    title: 'HIPAA Notice',
    paragraphs: [
      'Compass CHW maintains strict compliance with the Health Insurance Portability and Accountability Act (HIPAA). All protected health information (PHI) is encrypted at rest and in transit.',
      'Access to PHI is restricted to authorized personnel on a minimum-necessary basis. We maintain audit logs of all PHI access. Our infrastructure partners maintain signed Business Associate Agreements (BAAs).',
      'To report a privacy concern, contact hipaa@joincompasschw.com.',
    ],
  },
  contact: {
    title: 'Contact Us',
    paragraphs: [
      'We would love to hear from you.',
      'General inquiries: hello@joincompasschw.com',
      'Partnership opportunities: partnerships@joincompasschw.com',
      'HIPAA and privacy: hipaa@joincompasschw.com',
      'Based in Los Angeles, California.',
    ],
  },
};

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Scrollable screen for legal / policy text pages.
 *
 * The `page` prop is typically provided via route.params from the navigator.
 * Example usage:
 *   navigation.navigate('Legal', { page: 'hipaa' })
 */
export function LegalScreen({ page }: LegalScreenProps): React.JSX.Element {
  const navigation = useNavigation();
  const resolvedPage: LegalPage = page && PAGES[page] ? page : 'privacy';
  const content = PAGES[resolvedPage];

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Back button */}
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <ArrowLeft size={16} color={colors.secondary} />
          <Text style={styles.backLabel}>Back</Text>
        </TouchableOpacity>

        {/* Title */}
        <Text style={styles.title}>{content.title}</Text>

        {/* Body paragraphs */}
        {content.paragraphs.map((paragraph, index) => (
          <Text key={index} style={styles.paragraph}>
            {paragraph}
          </Text>
        ))}

        {/* Footer */}
        <Text style={styles.footer}>
          Last updated: April 2026. Compass CHW. All rights reserved.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  } as ViewStyle,
  scroll: {
    flex: 1,
  } as ViewStyle,
  scrollContent: {
    maxWidth: 640,
    alignSelf: 'center',
    width: '100%',
    paddingHorizontal: 24,
    paddingTop: 32,
    paddingBottom: 64,
  } as ViewStyle,
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 32,
    alignSelf: 'flex-start',
  } as ViewStyle,
  backLabel: {
    fontSize: 14,
    color: colors.secondary,
    fontWeight: '500',
  } as TextStyle,
  title: {
    fontSize: 26,
    fontWeight: '700',
    color: colors.foreground,
    marginBottom: 20,
  } as TextStyle,
  paragraph: {
    fontSize: 15,
    lineHeight: 24,
    color: '#555555',
    marginBottom: 16,
  } as TextStyle,
  footer: {
    fontSize: 12,
    color: colors.mutedForeground,
    marginTop: 48,
  } as TextStyle,
});

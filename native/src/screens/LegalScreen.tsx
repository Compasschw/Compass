/**
 * LegalScreen — scrollable legal / policy content pages.
 *
 * Accepts a `page` route param: 'privacy' | 'terms' | 'hipaa' | 'contact'.
 * Falls back to the privacy page for unknown values.
 *
 * Each page renders an optional intro followed by a list of sections.
 * Each section may have an optional heading + one or more paragraphs.
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

interface PageSection {
  /** Optional bold subheading rendered above the section's paragraphs. */
  heading?: string;
  /** One or more paragraphs of body text within the section. */
  paragraphs: string[];
}

interface PageContent {
  title: string;
  /** Optional preamble paragraph rendered before the first section. */
  intro?: string;
  sections: PageSection[];
}

// ─── Content ──────────────────────────────────────────────────────────────────

// TODO(legal): These pages are structured placeholders pending formal legal
// review. Section structure follows standard CCPA / HIPAA Notice of Privacy
// Practices format so counsel can fill in the substantive language without
// reorganizing the screen. Replace before mass-marketing the platform or
// onboarding production CHWs at scale.

const PAGES: Record<LegalPage, PageContent> = {
  privacy: {
    title: 'Privacy Policy',
    intro:
      'Compass CHW ("Compass," "we," "us," or "our") respects your privacy. This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you use our platform connecting Medi-Cal members with Community Health Workers.',
    sections: [
      {
        heading: '1. Information We Collect',
        paragraphs: [
          'Account Information: name, email address, phone number, ZIP code, and primary language.',
          'Health Information (PHI): when you receive services from a Community Health Worker, we collect session notes, scheduling data, billing codes, and other information necessary to coordinate care and submit Medi-Cal reimbursement claims.',
          'Identification & Verification (CHWs only): government-issued ID, certifications, and background-check results, processed through our identity-verification partner.',
          'Technical Information: device type, operating system, IP address, application logs, and crash reports.',
        ],
      },
      {
        heading: '2. How We Use Your Information',
        paragraphs: [
          'To match members with appropriate CHWs based on language, specialty, and location.',
          'To submit reimbursement claims to California Medi-Cal and authorized managed-care plans.',
          'To verify CHW credentials, perform background checks, and meet regulatory requirements.',
          'To improve the platform, detect fraud or abuse, and provide customer support.',
        ],
      },
      {
        heading: '3. How We Share Information',
        paragraphs: [
          'We share PHI only with parties that have a legitimate need and have executed a Business Associate Agreement (BAA) with us, including: assigned Community Health Workers, Medi-Cal and managed-care plan billing partners, and HIPAA-compliant infrastructure providers.',
          'We do not sell, rent, or trade your personal information to third parties for marketing purposes.',
        ],
      },
      {
        heading: '4. Data Retention',
        paragraphs: [
          'We retain PHI for the period required by California Medi-Cal regulations (currently a minimum of 10 years from the date of service) and applicable HIPAA recordkeeping rules.',
          'Account information is retained while your account is active and for a reasonable period afterward to comply with legal obligations.',
        ],
      },
      {
        heading: '5. Your Rights (California Residents)',
        paragraphs: [
          'Under the California Consumer Privacy Act (CCPA), you have the right to: know what personal information we collect, request deletion of personal information, opt out of the sale of personal information (we do not sell), and not be discriminated against for exercising these rights.',
          'Under HIPAA, you have additional rights regarding your PHI — see our HIPAA Notice for details.',
          'To exercise any of these rights, contact privacy@joincompasschw.com.',
        ],
      },
      {
        heading: '6. Security',
        paragraphs: [
          'We use industry-standard administrative, technical, and physical safeguards to protect your information, including encryption at rest and in transit, role-based access controls, and audit logging. No method of transmission or storage is 100% secure; we cannot guarantee absolute security.',
        ],
      },
      {
        heading: "7. Children's Privacy",
        paragraphs: [
          'Compass CHW is not directed to children under 13. We do not knowingly collect personal information from children under 13. If you believe we have collected such information, contact privacy@joincompasschw.com.',
        ],
      },
      {
        heading: '8. Changes to This Policy',
        paragraphs: [
          'We may update this Privacy Policy from time to time. Material changes will be communicated to active users via in-app notification or email. The "Last updated" date below indicates when the most recent changes were made.',
        ],
      },
      {
        heading: '9. Contact',
        paragraphs: [
          'Privacy questions or requests: privacy@joincompasschw.com.',
        ],
      },
    ],
  },

  terms: {
    title: 'Terms of Service',
    intro:
      'These Terms of Service ("Terms") govern your access to and use of the Compass CHW platform, including our website, mobile application, and related services (collectively, the "Service"). By creating an account or using the Service, you agree to these Terms.',
    sections: [
      {
        heading: '1. Eligibility',
        paragraphs: [
          'You must be at least 18 years old to use the Service. By using the Service you represent that you meet this requirement.',
          'Community Health Workers must additionally meet our credentialing requirements, including identity verification and background screening.',
        ],
      },
      {
        heading: '2. The Service',
        paragraphs: [
          'Compass CHW is a marketplace that connects Medi-Cal members with Community Health Workers ("CHWs") for non-clinical support including housing navigation, food security, mental-health connection, recovery resources, and healthcare access.',
          'Compass CHW is NOT a medical provider. We do not provide medical diagnosis, treatment, prescriptions, or emergency services. CHWs provide non-clinical navigation and support only. If you are experiencing a medical emergency, call 911.',
        ],
      },
      {
        heading: '3. Accounts',
        paragraphs: [
          'You are responsible for the activity that occurs under your account. Keep your credentials confidential and notify us immediately of any unauthorized access.',
          'We reserve the right to suspend or terminate accounts that violate these Terms, applicable law, or our community guidelines.',
        ],
      },
      {
        heading: '4. Member Conduct',
        paragraphs: [
          'Members agree to provide accurate information, treat CHWs with respect, and use the Service only for lawful purposes.',
        ],
      },
      {
        heading: '5. CHW Conduct',
        paragraphs: [
          'CHWs agree to maintain current credentials, complete required training, document services accurately for Medi-Cal billing, and follow all applicable HIPAA requirements.',
          'CHWs are independent service providers and not employees of Compass CHW.',
        ],
      },
      {
        heading: '6. Medi-Cal Reimbursement',
        paragraphs: [
          'Eligible services delivered by qualified CHWs are reimbursed through California Medi-Cal at no cost to eligible members. Compass CHW handles claim submission on behalf of CHWs and may retain a service fee in accordance with our CHW agreements.',
        ],
      },
      {
        heading: '7. Intellectual Property',
        paragraphs: [
          'All content, software, and trademarks on the Service are owned by Compass CHW or its licensors. You may not copy, modify, or distribute them without our written permission.',
        ],
      },
      {
        heading: '8. Disclaimers',
        paragraphs: [
          'The Service is provided "as is" and "as available" without warranties of any kind, express or implied. We do not guarantee that the Service will be uninterrupted, error-free, or free from harmful components.',
          'Information provided by CHWs is for navigation and support only and is not a substitute for medical advice. Always consult a licensed healthcare provider for medical questions.',
        ],
      },
      {
        heading: '9. Limitation of Liability',
        paragraphs: [
          'To the maximum extent permitted by law, Compass CHW is not liable for any indirect, incidental, special, consequential, or punitive damages arising from your use of the Service.',
        ],
      },
      {
        heading: '10. Indemnification',
        paragraphs: [
          'You agree to indemnify and hold Compass CHW harmless from claims arising out of your violation of these Terms or your misuse of the Service.',
        ],
      },
      {
        heading: '11. Termination',
        paragraphs: [
          'You may close your account at any time by contacting support. We may suspend or terminate your access for violations of these Terms or applicable law.',
        ],
      },
      {
        heading: '12. Governing Law & Disputes',
        paragraphs: [
          'These Terms are governed by the laws of the State of California, without regard to conflict-of-laws rules. Any dispute arising out of or relating to these Terms shall be resolved in the state or federal courts located in Los Angeles County, California.',
        ],
      },
      {
        heading: '13. Changes to These Terms',
        paragraphs: [
          'We may update these Terms from time to time. Material changes will be communicated to active users. Continued use of the Service after changes take effect constitutes your acceptance of the revised Terms.',
        ],
      },
      {
        heading: '14. Contact',
        paragraphs: [
          'Questions about these Terms: hello@joincompasschw.com.',
        ],
      },
    ],
  },

  hipaa: {
    title: 'Notice of Privacy Practices (HIPAA)',
    intro:
      'This Notice describes how medical and other health information about you may be used and disclosed and how you can get access to this information. Please review it carefully.',
    sections: [
      {
        heading: '1. Our Commitment to Your Privacy',
        paragraphs: [
          'Compass CHW is required by the Health Insurance Portability and Accountability Act (HIPAA) to maintain the privacy of Protected Health Information ("PHI"), provide you with this Notice of our legal duties and privacy practices, and follow the terms of this Notice currently in effect.',
        ],
      },
      {
        heading: '2. PHI We Collect',
        paragraphs: [
          'PHI we collect may include your name, contact information, Medi-Cal ID, language preferences, the services you receive from CHWs, session notes, scheduling data, billing codes, and related records necessary to coordinate care and process claims.',
        ],
      },
      {
        heading: '3. How We Use & Disclose PHI',
        paragraphs: [
          'For Treatment / Coordination of Services: We share PHI with the CHW assigned to you so they can provide and document services.',
          'For Payment: We use PHI to submit claims to California Medi-Cal and authorized managed-care plans for reimbursement.',
          'For Healthcare Operations: We use PHI for quality assurance, training, audits, and improving the Service.',
          'As Required by Law: We may disclose PHI when required by federal, state, or local law, including reporting suspected abuse or responding to lawful court orders.',
          'With Your Authorization: Any other use or disclosure of PHI requires your written authorization, which you may revoke at any time.',
        ],
      },
      {
        heading: '4. Your Rights Under HIPAA',
        paragraphs: [
          'Right to Inspect and Copy your PHI.',
          'Right to Amend PHI you believe is inaccurate or incomplete.',
          'Right to an Accounting of Disclosures we have made of your PHI.',
          'Right to Request Restrictions on certain uses or disclosures of your PHI.',
          'Right to Confidential Communications by alternative means or at alternative locations.',
          'Right to a Paper Copy of this Notice.',
          'To exercise any of these rights, contact hipaa@joincompasschw.com.',
        ],
      },
      {
        heading: '5. Our Responsibilities',
        paragraphs: [
          'We are required to maintain the privacy and security of your PHI, notify you in the event of a breach of unsecured PHI, follow the terms of this Notice currently in effect, and not use or disclose PHI in ways not described in this Notice without your authorization.',
        ],
      },
      {
        heading: '6. Changes to This Notice',
        paragraphs: [
          'We reserve the right to change this Notice. Changes will apply to PHI we already have as well as PHI we receive in the future. Updated notices will be posted in our application and on our website.',
        ],
      },
      {
        heading: '7. Complaints',
        paragraphs: [
          'If you believe your privacy rights have been violated, you may file a complaint with us at hipaa@joincompasschw.com or with the U.S. Department of Health and Human Services Office for Civil Rights. We will not retaliate against you for filing a complaint.',
        ],
      },
      {
        heading: '8. Privacy Officer Contact',
        paragraphs: [
          'Privacy Officer: hipaa@joincompasschw.com.',
        ],
      },
    ],
  },

  contact: {
    title: 'Contact Us',
    intro:
      'We would love to hear from you. Reach us through any of the channels below — we typically respond within two business days.',
    sections: [
      {
        heading: 'General Inquiries',
        paragraphs: ['hello@joincompasschw.com'],
      },
      {
        heading: 'Partnership Opportunities',
        paragraphs: ['partnerships@joincompasschw.com'],
      },
      {
        heading: 'Privacy & HIPAA',
        paragraphs: [
          'privacy@joincompasschw.com',
          'hipaa@joincompasschw.com',
        ],
      },
      {
        heading: 'Office',
        paragraphs: ['Compass CHW', 'Los Angeles, California'],
      },
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

        {/* Optional intro */}
        {content.intro ? (
          <Text style={styles.intro}>{content.intro}</Text>
        ) : null}

        {/* Sections */}
        {content.sections.map((section, sectionIndex) => (
          <View key={sectionIndex} style={styles.section}>
            {section.heading ? (
              <Text style={styles.sectionHeading}>{section.heading}</Text>
            ) : null}
            {section.paragraphs.map((paragraph, paragraphIndex) => (
              <Text key={paragraphIndex} style={styles.paragraph}>
                {paragraph}
              </Text>
            ))}
          </View>
        ))}

        {/* Footer */}
        <Text style={styles.footer}>
          Last updated: April 2026. Compass CHW. All rights reserved.{'\n'}
          This content is a structured placeholder pending formal legal review.
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
    marginBottom: 16,
  } as TextStyle,
  intro: {
    fontSize: 15,
    lineHeight: 24,
    color: '#555555',
    marginBottom: 28,
  } as TextStyle,
  section: {
    marginBottom: 24,
  } as ViewStyle,
  sectionHeading: {
    fontSize: 17,
    fontWeight: '600',
    color: colors.foreground,
    marginBottom: 10,
  } as TextStyle,
  paragraph: {
    fontSize: 15,
    lineHeight: 24,
    color: '#555555',
    marginBottom: 12,
  } as TextStyle,
  footer: {
    fontSize: 12,
    lineHeight: 18,
    color: colors.mutedForeground,
    marginTop: 32,
  } as TextStyle,
});

/**
 * PaymentsScreen — CHW payout setup.
 *
 * Drives the Stripe Connect Express onboarding flow:
 *  1. Empty state: "Set up direct deposit" CTA → POST /payments/connect-onboarding
 *  2. Opens the Stripe-hosted onboarding URL in an in-app browser
 *  3. CHW completes KYC + bank info → Stripe redirects to compasschw://payments/onboarding-complete
 *  4. App returns here; useAccountStatus refetches
 *  5. Active state: "Payouts enabled" badge + readiness summary + "Update info" link
 *
 * Accessible from: CHWEarningsScreen (via "Set up payouts" banner) and
 *                  CHWProfileScreen (via "Payment settings" row).
 */

import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as WebBrowser from 'expo-web-browser';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle,
  CreditCard,
  Landmark,
  ShieldCheck,
  TrendingUp,
} from 'lucide-react-native';

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { CHWTabParamList } from '../../navigation/CHWTabNavigator';
import { colors } from '../../theme/colors';
import { fonts, typography } from '../../theme/typography';
import { radii, spacing } from '../../theme/spacing';
import { shadows } from '../../theme/shadows';
import {
  useConnectOnboardingLink,
  usePaymentsAccountStatus,
} from '../../hooks/useApiQueries';

type Props = NativeStackScreenProps<CHWTabParamList & { Payments: undefined }, 'Payments'>;

export function PaymentsScreen({ navigation }: Props): React.JSX.Element {
  const statusQuery = usePaymentsAccountStatus();
  const onboardingMutation = useConnectOnboardingLink();
  const [opening, setOpening] = useState(false);

  const status = statusQuery.data;

  const handleStart = useCallback(async () => {
    if (opening || onboardingMutation.isPending) return;
    setOpening(true);
    try {
      const { onboardingUrl } = await onboardingMutation.mutateAsync();

      // openAuthSessionAsync handles the deep-link return path automatically
      // on iOS (via ASWebAuthenticationSession). On Android it uses Custom Tabs.
      const result = await WebBrowser.openAuthSessionAsync(
        onboardingUrl,
        'compasschw://payments/onboarding-complete',
      );

      if (result.type === 'cancel' || result.type === 'dismiss') {
        // User closed the browser before completing — no error, just no-op
      }

      // Regardless of outcome, refetch status to pick up webhook-driven changes
      await statusQuery.refetch();
    } catch {
      Alert.alert(
        'Could not open onboarding',
        'Check your connection and try again. If the problem persists, contact support.',
      );
    } finally {
      setOpening(false);
    }
  }, [onboardingMutation, statusQuery, opening]);

  const handleLearnMore = useCallback(() => {
    void Linking.openURL('https://joincompasschw.com/payments-info');
  }, []);

  // ─── Loading state ────────────────────────────────────────────────────────

  if (statusQuery.isLoading) {
    return (
      <SafeAreaView style={s.safeArea} edges={['top', 'bottom']}>
        <Header onBack={() => navigation.goBack()} />
        <View style={s.centered}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  // ─── Active state — payouts enabled ───────────────────────────────────────

  if (status?.payoutsEnabled) {
    return (
      <SafeAreaView style={s.safeArea} edges={['top', 'bottom']}>
        <Header onBack={() => navigation.goBack()} />
        <ScrollView contentContainerStyle={s.content}>
          <View style={[s.heroCard, s.heroCardActive]}>
            <View style={s.heroIconCircle}>
              <CheckCircle size={28} color="#FFFFFF" />
            </View>
            <Text style={s.heroTitleActive}>Direct deposit active</Text>
            <Text style={s.heroSubtitleActive}>
              You're all set to receive payouts. Funds arrive in your bank 2 business days
              after each session is paid.
            </Text>
          </View>

          <InfoRow
            icon={<Landmark size={18} color={colors.primary} />}
            title="Linked bank account"
            subtitle="Managed by Stripe — update from your bank if it changes"
          />
          <InfoRow
            icon={<ShieldCheck size={18} color={colors.primary} />}
            title="Identity verified"
            subtitle="Stripe handles identity verification and KYC securely"
          />
          <InfoRow
            icon={<TrendingUp size={18} color={colors.primary} />}
            title="Automatic weekly payouts"
            subtitle="Funds from completed sessions are paid out every Friday"
          />

          <Pressable
            style={s.secondaryButton}
            onPress={handleStart}
            disabled={opening || onboardingMutation.isPending}
          >
            {opening || onboardingMutation.isPending ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Text style={s.secondaryButtonText}>Update payout info</Text>
            )}
          </Pressable>

          <Text style={s.footnote}>
            Tax documents (1099-NEC) are generated automatically by Stripe at year-end
            for CHWs earning over $600. You'll receive them by email from Stripe.
          </Text>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ─── In-progress state — started but not finished ─────────────────────────

  if (status?.accountId && status?.detailsSubmitted && !status?.payoutsEnabled) {
    return (
      <SafeAreaView style={s.safeArea} edges={['top', 'bottom']}>
        <Header onBack={() => navigation.goBack()} />
        <ScrollView contentContainerStyle={s.content}>
          <View style={[s.heroCard, s.heroCardPending]}>
            <View style={[s.heroIconCircle, s.heroIconCirclePending]}>
              <CreditCard size={28} color="#FFFFFF" />
            </View>
            <Text style={s.heroTitle}>Almost there</Text>
            <Text style={s.heroSubtitle}>
              Stripe is reviewing your information. This usually takes a few minutes,
              sometimes up to 24 hours.
            </Text>
          </View>

          {(status.requirementsCurrentlyDue?.length ?? 0) > 0 && (
            <View style={s.requirementsCard}>
              <Text style={s.requirementsTitle}>Stripe needs these items:</Text>
              {status.requirementsCurrentlyDue.map((req: string) => (
                <Text key={req} style={s.requirementItem}>• {req.replace(/_/g, ' ')}</Text>
              ))}
            </View>
          )}

          <Pressable
            style={[s.primaryButton, opening && s.primaryButtonDisabled]}
            onPress={handleStart}
            disabled={opening || onboardingMutation.isPending}
          >
            {opening || onboardingMutation.isPending ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <>
                <Text style={s.primaryButtonText}>Continue setup</Text>
                <ArrowRight size={18} color="#FFFFFF" />
              </>
            )}
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ─── Empty state — never started ──────────────────────────────────────────

  return (
    <SafeAreaView style={s.safeArea} edges={['top', 'bottom']}>
      <Header onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={s.content}>
        <View style={[s.heroCard, s.heroCardEmpty]}>
          <View style={s.heroIconCircle}>
            <CreditCard size={28} color="#FFFFFF" />
          </View>
          <Text style={s.heroTitle}>Set up direct deposit</Text>
          <Text style={s.heroSubtitle}>
            Connect your bank account to start receiving Medi-Cal reimbursements for your
            sessions. Takes about 5 minutes — Stripe handles the rest.
          </Text>
        </View>

        <BulletRow
          icon={<ShieldCheck size={18} color={colors.primary} />}
          text="Secured by Stripe. Compass never sees your bank info or SSN."
        />
        <BulletRow
          icon={<Landmark size={18} color={colors.primary} />}
          text="Works with any US bank or credit union. ACH only — no cards needed."
        />
        <BulletRow
          icon={<TrendingUp size={18} color={colors.primary} />}
          text="Weekly automatic payouts. Funds arrive 2 business days after each session is paid."
        />

        <Pressable
          style={[s.primaryButton, (opening || onboardingMutation.isPending) && s.primaryButtonDisabled]}
          onPress={handleStart}
          disabled={opening || onboardingMutation.isPending}
          accessibilityRole="button"
          accessibilityLabel="Set up direct deposit"
        >
          {opening || onboardingMutation.isPending ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <>
              <Text style={s.primaryButtonText}>Set up direct deposit</Text>
              <ArrowRight size={18} color="#FFFFFF" />
            </>
          )}
        </Pressable>

        <Pressable onPress={handleLearnMore} style={s.learnMoreLink}>
          <Text style={s.learnMoreText}>Learn more about payouts</Text>
        </Pressable>

        <Text style={s.footnote}>
          Stripe Connect is PCI DSS Level 1 certified. Your SSN, tax ID, and bank account
          details are collected directly by Stripe and never touch CompassCHW servers.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function Header({ onBack }: { onBack: () => void }): React.JSX.Element {
  return (
    <View style={s.header}>
      <Pressable
        onPress={onBack}
        style={s.backButton}
        accessibilityRole="button"
        accessibilityLabel="Go back"
      >
        <ArrowLeft size={22} color={colors.foreground} />
      </Pressable>
      <Text style={s.headerTitle}>Payout Setup</Text>
      <View style={s.headerSpacer} />
    </View>
  );
}

function BulletRow({
  icon,
  text,
}: {
  icon: React.ReactNode;
  text: string;
}): React.JSX.Element {
  return (
    <View style={s.bulletRow}>
      <View style={s.bulletIcon}>{icon}</View>
      <Text style={s.bulletText}>{text}</Text>
    </View>
  );
}

function InfoRow({
  icon,
  title,
  subtitle,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
}): React.JSX.Element {
  return (
    <View style={s.infoRow}>
      <View style={s.infoIcon}>{icon}</View>
      <View style={s.infoContent}>
        <Text style={s.infoTitle}>{title}</Text>
        <Text style={s.infoSubtitle}>{subtitle}</Text>
      </View>
    </View>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xxl,
    gap: spacing.md,
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.card,
  },
  backButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    ...typography.bodyMd,
    fontFamily: fonts.bodySemibold,
    color: colors.foreground,
    flex: 1,
    textAlign: 'center',
  },
  headerSpacer: { width: 40 },

  // Hero cards
  heroCard: {
    borderRadius: radii.xl,
    padding: spacing.xl,
    alignItems: 'center',
    marginTop: spacing.md,
    ...shadows.card,
  },
  heroCardEmpty: { backgroundColor: colors.primary },
  heroCardPending: { backgroundColor: colors.compassGold },
  heroCardActive: { backgroundColor: colors.secondary },
  heroIconCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  heroIconCirclePending: { backgroundColor: 'rgba(255,255,255,0.25)' },
  heroTitle: {
    ...typography.displaySm,
    color: '#FFFFFF',
    textAlign: 'center',
    marginBottom: spacing.xs,
  },
  heroTitleActive: {
    ...typography.displaySm,
    color: '#FFFFFF',
    textAlign: 'center',
    marginBottom: spacing.xs,
  },
  heroSubtitle: {
    ...typography.bodySm,
    color: 'rgba(255,255,255,0.92)',
    textAlign: 'center',
    lineHeight: 20,
  },
  heroSubtitleActive: {
    ...typography.bodySm,
    color: 'rgba(255,255,255,0.95)',
    textAlign: 'center',
    lineHeight: 20,
  },

  // Bullet rows (empty state)
  bulletRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    backgroundColor: colors.card,
    borderRadius: radii.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  bulletIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: `${colors.primary}12`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bulletText: {
    ...typography.bodySm,
    color: colors.foreground,
    flex: 1,
    lineHeight: 20,
  },

  // Info rows (active state)
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.card,
    borderRadius: radii.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  infoIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: `${colors.primary}12`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  infoContent: { flex: 1 },
  infoTitle: {
    ...typography.bodySm,
    fontFamily: fonts.bodySemibold,
    color: colors.foreground,
    marginBottom: 2,
  },
  infoSubtitle: {
    fontSize: 12,
    color: colors.mutedForeground,
  },

  // Requirements card
  requirementsCard: {
    backgroundColor: colors.card,
    borderRadius: radii.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 6,
  },
  requirementsTitle: {
    ...typography.bodySm,
    fontFamily: fonts.bodySemibold,
    color: colors.foreground,
    marginBottom: 4,
  },
  requirementItem: {
    fontSize: 13,
    color: colors.mutedForeground,
  },

  // Buttons
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    height: 54,
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    ...Platform.select({
      ios: {
        shadowColor: colors.primary,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.2,
        shadowRadius: 12,
      },
      android: { elevation: 4 },
    }),
  },
  primaryButtonDisabled: { opacity: 0.6 },
  primaryButtonText: {
    ...typography.bodyMd,
    fontFamily: fonts.bodySemibold,
    color: '#FFFFFF',
  },
  secondaryButton: {
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    marginTop: spacing.xs,
  },
  secondaryButtonText: {
    ...typography.bodySm,
    fontFamily: fonts.bodySemibold,
    color: colors.primary,
  },
  learnMoreLink: { alignSelf: 'center', paddingVertical: spacing.sm },
  learnMoreText: {
    ...typography.bodySm,
    color: colors.primary,
    textDecorationLine: 'underline',
  },

  // Footnote
  footnote: {
    fontSize: 12,
    color: colors.mutedForeground,
    textAlign: 'center',
    lineHeight: 16,
    marginTop: spacing.sm,
  },
});

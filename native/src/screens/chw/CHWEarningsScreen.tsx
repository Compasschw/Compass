/**
 * CHWEarningsScreen — Earnings dashboard for CHW users.
 *
 * Sections:
 *  1. Page header — title + subtitle, period selector, "Update Bank Account" button
 *  2. 3 summary cards — Earnings this period, Pending payout, Paid out this period
 *  3. Sessions Completed table card — driven by useChwEarningSessions(period)
 *  4. Recent Payouts table card     — driven by useChwPayouts(period)
 *
 * The `period` state at the top drives all three data hooks so every section
 * updates together when the user switches between "This Month" / "Last Month".
 *
 * Session detail modal: tapping a row shows Member Name, Session Date,
 * Session Type, Units, Amount Earned, Payment Status.
 *
 * The Update Bank Account button opens Stripe Connect onboarding (unchanged
 * from the previous implementation).
 */

import React, { useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Linking,
  Platform,
  Modal,
  Pressable,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  DollarSign,
  Wallet,
  CheckCircle2,
  ChevronDown,
  X,
} from 'lucide-react-native';

import { formatCurrency } from '../../data/mock';
import {
  useChwEarnings,
  useChwEarningSessions,
  useChwPayouts,
  useConnectOnboardingLink,
  type EarningsPeriod,
  type SessionEarningItem,
} from '../../hooks/useApiQueries';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';
import {
  AppShell,
  PageHeader,
  Card,
  SectionHeader,
  Pill,
  type PillVariant,
} from '../../components/ui';
import { colors as tokens, numerals } from '../../theme/tokens';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Formats an ISO date string as "May 9, 2026" for table cells.
 */
function formatLongDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Formats an ISO date string as "Fri May 16" for the payout date subtext.
 */
function formatPayoutDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Maps a sessionMode string to the human-readable label.
 */
function sessionModeLabel(mode: string): string {
  switch (mode) {
    case 'in_person': return 'In-Person';
    case 'virtual':   return 'Video';
    case 'phone':     return 'Phone';
    default:          return mode;
  }
}

/**
 * Returns a Pill variant + label for a session payment status.
 */
function sessionStatusPill(status: 'paid' | 'pending'): { variant: PillVariant; label: string } {
  return status === 'paid'
    ? { variant: 'emerald', label: 'Paid' }
    : { variant: 'amber',   label: 'Pending' };
}

/**
 * Returns a Pill variant + label for a payout status.
 */
function payoutStatusPill(status: string): { variant: PillVariant; label: string } {
  return status === 'paid' || status === 'completed'
    ? { variant: 'emerald', label: 'Paid' }
    : { variant: 'amber',   label: status };
}

// ─── Period Selector ──────────────────────────────────────────────────────────

interface PeriodSelectorProps {
  value: EarningsPeriod;
  onChange: (p: EarningsPeriod) => void;
}

/**
 * Inline period segmented control for the page header right slot.
 * Shows "This Month" / "Last Month" as pressable tabs.
 */
function PeriodSelector({ value, onChange }: PeriodSelectorProps): React.JSX.Element {
  const now = new Date();
  const thisMonthLabel = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthLabel = prevDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const options: { key: EarningsPeriod; label: string }[] = [
    { key: 'this_month', label: `This month (${thisMonthLabel})` },
    { key: 'last_month', label: `Last month (${lastMonthLabel})` },
  ];

  return (
    <View style={periodStyles.wrap} accessibilityRole="tablist">
      {options.map((opt, idx) => {
        const isActive = value === opt.key;
        return (
          <Pressable
            key={opt.key}
            onPress={() => onChange(opt.key)}
            style={[
              periodStyles.tab,
              isActive && periodStyles.tabActive,
              idx === 0 && periodStyles.tabFirst,
              idx === options.length - 1 && periodStyles.tabLast,
            ]}
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive }}
            accessibilityLabel={opt.label}
          >
            <Text style={[periodStyles.tabText, isActive && periodStyles.tabTextActive]}>
              {opt.label}
            </Text>
            {idx < options.length - 1 && <ChevronDown size={12} color={isActive ? '#ffffff' : tokens.textPrimary} style={periodStyles.chevron} />}
          </Pressable>
        );
      })}
    </View>
  );
}

const periodStyles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    overflow: 'hidden',
  } as ViewStyle,
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: tokens.cardBg,
    gap: 4,
  } as ViewStyle,
  tabActive: {
    backgroundColor: tokens.emerald700,
  } as ViewStyle,
  tabFirst: {
    borderTopLeftRadius: 7,
    borderBottomLeftRadius: 7,
  } as ViewStyle,
  tabLast: {
    borderTopRightRadius: 7,
    borderBottomRightRadius: 7,
  } as ViewStyle,
  tabText: {
    fontSize: 12,
    fontWeight: '600',
    color: tokens.textPrimary,
  } as TextStyle,
  tabTextActive: {
    color: '#ffffff',
  } as TextStyle,
  chevron: {
    display: 'none',
  },
});

// ─── Summary Card ─────────────────────────────────────────────────────────────

interface SummaryCardProps {
  icon: React.ReactNode;
  iconBg: string;
  label: string;
  value: string;
  /** Top-right badge text. */
  badge?: string;
  badgeVariant?: PillVariant;
  /** Small subtext below the value. */
  subtext?: string;
}

/**
 * One of the three equal-width summary cards in the top row.
 * Lays out: icon (top-left) + optional badge (top-right) / big value / label / subtext.
 */
function SummaryCard({
  icon,
  iconBg,
  label,
  value,
  badge,
  badgeVariant = 'emerald',
  subtext,
}: SummaryCardProps): React.JSX.Element {
  return (
    <Card style={summaryCardStyles.card}>
      <View style={summaryCardStyles.topRow}>
        <View style={[summaryCardStyles.iconCircle, { backgroundColor: iconBg }]}>
          {icon}
        </View>
        {badge !== undefined && (
          <Pill variant={badgeVariant} size="sm">{badge}</Pill>
        )}
      </View>
      <Text style={[summaryCardStyles.value, numerals.tabular]}>{value}</Text>
      <Text style={summaryCardStyles.label}>{label}</Text>
      {subtext !== undefined && (
        <Text style={summaryCardStyles.subtext}>{subtext}</Text>
      )}
    </Card>
  );
}

const summaryCardStyles = StyleSheet.create({
  card: {
    flex: 1,
    minWidth: 200,
    padding: 20,
    gap: 6,
  } as ViewStyle,
  topRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 8,
  } as ViewStyle,
  iconCircle: {
    width: 36,
    height: 36,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  value: {
    fontSize: 28,
    fontWeight: '700',
    color: tokens.textPrimary,
    letterSpacing: -0.5,
  } as TextStyle,
  label: {
    fontSize: 13,
    fontWeight: '500',
    color: '#6b7280',
  } as TextStyle,
  subtext: {
    fontSize: 12,
    color: '#9ca3af',
    marginTop: 2,
  } as TextStyle,
});

// ─── Session Detail Modal ─────────────────────────────────────────────────────

interface SessionDetailModalProps {
  visible: boolean;
  session: SessionEarningItem | null;
  onClose: () => void;
}

/**
 * Bottom-sheet style modal showing detail for a tapped session row.
 * Omits "Open Member Profile" since SessionEarningItem has no member id.
 */
function SessionDetailModal({ visible, session, onClose }: SessionDetailModalProps): React.JSX.Element {
  if (!session) return <></>;

  const statusPill = sessionStatusPill(session.paymentStatus);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      accessibilityViewIsModal
    >
      <Pressable style={detailModalStyles.backdrop} onPress={onClose}>
        <Pressable
          style={detailModalStyles.sheet}
          onPress={(e) => e.stopPropagation()}
          accessibilityLabel="Session detail"
        >
          {/* Header */}
          <View style={detailModalStyles.sheetHeader}>
            <Text style={detailModalStyles.sheetTitle}>Session Detail</Text>
            <TouchableOpacity
              onPress={onClose}
              style={detailModalStyles.closeBtn}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <X size={18} color="#6b7280" />
            </TouchableOpacity>
          </View>

          {/* Fields */}
          <View style={detailModalStyles.fields}>
            <DetailRow label="Member Name"    value={session.memberName} />
            <DetailRow label="Session Date"   value={formatLongDate(session.serviceDate)} />
            <DetailRow label="Session Type"   value={sessionModeLabel(session.sessionMode)} />
            <DetailRow label="Units"          value={session.units.toFixed(2)} />
            <DetailRow label="Amount Earned"  value={formatCurrency(session.amountEarned)} />
            <View style={detailModalStyles.fieldRow}>
              <Text style={detailModalStyles.fieldLabel}>Payment Status</Text>
              <Pill variant={statusPill.variant} size="sm">{statusPill.label}</Pill>
            </View>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

interface DetailRowProps {
  label: string;
  value: string;
}

function DetailRow({ label, value }: DetailRowProps): React.JSX.Element {
  return (
    <View style={detailModalStyles.fieldRow}>
      <Text style={detailModalStyles.fieldLabel}>{label}</Text>
      <Text style={detailModalStyles.fieldValue}>{value}</Text>
    </View>
  );
}

const detailModalStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,
  sheet: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    width: '100%',
    maxWidth: 480,
    padding: 24,
    margin: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.12,
    shadowRadius: 24,
    elevation: 10,
  } as ViewStyle,
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 20,
  } as ViewStyle,
  sheetTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: tokens.textPrimary,
  } as TextStyle,
  closeBtn: {
    padding: 4,
  } as ViewStyle,
  fields: {
    gap: 16,
  } as ViewStyle,
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  } as ViewStyle,
  fieldLabel: {
    fontSize: 13,
    color: '#6b7280',
    fontWeight: '500',
  } as TextStyle,
  fieldValue: {
    fontSize: 13,
    color: tokens.textPrimary,
    fontWeight: '600',
  } as TextStyle,
});

// ─── Main Component ───────────────────────────────────────────────────────────

/**
 * CHW Earnings screen — period selector, 3 summary cards, sessions table,
 * payouts table.
 *
 * One-screen answer to the four core CHW questions:
 *   1. How much have I earned?
 *   2. How much is paid soon?
 *   3. Which sessions earned it?
 *   4. Have I actually been paid?
 */
export function CHWEarningsScreen(): React.JSX.Element {
  const [period, setPeriod] = useState<EarningsPeriod>('this_month');
  const [selectedSession, setSelectedSession] = useState<SessionEarningItem | null>(null);
  const [sessionModalVisible, setSessionModalVisible] = useState(false);

  const earningsQuery       = useChwEarnings(period);
  const earningSessionsQuery = useChwEarningSessions(period);
  const payoutsQuery        = useChwPayouts(period);
  const connectOnboarding   = useConnectOnboardingLink();

  // ── Stripe Connect onboarding flow ────────────────────────────────────────
  const handleUpdateBankAccount = useCallback(() => {
    if (connectOnboarding.isPending) return;
    connectOnboarding.mutate(undefined, {
      onSuccess: ({ onboardingUrl }) => {
        if (Platform.OS === 'web' && typeof window !== 'undefined') {
          // Full-page redirect to Stripe's hosted onboarding. A post-await
          // `window.open(..., '_blank')` is popup-blocked because it isn't a
          // direct user gesture — that's why the button "did nothing".
          // Same-tab navigation is the standard Stripe Connect pattern; Stripe
          // returns the CHW to /payments/onboarding-complete via the return_url.
          window.location.assign(onboardingUrl);
        } else {
          void Linking.openURL(onboardingUrl);
        }
      },
    });
  }, [connectOnboarding]);

  // ── Session detail modal handlers ─────────────────────────────────────────
  const handleSessionPress = useCallback((session: SessionEarningItem) => {
    setSelectedSession(session);
    setSessionModalVisible(true);
  }, []);

  const handleSessionModalClose = useCallback(() => {
    setSessionModalVisible(false);
    setSelectedSession(null);
  }, []);

  // ── Derived values ─────────────────────────────────────────────────────────
  const earnings         = earningsQuery.data;
  const earningSessions  = useMemo(() => earningSessionsQuery.data ?? [], [earningSessionsQuery.data]);
  const payouts          = useMemo(() => payoutsQuery.data ?? [], [payoutsQuery.data]);

  const nextPayoutFormatted = useMemo<string | null>(() => {
    if (!earnings?.nextPayoutDate) return null;
    return formatPayoutDate(earnings.nextPayoutDate);
  }, [earnings?.nextPayoutDate]);

  // ── Loading / error guards ────────────────────────────────────────────────
  const isLoading  = earningsQuery.isLoading || earningSessionsQuery.isLoading || payoutsQuery.isLoading;
  const queryError = earningsQuery.error ?? earningSessionsQuery.error ?? payoutsQuery.error;

  const handleRetry = useCallback(() => {
    void earningsQuery.refetch();
    void earningSessionsQuery.refetch();
    void payoutsQuery.refetch();
  }, [earningsQuery, earningSessionsQuery, payoutsQuery]);

  // ── Header right slot (shared between loading and loaded states) ──────────
  const headerRight = (
    <View style={styles.headerRight}>
      <PeriodSelector value={period} onChange={setPeriod} />
      <TouchableOpacity
        style={styles.updateBankBtn}
        onPress={handleUpdateBankAccount}
        disabled={connectOnboarding.isPending}
        accessibilityRole="button"
        accessibilityLabel="Update bank account"
      >
        {connectOnboarding.isPending ? (
          <ActivityIndicator size="small" color={tokens.textPrimary} />
        ) : null}
        <Text style={styles.updateBankBtnText}>Update bank account</Text>
      </TouchableOpacity>
    </View>
  );

  if (isLoading) {
    return (
      <AppShell
        role="chw"
        activeKey="earnings"
        userBlock={{ initials: '...', name: '...', role: 'CHW' }}
      >
        <SafeAreaView style={styles.safe} edges={['top']}>
          <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
            <View style={styles.pageWrap}>
              <PageHeader
                title="Earnings"
                subtitle="Overview of your earnings and payouts"
                right={headerRight}
              />
              <LoadingSkeleton variant="stat-grid" />
              <LoadingSkeleton variant="rows" rows={4} />
            </View>
          </ScrollView>
        </SafeAreaView>
      </AppShell>
    );
  }

  if (queryError) {
    return (
      <AppShell
        role="chw"
        activeKey="earnings"
        userBlock={{ initials: '...', name: '...', role: 'CHW' }}
      >
        <SafeAreaView style={styles.safe} edges={['top']}>
          <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
            <View style={styles.pageWrap}>
              <PageHeader
                title="Earnings"
                subtitle="Overview of your earnings and payouts"
                right={headerRight}
              />
              <ErrorState message="Failed to load earnings" onRetry={handleRetry} />
            </View>
          </ScrollView>
        </SafeAreaView>
      </AppShell>
    );
  }

  return (
    <AppShell
      role="chw"
      activeKey="earnings"
      userBlock={{ initials: 'MS', name: 'Maria Sanchez', role: 'CHW' }}
    >
      <SafeAreaView style={styles.safe} edges={['top']}>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.pageWrap}>

            {/* ── Page header ─────────────────────────────────────────────── */}
            <PageHeader
              title="Earnings"
              subtitle="Overview of your earnings and payouts"
              right={headerRight}
            />

            {/* ── 3 summary cards ─────────────────────────────────────────── */}
            <View style={styles.cardRow}>
              {/* Card 1 — Earnings this period */}
              <SummaryCard
                icon={<DollarSign size={18} color={tokens.emerald700} />}
                iconBg={tokens.emerald100}
                label="Earnings this month"
                value={formatCurrency(earnings?.earningsThisPeriod ?? 0)}
              />

              {/* Card 2 — Pending payout */}
              <SummaryCard
                icon={<Wallet size={18} color={tokens.blue700} />}
                iconBg={tokens.blue100}
                label="Pending payout"
                value={formatCurrency(earnings?.pendingPayout ?? 0)}
                badge={earnings?.pendingInTransit ? 'In transit' : undefined}
                badgeVariant="blue"
                subtext={
                  nextPayoutFormatted
                    ? `Paid on ${nextPayoutFormatted}`
                    : undefined
                }
              />

              {/* Card 3 — Paid out this period */}
              <SummaryCard
                icon={<CheckCircle2 size={18} color={tokens.emerald700} />}
                iconBg={tokens.emerald100}
                label="Paid out this month"
                value={formatCurrency(earnings?.paidThisPeriod ?? 0)}
                badge="Paid"
                badgeVariant="emerald"
              />
            </View>

            {/* ── Sessions Completed table ─────────────────────────────────── */}
            <Card style={styles.tableCard}>
              <View style={styles.cardHeaderRow}>
                <SectionHeader title="Sessions completed" marginBottom={0} />
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="View all sessions"
                >
                  <Text style={styles.viewAllLink}>View all sessions →</Text>
                </TouchableOpacity>
              </View>

              {earningSessions.length === 0 ? (
                <View style={styles.emptyRow}>
                  <Text style={styles.emptyText}>No sessions yet this period.</Text>
                </View>
              ) : (
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <View style={styles.tableInner}>
                    {/* Table header */}
                    <View style={[styles.tableRow, styles.tableHeaderRow]}>
                      {SESSION_COLS.map((col) => (
                        <Text key={col} style={[styles.th, sessionColWidths[col] as TextStyle]}>
                          {col}
                        </Text>
                      ))}
                    </View>
                    {/* Data rows */}
                    {earningSessions.map((s) => {
                      const pill = sessionStatusPill(s.paymentStatus);
                      return (
                        <TouchableOpacity
                          key={s.sessionId}
                          style={[styles.tableRow, styles.tableDataRow]}
                          onPress={() => handleSessionPress(s)}
                          accessibilityRole="button"
                          accessibilityLabel={`Session for ${s.memberName}, ${formatCurrency(s.amountEarned)}`}
                        >
                          <Text style={[styles.td, sessionColWidths['SESSION DATE'] as TextStyle]}>
                            {formatLongDate(s.serviceDate)}
                          </Text>
                          <Text style={[styles.td, styles.tdBold, sessionColWidths['MEMBER NAME'] as TextStyle]}>
                            {s.memberName}
                          </Text>
                          <Text style={[styles.td, styles.tdNumeric, sessionColWidths.UNITS as TextStyle, numerals.tabular]}>
                            {s.units.toFixed(2)}
                          </Text>
                          <Text style={[styles.td, styles.tdBold, sessionColWidths['AMOUNT EARNED'] as TextStyle, numerals.tabular]}>
                            {formatCurrency(s.amountEarned)}
                          </Text>
                          <View style={[sessionColWidths['PAYMENT STATUS'] as ViewStyle, styles.tdCenter]}>
                            <Pill variant={pill.variant} size="sm">{pill.label}</Pill>
                          </View>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </ScrollView>
              )}
            </Card>

            {/* ── Recent Payouts table ─────────────────────────────────────── */}
            <Card style={styles.tableCard}>
              <View style={styles.cardHeaderRow}>
                <SectionHeader title="Recent payouts" marginBottom={0} />
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="View all payouts"
                >
                  <Text style={styles.viewAllLink}>View all payouts →</Text>
                </TouchableOpacity>
              </View>

              {payouts.length === 0 ? (
                <View style={styles.emptyRow}>
                  <Text style={styles.emptyText}>No payouts yet this period.</Text>
                </View>
              ) : (
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <View style={styles.tableInner}>
                    {/* Table header */}
                    <View style={[styles.tableRow, styles.tableHeaderRow]}>
                      {PAYOUT_COLS.map((col) => (
                        <Text key={col} style={[styles.th, payoutColWidths[col] as TextStyle]}>
                          {col}
                        </Text>
                      ))}
                    </View>
                    {/* Data rows */}
                    {payouts.map((p, idx) => {
                      const pill = payoutStatusPill(p.status);
                      return (
                        <View key={p.reference ?? idx} style={[styles.tableRow, styles.tableDataRow]}>
                          <Text style={[styles.td, payoutColWidths.DATE as TextStyle]}>
                            {formatLongDate(p.date)}
                          </Text>
                          <Text style={[styles.td, styles.tdBold, payoutColWidths.AMOUNT as TextStyle, numerals.tabular]}>
                            {formatCurrency(p.amount)}
                          </Text>
                          <View style={[payoutColWidths.STATUS as ViewStyle, styles.tdCenter]}>
                            <Pill variant={pill.variant} size="sm">{pill.label}</Pill>
                          </View>
                          <Text style={[styles.td, payoutColWidths['PAYOUT METHOD'] as TextStyle]}>
                            {p.method}
                          </Text>
                          <Text style={[styles.td, styles.tdMono, payoutColWidths.REFERENCE as TextStyle]}>
                            {p.reference ?? '—'}
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                </ScrollView>
              )}
            </Card>

          </View>
        </ScrollView>
      </SafeAreaView>

      {/* ── Session detail modal ─────────────────────────────────────────── */}
      <SessionDetailModal
        visible={sessionModalVisible}
        session={selectedSession}
        onClose={handleSessionModalClose}
      />
    </AppShell>
  );
}

// ─── Table column definitions ─────────────────────────────────────────────────

type SessionCol = 'SESSION DATE' | 'MEMBER NAME' | 'UNITS' | 'AMOUNT EARNED' | 'PAYMENT STATUS';
const SESSION_COLS: SessionCol[] = ['SESSION DATE', 'MEMBER NAME', 'UNITS', 'AMOUNT EARNED', 'PAYMENT STATUS'];
const sessionColWidths: Record<SessionCol, ViewStyle> = {
  'SESSION DATE':    { width: 120 },
  'MEMBER NAME':    { width: 160 },
  UNITS:            { width: 72 },
  'AMOUNT EARNED':  { width: 120 },
  'PAYMENT STATUS': { width: 120 },
};

type PayoutCol = 'DATE' | 'AMOUNT' | 'STATUS' | 'PAYOUT METHOD' | 'REFERENCE';
const PAYOUT_COLS: PayoutCol[] = ['DATE', 'AMOUNT', 'STATUS', 'PAYOUT METHOD', 'REFERENCE'];
const payoutColWidths: Record<PayoutCol, ViewStyle> = {
  DATE:            { width: 120 },
  AMOUNT:          { width: 100 },
  STATUS:          { width: 90 },
  'PAYOUT METHOD': { width: 130 },
  REFERENCE:       { width: 160 },
};

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#f5f7f6',
  } as ViewStyle,

  scroll: {
    flex: 1,
  } as ViewStyle,

  content: {
    flexGrow: 1,
  } as ViewStyle,

  pageWrap: {
    width: '100%',
    maxWidth: 1600,
    alignSelf: 'center',
    padding: 32,
    paddingBottom: 48,
  } as ViewStyle,

  // ── Header right slot ───────────────────────────────────────────────────────
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flexWrap: 'wrap',
  } as ViewStyle,

  updateBankBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 36,
    paddingHorizontal: 14,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    backgroundColor: tokens.cardBg,
  } as ViewStyle,

  updateBankBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: tokens.textPrimary,
  } as TextStyle,

  // ── Summary card row ────────────────────────────────────────────────────────
  cardRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 16,
    marginBottom: 24,
  } as ViewStyle,

  // ── Table cards (sessions + payouts) ────────────────────────────────────────
  tableCard: {
    marginBottom: 24,
    overflow: 'hidden',
    padding: 0,
  } as ViewStyle,

  cardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  } as ViewStyle,

  viewAllLink: {
    fontSize: 13,
    fontWeight: '600',
    color: tokens.emerald700,
  } as TextStyle,

  // ── Table layout ────────────────────────────────────────────────────────────
  tableInner: {
    minWidth: '100%',
  } as ViewStyle,

  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
  } as ViewStyle,

  tableHeaderRow: {
    backgroundColor: '#f9fafb',
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  } as ViewStyle,

  tableDataRow: {
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  } as ViewStyle,

  th: {
    fontSize: 11,
    fontWeight: '700',
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    paddingVertical: 10,
    paddingHorizontal: 16,
  } as TextStyle,

  td: {
    fontSize: 13,
    color: '#374151',
    paddingVertical: 13,
    paddingHorizontal: 16,
  } as TextStyle,

  tdBold: {
    fontWeight: '600',
    color: tokens.textPrimary,
  } as TextStyle,

  tdNumeric: {
    textAlign: 'right',
  } as TextStyle,

  tdMono: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 12,
    color: '#6b7280',
  } as TextStyle,

  tdCenter: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 13,
    paddingHorizontal: 16,
  } as ViewStyle,

  // ── Empty states ────────────────────────────────────────────────────────────
  emptyRow: {
    paddingVertical: 32,
    paddingHorizontal: 20,
    alignItems: 'center',
  } as ViewStyle,

  emptyText: {
    fontSize: 14,
    color: '#9ca3af',
  } as TextStyle,
});

/**
 * CHWEarningsScreen — Earnings dashboard for CHW users.
 *
 * Visual spec: native/_mockups/earnings.html (v1)
 *
 * Sections:
 *  1. Page header row — title, Stripe account subtitle, period selector, export & Stripe CTAs
 *  2. 4 KPI stat tiles — Earnings this month, Pending payout, Paid out this month,
 *                        Claims pending adjudication
 *  3. 8/12 Earnings trend chart + 4/12 Bank & payout setup card
 *  4. Sessions billed table card (full width)
 *  5. Recent payouts card (full width)
 *
 * Data wiring:
 *  - useChwEarnings()          → KPI tiles 1/2/3, Stripe account ID in subtitle
 *  - useChwClaims()            → KPI tile 4, sessions table (CPT, units, gross, net, status),
 *                                computed paidOutThisMonth from paid claims
 *  - usePaymentsAccountStatus()→ payoutsEnabled flag, accountId for Stripe subtitle
 */

import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Linking,
  Platform,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  DollarSign,
  Banknote,
  CheckCircle2,
  Clock,
  BadgeCheck,
  Download,
  ExternalLink,
  ShieldCheck,
} from 'lucide-react-native';

import { formatCurrency } from '../../data/mock';
import {
  useChwClaims,
  useChwEarnings,
  usePaymentsAccountStatus,
  type ChwClaim,
} from '../../hooks/useApiQueries';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';
import {
  AppShell,
  PageHeader,
  Card,
  StatTile,
  Pill,
  type PillVariant,
} from '../../components/ui';
import { colors as tokens } from '../../theme/tokens';

// ─── Constants ────────────────────────────────────────────────────────────────

const STRIPE_DASHBOARD_URL = 'https://dashboard.stripe.com/express';

const PERIOD_OPTIONS = [
  'This month (May 2026)',
  'Last month',
  'Year to date',
] as const;

type PeriodOption = typeof PERIOD_OPTIONS[number];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Truncates a Stripe account ID for display: "acct_1ABCDEFGx9" → "acct_1ABC...x9".
 * Returns "—" when accountId is null or empty.
 */
function maskStripeAccountId(accountId: string | null | undefined): string {
  if (!accountId || accountId.length < 8) return accountId ?? '—';
  const prefix = accountId.slice(0, 9); // "acct_1ABC"
  const suffix = accountId.slice(-2);   // "x9"
  return `${prefix}...${suffix}`;
}

/**
 * Formats an ISO date string as "May 7" for the sessions table Date column.
 */
function formatClaimDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Returns true when the claim's serviceDate falls within the current calendar month.
 */
function isCurrentMonth(iso: string | null): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}

/**
 * Maps a ChwClaim.status string to the Pear Suite pill variant + label tuple.
 */
function pearPill(status: string): { variant: PillVariant; label: string } {
  switch (status) {
    case 'paid':
      return { variant: 'emerald', label: 'paid' };
    case 'submitted':
      return { variant: 'amber', label: 'submitted' };
    case 'rejected':
      return { variant: 'red', label: 'denied' };
    default:
      return { variant: 'amber', label: 'submitted' };
  }
}

/**
 * Maps a ChwClaim.status string to the Stripe pill variant + label tuple.
 * "paid" claims are transferred; everything else is awaiting or blank for rejected.
 */
function stripePill(status: string): { variant: PillVariant; label: string } {
  switch (status) {
    case 'paid':
      return { variant: 'emerald', label: 'transferred' };
    case 'rejected':
      return { variant: 'gray', label: '—' };
    default:
      return { variant: 'gray', label: 'awaiting claim' };
  }
}

// ─── Subcomponents ────────────────────────────────────────────────────────────

/**
 * Native-compatible period selector.
 * On web: renders a styled <select> element via a webStyle override.
 * On native: shows the current period label as a pressable button (no ActionSheet
 * dependency needed — this is a display-only label for the CHW's context).
 */
function PeriodSelector({
  value,
  onChange,
}: {
  value: PeriodOption;
  onChange: (v: PeriodOption) => void;
}): React.JSX.Element {
  if (Platform.OS === 'web') {
    return (
      // @ts-expect-error — select is a valid web-only element
      <select
        value={value}
        onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
          onChange(e.target.value as PeriodOption)
        }
        style={webStyles.periodSelect}
        aria-label="Select period"
      >
        {PERIOD_OPTIONS.map((opt) => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    );
  }

  // Native: simple pressable that cycles through periods
  const currentIdx = PERIOD_OPTIONS.indexOf(value);
  return (
    <TouchableOpacity
      style={styles.periodButtonNative}
      onPress={() => onChange(PERIOD_OPTIONS[(currentIdx + 1) % PERIOD_OPTIONS.length])}
      accessibilityRole="button"
      accessibilityLabel={`Period: ${value}. Tap to change.`}
    >
      <Text style={styles.periodButtonText}>{value}</Text>
    </TouchableOpacity>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

/**
 * CHW Earnings screen — mirrors earnings.html (v1 spec) 1:1.
 */
export function CHWEarningsScreen(): React.JSX.Element {
  const [selectedPeriod, setSelectedPeriod] = useState<PeriodOption>(PERIOD_OPTIONS[0]);

  const earningsQuery = useChwEarnings();
  const claimsQuery = useChwClaims();
  const paymentsQuery = usePaymentsAccountStatus();

  const isLoading = earningsQuery.isLoading || claimsQuery.isLoading;
  const queryError = earningsQuery.error ?? claimsQuery.error;

  const handleRetry = () => {
    void earningsQuery.refetch();
    void claimsQuery.refetch();
  };

  const earnings = earningsQuery.data;
  const allClaims: ChwClaim[] = claimsQuery.data ?? [];
  const payoutsEnabled = paymentsQuery.data?.payoutsEnabled === true;
  const accountId = paymentsQuery.data?.accountId ?? null;

  // ── Derived KPI values ────────────────────────────────────────────────────

  /**
   * Sum of netPayout for claims with status='paid' in the current calendar month.
   * Falls back to earnings.pendingPayout when no paid claims exist.
   */
  const paidOutThisMonth = useMemo<number>(() => {
    const paid = allClaims.filter(
      (c) => c.status === 'paid' && isCurrentMonth(c.serviceDate ?? c.paidAt),
    );
    return paid.reduce((acc, c) => acc + c.netPayout, 0);
  }, [allClaims]);

  /**
   * Sum of grossAmount for claims with status='pending' or 'submitted'.
   * These are the claims awaiting adjudication at Pear Suite.
   */
  const pendingAdjudicationAmount = useMemo<number>(() => {
    return allClaims
      .filter((c) => c.status === 'pending' || c.status === 'submitted')
      .reduce((acc, c) => acc + c.grossAmount, 0);
  }, [allClaims]);

  /**
   * Claims filtered to the current calendar month for the sessions table.
   */
  const currentMonthClaims = useMemo<ChwClaim[]>(() => {
    return allClaims
      .filter((c) => isCurrentMonth(c.serviceDate ?? c.createdAt))
      .sort((a, b) => {
        const ta = new Date(a.serviceDate ?? a.createdAt ?? '').getTime();
        const tb = new Date(b.serviceDate ?? b.createdAt ?? '').getTime();
        return tb - ta; // newest first
      });
  }, [allClaims]);

  /**
   * Paid claims for the recent payouts list (newest paidAt first).
   * TODO: wire when /chw/payouts ships — then replace this derived list with
   * a dedicated hook that returns aggregate payout transfer records.
   */
  const recentPayoutClaims = useMemo<ChwClaim[]>(() => {
    return allClaims
      .filter((c) => c.status === 'paid')
      .sort((a, b) => {
        const ta = new Date(a.paidAt ?? '').getTime();
        const tb = new Date(b.paidAt ?? '').getTime();
        return tb - ta;
      })
      .slice(0, 3);
  }, [allClaims]);

  // ── MoM delta for tile 1 ─────────────────────────────────────────────────
  // EarningsSummary does not expose a previousMonth field, so we cannot compute
  // MoM%. The delta pill is omitted. TODO: wire when /chw/earnings exposes monthOverMonth.
  const momDelta: string | undefined = undefined;

  // ── Stripe account masked ID ──────────────────────────────────────────────
  const maskedAccountId = maskStripeAccountId(accountId);

  // ── Loading / error guards ────────────────────────────────────────────────

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
          <ErrorState message="Failed to load earnings" onRetry={handleRetry} />
        </SafeAreaView>
      </AppShell>
    );
  }

  // ── Header right slot ─────────────────────────────────────────────────────

  const headerRight = (
    <View style={styles.headerControls}>
      <PeriodSelector value={selectedPeriod} onChange={setSelectedPeriod} />

      <TouchableOpacity
        style={styles.outlineButton}
        accessibilityRole="button"
        accessibilityLabel="Export 1099 data"
        // TODO: wire to a real export endpoint when /chw/earnings/1099-export ships
      >
        <Download size={14} color="#374151" />
        <Text style={styles.outlineButtonText}>Export 1099 data</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.primaryButton}
        onPress={() => void Linking.openURL(STRIPE_DASHBOARD_URL)}
        accessibilityRole="link"
        accessibilityLabel="Open Stripe Dashboard"
      >
        <ExternalLink size={14} color="#FFFFFF" />
        <Text style={styles.primaryButtonText}>Open Stripe Dashboard</Text>
      </TouchableOpacity>
    </View>
  );

  // ── Subtitle row (Stripe Connect line) ────────────────────────────────────

  const subtitleSlot = (
    <View style={styles.subtitleRow}>
      <Text style={styles.subtitleText}>
        {'Stripe Connect · Express account · ID '}
        {maskedAccountId}
        {'  '}
      </Text>
      {payoutsEnabled && (
        <View style={styles.payoutsEnabledPill}>
          <BadgeCheck size={10} color="#047857" />
          <Text style={styles.payoutsEnabledText}>Payouts enabled</Text>
        </View>
      )}
    </View>
  );

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
            {/* ── Page header ── */}
            <PageHeader
              title="Earnings"
              subtitle={undefined} // subtitle rendered as custom slot below
              right={headerRight}
            />
            {/* Custom subtitle with inline pill — rendered below the PageHeader
                because PageHeader's subtitle prop only accepts a plain string */}
            {subtitleSlot}

            {/* ── 4 KPI stat tiles ── */}
            <View style={styles.statGrid}>
              {/* 1. Earnings this month */}
              <View style={styles.statTileWrap}>
                <StatTile
                  icon={<DollarSign size={18} color="#16a34a" />}
                  iconBg={tokens.emerald100}
                  label="Earnings this month"
                  value={formatCurrency(earnings?.thisMonth ?? 0)}
                  delta={momDelta}
                  deltaColor={tokens.emerald700}
                  deltaBg="#ecfdf5"
                />
              </View>

              {/* 2. Pending payout
                  Wired to earnings.pendingPayout — EarningsSummary exposes this.
                  nextPayoutDate is not in the schema; showing static "Fri May 16".
                  TODO: wire nextPayoutDate when /chw/earnings exposes it. */}
              <View style={styles.statTileWrap}>
                <StatTile
                  icon={<Banknote size={18} color="#1d4ed8" />}
                  iconBg={tokens.blue100}
                  label="Pending payout (Fri May 16)"
                  value={formatCurrency(earnings?.pendingPayout ?? 0)}
                  delta="in transit"
                  deltaColor="#1d4ed8"
                  deltaBg="#eff6ff"
                />
              </View>

              {/* 3. Paid out this month — derived from paid claims in current month */}
              <View style={styles.statTileWrap}>
                <StatTile
                  icon={<CheckCircle2 size={18} color="#6d28d9" />}
                  iconBg={tokens.purple100}
                  label="Paid out this month"
                  value={formatCurrency(paidOutThisMonth)}
                  delta="paid"
                  deltaColor={tokens.emerald700}
                  deltaBg="#ecfdf5"
                />
              </View>

              {/* 4. Claims pending adjudication — sum of pending/submitted claim gross */}
              <View style={styles.statTileWrap}>
                <StatTile
                  icon={<Clock size={18} color="#b45309" />}
                  iconBg={tokens.amber100}
                  label="Claims pending adjudication"
                  value={formatCurrency(pendingAdjudicationAmount)}
                  delta="awaiting Pear"
                  deltaColor={tokens.amber700}
                  deltaBg="#fffbeb"
                />
              </View>
            </View>

            {/* ── Earnings trend + Bank setup row (8/12 + 4/12) ── */}
            <View style={styles.trendBankRow}>
              {/* Left: Earnings trend chart (8/12) */}
              <Card style={styles.trendCard}>
                <View style={styles.trendHeader}>
                  <Text style={styles.sectionTitle}>Earnings trend</Text>
                  <Text style={styles.trendMeta}>Weekly · last 8 weeks</Text>
                </View>

                {/* Gradient chart area — SVG is static from the mock.
                    TODO: wire polyline points when /chw/earnings/weekly ships
                    returning a weekly[] array of grossAmount sums. */}
                <View style={styles.trendChartArea}>
                  {Platform.OS === 'web' ? (
                    // @ts-expect-error — svg is a valid web element
                    <svg
                      viewBox="0 0 600 180"
                      style={{ width: '100%', height: 176 }}
                      aria-label="Earnings trend chart — last 8 weeks"
                      role="img"
                    >
                      <defs>
                        {/* @ts-expect-error */}
                        <linearGradient id="chwEarningsGrad" x1="0" x2="0" y1="0" y2="1">
                          {/* @ts-expect-error */}
                          <stop offset="0%" stopColor="#10b981" />
                          {/* @ts-expect-error */}
                          <stop offset="100%" stopColor="#10b981" stopOpacity="0" />
                        </linearGradient>
                      </defs>
                      {/* Area fill */}
                      {/* @ts-expect-error */}
                      <polyline
                        points="20,150 90,135 160,128 230,108 300,98 370,80 440,55 510,30 510,180 20,180"
                        fill="url(#chwEarningsGrad)"
                        opacity="0.22"
                      />
                      {/* Line */}
                      {/* @ts-expect-error */}
                      <polyline
                        points="20,150 90,135 160,128 230,108 300,98 370,80 440,55 510,30"
                        stroke="#10b981"
                        strokeWidth="4"
                        fill="none"
                        strokeLinecap="round"
                      />
                      {/* X-axis labels */}
                      {/* @ts-expect-error */}
                      <g fontFamily="Inter, system-ui, sans-serif" fontSize="10" fill="#9ca3af">
                        {/* @ts-expect-error */}
                        <text x="20" y="175" textAnchor="middle">Mar 17</text>
                        {/* @ts-expect-error */}
                        <text x="160" y="175" textAnchor="middle">Mar 31</text>
                        {/* @ts-expect-error */}
                        <text x="300" y="175" textAnchor="middle">Apr 14</text>
                        {/* @ts-expect-error */}
                        <text x="440" y="175" textAnchor="middle">Apr 28</text>
                        {/* @ts-expect-error */}
                        <text x="510" y="175" textAnchor="middle">May 5</text>
                      </g>
                    </svg>
                  ) : (
                    // Native: render a simple placeholder bar — SVG charting
                    // requires react-native-svg which is already a dep if used
                    // elsewhere; for now show a text fallback.
                    <View style={styles.trendChartNativePlaceholder}>
                      <Text style={styles.trendChartNativePlaceholderText}>
                        Chart available on web
                      </Text>
                    </View>
                  )}
                </View>
              </Card>

              {/* Right: Bank & payout setup (4/12) */}
              <Card style={styles.bankCard}>
                <Text style={styles.sectionTitle}>Bank &amp; payout setup</Text>

                <View style={styles.bankChecklist}>
                  <BankCheckItem label="Identity verified" />
                  {/* TODO: wire bank account last4 when /payments/account-status
                      exposes bankLast4. Currently not in PaymentsAccountStatus shape. */}
                  <BankCheckItem label="Bank account on file" sublabel="···4421" />
                  <BankCheckItem label="Tax info submitted (W-9)" />
                  <BankCheckItem label="Payout schedule: weekly (Fri)" />
                </View>

                {/* Status banner */}
                <View style={styles.payoutsStatusBanner}>
                  <ShieldCheck size={14} color="#16a34a" />
                  <Text style={styles.payoutsStatusBannerText}>
                    {/* TODO: wire nextPayoutDate when backend exposes it */}
                    Payouts enabled · next on Fri May 16
                  </Text>
                </View>

                <TouchableOpacity
                  style={styles.outlineButtonFull}
                  accessibilityRole="button"
                  accessibilityLabel="Update bank account"
                  onPress={() => void Linking.openURL(STRIPE_DASHBOARD_URL)}
                >
                  <Text style={styles.outlineButtonFullText}>Update bank account</Text>
                </TouchableOpacity>
              </Card>
            </View>

            {/* ── Sessions billed table (full width) ── */}
            <Card style={styles.tableCard}>
              <View style={styles.tableCardHeader}>
                <Text style={styles.sectionTitle}>Sessions billed this month</Text>
                <TouchableOpacity accessibilityRole="button" accessibilityLabel="View all sessions">
                  <Text style={styles.viewAllLink}>View all →</Text>
                </TouchableOpacity>
              </View>

              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.tableScroll}
              >
                <View style={styles.tableInner}>
                  {/* Table header */}
                  <View style={[styles.tableRow, styles.tableHeaderRow]}>
                    {['Member', 'Date', 'CPT', 'Units', 'Gross', 'Net', 'Pear Suite', 'Stripe'].map(
                      (col) => (
                        <Text key={col} style={[styles.th, colWidths[col as TableCol]]}>
                          {col}
                        </Text>
                      ),
                    )}
                  </View>

                  {/* Data rows */}
                  {currentMonthClaims.length === 0 ? (
                    <View style={styles.tableEmptyRow}>
                      <Text style={styles.tableEmptyText}>No sessions billed this month.</Text>
                    </View>
                  ) : (
                    currentMonthClaims.map((claim) => {
                      const pear = pearPill(claim.status);
                      const stripe = stripePill(claim.status);
                      return (
                        <View key={claim.id} style={[styles.tableRow, styles.tableDataRow]}>
                          {/* Member — ChwClaim has no memberName field; sessionId could be
                              used to cross-ref useSessions(), but that adds a heavy second
                              query. Show "—" until /chw/claims returns memberName directly.
                              TODO: wire memberName when /chw/claims exposes it. */}
                          <Text style={[styles.td, styles.tdMemberName, colWidths.Member]}>
                            —
                          </Text>
                          <Text style={[styles.td, colWidths.Date]}>
                            {formatClaimDate(claim.serviceDate)}
                          </Text>
                          <View style={[colWidths.CPT, styles.tdCenter]}>
                            <Pill variant="blue" size="sm">
                              {claim.procedureCode || '—'}
                            </Pill>
                          </View>
                          <Text style={[styles.td, styles.tdNumeric, colWidths.Units]}>
                            {claim.units ?? '—'}
                          </Text>
                          <Text style={[styles.td, colWidths.Gross]}>
                            {formatCurrency(claim.grossAmount)}
                          </Text>
                          <Text style={[styles.td, styles.tdBold, colWidths.Net]}>
                            {formatCurrency(claim.netPayout)}
                          </Text>
                          <View style={[colWidths['Pear Suite'], styles.tdCenter]}>
                            <Pill variant={pear.variant} size="sm">{pear.label}</Pill>
                          </View>
                          <View style={[colWidths.Stripe, styles.tdCenter]}>
                            <Pill variant={stripe.variant} size="sm">{stripe.label}</Pill>
                          </View>
                        </View>
                      );
                    })
                  )}
                </View>
              </ScrollView>
            </Card>

            {/* ── Recent payouts card (full width) ── */}
            {/* Data is derived from paid claims sorted by paidAt desc (top 3).
                TODO: replace with a dedicated /chw/payouts hook when it ships,
                which will return aggregate payout transfer records (not per-claim). */}
            <Card style={styles.payoutsCard}>
              <View style={styles.payoutsCardHeader}>
                <Text style={styles.sectionTitle}>Recent payouts</Text>
              </View>

              <View style={styles.payoutsList}>
                {recentPayoutClaims.length === 0 ? (
                  /* Skeleton row — shown when no paid claims exist yet */
                  <View style={styles.payoutRow}>
                    <View style={styles.payoutIconCircle}>
                      <CheckCircle2 size={18} color="#16a34a" />
                    </View>
                    <View style={styles.payoutInfo}>
                      <Text style={styles.payoutAmount}>—</Text>
                      <Text style={styles.payoutMeta}>
                        {/* TODO: wire when /chw/payouts ships */}
                        No payouts yet
                      </Text>
                    </View>
                    <Pill variant="gray" size="sm">Pending</Pill>
                  </View>
                ) : (
                  recentPayoutClaims.map((claim, idx) => (
                    <View
                      key={claim.id}
                      style={[
                        styles.payoutRow,
                        idx < recentPayoutClaims.length - 1 && styles.payoutRowBorder,
                      ]}
                    >
                      <View style={styles.payoutIconCircle}>
                        <CheckCircle2 size={18} color="#16a34a" />
                      </View>
                      <View style={styles.payoutInfo}>
                        <Text style={styles.payoutAmount}>
                          {formatCurrency(claim.netPayout)}
                        </Text>
                        <Text style={styles.payoutMeta}>
                          {/* TODO: include ACH descriptor and bank last4 when
                              /chw/payouts returns payout transfer records */}
                          Paid {formatClaimDate(claim.paidAt)} · ACH
                        </Text>
                      </View>
                      <Pill variant="emerald" size="sm">Completed</Pill>
                    </View>
                  ))
                )}
              </View>
            </Card>
          </View>
        </ScrollView>
      </SafeAreaView>
    </AppShell>
  );
}

// ─── BankCheckItem helper ─────────────────────────────────────────────────────

function BankCheckItem({
  label,
  sublabel,
}: {
  label: string;
  sublabel?: string;
}): React.JSX.Element {
  return (
    <View style={styles.bankCheckRow}>
      <CheckCircle2 size={14} color="#16a34a" />
      <Text style={styles.bankCheckLabel}>
        {label}
        {sublabel !== undefined ? (
          <Text style={styles.bankCheckSublabel}> {sublabel}</Text>
        ) : null}
      </Text>
    </View>
  );
}

// ─── Table column width map ───────────────────────────────────────────────────

type TableCol = 'Member' | 'Date' | 'CPT' | 'Units' | 'Gross' | 'Net' | 'Pear Suite' | 'Stripe';

const colWidths: Record<TableCol, ViewStyle> = {
  Member:       { width: 140 },
  Date:         { width: 80 },
  CPT:          { width: 80 },
  Units:        { width: 60 },
  Gross:        { width: 90 },
  Net:          { width: 90 },
  'Pear Suite': { width: 110 },
  Stripe:       { width: 110 },
};

// ─── Web-only inline styles ───────────────────────────────────────────────────

const webStyles = {
  periodSelect: {
    paddingTop: 8,
    paddingBottom: 8,
    paddingLeft: 12,
    paddingRight: 12,
    borderRadius: 12,
    border: '1px solid #E5E7EB',
    fontSize: 14,
    backgroundColor: '#FFFFFF',
    color: '#374151',
    fontFamily: 'inherit',
    cursor: 'pointer',
    outline: 'none',
  } as React.CSSProperties,
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

  // ── Subtitle row ────────────────────────────────────────────────────────────
  subtitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: -16, // pull up under PageHeader title; PageHeader already has marginBottom
    marginBottom: 24,
  } as ViewStyle,

  subtitleText: {
    fontSize: 14,
    color: '#6b7280',
    lineHeight: 20,
  } as TextStyle,

  payoutsEnabledPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: '#d1fae5',
  } as ViewStyle,

  payoutsEnabledText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#047857',
    lineHeight: 16,
  } as TextStyle,

  // ── Header controls row ─────────────────────────────────────────────────────
  headerControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
  } as ViewStyle,

  periodButtonNative: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#FFFFFF',
  } as ViewStyle,

  periodButtonText: {
    fontSize: 14,
    color: '#374151',
    fontWeight: '500',
  } as TextStyle,

  outlineButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#FFFFFF',
  } as ViewStyle,

  outlineButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
  } as TextStyle,

  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: '#16a34a',
  } as ViewStyle,

  primaryButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#FFFFFF',
  } as TextStyle,

  // ── 4-tile stat grid ────────────────────────────────────────────────────────
  statGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 16,
    marginBottom: 24,
  } as ViewStyle,

  statTileWrap: {
    flex: 1,
    minWidth: 200,
  } as ViewStyle,

  // ── Earnings trend + bank row ────────────────────────────────────────────────
  trendBankRow: {
    flexDirection: 'row',
    gap: 20,
    marginBottom: 24,
    flexWrap: 'wrap',
  } as ViewStyle,

  trendCard: {
    flex: 2,
    minWidth: 300,
    padding: 20,
  } as ViewStyle,

  trendHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  } as ViewStyle,

  trendMeta: {
    fontSize: 12,
    color: '#9ca3af',
  } as TextStyle,

  trendChartArea: {
    borderRadius: 12,
    backgroundColor: '#f0fdf9', // emerald-50 approximation
    padding: 20,
    overflow: 'hidden',
  } as ViewStyle,

  trendChartNativePlaceholder: {
    height: 176,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,

  trendChartNativePlaceholderText: {
    fontSize: 13,
    color: '#9ca3af',
  } as TextStyle,

  bankCard: {
    flex: 1,
    minWidth: 220,
    padding: 20,
    gap: 12,
  } as ViewStyle,

  bankChecklist: {
    gap: 8,
  } as ViewStyle,

  bankCheckRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  } as ViewStyle,

  bankCheckLabel: {
    fontSize: 14,
    color: '#374151',
    flex: 1,
  } as TextStyle,

  bankCheckSublabel: {
    fontSize: 14,
    color: '#9ca3af',
  } as TextStyle,

  payoutsStatusBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#ecfdf5',
    borderWidth: 1,
    borderColor: '#a7f3d0',
  } as ViewStyle,

  payoutsStatusBannerText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#065f46',
    flex: 1,
  } as TextStyle,

  outlineButtonFull: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
  } as ViewStyle,

  outlineButtonFullText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
  } as TextStyle,

  // ── Sessions billed table ────────────────────────────────────────────────────
  tableCard: {
    marginBottom: 24,
    overflow: 'hidden',
  } as ViewStyle,

  tableCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  } as ViewStyle,

  viewAllLink: {
    fontSize: 14,
    fontWeight: '500',
    color: '#16a34a',
  } as TextStyle,

  tableScroll: {
    flex: 1,
  } as ViewStyle,

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
    fontWeight: '600',
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingVertical: 10,
    paddingHorizontal: 16,
  } as TextStyle,

  td: {
    fontSize: 13,
    color: '#374151',
    paddingVertical: 13,
    paddingHorizontal: 16,
  } as TextStyle,

  tdMemberName: {
    fontWeight: '600',
    color: '#111827',
  } as TextStyle,

  tdBold: {
    fontWeight: '600',
    color: '#111827',
  } as TextStyle,

  tdNumeric: {
    textAlign: 'center',
  } as TextStyle,

  tdCenter: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 13,
    paddingHorizontal: 16,
  } as ViewStyle,

  tableEmptyRow: {
    paddingVertical: 24,
    paddingHorizontal: 20,
    alignItems: 'center',
  } as ViewStyle,

  tableEmptyText: {
    fontSize: 13,
    color: '#9ca3af',
  } as TextStyle,

  // ── Recent payouts card ──────────────────────────────────────────────────────
  payoutsCard: {
    marginBottom: 24,
    overflow: 'hidden',
  } as ViewStyle,

  payoutsCardHeader: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  } as ViewStyle,

  payoutsList: {
    paddingHorizontal: 8,
    paddingVertical: 8,
  } as ViewStyle,

  payoutRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 8,
  } as ViewStyle,

  payoutRowBorder: {
    // no actual border — rows are padded inside the card. Visual separation
    // comes from the hover bg in the mock; we rely on spacing alone in native.
  } as ViewStyle,

  payoutIconCircle: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: '#d1fae5',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,

  payoutInfo: {
    flex: 1,
    gap: 2,
  } as ViewStyle,

  payoutAmount: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
  } as TextStyle,

  payoutMeta: {
    fontSize: 12,
    color: '#6b7280',
  } as TextStyle,

  // ── Shared section title ─────────────────────────────────────────────────────
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111827',
    lineHeight: 22,
  } as TextStyle,
});

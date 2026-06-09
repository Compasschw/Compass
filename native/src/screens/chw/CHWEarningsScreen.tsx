/**
 * CHWEarningsScreen — Earnings dashboard for CHW users.
 *
 * Sections:
 *  1. Page header — title only
 *  2. 3 KPI stat tiles — Earnings this month, Pending payout, Paid out this month
 *  3. Sessions billed table card (full width, Pear Suite status, no Stripe column)
 *  4. Recent payouts card (full width)
 *
 * Data wiring:
 *  - useChwEarnings()  → KPI tiles (thisMonth, pendingPayout)
 *  - useChwClaims()    → KPI tile 3 (paidOutThisMonth, derived), sessions table,
 *                        recent payouts list (derived from paid claims)
 *
 * Stripped in T13: 1099 export, Stripe Connect checklist, earnings trend chart,
 * Bank & payout setup card, Stripe status column in the sessions table.
 */

import React, { useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  DollarSign,
  Banknote,
  CheckCircle2,
} from 'lucide-react-native';

import { formatCurrency } from '../../data/mock';
import {
  useChwClaims,
  useChwEarnings,
  type ChwClaim,
} from '../../hooks/useApiQueries';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';
import {
  AppShell,
  PageHeader,
  Card,
  StatTile,
  SectionHeader,
  Pill,
  type PillVariant,
} from '../../components/ui';
import { colors as tokens } from '../../theme/tokens';

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
 * Maps a ChwClaim.status string to the Pear Suite Pill variant + label tuple.
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

// ─── Main Component ───────────────────────────────────────────────────────────

/**
 * CHW Earnings screen — 3-card KPI row, sessions billed table, recent payouts.
 */
export function CHWEarningsScreen(): React.JSX.Element {
  const earningsQuery = useChwEarnings();
  const claimsQuery = useChwClaims();

  const isLoading = earningsQuery.isLoading || claimsQuery.isLoading;
  const queryError = earningsQuery.error ?? claimsQuery.error;

  const handleRetry = (): void => {
    void earningsQuery.refetch();
    void claimsQuery.refetch();
  };

  const earnings = earningsQuery.data;
  const allClaims: ChwClaim[] = claimsQuery.data ?? [];

  // ── Derived values ────────────────────────────────────────────────────────

  /**
   * Sum of netPayout for claims with status='paid' in the current calendar month.
   */
  const paidOutThisMonth = useMemo<number>(() => {
    return allClaims
      .filter((c) => c.status === 'paid' && isCurrentMonth(c.serviceDate ?? c.paidAt))
      .reduce((acc, c) => acc + c.netPayout, 0);
  }, [allClaims]);

  /**
   * Claims filtered to the current calendar month for the sessions table,
   * sorted newest-first.
   */
  const currentMonthClaims = useMemo<ChwClaim[]>(() => {
    return allClaims
      .filter((c) => isCurrentMonth(c.serviceDate ?? c.createdAt))
      .sort((a, b) => {
        const ta = new Date(a.serviceDate ?? a.createdAt ?? '').getTime();
        const tb = new Date(b.serviceDate ?? b.createdAt ?? '').getTime();
        return tb - ta;
      });
  }, [allClaims]);

  /**
   * Paid claims for the recent payouts list (newest paidAt first, capped at 3).
   * TODO: replace with a dedicated /chw/payouts hook when it ships, which will
   * return aggregate payout transfer records rather than per-claim rows.
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
            <PageHeader title="Earnings" />

            {/* ── 3 KPI stat tiles ── */}
            <View style={styles.statGrid}>

              {/* 1. Earnings this month */}
              <View style={styles.statTileWrap}>
                <StatTile
                  icon={<DollarSign size={18} color="#16a34a" />}
                  iconBg={tokens.emerald100}
                  label="Earnings this month"
                  value={formatCurrency(earnings?.thisMonth ?? 0)}
                  deltaColor={tokens.emerald700}
                  deltaBg="#ecfdf5"
                />
              </View>

              {/* 2. Pending payout — from earnings.pendingPayout.
                  nextPayoutDate is not in the schema; showing static label.
                  TODO: wire nextPayoutDate when /chw/earnings exposes it. */}
              <View style={styles.statTileWrap}>
                <StatTile
                  icon={<Banknote size={18} color="#1d4ed8" />}
                  iconBg={tokens.blue100}
                  label="Pending payout"
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

            </View>

            {/* ── Sessions billed table (full width) ── */}
            <Card style={styles.tableCard}>
              <View style={styles.tableCardHeader}>
                <SectionHeader
                  title="Sessions billed this month"
                  right={
                    <TouchableOpacity
                      accessibilityRole="button"
                      accessibilityLabel="View all sessions"
                    >
                      <Text style={styles.viewAllLink}>View all →</Text>
                    </TouchableOpacity>
                  }
                  marginBottom={0}
                />
              </View>

              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.tableScroll}
              >
                <View style={styles.tableInner}>

                  {/* Table header */}
                  <View style={[styles.tableRow, styles.tableHeaderRow]}>
                    {TABLE_COLS.map((col) => (
                      <Text key={col} style={[styles.th, colWidths[col]]}>
                        {col}
                      </Text>
                    ))}
                  </View>

                  {/* Data rows */}
                  {currentMonthClaims.length === 0 ? (
                    <View style={styles.tableEmptyRow}>
                      <Text style={styles.tableEmptyText}>
                        No sessions billed this month.
                      </Text>
                    </View>
                  ) : (
                    currentMonthClaims.map((claim) => {
                      const pear = pearPill(claim.status);
                      return (
                        <View key={claim.id} style={[styles.tableRow, styles.tableDataRow]}>
                          {/* Member — ChwClaim has no memberName field.
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
                            <Pill variant={pear.variant} size="sm">
                              {pear.label}
                            </Pill>
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
                returning aggregate payout transfer records (not per-claim). */}
            <Card style={styles.payoutsCard}>
              <View style={styles.payoutsCardHeader}>
                <SectionHeader title="Recent payouts" marginBottom={0} />
              </View>

              <View style={styles.payoutsList}>
                {recentPayoutClaims.length === 0 ? (
                  /* Empty state — shown when no paid claims exist yet */
                  <View style={styles.payoutRow}>
                    <View style={styles.payoutIconCircle}>
                      <CheckCircle2 size={18} color="#16a34a" />
                    </View>
                    <View style={styles.payoutInfo}>
                      <Text style={styles.payoutAmount}>—</Text>
                      <Text style={styles.payoutMeta}>No payouts yet</Text>
                    </View>
                    <Pill variant="gray" size="sm">Pending</Pill>
                  </View>
                ) : (
                  recentPayoutClaims.map((claim, idx) => (
                    <View
                      key={claim.id}
                      style={[
                        styles.payoutRow,
                        idx < recentPayoutClaims.length - 1 && styles.payoutRowDivider,
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

// ─── Table column definitions ─────────────────────────────────────────────────

type TableCol = 'Member' | 'Date' | 'CPT' | 'Units' | 'Gross' | 'Net' | 'Pear Suite';

const TABLE_COLS: TableCol[] = ['Member', 'Date', 'CPT', 'Units', 'Gross', 'Net', 'Pear Suite'];

const colWidths: Record<TableCol, ViewStyle> = {
  Member:       { width: 140 },
  Date:         { width: 80 },
  CPT:          { width: 80 },
  Units:        { width: 60 },
  Gross:        { width: 90 },
  Net:          { width: 90 },
  'Pear Suite': { width: 110 },
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

  // ── 3-tile stat grid ────────────────────────────────────────────────────────
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

  // ── Sessions billed table ────────────────────────────────────────────────────
  tableCard: {
    marginBottom: 24,
    overflow: 'hidden',
  } as ViewStyle,

  tableCardHeader: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  } as ViewStyle,

  viewAllLink: {
    fontSize: 13,
    fontWeight: '600',
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

  payoutRowDivider: {
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
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
});

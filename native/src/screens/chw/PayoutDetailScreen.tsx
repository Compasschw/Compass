/**
 * PayoutDetailScreen — Per-session earnings + claim breakdown.
 *
 * Reached from the Recent Payouts list on CHWEarningsScreen by tapping a
 * row. Renders the full backstory of one session's payout:
 *   - Session metadata (member, vertical, mode, date, duration)
 *   - Line-item earnings math (gross, platform fee, rewards pool, your net)
 *   - Claim lifecycle timeline (pending → submitted → paid)
 *   - Diagnosis + procedure codes that filed the claim
 *
 * Data sources are the same as CHWEarningsScreen — useSessions() for
 * session metadata and useChwClaims() for the BillingClaim row keyed by
 * session_id. Falls back gracefully when a session has no claim yet
 * (i.e., CHW hasn't submitted documentation for it).
 */

import React, { useMemo } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  ArrowLeft,
  Brain,
  CheckCircle2,
  Circle,
  Clock,
  DollarSign,
  Home,
  RefreshCw,
  Stethoscope,
  Utensils,
} from 'lucide-react-native';

import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import {
  useChwClaims,
  useSessions,
  type ChwClaim,
  type SessionData,
} from '../../hooks/useApiQueries';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';
import type { Vertical } from '../../data/mock';

// ─── Local types ──────────────────────────────────────────────────────────────

/**
 * Param list excerpt for the Earnings stack — kept local so this screen
 * doesn't take a hard dependency on the navigator file. The navigator
 * registers the same `PayoutDetail` route name with the same param shape.
 */
type EarningsStackParamList = {
  Earnings: undefined;
  Payments: undefined;
  PayoutDetail: { sessionId: string };
};

type PayoutDetailRouteProp = RouteProp<EarningsStackParamList, 'PayoutDetail'>;
type PayoutDetailNavProp = NativeStackNavigationProp<
  EarningsStackParamList,
  'PayoutDetail'
>;

// ─── Constants ────────────────────────────────────────────────────────────────

const MEDI_CAL_RATE = 26.66;
const PLATFORM_FEE_RATE = 0.15;
const REWARDS_POOL_RATE = 0.25;
const NET_PAYOUT_RATE = 0.6;

const VERTICAL_COLORS: Record<Vertical, string> = {
  housing: '#3B82F6',
  rehab: '#EF4444',
  food: '#F59E0B',
  mental_health: '#8B5CF6',
  healthcare: '#06B6D4',
};

const VERTICAL_LABELS: Record<Vertical, string> = {
  housing: 'Housing',
  rehab: 'Rehab & Recovery',
  food: 'Food Security',
  mental_health: 'Mental Health',
  healthcare: 'Healthcare',
};

const SESSION_MODE_LABELS: Record<string, string> = {
  in_person: 'In Person',
  virtual: 'Video Call',
  phone: 'Phone',
};

type ClaimStage = 'pending' | 'submitted' | 'paid' | 'rejected';

const CLAIM_STAGE_ORDER: ClaimStage[] = ['pending', 'submitted', 'paid'];

const CLAIM_STAGE_LABELS: Record<ClaimStage, string> = {
  pending: 'Documentation submitted',
  submitted: 'Sent to Medi-Cal clearinghouse',
  paid: 'Payout deposited to your account',
  rejected: 'Claim rejected',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function VerticalIcon({
  vertical,
  size = 20,
}: {
  vertical: Vertical;
  size?: number;
}): React.JSX.Element {
  const tint = VERTICAL_COLORS[vertical] ?? colors.mutedForeground;
  switch (vertical) {
    case 'housing':
      return <Home size={size} color={tint} />;
    case 'rehab':
      return <RefreshCw size={size} color={tint} />;
    case 'food':
      return <Utensils size={size} color={tint} />;
    case 'mental_health':
      return <Brain size={size} color={tint} />;
    case 'healthcare':
      return <Stethoscope size={size} color={tint} />;
  }
}

function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function formatLongDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Compute the live earnings split for a session. Prefer claim values when a
 * BillingClaim exists; otherwise reconstruct from session.unitsBilled at the
 * canonical rate so the breakdown still renders for sessions awaiting a
 * documentation submission.
 */
function computeEarnings(
  session: SessionData,
  claim: ChwClaim | undefined,
): {
  units: number;
  gross: number;
  platformFee: number;
  rewardsPool: number;
  netPayout: number;
} {
  if (claim) {
    return {
      units: claim.units,
      gross: claim.grossAmount,
      platformFee: claim.platformFee,
      rewardsPool: claim.pearSuiteFee ?? claim.grossAmount * REWARDS_POOL_RATE,
      netPayout: claim.netPayout,
    };
  }
  const units = session.unitsBilled ?? 0;
  const gross = units * MEDI_CAL_RATE;
  return {
    units,
    gross,
    platformFee: gross * PLATFORM_FEE_RATE,
    rewardsPool: gross * REWARDS_POOL_RATE,
    netPayout: gross * NET_PAYOUT_RATE,
  };
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface LineItemProps {
  label: string;
  value: string;
  emphasis?: 'positive' | 'negative' | 'total' | 'neutral';
  hint?: string;
}

function LineItem({
  label,
  value,
  emphasis = 'neutral',
  hint,
}: LineItemProps): React.JSX.Element {
  const valueStyle =
    emphasis === 'total'
      ? styles.lineValueTotal
      : emphasis === 'negative'
        ? styles.lineValueNegative
        : emphasis === 'positive'
          ? styles.lineValuePositive
          : styles.lineValueNeutral;

  return (
    <View style={styles.lineRow}>
      <View style={styles.lineLabelCol}>
        <Text style={styles.lineLabel}>{label}</Text>
        {hint ? <Text style={styles.lineHint}>{hint}</Text> : null}
      </View>
      <Text style={valueStyle}>{value}</Text>
    </View>
  );
}

interface TimelineRowProps {
  stage: ClaimStage;
  reached: boolean;
  current: boolean;
  timestamp: string | null;
}

function TimelineRow({
  stage,
  reached,
  current,
  timestamp,
}: TimelineRowProps): React.JSX.Element {
  const tint = reached ? colors.primary : colors.mutedForeground;
  return (
    <View style={styles.timelineRow}>
      <View style={styles.timelineIconCol}>
        {reached ? (
          <CheckCircle2 size={18} color={tint} />
        ) : (
          <Circle size={18} color={tint} />
        )}
      </View>
      <View style={styles.timelineTextCol}>
        <Text
          style={[
            styles.timelineLabel,
            reached && styles.timelineLabelReached,
            current && styles.timelineLabelCurrent,
          ]}
        >
          {CLAIM_STAGE_LABELS[stage]}
        </Text>
        {timestamp ? (
          <Text style={styles.timelineTimestamp}>{timestamp}</Text>
        ) : null}
      </View>
    </View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export function PayoutDetailScreen(): React.JSX.Element {
  const navigation = useNavigation<PayoutDetailNavProp>();
  const route = useRoute<PayoutDetailRouteProp>();
  const { sessionId } = route.params;

  const sessionsQuery = useSessions();
  const claimsQuery = useChwClaims();

  const session = useMemo<SessionData | undefined>(
    () => (sessionsQuery.data ?? []).find((s) => s.id === sessionId),
    [sessionsQuery.data, sessionId],
  );
  const claim = useMemo<ChwClaim | undefined>(
    () => (claimsQuery.data ?? []).find((c) => c.sessionId === sessionId),
    [claimsQuery.data, sessionId],
  );

  const isLoading = sessionsQuery.isLoading || claimsQuery.isLoading;
  const queryError = sessionsQuery.error ?? claimsQuery.error;

  // ── Loading / error / not-found handling ────────────────────────────────
  if (isLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <Header onBack={() => navigation.goBack()} title="Payout details" />
        <View style={styles.loadingPad}>
          <LoadingSkeleton variant="rows" rows={4} />
        </View>
      </SafeAreaView>
    );
  }
  if (queryError || !session) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <Header onBack={() => navigation.goBack()} title="Payout details" />
        <ErrorState
          message={
            queryError
              ? 'Failed to load payout detail.'
              : 'Session not found.'
          }
          onRetry={() => {
            void sessionsQuery.refetch();
            void claimsQuery.refetch();
          }}
        />
      </SafeAreaView>
    );
  }

  // ── Derived display values ──────────────────────────────────────────────
  const earnings = computeEarnings(session, claim);
  const verticalKey = session.vertical as Vertical;
  const verticalColor = VERTICAL_COLORS[verticalKey] ?? colors.mutedForeground;
  const verticalLabel = VERTICAL_LABELS[verticalKey] ?? session.vertical;
  const modeLabel =
    SESSION_MODE_LABELS[session.mode] ?? session.mode ?? '—';

  // Claim status drives both the badge and the timeline
  const status: ClaimStage = (claim?.status as ClaimStage) ?? 'pending';
  const reachedStages = useMemo(() => {
    const set = new Set<ClaimStage>();
    if (status === 'rejected') {
      set.add('pending');
      set.add('submitted');
    } else {
      const idx = CLAIM_STAGE_ORDER.indexOf(status);
      for (let i = 0; i <= idx; i++) {
        set.add(CLAIM_STAGE_ORDER[i]);
      }
    }
    return set;
  }, [status]);

  const stageTimestamp = useMemo<Record<ClaimStage, string | null>>(() => {
    return {
      pending: claim?.createdAt ?? null,
      submitted: claim?.submittedAt ?? null,
      paid: claim?.paidAt ?? null,
      rejected: null,
    };
  }, [claim]);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <Header onBack={() => navigation.goBack()} title="Payout details" />

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Session summary card ───────────────────────────────────────── */}
        <View style={styles.card}>
          <View style={styles.sessionHeader}>
            <View
              style={[
                styles.verticalIconWrap,
                { backgroundColor: `${verticalColor}1A` },
              ]}
            >
              <VerticalIcon vertical={verticalKey} size={22} />
            </View>
            <View style={styles.sessionHeaderText}>
              <Text style={styles.sessionMember}>
                {session.memberName ?? 'Member'}
              </Text>
              <Text style={styles.sessionMeta}>
                {verticalLabel} · {modeLabel}
              </Text>
            </View>
          </View>

          <View style={styles.metaGrid}>
            <View style={styles.metaCell}>
              <Text style={styles.metaCellLabel}>Date</Text>
              <Text style={styles.metaCellValue}>
                {formatLongDate(session.scheduledAt)}
              </Text>
            </View>
            <View style={styles.metaCell}>
              <Text style={styles.metaCellLabel}>Duration</Text>
              <Text style={styles.metaCellValue}>
                {session.durationMinutes != null
                  ? `${session.durationMinutes} min`
                  : '—'}
              </Text>
            </View>
            <View style={styles.metaCell}>
              <Text style={styles.metaCellLabel}>Units billed</Text>
              <Text style={styles.metaCellValue}>{earnings.units || '—'}</Text>
            </View>
            <View style={styles.metaCell}>
              <Text style={styles.metaCellLabel}>Procedure code</Text>
              <Text style={styles.metaCellValue}>
                {claim?.procedureCode ?? '—'}
              </Text>
            </View>
          </View>
        </View>

        {/* ── Earnings breakdown ─────────────────────────────────────────── */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <DollarSign size={18} color={colors.primary} />
            <Text style={styles.cardTitle}>Earnings breakdown</Text>
          </View>

          <LineItem
            label="Gross"
            value={formatCurrency(earnings.gross)}
            hint={
              earnings.units > 0
                ? `${earnings.units} unit${earnings.units === 1 ? '' : 's'} × $${MEDI_CAL_RATE.toFixed(2)} Medi-Cal rate`
                : undefined
            }
          />
          <View style={styles.divider} />
          <LineItem
            label="Platform fee (15%)"
            value={`-${formatCurrency(earnings.platformFee)}`}
            emphasis="negative"
          />
          <LineItem
            label="Member rewards pool (25%)"
            value={`-${formatCurrency(earnings.rewardsPool)}`}
            emphasis="negative"
            hint="Funds the catalog members redeem points against."
          />
          <View style={styles.divider} />
          <LineItem
            label="Your payout (60%)"
            value={formatCurrency(earnings.netPayout)}
            emphasis="total"
          />
        </View>

        {/* ── Claim status timeline ──────────────────────────────────────── */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Clock size={18} color={colors.primary} />
            <Text style={styles.cardTitle}>Claim status</Text>
          </View>

          {claim == null ? (
            <Text style={styles.emptyTimeline}>
              Documentation has not been submitted for this session yet. Submit
              from the Sessions tab to file a claim.
            </Text>
          ) : (
            <>
              {CLAIM_STAGE_ORDER.map((stage) => (
                <TimelineRow
                  key={stage}
                  stage={stage}
                  reached={reachedStages.has(stage)}
                  current={status === stage}
                  timestamp={formatTimestamp(stageTimestamp[stage])}
                />
              ))}
              {status === 'rejected' ? (
                <TimelineRow
                  stage="rejected"
                  reached
                  current
                  timestamp={formatTimestamp(stageTimestamp.rejected)}
                />
              ) : null}
            </>
          )}
        </View>

        {/* ── Diagnosis codes (if claim exists) ──────────────────────────── */}
        {claim?.procedureCode ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Codes filed with claim</Text>
            <View style={styles.codeRow}>
              <Text style={styles.codeLabel}>Procedure</Text>
              <Text style={styles.codeValue}>{claim.procedureCode}</Text>
            </View>
            {/* Diagnosis codes aren't on ChwClaim today (PHI hygiene); render a
                placeholder so the card still tells a story. Wire to a fuller
                claim-detail endpoint once it exists. */}
            <View style={styles.codeRow}>
              <Text style={styles.codeLabel}>Service date</Text>
              <Text style={styles.codeValue}>
                {formatLongDate(claim.serviceDate)}
              </Text>
            </View>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Header (small inline because we don't have a shared one yet) ─────────────

interface HeaderProps {
  onBack: () => void;
  title: string;
}

function Header({ onBack, title }: HeaderProps): React.JSX.Element {
  return (
    <View style={styles.header}>
      <Pressable
        onPress={onBack}
        style={styles.backBtn}
        accessibilityRole="button"
        accessibilityLabel="Back to earnings"
        hitSlop={8}
      >
        <ArrowLeft size={20} color={colors.foreground} />
      </Pressable>
      <Text style={styles.headerTitle}>{title}</Text>
      <View style={styles.headerSpacer} />
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
    backgroundColor: colors.card,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
  },
  headerTitle: {
    ...typography.bodyMd,
    fontFamily: 'DMSans_700Bold',
    color: colors.foreground,
    flex: 1,
    textAlign: 'center',
  },
  headerSpacer: { width: 36 },
  loadingPad: { padding: 20 },

  scrollContent: {
    padding: 20,
    gap: 16,
    paddingBottom: 40,
  },
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    padding: 16,
    gap: 12,
    shadowColor: '#3D5A3E',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 16,
    elevation: 2,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  cardTitle: {
    ...typography.bodyMd,
    fontFamily: 'DMSans_700Bold',
    color: colors.foreground,
  },

  // Session summary
  sessionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  verticalIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sessionHeaderText: { flex: 1 },
  sessionMember: {
    ...typography.bodyLg,
    fontFamily: 'DMSans_700Bold',
    color: colors.foreground,
  },
  sessionMeta: {
    ...typography.bodySm,
    color: colors.mutedForeground,
    marginTop: 2,
  },
  metaGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 4,
  },
  metaCell: {
    width: '50%',
    paddingVertical: 8,
  },
  metaCellLabel: {
    ...typography.label,
    color: colors.mutedForeground,
    marginBottom: 2,
  },
  metaCellValue: {
    ...typography.bodySm,
    color: colors.foreground,
    fontFamily: 'PlusJakartaSans_600SemiBold',
  },

  // Line items
  lineRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  lineLabelCol: { flex: 1 },
  lineLabel: {
    ...typography.bodySm,
    color: colors.foreground,
  },
  lineHint: {
    ...typography.label,
    color: colors.mutedForeground,
    marginTop: 2,
    letterSpacing: 0,
  },
  lineValueNeutral: {
    ...typography.bodySm,
    color: colors.foreground,
    fontFamily: 'PlusJakartaSans_600SemiBold',
  },
  lineValueNegative: {
    ...typography.bodySm,
    color: colors.mutedForeground,
    fontFamily: 'PlusJakartaSans_600SemiBold',
  },
  lineValuePositive: {
    ...typography.bodySm,
    color: colors.primary,
    fontFamily: 'PlusJakartaSans_600SemiBold',
  },
  lineValueTotal: {
    ...typography.bodyLg,
    color: colors.primary,
    fontFamily: 'DMSans_700Bold',
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: 4,
  },

  // Timeline
  timelineRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    marginVertical: 6,
  },
  timelineIconCol: { width: 22, alignItems: 'center', paddingTop: 1 },
  timelineTextCol: { flex: 1 },
  timelineLabel: {
    ...typography.bodySm,
    color: colors.mutedForeground,
  },
  timelineLabelReached: {
    color: colors.foreground,
  },
  timelineLabelCurrent: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
  },
  timelineTimestamp: {
    ...typography.label,
    color: colors.mutedForeground,
    marginTop: 2,
    letterSpacing: 0,
  },
  emptyTimeline: {
    ...typography.bodySm,
    color: colors.mutedForeground,
    lineHeight: 20,
  },

  // Codes
  codeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  codeLabel: {
    ...typography.bodySm,
    color: colors.mutedForeground,
  },
  codeValue: {
    ...typography.bodySm,
    color: colors.foreground,
    fontFamily: 'PlusJakartaSans_600SemiBold',
  },
});

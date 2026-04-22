/**
 * CHWRequestsScreen — Inbox for incoming community member service requests.
 *
 * Features:
 *  - Horizontal scrollable filter tabs by vertical category
 *  - Request cards with vertical badge, urgency badge, earnings estimate
 *  - Accept / Pass actions (optimistic dismiss)
 *  - Empty state when no requests match the active filter
 */

import React, { useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  FlatList,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  CheckCircle,
  XCircle,
  Inbox,
  Home,
  Utensils,
  Brain,
  RefreshCw,
  Stethoscope,
  Bell,
  ThumbsDown,
} from 'lucide-react-native';

import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import {
  formatCurrency,
  MEDI_CAL_RATE,
  NET_PAYOUT_RATE,
  type Vertical,
} from '../../data/mock';
import {
  useRequests,
  useAcceptRequest,
  usePassRequest,
  type ServiceRequestData,
} from '../../hooks/useApiQueries';
import { useRefreshControl } from '../../hooks/useRefreshControl';
import { LoadingSkeleton } from '../../components/shared/LoadingSkeleton';
import { ErrorState } from '../../components/shared/ErrorState';

// ─── Constants ────────────────────────────────────────────────────────────────

type FilterTab = 'all' | Vertical;

const FILTER_TABS: { key: FilterTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'housing', label: 'Housing' },
  { key: 'food', label: 'Food' },
  { key: 'mental_health', label: 'Mental Health' },
  { key: 'rehab', label: 'Rehab' },
  { key: 'healthcare', label: 'Healthcare' },
];

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

const URGENCY_COLORS: Record<string, string> = {
  routine: colors.secondary,
  soon: colors.compassGold,
  urgent: colors.destructive,
};

const URGENCY_LABELS: Record<string, string> = {
  routine: 'Routine',
  soon: 'Soon',
  urgent: 'Urgent',
};

const SESSION_MODE_LABELS: Record<string, string> = {
  in_person: 'In Person',
  virtual: 'Video Call',
  phone: 'Phone',
};

// ─── VerticalIcon helper ──────────────────────────────────────────────────────

function VerticalIconComponent({
  vertical,
  size = 18,
}: {
  vertical: Vertical;
  size?: number;
}): React.JSX.Element {
  const iconColor = VERTICAL_COLORS[vertical];
  switch (vertical) {
    case 'housing':
      return <Home size={size} color={iconColor} />;
    case 'rehab':
      return <RefreshCw size={size} color={iconColor} />;
    case 'food':
      return <Utensils size={size} color={iconColor} />;
    case 'mental_health':
      return <Brain size={size} color={iconColor} />;
    case 'healthcare':
      return <Stethoscope size={size} color={iconColor} />;
  }
}

// ─── RequestCard sub-component ────────────────────────────────────────────────

interface RequestCardProps {
  request: ServiceRequestData;
  onAccept: (id: string) => void;
  onPass: (id: string) => void;
}

function RequestCard({ request, onAccept, onPass }: RequestCardProps): React.JSX.Element {
  const grossEarnings = request.estimatedUnits * MEDI_CAL_RATE;
  const netEarnings = parseFloat((grossEarnings * NET_PAYOUT_RATE).toFixed(2));
  const verticalColor = VERTICAL_COLORS[request.vertical as Vertical] ?? '#6B7A6B';

  return (
    <View style={cardStyles.card}>
      {/* Header row */}
      <View style={cardStyles.headerRow}>
        <View style={[cardStyles.iconCircle, { backgroundColor: verticalColor + '18' }]}>
          <VerticalIconComponent vertical={request.vertical as Vertical} size={18} />
        </View>
        <View style={cardStyles.headerContent}>
          <View style={cardStyles.badgeRow}>
            <Text style={cardStyles.memberName}>{request.memberName}</Text>
            <View style={[cardStyles.badge, { backgroundColor: verticalColor + '18' }]}>
              <Text style={[cardStyles.badgeText, { color: verticalColor }]}>
                {VERTICAL_LABELS[request.vertical as Vertical] ?? request.vertical}
              </Text>
            </View>
            <View
              style={[
                cardStyles.badge,
                { backgroundColor: (URGENCY_COLORS[request.urgency] ?? '#6B7A6B') + '18' },
              ]}
            >
              <Text
                style={[cardStyles.badgeText, { color: URGENCY_COLORS[request.urgency] ?? '#6B7A6B' }]}
              >
                {URGENCY_LABELS[request.urgency] ?? request.urgency}
              </Text>
            </View>
          </View>
          <Text style={cardStyles.modeLabel}>
            {SESSION_MODE_LABELS[request.preferredMode] ?? request.preferredMode}
          </Text>
        </View>
      </View>

      {/* Description */}
      <Text style={cardStyles.description} numberOfLines={3}>
        {request.description}
      </Text>

      {/* Earnings row */}
      <View style={cardStyles.earningsRow}>
        <Text style={cardStyles.earningsUnits}>
          ~{request.estimatedUnits} {request.estimatedUnits === 1 ? 'unit' : 'units'}
        </Text>
        <Text style={cardStyles.dot}> · </Text>
        <Text style={cardStyles.earningsGross}>{formatCurrency(grossEarnings)} gross</Text>
        <Text style={cardStyles.dot}> · </Text>
        <Text style={cardStyles.earningsNet}>{formatCurrency(netEarnings)} net</Text>
      </View>

      {/* Action buttons */}
      <View style={cardStyles.actionRow}>
        <TouchableOpacity
          style={cardStyles.acceptButton}
          onPress={() => onAccept(request.id)}
          accessibilityLabel={`Accept request from ${request.memberName}`}
          accessibilityRole="button"
        >
          <CheckCircle size={15} color="#FFFFFF" />
          <Text style={cardStyles.acceptButtonText}>Accept</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={cardStyles.passButton}
          onPress={() => onPass(request.id)}
          accessibilityLabel={`Pass on request from ${request.memberName}`}
          accessibilityRole="button"
        >
          <XCircle size={15} color={colors.mutedForeground} />
          <Text style={cardStyles.passButtonText}>Pass</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const cardStyles = StyleSheet.create({
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#DDD6CC',
    padding: 16,
    marginBottom: 12,
    shadowColor: '#3D5A3E',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 24,
    elevation: 3,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    marginBottom: 10,
  },
  iconCircle: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    marginTop: 2,
    backgroundColor: '#3D5A3E15',
  },
  headerContent: {
    flex: 1,
    gap: 4,
  },
  badgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
  },
  memberName: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    lineHeight: 22,
    color: '#1E3320',
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 100,
  },
  badgeText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    lineHeight: 16,
  },
  modeLabel: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    letterSpacing: 1,
    color: '#6B7A6B',
  },
  description: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#6B7A6B',
    lineHeight: 20,
    marginBottom: 10,
  },
  earningsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
    flexWrap: 'wrap',
  },
  earningsUnits: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    letterSpacing: 1,
    color: '#3D5A3E',
  },
  dot: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    color: '#6B7A6B',
  },
  earningsGross: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    letterSpacing: 1,
    color: '#6B7A6B',
  },
  earningsNet: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    letterSpacing: 1,
    color: '#1E3320',
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
  },
  acceptButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#3D5A3E',
    paddingVertical: 14,
    borderRadius: 12,
  },
  acceptButtonText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#FFFFFF',
  },
  passButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#DDD6CC',
    paddingVertical: 14,
    borderRadius: 12,
  },
  passButtonText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#6B7A6B',
  },
});

// ─── Main Component ───────────────────────────────────────────────────────────

/**
 * CHW Requests screen — displays open service requests with filter tabs
 * and a summary stat row showing new / accepted / passed counts.
 */
export function CHWRequestsScreen(): React.JSX.Element {
  const [activeFilter, setActiveFilter] = useState<FilterTab>('all');

  const { data: rawRequests, isLoading, error, refetch } = useRequests();
  const acceptRequest = useAcceptRequest();
  const passRequest = usePassRequest();
  const refresh = useRefreshControl([refetch]);

  // Track session-local accepted/passed counts for the summary stat row.
  // The API handles actual status transitions; these just reflect in-session actions.
  const [acceptedCount, setAcceptedCount] = useState(0);
  const [passedCount, setPassedCount] = useState(0);

  const allOpenRequests = useMemo<ServiceRequestData[]>(
    () => (rawRequests ?? []).filter((r) => r.status === 'open'),
    [rawRequests],
  );

  const filteredRequests = useMemo<ServiceRequestData[]>(
    () =>
      activeFilter === 'all'
        ? allOpenRequests
        : allOpenRequests.filter((r) => r.vertical === activeFilter),
    [activeFilter, allOpenRequests],
  );

  const handleAccept = useCallback(async (id: string): Promise<void> => {
    await acceptRequest.mutateAsync(id);
    setAcceptedCount((prev) => prev + 1);
  }, [acceptRequest]);

  const handlePass = useCallback(async (id: string): Promise<void> => {
    await passRequest.mutateAsync(id);
    setPassedCount((prev) => prev + 1);
  }, [passRequest]);

  if (isLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.headerBlock}>
          <View style={styles.titleRow}>
            <Text style={styles.pageTitle}>Open Requests</Text>
          </View>
        </View>
        <View style={styles.listContent}>
          <LoadingSkeleton variant="rows" rows={4} />
        </View>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <ErrorState message="Failed to load requests" onRetry={() => void refetch()} />
      </SafeAreaView>
    );
  }

  const tabCount = useCallback(
    (key: FilterTab): number => {
      if (key === 'all') return allOpenRequests.length;
      return allOpenRequests.filter((r) => r.vertical === (key as string)).length;
    },
    [allOpenRequests],
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* Page header — fixed above scroll */}
      <View style={styles.headerBlock}>
        <View style={styles.titleRow}>
          <Text style={styles.pageTitle}>Open Requests</Text>
          {allOpenRequests.length > 0 ? (
            <View style={styles.countBadge}>
              <Text style={styles.countBadgeText}>{allOpenRequests.length}</Text>
            </View>
          ) : null}
        </View>

        {/* ── Summary stat row ── */}
        <View style={styles.statSummaryRow}>
          <View style={[styles.statSummaryCard, { borderColor: colors.compassGold + '50' }]}>
            <View style={[styles.statSummaryIcon, { backgroundColor: colors.compassGold + '18' }]}>
              <Bell size={14} color={colors.compassGold} />
            </View>
            <Text style={styles.statSummaryValue}>{allOpenRequests.length}</Text>
            <Text style={styles.statSummaryLabel}>New</Text>
          </View>
          <View style={[styles.statSummaryCard, { borderColor: colors.secondary + '50' }]}>
            <View style={[styles.statSummaryIcon, { backgroundColor: colors.secondary + '18' }]}>
              <CheckCircle size={14} color={colors.secondary} />
            </View>
            <Text style={styles.statSummaryValue}>{acceptedCount}</Text>
            <Text style={styles.statSummaryLabel}>Accepted</Text>
          </View>
          <View style={[styles.statSummaryCard, { borderColor: colors.destructive + '40' }]}>
            <View style={[styles.statSummaryIcon, { backgroundColor: colors.destructive + '18' }]}>
              <ThumbsDown size={14} color={colors.destructive} />
            </View>
            <Text style={styles.statSummaryValue}>{passedCount}</Text>
            <Text style={styles.statSummaryLabel}>Passed</Text>
          </View>
        </View>

        {/* Filter tabs */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.tabsRow}
        >
          {FILTER_TABS.map((tab) => {
            const isActive = activeFilter === tab.key;
            const count = tabCount(tab.key);
            return (
              <TouchableOpacity
                key={tab.key}
                style={[styles.tab, isActive && styles.tabActive]}
                onPress={() => setActiveFilter(tab.key)}
                accessibilityRole="tab"
                accessibilityState={{ selected: isActive }}
              >
                <Text style={[styles.tabText, isActive && styles.tabTextActive]}>
                  {tab.label}
                  {count > 0 ? ` ${count}` : ''}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      {/* Request list */}
      {filteredRequests.length > 0 ? (
        <FlatList
          data={filteredRequests}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <RequestCard
              request={item}
              onAccept={(id) => void handleAccept(id)}
              onPass={(id) => void handlePass(id)}
            />
          )}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          refreshControl={refresh.control}
          ListFooterComponent={
            <Text style={styles.footnote}>
              Earnings based on $26.66/unit Medi-Cal rate · 85% CHW net payout.
            </Text>
          }
        />
      ) : (
        <View style={styles.emptyState}>
          <View style={styles.emptyIconCircle}>
            <Inbox size={24} color={colors.mutedForeground} />
          </View>
          <Text style={styles.emptyTitle}>No open requests</Text>
          <Text style={styles.emptySubtext}>
            {activeFilter === 'all'
              ? 'No open requests right now. Check back soon!'
              : 'No open requests in this category. Check back soon!'}
          </Text>
        </View>
      )}
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#F4F1ED',
  },
  headerBlock: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 8,
    backgroundColor: '#F4F1ED',
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 14,
  },
  pageTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 24,
    lineHeight: 30,
    color: '#1E3320',
  },
  countBadge: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#3D5A3E',
    alignItems: 'center',
    justifyContent: 'center',
  },
  countBadgeText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    letterSpacing: 1,
    color: '#FFFFFF',
  },
  // Summary stat row
  statSummaryRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 14,
  },
  statSummaryCard: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    padding: 12,
    alignItems: 'center',
    gap: 4,
    shadowColor: '#3D5A3E',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 24,
    elevation: 3,
  },
  statSummaryIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
    backgroundColor: '#3D5A3E15',
  },
  statSummaryValue: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 24,
    color: '#1E3320',
    lineHeight: 30,
  },
  statSummaryLabel: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#6B7A6B',
  },

  tabsRow: {
    flexDirection: 'row',
    gap: 8,
    paddingBottom: 4,
  },
  tab: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#DDD6CC',
  },
  tabActive: {
    backgroundColor: '#3D5A3E',
    borderColor: '#3D5A3E',
  },
  tabText: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 14,
    color: '#6B7A6B',
  },
  tabTextActive: {
    color: '#FFFFFF',
  },
  listContent: {
    padding: 20,
    paddingBottom: 40,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
    gap: 12,
  },
  emptyIconCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#3D5A3E15',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: {
    fontFamily: 'DMSans_700Bold',
    fontSize: 16,
    lineHeight: 22,
    color: '#1E3320',
  },
  emptySubtext: {
    fontFamily: 'PlusJakartaSans_400Regular',
    fontSize: 14,
    color: '#6B7A6B',
    textAlign: 'center',
    maxWidth: 280,
  },
  footnote: {
    fontFamily: 'PlusJakartaSans_600SemiBold',
    fontSize: 12,
    letterSpacing: 1,
    color: '#6B7A6B',
    textAlign: 'center',
    marginTop: 8,
    paddingBottom: 8,
  },
});
